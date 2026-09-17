import type { ShopointUsage } from "./types.js";

export type UsageEvent = Partial<ShopointUsage>;
export type UsageLogger = (label: string, usage: ShopointUsage) => void;

const emptyUsage = (): ShopointUsage => ({
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
});

function nonNegativeNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export class ShopointUsageTracker {
    private readonly totals = emptyUsage();

    public constructor(
        private readonly logger: UsageLogger = (label, usage) => {
            console.error(`[shopoint][usage] ${label}`, JSON.stringify(usage));
        },
    ) {}

    public record(label: string, event: UsageEvent): void {
        const current = {
            elapsedMs: nonNegativeNumber(event.elapsedMs),
            inputTokens: nonNegativeNumber(event.inputTokens),
            outputTokens: nonNegativeNumber(event.outputTokens),
            cacheReadTokens: nonNegativeNumber(event.cacheReadTokens),
            cacheWriteTokens: nonNegativeNumber(event.cacheWriteTokens),
        };
        this.totals.elapsedMs += current.elapsedMs;
        this.totals.inputTokens += current.inputTokens;
        this.totals.outputTokens += current.outputTokens;
        this.totals.cacheReadTokens += current.cacheReadTokens;
        this.totals.cacheWriteTokens += current.cacheWriteTokens;
        this.logger(label, current);
    }

    public snapshot(): ShopointUsage {
        return {...this.totals};
    }
}
