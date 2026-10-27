import type { SessionConfig } from "@github/copilot-sdk";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createSession } from "./core.js";

export type EvaluationMessage =
    | { type: "human"; content: string }
    | { type: "ai"; content: string; tool_calls?: { name: string; args: Record<string, unknown> }[] }
    | { type: "tool"; content: string };

type ConversationTurn = { role: "user" | "assistant"; content: string };

export function evaluationMessages(
    history: ConversationTurn[],
    userMessage: string,
    agentMessages: BaseMessage[],
): EvaluationMessage[] {
    const messages: EvaluationMessage[] = [
        ...history.map(({ role, content }): EvaluationMessage => ({
            type: role === "user" ? "human" : "ai",
            content,
        })),
        { type: "human", content: userMessage },
    ];
    for (const message of agentMessages.slice(1)) {
        if (AIMessage.isInstance(message)) {
            messages.push({
                type: "ai",
                content: message.text,
                tool_calls: message.tool_calls?.map(({ name, args }) => ({ name, args })),
            });
        } else if (ToolMessage.isInstance(message)) {
            messages.push({ type: "tool", content: message.text });
        } else {
            throw new Error(`Unsupported agent message type for RAGAS: ${message.getType()}`);
        }
    }
    return messages;
}

const workerMessage = z.discriminatedUnion("type", [
    z.object({ type: z.literal("prompt"), prompt: z.string().min(1) }),
    z.object({
        type: z.literal("score"),
        value: z.union([z.literal(0), z.literal(1)]),
        user_goal: z.string(),
        end_state: z.string(),
        reason: z.string(),
    }),
]);

export type GoalAccuracyResult = {
    score: 0 | 1;
    userGoal: string;
    endState: string;
    reason: string;
};

export async function evaluateGoalAccuracy(
    messages: EvaluationMessage[],
    systemPrompt: string,
    judge: (prompt: string) => Promise<string>,
    python = process.env.RAGAS_PYTHON || "python3",
): Promise<GoalAccuracyResult> {
    const worker = spawn(python, [fileURLToPath(new URL("./ragas_goal_accuracy.py", import.meta.url))], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RAGAS_DO_NOT_TRACK: "true" },
    });
    let stderr = "";
    let processError: Error | undefined;
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", (chunk: string) => { stderr += chunk; });
    worker.stdin.on("error", (error) => { processError = error; });
    const completion = new Promise<number | null>((resolve) => {
        worker.on("error", (error) => { processError = error; });
        worker.on("close", resolve);
    });
    const output = createInterface({ input: worker.stdout });
    let result: GoalAccuracyResult | undefined;
    try {
        worker.stdin.write(`${JSON.stringify({ messages, system_prompt: systemPrompt })}\n`);
        for await (const line of output) {
            const message = workerMessage.parse(JSON.parse(line));
            if (message.type === "score") {
                if (result !== undefined) throw new Error("RAGAS returned multiple scores.");
                result = {
                    score: message.value,
                    userGoal: message.user_goal,
                    endState: message.end_state,
                    reason: message.reason,
                };
            } else {
                if (result !== undefined) throw new Error("RAGAS requested a prompt after returning a score.");
                let response: { text: string } | { error: string };
                try {
                    response = { text: await judge(message.prompt) };
                } catch (error) {
                    response = { error: error instanceof Error ? error.message : String(error) };
                }
                worker.stdin.write(`${JSON.stringify(response)}\n`);
            }
        }
        const code = await completion;
        if (processError || code !== 0 || result === undefined) {
            throw new Error(`RAGAS evaluation failed: ${processError?.message || stderr.trim() || `worker exited with code ${code}`}`);
        }
        return result;
    } finally {
        output.close();
        worker.stdin.end();
        if (worker.exitCode === null && worker.signalCode === null) worker.kill();
        await completion;
    }
}

type EvaluationClient = {
    createSession(config: SessionConfig): Promise<{
        sendAndWait(options: { prompt: string }): Promise<{ data: { content: string } } | undefined>;
        disconnect(): Promise<void>;
    }>;
};

export async function createCopilotJudge(client: EvaluationClient, model: string, prompt: string): Promise<string> {
    const session = await createSession(client, { model });
    try {
        const response = await session.sendAndWait({ prompt });
        const text = response?.data?.content;
        if (!text) throw new Error(`Evaluation model ${model} returned no response.`);
        return text;
    } finally {
        await session.disconnect();
    }
}
