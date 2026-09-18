import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "./app.js";
import type { SessionConfig, SessionMetadata } from "@github/copilot-sdk";
import {
  solveHelloSpeech,
  type HelloSpeechClient,
  type HelloSpeechSession,
  type HelloSpeechUsageEvent,
} from "./features/hello-speech/service.js";

class FakeSession {
  readonly sessionId: string;
  private usageHandler: ((event: HelloSpeechUsageEvent) => void) | undefined;
  disconnected = false;
  shouldFail = false;
  responseContent = "bot reply";

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  on(_eventType: "assistant.usage", handler: (event: HelloSpeechUsageEvent) => void): () => void {
    this.usageHandler = handler;
    return () => {
      this.usageHandler = undefined;
    };
  }

  async sendAndWait(_options: { prompt: string }, _timeout?: number) {
    if (this.shouldFail) throw Object.assign(new Error("model failed"), { code: "MODEL" });
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
  metadata: SessionMetadata | undefined = {
    sessionId: "existing",
    startTime: new Date(),
    modifiedTime: new Date(),
    isRemote: false,
  };
  started = false;
  stopped = false;

  constructor() {
    this.createdSession = new FakeSession("generated-session");
    this.resumedSession = new FakeSession("existing");
  }

  async start() {
    this.started = true;
    this.calls.push("start");
  }

  async createSession(_config: SessionConfig): Promise<HelloSpeechSession> {
    this.calls.push("create");
    return this.createdSession as unknown as HelloSpeechSession;
  }

  async resumeSession(sessionId: string): Promise<HelloSpeechSession> {
    this.calls.push(`resume:${sessionId}`);
    return this.resumedSession as unknown as HelloSpeechSession;
  }

  async getSessionMetadata(_sessionId: string) {
    if (!this.started) throw new Error("Client not connected");
    this.calls.push("metadata");
    return this.metadata;
  }

  async stop() {
    this.calls.push("stop");
    this.stopped = true;
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

  assert.equal(result.response, "");
  assert.equal(result.sessionId, "generated-session");
  assert.equal(result.status, "in_progress");
  assert.deepEqual(client.calls, ["create", "stop"]);
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
