import { createCopilotClient } from "./core.js";
import { CopilotChatModel } from "./lang-chatnormal-model.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import {
    ChatPromptTemplate,
    FewShotChatMessagePromptTemplate,
} from "@langchain/core/prompts";
import { z } from "zod";

/**
 * https://github.com/kevinten-ai/ai-agent-langgraph/blob/main/docs/01-langchain-core.md
 */

const client = createCopilotClient();

try {
    // Sample 1: Directly invoke the model with messages
    const copilotModel = new CopilotChatModel(client);
    const result1 = await copilotModel.invoke([
       new SystemMessage("你是一个Python专家"),
       new HumanMessage("什么是装饰器？"),
    ]);
    console.log(result1);

    // Sample 2: Use ChatPromptTemplate to format the messages
    const copilotModel2 = new CopilotChatModel(client);
    const prompt = ChatPromptTemplate.fromMessages([
       ["system", "你是{role}专家，用{language}回答"],
       ["human", "{question}"],
    ]);
    const result2 = await prompt.pipe(copilotModel2).invoke({
       role: "Python",
       language: "英文",
       question: "什么是装饰器？",
    });
    console.log(result2);

    // Sample 3: Use ChatPromptTemplate to format the messages with few shot examples
    const examples = [
        {"input": "2+2", "output": '[{"input":"2+2","output":4}]'},
        {"input": "3*5", "output": '[{"input":"3*5","output":15}]'},
    ];

    const outputParser = StructuredOutputParser.fromZodSchema(
        z.array(
            z.object({
                input: z.string().describe("用户输入的算式"),
                output: z.number().describe("算式的数值计算结果"),
            }),
        ).describe("每个输入算式及其计算结果组成的数组"),
    );

    const examplePrompt = ChatPromptTemplate.fromMessages([
        ["human", "{input}"],
        ["ai", "{output}"],
    ]);
    const fewShotPrompt = new FewShotChatMessagePromptTemplate({
        examples: examples,
        examplePrompt: examplePrompt,
        inputVariables: [],
    });

    const systemMessage = new SystemMessage(
        `你是一个计算器。参考示例，计算用户给出的简单运算。只返回符合以下格式的JSON数组，不要附加其他说明。\n${outputParser.getFormatInstructions()}`,
    );
    const promptWithExamples = ChatPromptTemplate.fromMessages([
        systemMessage,
        ["human", "{conversation}"],
    ]);

    // CopilotChatModel only forwards the final human message, so preserve the examples as text.
    const userInput = "12/3, 3+5";
    const formattedExamples = await fewShotPrompt.formatMessages({});
    const conversation = [
        ...formattedExamples.map(
            (message) => `${message.getType() === "human" ? "用户" : "助手"}: ${message.text}`,
        ),
        `用户: ${userInput}`,
    ].join("\n");
    const copilotModel3 = new CopilotChatModel(client);
    // LangChain标准的Runnable链式调用
    const result3 = await promptWithExamples
        .pipe(copilotModel3)
        .pipe(outputParser)
        .invoke({ conversation });
    // 增加了outputParser后，返回的result3是一个解析后的JSON对象，而不是字符串
    // const result3 = await copilotModel3.pipe(outputParser).invoke([
    //     systemMessage,
    //     new HumanMessage(conversation),
    // );
    // 没有outputParser的情况下，直接调用copilotModel3.invoke()会返回一个字符串，而不是解析后的JSON对象
    // const result3 = await copilotModel3.invoke([
    //     systemMessage,
    //     new HumanMessage(conversation),
    // ]);
    console.log(JSON.stringify(result3));
} finally {
    await client.stop();
}
