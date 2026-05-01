import { describe, it, expect } from 'vitest'
import { createGraphReader, type GraphReader } from '../src/graphs/graph-reader'
import type { GraphNode, GraphEdge } from '../src/graphs/schema'

function node(key: string, kind: string, name?: string): GraphNode {
  return { key, kind: kind as any, name: name ?? key.split(':').pop()!.split('\\').pop()! }
}

function edge(from: string, to: string, kind: string, confidence: 'exact' | 'inferred' = 'exact'): GraphEdge {
  return { from, to, kind: kind as any, confidence, source: 'parser' }
}

function laravelEdge(from: string, to: string, kind: string): GraphEdge {
  return { from, to, kind: kind as any, confidence: 'exact', source: 'laravel_scanner' }
}

function buildReader(nodes: GraphNode[], edges: GraphEdge[]): GraphReader {
  return createGraphReader(nodes, edges)
}

// Sample graph mimicking a small checkout slice
const sampleNodes: GraphNode[] = [
  node('file:src/AuthorizePayment.php', 'file'),
  node('class:App\\Steps\\AuthorizePayment', 'class'),
  node('interface:App\\Steps\\StepInterface', 'interface'),
  node('method:App\\Steps\\AuthorizePayment::handle', 'method'),
  node('method:App\\Gateway::authorize', 'method'),
  node('class:App\\Gateway', 'class'),
  node('route:POST:/checkout', 'route'),
  node('class:App\\Requests\\CheckoutRequest', 'class'),
  node('job:App\\Jobs\\ProcessOrder', 'job'),
  node('event:App\\Events\\OrderCreated', 'event'),
  node('listener:App\\Listeners\\SendConfirmation', 'listener'),
]

const sampleEdges: GraphEdge[] = [
  edge('file:src/AuthorizePayment.php', 'class:App\\Steps\\AuthorizePayment', 'defines'),
  edge('class:App\\Steps\\AuthorizePayment', 'interface:App\\Steps\\StepInterface', 'implements'),
  edge('class:App\\Steps\\AuthorizePayment', 'method:App\\Steps\\AuthorizePayment::handle', 'contains_method'),
  edge('method:App\\Steps\\AuthorizePayment::handle', 'method:App\\Gateway::authorize', 'calls'),
  edge('class:App\\Gateway', 'method:App\\Gateway::authorize', 'contains_method'),
  laravelEdge('route:POST:/checkout', 'method:App\\Steps\\AuthorizePayment::handle', 'route_to_controller'),
  laravelEdge('method:App\\Steps\\AuthorizePayment::handle', 'class:App\\Requests\\CheckoutRequest', 'controller_uses_request'),
  laravelEdge('method:App\\Steps\\AuthorizePayment::handle', 'job:App\\Jobs\\ProcessOrder', 'controller_dispatches_job'),
  laravelEdge('method:App\\Steps\\AuthorizePayment::handle', 'event:App\\Events\\OrderCreated', 'emits_event'),
  laravelEdge('listener:App\\Listeners\\SendConfirmation', 'event:App\\Events\\OrderCreated', 'listens_to_event'),
]

describe('GraphReader — getNode', () => {
  it('returns node by exact key', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const n = r.getNode('class:App\\Steps\\AuthorizePayment')
    expect(n).toBeDefined()
    expect(n!.kind).toBe('class')
  })

  it('returns undefined for unknown key', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    expect(r.getNode('class:App\\Missing')).toBeUndefined()
  })
})

describe('GraphReader — search', () => {
  it('finds nodes by substring match', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const results = r.search('AuthorizePayment')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(n => n.key.includes('AuthorizePayment'))).toBe(true)
  })

  it('exact key match ranks first', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const results = r.search('method:App\\Steps\\AuthorizePayment::handle')
    expect(results[0].key).toBe('method:App\\Steps\\AuthorizePayment::handle')
  })

  it('filters by kinds', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const results = r.search('App', { kinds: ['class'] })
    for (const n of results) expect(n.kind).toBe('class')
  })

  it('respects limit', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const results = r.search('App', { limit: 2 })
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('returns empty for no match', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    expect(r.search('ZzzNonExistent')).toHaveLength(0)
  })
})

