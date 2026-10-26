import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createCopilotClient, createSession } from "../hello-world/core.js";
import {
  MAX_CONCURRENT_REQUESTS,
  REQUEST_TIMEOUT_MS,
  invalidSession,
  isUnresumableSessionError,
  newChatPrompt,
  parseAssistantResponse,
  sessionConfig,
  validateHelloSpeechRequest,
  withCode,
  type HelloSpeechClient,
  type HelloSpeechDependencies,
  type HelloSpeechResponse,
  type HelloSpeechSession,
  type HelloSpeechStatus,
} from "./service.js";

loadEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)), quiet: true });

const checkpointer = new MemorySaver();

const speechState = Annotation.Root({
  prompt: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  response: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  status: Annotation<HelloSpeechStatus>({
    reducer: (_current, next) => next,
    default: () => "in_progress",
  }),
  model: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
});

export function createSpeechGraph(session: HelloSpeechSession) {
  return new StateGraph(speechState)
    .addNode("generateResponse", async ({ prompt }) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          session.sendAndWait({ prompt }, REQUEST_TIMEOUT_MS),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(withCode("Copilot 请求超时。", "TIMEOUT")), REQUEST_TIMEOUT_MS);
          }),
        ]);
        if (!result || typeof result.data.content !== "string") {
          throw withCode("模型没有返回有效内容。", "MODEL_OUTPUT");
        }
        const parsed = parseAssistantResponse(result.data.content);
        return {
          response: parsed.response,
          status: parsed.status,
          model: typeof result.data.model === "string" ? result.data.model : "",
        };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })
    .addNode("waitForUser", () => ({
      prompt: interrupt("Your response: "),
    }))
    .addEdge(START, "generateResponse")
    .addConditionalEdges(
      "generateResponse",
      ({ status }) => status === "completed" ? END : "waitForUser",
      [END, "waitForUser"],
    )
    .addEdge("waitForUser", "generateResponse")
    .compile({ checkpointer });
}

let activeRequests = 0;
const requestWaiters: Array<() => void> = [];

async function acquireRequestSlot() {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    return;
  }
  await new Promise<void>((resolve) => requestWaiters.push(resolve));
}

function releaseRequestSlot() {
  const nextWaiter = requestWaiters.shift();
  if (nextWaiter) {
    nextWaiter();
    return;
  }
  activeRequests--;
}

export async function solveHelloSpeech(
  value: unknown,
  dependencies: HelloSpeechDependencies = {},
): Promise<HelloSpeechResponse> {
  const request = validateHelloSpeechRequest(value);
  await acquireRequestSlot();

  let client: HelloSpeechClient | undefined;
  let session: HelloSpeechSession | undefined;
  try {
    const currentClient = (dependencies.createClient ?? (() => createCopilotClient("empty")))();
    client = currentClient;
    const config = sessionConfig();
    if ("sessionId" in request && request.sessionId !== undefined) {
      await currentClient.start();
      const metadata = await currentClient.getSessionMetadata(request.sessionId);
      if (!metadata) throw invalidSession();
      try {
        session = await currentClient.resumeSession(request.sessionId, config);
      } catch (error) {
        if (isUnresumableSessionError(error)) throw invalidSession();
        throw error;
      }
    } else {
      session = await createSession(currentClient, config);
    }

    const usage = {
      elapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "",
    };
    session.on("assistant.usage", (event) => {
      usage.elapsedMs += event.data.duration ?? 0;
      usage.inputTokens += event.data.inputTokens ?? 0;
      usage.outputTokens += event.data.outputTokens ?? 0;
      usage.cacheReadTokens += event.data.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.data.cacheWriteTokens ?? 0;
      if (typeof event.data.model === "string") usage.model = event.data.model;
    });

    const graph = createSpeechGraph(session);
    const graphConfig = { configurable: { thread_id: session.sessionId } };
    const startedAt = Date.now();
    let result;
    if ("sessionId" in request && request.sessionId !== undefined) {
      const checkpoint = await graph.getState(graphConfig);
      if (!checkpoint.next.includes("waitForUser")) throw invalidSession();
      result = await graph.invoke(new Command({ resume: request.input }), graphConfig);
    } else {
      result = await graph.invoke({
        prompt: "newChat" in request ? newChatPrompt : request.input,
      }, graphConfig);
    }

    return {
      response: result.response,
      sessionId: session.sessionId,
      status: "newChat" in request ? "in_progress" : result.status,
      model: result.model || usage.model || "未知模型",
      elapsedMs: usage.elapsedMs || Math.max(0, Date.now() - startedAt),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    };
  } finally {
    try {
      if (session) await session.disconnect();
    } finally {
      try {
        if (client) await client.stop();
      } finally {
        releaseRequestSlot();
      }
    }
  }
}

export { solveHelloSpeech as solve };