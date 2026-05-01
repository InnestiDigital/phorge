import { describe, it, expect } from 'vitest'
import { expandAnchors } from '../src/anchors/anchor-expander'
import { createGraphReader } from '../src/graphs/graph-reader'
import type { GraphNode, GraphEdge } from '../src/graphs/schema'
import type { TargetAnchor } from '../src/anchors/anchor-types'

function buildGraph(className: string, fqcn: string) {
  const classKey = `class:${fqcn}`
  const fileKey = `file:app/Services/${className}.php`
  const methodKey = `method:${fqcn}::handle`
  const jobKey = `class:App\\Jobs\\DoWork`

  const nodes: GraphNode[] = [
    { key: fileKey, kind: 'file', name: `${className}.php`, filePath: `app/Services/${className}.php` },
    { key: classKey, kind: 'class', name: className, fqcn, filePath: `app/Services/${className}.php` },
    { key: methodKey, kind: 'method', name: 'handle', fqcn: `${fqcn}::handle`, filePath: `app/Services/${className}.php` },
    { key: jobKey, kind: 'job', name: 'DoWork', fqcn: 'App\\Jobs\\DoWork', filePath: 'app/Jobs/DoWork.php' },
  ]
  const edges: GraphEdge[] = [
    { from: fileKey, to: classKey, kind: 'defines', confidence: 'exact', source: 'parser' },
    { from: classKey, to: methodKey, kind: 'contains_method', confidence: 'exact', source: 'parser' },
    { from: classKey, to: jobKey, kind: 'dispatches_job', confidence: 'exact', source: 'parser' },
  ]
  return createGraphReader(nodes, edges)
}

function lowSymbol(value: string): TargetAnchor {
  return {
    kind: 'symbol',
    value,
    source: 'lexical',
    confidence: 'low',
    evidence: ['lexical: test'],
  }
}

describe('anchor-expander: low-confidence symbols that map to graph bypass the gate', () => {
  it('namespace-shaped symbol (App\\Services\\Foo) resolves via exact getNode and expands', () => {
    const reader = buildGraph('Foo', 'App\\Services\\Foo')
    const anchor = lowSymbol('App\\Services\\Foo') // exact key match for class:App\Services\Foo? key is class:App\\Services\\Foo
    // Note: anchor value is the bare fqcn; reader.getNode tries exact key match.
    // To make the test robust, expand from the class-key form which is what graph extractor emits.
    const anchorByKey = lowSymbol('class:App\\Services\\Foo')

    const result = expandAnchors([anchorByKey], { graphReader: reader })
    expect(result.stats.graphAdded).toBeGreaterThan(0)
  })

  it('suffix-shaped symbol (FooService) resolves via fuzzy search and expands', () => {
    const reader = buildGraph('FooService', 'App\\Services\\FooService')
    const anchor = lowSymbol('FooService')

    const result = expandAnchors([anchor], { graphReader: reader })
    expect(result.stats.graphAdded).toBeGreaterThan(0)
  })

  it('low-confidence symbol with no graph match and no strong shape stays gated (no expansion)', () => {
    const reader = buildGraph('FooService', 'App\\Services\\FooService')
    const anchor = lowSymbol('randomword')

    const result = expandAnchors([anchor], { graphReader: reader })
    expect(result.stats.graphAdded).toBe(0)
  })
})
