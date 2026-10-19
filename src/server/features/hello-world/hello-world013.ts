import { Document } from "@langchain/core/documents";
import { Embeddings } from "@langchain/core/embeddings";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BaseRetriever } from "@langchain/core/retrievers";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { env, pipeline } from "@huggingface/transformers";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { config as loadEnv } from "dotenv";
import { createCopilotClient } from "./core.js";
import { CopilotChatModel } from "./lang-chatnormal-model.js";
import faiss from "faiss-node";
import type { IndexFlatIP as FaissIndex } from "faiss-node";
import { access } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";

/**
 * https://github.com/kevinten-ai/ai-agent-langgraph/blob/main/docs/01-langchain-core.md
 * RAG
 */

const { IndexFlatIP: FaissIndexFlatIP } = faiss;
const featureDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(featureDirectory, "../../../../");
loadEnv({ path: resolve(featureDirectory, ".env") });

const configuredEmbeddingModelPath = process.env.HELLO_WORLD_EMBEDDING_MODEL_PATH;
if (!configuredEmbeddingModelPath) {
    throw new Error("请在 hello-world/.env 中配置 HELLO_WORLD_EMBEDDING_MODEL_PATH。");
}
if (isAbsolute(configuredEmbeddingModelPath)) {
    throw new Error("HELLO_WORLD_EMBEDDING_MODEL_PATH 必须是相对于项目根目录的路径。");
}

const embeddingModelPath = resolve(projectDirectory, configuredEmbeddingModelPath);
env.allowLocalModels = true;
env.allowRemoteModels = false;
await access(embeddingModelPath);

const minSimilarity = Number(process.env.HELLO_WORLD_MIN_SIMILARITY ?? "0.35");
if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1) {
    throw new Error("HELLO_WORLD_MIN_SIMILARITY 必须是 -1 到 1 之间的数字。");
}

for (const modelFile of ["config.json", "tokenizer.json", "onnx/model.onnx"]) {
    const modelFilePath = resolve(embeddingModelPath, modelFile);
    try {
        await access(modelFilePath);
    } catch (cause) {
        throw new Error(`本地嵌入模型文件缺失或不可访问：${modelFilePath}`, { cause });
    }
}

const embeddingBatchSize = 16;

class TransformersEmbeddings extends Embeddings {
    private readonly extractor = pipeline("feature-extraction", embeddingModelPath);

    constructor() {
        super({});
    }

    async embedDocuments(texts: string[]): Promise<number[][]> {
        const embeddings: number[][] = [];
        const extractor = await this.extractor;

        for (let start = 0; start < texts.length; start += embeddingBatchSize) {
            const batch = texts.slice(start, start + embeddingBatchSize);
            const output = await extractor(batch, { pooling: "mean", normalize: true });

            for (const row of output.tolist()) {
                if (!Array.isArray(row) || row.length === 0) {
                    throw new Error("嵌入模型返回了无效的向量。");
                }

                embeddings.push(row.map((value: unknown) => {
                    if (typeof value !== "number" || !Number.isFinite(value)) {
                        throw new Error("嵌入模型返回了非数值向量元素。");
                    }
                    return value;
                }));
            }
        }

        return embeddings;
    }

    async embedQuery(text: string): Promise<number[]> {
        const [embedding] = await this.embedDocuments([text]);
        if (!embedding) {
            throw new Error("嵌入模型未能处理提问。");
        }
        return embedding;
    }
}

class FaissRetriever extends BaseRetriever {
    lc_namespace = ["hello-world", "faiss"];

    constructor(
        private readonly index: FaissIndex,
        private readonly documents: Document[],
        private readonly embeddings: TransformersEmbeddings,
        private readonly minSimilarity: number,
    ) {
        super({});
    }

    async _getRelevantDocuments(question: string): Promise<Document[]> {
        const queryVector = await this.embeddings.embedQuery(question);
        const { labels, distances } = this.index.search(queryVector, Math.min(5, this.documents.length));
        const candidates = labels.flatMap((label, rank) => {
            const document = this.documents[label];
            const similarity = distances[rank];
            return document && similarity !== undefined ? [{ document, similarity }] : [];
        });

        console.log(
            `FAISS Top-${candidates.length} cosine similarity: ${candidates.map(({ similarity }) => similarity.toFixed(3)).join(", ")}`,
        );

        const matches = candidates
            .filter(({ similarity }) => similarity >= this.minSimilarity)
            .map(({ document, similarity }) => new Document({
                pageContent: document.pageContent,
                metadata: { ...document.metadata, similarity },
            }));
        console.log(`通过相似度阈值 ${this.minSimilarity.toFixed(2)} 的片段：${matches.length}/${candidates.length}`);
        return matches;
    }
}

const configuredDocumentPath = process.env.HELLO_WORLD_DOCUMENT_PATH;
if (!configuredDocumentPath) {
    throw new Error("请在 hello-world/.env 中配置 HELLO_WORLD_DOCUMENT_PATH。");
}

const documentPath = resolve(featureDirectory, configuredDocumentPath);
if (extname(documentPath).toLowerCase() !== ".docx") {
    throw new Error(`仅支持 .docx 格式的 Word 文件：${documentPath}`);
}
await access(documentPath);

const extractedText = await mammoth.extractRawText({ path: documentPath });
if (!extractedText.value.trim()) {
    throw new Error(`Word 文件中没有可检索的文本：${documentPath}`);
}

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
    throw new Error("请在命令行参数中提供提问，例如：npx tsx src/server/features/hello-world/hello-world013.ts \"文档的主要内容是什么？\"");
}

const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 150,
    separators: ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""],
});
const documents = await splitter.splitDocuments([
    new Document({
        pageContent: extractedText.value,
        metadata: { source: documentPath },
    }),
]);
const embeddings = new TransformersEmbeddings();
const vectors = await embeddings.embedDocuments(documents.map(({ pageContent }) => pageContent));
const dimension = vectors[0]?.length;
if (!dimension || vectors.length !== documents.length || vectors.some((vector) => vector.length !== dimension)) {
    throw new Error("嵌入向量数量或维度无效，无法建立 FAISS 索引。");
}

const index = new FaissIndexFlatIP(dimension);
index.add(vectors.flat());
if (index.ntotal() !== documents.length) {
    throw new Error("FAISS 索引中的向量数量与文档分块数量不一致。");
}

const retriever = new FaissRetriever(index, documents, embeddings, minSimilarity);
const answerPrompt = ChatPromptTemplate.fromMessages([
    ["system", "你是一个严谨的文档问答助手。只依据给出的检索片段回答；如果片段中没有答案，请明确说明。引用内容时使用对应的[片段编号]。"],
    ["human", "用户问题：{question}\n\n本地检索到的文档片段：\n{context}"],
]);
const matches = await retriever.invoke(question);
if (matches.length === 0) {
    console.log("没有片段达到相似度阈值，已跳过 GPT 回答。");
} else {
    const client = createCopilotClient();
    try {
        const answerModel = new CopilotChatModel(client, { model: "gpt-6-luna" });
        const answerChain = RunnableSequence.from([
            new RunnableLambda({
                func: (input: { question: string; matches: Document[] }) => ({
                    question: input.question,
                    context: input.matches
                        .map((document, index) => `[片段 ${index + 1}]\n${document.pageContent}`)
                        .join("\n\n"),
                }),
            }),
            answerPrompt,
            answerModel,
        ]);

        const answer = await answerChain.invoke({ question, matches });
        console.log(answer.text);
    } finally {
        await client.stop();
    }
}