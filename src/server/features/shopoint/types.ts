export const ONE_PAY_PROBLEM_ANALYSIS = "one_pay_problem_analysis";

export type ShopointIntent = {
    type: string;
    summary: string;
    raw: string;
};

export type ShopointUsage = {
    elapsedMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
};

export type ShopointAddressComparison = {
    officialInterfaceUrl: string | null;
    officialRoutePath: string | null;
    reportInterfacePath: string | null;
    reportMatchesOfficial: boolean | null;
    codeRoutePath: string | null;
    codeMatchesOfficial: boolean | null;
};

export type ShopointCodeSearch = {
    root: string;
    query: string;
    matches: ShopointCodeLocation[];
    truncated: boolean;
};

export type ShopointCodeLocation = {
    path: string;
    line: number;
    text: string;
};

export type ShopointAnalysisResult = ShopointUsage & {
    result: string;
    model: string;
    addressComparison: ShopointAddressComparison;
    codeSearches: ShopointCodeSearch[];
};

export type ShopointResult = ShopointAnalysisResult & {
    intent: ShopointIntent;
};
