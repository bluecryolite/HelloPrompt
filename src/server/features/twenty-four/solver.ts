import { readFile } from "node:fs/promises";
import { requestCopilot } from "../../services/copilot.js";
import { findLocalSolution, validateSolution, type Solution } from "./validation.js";

const prompt = await readFile(new URL("../../../../prompts/24.md", import.meta.url), "utf8");
export type CopilotSolution = Solution & { model: string };

const systemInstruction = `你是 24 点结果校验器。只返回一个严格 JSON 对象，禁止 Markdown、自然语言和思维链。schema: {"status":"solution","expression":"仅含四个输入整数及 + - * / ()","steps":[{"operation":"恰好两个当前数字或分数的运算；引用先前分数时使用 {8/3} 或 {-1}","result":"精确数字或分数，如 0.75、8/3、-1","remaining":["精确数字或分数", "..."]}]}。status 只能是 solution 或 no_solution；solution 必须有恰好 3 个 steps，每步只合并两个当前值，允许一元负号，result 和 remaining 中的分数必须使用字符串精确表示（例如 8/3，不要输出循环小数）；remaining 必须是合并后的完整值集合；no_solution 时 expression 必须为空字符串且 steps 必须为空数组。`;

function invalidModelOutput(message: string) {
  return Object.assign(new Error(message), { code: "MODEL_OUTPUT" });
}

export async function solveTwentyFour(numbers: number[]): Promise<CopilotSolution> {
  const response = await requestCopilot({
    systemInstruction,
    prompt: `${prompt}\n\n输入数字：${JSON.stringify(numbers)}\n返回 JSON。`
  });
  let parsed: { status?: string; expression?: string; steps?: unknown };
  try {
    parsed = JSON.parse(response.content) as typeof parsed;
  } catch {
    throw invalidModelOutput("模型返回的 JSON 无效。");
  }
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).sort().join(",") !== "expression,status,steps" ||
      (parsed.status !== "solution" && parsed.status !== "no_solution")) {
    throw invalidModelOutput("模型返回字段无效。");
  }
  if (parsed.status === "no_solution") {
    if (parsed.expression !== "" || !Array.isArray(parsed.steps) || parsed.steps.length !== 0) {
      throw invalidModelOutput("无解响应结构无效。");
    }
    if (!findLocalSolution(numbers)) throw Object.assign(new Error("这四个数字无法组成 24。"), { code: "NO_SOLUTION" });
    throw invalidModelOutput("模型返回结果无效。");
  }
  try {
    return { ...validateSolution(numbers, parsed.expression, parsed.steps), model: response.model };
  } catch (error) {
    throw invalidModelOutput(error instanceof Error ? error.message : "模型返回结果无效。");
  }
}
