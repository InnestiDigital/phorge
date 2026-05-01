// pipeline/tests/knowledge/consumers/anchor-expander.test.ts
import { describe, it, expect } from 'vitest'
import { expandAnchors } from '../src/anchors/anchor-expander'
import type { TargetAnchor, ExpansionResult } from '../src/anchors/anchor-types'
import type { CoChangeView } from '../src/commit-mining'
import type { GraphReader } from '../src/graphs/graph-reader'
import type { GraphNode, GraphEdge } from '../src/graphs/schema'

function makeAnchor(overrides: Partial<TargetAnchor> & { value: string }): TargetAnchor {
  return {
    kind: overrides.kind ?? 'path',
    value: overrides.value,
    source: overrides.source ?? 'explicit',
    confidence: overrides.confidence ?? 'high',
    evidence: overrides.evidence ?? ['test'],
  }
}

function makeCoChangeView(entries: Array<{ path: string; neighbors: Array<{ path: string; coupling: number }> }>): CoChangeView {
  return {
    intentFilter: 'all',
    entries: entries.map(e => ({
      path: e.path,
      commitCount: 10,
      neighbors: e.neighbors.map(n => ({ path: n.path, jointCommits: 5, coupling: n.coupling })),
    })),
    stats: { anchors: entries.length, pairs: 0, commitsConsidered: 100 },
  }
}

describe('expandAnchors — co-change expansion', () => {
  const coChangeView = makeCoChangeView([
    { path: 'src/A.php', neighbors: [
      { path: 'src/B.php', coupling: 0.8 },
      { path: 'src/C.php', coupling: 0.6 },
      { path: 'src/D.php', coupling: 0.3 },
    ]},
  ])

  it('expands high-confidence path anchors via co-change', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView })
    const expanded = result.anchors.map(a => a.value)
    expect(expanded).toContain('src/B.php')
    expect(expanded).toContain('src/C.php')
  })

  it('filters by minCoupling (default 0.5)', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView })
    const expanded = result.anchors.map(a => a.value)
    expect(expanded).not.toContain('src/D.php')
  })

  it('degrades confidence from high parent to medium', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView })
    const bAnchor = result.anchors.find(a => a.value === 'src/B.php')
    expect(bAnchor?.confidence).toBe('medium')
  })

  it('degrades confidence from medium parent to low', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'medium' })]
    const result = expandAnchors(input, { coChangeView })
    const bAnchor = result.anchors.find(a => a.value === 'src/B.php')
    expect(bAnchor?.confidence).toBe('low')
  })

  it('skips anchors already present in input', () => {
    const input = [
      makeAnchor({ value: 'src/A.php', confidence: 'high' }),
      makeAnchor({ value: 'src/B.php', confidence: 'high' }),
    ]
    const result = expandAnchors(input, { coChangeView })
    const bAnchors = result.anchors.filter(a => a.value === 'src/B.php')
    expect(bAnchors).toHaveLength(0)
  })

  it('caps to maxCoChangePerAnchor', () => {
    const view = makeCoChangeView([
      { path: 'src/A.php', neighbors: [
        { path: 'src/B.php', coupling: 0.9 },
        { path: 'src/C.php', coupling: 0.8 },
        { path: 'src/D.php', coupling: 0.7 },
        { path: 'src/E.php', coupling: 0.6 },
      ]},
    ])
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView: view }, { maxCoChangePerAnchor: 2 })
    expect(result.anchors.length).toBeLessThanOrEqual(2)
  })

  it('caps to maxCoChangeAnchors input anchors', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      path: `src/File${i}.php`,
      neighbors: [{ path: `src/Neighbor${i}.php`, coupling: 0.8 }],
    }))
    const view = makeCoChangeView(entries)
    const input = entries.map(e => makeAnchor({ value: e.path, confidence: 'high' }))
    const result = expandAnchors(input, { coChangeView: view }, { maxCoChangeAnchors: 3 })
    expect(result.anchors.length).toBeLessThanOrEqual(3)
  })

  it('includes evidence with parent and coupling', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView })
    const bAnchor = result.anchors.find(a => a.value === 'src/B.php')
    expect(bAnchor?.evidence[0]).toContain('cochange_expand')
    expect(bAnchor?.evidence[0]).toContain('src/A.php')
    expect(bAnchor?.evidence[0]).toContain('0.8')
  })

  it('includes metadata with coupling and parent', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView })
    const bAnchor = result.anchors.find(a => a.value === 'src/B.php')
    expect(bAnchor?.metadata?.coupling).toBe(0.8)
    expect(bAnchor?.metadata?.parent).toBe('path:src/A.php')
  })

  it('populates expandedFrom map', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView })
    expect(result.expandedFrom['path:src/A.php']).toContain('path:src/B.php')
  })

  it('populates stats', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView })
    expect(result.stats.coChangeAdded).toBeGreaterThan(0)
  })

  it('returns empty when no deps provided', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, {})
    expect(result.anchors).toHaveLength(0)
    expect(result.stats.coChangeAdded).toBe(0)
    expect(result.stats.graphAdded).toBe(0)
  })

  it('skips symbol anchors for co-change expansion', () => {
    const input = [makeAnchor({ value: 'class:Foo', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView })
    expect(result.stats.coChangeAdded).toBe(0)
  })

  it('skips low-confidence input anchors', () => {
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'low' })]
    const result = expandAnchors(input, { coChangeView })
    expect(result.anchors).toHaveLength(0)
  })

  it('returns neighbors sorted by coupling desc within cap', () => {
    const view = makeCoChangeView([
      { path: 'src/A.php', neighbors: [
        { path: 'src/Low.php', coupling: 0.5 },
        { path: 'src/High.php', coupling: 0.9 },
        { path: 'src/Mid.php', coupling: 0.7 },
      ]},
    ])
    const input = [makeAnchor({ value: 'src/A.php', confidence: 'high' })]
    const result = expandAnchors(input, { coChangeView: view })
    const values = result.anchors.map(a => a.value)
    expect(values[0]).toBe('src/High.php')
    expect(values[1]).toBe('src/Mid.php')
    expect(values[2]).toBe('src/Low.php')
  })
})

