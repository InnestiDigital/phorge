import type { GraphReader } from '../graphs/graph-reader'
import { renderSubgraph } from '../graphs/graph-renderer'

export const GRAPH_CONTEXT_HEADER = '## Structural Context'
export const DEFAULT_GRAPH_MAX_ANCHORS = 3
export const DEFAULT_GRAPH_MAX_CHARS_PER_ANCHOR = 8000
export const DEFAULT_GRAPH_MAX_CHARS_TOTAL = 20000

export type FormatGraphContextOpts = {
  targetSymbols: string[]
  maxAnchors?: number
  maxCharsPerAnchor?: number
  maxCharsTotal?: number
  confidenceFloor?: 'exact' | 'inferred'
}

export function formatGraphContextForPlanner(
  reader: GraphReader,
  opts: FormatGraphContextOpts,
): string {
  const maxAnchors = opts.maxAnchors ?? DEFAULT_GRAPH_MAX_ANCHORS
  const maxCharsPerAnchor = opts.maxCharsPerAnchor ?? DEFAULT_GRAPH_MAX_CHARS_PER_ANCHOR
  const maxCharsTotal = opts.maxCharsTotal ?? DEFAULT_GRAPH_MAX_CHARS_TOTAL

  if (!opts.targetSymbols || opts.targetSymbols.length === 0) return ''

  const resolvedKeys: string[] = []
  const seen = new Set<string>()

  for (const sym of opts.targetSymbols) {
    if (resolvedKeys.length >= maxAnchors) break

    let key: string | null = null

    // Exact key match first
    const exactNode = reader.getNode(sym)
    if (exactNode) {
      key = exactNode.key
    } else {
      // Search fallback
      const results = reader.search(sym, { limit: 1 })
      if (results.length > 0) {
        key = results[0].key
      }
    }

    if (key && !seen.has(key)) {
      seen.add(key)
      resolvedKeys.push(key)
    }
  }

  if (resolvedKeys.length === 0) return ''

  let out = GRAPH_CONTEXT_HEADER
  let totalChars = out.length

  for (const key of resolvedKeys) {
    const sub = reader.getNeighbors(key, {
      maxHops: 2,
      maxNodes: 80,
      confidenceFloor: opts.confidenceFloor,
    })

    const rendered = renderSubgraph(sub, { maxChars: maxCharsPerAnchor })
    if (!rendered) continue

    const block = `\n### ${key}\n${rendered}`
    if (totalChars + block.length > maxCharsTotal) break

    out += block
    totalChars += block.length
  }

  if (out === GRAPH_CONTEXT_HEADER) return ''
  return out
}
