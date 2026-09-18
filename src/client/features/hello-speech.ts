import { requestJson } from "../services/http.js";

export type HelloSpeechResponse = {
  response: string;
  sessionId: string;
  status: "in_progress" | "completed";
  model: string;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHelloSpeechResponse(value: unknown): value is HelloSpeechResponse {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).sort().join(",") === "cacheReadTokens,cacheWriteTokens,elapsedMs,inputTokens,model,outputTokens,response,sessionId,status" &&
    typeof body.response === "string" &&
    typeof body.sessionId === "string" && body.sessionId.length > 0 &&
    (body.status === "in_progress" || body.status === "completed") &&
    typeof body.model === "string" && body.model.length > 0 &&
    isNonNegativeNumber(body.elapsedMs) &&
    isNonNegativeNumber(body.inputTokens) &&
    isNonNegativeNumber(body.outputTokens) &&
    isNonNegativeNumber(body.cacheReadTokens) &&
    isNonNegativeNumber(body.cacheWriteTokens);
}

export async function sendHelloSpeech(input: string, sessionId?: string): Promise<HelloSpeechResponse> {
  const body = await requestJson<unknown>("/features/hello-speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionId === undefined ? { input } : { input, sessionId }),
  });
  if (!isHelloSpeechResponse(body)) throw new Error("服务端返回的数据格式无效。");
  return body;
}

export async function startHelloSpeech(): Promise<HelloSpeechResponse> {
  const body = await requestJson<unknown>("/features/hello-speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newChat: true }),
  });
  if (!isHelloSpeechResponse(body)) throw new Error("服务端返回的数据格式无效。");
  return body;
}
