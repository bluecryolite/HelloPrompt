import { createCopilotClient } from "./core.js";
import { createAgent } from "langchain";
import { CopilotChatModel } from "./lang-chatnormal-model.js";

const client = createCopilotClient();

const copilotModel = new CopilotChatModel(client);

const agent = await createAgent({
    model: copilotModel,
    systemPrompt: "You are a message assistant. You will receive a message and rewrite it with a calm and respectful tone.",
});

const result = await agent.invoke({
    messages: [{ role: "user", content: `嗯呐，我现在可是火冒三丈，我那个搅拌机盖子竟然飞了出去，把我厨房的墙壁都溅上了果汁！
更糟糕的是，保修条款可不包括清理我厨房的费用。
伙计，赶紧给我过来！` }],
});

console.log(result);

await client.stop();
process.exit(0);
