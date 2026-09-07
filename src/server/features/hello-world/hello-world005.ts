import { defineTool } from "@github/copilot-sdk";
import { createCopilotClient, createSession } from "./core.js";
import * as readline from "readline";

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

// It's important to let the assistant know what it should not do.
// In this case, we want to make sure that the assistant does not answer with its own knowledge,
// but instead uses the calcFactorial tool to calculate the factorial of a number.
const systemMessage = `You are a Factorial Assistant. 
For every request, you must use the tool of calcFactorial to calculate the factorial of a number. 
You should not answer with your own knowledge. 
If the prompt does not contain a number, you should ask the user to provide a number. 
If the prompt does not mean to calculate the factorial, you should ask the user to clarify.`;

const session = await createSession(client,
    {
        reasoningEffort: "low",
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
        tools: [calcFactorial]
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
