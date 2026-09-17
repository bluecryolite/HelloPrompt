import { createCopilotClient, createSession } from "../hello-world/core.js";
import type { ShopointIntent } from "./types.js";
import { ShopointUsageTracker } from "./usage.js";

const INTENT_TIMEOUT_MS = 30000;
const intentSystemMessage = [
    "你是用户问题意图解析器，不负责解决问题。",
    "只根据用户原文判断用户想做什么，并严格返回 JSON，不要使用 Markdown，不要添加 JSON 之外的文字。",
    'JSON 格式必须是 {"type":"...","summary":"..."}。',
    `当用户是在排查一码付接口、报文、错误信息或相关代码问题时，type 必须为 "one_pay_problem_analysis"。`,
    '当用户明确要求统计、汇总、计数或指标分析时，type 使用 "statistics"。',
    '其他无法归入上述类型的问题，type 使用 "other"。',
    "summary 用一句话说明判定依据，不能为空。",
].join("\n");

function withCode(message: string, code: string) {
    return Object.assign(new Error(message), {code});
}

export type ShopointIntentAnalysis = {
    intent: ShopointIntent;
    model: string;
};

export async function analyzeShopointIntent(
    userPrompt: string,
    usage: ShopointUsageTracker,
): Promise<ShopointIntentAnalysis> {
    const client = createCopilotClient("empty");
    const session = await createSession(client, {
        systemMessage: {mode: "replace", content: intentSystemMessage},
        streaming: false,
        reasoningSummary: "none",
        availableTools: [],
    });
    session.on("assistant.usage", (event) => usage.record("intent-analysis", event.data));

    try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const response = await Promise.race([
                session.sendAndWait({prompt: userPrompt}, INTENT_TIMEOUT_MS),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(withCode("意图解析请求超时。", "TIMEOUT")), INTENT_TIMEOUT_MS);
                }),
            ]);
            const content = response?.data?.content;
            if (typeof content !== "string") throw withCode("意图解析模型没有返回有效内容。", "MODEL_OUTPUT");
            return {
                intent: parseShopointIntent(content),
                model: response?.data?.model ?? "未知模型",
            };
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    } finally {
        await client.stop();
    }
}

export function parseShopointIntent(content: string): ShopointIntent {
    const normalized = content.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(normalized);
    } catch {
        throw withCode("意图解析模型返回的内容不是有效 JSON。", "MODEL_OUTPUT");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw withCode("意图解析模型返回的 JSON 结构无效。", "MODEL_OUTPUT");
    }
    const value = parsed as Record<string, unknown>;
    if (
        Object.keys(value).sort().join(",") !== "summary,type" ||
        typeof value.type !== "string" ||
        !value.type.trim() ||
        typeof value.summary !== "string" ||
        !value.summary.trim()
    ) {
        throw withCode("意图解析模型返回的字段无效。", "MODEL_OUTPUT");
    }
    return {
        type: value.type.trim(),
        summary: value.summary.trim(),
        raw: content,
    };
}