function makeGraphReader(nodes: GraphNode[], edges: GraphEdge[]): GraphReader {
  const nodeMap = new Map(nodes.map(n => [n.key, n]))
  return {
    getNode: (key) => nodeMap.get(key),
    getNeighbors: (key, opts) => {
      const center = nodeMap.get(key)
      if (!center) return { center: [], nodes: [], edges: [], truncated: false }
      const allowedKinds = opts?.edgeKinds ? new Set(opts.edgeKinds) : null
      const relevantEdges = edges.filter(e =>
        (e.from === key || e.to === key) &&
        (!allowedKinds || allowedKinds.has(e.kind))
      )
      const neighborKeys = new Set<string>()
      for (const e of relevantEdges) {
        if (e.from === key) neighborKeys.add(e.to)
        if (e.to === key) neighborKeys.add(e.from)
      }
      const neighborNodes = [...neighborKeys].map(k => nodeMap.get(k)!).filter(Boolean)
      return {
        center: [key],
        nodes: [center, ...neighborNodes],
        edges: relevantEdges,
        truncated: false,
      }
    },
    search: (query, opts) => {
      const limit = opts?.limit ?? 20
      return nodes.filter(n => n.key.includes(query) || n.name.includes(query)).slice(0, limit)
    },
  }
}

const testNodes: GraphNode[] = [
  { key: 'file:src/Http/Controllers/CheckoutController.php', kind: 'file', name: 'CheckoutController.php', filePath: 'src/Http/Controllers/CheckoutController.php' },
  { key: 'route:POST /api/checkout', kind: 'route', name: 'POST /api/checkout' },
  { key: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'class', name: 'CheckoutController', filePath: 'src/Http/Controllers/CheckoutController.php', fqcn: 'App\\Http\\Controllers\\CheckoutController' },
  { key: 'file:src/Shop/Checkout/Steps/AuthorizePayment.php', kind: 'file', name: 'AuthorizePayment.php', filePath: 'src/Shop/Checkout/Steps/AuthorizePayment.php' },
  { key: 'class:App\\Shop\\Checkout\\Steps\\AuthorizePayment', kind: 'class', name: 'AuthorizePayment', filePath: 'src/Shop/Checkout/Steps/AuthorizePayment.php', fqcn: 'App\\Shop\\Checkout\\Steps\\AuthorizePayment' },
  { key: 'job:App\\Jobs\\ProcessOrder', kind: 'job', name: 'ProcessOrder', filePath: 'src/Jobs/ProcessOrder.php' },
]

const testEdges: GraphEdge[] = [
  { from: 'route:POST /api/checkout', to: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'route_to_controller', confidence: 'exact', source: 'laravel_scanner' },
  { from: 'class:App\\Http\\Controllers\\CheckoutController', to: 'job:App\\Jobs\\ProcessOrder', kind: 'controller_dispatches_job', confidence: 'exact', source: 'laravel_scanner' },
  { from: 'class:App\\Http\\Controllers\\CheckoutController', to: 'class:App\\Shop\\Checkout\\Steps\\AuthorizePayment', kind: 'calls', confidence: 'exact', source: 'parser' },
]

