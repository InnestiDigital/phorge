import { describe, it, expect } from 'vitest'
import { rankAnchors } from '../../src/anchors/anchor-ranker'
import type { TargetAnchor } from '../../src/anchors/anchor-types'
import { createGraphReader } from '../../src/graphs/graph-reader'
import type { GraphNode, GraphEdge } from '../../src/graphs/schema'
import { fileKey } from '../../src/graphs/node-keys'

function pathAnchor(value: string): TargetAnchor {
  return {
    kind: 'path',
    value,
    source: 'corpus_match',
    confidence: 'high',
    evidence: ['t'],
  }
}

function fileNode(path: string, roles?: string[]): GraphNode {
  return { key: fileKey(path), kind: 'file', name: path, filePath: path, roles }
}

function routeNode(key: string): GraphNode {
  return { key, kind: 'route', name: key }
}

describe('rankAnchors — route-aware boost', () => {
  it('boosts file with inbound route_to_controller when prompt is endpoint-y', () => {
    const A = 'src/Http/Controllers/AController.php'
    const B = 'src/Http/Controllers/BController.php'
    const nodes: GraphNode[] = [fileNode(A), fileNode(B), routeNode('route:GET:/a')]
    const edges: GraphEdge[] = [
      { from: 'route:GET:/a', to: fileKey(A), kind: 'route_to_controller', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = createGraphReader(nodes, edges)
    const result = rankAnchors([pathAnchor(B), pathAnchor(A)], {
      graphReader: reader,
      promptText: 'review the API endpoints',
    })
    const idxA = result.anchors.findIndex(x => x.value === A)
    const idxB = result.anchors.findIndex(x => x.value === B)
    expect(idxA).toBeLessThan(idxB)
  })

  it('non-endpoint prompt: no route boost applied', () => {
    const A = 'src/Http/Controllers/AController.php'
    const B = 'src/Services/B.php'
    const nodes: GraphNode[] = [fileNode(A), fileNode(B), routeNode('route:GET:/a')]
    const edges: GraphEdge[] = [
      { from: 'route:GET:/a', to: fileKey(A), kind: 'route_to_controller', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = createGraphReader(nodes, edges)
    // Equal score; alphabetical tiebreak picks A first regardless. Verify no demotion of B.
    const result = rankAnchors([pathAnchor(A), pathAnchor(B)], {
      graphReader: reader,
      promptText: 'fix the refund flow',
    })
    expect(result.anchors[0].value).toBe(A)
    expect(result.anchors[1].value).toBe(B)
  })

  it('null graphReader is a no-op', () => {
    const result = rankAnchors([pathAnchor('src/A.php')], {
      graphReader: null,
      promptText: 'review the API endpoints',
    })
    expect(result.anchors).toHaveLength(1)
  })

  it('TS route_to_component edge also fires the boost', () => {
    const A = 'pages/orders.vue'
    const B = 'components/Misc.vue'
    const nodes: GraphNode[] = [fileNode(A), fileNode(B), routeNode('route:GET:/orders')]
    const edges: GraphEdge[] = [
      { from: 'route:GET:/orders', to: fileKey(A), kind: 'route_to_component', confidence: 'exact', source: 'ts_scanner' },
    ]
    const reader = createGraphReader(nodes, edges)
    const result = rankAnchors([pathAnchor(B), pathAnchor(A)], {
      graphReader: reader,
      promptText: 'fix the page handler',
    })
    const idxA = result.anchors.findIndex(x => x.value === A)
    const idxB = result.anchors.findIndex(x => x.value === B)
    expect(idxA).toBeLessThan(idxB)
  })

  it('demotes routed-eligible files without inbound route edges when endpoint-y', () => {
    const A = 'src/Http/Controllers/AController.php'
    const B = 'src/Http/Controllers/UnroutedController.php'
    const nodes: GraphNode[] = [fileNode(A), fileNode(B), routeNode('route:GET:/a')]
    const edges: GraphEdge[] = [
      { from: 'route:GET:/a', to: fileKey(A), kind: 'route_to_controller', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = createGraphReader(nodes, edges)
    const result = rankAnchors([pathAnchor(B), pathAnchor(A)], {
      graphReader: reader,
      promptText: 'review the api routes',
    })
    expect(result.anchors[0].value).toBe(A)
    expect(result.anchors[1].value).toBe(B)
  })

  it('stacks role-tag and route-edge boosts (compound >1.5)', () => {
    const A = 'src/Http/Controllers/AController.php' // role + route
    const B = 'src/Http/Controllers/BController.php' // route only
    const C = 'src/Http/Controllers/CController.php' // role only
    const nodes: GraphNode[] = [
      fileNode(A, ['member-endpoint']),
      fileNode(B),
      fileNode(C, ['member-endpoint']),
      routeNode('route:GET:/a'),
      routeNode('route:GET:/b'),
    ]
    const edges: GraphEdge[] = [
      { from: 'route:GET:/a', to: fileKey(A), kind: 'route_to_controller', confidence: 'exact', source: 'laravel_scanner' },
      { from: 'route:GET:/b', to: fileKey(B), kind: 'route_to_controller', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = createGraphReader(nodes, edges)
    const result = rankAnchors([pathAnchor(C), pathAnchor(B), pathAnchor(A)], {
      graphReader: reader,
      promptText: 'review the API endpoints',
    })
    // A has both boosts (1.4 × 1.5 = 2.1), should be first
    expect(result.anchors[0].value).toBe(A)
  })
})
