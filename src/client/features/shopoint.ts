import { requestJson } from "../services/http.js";

export type ShopointResponse = { result: string; model: string };

function isShopointResponse(value: unknown): value is ShopointResponse {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).sort().join(",") === "model,result" &&
    typeof body.result === "string" &&
    typeof body.model === "string";
}

export async function solveShopoint(text: string): Promise<ShopointResponse> {
  const body = await requestJson<unknown>("/features/shopoint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!isShopointResponse(body)) throw new Error("服务端返回的数据格式无效。");
  return body;
}
