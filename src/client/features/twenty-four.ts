import { requestJson } from "../services/http.js";

export type NumericValue = number | string;
export type Step = { operation: string; result: NumericValue; remaining: NumericValue[] };
export type SolveResponse = {
  expression: string;
  formattedExpression: string;
  steps: Step[];
  model: string;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function isSolveResponse(value: unknown): value is SolveResponse {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).sort().join(",") === "cacheReadTokens,cacheWriteTokens,elapsedMs,expression,formattedExpression,inputTokens,model,outputTokens,steps" &&
    typeof body.expression === "string" && typeof body.formattedExpression === "string" &&
    typeof body.elapsedMs === "number" && Number.isFinite(body.elapsedMs) && body.elapsedMs >= 0 &&
    typeof body.inputTokens === "number" && Number.isFinite(body.inputTokens) && body.inputTokens >= 0 &&
    typeof body.outputTokens === "number" && Number.isFinite(body.outputTokens) && body.outputTokens >= 0 &&
    typeof body.cacheReadTokens === "number" && Number.isFinite(body.cacheReadTokens) && body.cacheReadTokens >= 0 &&
    typeof body.cacheWriteTokens === "number" && Number.isFinite(body.cacheWriteTokens) && body.cacheWriteTokens >= 0 &&
    typeof body.model === "string" && Array.isArray(body.steps) &&
    body.steps.every((step) => {
      if (!step || typeof step !== "object") return false;
      const item = step as Record<string, unknown>;
      return Object.keys(item).sort().join(",") === "operation,remaining,result" &&
        typeof item.operation === "string" && (typeof item.result === "number" || typeof item.result === "string") &&
        Array.isArray(item.remaining) && item.remaining.every((n) => typeof n === "number" || typeof n === "string");
    });
}

export async function solveTwentyFour(numbers: number[]): Promise<SolveResponse> {
  const body = await requestJson<unknown>("/features/twenty-four", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numbers })
  });
  if (!isSolveResponse(body)) throw new Error("服务端返回的数据格式无效。");
  return body;
}
