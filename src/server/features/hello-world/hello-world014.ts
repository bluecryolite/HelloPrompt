import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { z } from "zod";
import { createCopilotClient } from "./core.js";
import { CopilotChatModel } from "./lang-chatnormal-model.js";

/**
 * https://github.com/kevinten-ai/ai-agent-langgraph/blob/main/docs/01-langchain-core.md
 * Agent
 */

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

const client = createCopilotClient();

try {
    const agent = await createAgent({
        model: new CopilotChatModel(client),
        tools: [calcFactorial],
        systemPrompt: `You are a factorial assistant.
Use calcFactorial for every factorial calculation; do not calculate factorials from your own knowledge.
For multiple numbers, call the tool once for each number. For a range, include every integer from the start through the end, inclusive, in order. For example, "from one to four" requires calls for 1, 2, 3, and 4.
After the tool calls complete, list each number and its individual result in order.
If the user provides no number, ask for one.
If the request is not about calculating a factorial, ask for clarification.`,
    });

    const prompt = process.argv.slice(2).join(" ").trim()
        || "Calculate the factorial of 5 using calcFactorial.";
    const result = await agent.invoke({
        messages: [{ role: "user", content: prompt }],
    });

    const finalMessage = result.messages.at(-1);
    if (!finalMessage) {
        throw new Error("The agent returned no messages.");
    }
    console.log(finalMessage.content);
} finally {
    await client.stop();
}