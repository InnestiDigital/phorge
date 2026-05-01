import { describe, it, expect } from 'vitest'
import {
  NodeKind,
  EdgeKind,
  Confidence,
  EdgeSource,
  GraphNode,
  GraphEdge,
  RepoGraphManifest,
} from '../src/graphs/schema'

describe('NodeKind enum', () => {
  it('includes all v1 node kinds', () => {
    const kinds = NodeKind.options
    expect(kinds).toContain('file')
    expect(kinds).toContain('class')
    expect(kinds).toContain('interface')
    expect(kinds).toContain('trait')
    expect(kinds).toContain('method')
    expect(kinds).toContain('function')
    expect(kinds).toContain('route')
    expect(kinds).toContain('event')
    expect(kinds).toContain('listener')
    expect(kinds).toContain('job')
    expect(kinds).toContain('observer')
    expect(kinds).toContain('policy')
    expect(kinds).toContain('model')
    expect(kinds).toContain('service_binding')
    expect(kinds).toContain('command')
    expect(kinds).toContain('resource')
    expect(kinds).toContain('transformer')
    expect(kinds).toContain('component')
    expect(kinds).toContain('composable')
    expect(kinds).toContain('store')
    expect(kinds).toHaveLength(20)
  })
})

describe('EdgeKind enum', () => {
  it('includes all v1 core edge kinds', () => {
    const kinds = EdgeKind.options
    expect(kinds).toContain('defines')
    expect(kinds).toContain('contains_method')
    expect(kinds).toContain('extends')
    expect(kinds).toContain('implements')
    expect(kinds).toContain('uses_trait')
    expect(kinds).toContain('calls')
    expect(kinds).toContain('imports')
    expect(kinds).toContain('throws')
  })

  it('includes all v1 Laravel edge kinds', () => {
    const kinds = EdgeKind.options
    expect(kinds).toContain('route_to_controller')
    expect(kinds).toContain('controller_uses_request')
    expect(kinds).toContain('controller_returns_resource')
    expect(kinds).toContain('controller_returns_transformer')
    expect(kinds).toContain('controller_dispatches_job')
    expect(kinds).toContain('dispatches_job')
    expect(kinds).toContain('emits_event')
    expect(kinds).toContain('listens_to_event')
    expect(kinds).toContain('observes_model')
    expect(kinds).toContain('authorizes_policy')
    expect(kinds).toContain('binds_service')
    expect(kinds).toContain('binds_concrete')
    expect(kinds).toContain('resource_transforms_model')
    expect(kinds).toContain('transformer_transforms_model')
  })

  it('includes TS / Vue / Nuxt edge kinds', () => {
    const kinds = EdgeKind.options
    expect(kinds).toContain('vue_renders')
    expect(kinds).toContain('route_to_component')
    expect(kinds).toContain('component_uses_component')
    expect(kinds).toContain('component_uses_composable')
  })

  it('has exactly 26 edge kinds', () => {
    expect(EdgeKind.options).toHaveLength(26)
  })
})

describe('GraphNode schema', () => {
  it('validates a minimal file node', () => {
    const node = {
      key: 'file:src/Shop/Checkout.php',
      kind: 'file',
      name: 'Checkout.php',
      filePath: 'src/Shop/Checkout.php',
    }
    expect(GraphNode.safeParse(node).success).toBe(true)
  })

  it('validates a method node with visibility', () => {
    const node = {
      key: 'method:App\\Models\\Order::updateStatus',
      kind: 'method',
      name: 'updateStatus',
      filePath: 'src/Shop/Checkout/Models/Order.php',
      line: 42,
      fqcn: 'App\\Models\\Order::updateStatus',
      visibility: 'public',
    }
    expect(GraphNode.safeParse(node).success).toBe(true)
  })

  it('validates a node with laravelRole metadata', () => {
    const node = {
      key: 'class:App\\Http\\Controllers\\CheckoutController',
      kind: 'class',
      name: 'CheckoutController',
      laravelRole: 'controller',
    }
    expect(GraphNode.safeParse(node).success).toBe(true)
  })

  it('rejects node with empty key', () => {
    const node = { key: '', kind: 'file', name: 'x' }
    expect(GraphNode.safeParse(node).success).toBe(false)
  })
})

describe('GraphEdge schema', () => {
  it('validates a core edge', () => {
    const edge = {
      from: 'file:src/A.php',
      to: 'class:App\\A',
      kind: 'defines',
      confidence: 'exact',
      source: 'parser',
    }
    expect(GraphEdge.safeParse(edge).success).toBe(true)
  })

  it('validates a Laravel scanner edge', () => {
    const edge = {
      from: 'route:POST:/api/v1/checkout',
      to: 'method:App\\Http\\Controllers\\CheckoutController::submit',
      kind: 'route_to_controller',
      confidence: 'exact',
      source: 'laravel_scanner',
    }
    expect(GraphEdge.safeParse(edge).success).toBe(true)
  })

  it('rejects heuristic source in v1', () => {
    const edge = {
      from: 'test:tests/A.php::test_x',
      to: 'method:App\\A::x',
      kind: 'calls',
      confidence: 'inferred',
      source: 'heuristic',
    }
    expect(GraphEdge.safeParse(edge).success).toBe(false)
  })
})

describe('RepoGraphManifest schema', () => {
  it('validates a minimal manifest', () => {
    const manifest = {
      schemaVersion: 1,
      repo: 'podium.api',
      createdAt: '2026-04-23T00:00:00.000Z',
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        byNodeKind: {},
        byEdgeKind: {},
        byEdgeSource: {},
      },
      nodes: [],
      edges: [],
    }
    expect(RepoGraphManifest.safeParse(manifest).success).toBe(true)
  })

  it('validates a manifest with nodes and edges', () => {
    const manifest = {
      schemaVersion: 1,
      repo: 'podium.api',
      commitSha: 'abc123',
      createdAt: '2026-04-23T00:00:00.000Z',
      stats: {
        nodeCount: 1,
        edgeCount: 1,
        byNodeKind: { file: 1 },
        byEdgeKind: { defines: 1 },
        byEdgeSource: { parser: 1 },
      },
      nodes: [{
        key: 'file:src/A.php',
        kind: 'file',
        name: 'A.php',
      }],
      edges: [{
        from: 'file:src/A.php',
        to: 'class:App\\A',
        kind: 'defines',
        confidence: 'exact',
        source: 'parser',
      }],
    }
    expect(RepoGraphManifest.safeParse(manifest).success).toBe(true)
  })
})
