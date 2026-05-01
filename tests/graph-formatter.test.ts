import { describe, it, expect } from 'vitest'
import {
  formatGraphContextForPlanner,
  GRAPH_CONTEXT_HEADER,
  DEFAULT_GRAPH_MAX_ANCHORS,
  DEFAULT_GRAPH_MAX_CHARS_PER_ANCHOR,
  DEFAULT_GRAPH_MAX_CHARS_TOTAL,
} from '../src/formatters/graph-formatter'
import { createGraphReader } from '../src/graphs/graph-reader'
import type { GraphNode, GraphEdge } from '../src/graphs/schema'

function node(key: string, kind: string, opts?: { name?: string; fqcn?: string }): GraphNode {
  return { key, kind: kind as any, name: opts?.name ?? key.split(':').pop()!.split('\\').pop()!, fqcn: opts?.fqcn }
}

function edge(from: string, to: string, kind: string): GraphEdge {
  return { from, to, kind: kind as any, confidence: 'exact', source: 'parser' }
}

function laravelEdge(from: string, to: string, kind: string): GraphEdge {
  return { from, to, kind: kind as any, confidence: 'exact', source: 'laravel_scanner' }
}

const sampleNodes: GraphNode[] = [
  node('file:src/AuthorizePayment.php', 'file'),
  node('class:App\\Steps\\AuthorizePayment', 'class', { fqcn: 'App\\Steps\\AuthorizePayment' }),
  node('interface:App\\Steps\\StepInterface', 'interface', { fqcn: 'App\\Steps\\StepInterface' }),
  node('method:App\\Steps\\AuthorizePayment::handle', 'method', { fqcn: 'App\\Steps\\AuthorizePayment::handle' }),
  node('method:App\\Gateway::authorize', 'method'),
  node('class:App\\Gateway', 'class'),
  node('route:POST:/checkout', 'route'),
  node('class:App\\Requests\\CheckoutRequest', 'class', { fqcn: 'App\\Requests\\CheckoutRequest' }),
  node('job:App\\Jobs\\ProcessOrder', 'job'),
  node('event:App\\Events\\OrderCreated', 'event'),
  node('listener:App\\Listeners\\SendConfirmation', 'listener'),
  node('class:App\\Models\\Order', 'class', { name: 'Order', fqcn: 'App\\Models\\Order' }),
  node('observer:App\\Observers\\OrderObserver', 'observer'),
  node('policy:App\\Policies\\OrderPolicy', 'policy'),
  node('model:App\\Models\\Order', 'model', { fqcn: 'App\\Models\\Order' }),
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
  laravelEdge('observer:App\\Observers\\OrderObserver', 'model:App\\Models\\Order', 'observes_model'),
  laravelEdge('policy:App\\Policies\\OrderPolicy', 'model:App\\Models\\Order', 'authorizes_policy'),
]

function makeReader() {
  return createGraphReader(sampleNodes, sampleEdges)
}

describe('formatGraphContextForPlanner — empty cases', () => {
  it('returns empty when no targetSymbols', () => {
    const out = formatGraphContextForPlanner(makeReader(), { targetSymbols: [] })
    expect(out).toBe('')
  })

  it('returns empty when all symbols unresolvable', () => {
    const out = formatGraphContextForPlanner(makeReader(), {
      targetSymbols: ['class:App\\NonExistent', 'method:App\\Ghost::missing'],
    })
    expect(out).toBe('')
  })
})

describe('formatGraphContextForPlanner — exact key match', () => {
  it('resolves exact node key and renders slice', () => {
    const out = formatGraphContextForPlanner(makeReader(), {
      targetSymbols: ['method:App\\Steps\\AuthorizePayment::handle'],
    })
    expect(out).toContain(GRAPH_CONTEXT_HEADER)
    expect(out).toContain('method:App\\Steps\\AuthorizePayment::handle')
    expect(out).toContain('calls:')
  })
})

describe('formatGraphContextForPlanner — search fallback', () => {
  it('finds symbol via search when exact key does not match', () => {
    const out = formatGraphContextForPlanner(makeReader(), {
      targetSymbols: ['AuthorizePayment'],
    })
    expect(out).toContain(GRAPH_CONTEXT_HEADER)
    expect(out).toContain('AuthorizePayment')
  })
})

describe('formatGraphContextForPlanner — multiple anchors', () => {
  it('renders multiple anchor slices under sub-headers', () => {
    const out = formatGraphContextForPlanner(makeReader(), {
      targetSymbols: [
        'method:App\\Steps\\AuthorizePayment::handle',
        'class:App\\Models\\Order',
      ],
    })
    expect(out).toContain(GRAPH_CONTEXT_HEADER)
    expect(out).toContain('AuthorizePayment::handle')
    expect(out).toContain('App\\Models\\Order')
  })
})

describe('formatGraphContextForPlanner — maxAnchors cap', () => {
  it('caps at default maxAnchors', () => {
    const out = formatGraphContextForPlanner(makeReader(), {
      targetSymbols: [
        'method:App\\Steps\\AuthorizePayment::handle',
        'class:App\\Models\\Order',
        'class:App\\Gateway',
        'route:POST:/checkout',
        'event:App\\Events\\OrderCreated',
      ],
      maxAnchors: 2,
    })
    const anchorHeaders = (out.match(/### /g) ?? []).length
    expect(anchorHeaders).toBeLessThanOrEqual(2)
  })
})

describe('formatGraphContextForPlanner — maxCharsTotal', () => {
  it('truncates to stay under total char budget', () => {
    const out = formatGraphContextForPlanner(makeReader(), {
      targetSymbols: [
        'method:App\\Steps\\AuthorizePayment::handle',
        'class:App\\Models\\Order',
        'class:App\\Gateway',
      ],
      maxCharsTotal: 500,
    })
    expect(out.length).toBeLessThanOrEqual(500)
  })
})

describe('formatGraphContextForPlanner — determinism', () => {
  it('produces identical output on repeated calls', () => {
    const reader = makeReader()
    const opts = {
      targetSymbols: ['method:App\\Steps\\AuthorizePayment::handle', 'class:App\\Models\\Order'],
    }
    const a = formatGraphContextForPlanner(reader, opts)
    const b = formatGraphContextForPlanner(reader, opts)
    expect(a).toBe(b)
  })
})

describe('formatGraphContextForPlanner — dedup anchors', () => {
  it('does not render same anchor twice when search resolves to same key', () => {
    const out = formatGraphContextForPlanner(makeReader(), {
      targetSymbols: [
        'method:App\\Steps\\AuthorizePayment::handle',
        'AuthorizePayment::handle',
      ],
    })
    const anchorHeaders = (out.match(/### /g) ?? []).length
    expect(anchorHeaders).toBe(1)
  })
})

describe('formatGraphContextForPlanner — exports', () => {
  it('exports correct defaults', () => {
    expect(GRAPH_CONTEXT_HEADER).toBe('## Structural Context')
    expect(DEFAULT_GRAPH_MAX_ANCHORS).toBe(3)
    expect(DEFAULT_GRAPH_MAX_CHARS_PER_ANCHOR).toBe(8000)
    expect(DEFAULT_GRAPH_MAX_CHARS_TOTAL).toBe(20000)
  })
})
