import { Annotation, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createCopilotClient, createSession } from "../hello-world/core.js";
import {
  REQUEST_TIMEOUT_MS,
  invalidSession,
  isUnresumableSessionError,
  newChatPrompt,
  parseAssistantResponse,
  sessionConfig,
  withCode,
  type HelloSpeechClient,
  type HelloSpeechDependencies,
  type HelloSpeechSession,
  type HelloSpeechStatus,
} from "./service.js";

loadEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)), quiet: true });

const speechState = Annotation.Root({
  prompt: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => newChatPrompt,
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
  sessionId: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
});

async function generateResponse(
  prompt: string,
  sessionId: string,
  dependencies: HelloSpeechDependencies,
) {
  const client: HelloSpeechClient = (dependencies.createClient ?? (() => createCopilotClient("empty")))();
  let session: HelloSpeechSession | undefined;
  try {
    const config = sessionConfig();
    if (sessionId) {
      await client.start();
      if (!await client.getSessionMetadata(sessionId)) throw invalidSession();
      try {
        session = await client.resumeSession(sessionId, config);
      } catch (error) {
        if (isUnresumableSessionError(error)) throw invalidSession();
        throw error;
      }
    } else {
      session = await createSession(client, config);
    }

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
        sessionId: session.sessionId,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    try {
      if (session) await session.disconnect();
    } finally {
      await client.stop();
    }
  }
}

export function createLangGraphSpeechGraph(
  dependencies: HelloSpeechDependencies = {},
  checkpointer?: MemorySaver,
) {
  const builder = new StateGraph(speechState)
    .addNode("generateResponse", async ({ prompt, sessionId }) => (
      generateResponse(prompt, sessionId, dependencies)
    ))
    .addNode("waitForUser", () => ({
      prompt: interrupt("Your response: "),
    }))
    .addEdge(START, "generateResponse")
    .addConditionalEdges(
      "generateResponse",
      ({ status }) => status === "completed" ? END : "waitForUser",
      [END, "waitForUser"],
    )
    .addEdge("waitForUser", "generateResponse");

  return checkpointer ? builder.compile({ checkpointer }) : builder.compile();
}

export const graph = createLangGraphSpeechGraph();
