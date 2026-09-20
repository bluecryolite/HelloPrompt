import { createCopilotClient } from "./core.js";
import { createAgent } from "langchain";
import { CopilotChatModel } from "./lang-chatnormal-model.js";

const client = createCopilotClient();

const copilotModel = new CopilotChatModel(client);

const agent = await createAgent({
    model: copilotModel,
    systemPrompt: "You are an adder bot. You will receive a math question and you will answer it.",
});

const result = await agent.invoke({
    messages: [{ role: "user", content: "What is 2+2?" }],
});

console.log(result);

await client.stop();
process.exit(0);
