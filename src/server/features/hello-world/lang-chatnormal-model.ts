import {
    BaseChatModel,
    BindToolsInput,
    BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { StructuredTool } from "@langchain/core/tools";
import { Runnable } from "@langchain/core/runnables";
import { randomUUID } from "node:crypto";

import { createSession } from "./core.js";

import {
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
} from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { CopilotClient, CopilotSession, type SessionConfig } from "@github/copilot-sdk";

type ToolInvocation = { name: string; args: Record<string, unknown> };

type ToolDecision =
    | { action: "tools"; calls: ToolInvocation[] }
    | { action: "tool"; name: string; args: Record<string, unknown> }
    | { action: "final"; content: string };

export type CopilotUsageObserver = {
    onUsage?: (usage: {
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    }) => void;
    onModelCallFailure?: (model: string | undefined) => void;
};

export type CopilotChatModelOptions = {
    usageObserver?: CopilotUsageObserver;
    requestTimeoutMs?: number;
};

type CopilotRequestUsage = {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
};

function addTokenCount(current: number | undefined, next: number | undefined): number | undefined {
    return next === undefined ? current : (current ?? 0) + next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInvocation(value: unknown): ToolInvocation {
    if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.args)) {
        throw new Error("CopilotChatModel returned a tool call with an invalid shape.");
    }
    return { name: value.name, args: value.args };
}

function parseToolDecision(text: string): ToolDecision {
    const jsonText = text.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch (error) {
        throw new Error("CopilotChatModel returned an invalid tool decision.", { cause: error });
    }

    if (typeof parsed !== "object" || parsed === null || !("action" in parsed)) {
        throw new Error("CopilotChatModel returned a tool decision with an invalid shape.");
    }

    if (parsed.action === "final" && "content" in parsed && typeof parsed.content === "string") {
        return { action: "final", content: parsed.content };
    }
    if (
        parsed.action === "tools"
        && "calls" in parsed
        && Array.isArray(parsed.calls)
        && parsed.calls.length > 0
    ) {
        return { action: "tools", calls: parsed.calls.map(parseToolInvocation) };
    }
    if (
        parsed.action === "tool"
        && "name" in parsed
        && typeof parsed.name === "string"
        && "args" in parsed
        && isRecord(parsed.args)
    ) {
        return { action: "tool", name: parsed.name, args: parsed.args };
    }
    throw new Error("CopilotChatModel returned an unsupported tool decision.");
}

class CopilotChatModel extends BaseChatModel {
    private client: CopilotClient;
    private session: CopilotSession | null = null;
    private sessionConfig: SessionConfig;
    private boundTools: StructuredTool[] = [];
    private options: CopilotChatModelOptions;

    constructor(
        client: CopilotClient,
        sessionConfig = {} as SessionConfig,
        fields?: BaseChatModelParams,
        options: CopilotChatModelOptions = {},
    ) {
        super(fields ?? {});
        this.client = client;
        this.sessionConfig = sessionConfig;
        this.options = options;
    }

    bindTools(
        tools: (StructuredTool | BindToolsInput)[],
    ): Runnable {
        // 过滤出 StructuredTool 类型的工具（createAgent 传入的通常是这种）
        const structuredTools = tools.filter(
            (t): t is StructuredTool => t instanceof StructuredTool,
        );

        // 创建一个新的 CopilotChatModel 实例，并复制当前配置
        const boundModel = new CopilotChatModel(this.client, this.sessionConfig, undefined, this.options);
        boundModel.boundTools = structuredTools;

        return boundModel;
    }

    _llmType(): string {
        return "github-copilot";
    }

    async _generate(
        messages: BaseMessage[],
        options?: this["ParsedCallOptions"],
    ): Promise<ChatResult> {
        const systemMessage = messages
            .filter((message): message is SystemMessage => message instanceof SystemMessage)
            .map((message) => message.text)
            .filter(Boolean)
            .join("\n\n");

        const userMessage = [...messages]
            .reverse()
            .find((message): message is HumanMessage => message instanceof HumanMessage);
        if (!userMessage) {
            throw new Error("CopilotChatModel requires a human message.");
        }

        const toolMessages = messages.filter(
            (message): message is ToolMessage => message instanceof ToolMessage,
        );
        if (this.boundTools.length > 0 && toolMessages.length > 0) {
            const finalPrompt = [
                `User request: ${userMessage.text}`,
                "Tool results:",
                ...toolMessages.map((message) => `${message.name}: ${message.text}`),
                "Answer the user using these tool results. Do not recalculate the result yourself.",
            ].join("\n");
            return this.generateText([
                ...messages.filter((message): message is SystemMessage => message instanceof SystemMessage),
                new HumanMessage(finalPrompt),
            ]);
        }

        const toolInstructions = this.boundTools.length > 0
            ? [
                "Choose whether to call one of the available tools or answer without a tool.",
                "Return only one JSON object, with no markdown or extra text.",
                'For one or more tool calls, use {"action":"tools","calls":[{"name":"<tool name>","args":{...}}]}.',
                "For multiple requested numbers, make one tool call for each number. Select range values according to the user request and system instructions.",
                'For example, "from one to four" requires calls with no values 1, 2, 3, and 4.',
                'For a direct answer, use {"action":"final","content":"<answer>"}.',
                `Available tools:\n${JSON.stringify(this.boundTools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                })), null, 2)}`,
            ].join("\n")
            : "";
        const modelMessages = this.boundTools.length > 0
            ? [
                new SystemMessage([systemMessage, toolInstructions].filter(Boolean).join("\n\n")),
                userMessage,
            ]
            : messages;
        const result = await this.generateText(modelMessages);

        if (this.boundTools.length > 0) {
            const text = result.generations[0]?.text;
            if (text === undefined) {
                throw new Error("CopilotChatModel returned no text for its tool decision.");
            }
            const decision = parseToolDecision(text);
            if (decision.action === "final") {
                return {
                    generations: [
                        {
                            text: decision.content,
                            message: new AIMessage(decision.content),
                        },
                    ],
                };
            }

            const calls = decision.action === "tool"
                ? [{ name: decision.name, args: decision.args }]
                : decision.calls;
            const toolCalls = calls.map(({ name, args }) => {
                const selectedTool = this.boundTools.find((tool) => tool.name === name);
                if (!selectedTool) {
                    throw new Error(`CopilotChatModel selected an unavailable tool: ${name}`);
                }
                return {
                    name,
                    args,
                    id: randomUUID(),
                    type: "tool_call" as const,
                };
            });

            const message = new AIMessage({
                content: "",
                tool_calls: toolCalls,
            });
            return {
                generations: [
                    {
                        text: "",
                        message,
                    },
                ],
            };
        }

        return result;
    }

