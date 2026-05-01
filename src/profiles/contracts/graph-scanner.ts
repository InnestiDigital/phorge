import type { GraphNode, GraphEdge } from '../../graphs/schema'

export type ScannerStat = {
  nodes: number
  edges: number
  skipped: number
  unresolvedRefs: number
  duplicateEdges: number
}

export type GraphScanStats = {
  filesScanned: number
  parseErrors: number
  nodes: number
  edges: number
  perScanner: Record<string, ScannerStat>
}

export type GraphScanResult = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphScanStats
}

export type GraphScanner = {
  scan(opts: { repoRoot: string }): GraphScanResult
  // Ordered edge kinds brief follows from a `file:` node to find a richer
  // center node for subgraph rendering. First edge yielding a node with > 1
  // outgoing edge wins; empty/undefined disables promotion. EdgeKind kept
  // as string here to avoid a circular dependency on graphs/schema.
  readonly promotionEdges?: readonly string[]
}
