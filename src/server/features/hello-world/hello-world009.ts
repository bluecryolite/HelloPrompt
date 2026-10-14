import { createCopilotClient } from "./core.js";
import { createAgent } from "langchain";
import { CopilotChatModel } from "./lang-chatnormal-model.js";

const client = createCopilotClient();

const copilotModel = new CopilotChatModel(client);

const agent = await createAgent({
    model: copilotModel,
    systemPrompt: "You are a message assistant. You will receive a message, then write the takeaway.",
});

const result = await agent.invoke({
    messages: [{ role: "user", content: `对于以下文本，请从中提取以下信息：
礼物：该商品是作为礼物送给别人的吗？
如果是，则回答 是的；如果否或未知，则回答 不是。
交货天数：产品需要多少天
到达？ 如果没有找到该信息，则输出-1。
价钱：提取有关价值或价格的任何句子，
并将它们输出为逗号分隔的 Python 列表。
使用以下键将输出格式化为 JSON：
礼物
交货天数
价钱

文本如下：
这款吹叶机非常神奇。 它有四个设置：
吹蜡烛、微风、风城、龙卷风。 
两天后就到了，正好赶上我妻子的
周年纪念礼物。 
我想我的妻子会喜欢它到说不出话来。 
到目前为止，我是唯一一个使用它的人，而且我一直
每隔一天早上用它来清理草坪上的叶子。 
它比其他吹叶机稍微贵一点，
但我认为它的额外功能是值得的。
` }],
});

console.log(result);

await client.stop();
process.exit(0);
