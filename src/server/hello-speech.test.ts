import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createApp } from "./app.js";
import type { SessionConfig, SessionMetadata } from "@github/copilot-sdk";
import { createSession } from "./features/hello-world/core.js";
import {
  solveHelloSpeech,
  type HelloSpeechClient,
  type HelloSpeechSession,
  type HelloSpeechUsageEvent,
} from "./features/hello-speech/service.js";
import { solveHelloSpeech as solveHelloSpeechGraph } from "./features/hello-speech/service_graph.js";
import { createLangGraphSpeechGraph } from "./features/hello-speech/langgraph_entry.js";

class FakeSession {
  readonly sessionId: string;
  private usageHandler: ((event: HelloSpeechUsageEvent) => void) | undefined;
  disconnected = false;
  shouldFail = false;
  responseContent = "bot reply";
  beforeResponse: (() => Promise<void>) | undefined;
  readonly prompts: string[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  on(_eventType: "assistant.usage", handler: (event: HelloSpeechUsageEvent) => void): () => void {
    this.usageHandler = handler;
    return () => {
      this.usageHandler = undefined;
    };
  }

  async sendAndWait(options: { prompt: string }, _timeout?: number) {
    this.prompts.push(options.prompt);
    if (this.shouldFail) throw Object.assign(new Error("model failed"), { code: "MODEL" });
    await this.beforeResponse?.();
    this.usageHandler?.({
      data: {
        duration: 123,
        inputTokens: 11,
        outputTokens: 12,
        cacheReadTokens: 13,
        cacheWriteTokens: 14,
        model: "usage-model",
      },
    });
    return { data: { content: this.responseContent, model: "response-model" } };
  }

  async disconnect() {
    this.disconnected = true;
  }
}

class FakeClient implements HelloSpeechClient {
  readonly createdSession: FakeSession;
  readonly resumedSession: FakeSession;
  readonly calls: string[] = [];
  createdConfig: SessionConfig | undefined;
  metadata: SessionMetadata | undefined = {
    sessionId: "existing",
    startTime: new Date(),
    modifiedTime: new Date(),
    isRemote: false,
  };
  started = false;
  stopped = false;
  onStop: (() => void) | undefined;

  constructor(sessionId = "generated-session") {
    this.createdSession = new FakeSession(sessionId);
    this.resumedSession = new FakeSession("existing");
  }

  async start() {
    this.started = true;
    this.calls.push("start");
  }

  async createSession(config: SessionConfig): Promise<HelloSpeechSession> {
    this.calls.push("create");
    this.createdConfig = config;
    return this.createdSession as unknown as HelloSpeechSession;
  }

  async resumeSession(sessionId: string): Promise<HelloSpeechSession> {
    this.calls.push(`resume:${sessionId}`);
    return (sessionId === this.createdSession.sessionId ? this.createdSession : this.resumedSession) as unknown as HelloSpeechSession;
  }

  async getSessionMetadata(_sessionId: string) {
    if (!this.started) throw new Error("Client not connected");
    this.calls.push("metadata");
    return this.metadata;
  }

