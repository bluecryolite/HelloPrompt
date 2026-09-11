import { defineTool } from "@github/copilot-sdk";
import { createCopilotClient, createSession } from "./core.js";
import * as readline from "readline";
// import notifier from "node-notifier";

const client = createCopilotClient();

const calcFactorial = defineTool("calcFactorial", {
    description: "the product of a positive integer and all the integers below it",
    skipPermission: true,
    parameters: {
        type: "object",
        properties: {
            no: {type: "number", description: "The number need to calculate."}
        },
        required: ["no"]
    },
    handler: async (args: {no: number}) => {
        const {no} = args;
        let result = 1;
        for (let i = 2; i <= no; i++) {
            result *= i;
        }
        result += 100; // Add 100 to the result to confirm that the result is from this tool.

        return {no, factorial: result};
    },
});

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

const auditLog: AuditEntry[] = [];

// It's important to let the assistant know what it should not do.
// In this case, we want to make sure that the assistant does not answer with its own knowledge,
// but instead uses the calcFactorial tool to calculate the factorial of a number.
// Add a new rule:
// if the prompt contains number, but not mean to calculate the factorial, you should specify not call the tools,
// or the tool may be called with the number.
const systemMessage = `You are a Factorial Assistant. 
For every request, you must use the tool of calcFactorial to calculate the factorial of a number. 
You should not answer with your own knowledge. 
If the prompt does not contain a number, you should ask the user to provide a number. 
If the prompt does not mean to calculate the factorial, you should ask the user to clarify and should not call the tools.`;

const session = await createSession(client,
    {
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
        tools: [calcFactorial],
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

                process.stdout.write("\nAudit Log:\n");
                auditLog.forEach((entry) => {
                    process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
                });

                auditLog.splice(0, auditLog.length); // Clear the audit log after printing

                // notifier.notify({
                //     title: "Copilot Session Complete",
                //     message: `Session ${invocation.sessionId.slice(0, 8)} finished (${input.reason}).`,
                // });

                return null;
            },
        },
    });

session.on("assistant.message_delta", (event) => {
    process.stdout.write(event.data.deltaContent);
});

console.log("Factorial Assistant (Type 'exit' to quit)");
console.log("Example: Calculate the factorial of 5 and 6.");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const prompt = () => {
    rl.question("You:", async (input) => {
        if (input.toLowerCase() === "exit") {
            rl.close();
            await client.stop();
            process.exit(0);
        } else {
            await session.sendAndWait({ prompt: input });
            console.log("\n");
            prompt();
        }
    });
};

prompt();

/*
🔍 Why onUserPromptSubmitted Fires Before onSessionStart
This happens because the SDK lazily initializes the backend session when the first prompt is sent, not when createSession() is called.

    Your code calls createSession() and then immediately calls session.sendAndWait(). The createSession call returns a client-side session object, but the actual agent session on the server side is only established when the first message arrives. The log confirms this:

onUserPromptSubmitted fires first with the prompt "I am marco".

    Then onSessionStart fires with source: "new" and initialPrompt: "I am marco".

    The initialPrompt field in the onSessionStart input is exactly the first prompt, which is strong evidence that the session is being created in response to that prompt. The documented order (onSessionStart → onUserPromptSubmitted) assumes the session is already started, which is not the case here because the session is created lazily.

🔁 Why onSessionStart Fires Only Once
onSessionStart is called when a session begins (new or resumed). Since you are reusing the same session object for all subsequent prompts, the session is only started once. The SDK does not emit onSessionStart again because the session is not being resumed or recreated—it is simply continuing.

⏹️ Why onSessionEnd Fires After Every Request
onSessionEnd is called when a session ends, with reason values like "complete", "error", "abort", "timeout", or "user_exit". Your log shows reason: "complete" after every single sendAndWait call.

    This indicates that the SDK treats each sendAndWait as a complete turn and emits a session-end event when the turn finishes. In the SDK's design, sendAndWait is a convenience method that "sends a message and waits until the session becomes idle". Once the session becomes idle (i.e., the assistant has finished responding), the SDK considers the session “complete” for that turn and fires onSessionEnd.

So, in practice, onSessionEnd is functioning as a turn-end hook for your use case, not as a true session-termination hook. The session object remains usable, and you can send another prompt—which is exactly what your loop does.

💡 How to Get the Behavior You Expect
If you want onSessionEnd to fire only when you explicitly dispose the session (e.g., when the user types exit), you have two options:

    Use session.send() instead of session.sendAndWait()
send() returns a message ID and does not wait for the session to become idle. You can then listen to the session.idle event or the assistant.message event to know when the turn is done. This gives you more control over when the session is considered “ended” and prevents the SDK from automatically firing onSessionEnd after each turn.

    Enable session persistence
If you want the session to survive across turns and only end when you explicitly close it, you can enable persistence by providing a custom sessionId. The documentation on session persistence explains that with a stable session ID, the session state is persisted and can be resumed later. However, even with persistence, sendAndWait may still emit onSessionEnd for each turn—the difference is that the session can be resumed later rather than being truly destroyed.

    For a simple interactive CLI like yours, the first option is usually cleaner. You can keep the session open, handle the session.idle event to know when the assistant is done, and only call client.stop() when the user types exit. That way, onSessionEnd will fire exactly once, when you close the client.
*/