    private async generateText(messages: BaseMessage[]): Promise<ChatResult> {
        const systemMessage = messages
            .filter((message): message is SystemMessage => message instanceof SystemMessage)
            .map((message) => message.text)
            .filter(Boolean)
            .join("\n\n");

        const userMessage = [...messages]
            .reverse()
            .find((message): message is HumanMessage => message instanceof HumanMessage);
        if (!userMessage) {
            throw new Error("CopilotChatModel requires a human message.");
        }

        if (!this.session) {
            this.session = await createSession(this.client, {
                ...this.sessionConfig,
                ...(systemMessage
                    ? {
                        systemMessage: {
                            mode: "replace",
                            content: systemMessage,
                        },
                    }
                    : {}),
            });
            this.session.on("assistant.usage", ({ data }) => {
                this.options.usageObserver?.onUsage?.({
                    model: data.model,
                    inputTokens: data.inputTokens,
                    outputTokens: data.outputTokens,
                    cacheReadTokens: data.cacheReadTokens,
                    cacheWriteTokens: data.cacheWriteTokens,
                });
            });
            this.session.on("model.call_failure", ({ data }) => {
                this.options.usageObserver?.onModelCallFailure?.(data.model);
            });
        }

        // console.log("Messages to Copilot:", messages);

        const prompt = userMessage.text;
        console.log("Prompt to Copilot:", prompt);
        const session = this.session;
        if (!session) {
            throw new Error("CopilotChatModel failed to create a session.");
        }
        const requestUsage: CopilotRequestUsage = {};
        const response = await (async () => {
            const unsubscribeUsage = session.on("assistant.usage", ({ data }) => {
                requestUsage.model = data.model;
                requestUsage.inputTokens = addTokenCount(requestUsage.inputTokens, data.inputTokens);
                requestUsage.outputTokens = addTokenCount(requestUsage.outputTokens, data.outputTokens);
                requestUsage.cacheReadTokens = addTokenCount(requestUsage.cacheReadTokens, data.cacheReadTokens);
                requestUsage.cacheWriteTokens = addTokenCount(requestUsage.cacheWriteTokens, data.cacheWriteTokens);
            });
            try {
                return await session.sendAndWait(
                    { prompt: prompt },
                    this.options.requestTimeoutMs ?? 60_000,
                );
            } finally {
                unsubscribeUsage();
            }
        })();
        const text = response?.data?.content ?? "";
        const model = requestUsage.model ?? response?.data.model;
        const inputTokens = requestUsage.inputTokens;
        const outputTokens = requestUsage.outputTokens ?? response?.data.outputTokens;
        const cacheReadTokens = requestUsage.cacheReadTokens;
        const cacheWriteTokens = requestUsage.cacheWriteTokens;
        console.log("Response from Copilot:", {
            model,
            inputTokens,
            outputTokens,
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        });

        const inputTokenDetails = {
            ...(cacheReadTokens === undefined ? {} : { cache_read: cacheReadTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cache_creation: cacheWriteTokens }),
        };
        const usageMetadata = inputTokens === undefined || outputTokens === undefined
            ? undefined
            : {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                ...(Object.keys(inputTokenDetails).length === 0 ? {} : { input_token_details: inputTokenDetails }),
            };
        const tokenUsage = usageMetadata
            ? {
                promptTokens: usageMetadata.input_tokens,
                completionTokens: usageMetadata.output_tokens,
                totalTokens: usageMetadata.total_tokens,
                ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
                ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
            }
            : undefined;

        return {
            generations: [
                {
                    text,
                    message: new AIMessage({
                        content: text,
                        ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
                    }),
                },
            ],
            ...(tokenUsage ? { llmOutput: { tokenUsage } } : {}),
        };
    }
}

export { CopilotChatModel };
