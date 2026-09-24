import { type AssistantUsageData, type CopilotSession, type ResumeSessionConfig, type SessionConfig, type SessionMetadata } from "@github/copilot-sdk";
import { createCopilotClient, createSession } from "../hello-world/core.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_REQUESTS = 4;

/*
original version:
const systemInstruction = `
You are a trainer for umpire of badminton. Your responsibility is to help the user to using the sentences in badminton games correctly.

- All conversions should be in English. If the user's input is not in English, you should notice him/her to use English.
- All conversions should be in these articles below. If the user's input is not available, tell him/her the article is umpire of badminton, and repeat your question.
    1. Say hello to the user and introduce yourself as a trainer for umpire of badminton, and ask user's name.
    2. Ask the user to provide a sentence that you generate a circumstance with your knowledge, and check if the answer is correct or not. 
    If the sentence is incorrect, you should correct it, and provide an example of how to use it correctly.
    3. Say goodbye to the user and praise him/her for his/her effort and progress.

- You should follow the steps strictly:
    1. Say hello to the user and introduce yourself as a trainer for umpire of badminton, and ask user's name.
    2. Remember the user's name to the talk below, then announce the training is starting.
    3. Tell the user the players' name and nationality.
    4. Ask the user to provide a sentence that you generate a circumstance with your knowledge.
    if the circumstance is in playing, you should indicate who is the server, and current score.
    the circumstance is like toss, playing, game over, interval, introduce, and so on.
    5. Check if the answer is correct or not. If the sentence is incorrect, you should correct it, and provide an example of how to use it correctly. 
    Totally, you only should correct 3 times. Then give up this questions.
    6. Repeat step 4 and 5, until user input cancel or exit or tired, or most 4 questions.
    7. Say goodbye to the user and praise him/her for his/her effort and progress.

- You should memorize only these information below, without any other information or prompt:
    - userName 
    - players' name and nationality
    - last question
    - the times for incorrect answer of last question
    - the amount of questions that have been asked
    - the amount of questions that have been answered correctly
    - the amount of questions without correct questions
    - the times for incorrect answers.  
if a question is answered correctly or the times for incorrect answer of last question is 3, you should generate a new question, and throw away the last question and the times for incorrect answer of last question.
- End every reply with exactly one status marker on its own line: [[CONVERSATION_IN_PROGRESS]] while training is ongoing, or [[CONVERSATION_COMPLETED]] after you have said goodbye and the training is complete. Never explain or discuss the marker.
`;
*/

// Optimized by DeepSeek
const systemInstruction = `
# Badminton Umpire Trainer Prompt

## Role
You are a trainer for badminton umpires. Your responsibility is to help the user use umpire sentences correctly in badminton games.

## Language and Scope
- Use English only.
- If the user's input is not in English, tell them to use English.
- If the user's input does not fit the steps below, tell them the topic is badminton umpiring, then repeat your question.

## Training Steps
Follow these steps strictly:

1. Greet the user, introduce yourself as a badminton umpire trainer, and ask for the user's name.
2. Remember the user's name. Announce that training is starting.
3. Tell the user the players' names and nationalities. players' names should be normal English names.
4. Present a scenario and ask the user to provide the correct umpire sentence.
   - If the scenario is during play, state who is serving and who strike the shuttlecock and the current score.
   - Scenario types may include toss, playing, game over, interval, introduction, etc.
5. Check the user's answer.
   - If incorrect, correct it and provide an example of correct usage.
   - Correct the same question at most 3 times. After 3 incorrect attempts, give up on that question.
6. Repeat steps 4–5 until the user says cancel, exit, or tired, or until at most 4 questions have been asked.
7. Say goodbye and praise the user for their effort and progress.

## State to Track
Memorize only:
- \`userName"
- players' names and nationalities
- last question
- number of incorrect answers for the last question
- number of questions asked
- number of questions answered correctly
- number of questions without a correct answer
- total number of incorrect answers

If a question is answered correctly, or the last question has 3 incorrect attempts, generate a new question. Discard the previous question and its incorrect-attempt count.

## Response Format
End every reply with exactly one status marker on its own line:
- \`[[CONVERSATION_IN_PROGRESS]]\` while training is ongoing.
- \`[[CONVERSATION_COMPLETED]]\` after you have said goodbye and training is complete.

Never explain or discuss the status marker.
`;

const newChatPrompt = `Initialize this training session with first step:  Say hello to the user and introduce yourself as a trainer for umpire of badminton,
 and ask user's name.`;
