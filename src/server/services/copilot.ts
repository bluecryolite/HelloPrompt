import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const copilotDataDirectory = resolve(process.env.COPILOT_DATA_DIRECTORY ?? ".copilot");
let client: CopilotClient | undefined;
let clientStartPromise: Promise<CopilotClient> | undefined;
let modelsPromise: Promise<Set<string>> | undefined;
let activeRequests = 0;
const waiters: Array<() => void> = [];

export type CopilotRequest = { systemInstruction: string; prompt: string; model?: string };
export type CopilotUsage = {
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
export type CopilotResponse = { content: string; model: string } & CopilotUsage;

function withCode(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function resolveCopilotCliPath() {
  const variants = process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform];
  for (const variant of variants) {
    try {
      return fileURLToPath(import.meta.resolve(`@github/copilot-${variant}-${process.arch}`));
    } catch {
      // Try the next compatible platform package.
    }
  }
  throw withCode(`未找到适用于 ${process.platform}/${process.arch} 的 Copilot CLI。`, "UPSTREAM");
}

async function getClient() {
  if (client) return client;
  clientStartPromise ??= (async () => {
    await mkdir(copilotDataDirectory, { recursive: true });
    const startedClient = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: resolveCopilotCliPath() }),
      gitHubToken: process.env.COPILOT_GITHUB_TOKEN,
      mode: "empty",
      baseDirectory: copilotDataDirectory,
      sessionIdleTimeoutSeconds: 60
    });
    await startedClient.start();
    client = startedClient;
    return startedClient;
  })();
  try {
    return await clientStartPromise;
  } catch (error) {
    clientStartPromise = undefined;
    throw error;
  }
}

async function acquireSlot() {
  if (activeRequests >= 4) await new Promise<void>((release) => waiters.push(release));
  activeRequests++;
}

function releaseSlot() {
  activeRequests--;
  waiters.shift()?.();
}

export async function requestCopilot(request: CopilotRequest): Promise<CopilotResponse> {
  if (!process.env.COPILOT_GITHUB_TOKEN) throw withCode("服务端未配置 Copilot 令牌。", "AUTH");
  await acquireSlot();
  try {
    const copilot = await getClient();
    modelsPromise ??= copilot.listModels().then((models) => new Set(models.map((model) => model.id)));
    const models = await modelsPromise;
    const model = request.model ?? process.env.COPILOT_MODEL;
    if (model && !models.has(model)) throw withCode("配置的 Copilot 模型不可用。", "MODEL");
    const session = await copilot.createSession({
      ...(model ? { model } : {}),
      availableTools: [],
      systemMessage: { mode: "replace", content: request.systemInstruction },
      reasoningEffort: "low",
    });
    const usage: CopilotUsage = {
      elapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    };
    session.on("assistant.usage", (event) => {
      usage.elapsedMs += event.data.duration ?? 0;
      usage.inputTokens += event.data.inputTokens ?? 0;
      usage.outputTokens += event.data.outputTokens ?? 0;
      usage.cacheReadTokens += event.data.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.data.cacheWriteTokens ?? 0;
    });
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          session.sendAndWait({ prompt: request.prompt }, 30000),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(withCode("Copilot 请求超时。", "TIMEOUT")), 30000);
          })
        ]);
        const content = response?.data?.content;
        if (typeof content !== "string") throw withCode("模型没有返回有效内容。", "MODEL_OUTPUT");
        return { content, model: response?.data?.model ?? "未知模型", ...usage };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } finally {
      await session.disconnect();
    }
  } finally {
    releaseSlot();
  }
}
