import type { Subgraph } from './graph-reader'
import type { GraphEdge } from './schema'

export type RenderBudget = {
  maxNodes?: number
  maxEdges?: number
  maxChars?: number
}

const DEFAULT_MAX_CHARS = 50_000

export function renderSubgraph(subgraph: Subgraph, budget?: RenderBudget): string {
  if (subgraph.nodes.length === 0) return ''

  const maxChars = budget?.maxChars ?? DEFAULT_MAX_CHARS
  const centerSet = new Set(subgraph.center)

  // Build edge index per node
  const outgoing = new Map<string, GraphEdge[]>()
  const incoming = new Map<string, GraphEdge[]>()
  for (const e of subgraph.edges) {
    const o = outgoing.get(e.from) ?? []
    o.push(e)
    outgoing.set(e.from, o)
    const i = incoming.get(e.to) ?? []
    i.push(e)
    incoming.set(e.to, i)
  }

  // Sort edges within each group
  for (const [, edges] of outgoing) edges.sort(edgeSort)
  for (const [, edges] of incoming) edges.sort(edgeSort)

  // Nodes already sorted by reader (centers first, degree desc, key asc)
  const totalNodes = subgraph.nodes.length
  const totalEdges = subgraph.edges.length

  const header = `## Graph Context (center: ${subgraph.center.join(', ')})\n## ${totalNodes} nodes, ${totalEdges} edges\n`

  let out = header
  let renderedNodes = 0
  let renderedEdges = 0

  for (const node of subgraph.nodes) {
    const block = renderNodeBlock(node.key, outgoing.get(node.key) ?? [], incoming.get(node.key) ?? [])
    const candidate = out + '\n' + block
    if (candidate.length > maxChars) {
      break
    }
    out = candidate
    renderedNodes++
    renderedEdges += (outgoing.get(node.key) ?? []).length + (incoming.get(node.key) ?? []).length
  }

  if (renderedNodes < totalNodes || subgraph.truncated) {
    const elidedNodes = totalNodes - renderedNodes
    const footer = `\n... (${elidedNodes} nodes elided by budget)`
    if (out.length + footer.length <= maxChars) {
      out += footer
    }
  }

  return out
}

function renderNodeBlock(key: string, out: GraphEdge[], inc: GraphEdge[]): string {
  const lines: string[] = [`[${key}]`]

  for (const e of out) {
    lines.push(`  ${e.kind}: ${e.to} [${e.confidence}, ${e.source}]`)
  }
  for (const e of inc) {
    lines.push(`  <-${e.kind}: ${e.from} [${e.confidence}, ${e.source}]`)
  }

  return lines.join('\n')
}

function edgeSort(a: GraphEdge, b: GraphEdge): number {
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
  const aTarget = a.to ?? a.from
  const bTarget = b.to ?? b.from
  return aTarget.localeCompare(bTarget)
}