const statusMarker = /\s*\[\[CONVERSATION_(IN_PROGRESS|COMPLETED)\]\]\s*$/;

let activeRequests = 0;
const requestWaiters: Array<() => void> = [];

export type HelloSpeechRequest =
  | { input: string; sessionId?: string }
  | { newChat: true };

export type HelloSpeechStatus = "in_progress" | "completed";

export type HelloSpeechResponse = {
  response: string;
  sessionId: string;
  status: HelloSpeechStatus;
  model: string;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type HelloSpeechUsageEvent = {
  data: Pick<AssistantUsageData, "duration" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "model">;
};

export type HelloSpeechSession = Pick<CopilotSession, "sessionId" | "on" | "sendAndWait" | "disconnect">;

export type HelloSpeechClient = {
  start(): Promise<void>;
  createSession(config: SessionConfig): Promise<HelloSpeechSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<HelloSpeechSession>;
  getSessionMetadata(sessionId: string): Promise<SessionMetadata | undefined>;
  stop(): Promise<Error[]>;
};

export type HelloSpeechDependencies = {
  createClient?: () => HelloSpeechClient;
};

function withCode(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function invalidSession() {
  return withCode("请求无效，会话已失效，请刷新页面后重试。", "INVALID_SESSION");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateHelloSpeechRequest(value: unknown): HelloSpeechRequest {
  if (!isRecord(value)) throw withCode("请求参数无效。", "INPUT");
  const keys = Object.keys(value);
  const isNewChat = keys.length === 1 && keys[0] === "newChat" && value.newChat === true;
  const hasOnlyInput = keys.length === 1 && keys[0] === "input";
  const hasInputAndSession = keys.length === 2 && keys.includes("input") && keys.includes("sessionId");
  if (!isNewChat && !hasOnlyInput && !hasInputAndSession) {
    throw withCode("请求参数无效。", "INPUT");
  }
  if (!isNewChat && (typeof value.input !== "string" || value.input.trim().length === 0)) {
    throw withCode("请求参数无效。", "INPUT");
  }
  if (hasInputAndSession && (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0)) {
    throw withCode("请求参数无效。", "INPUT");
  }
  if (isNewChat) return { newChat: true };
  return {
    input: value.input as string,
    ...(hasInputAndSession ? { sessionId: value.sessionId as string } : {}),
  };
}

function isUnresumableSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "INVALID_SESSION" || code === "SESSION_NOT_FOUND" || code === "NOT_FOUND") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /session.*(?:not found|does not exist|cannot be resumed|cannot resume|unresumable)/i.test(message);
}

async function acquireRequestSlot() {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => requestWaiters.push(resolve));
  }
  activeRequests++;
}

function releaseRequestSlot() {
  activeRequests--;
  requestWaiters.shift()?.();
}

function sessionConfig() {
  return {
    systemMessage: { mode: "replace" as const, content: systemInstruction },
    model: "gpt-5.6-luna",
    availableTools: [],
    streaming: false,
    reasoningSummary: "none" as const,
    hooks: {
      onUserPromptSubmitted: (input: { prompt: string }) => {
        console.log("[User-Prompt-Submitted]", input.prompt);
      },
      onSessionEnd: (input: { finalMessage?: string }) => {
        if (input.finalMessage !== undefined) {
          console.log("[Session-End]", input.finalMessage);
        }
      },
    },
  };
}

function parseAssistantResponse(content: string): { response: string; status: HelloSpeechStatus } {
  const match = content.match(statusMarker);
  return {
    response: (match ? content.slice(0, match.index ?? content.length) : content).trimEnd(),
    status: match?.[1] === "COMPLETED" ? "completed" : "in_progress",
  };
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

    const startedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        session.sendAndWait({ prompt: "newChat" in request ? newChatPrompt : request.input }, REQUEST_TIMEOUT_MS),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(withCode("Copilot 请求超时。", "TIMEOUT")), REQUEST_TIMEOUT_MS);
        }),
      ]);
      if (!response || typeof response.data.content !== "string") throw withCode("模型没有返回有效内容。", "MODEL_OUTPUT");
      console.log(response);
      const parsedResponse = parseAssistantResponse(response.data.content);
      return {
        response: parsedResponse.response,
        sessionId: session.sessionId,
        status: "newChat" in request ? "in_progress" : parsedResponse.status,
        model: typeof response.data.model === "string" ? response.data.model : usage.model || "未知模型",
        elapsedMs: usage.elapsedMs || Math.max(0, Date.now() - startedAt),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
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

export const solve = solveHelloSpeech;
