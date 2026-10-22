import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { HelloSpeechDependencies } from "./features/hello-speech/service.js";
import { validateNumbers } from "./features/twenty-four/validation.js";

loadEnv({ path: fileURLToPath(new URL("./features/hello-speech/.env", import.meta.url)), quiet: true });

const port = Number(process.env.PORT ?? 30001);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const distDirectory = resolve(projectRoot, "dist");
const requests = new Map<string, { count: number; resetAt: number }>();
function logRequestError(route: string, error: unknown) {
  console.error(`[${route}] request failed`, error);
}

export function toErrorResponse(error: unknown): { status: number; body: { code: string; message: string } } {
  const code = (error as { code?: string }).code;
  const status = code === "INPUT" || code === "INVALID_SESSION" ? 400 : code === "NO_SOLUTION" ? 422 : code === "RATE_LIMIT" ? 429 : code === "TIMEOUT" ? 504 : 502;
  const responseCode = code === "INPUT" ? "INVALID_REQUEST" : code === "INVALID_SESSION" ? "INVALID_SESSION" : code === "AUTH" ? "COPILOT_AUTH" : code === "MODEL" ? "INVALID_MODEL" : code === "MODEL_OUTPUT" ? "MODEL_OUTPUT_INVALID" : code === "TIMEOUT" ? "UPSTREAM_TIMEOUT" : code === "NO_SOLUTION" ? "NO_SOLUTION" : code === "RATE_LIMIT" ? "RATE_LIMITED" : "COPILOT_UPSTREAM_ERROR";
  return { status, body: { code: responseCode, message: error instanceof Error ? error.message : "计算失败。" } };
}

export function createApp(dependencies: { helloSpeech?: HelloSpeechDependencies } = {}) {
  const app = express();
  app.set("trust proxy", process.env.TRUST_PROXY === "true");
  app.use(express.json({ limit: "4kb" }));
  app.get("/api/health", (_, res) => res.json({ ok: true }));
  app.post("/features/twenty-four", async (req, res) => {
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
      const { solveTwentyFour } = await import("./features/twenty-four/solver.js");
      const result = await solveTwentyFour(numbers);
      res.json(result);
    } catch (error) {
      logRequestError("/features/twenty-four", error);
      const response = toErrorResponse(error);
      res.status(response.status).json(response.body);
    }
  });
  app.post("/features/shopoint", async (req, res) => {
    try {
      const keys = Object.keys(req.body ?? {});
      if (keys.length !== 1 || keys[0] !== "text" || typeof req.body?.text !== "string") {
        throw Object.assign(new Error("请求参数无效。"), { code: "INPUT" });
      }
      const { solve } = await import("./features/shopoint/service.js");
      res.json(await solve(req.body.text));
    } catch (error) {
      logRequestError("/features/shopoint", error);
      const response = toErrorResponse(error);
      res.status(response.status).json(response.body);
    }
  });
  app.post("/features/hello-speech", async (req, res) => {
    try {
      const implementation = process.env.HELLO_SPEECH_SERVICE ?? "service";
      const module = implementation === "service"
        ? await import("./features/hello-speech/service.js")
        : implementation === "service_graph"
          ? await import("./features/hello-speech/service_graph.js")
          : undefined;
      if (!module) {
        throw new Error("HELLO_SPEECH_SERVICE must be either 'service' or 'service_graph'.");
      }
      res.json(await module.solveHelloSpeech(req.body, dependencies.helloSpeech));
    } catch (error) {
      logRequestError("/features/hello-speech", error);
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
    app.use(express.static(distDirectory));
    app.get("/{*splat}", (_, res) => res.sendFile("index.html", { root: distDirectory }));
  }
  return app;
}

export const app = createApp();
if (process.env.NODE_ENV !== "test") {
  createServer(app).listen(port, "0.0.0.0", () => console.log(`HelloPrompt listening on ${port}`));
}
