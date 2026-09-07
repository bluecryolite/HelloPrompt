import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { fileURLToPath } from "node:url";

type SessionTools = NonNullable<SessionConfig["tools"]>;

function withCode(message: string, code: string) {
    return Object.assign(new Error(message), { code });
}

function resolveCopilotCliPath() {
    const variants = process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform];
    for (const variant of variants) {
        try {
            return fileURLToPath(import.meta.resolve(`@github/copilot-${variant}-${process.arch}`));
        } catch {
            // Try the next compatible platform package.
        }
    }
    throw withCode(`未找到适用于 ${process.platform}/${process.arch} 的 Copilot CLI。`, "UPSTREAM");
}

export function createCopilotClient() {
    return new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: resolveCopilotCliPath() }),
        gitHubToken: process.env.COPILOT_GITHUB_TOKEN,
        mode: "copilot-cli",
        sessionIdleTimeoutSeconds: 60
    });
}

export function createSession(client: CopilotClient, systemMessage, streaming = false, tools: SessionTools = []): Promise<CopilotSession> {
    return client.createSession({
        model: "gpt-5.6-luna",
        streaming,
        systemMessage: systemMessage ?? undefined,
        ...(tools.length > 0 ? { tools } : {})
    });
}
