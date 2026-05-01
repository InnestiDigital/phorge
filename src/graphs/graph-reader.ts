import type { GraphNode, GraphEdge, NodeKind } from './schema'

export type NeighborOpts = {
  maxHops?: 1 | 2
  edgeKinds?: string[]
  confidenceFloor?: 'exact' | 'inferred'
  maxNodes?: number
  maxEdges?: number
}

export type SearchOpts = {
  kinds?: NodeKind[]
  limit?: number
}

export type Subgraph = {
  center: string[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
}

export type GraphReader = {
  getNode(key: string): GraphNode | undefined
  getNeighbors(key: string, opts?: NeighborOpts): Subgraph
  search(query: string, opts?: SearchOpts): GraphNode[]
}

type AdjEntry = {
  outgoing: GraphEdge[]
  incoming: GraphEdge[]
}

export function createGraphReader(nodes: GraphNode[], edges: GraphEdge[]): GraphReader {
  const nodeMap = new Map<string, GraphNode>()
  for (const n of nodes) nodeMap.set(n.key, n)

  const adj = new Map<string, AdjEntry>()
  for (const e of edges) {
    let fromEntry = adj.get(e.from)
    if (!fromEntry) { fromEntry = { outgoing: [], incoming: [] }; adj.set(e.from, fromEntry) }
    fromEntry.outgoing.push(e)

    let toEntry = adj.get(e.to)
    if (!toEntry) { toEntry = { outgoing: [], incoming: [] }; adj.set(e.to, toEntry) }
    toEntry.incoming.push(e)
  }

  return {
    getNode(key: string): GraphNode | undefined {
      return nodeMap.get(key)
    },

    search(query: string, opts?: SearchOpts): GraphNode[] {
      const limit = opts?.limit ?? 20
      const kinds = opts?.kinds ? new Set(opts.kinds) : null
      const lowerQuery = query.toLowerCase()

      type Scored = { node: GraphNode; rank: number }
      const results: Scored[] = []

      for (const [, node] of nodeMap) {
        if (kinds && !kinds.has(node.kind as NodeKind)) continue

        const keyLower = node.key.toLowerCase()
        const nameLower = node.name.toLowerCase()
        const fqcnLower = (node.fqcn ?? '').toLowerCase()

        let rank = -1
        if (keyLower === lowerQuery) rank = 0
        else if (fqcnLower === lowerQuery) rank = 1
        else if (nameLower === lowerQuery) rank = 2
        else if (keyLower.startsWith(lowerQuery) || fqcnLower.startsWith(lowerQuery)) rank = 3
        else if (nameLower.startsWith(lowerQuery)) rank = 4
        else if (keyLower.includes(lowerQuery) || fqcnLower.includes(lowerQuery) || nameLower.includes(lowerQuery)) rank = 5

        if (rank >= 0) results.push({ node, rank })
      }

      results.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank
        return a.node.key.localeCompare(b.node.key)
      })

      return results.slice(0, limit).map(r => r.node)
    },

    getNeighbors(centerKey: string, opts?: NeighborOpts): Subgraph {
      const maxHops = opts?.maxHops ?? 2
      const maxNodes = opts?.maxNodes ?? 200
      const maxEdges = opts?.maxEdges ?? 500
      const confidenceFloor = opts?.confidenceFloor ?? 'inferred'
      const edgeKindFilter = opts?.edgeKinds ? new Set(opts.edgeKinds) : null

      const centerNode = nodeMap.get(centerKey)
      if (!centerNode) {
        return { center: [centerKey], nodes: [], edges: [], truncated: false }
      }

      const centerKeys = new Set([centerKey])

      function edgePassesFilter(e: GraphEdge): boolean {
        if (confidenceFloor === 'exact' && e.confidence !== 'exact') return false
        if (edgeKindFilter && !edgeKindFilter.has(e.kind)) return false
        return true
      }

      // Collect: BFS hop by hop
      const visitedNodes = new Set<string>([centerKey])
      const collectedEdges: GraphEdge[] = []
      const edgeSigs = new Set<string>()
      let frontier = new Set([centerKey])

      for (let hop = 0; hop < maxHops; hop++) {
        const nextFrontier = new Set<string>()
        for (const nodeKey of frontier) {
          const entry = adj.get(nodeKey)
          if (!entry) continue
          for (const e of entry.outgoing) {
            if (!edgePassesFilter(e)) continue
            const sig = `${e.from}|${e.to}|${e.kind}`
            if (edgeSigs.has(sig)) continue
            edgeSigs.add(sig)
            collectedEdges.push(e)
            if (!visitedNodes.has(e.to)) {
              visitedNodes.add(e.to)
              nextFrontier.add(e.to)
            }
          }
          for (const e of entry.incoming) {
            if (!edgePassesFilter(e)) continue
            const sig = `${e.from}|${e.to}|${e.kind}`
            if (edgeSigs.has(sig)) continue
            edgeSigs.add(sig)
            collectedEdges.push(e)
            if (!visitedNodes.has(e.from)) {
              visitedNodes.add(e.from)
              nextFrontier.add(e.from)
            }
          }
        }
        frontier = nextFrontier
      }

      // Compute subgraph-local degree for pruning
      const degree = new Map<string, number>()
      for (const key of visitedNodes) degree.set(key, 0)
      for (const e of collectedEdges) {
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
      }

      // Prune if needed
      let truncated = false

      // Prune nodes first (never prune centers)
      let nodeKeys = [...visitedNodes]
      if (nodeKeys.length > maxNodes) {
        truncated = true
        // Sort non-center nodes by degree asc (lowest first to drop)
        const nonCenter = nodeKeys.filter(k => !centerKeys.has(k))
        nonCenter.sort((a, b) => {
          const da = degree.get(a) ?? 0
          const db = degree.get(b) ?? 0
          if (da !== db) return da - db
          return a.localeCompare(b)
        })
        const keepCount = maxNodes - centerKeys.size
        const kept = new Set([...centerKeys, ...nonCenter.slice(nonCenter.length - keepCount)])
        nodeKeys = nodeKeys.filter(k => kept.has(k))

        // Remove edges incident to dropped nodes
        const keptSet = new Set(nodeKeys)
        const newEdges = collectedEdges.filter(e => keptSet.has(e.from) && keptSet.has(e.to))
        collectedEdges.length = 0
        collectedEdges.push(...newEdges)
      }

      // Prune edges if still over budget
      if (collectedEdges.length > maxEdges) {
        truncated = true
        // Drop inferred first, then by kind alphabetical
        collectedEdges.sort((a, b) => {
          const ca = a.confidence === 'inferred' ? 1 : 0
          const cb = b.confidence === 'inferred' ? 1 : 0
          if (ca !== cb) return ca - cb
          return a.kind.localeCompare(b.kind)
        })
        collectedEdges.length = maxEdges
      }

      // Build result nodes
      const resultNodeSet = new Set(nodeKeys)
      const resultNodes = nodeKeys
        .map(k => nodeMap.get(k))
        .filter((n): n is GraphNode => !!n)

      // Stable sort: centers first, then degree desc, then key asc
      resultNodes.sort((a, b) => {
        const ac = centerKeys.has(a.key) ? 0 : 1
        const bc = centerKeys.has(b.key) ? 0 : 1
        if (ac !== bc) return ac - bc
        const da = degree.get(a.key) ?? 0
        const db = degree.get(b.key) ?? 0
        if (db !== da) return db - da
        return a.key.localeCompare(b.key)
      })

      // Stable edge sort
      collectedEdges.sort((a, b) => {
        if (a.from !== b.from) return a.from.localeCompare(b.from)
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
        return a.to.localeCompare(b.to)
      })

      return {
        center: [centerKey],
        nodes: resultNodes,
        edges: collectedEdges,
        truncated,
      }
    },
  }
}
