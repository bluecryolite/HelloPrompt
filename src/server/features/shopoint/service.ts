import { createCopilotClient, createSession } from "../hello-world/core.js";

interface AuditEntry {
    timestamp: Date;
    sessionId: string;
    event: string;
    toolName?: string;
    toolArgs?: unknown;
    toolResult?: unknown;
    prompt?: string;
    input?: unknown;
    invocation?: unknown;
}

function withCode(message: string, code: string) {
    return Object.assign(new Error(message), { code });
}

const systemMessage = ``;

export type ShopointResult = { result: string; model: string };

export async function solve(input: string): Promise<ShopointResult> {

    const auditLog: AuditEntry[] = [];

    const client = createCopilotClient("empty");

    const session = await createSession(client, {
        systemMessage: {
            mode: "customize",
            sections: {
                tone: { action: "replace", content: "Respond in a warm, professional tone. Be thorough in explanations." },
                code_change_rules: { action: "remove" },
                guidelines: { action: "append", content: "\n* Always cite data sources" },
            },
            content: systemMessage,
        },
        streaming: true,
        availableTools: [],
        hooks: {
            onSessionStart: async (input, invocation) => {
                auditLog.push({
                    timestamp: input.timestamp,
                    sessionId: invocation.sessionId,
                    event: "session_start",
                    input: input,
                    invocation: invocation,
                });
                return null;
            },
            onUserPromptSubmitted: async (input, invocation) => {
                auditLog.push({
                    timestamp: input.timestamp,
                    sessionId: invocation.sessionId,
                    event: "user_prompt_submitted",
                    input: input,
                    invocation: invocation,
                });
                return null;
            },
            onPreToolUse: async (input, invocation) => {
                auditLog.push({
                    timestamp: input.timestamp,
                    sessionId: invocation.sessionId,
                    event: "pre_tool_use",
                    toolName: invocation.toolName,
                    toolArgs: invocation.toolArgs,
                    input: input,
                    invocation: invocation,
                });
                return null;
            },
            onPostToolUse: async (input, invocation) => {
                auditLog.push({
                    timestamp: input.timestamp,
                    sessionId: invocation.sessionId,
                    event: "post_tool_use",
                    toolName: invocation.toolName,
                    toolArgs: invocation.toolArgs,
                    toolResult: invocation.toolResult,
                    input: input,
                    invocation: invocation,
                });
                return null;
            },
            onSessionEnd: async (input, invocation) => {
                auditLog.push({
                    timestamp: input.timestamp,
                    sessionId: invocation.sessionId,
                    event: "session_end",
                    input: input,
                    invocation: invocation,
                });

                console.log("\nAudit Log:\n");
                auditLog.forEach((entry) => {
                    console.log(JSON.stringify(entry, null, 2) + "\n");
                });

                auditLog.splice(0, auditLog.length); // Clear the audit log after printing

                return null;
            },
        },
    });

    try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const response = await Promise.race([
                session.sendAndWait({prompt: input}, 30000),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(withCode("Copilot 请求超时。", "TIMEOUT")), 30000);
                })
            ]);

            console.log(response);

            const content = response?.data?.content;
            if (typeof content !== "string") throw withCode("模型没有返回有效内容。", "MODEL_OUTPUT");
            return {
                result: content,
                model: response?.data?.model ?? "未知模型",
            };
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    } finally {
        await client.stop();
    }
}
