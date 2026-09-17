import { analyzeShopointIntent } from "./intent.js";
import { analyzeOnePay } from "./one-pay-analysis.js";
import type { ShopointAnalysisResult, ShopointResult } from "./types.js";
import { ONE_PAY_PROBLEM_ANALYSIS } from "./types.js";
import { ShopointUsageTracker } from "./usage.js";

type ShopointHandler = (userPrompt: string, usage: ShopointUsageTracker) => Promise<ShopointAnalysisResult>;

const handlers = new Map<string, ShopointHandler>([
    [ONE_PAY_PROBLEM_ANALYSIS, analyzeOnePay],
]);

export function routeShopointIntent(type: string): ShopointHandler | undefined {
    return handlers.get(type);
}

export async function solve(userPrompt: string): Promise<ShopointResult> {
    const usage = new ShopointUsageTracker();
    const parsed = await analyzeShopointIntent(userPrompt, usage);
    const handler = routeShopointIntent(parsed.intent.type);
    if (handler) {
        const result = await handler(userPrompt, usage);
        return {
            ...result,
            intent: parsed.intent,
        };
    }

    return {
        result: `暂不支持“${parsed.intent.type}”类型的问题。${parsed.intent.summary}`,
        model: parsed.model,
        ...usage.snapshot(),
        intent: parsed.intent,
        addressComparison: {
            officialInterfaceUrl: null,
            officialRoutePath: null,
            reportInterfacePath: null,
            reportMatchesOfficial: null,
            codeRoutePath: null,
            codeMatchesOfficial: null,
        },
        codeSearches: [],
    };
}
