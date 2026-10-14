import { showExecutionGraph } from '../langgraph-visualization.js'
import { MediaWikiApi } from 'wiki-saikou'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
    Annotation,
    StateGraph,
    START,
    END,
} from "@langchain/langgraph";

/**
 * 使用 LangGraph 构建多智能体系统
 * https://campus.datacamp.com/zh/courses/multi-agent-systems-with-langgraph/agents-as-graphs
 */

const wiki_api = new MediaWikiApi({
    baseURL: 'https://zh.moegirl.org.cn/api.php',
    throwOnApiError: true,
})

type OpenSearchResponse = [string, string[], string[], string[]]
type ExtractsResponse = {
    query?: {
        pages?: Array<{
            title: string
            extract?: string
        }>
    }
}

type SearchResponse = {
    query?: {
        search?: Array<{ title: string }>
    }
}

type WikiArticle = {
    title: string
    summary: string | null
}

export function executeCode(code: string): string {
    try {
        return String(new Function('source', 'return eval(source)')(code))
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return `Failed to execute. Error: ${reason}`
    }
}

export type StockPriceData = {
    headers: string[]
    data: string[][]
}

function unavailableStockError(stockCode: string): Error {
    return new Error(
        `Sorry, but data for company ${stockCode} is not available. Please try Apple, Amazon, Meta, Microsoft, Netflix, or Tesla.`,
    )
}

export async function getStockPrices(stockCode: string, tradingDays: number): Promise<StockPriceData> {
    const normalizedStockCode = stockCode.trim().toLowerCase()
    if (!/^[a-z0-9.-]+$/.test(normalizedStockCode)) {
        throw unavailableStockError(stockCode)
    }

    const filePath = fileURLToPath(new URL(`./data/${normalizedStockCode}_us_d.csv`, import.meta.url))
    let csv: string
    try {
        csv = await readFile(filePath, 'utf8')
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            throw unavailableStockError(stockCode)
        }
        throw error
    }

    const [headerLine, ...rows] = csv.trim().split(/\r?\n/).filter(Boolean)
    if (headerLine === undefined) {
        throw new Error(`Stock price data for ${stockCode} is empty.`)
    }

    if (tradingDays > rows.length) {
        throw new Error(
            `Sorry, but this time period ${tradingDays} exceeds the data available. Please reduce it to continue.`,
        )
    }
    if (!Number.isInteger(tradingDays) || tradingDays < 1) {
        throw new RangeError('The number of trading days must be a positive integer.')
    }

    return {
        headers: headerLine.replace(/^\uFEFF/, '').split(','),
        data: rows.slice(-tradingDays).map((row) => row.split(',')),
    }
}

async function searchWiki(query: string): Promise<WikiArticle[]> {
    const searchResult = await wiki_api.get<OpenSearchResponse>({
        action: 'opensearch',
        search: query,
        limit: 12,
        namespace: 0,
    })
    const titles = searchResult.data[1]
    // const searchResult = await wiki_api.get<SearchResponse>({
    //     action: 'query',
    //     list: 'search',
    //     srsearch: query,
    //     srnamespace: 0,
    //     srlimit: 12,
    // })
    // const titles = (searchResult.data.query?.search ?? []).map(({ title }) => title)
    if (titles.length === 0) return []

    const extractsResult = await wiki_api.get<ExtractsResponse>({
        action: 'query',
        prop: 'extracts',
        titles: titles.join('|'),
        exintro: true,
        explaintext: true,
        exsentences: 2,
    })
    const summaries = new Map<string, string>()
    for (const page of extractsResult.data.query?.pages ?? []) {
        const summary = page.extract?.trim()
        if (summary) summaries.set(page.title, summary)
    }

    return titles.map((title) => ({
        title,
        summary: summaries.get(title) ?? null,
    }))
}

type WorkflowTask =
    | { kind: 'searchWiki'; prompt: string; query: string }
    | { kind: 'getStockPrices'; prompt: string; stockCode: string; tradingDays: number }
    | { kind: 'plotOpen'; prompt: string; stockCode: string; tradingDays: number }

type WorkflowResult = {
    prompt: string
    output: string
}

