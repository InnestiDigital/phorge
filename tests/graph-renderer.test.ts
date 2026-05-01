import { describe, it, expect } from 'vitest'
import { renderSubgraph, type RenderBudget } from '../src/graphs/graph-renderer'
import type { Subgraph } from '../src/graphs/graph-reader'
import type { GraphNode, GraphEdge } from '../src/graphs/schema'

function node(key: string, kind: string): GraphNode {
  return { key, kind: kind as any, name: key.split(':').pop()!.split('\\').pop()! }
}

function edge(from: string, to: string, kind: string, confidence: 'exact' | 'inferred' = 'exact', source: 'parser' | 'laravel_scanner' = 'parser'): GraphEdge {
  return { from, to, kind: kind as any, confidence, source }
}

const centerKey = 'method:App\\Steps\\AuthorizePayment::handle'

const sampleSubgraph: Subgraph = {
  center: [centerKey],
  nodes: [
    node(centerKey, 'method'),
    node('class:App\\Steps\\AuthorizePayment', 'class'),
    node('method:App\\Gateway::authorize', 'method'),
    node('route:POST:/checkout', 'route'),
    node('class:App\\Requests\\CheckoutRequest', 'class'),
  ],
  edges: [
    edge('class:App\\Steps\\AuthorizePayment', centerKey, 'contains_method'),
    edge(centerKey, 'method:App\\Gateway::authorize', 'calls'),
    edge(centerKey, 'class:App\\Requests\\CheckoutRequest', 'controller_uses_request', 'exact', 'laravel_scanner'),
    edge('route:POST:/checkout', centerKey, 'route_to_controller', 'exact', 'laravel_scanner'),
  ],
  truncated: false,
}

describe('renderSubgraph — basic output', () => {
  it('renders header with center key', () => {
    const out = renderSubgraph(sampleSubgraph)
    expect(out).toContain('## Graph Context')
    expect(out).toContain(centerKey)
  })

  it('renders node count and edge count in header', () => {
    const out = renderSubgraph(sampleSubgraph)
    expect(out).toContain('5 nodes')
    expect(out).toContain('4 edges')
  })

  it('renders node blocks with [key] prefix', () => {
    const out = renderSubgraph(sampleSubgraph)
    expect(out).toContain(`[${centerKey}]`)
    expect(out).toContain('[class:App\\Steps\\AuthorizePayment]')
  })

  it('renders outgoing edges with kind: target [confidence, source]', () => {
    const out = renderSubgraph(sampleSubgraph)
    expect(out).toContain('calls: method:App\\Gateway::authorize [exact, parser]')
  })

  it('renders incoming edges with <- prefix', () => {
    const out = renderSubgraph(sampleSubgraph)
    expect(out).toContain('<-route_to_controller: route:POST:/checkout [exact, laravel_scanner]')
  })
})

describe('renderSubgraph — center renders first', () => {
  it('center node appears before other nodes', () => {
    const out = renderSubgraph(sampleSubgraph)
    const lines = out.split('\n')
    const centerLineIdx = lines.findIndex(l => l.startsWith(`[${centerKey}]`))
    const otherNodeIdx = lines.findIndex(l => l.startsWith('[class:App\\Steps\\AuthorizePayment]'))
    expect(centerLineIdx).toBeLessThan(otherNodeIdx)
  })
})

describe('renderSubgraph — outgoing before incoming', () => {
  it('outgoing edges appear before incoming for center node', () => {
    const out = renderSubgraph(sampleSubgraph)
    const lines = out.split('\n')
    const centerStart = lines.findIndex(l => l.startsWith(`[${centerKey}]`))
    const outgoingIdx = lines.findIndex((l, i) => i > centerStart && l.includes('calls:'))
    const incomingIdx = lines.findIndex((l, i) => i > centerStart && l.includes('<-'))
    if (outgoingIdx >= 0 && incomingIdx >= 0) {
      expect(outgoingIdx).toBeLessThan(incomingIdx)
    }
  })
})

describe('renderSubgraph — char budget', () => {
  it('truncates when over maxChars', () => {
    const out = renderSubgraph(sampleSubgraph, { maxChars: 200 })
    expect(out.length).toBeLessThanOrEqual(200)
  })

  it('shows truncation footer when over budget', () => {
    const manyNodes: GraphNode[] = []
    const manyEdges: GraphEdge[] = []
    for (let i = 0; i < 20; i++) {
      manyNodes.push(node(`class:App\\Namespace\\VeryLongClassName${i}`, 'class'))
      manyEdges.push(edge(centerKey, `class:App\\Namespace\\VeryLongClassName${i}`, 'calls'))
    }
    const sub: Subgraph = {
      center: [centerKey],
      nodes: [node(centerKey, 'method'), ...manyNodes],
      edges: manyEdges,
      truncated: true,
    }
    const out = renderSubgraph(sub, { maxChars: 500 })
    expect(out).toContain('elided')
  })
})

describe('renderSubgraph — empty subgraph', () => {
  it('returns empty string for subgraph with no nodes', () => {
    const empty: Subgraph = { center: ['class:App\\Missing'], nodes: [], edges: [], truncated: false }
    expect(renderSubgraph(empty)).toBe('')
  })
})

describe('renderSubgraph — determinism', () => {
  it('produces identical output on repeated calls', () => {
    const a = renderSubgraph(sampleSubgraph)
    const b = renderSubgraph(sampleSubgraph)
    expect(a).toBe(b)
  })
})
