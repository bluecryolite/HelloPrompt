import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { END, START } from '@langchain/langgraph'

type DrawableWorkflow = {
    nodes: Record<string, { id: string; name: string }>
    edges: Array<{ source: string; target: string }>
}

function escapeXml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => {
        const escaped: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&apos;',
        }
        return escaped[character] ?? character
    })
}

function renderExecutionGraph(graph: DrawableWorkflow, completedNodeIds: ReadonlySet<string>): string {
    const nodes = Object.values(graph.nodes)
    if (nodes.length === 0) {
        throw new Error('Cannot render an empty LangGraph workflow.')
    }

    const nodeHeight = 72
    const nodeGap = 76
    const padding = 56
    const centerY = 142
    const positions = new Map<string, { x: number; width: number }>()
    let nextX = padding

    for (const node of nodes) {
        const isTerminal = node.id === START || node.id === END
        const width = isTerminal ? 84 : Math.max(152, Math.min(300, node.name.length * 9 + 36))
        positions.set(node.id, { x: nextX, width })
        nextX += width + nodeGap
    }

    const width = Math.max(420, nextX - nodeGap + padding)
    const edgeSvg = graph.edges.map(({ source, target }) => {
        const sourcePosition = positions.get(source)
        const targetPosition = positions.get(target)
        if (!sourcePosition || !targetPosition) {
            throw new Error(`Cannot render LangGraph edge from "${source}" to "${target}".`)
        }
        const startX = sourcePosition.x + sourcePosition.width
        const endX = targetPosition.x - 10
        const path = endX >= startX
            ? `M ${startX} ${centerY} H ${endX}`
            : `M ${startX} ${centerY - 12} C ${startX + 40} 36, ${endX - 40} 36, ${endX} ${centerY - 12}`
        return `<path d="${path}" fill="none" stroke="#64748b" stroke-width="2" marker-end="url(#arrowhead)"/>`
    }).join('\n')

    const nodeSvg = nodes.map((node) => {
        const position = positions.get(node.id)
        if (!position) {
            throw new Error(`Cannot render LangGraph node "${node.id}".`)
        }
        const isTerminal = node.id === START || node.id === END
        const isComplete = completedNodeIds.has(node.id)
        const fill = isTerminal ? '#f1f5f9' : isComplete ? '#dcfce7' : '#dbeafe'
        const stroke = isTerminal ? '#64748b' : isComplete ? '#16a34a' : '#2563eb'
        const label = node.id === START ? 'START' : node.id === END ? 'END' : node.name
        const status = isComplete
            ? `<text x="${position.x + position.width / 2}" y="${centerY + 20}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#15803d">COMPLETED</text>`
            : ''
        return `<g>
  <rect x="${position.x}" y="${centerY - nodeHeight / 2}" width="${position.width}" height="${nodeHeight}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
  <text x="${position.x + position.width / 2}" y="${centerY + 4}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="#0f172a">${escapeXml(label)}</text>
  ${status}
</g>`
    }).join('\n')

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="240" viewBox="0 0 ${width} 240" role="img" aria-labelledby="title description">
  <title id="title">LangGraph execution graph</title>
  <desc id="description">Workflow nodes and directed edges. Completed nodes are highlighted in green.</desc>
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
      <path d="M 0 0 L 10 4 L 0 8 z" fill="#64748b"/>
    </marker>
  </defs>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${padding}" y="42" font-family="sans-serif" font-size="20" font-weight="700" fill="#0f172a">LangGraph execution</text>
  <text x="${padding}" y="68" font-family="sans-serif" font-size="12" fill="#64748b">Completed nodes are highlighted in green</text>
  ${edgeSvg}
  ${nodeSvg}
</svg>`
}

async function openWithDefaultApplication(filePath: string): Promise<void> {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32'
        ? ['/c', 'start', '""', `"${filePath.replace(/"/g, '""')}"`]
        : [filePath]

    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore' })
        child.once('error', (error) => {
            reject(new Error(`Could not open the execution graph at ${filePath}.`, { cause: error }))
        })
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve()
                return
            }
            reject(new Error(`Could not open the execution graph at ${filePath} (exit code: ${code ?? signal}).`))
        })
    })
}

export async function showExecutionGraph(
    graph: DrawableWorkflow,
    completedNodeIds: ReadonlySet<string>,
): Promise<void> {
    const graphPath = join(tmpdir(), 'hello-world010-execution-graph.svg')
    await writeFile(graphPath, renderExecutionGraph(graph, completedNodeIds), 'utf8')
    console.log(`Execution graph saved to ${graphPath}`)
    await openWithDefaultApplication(graphPath)
}
