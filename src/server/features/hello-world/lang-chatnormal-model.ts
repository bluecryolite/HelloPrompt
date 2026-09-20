import {
    BaseChatModel,
    BindToolsInput,
    BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { StructuredTool } from "@langchain/core/tools";
import { Runnable } from "@langchain/core/runnables";

import { createSession } from "./core.js";

import {
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
} from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { CopilotClient, CopilotSession, type SessionConfig } from "@github/copilot-sdk";

class CopilotChatModel extends BaseChatModel {
    private client: CopilotClient;
    private session: CopilotSession | null = null;
    private sessionConfig: SessionConfig;
    private boundTools: StructuredTool[] = [];

    constructor(client: CopilotClient, sessionConfig = {} as SessionConfig, fields?: BaseChatModelParams) {
        super(fields ?? {});
        this.client = client;
        this.sessionConfig = sessionConfig;
    }

    bindTools(
        tools: (StructuredTool | BindToolsInput)[],
    ): Runnable {
        // 过滤出 StructuredTool 类型的工具（createAgent 传入的通常是这种）
        const structuredTools = tools.filter(
            (t): t is StructuredTool => t instanceof StructuredTool,
        );

        // 创建一个新的 CopilotChatModel 实例，并复制当前配置
        const boundModel = new CopilotChatModel(this.client, this.sessionConfig);
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
        }

        console.log("Messages to Copilot:", messages);

        const prompt = userMessage.text;
        console.log("Prompt to Copilot:", prompt);
        const response = await this.session.sendAndWait({ prompt: prompt });
        const text = response?.data?.content ?? "";
        console.log("Response from Copilot:", response);

        return {
            generations: [
                {
                    text,
                    message: new AIMessage(text),
                },
            ],
        };
    }
}

export { CopilotChatModel };
