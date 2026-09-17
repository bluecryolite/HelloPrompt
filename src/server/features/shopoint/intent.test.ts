import assert from "node:assert/strict";
import test from "node:test";
import { parseShopointIntent } from "./intent.js";
import { routeShopointIntent } from "./service.js";
import { ONE_PAY_PROBLEM_ANALYSIS } from "./types.js";
import { ShopointUsageTracker } from "./usage.js";

test("parses a structured Shopoint intent", () => {
    assert.deepEqual(
        parseShopointIntent('{"type":"statistics","summary":"用户要求统计接口调用量"}'),
        {
            type: "statistics",
            summary: "用户要求统计接口调用量",
            raw: '{"type":"statistics","summary":"用户要求统计接口调用量"}',
        },
    );
});

test("accepts a JSON code fence but rejects non-JSON model output", () => {
    assert.equal(
        parseShopointIntent('```json\n{"type":"other","summary":"其他问题"}\n```').type,
        "other",
    );
    assert.throws(() => parseShopointIntent("无法判断"), {code: "MODEL_OUTPUT"});
    assert.throws(() => parseShopointIntent('{"type":"other","summary":"其他问题","extra":true}'), {code: "MODEL_OUTPUT"});
});

test("routes only registered intents to an independent handler", () => {
    assert.equal(typeof routeShopointIntent(ONE_PAY_PROBLEM_ANALYSIS), "function");
    assert.equal(routeShopointIntent("statistics"), undefined);
});

test("aggregates and logs all usage counters", () => {
    const logs: Array<{label: string; usage: Record<string, number>}> = [];
    const tracker = new ShopointUsageTracker((label, usage) => logs.push({label, usage}));

    tracker.record("intent-analysis", {
        elapsedMs: 10,
        inputTokens: 11,
        outputTokens: 12,
        cacheReadTokens: 13,
        cacheWriteTokens: 14,
    });
    tracker.record("one-pay-analysis", {
        elapsedMs: 20,
        inputTokens: 21,
        outputTokens: 22,
        cacheReadTokens: 23,
        cacheWriteTokens: 24,
    });

    assert.deepEqual(tracker.snapshot(), {
        elapsedMs: 30,
        inputTokens: 32,
        outputTokens: 34,
        cacheReadTokens: 36,
        cacheWriteTokens: 38,
    });
    assert.deepEqual(logs, [
        {
            label: "intent-analysis",
            usage: {elapsedMs: 10, inputTokens: 11, outputTokens: 12, cacheReadTokens: 13, cacheWriteTokens: 14},
        },
        {
            label: "one-pay-analysis",
            usage: {elapsedMs: 20, inputTokens: 21, outputTokens: 22, cacheReadTokens: 23, cacheWriteTokens: 24},
        },
    ]);
});