  async stop() {
    this.calls.push("stop");
    this.stopped = true;
    this.onStop?.();
    return [];
  }
}

test("creates a session and returns response plus aggregated usage", async () => {
  const client = new FakeClient();
  const result = await solveHelloSpeech({ input: "hello" }, { createClient: () => client });

  assert.deepEqual(result, {
    response: "bot reply",
    sessionId: "generated-session",
    status: "in_progress",
    model: "response-model",
    elapsedMs: 123,
    inputTokens: 11,
    outputTokens: 12,
    cacheReadTokens: 13,
    cacheWriteTokens: 14,
  });
  assert.deepEqual(client.calls, ["create", "stop"]);
  assert.equal(client.createdSession.disconnected, true);
  assert.equal(client.stopped, true);
});

test("uses COPILOT_MODEL as the default for createSession", async () => {
  const previousModel = process.env.COPILOT_MODEL;
  process.env.COPILOT_MODEL = "configured-model";
  try {
    let receivedConfig: SessionConfig | undefined;
    await createSession({
      async createSession(config) {
        receivedConfig = config;
        return config;
      },
    }, {});
    assert.equal(receivedConfig?.model, "configured-model");
  } finally {
    if (previousModel === undefined) delete process.env.COPILOT_MODEL;
    else process.env.COPILOT_MODEL = previousModel;
  }
});

test("uses COPILOT_MODEL in the hello speech session config", async () => {
  const previousModel = process.env.COPILOT_MODEL;
  process.env.COPILOT_MODEL = "configured-model";
  try {
    const client = new FakeClient();
    await solveHelloSpeech({ input: "hello" }, { createClient: () => client });
    assert.equal(client.createdConfig?.model, "configured-model");
  } finally {
    if (previousModel === undefined) delete process.env.COPILOT_MODEL;
    else process.env.COPILOT_MODEL = previousModel;
  }
});

test("uses HELLO_SPEECH_MAX_QUESTIONS and allows three retries on the final question", async () => {
  const previousQuestionCount = process.env.HELLO_SPEECH_MAX_QUESTIONS;
  process.env.HELLO_SPEECH_MAX_QUESTIONS = "6";
  try {
    const client = new FakeClient();
    await solveHelloSpeech({ input: "hello" }, { createClient: () => client });
    const systemInstruction = JSON.stringify(client.createdConfig?.systemMessage);
    assert.match(systemInstruction, /at most 6 distinct questions/);
    assert.match(systemInstruction, /including the final question/);
    assert.match(systemInstruction, /Allow 3 retries after the initial answer/);
  } finally {
    if (previousQuestionCount === undefined) delete process.env.HELLO_SPEECH_MAX_QUESTIONS;
    else process.env.HELLO_SPEECH_MAX_QUESTIONS = previousQuestionCount;
  }
});

test("keeps concurrent HelloSpeech requests within the request limit", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let startedRequests = 0;
  let signalFourStarted: (() => void) | undefined;
  const fourStarted = new Promise<void>((resolve) => {
    signalFourStarted = resolve;
  });
  let releaseResponses: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponses = resolve;
  });
  const createClient = () => {
    const client = new FakeClient();
    client.createdSession.beforeResponse = async () => {
      inFlight++;
      startedRequests++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (startedRequests === 4) signalFourStarted?.();
      await responseGate;
    };
    client.onStop = () => {
      inFlight--;
    };
    return client;
  };
  const requests = Array.from({ length: 8 }, () =>
    solveHelloSpeech({ input: "hello" }, { createClient }),
  );

  await fourStarted;
  const startedAtLimit = startedRequests;
  releaseResponses?.();
  await Promise.all(requests);
  assert.equal(startedAtLimit, 4);
  assert.equal(startedRequests, 8);
  assert.equal(maxInFlight, 4);
});

test("checks and resumes a supplied session before sending", async () => {
  const client = new FakeClient();
  const result = await solveHelloSpeech({ input: "continue", sessionId: "existing" }, { createClient: () => client });

  assert.equal(result.sessionId, "existing");
  assert.deepEqual(client.calls, ["start", "metadata", "resume:existing", "stop"]);
  assert.equal(client.resumedSession.disconnected, true);
});

test("creates a new chat without a session ID", async () => {
  const client = new FakeClient();
  const result = await solveHelloSpeech({ newChat: true }, { createClient: () => client });

  assert.equal(result.response, "bot reply");
  assert.equal(result.sessionId, "generated-session");
  assert.equal(result.status, "in_progress");
  assert.deepEqual(client.calls, ["create", "stop"]);
});