describe('GraphReader — getNeighbors 1-hop', () => {
  it('returns direct neighbors', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const sub = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 1 })
    expect(sub.center).toEqual(['method:App\\Steps\\AuthorizePayment::handle'])
    expect(sub.nodes.length).toBeGreaterThan(1)
    // Should include: the method itself, Gateway::authorize (calls), CheckoutRequest (uses_request),
    // ProcessOrder (dispatches_job), OrderCreated (emits_event), route (incoming), class (incoming)
  })

  it('includes center node', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const sub = r.getNeighbors('class:App\\Steps\\AuthorizePayment', { maxHops: 1 })
    expect(sub.nodes.some(n => n.key === 'class:App\\Steps\\AuthorizePayment')).toBe(true)
  })
})

describe('GraphReader — getNeighbors 2-hop', () => {
  it('reaches nodes 2 hops away', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const sub = r.getNeighbors('class:App\\Steps\\AuthorizePayment', { maxHops: 2 })
    // 2 hops from class: file (defines), interface (implements), handle method (contains_method)
    // then from handle: gateway, request, job, event, route
    expect(sub.nodes.some(n => n.key === 'method:App\\Gateway::authorize')).toBe(true)
    expect(sub.nodes.some(n => n.key === 'route:POST:/checkout')).toBe(true)
  })

  it('reaches listener via event at 2 hops from handle', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const sub = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 2 })
    expect(sub.nodes.some(n => n.key === 'listener:App\\Listeners\\SendConfirmation')).toBe(true)
  })
})

describe('GraphReader — center nodes never pruned', () => {
  it('center node survives even with maxNodes=1', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const sub = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 1, maxNodes: 1 })
    expect(sub.nodes.some(n => n.key === 'method:App\\Steps\\AuthorizePayment::handle')).toBe(true)
    expect(sub.truncated).toBe(true)
  })
})

describe('GraphReader — budget enforcement', () => {
  it('truncates nodes when over maxNodes', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const sub = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 2, maxNodes: 4 })
    expect(sub.nodes.length).toBeLessThanOrEqual(4)
    expect(sub.truncated).toBe(true)
  })

  it('truncates edges when over maxEdges', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const sub = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 2, maxEdges: 3 })
    expect(sub.edges.length).toBeLessThanOrEqual(3)
    expect(sub.truncated).toBe(true)
  })
})

describe('GraphReader — confidenceFloor', () => {
  const mixedEdges = [
    ...sampleEdges,
    { from: 'method:App\\Steps\\AuthorizePayment::handle', to: 'class:App\\SomeInferred', kind: 'calls' as any, confidence: 'inferred' as const, source: 'parser' as const },
  ]
  const mixedNodes = [
    ...sampleNodes,
    node('class:App\\SomeInferred', 'class'),
  ]

  it('includes inferred edges by default', () => {
    const r = buildReader(mixedNodes, mixedEdges)
    const sub = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 1 })
    expect(sub.nodes.some(n => n.key === 'class:App\\SomeInferred')).toBe(true)
  })

  it('excludes inferred edges when confidenceFloor=exact', () => {
    const r = buildReader(mixedNodes, mixedEdges)
    const sub = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 1, confidenceFloor: 'exact' })
    expect(sub.nodes.some(n => n.key === 'class:App\\SomeInferred')).toBe(false)
  })
})

describe('GraphReader — determinism', () => {
  it('produces identical subgraphs on repeated calls', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const a = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 2 })
    const b = r.getNeighbors('method:App\\Steps\\AuthorizePayment::handle', { maxHops: 2 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('GraphReader — empty/missing center', () => {
  it('returns empty subgraph for unknown key', () => {
    const r = buildReader(sampleNodes, sampleEdges)
    const sub = r.getNeighbors('class:App\\NonExistent', { maxHops: 1 })
    expect(sub.center).toEqual(['class:App\\NonExistent'])
    expect(sub.nodes).toHaveLength(0)
    expect(sub.edges).toHaveLength(0)
    expect(sub.truncated).toBe(false)
  })
})