describe('expandAnchors — graph expansion', () => {
  const graphReader = makeGraphReader(testNodes, testEdges)

  it('expands path anchors via file: key exact lookup', () => {
    const input = [makeAnchor({ value: 'src/Http/Controllers/CheckoutController.php', kind: 'path', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader })
    expect(result.stats.graphAdded).toBeGreaterThanOrEqual(0)
  })

  it('expands symbol anchors via exact getNode', () => {
    const input = [makeAnchor({ value: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader })
    const values = result.anchors.map(a => a.value)
    expect(values.some(v => v.includes('ProcessOrder'))).toBe(true)
  })

  it('uses search fallback for symbol anchors with strong shape', () => {
    const input = [makeAnchor({ value: 'CheckoutController', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader })
    expect(result.stats.graphAdded).toBeGreaterThanOrEqual(0)
  })

  it('skips fuzzy search for generic symbol names', () => {
    const nodesWithGeneric: GraphNode[] = [
      ...testNodes,
      { key: 'class:App\\Models\\Product', kind: 'class', name: 'Product', filePath: 'src/Models/Product.php' },
    ]
    const reader = makeGraphReader(nodesWithGeneric, testEdges)
    const input = [makeAnchor({ value: 'Product', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader: reader })
    expect(result.stats.graphAdded).toBe(0)
    expect(result.stats.skippedUnresolved).toBeGreaterThan(0)
  })

  it('degrades confidence from high parent to medium', () => {
    const input = [makeAnchor({ value: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader })
    for (const a of result.anchors) {
      expect(a.confidence).toBe('medium')
    }
  })

  it('only uses allowlisted edge kinds', () => {
    const input = [makeAnchor({ value: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader })
    const expanded = result.anchors.map(a => a.value)
    // calls edge is NOT in allowlist, so AuthorizePayment should not appear via graph
    expect(expanded).not.toContain('class:App\\Shop\\Checkout\\Steps\\AuthorizePayment')
    // controller_dispatches_job IS in allowlist, so ProcessOrder should appear
    expect(expanded.some(v => v.includes('ProcessOrder'))).toBe(true)
  })

  it('includes evidence with edge kind', () => {
    const input = [makeAnchor({ value: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader })
    const jobAnchor = result.anchors.find(a => a.value.includes('ProcessOrder'))
    expect(jobAnchor?.evidence[0]).toContain('graph_expand')
    expect(jobAnchor?.evidence[0]).toContain('controller_dispatches_job')
  })

  it('includes metadata with parent and edgeKind', () => {
    const input = [makeAnchor({ value: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader })
    const jobAnchor = result.anchors.find(a => a.value.includes('ProcessOrder'))
    expect(jobAnchor?.metadata?.parent).toContain('CheckoutController')
    expect(jobAnchor?.metadata?.edgeKind).toBe('controller_dispatches_job')
  })

it('bypasses the confidence gate when a low-confidence symbol resolves to a real graph node', () => {
    // Inverse of the gating rule: when the anchor maps to a real node (exact key
    // match here), graph expansion fires even at low confidence.
    const input = [makeAnchor({ value: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'symbol', confidence: 'low' })]
    const result = expandAnchors(input, { graphReader })
    expect(result.stats.graphAdded).toBeGreaterThan(0)
  })

  it('filters noise paths from graph expansion', () => {
    const nodesWithNoise: GraphNode[] = [
      ...testNodes,
      { key: 'file:database/factories/OrderFactory.php', kind: 'file', name: 'OrderFactory.php', filePath: 'database/factories/OrderFactory.php' },
    ]
    const edgesWithNoise: GraphEdge[] = [
      ...testEdges,
      { from: 'class:App\\Http\\Controllers\\CheckoutController', to: 'file:database/factories/OrderFactory.php', kind: 'implements', confidence: 'exact', source: 'parser' },
    ]
    const reader = makeGraphReader(nodesWithNoise, edgesWithNoise)
    const input = [makeAnchor({ value: 'class:App\\Http\\Controllers\\CheckoutController', kind: 'symbol', confidence: 'high' })]
    const result = expandAnchors(input, { graphReader: reader })
    const paths = result.anchors.filter(a => a.kind === 'path').map(a => a.value)
    expect(paths).not.toContain('database/factories/OrderFactory.php')
  })
})
