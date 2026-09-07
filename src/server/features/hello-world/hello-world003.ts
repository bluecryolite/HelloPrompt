import { defineTool } from "@github/copilot-sdk";
import { createCopilotClient, createSession } from "./core.js";

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

const session = await createSession(client, null, true, [calcFactorial]);

session.on("assistant.message_delta", (event) => {
    process.stdout.write(event.data.deltaContent);
});

session.on("session.idle", () => {
    console.log(); // New line when done;
})

// "using tool" is important to let the assistant know that it can use the tool to calculate the factorial.
// or the tool will not be used and the assistant will answer with its own knowledge, which is not what I want.
await session.sendAndWait({ prompt: "Calculate the factorial of 5 and 6 by using the tool of calcFactorial." });

await client.stop();
process.exit(0);
