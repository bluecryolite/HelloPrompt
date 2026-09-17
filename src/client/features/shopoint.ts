import { requestJson } from "../services/http.js";

export type ShopointResponse = {
  result: string;
  model: string;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  intent: ShopointIntent;
  addressComparison: ShopointAddressComparison;
  codeSearches: ShopointCodeSearch[];
};

export type ShopointIntent = {
  type: string;
  summary: string;
  raw: string;
};

export type ShopointAddressComparison = {
  officialInterfaceUrl: string | null;
  officialRoutePath: string | null;
  reportInterfacePath: string | null;
  reportMatchesOfficial: boolean | null;
  codeRoutePath: string | null;
  codeMatchesOfficial: boolean | null;
};

export type ShopointCodeSearch = {
  root: string;
  query: string;
  matches: ShopointCodeLocation[];
  truncated: boolean;
};

export type ShopointCodeLocation = {
  path: string;
  line: number;
  text: string;
};

function isShopointResponse(value: unknown): value is ShopointResponse {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).sort().join(",") === "addressComparison,cacheReadTokens,cacheWriteTokens,codeSearches,elapsedMs,inputTokens,intent,model,outputTokens,result" &&
    typeof body.result === "string" &&
    typeof body.model === "string" &&
    typeof body.elapsedMs === "number" && Number.isFinite(body.elapsedMs) && body.elapsedMs >= 0 &&
    typeof body.inputTokens === "number" && Number.isFinite(body.inputTokens) && body.inputTokens >= 0 &&
    typeof body.outputTokens === "number" && Number.isFinite(body.outputTokens) && body.outputTokens >= 0 &&
    typeof body.cacheReadTokens === "number" && Number.isFinite(body.cacheReadTokens) && body.cacheReadTokens >= 0 &&
    typeof body.cacheWriteTokens === "number" && Number.isFinite(body.cacheWriteTokens) && body.cacheWriteTokens >= 0 &&
    isIntent(body.intent) &&
    isAddressComparison(body.addressComparison) &&
    isCodeSearches(body.codeSearches);
}

function isIntent(value: unknown): value is ShopointIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Record<string, unknown>;
  return Object.keys(intent).sort().join(",") === "raw,summary,type" &&
    typeof intent.type === "string" && intent.type.length > 0 &&
    typeof intent.summary === "string" && intent.summary.length > 0 &&
    typeof intent.raw === "string" && intent.raw.length > 0;
}

function isAddressComparison(value: unknown): value is ShopointAddressComparison {
  if (!value || typeof value !== "object") return false;
  const comparison = value as Record<string, unknown>;
  return Object.keys(comparison).sort().join(",") === "codeMatchesOfficial,codeRoutePath,officialInterfaceUrl,officialRoutePath,reportInterfacePath,reportMatchesOfficial" &&
    isNullableString(comparison.officialInterfaceUrl) &&
    isNullableString(comparison.officialRoutePath) &&
    isNullableString(comparison.reportInterfacePath) &&
    isNullableBoolean(comparison.reportMatchesOfficial) &&
    isNullableString(comparison.codeRoutePath) &&
    isNullableBoolean(comparison.codeMatchesOfficial);
}

function isCodeSearches(value: unknown): value is ShopointCodeSearch[] {
  return Array.isArray(value) && value.every((search) => {
    if (!search || typeof search !== "object") return false;
    const item = search as Record<string, unknown>;
    return Object.keys(item).sort().join(",") === "matches,query,root,truncated" &&
      typeof item.root === "string" &&
      typeof item.query === "string" &&
      typeof item.truncated === "boolean" &&
      Array.isArray(item.matches) &&
      item.matches.every((match) => {
        if (!match || typeof match !== "object") return false;
        const location = match as Record<string, unknown>;
        return Object.keys(location).sort().join(",") === "line,path,text" &&
          typeof location.path === "string" &&
          typeof location.line === "number" && Number.isSafeInteger(location.line) && location.line >= 1 &&
          typeof location.text === "string";
      });
  });
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
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
