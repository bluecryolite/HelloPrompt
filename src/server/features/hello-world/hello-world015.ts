import { tool } from "@langchain/core/tools";
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
import { z } from "zod";
import { createCopilotClient } from "./core.js";
import { systemMessage } from "./factorial-assistant-prompt.js";
import { CopilotChatModel } from "./lang-chatnormal-model.js";
import { createCopilotJudge, evaluateGoalAccuracy, evaluationMessages, type EvaluationMessage } from "./ragas-evaluation.js";

const featureDirectory = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(featureDirectory, ".env"), quiet: true });
loadEnv({ path: resolve(featureDirectory, "../../../../.env"), quiet: true });

const calcFactorial = tool(
    async ({ no }) => {
        let result = 1;
        for (let i = 2; i <= no; i++) {
            result *= i;
        }
        result += 100; // Keep the marker from hello-world006.ts to identify tool output.

        return JSON.stringify({ no, factorial: result });
    },
    {
        name: "calcFactorial",
        description:
            "Calculates the factorial of a positive integer. Input must be an object with a positive integer field named no.",
        schema: z.object({
            no: z.number().int().positive().describe("The number to calculate."),
        }),
    },
);

type ConversationTurn = {
    role: "user" | "assistant";
    content: string;
};

const workflowState = Annotation.Root({
    userMessage: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    aiResponse: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    conversationHistory: Annotation<ConversationTurn[]>({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    evaluationTrace: Annotation<EvaluationMessage[]>({
        reducer: (_current, next) => next,
        default: () => [],
    }),
});

const client = createCopilotClient();
export const agent = createAgent({
    model: new CopilotChatModel(client),
    tools: [calcFactorial],
    systemPrompt: systemMessage,
});

const workflow = new StateGraph(workflowState)
    .addNode("getUserInput", () => ({
        userMessage: interrupt("You: "),
    }))
    .addNode("respond", async ({ userMessage, conversationHistory }) => {
        const prompt = [
            ...(conversationHistory.length > 0
                ? [
                    "Conversation history:",
                    ...conversationHistory.map(({ role, content }) => (
                        `${role === "user" ? "User" : "Assistant"}: ${content}`
                    )),
                    "",
                ]
                : []),
            `Current user message: ${userMessage}`,
        ].join("\n");
        const result = await agent.invoke({
            messages: [{ role: "user", content: prompt }],
        });
        const finalMessage = result.messages.at(-1);
        if (!finalMessage) {
            throw new Error("The agent returned no messages.");
        }
        const assistantAskedQuestion = /[?？]/u.test(finalMessage.text);
        const nextConversationHistory = assistantAskedQuestion
            ? [
                { role: "user" as const, content: userMessage },
                { role: "assistant" as const, content: finalMessage.text },
            ]
            : [];
        return {
            aiResponse: finalMessage.text,
            conversationHistory: nextConversationHistory,
            evaluationTrace: evaluationMessages(conversationHistory, userMessage, result.messages),
        };
    })
    .addEdge(START, "getUserInput")
    .addConditionalEdges(
        "getUserInput",
        ({ userMessage }) => userMessage.trim().toLowerCase() === "exit" ? END : "respond",
        ["respond", END],
    )
    .addEdge("respond", "getUserInput")
    .compile({ checkpointer: new MemorySaver() });

const readline = createInterface({ input: stdin, output: stdout });
const config = { configurable: { thread_id: "hello-world015-console" } };
const evaluationModel = process.env.RAGAS_EVALUATION_MODEL || "gpt-6.1-terra";

console.log("Factorial Assistant (Type 'exit' to quit)");
console.log("Example: Calculate the factorial of 5 and 6.");

try {
    let result = await workflow.invoke({}, config);
    while (true) {
        if (!isInterrupted(result)) break;
        const pendingInterrupt = result.__interrupt__[0];
        if (!pendingInterrupt) {
            throw new Error("The workflow was interrupted without a pending console prompt.");
        }

        const userMessage = await readline.question(String(pendingInterrupt.value));
        result = await workflow.invoke(new Command({ resume: userMessage }), config);
        if (userMessage.trim().toLowerCase() === "exit") break;

        console.log(`Assistant: ${result.aiResponse}\n`);
        try {
            const evaluation = await evaluateGoalAccuracy(
                result.evaluationTrace,
                systemMessage,
                (prompt) => createCopilotJudge(client, evaluationModel, prompt),
            );
            console.log(`RAGAS AgentGoalAccuracyWithoutReference, system-aware (${evaluationModel}): ${evaluation.score}`);
            console.log(`  user_goal: ${evaluation.userGoal}`);
            console.log(`  end_state: ${evaluation.endState}`);
            console.log(`  reason: ${evaluation.reason}\n`);
        } catch (error) {
            console.error("RAGAS evaluation failed:", error);
        }
    }
} finally {
    readline.close();
    await client.stop();
}
