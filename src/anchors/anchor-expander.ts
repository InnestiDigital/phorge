// pipeline/knowledge/consumers/anchor-expander.ts
import type { CoChangeView } from '../commit-mining'
import type { GraphReader } from '../graphs/graph-reader'
import type { EdgeKind } from '../graphs/schema'
import {
  type TargetAnchor,
  type AnchorConfidence,
  type ExpansionResult,
  CONFIDENCE_ORDER,
  SOURCE_PRIORITY,
  GRAPH_EXPAND_EDGE_KINDS,
  edgeKindsToStrings,
  isNoisePath,
  canonicalKey,
} from './anchor-types'

// Strong symbol shape used to gate fuzzy graph search and to bypass the
// medium-confidence gate when a low-confidence symbol resolves to a real graph node.
const DOMAIN_SUFFIXES = /(?:Controller|Request|Job|Policy|Resource|Transformer|Service|Repository|Event|Listener|Observer|Command)$/

function symbolMapsToGraph(value: string, reader: GraphReader): boolean {
  const exact = reader.getNode(value)
  if (exact) return true
  const isStrong = value.includes('\\') || value.includes('::') || DOMAIN_SUFFIXES.test(value)
  if (!isStrong) return false
  return reader.search(value, { limit: 1 }).length > 0
}

export type AnchorExpanderDeps = {
  coChangeView?: CoChangeView
  graphReader?: GraphReader
}

export type AnchorExpanderOpts = {
  maxCoChangePerAnchor?: number
  minCoupling?: number
  maxCoChangeAnchors?: number
  graphEdgeKinds?: readonly EdgeKind[]
  maxGraphPerAnchor?: number
}

function degradeConfidence(parent: AnchorConfidence): AnchorConfidence {
  if (parent === 'high') return 'medium'
  return 'low'
}

