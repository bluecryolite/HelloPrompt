import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { solveWithCopilot } from "./copilot.js";
import { validateNumbers } from "./validation.js";

export const app = express();
const port = Number(process.env.PORT ?? 30001);
const requests = new Map<string, { count: number; resetAt: number }>();
export function toErrorResponse(error: unknown): { status: number; body: { code: string; message: string } } {
  const code = (error as { code?: string }).code;
  const status = code === "INPUT" ? 400 : code === "NO_SOLUTION" ? 422 : code === "RATE_LIMIT" ? 429 : code === "TIMEOUT" ? 504 : 502;
  const responseCode = code === "INPUT" ? "INVALID_REQUEST" : code === "AUTH" ? "COPILOT_AUTH" : code === "MODEL" ? "INVALID_MODEL" : code === "MODEL_OUTPUT" ? "MODEL_OUTPUT_INVALID" : code === "TIMEOUT" ? "UPSTREAM_TIMEOUT" : code === "NO_SOLUTION" ? "NO_SOLUTION" : code === "RATE_LIMIT" ? "RATE_LIMITED" : "COPILOT_UPSTREAM_ERROR";
  return { status, body: { code: responseCode, message: error instanceof Error ? error.message : "计算失败。" } };
}
app.set("trust proxy", process.env.TRUST_PROXY === "true");
app.use(express.json({ limit: "4kb" }));
app.get("/api/health", (_, res) => res.json({ ok: true }));
app.post("/api/solve", async (req, res) => {
  const started = performance.now();
  try {
    const keys = Object.keys(req.body ?? {});
    if (keys.length !== 1 || keys[0] !== "numbers") {
      throw Object.assign(new Error("请求参数无效。"), { code: "INPUT" });
    }
    const now = Date.now();
    for (const [ip, entry] of requests) if (entry.resetAt <= now) requests.delete(ip);
    const clientIp = req.ip ?? "unknown";
    const client = requests.get(clientIp);
    if (client && client.resetAt > now && client.count >= 10) {
      throw Object.assign(new Error("请求过于频繁，请稍后再试。"), { code: "RATE_LIMIT" });
    }
    if (!client || client.resetAt <= now) requests.set(clientIp, { count: 1, resetAt: now + 60_000 });
    else client.count++;
    const numbers = validateNumbers(req.body?.numbers);
    const result = await solveWithCopilot(numbers);
    res.json({ ...result, elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    const response = toErrorResponse(error);
    res.status(response.status).json(response.body);
  }
});
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ code: "INVALID_JSON", message: "请求 JSON 格式无效。" });
    return;
  }
  next(error);
});

if (process.env.NODE_ENV !== "test") {
  app.use(express.static("dist"));
  app.get("/{*splat}", (_, res) => res.sendFile("index.html", { root: "dist" }));
}
if (process.env.NODE_ENV !== "test") {
  createServer(app).listen(port, "0.0.0.0", () => console.log(`HelloPrompt listening on ${port}`));
}
