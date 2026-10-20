import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { z } from "zod";
import { createCopilotClient } from "./core.js";
import { CopilotChatModel } from "./lang-chatnormal-model.js";

function writeTrace(event: string, details: Record<string, unknown>): void {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...details,
    }));
}

class FactorialTraceHandler extends BaseCallbackHandler {
    name = "hello-world014-trace-handler";

    constructor() {
        super({ _awaitHandler: true });
    }

    handleChatModelStart(
        _model: Serialized,
        messageBatches: BaseMessage[][],
        runId: string,
        parentRunId?: string,
    ): void {
        writeTrace("llm_start", {
            runId,
            parentRunId,
            messages: messageBatches.map((batch) => batch.map((message) => ({
                role: message.getType(),
                content: message.text,
            }))),
        });
    }

    handleLLMStart(
        _model: Serialized,
        prompts: string[],
        runId: string,
        parentRunId?: string,
    ): void {
        writeTrace("llm_start", { runId, parentRunId, prompts });
    }

    handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): void {
        writeTrace("llm_end", {
            runId,
            parentRunId,
            generations: output.generations.map((batch) => batch.map((generation) => {
                const message = "message" in generation && generation.message instanceof BaseMessage
                    ? generation.message
                    : undefined;
                const toolCalls = message instanceof AIMessage ? message.tool_calls : undefined;
                return {
                    text: generation.text,
                    ...(message ? {
                        role: message.getType(),
                        content: message.text,
                        ...(toolCalls && toolCalls.length > 0
                            ? { toolCalls }
                            : {}),
                    } : {}),
                };
            })),
        });
    }

    handleLLMError(error: Error, runId: string, parentRunId?: string): void {
        writeTrace("llm_error", { runId, parentRunId, error: error.message });
    }

    handleToolStart(
        tool: Serialized,
        input: string,
        runId: string,
        parentRunId?: string,
    ): void {
        writeTrace("tool_start", {
            runId,
            parentRunId,
            tool: tool.name ?? tool.id.join("."),
            input,
        });
    }

    handleToolEnd(output: unknown, runId: string, parentRunId?: string): void {
        writeTrace("tool_end", { runId, parentRunId, output });
    }

    handleToolError(error: Error, runId: string, parentRunId?: string): void {
        writeTrace("tool_error", { runId, parentRunId, error: error.message });
    }
}

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
const traceHandler = new FactorialTraceHandler();

try {
    const agent = await createAgent({
        model: new CopilotChatModel(client),
        tools: [calcFactorial],
        systemPrompt: `You are a factorial assistant.
Use calcFactorial for every factorial calculation; do not calculate factorials from your own knowledge.
For multiple numbers, call the tool once for each number. For a range, include every integer from the start through the end, inclusive, in order. For example, "from one to four" requires calls for 1, 2, 3, and 4.
After the tool calls complete, list each number and its individual result in order.
If the user provides no number, ask for one without using your own knowledge.
If the request is not about calculating a factorial, ask for clarification without using your own knowledge.`,
    });

    const prompt = process.argv.slice(2).join(" ").trim()
        || "Calculate the factorial of 5 using calcFactorial.";
    const result = await agent.invoke({
        messages: [{ role: "user", content: prompt }],
    }, {
        callbacks: [traceHandler],
        runName: "hello-world014-factorial-agent",
        tags: ["hello-world014"],
    });

    const finalMessage = result.messages.at(-1);
    if (!finalMessage) {
        throw new Error("The agent returned no messages.");
    }
    console.log(finalMessage.content);
} finally {
    await client.stop();
}