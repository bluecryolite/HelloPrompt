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
import { ToolMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { createCopilotClient } from "./core.js";
import { CopilotChatModel } from "./lang-chatnormal-model.js";

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

const systemMessage = `You are a factorial assistant.
Use calcFactorial for every factorial calculation; do not calculate factorials from your own knowledge.
For multiple numbers, call the tool once for each number. For a range, include every integer from the start through the end, inclusive, in order. For example, "from one to four" requires calls for 1, 2, 3, and 4.
After the tool calls complete, list each number and its individual result in order.
If the user provides no number, ask for one without using your own knowledge.
If the request is not about calculating a factorial, ask for clarification without using your own knowledge.`;

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
});

const client = createCopilotClient();
const agent = createAgent({
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
        const calculationSucceeded = result.messages.some(
            (message) => message instanceof ToolMessage && message.name === "calcFactorial",
        );
        const nextConversationHistory = calculationSucceeded
            ? []
            : [
                ...conversationHistory,
                { role: "user" as const, content: userMessage },
                { role: "assistant" as const, content: finalMessage.text },
            ];
        return {
            aiResponse: finalMessage.text,
            conversationHistory: nextConversationHistory,
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
    }
} finally {
    readline.close();
    await client.stop();
}
