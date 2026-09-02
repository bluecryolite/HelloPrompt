export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError("网络请求失败，请稍后重试。", "NETWORK_ERROR", 0);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("服务端返回的数据格式无效。", "INVALID_RESPONSE", response.status);
  }
  if (!response.ok) {
    const error = body && typeof body === "object" ? body as { message?: unknown; code?: unknown } : {};
    throw new ApiError(typeof error.message === "string" ? error.message : "请求失败。", typeof error.code === "string" ? error.code : "HTTP_ERROR", response.status);
  }
  return body as T;
}