function createPlotCode(prompt: string, stockPriceData: StockPriceData): string {
    const requestedField = prompt.match(/\b(Open|High|Low|Close)\b/i)?.[1]
    if (!requestedField) {
        throw new Error(`Cannot determine the requested stock-price column from "${prompt}".`)
    }

    const fieldIndex = stockPriceData.headers.findIndex(
        (header) => header.toLowerCase() === requestedField.toLowerCase(),
    )
    const dateIndex = stockPriceData.headers.findIndex((header) => header.toLowerCase() === 'date')
    if (fieldIndex < 0 || dateIndex < 0) {
        throw new Error(`Stock-price data must contain Date and ${requestedField} columns.`)
    }

    const points = stockPriceData.data.map((row, index) => {
        const date = row[dateIndex]
        const price = Number(row[fieldIndex])
        if (date === undefined || !Number.isFinite(price)) {
            throw new Error(`Invalid ${requestedField} stock-price row at index ${index}.`)
        }
        return { date, price }
    })
    if (points.length === 0) {
        throw new Error('No stock-price rows are available to plot.')
    }

    return `(() => {
  const field = ${JSON.stringify(stockPriceData.headers[fieldIndex])};
  const points = ${JSON.stringify(points)};
  const chartWidth = Math.min(points.length, 60);
  const chartHeight = 10;
  const sampledPoints = points.length <= chartWidth
    ? points
    : Array.from({ length: chartWidth }, (_, index) =>
        points[Math.round(index * (points.length - 1) / (chartWidth - 1))]);
  const prices = sampledPoints.map((point) => point.price);
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const grid = Array.from({ length: chartHeight }, () => Array(chartWidth).fill(' '));
  const coordinates = sampledPoints.map((point, index) => ({
    x: chartWidth === 1 ? 0 : Math.round(index * (chartWidth - 1) / (sampledPoints.length - 1)),
    y: maximum === minimum ? Math.floor(chartHeight / 2)
      : Math.round((maximum - point.price) / (maximum - minimum) * (chartHeight - 1)),
  }));

  for (let index = 0; index < coordinates.length; index += 1) {
    const current = coordinates[index];
    const previous = coordinates[index - 1];
    if (!current) continue;
    if (!previous) {
      grid[current.y][current.x] = '*';
      continue;
    }
    const distance = current.x - previous.x;
    for (let step = 0; step <= distance; step += 1) {
      const ratio = distance === 0 ? 0 : step / distance;
      const y = Math.round(previous.y + (current.y - previous.y) * ratio);
      grid[y][previous.x + step] = '*';
    }
  }

  const chart = grid.map((row, index) => {
    const value = maximum === minimum
      ? maximum
      : maximum - (maximum - minimum) * index / (chartHeight - 1);
    return value.toFixed(2).padStart(9) + ' | ' + row.join('');
  }).join('\\n');
  return field + ' price time-series (' + points.length + ' trading days)\\n'
    + chart + '\\n'
    + points[0].date + ' to ' + points[points.length - 1].date;
})()`
}

const exampleTasks: WorkflowTask[] = [
    {
        kind: 'searchWiki',
        prompt: 'Tell me about Apple Inc with searchWiki.',
        query: 'Apple Inc',
    },
    {
        kind: 'getStockPrices',
        prompt: 'AAPL stock price with getStockPrices.',
        stockCode: 'AAPL',
        tradingDays: 30,
    },
    {
        kind: 'plotOpen',
        prompt: 'Plot an Open price time-series of AAPL with executeCode.',
        stockCode: 'AAPL',
        tradingDays: 30,
    },
]

const completedNodeIds = new Set<string>()
const workflowState = Annotation.Root({
    tasks: Annotation<WorkflowTask[]>({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    currentTask: Annotation<WorkflowTask | null>({
        reducer: (_current, next) => next,
        default: () => null,
    }),
    taskIndex: Annotation<number>({
        reducer: (_current, next) => next,
        default: () => 0,
    }),
    stockPriceData: Annotation<StockPriceData | null>({
        reducer: (_current, next) => next,
        default: () => null,
    }),
    generatedCode: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => '',
    }),
    results: Annotation<WorkflowResult[]>({
        reducer: (_current, next) => next,
        default: () => [],
    }),
})

