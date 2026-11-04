
import {
    Annotation,
    Command,
    END,
    MemorySaver,
    START,
    StateGraph,
    interrupt,
    isInterrupted,
} from "@langchain/langgraph";
import { createAgent } from "langchain";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createCopilotClient } from "./core.js";
import {
    CopilotChatModel,
    type CopilotChatModelOptions,
    type CopilotUsageObserver,
} from "./lang-chatnormal-model.js";

const featureDirectory = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(featureDirectory, ".env"), quiet: true });
loadEnv({ path: resolve(featureDirectory, "../../../../.env"), quiet: true });

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const MAX_CHECK_FAILURES = 8;

// const rule = `1. 接收参赛人数，参赛人数不超过8人。如果没有收到参赛人数，或者参数人数不满足要求，返回提示信息，要求用户输入正确的参赛人数。
// 2. 比赛为单循环赛制
// 3. 每位参赛选手都需要和其他选手搭档至少一次
// 4. 每位参赛选手都需要和其他选手对战至少一次
// 5. 每位参赛选手连续作战的场次为最小
// 6. 每位参赛选手场下休息的场次为最小
// 7. 每位参赛选手的参赛场数相同
// 8. 参赛者以小写字母表示。如：a、b、c、d表示4位参赛者
// `;

const rule = `1. 接收参赛人数，参赛人数不超过10人。如果没有收到参赛人数，或者参数人数不满足要求，返回提示信息，要求用户输入正确的参赛人数。
2. 每位参赛选手都需要和其他选手搭档至少一次
3. 每位参赛选手需要和其他选手对战至少一次，且对战次数为最小
4. 每位参赛选手连续作战的场次最大为两轮
5. 每位参赛选手场下休息的场次最大为两轮
6. 每位参赛选手的参赛场数相同
7. 总的比赛场次最少
8. 参赛者以小写字母表示。如：a、b、c、d表示4位参赛者
`;

const promptGenerator = `你是一名羽毛球比赛赛程的制定者。需要在一个场地上安排一场羽毛球双打比赛的赛程。请根据以下要求生成赛程：
` + rule
+ `请只返回合法JSON对象，不要添加Markdown或解释。有可行赛程时，格式为{"status":"ok","schedule":[{"match_number":1,"team1":["a","b"],"team2":["c","d"]}]}；如果确认无解，格式为{"status":"unsolvable","schedule":[],"reason":"无解原因"}。不要仅因暂时想不到方案就判定无解。`
;

const promptChecker = `你是一名羽毛球比赛赛程的核对者。请根据以下要求检查赛程是否符合要求：
` + rule
+ `非空赛程符合要求时返回{status:"ok"}；不符合时返回{status:"error","message":"错误信息"}。如果赛程为空数组，请独立判断在当前参赛人数下是否确实不存在满足全部要求的赛程；只有确认无解时才返回{status:"ok","reason":"无解原因"}，否则返回{status:"error","message":"无解判断不成立的原因或可行方向"}。`
;

type ParticipantStats = {
    participant: string;
    matchesPlayed: number;
    maxConsecutivePlayMatches: number;
    maxConsecutiveRestMatches: number;
    meetings: Array<{
        participant: string;
        partnerMatches: number;
        opponentMatches: number;
    }>;
};

const workflowState = Annotation.Root({
    participantCountInput: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    participantCount: Annotation<number | null>({
        reducer: (_current, next) => next,
        default: () => null,
    }),
    schedule: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    noSolutionReason: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    checkerResponse: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    checkerStatus: Annotation<"ok" | "error">({
        reducer: (_current, next) => next,
        default: () => "error",
    }),
    checkerFailureCount: Annotation<number>({
        reducer: (_current, next) => next,
        default: () => 0,
    }),
    participantStats: Annotation<ParticipantStats[]>({
        reducer: (_current, next) => next,
        default: () => [],
    }),
});