test("resumes the LangGraph interrupt with the next frontend input", async () => {
  const client = new FakeClient();
  client.metadata = {
    sessionId: client.createdSession.sessionId,
    startTime: new Date(),
    modifiedTime: new Date(),
    isRemote: false,
  };
  client.createdSession.responseContent = "Please tell me your name.\n[[CONVERSATION_IN_PROGRESS]]";

  const first = await solveHelloSpeechGraph({ newChat: true }, { createClient: () => client });
  assert.equal(first.response, "Please tell me your name.");
  assert.equal(first.status, "in_progress");

  client.createdSession.responseContent = "Welcome, Alex.\n[[CONVERSATION_IN_PROGRESS]]";
  const next = await solveHelloSpeechGraph(
    { input: "Alex", sessionId: first.sessionId },
    { createClient: () => client },
  );

  assert.equal(next.response, "Welcome, Alex.");
  assert.equal(next.sessionId, first.sessionId);
  assert.equal(client.createdSession.prompts[1], "Alex");
});

test("standalone LangGraph entry persists the Copilot session and resumes the interrupt", async () => {
  const client = new FakeClient("existing");
  client.createdSession.responseContent = "Please tell me your name.\n[[CONVERSATION_IN_PROGRESS]]";
  const graph = createLangGraphSpeechGraph(
    { createClient: () => client },
    new MemorySaver(),
  );
  const config = { configurable: { thread_id: "standalone-speech" } };

  const first = await graph.invoke({ prompt: "Start training" }, config);
  assert.equal(first.response, "Please tell me your name.");
  assert.equal(first.sessionId, "existing");

  client.createdSession.responseContent = "Welcome, Alex.\n[[CONVERSATION_IN_PROGRESS]]";
  const second = await graph.invoke(new Command({ resume: "Alex" }), config);
  assert.equal(second.response, "Welcome, Alex.");
  assert.equal(second.sessionId, "existing");
  assert.deepEqual(client.createdSession.prompts, ["Start training", "Alex"]);
  assert.deepEqual(client.calls, ["create", "stop", "start", "metadata", "resume:existing", "stop"]);
});

test("selects the LangGraph service from configuration without changing the HTTP response shape", async () => {
  const previousService = process.env.HELLO_SPEECH_SERVICE;
  process.env.HELLO_SPEECH_SERVICE = "service_graph";
  const client = new FakeClient("graph-http-session");
  const server = createServer(createApp({ helloSpeech: { createClient: () => client } }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/features/hello-speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newChat: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), [
      "cacheReadTokens",
      "cacheWriteTokens",
      "elapsedMs",
      "inputTokens",
      "model",
      "outputTokens",
      "response",
      "sessionId",
      "status",
    ]);
    assert.equal(body.response, "bot reply");
    assert.equal(body.sessionId, "graph-http-session");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousService === undefined) delete process.env.HELLO_SPEECH_SERVICE;
    else process.env.HELLO_SPEECH_SERVICE = previousService;
  }
});

test("returns completed status and removes the protocol marker", async () => {
  const client = new FakeClient();
  client.createdSession.responseContent = "Goodbye.\n[[CONVERSATION_COMPLETED]]";

  const result = await solveHelloSpeech({ input: "exit" }, { createClient: () => client });

  assert.equal(result.response, "Goodbye.");
  assert.equal(result.status, "completed");
});

test("rejects unknown sessions and cleans up the client", async () => {
  const client = new FakeClient();
  client.metadata = undefined;

  await assert.rejects(
    solveHelloSpeech({ input: "continue", sessionId: "missing" }, { createClient: () => client }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "INVALID_SESSION",
  );
  assert.deepEqual(client.calls, ["start", "metadata", "stop"]);
  assert.equal(client.stopped, true);
});

test("maps the injected service response through the HTTP route", async () => {
  const client = new FakeClient();
  const server = createServer(createApp({ helloSpeech: { createClient: () => client } }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/features/hello-speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      response: "bot reply",
      sessionId: "generated-session",
      status: "in_progress",
      model: "response-model",
      elapsedMs: 123,
      inputTokens: 11,
      outputTokens: 12,
      cacheReadTokens: 13,
      cacheWriteTokens: 14,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
