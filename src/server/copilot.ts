import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSolution, findLocalSolution, type Solution } from "./validation.js";

const prompt = await readFile(new URL("../../prompts/24.md", import.meta.url), "utf8");
const copilotDataDirectory = resolve(process.env.COPILOT_DATA_DIRECTORY ?? ".copilot");
let client: CopilotClient | undefined;
let clientStartPromise: Promise<CopilotClient> | undefined;
let modelsPromise: Promise<Set<string>> | undefined;
let activeRequests = 0;
const waiters: Array<() => void> = [];

export type CopilotSolution = Solution & { model: string };

function invalidModelOutput(message: string, raw: unknown) {
  console.error(message, { raw });
  return Object.assign(new Error(message), { code: "MODEL_OUTPUT" });
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
  throw new Error(`未找到适用于 ${process.platform}/${process.arch} 的 Copilot CLI。`);
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
  if (activeRequests >= 4) await new Promise<void>((resolve) => waiters.push(resolve));
  activeRequests++;
}

function releaseSlot() {
  activeRequests--;
  waiters.shift()?.();
}

export async function solveWithCopilot(numbers: number[]): Promise<CopilotSolution> {
  if (!process.env.COPILOT_GITHUB_TOKEN) throw Object.assign(new Error("服务端未配置 Copilot 令牌。"), { code: "AUTH" });
  await acquireSlot();
  try {
    const client = await getClient();
    modelsPromise ??= client.listModels().then((models) => new Set(models.map((model) => model.id)));
    const models = await modelsPromise;
    const requestedModel = process.env.COPILOT_MODEL;
    if (requestedModel && !models.has(requestedModel)) {
      throw Object.assign(new Error("配置的 Copilot 模型不可用。"), { code: "MODEL" });
    }
    const session = await client.createSession({
      ...(requestedModel ? { model: requestedModel } : {}),
      availableTools: [],
      systemMessage: { mode: "replace", content: `你是 24 点结果校验器。只返回一个严格 JSON 对象，禁止 Markdown、自然语言和思维链。schema: {"status":"solution","expression":"仅含四个输入整数及 + - * / ()","steps":[{"operation":"恰好两个当前数字或分数的运算；引用先前分数时使用 {8/3} 或 {-1}","result":"精确数字或分数，如 0.75、8/3、-1","remaining":["精确数字或分数", "..."]}]}。status 只能是 solution 或 no_solution；solution 必须有恰好 3 个 steps，每步只合并两个当前值，允许一元负号，result 和 remaining 中的分数必须使用字符串精确表示（例如 8/3，不要输出循环小数）；remaining 必须是合并后的完整值集合；no_solution 时 expression 必须为空字符串且 steps 必须为空数组。` }
    });
    try {
    const response = await Promise.race([
      session.sendAndWait({ prompt: `${prompt}\n\n输入数字：${JSON.stringify(numbers)}\n返回 JSON。` }, 30000),
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("Copilot 请求超时。"), { code: "TIMEOUT" })), 30000))
    ]);
    const raw = response?.data?.content;
    if (typeof raw !== "string") throw invalidModelOutput("模型没有返回有效内容。", raw);
    let parsed: { status?: string; expression?: string; steps?: unknown };
    try {
      parsed = JSON.parse(raw) as { status?: string; expression?: string; steps?: unknown };
    } catch {
      throw invalidModelOutput("模型返回的 JSON 无效。", raw);
    }
    if (!parsed || typeof parsed !== "object" || Object.keys(parsed).sort().join(",") !== "expression,status,steps" ||
        (parsed.status !== "solution" && parsed.status !== "no_solution")) {
      throw invalidModelOutput("模型返回字段无效。", raw);
    }
    if (parsed.status === "no_solution") {
      if (parsed.expression !== "" || !Array.isArray(parsed.steps) || parsed.steps.length !== 0) {
        throw invalidModelOutput("无解响应结构无效。", raw);
      }
      if (!findLocalSolution(numbers)) throw Object.assign(new Error("这四个数字无法组成 24。"), { code: "NO_SOLUTION" });
      throw invalidModelOutput("模型返回结果无效。", raw);
    }
    try {
      return {
        ...validateSolution(numbers, parsed.expression, parsed.steps),
        model: requestedModel || "Copilot 默认模型"
      };
    } catch (error) {
      throw invalidModelOutput(error instanceof Error ? error.message : "模型返回结果无效。", raw);
    }
  } finally {
    await session.disconnect();
    }
  } finally {
    releaseSlot();
  }
}