export function expandAnchors(
  inputAnchors: TargetAnchor[],
  deps: AnchorExpanderDeps,
  opts?: AnchorExpanderOpts,
): ExpansionResult {
  const maxPerAnchor = opts?.maxCoChangePerAnchor ?? 3
  const minCoupling = opts?.minCoupling ?? 0.5
  const maxAnchors = opts?.maxCoChangeAnchors ?? 5

  const expandedAnchors: TargetAnchor[] = []
  const expandedFrom: Record<string, string[]> = {}
  const existingKeys = new Set(inputAnchors.map(a => canonicalKey(a.kind, a.value)))
  const expandedKeys = new Set<string>()
  let coChangeAdded = 0
  let graphAdded = 0
  let skippedExisting = 0
  let skippedUnresolved = 0

  // Co-change expansion
  if (deps.coChangeView) {
    const entryIndex = new Map<string, typeof deps.coChangeView.entries[0]>()
    for (const e of deps.coChangeView.entries) entryIndex.set(e.path, e)

    const candidates = inputAnchors
      .filter(a => a.kind === 'path' && CONFIDENCE_ORDER[a.confidence] >= CONFIDENCE_ORDER.medium)
      .sort((a, b) => {
        const confDiff = CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence]
        if (confDiff !== 0) return confDiff
        return SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]
      })
      .slice(0, maxAnchors)

    for (const anchor of candidates) {
      const entry = entryIndex.get(anchor.value)
      if (!entry) continue
      const parentKey = canonicalKey(anchor.kind, anchor.value)
      const children: string[] = []
      let added = 0
      const sortedNeighbors = [...entry.neighbors].sort((a, b) => b.coupling - a.coupling)
      for (const neighbor of sortedNeighbors) {
        if (added >= maxPerAnchor) break
        if (neighbor.coupling < minCoupling) continue
        const childKey = canonicalKey('path', neighbor.path)
        if (existingKeys.has(childKey) || expandedKeys.has(childKey)) {
          skippedExisting++
          continue
        }
        if (isNoisePath(neighbor.path)) continue
        expandedAnchors.push({
          kind: 'path',
          value: neighbor.path,
          source: 'cochange_expand',
          confidence: degradeConfidence(anchor.confidence),
          evidence: [`cochange_expand: from ${parentKey} coupling=${neighbor.coupling.toFixed(2)}`],
          metadata: { coupling: neighbor.coupling, parent: parentKey },
        })
        expandedKeys.add(childKey)
        children.push(childKey)
        added++
        coChangeAdded++
      }
      if (children.length > 0) expandedFrom[parentKey] = children
    }
  }

  // Graph expansion
  if (deps.graphReader) {
    const reader = deps.graphReader
    const edgeKinds = opts?.graphEdgeKinds ?? GRAPH_EXPAND_EDGE_KINDS
    const maxGraphPerAnchor = opts?.maxGraphPerAnchor ?? 5
    // Path anchors that map to a real graph node are inherently trustworthy
    // (the scanner found the file). Symbol anchors normally require medium+
    // confidence to avoid fuzzy-search hallucinations — but if a low-confidence
    // symbol already resolves to a real graph node (exact lookup or strong-shape
    // fuzzy match), it earns the bypass too.
    const graphCandidates = inputAnchors.filter(a => {
      if (a.kind === 'path') return true
      if (symbolMapsToGraph(a.value, reader)) return true
      return CONFIDENCE_ORDER[a.confidence] >= CONFIDENCE_ORDER.medium
    })

    for (const anchor of graphCandidates) {
      let nodeKey: string | undefined

      if (anchor.kind === 'path') {
        // File nodes only have a `defines` edge (to their class). Promote to
        // the class node so expansion taps the rich edges (uses_trait,
        // implements, contains_method, dispatches_job, etc).
        const fileKey = `file:${anchor.value}`
        if (deps.graphReader.getNode(fileKey)) {
          const promoted = deps.graphReader
            .getNeighbors(fileKey, { maxHops: 1, edgeKinds: ['defines'], maxNodes: 4 })
            .nodes.find(n => n.key.startsWith('class:'))
          nodeKey = promoted ? promoted.key : fileKey
        }
      } else {
        // Try exact lookup first
        const exact = deps.graphReader.getNode(anchor.value)
        if (exact) {
          nodeKey = exact.key
        } else {
          // Fuzzy search fallback only for strong symbol shapes
          const val = anchor.value
          const isStrong = val.includes('\\') || val.includes('::') || DOMAIN_SUFFIXES.test(val)
          if (isStrong) {
            const results = deps.graphReader.search(val, { limit: 1 })
            if (results.length > 0) nodeKey = results[0].key
          } else {
            skippedUnresolved++
          }
        }
      }

      if (!nodeKey) {
        if (anchor.kind === 'symbol') skippedUnresolved++
        continue
      }

      const subgraph = deps.graphReader.getNeighbors(nodeKey, {
        maxHops: 1,
        edgeKinds: edgeKindsToStrings(edgeKinds),
        maxNodes: maxGraphPerAnchor + 1,
      })

      const parentKey = canonicalKey(anchor.kind, anchor.value)
      const children: string[] = []
      let graphChildrenAdded = 0

      // Sort edges deterministically before emit
      const sortedEdges = [...subgraph.edges].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
        const aNeighbor = a.from === nodeKey ? a.to : a.from
        const bNeighbor = b.from === nodeKey ? b.to : b.from
        return aNeighbor.localeCompare(bNeighbor)
      })

      for (const edge of sortedEdges) {
        if (graphChildrenAdded >= maxGraphPerAnchor) break
        const neighborKey = edge.from === nodeKey ? edge.to : edge.from
        const neighborNode = subgraph.nodes.find(n => n.key === neighborKey)
        if (!neighborNode) continue

        // Derive anchor kind from node key
        const isFile = neighborNode.key.startsWith('file:')
        const childKind = isFile ? 'path' as const : 'symbol' as const
        const childValue = isFile ? (neighborNode.filePath ?? neighborNode.key.replace('file:', '')) : neighborNode.key

        if (isFile && isNoisePath(childValue)) continue

        const childCanonical = canonicalKey(childKind, childValue)
        if (existingKeys.has(childCanonical) || expandedKeys.has(childCanonical)) {
          skippedExisting++
          continue
        }

        expandedAnchors.push({
          kind: childKind,
          value: childValue,
          source: 'graph_expand',
          confidence: degradeConfidence(anchor.confidence),
          evidence: [`graph_expand: from ${parentKey} via ${edge.kind}`],
          metadata: { parent: parentKey, edgeKind: edge.kind },
        })
        expandedKeys.add(childCanonical)
        children.push(childCanonical)
        graphAdded++
        graphChildrenAdded++
      }

      if (children.length > 0) {
        expandedFrom[parentKey] = [...(expandedFrom[parentKey] ?? []), ...children]
      }
    }
  }

  return {
    anchors: expandedAnchors,
    expandedFrom,
    stats: { coChangeAdded, graphAdded, skippedExisting, skippedUnresolved },
  }
}