function getAgentResponse(result: { messages: Array<{ text: string }> }): string {
    const finalMessage = result.messages.at(-1);
    if (!finalMessage) {
        throw new Error("The agent returned no messages.");
    }
    return finalMessage.text;
}

function parseCheckerStatus(response: string): "ok" | "error" {
    const match = response.match(/["']?status["']?\s*:\s*["']?(ok|error)\b/iu);
    const status = match?.[1]?.toLowerCase();
    if (status !== "ok" && status !== "error") {
        throw new Error(`The schedule checker returned an invalid status: ${response}`);
    }
    return status;
}

function parseCheckerReason(response: string): string {
    const match = response.match(/["']?reason["']?\s*:\s*("(?:\\.|[^"\\])*")/u);
    if (!match?.[1]) {
        return "";
    }
    try {
        const reason: unknown = JSON.parse(match[1]);
        return typeof reason === "string" ? reason.trim() : "";
    } catch (error) {
        throw new Error("The schedule checker returned an invalid reason.", { cause: error });
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlayerPair(value: unknown): value is [string, string] {
    return Array.isArray(value)
        && value.length === 2
        && typeof value[0] === "string"
        && typeof value[1] === "string";
}

function parseGeneratorResponse(response: string): { schedule: string; noSolutionReason: string } {
    const jsonText = response.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    let parsedOutput: unknown;
    try {
        parsedOutput = JSON.parse(jsonText);
    } catch (error) {
        throw new Error("The schedule generator returned invalid JSON.", { cause: error });
    }

    if (!isRecord(parsedOutput) || !Array.isArray(parsedOutput.schedule)) {
        throw new Error("The schedule generator returned an invalid result.");
    }
    if (parsedOutput.status === "ok" && parsedOutput.schedule.length > 0) {
        return { schedule: JSON.stringify(parsedOutput.schedule), noSolutionReason: "" };
    }
    if (
        parsedOutput.status === "unsolvable"
        && parsedOutput.schedule.length === 0
        && typeof parsedOutput.reason === "string"
        && parsedOutput.reason.trim().length > 0
    ) {
        return { schedule: "[]", noSolutionReason: parsedOutput.reason.trim() };
    }
    throw new Error("The schedule generator returned an inconsistent status and schedule.");
}

function parseScheduleOutput(
    scheduleOutput: string,
    participantCount: number,
): { schedule: string; participantStats: ParticipantStats[] } {
    const arrayStart = scheduleOutput.indexOf("[");
    const arrayEnd = scheduleOutput.lastIndexOf("]");
    if (arrayStart === -1 || arrayEnd < arrayStart) {
        throw new Error("The generated schedule does not contain a JSON array.");
    }

    let parsedOutput: unknown;
    try {
        parsedOutput = JSON.parse(scheduleOutput.slice(arrayStart, arrayEnd + 1));
    } catch (error) {
        throw new Error("The generated schedule is not valid JSON.", { cause: error });
    }
    if (!Array.isArray(parsedOutput) || parsedOutput.length === 0) {
        throw new Error("The generated schedule must be a non-empty JSON array.");
    }

    const participants = Array.from(
        { length: participantCount },
        (_value, index) => String.fromCharCode("a".charCodeAt(0) + index),
    );
    const participantSet = new Set(participants);
    const matches = parsedOutput.map((value, index) => {
        if (!isRecord(value)) {
            throw new Error(`The generated schedule has an invalid match at index ${index}.`);
        }
        const matchNumber = value.match_number;
        if (typeof matchNumber !== "number"
            || !Number.isSafeInteger(matchNumber)
            || matchNumber < 1
            || !isPlayerPair(value.team1)
            || !isPlayerPair(value.team2)) {
            throw new Error(`The generated schedule has an invalid match at index ${index}.`);
        }

        const players = [...value.team1, ...value.team2];
        if (new Set(players).size !== 4 || players.some((player) => !participantSet.has(player))) {
            throw new Error(`The generated schedule has invalid players in match ${matchNumber}.`);
        }

        return {
            matchNumber,
            team1: value.team1,
            team2: value.team2,
            players: new Set(players),
        };
    }).sort((left, right) => left.matchNumber - right.matchNumber);

    if (new Set(matches.map(({ matchNumber }) => matchNumber)).size !== matches.length) {
        throw new Error("The generated schedule contains duplicate match numbers.");
    }

    const participantStats = participants.map((participant) => {
        let matchesPlayed = 0;
        let currentPlayStreak = 0;
        let currentRestStreak = 0;
        let maxConsecutivePlayMatches = 0;
        let maxConsecutiveRestMatches = 0;
        const meetings = new Map<string, {
            participant: string;
            partnerMatches: number;
            opponentMatches: number;
        }>();
        for (const otherParticipant of participants) {
            if (otherParticipant !== participant) {
                meetings.set(otherParticipant, {
                    participant: otherParticipant,
                    partnerMatches: 0,
                    opponentMatches: 0,
                });
            }
        }

        for (const match of matches) {
            if (match.players.has(participant)) {
                matchesPlayed++;
                currentPlayStreak++;
                currentRestStreak = 0;
                maxConsecutivePlayMatches = Math.max(maxConsecutivePlayMatches, currentPlayStreak);
                const participantTeam = match.team1.includes(participant) ? match.team1 : match.team2;
                for (const otherParticipant of match.players) {
                    if (otherParticipant === participant) {
                        continue;
                    }
                    const meeting = meetings.get(otherParticipant);
                    if (!meeting) {
                        throw new Error(`Missing meeting statistics for ${otherParticipant}.`);
                    }
                    if (participantTeam.includes(otherParticipant)) {
                        meeting.partnerMatches++;
                    } else {
                        meeting.opponentMatches++;
                    }
                }
            } else {
                currentRestStreak++;
                currentPlayStreak = 0;
                maxConsecutiveRestMatches = Math.max(maxConsecutiveRestMatches, currentRestStreak);
            }
        }

        return {
            participant,
            matchesPlayed,
            maxConsecutivePlayMatches,
            maxConsecutiveRestMatches,
            meetings: [...meetings.values()],
        };
    });
    const formattedSchedule = `[\n${matches.map(({ matchNumber, team1, team2 }) => (
        `  ${JSON.stringify({ match_number: matchNumber, team1, team2 })}`
    )).join(",\n")}\n]`;

    return { schedule: formattedSchedule, participantStats };
}

function getRequestTimeoutMs(): number {
    const value = process.env.HELLO_WORLD_REQUEST_TIMEOUT_MS;
    if (value === undefined) {
        return DEFAULT_REQUEST_TIMEOUT_MS;
    }

    const timeoutMs = Number(value);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
        throw new Error(
            `HELLO_WORLD_REQUEST_TIMEOUT_MS must be a positive integer no greater than ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`,
        );
    }
    return timeoutMs;
}

const tracingConfig = {
    configurable: { thread_id: "hello-world016-console" },
    runName: "hello-world016-schedule-workflow",
    tags: ["hello-world016", "schedule"],
    metadata: { feature: "hello-world016" },
};
let client: ReturnType<typeof createCopilotClient> | undefined;
let readline: ReturnType<typeof createInterface> | undefined;
const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: new Set<string>(),
    eventCount: 0,
};
const configuredModel = process.env.COPILOT_MODEL ?? "gpt-6-luna";
const usageObserver: CopilotUsageObserver = {
    onUsage: ({ model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 }) => {
        usage.models.add(model);
        usage.inputTokens += inputTokens;
        usage.outputTokens += outputTokens;
        usage.cacheReadTokens += cacheReadTokens;
        usage.cacheWriteTokens += cacheWriteTokens;
        usage.eventCount++;
    },
    onModelCallFailure: (model) => {
        if (model) {
            usage.models.add(model);
        }
    },
};

function logUsageSummary(context: string): void {
    console.error(`${context}；模型与Token消耗：`, {
        models: usage.models.size > 0 ? [...usage.models] : [`${configuredModel}（配置模型，实际模型未报告）`],
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        tokenUsageStatus: usage.eventCount > 0
            ? "仅统计SDK已返回的用量事件；超时中的请求可能尚未计入"
            : "SDK尚未返回用量事件，当前Token消耗无法准确统计",
        usageEvents: usage.eventCount,
    });
}

try {
    const requestTimeoutMs = getRequestTimeoutMs();
    const activeClient = createCopilotClient();
    client = activeClient;
    const activeReadline = createInterface({ input: stdin, output: stdout });
    readline = activeReadline;
    const modelOptions: CopilotChatModelOptions = { usageObserver, requestTimeoutMs };

    const generatorAgent = await createAgent({
        model: new CopilotChatModel(activeClient, {model: "gpt-6.1-terra"}, undefined, modelOptions),
        systemPrompt: promptGenerator,
    });
    const checkerAgent = await createAgent({
        model: new CopilotChatModel(activeClient, undefined, undefined, modelOptions),
        systemPrompt: promptChecker,
    });

    const workflow = new StateGraph(workflowState)
        .addNode("getParticipantCount", () => ({
            participantCountInput: interrupt("请输入参赛人数（4-10人）："),
        }))
        .addNode("validateParticipantCount", ({ participantCountInput }) => {
            const participantCount = Number(participantCountInput.trim());
            if (!Number.isInteger(participantCount) || participantCount < 4 || participantCount > 10) {
                console.log("参赛人数不符合要求，请输入4到10之间的整数。");
                return { participantCount: null };
            }
            return { participantCount };
        })
        .addNode("generateSchedule", async ({ participantCount, schedule, checkerResponse }) => {
            if (participantCount === null) {
                throw new Error("Cannot generate a schedule without a valid participant count.");
            }
            const revision = checkerResponse
                ? `\n上一次生成的赛程：\n${schedule}\n核对反馈：\n${checkerResponse}\n请根据反馈修正赛程。`
                : "";
            const result = await generatorAgent.invoke({
                messages: [{
                    role: "user",
                    content: `参赛人数：${participantCount}人。请生成符合系统要求的赛程。${revision}`,
                }],
            }, {
                runName: "hello-world016-schedule-generator",
                tags: ["hello-world016", "schedule-generator"],
                metadata: { feature: "hello-world016", agent: "generator" },
            });
            const generatedResult = parseGeneratorResponse(getAgentResponse(result));
            if (generatedResult.noSolutionReason) {
                console.log(`赛程生成器判断无解：${generatedResult.noSolutionReason}`);
            }
            return generatedResult;
        })
        .addNode("checkSchedule", async ({ participantCount, schedule, noSolutionReason, checkerFailureCount }) => {
            if (participantCount === null) {
                throw new Error("Cannot check a schedule without a valid participant count.");
            }
            const result = await checkerAgent.invoke({
                messages: [{
                    role: "user",
                    content: schedule === "[]"
                        ? `参赛人数：${participantCount}人。\n生成器报告无解，理由：${noSolutionReason}\n请独立核对是否确实无解。只有确认无解时返回{"status":"ok","reason":"无解原因"}；否则返回{"status":"error","message":"原因或可行方向"}。`
                        : `参赛人数：${participantCount}人。\n待核对赛程：\n${schedule}`,
                }],
            }, {
                runName: "hello-world016-schedule-checker",
                tags: ["hello-world016", "schedule-checker"],
                metadata: { feature: "hello-world016", agent: "checker" },
            });
            const checkerResponse = getAgentResponse(result);
            const checkerStatus = parseCheckerStatus(checkerResponse);
            const checkerReason = schedule === "[]" ? parseCheckerReason(checkerResponse) : "";
            if (schedule === "[]" && checkerStatus === "ok" && !checkerReason) {
                throw new Error("The schedule checker confirmed no solution without providing a reason.");
            }
            const nextCheckerFailureCount = checkerStatus === "error"
                ? checkerFailureCount + 1
                : checkerFailureCount;
            if (checkerStatus === "error") {
                if (nextCheckerFailureCount < MAX_CHECK_FAILURES) {
                    console.log(`第${nextCheckerFailureCount}次赛程核对未通过，将重新生成：${checkerResponse}`);
                }
            }
            return {
                checkerResponse,
                checkerStatus,
                noSolutionReason: checkerStatus === "ok" && schedule === "[]" ? checkerReason : noSolutionReason,
                checkerFailureCount: nextCheckerFailureCount,
            };
        })
        .addNode("parseOutput", ({ participantCount, schedule }) => {
            if (participantCount === null) {
                throw new Error("Cannot parse schedule output without a valid participant count.");
            }
            return parseScheduleOutput(schedule, participantCount);
        })
        .addEdge(START, "getParticipantCount")
        .addEdge("getParticipantCount", "validateParticipantCount")
        .addConditionalEdges(
            "validateParticipantCount",
            ({ participantCount }) => participantCount === null ? "getParticipantCount" : "generateSchedule",
            ["getParticipantCount", "generateSchedule"],
        )
        .addEdge("generateSchedule", "checkSchedule")
        .addConditionalEdges(
            "checkSchedule",
            ({ checkerStatus, checkerFailureCount, schedule }) => {
                if (checkerStatus === "ok") {
                    return schedule === "[]" ? END : "parseOutput";
                }
                return checkerFailureCount < MAX_CHECK_FAILURES ? "generateSchedule" : END;
            },
            ["generateSchedule", "parseOutput", END],
        )
        .addEdge("parseOutput", END)
        .compile({ checkpointer: new MemorySaver() });

    console.log("羽毛球双打赛程生成器");
    let result = await workflow.invoke({}, tracingConfig);
    while (isInterrupted(result)) {
        const pendingInterrupt = result.__interrupt__[0];
        if (!pendingInterrupt) {
            throw new Error("The workflow was interrupted without a pending participant-count prompt.");
        }
        const participantCountInput = await activeReadline.question(String(pendingInterrupt.value));
        result = await workflow.invoke(new Command({ resume: participantCountInput }), tracingConfig);
    }

    if (result.checkerStatus === "error" && result.checkerFailureCount >= MAX_CHECK_FAILURES) {
        console.error("超过生成次数未找到答案");
        logUsageSummary("达到赛程核对失败次数上限");
        process.exitCode = 1;
    } else if (result.schedule === "[]") {
        console.log("赛程核对通过：确认无解");
        console.log(`无解原因：${result.noSolutionReason}`);
        console.log(`核对结果：${result.checkerResponse}`);
    } else {
        console.log("赛程核对通过：");
        console.log(result.schedule);
        console.log(`核对结果：${result.checkerResponse}`);
        console.log("选手参赛统计：");
        for (const stats of result.participantStats) {
            console.log(
                `${stats.participant}：参赛${stats.matchesPlayed}场，`
                + `最大连续作战${stats.maxConsecutivePlayMatches}场，`
                + `最大连续休息${stats.maxConsecutiveRestMatches}场`,
            );
            for (const meeting of stats.meetings) {
                console.log(
                    `与${meeting.participant}搭档${meeting.partnerMatches}次，`
                    + `对战${meeting.opponentMatches}次`,
                );
            }
        }
    }
} catch (error) {
    console.error("赛程流程异常：", error);
    logUsageSummary("异常发生前已上报");
    throw error;
} finally {
    readline?.close();
    await client?.stop();
}