const workflow = new StateGraph(workflowState)
    .addNode('prepareTask', ({ tasks, taskIndex }) => {
        const task = tasks[taskIndex]
        if (!task) {
            throw new Error(`No workflow task is available at index ${taskIndex}.`)
        }
        completedNodeIds.add('prepareTask')
        return { currentTask: task, stockPriceData: null, generatedCode: '' }
    })
    .addNode('searchWiki', async ({ currentTask, results }) => {
        if (currentTask?.kind !== 'searchWiki') {
            throw new Error('The searchWiki node received an incompatible task.')
        }
        const articles = await searchWiki(currentTask.query)
        completedNodeIds.add('searchWiki')
        return {
            results: [...results, { prompt: currentTask.prompt, output: JSON.stringify(articles, null, 2) }],
        }
    })
    .addNode('getStockPrices', async ({ currentTask, results }) => {
        if (!currentTask || currentTask.kind === 'searchWiki') {
            throw new Error('The getStockPrices node received an incompatible task.')
        }
        const stockPriceData = await getStockPrices(currentTask.stockCode, currentTask.tradingDays)
        completedNodeIds.add('getStockPrices')
        if (currentTask.kind === 'getStockPrices') {
            return {
                stockPriceData,
                results: [
                    ...results,
                    { prompt: currentTask.prompt, output: JSON.stringify(stockPriceData, null, 2) },
                ],
            }
        }
        return { stockPriceData }
    })
    .addNode('useLangGraph', ({ currentTask, stockPriceData }) => {
        if (currentTask?.kind !== 'plotOpen' || !stockPriceData) {
            throw new Error('The useLangGraph node requires a plot task with stock-price data.')
        }
        const generatedCode = createPlotCode(currentTask.prompt, stockPriceData)
        completedNodeIds.add('useLangGraph')
        return { generatedCode }
    })
    .addNode('executeCode', ({ currentTask, generatedCode, results }) => {
        if (currentTask?.kind !== 'plotOpen' || !generatedCode) {
            throw new Error('The executeCode node requires generated plotting code.')
        }
        const output = executeCode(generatedCode)
        if (output.startsWith('Failed to execute. Error:')) {
            throw new Error(output)
        }
        completedNodeIds.add('executeCode')
        return {
            results: [...results, { prompt: currentTask.prompt, output }],
        }
    })
    .addNode('advanceTask', ({ taskIndex, currentTask }) => {
        if (!currentTask) {
            throw new Error('Cannot advance without a current workflow task.')
        }
        completedNodeIds.add('advanceTask')
        return { taskIndex: taskIndex + 1, currentTask: null }
    })
    .addEdge(START, 'prepareTask')
    .addConditionalEdges(
        'prepareTask',
        ({ currentTask }) => {
            if (!currentTask) {
                throw new Error('The task preparation node did not set a current task.')
            }
            return currentTask.kind === 'searchWiki' ? 'searchWiki' : 'getStockPrices'
        },
        ['searchWiki', 'getStockPrices'],
    )
    .addEdge('searchWiki', 'advanceTask')
    .addConditionalEdges(
        'getStockPrices',
        ({ currentTask }) => {
            if (currentTask?.kind === 'plotOpen') return 'useLangGraph'
            if (currentTask?.kind === 'getStockPrices') return 'advanceTask'
            throw new Error('The getStockPrices node completed without a valid task.')
        },
        ['useLangGraph', 'advanceTask'],
    )
    .addEdge('useLangGraph', 'executeCode')
    .addEdge('executeCode', 'advanceTask')
    .addConditionalEdges(
        'advanceTask',
        ({ tasks, taskIndex }) => taskIndex < tasks.length ? 'prepareTask' : END,
        ['prepareTask', END],
    )
    .compile();

const result = await workflow.invoke({ tasks: exampleTasks })
for (const { prompt, output } of result.results) {
    console.log(`Request: ${prompt}`)
    console.log(output)
}
await showExecutionGraph(await workflow.getGraphAsync(), completedNodeIds)

// console.log(await searchWiki('Apple'));
// console.log(await getStockPrices('Apple', 5));
// console.log(await getStockPrices('aapl', 5));
// console.log(await executeCode("console.log('Hello, world!\\r\\n'); 2 + 2;"));
