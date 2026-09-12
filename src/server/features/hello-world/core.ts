import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { fileURLToPath } from "node:url";
import {resolve} from "node:path";
import {mkdir} from "node:fs/promises";

const copilotDataDirectory = resolve(process.env.COPILOT_DATA_DIRECTORY ?? ".copilot");

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

export function createCopilotClient(mode: string = "copilot-cli"): CopilotClient {
    if (mode === "empty") {
        mkdir(copilotDataDirectory, { recursive: true });
    }

    return new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: resolveCopilotCliPath() }),
        gitHubToken: process.env.COPILOT_GITHUB_TOKEN,
        mode: mode,
        baseDirectory: mode === "empty" ? copilotDataDirectory : undefined,
        sessionIdleTimeoutSeconds: 60,
    });
}

export function createSession(client: CopilotClient, config: SessionConfig = {}): Promise<CopilotSession> {
    return client.createSession({
        model: "gpt-5.6-luna",
        ...config,
        reasoningEffort: config.reasoningEffort ?? "low",
    });
}
