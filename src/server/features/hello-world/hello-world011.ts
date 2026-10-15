import {showExecutionGraph} from '../langgraph-visualization.js'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {HumanMessage, SystemMessage} from '@langchain/core/messages'
import {
    Annotation,
    StateGraph,
    START,
    END,
} from "@langchain/langgraph";
import {createCopilotClient} from './core.js'
import {CopilotChatModel} from './lang-chatnormal-model.js'

/**
 * Build a stock-price analysis workflow with LangGraph.
 */

/**
 * 优化/Users/md07/code/HelloPrompt/src/server/features/hello-world/hello-world010.ts中的逻辑：
 * 1.
 * 目前从wiki-saikou获取信息的逻辑，改为从大模型自身的知识库中获取信息。功能改为：根据提示词，返回对应公司的股票代码
 * 2.
 * getStockPrices工具，根据前述返回的股票代码，不依赖大模型的知识库，直接调用getStockPrices方法从本地获取最近15天的股票价格。如果没有找到对应的文件，则终止，不执行第3步
 * 3.
 * executeCode工具，根据前述返回的股票价格，不依赖大模型的知识库，直接调用executeCode方法在本地生成价格走势
 * 4.
 * 第1步的提示词，需要支持一次返回多个股票代码，如果无法返回任何有效的股票代码，则提示优化提示信息。第2步、第3步需要支持多个股票代码的处理。第2步需要处理部分股票代码没有找到的逻辑和所有股票代码都没有找到的逻辑。部分股票代码没有找到时，列出没有找到的股票代码，同时展示其他能找到的股票代码；所有股票代码都没找到时，列出所有没有找到的股票代码，并终止执行。
 * 5.
 * 提示信息均为英文
 */

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

class StockDataUnavailableError extends Error {
    constructor(stockCode: string) {
        super(`No local stock-price file was found for ${stockCode}.`)
        this.name = 'StockDataUnavailableError'
    }
}

export async function getStockPrices(stockCode: string, tradingDays: number): Promise<StockPriceData> {
    const normalizedStockCode = stockCode.trim().toLowerCase()
    if (!/^[a-z0-9.-]+$/.test(normalizedStockCode)) {
        throw new StockDataUnavailableError(stockCode)
    }

    const filePath = fileURLToPath(new URL(`./data/${normalizedStockCode}_us_d.csv`, import.meta.url))
    let csv: string
    try {
        csv = await readFile(filePath, 'utf8')
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            throw new StockDataUnavailableError(stockCode)
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

const RECENT_TRADING_DAYS = 15

function parseStockCodes(response: string): string[] {
    const jsonResponse = response.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    let parsed: unknown
    try {
        parsed = JSON.parse(jsonResponse)
    } catch {
        return []
    }

    const candidates = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && 'stockCodes' in parsed
            ? parsed.stockCodes
            : []
    if (!Array.isArray(candidates)) return []

    const validCodes = candidates
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map((stockCode) => stockCode.trim().toUpperCase())
        .filter((stockCode) => stockCode.length <= 15 && /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(stockCode))
    return [...new Set(validCodes)]
}

function createPlotCode(prompt: string, stockCode: string, stockPriceData: StockPriceData): string {
    const requestedField = prompt.match(/\b(Open|High|Low|Close)\b/i)?.[1] ?? 'Close'

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
        return {date, price}
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
  return ${JSON.stringify(stockCode)} + ' ' + field + ' price time-series (' + points.length + ' trading days)\\n'
    + chart + '\\n'
    + points[0].date + ' to ' + points[points.length - 1].date;
})()`
}

type StockPriceResult = {
    stockCode: string
    data: StockPriceData
}

const completedNodeIds = new Set<string>()
const workflowState = Annotation.Root({
    prompt: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => '',
    }),
    stockCodes: Annotation<string[]>({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    stockPriceResults: Annotation<StockPriceResult[]>({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    missingStockCodes: Annotation<string[]>({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    output: Annotation<string>({
        reducer: (_current, next) => next,
        default: () => '',
    }),
})

const client = createCopilotClient()
const copilotModel = new CopilotChatModel(client)
const workflow = new StateGraph(workflowState)
    .addNode('identifyStocks', async ({prompt}) => {
        const response = await copilotModel.invoke([
            new SystemMessage(
                'Identify publicly traded companies in the user request and map each to its stock ticker using your own knowledge. Do not use external search, tools, or databases. Return only a JSON array of ticker symbols, for example ["AAPL", "MSFT"]. Return [] if no unambiguous symbols can be identified. Do not guess.',
            ),
            new HumanMessage(prompt),
        ])
        const stockCodes = parseStockCodes(response.text)
        completedNodeIds.add('identifyStocks')
        return {
            stockCodes,
            output: stockCodes.length === 0
                ? 'No valid stock symbols could be identified. Please refine your prompt by naming the companies or providing their ticker symbols.'
                : `Identified stock symbols: ${stockCodes.join(', ')}.`,
        }
    })
    .addNode('getStockPrices', async ({stockCodes}) => {
        const fetchResults = await Promise.all(stockCodes.map(async (stockCode) => {
            try {
                return {stockCode, data: await getStockPrices(stockCode, RECENT_TRADING_DAYS)}
            } catch (error) {
                if (error instanceof StockDataUnavailableError) {
                    return {stockCode, data: null}
                }
                throw error
            }
        }))
        const stockPriceResults = fetchResults.flatMap(({stockCode, data}) => (
            data ? [{stockCode, data}] : []
        ))
        const missingStockCodes = fetchResults
            .filter(({data}) => data === null)
            .map(({stockCode}) => stockCode)
        completedNodeIds.add('getStockPrices')
        const output = stockPriceResults.length === 0
            ? `No local stock-price files were found for: ${missingStockCodes.join(', ')}. Execution stopped; no charts were generated.`
            : [
                `Found local price data for: ${stockPriceResults.map(({stockCode}) => stockCode).join(', ')}.`,
                ...(missingStockCodes.length > 0
                    ? [`No local price data was found for: ${missingStockCodes.join(', ')}.`]
                    : []),
            ].join('\n')
        return {stockPriceResults, missingStockCodes, output}
    })
    .addNode('executeCode', ({prompt, stockPriceResults, output}) => {
        if (stockPriceResults.length === 0) {
            throw new Error('The executeCode node requires locally retrieved stock-price data.')
        }
        const charts = stockPriceResults.map(({stockCode, data}) => {
            const generatedCode = createPlotCode(prompt, stockCode, data)
            const chart = executeCode(generatedCode)
            if (chart.startsWith('Failed to execute. Error:')) throw new Error(chart)
            return chart
        })
        completedNodeIds.add('executeCode')
        return {output: [output, ...charts].filter(Boolean).join('\n\n')}
    })
    .addEdge(START, 'identifyStocks')
    .addConditionalEdges(
        'identifyStocks',
        ({stockCodes}) => {
            return stockCodes.length > 0 ? 'getStockPrices' : END
        },
        ['getStockPrices', END],
    )
    .addConditionalEdges(
        'getStockPrices',
        ({stockPriceResults}) => {
            return stockPriceResults.length > 0 ? 'executeCode' : END
        },
        ['executeCode', END],
    )
    .compile();

const prompt = process.argv.slice(2).join(' ').trim()
    || 'Compare Apple, Microsoft, and Tesla closing prices for the last 15 trading days.'
try {
    const result = await workflow.invoke({prompt})
    console.log(`Request: ${prompt}`)
    console.log(result.output)
    await showExecutionGraph(await workflow.getGraphAsync(), completedNodeIds)
} finally {
    await client.stop()
}
