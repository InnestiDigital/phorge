import { describe, it, expect } from 'vitest'
import type {
  PlanValidationContext,
  ParsedPlan,
  PlannedFileRef,
  PlannedSymbolRef,
  PlanValidationDeps,
  PlanValidatorOpts,
} from '../src/checkers/plan-validator-types'
import { normalizePath } from '../src/checkers/plan-validator-types'
import { structuralGapChecker } from '../src/checkers/plan-checker-structural-gap'
import type { GraphNode, GraphEdge } from '../src/graphs/schema'
import type { GraphReader } from '../src/graphs/graph-reader'
import type { Subgraph } from '../src/graphs/graph-reader'

// ---------------------------------------------------------------------------
// Mock GraphReader
// ---------------------------------------------------------------------------

function makeMockGraphReader(nodes: GraphNode[], edges: GraphEdge[]): GraphReader {
  const nodeMap = new Map(nodes.map(n => [n.key, n]))
  return {
    getNode: (key) => nodeMap.get(key),
    getNeighbors: (key, opts) => {
      const center = nodeMap.get(key)
      if (!center) return { center: [], nodes: [], edges: [], truncated: false }
      const edgeKinds = new Set(opts?.edgeKinds ?? [])
      const relevantEdges = edges.filter(e =>
        (e.from === key || e.to === key) &&
        (edgeKinds.size === 0 || edgeKinds.has(e.kind))
      )
      const neighborKeys = new Set(relevantEdges.map(e => e.from === key ? e.to : e.from))
      const neighborNodes = [...neighborKeys].map(k => nodeMap.get(k)).filter(Boolean) as GraphNode[]
      return { center: [key], nodes: neighborNodes, edges: relevantEdges, truncated: false }
    },
    search: (query) => nodes.filter(n => n.filePath === query || n.key.includes(query)),
  }
}

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const nodes: GraphNode[] = [
  { key: 'file:src/A.php', kind: 'file', name: 'A.php', filePath: 'src/A.php' },
  { key: 'class:App\\A', kind: 'class', name: 'A', filePath: 'src/A.php' },
  { key: 'class:App\\B', kind: 'class', name: 'B', filePath: 'src/B.php' },
  { key: 'class:App\\C', kind: 'class', name: 'C', filePath: 'src/C.php' },
  { key: 'event:SomeEvent', kind: 'event', name: 'SomeEvent' }, // no filePath
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  plannedPaths: string[],
  plannedSymbols: PlannedSymbolRef[],
  graphReader: GraphReader | null,
): PlanValidationContext {
  const fileRefs: PlannedFileRef[] = plannedPaths.map((p) => ({
    path: p,
    normalized: normalizePath(p),
  }))

  const parsed: ParsedPlan = {
    files: fileRefs,
    symbols: plannedSymbols,
    stats: {
      missingStructuredPaths: 0,
      unresolvedExtractedPaths: 0,
      ambiguousExtractedSymbols: 0,
      finalPlannedFileRefs: fileRefs.length,
      finalPlannedSymbolRefs: plannedSymbols.length,
    },
  }

  const deps: PlanValidationDeps = {
    repoResolver: {
      fileExists: () => false,
      findFileForClass: () => null,
      findMethodKey: () => null,
    },
    graphReader,
    cochangeEntries: [],
    volatilityEntries: [],
    revertStats: [],
    rules: [],
  }

  const opts: PlanValidatorOpts = {}

  return { parsed, deps, opts }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('structuralGapChecker', () => {
  it('has correct id and strength', () => {
    expect(structuralGapChecker.id).toBe('structural-gap')
    expect(structuralGapChecker.strength).toBe(1)
  })

  it('emits warning for side-effect neighbor missing from plan', async () => {
    const edges: GraphEdge[] = [
      { from: 'class:App\\A', to: 'class:App\\B', kind: 'emits_event', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = makeMockGraphReader(nodes, edges)
    const ctx = makeCtx(['src/A.php'], [], reader)

    const result = await structuralGapChecker.check(ctx)
    expect(result.issues.length).toBeGreaterThanOrEqual(1)

    const bIssue = result.issues.find(i => i.issueKey.includes('src/B.php'))
    expect(bIssue).toBeDefined()
    expect(bIssue!.severity).toBe('warning')
    expect(bIssue!.confidence).toBeCloseTo(0.6, 1)
    expect(bIssue!.kind).toBe('structural_gap')
    expect(bIssue!.checkerId).toBe('structural-gap')
  })

  it('emits no issue when neighbor is already in plan', async () => {
    const edges: GraphEdge[] = [
      { from: 'class:App\\A', to: 'class:App\\B', kind: 'emits_event', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = makeMockGraphReader(nodes, edges)
    const ctx = makeCtx(['src/A.php', 'src/B.php'], [], reader)

    const result = await structuralGapChecker.check(ctx)
    const bIssue = result.issues.find(i => i.issueKey.includes('src/B.php'))
    expect(bIssue).toBeUndefined()
  })

  it('emits info for implements/extends neighbors', async () => {
    const edges: GraphEdge[] = [
      { from: 'class:App\\A', to: 'class:App\\B', kind: 'implements', confidence: 'exact', source: 'parser' },
    ]
    const reader = makeMockGraphReader(nodes, edges)
    const ctx = makeCtx(['src/A.php'], [], reader)

    const result = await structuralGapChecker.check(ctx)
    const bIssue = result.issues.find(i => i.issueKey.includes('src/B.php'))
    expect(bIssue).toBeDefined()
    expect(bIssue!.severity).toBe('info')
    expect(bIssue!.confidence).toBeCloseTo(0.4, 1)
  })

  it('skips with missing_dep when graphReader is null', async () => {
    const ctx = makeCtx(['src/A.php'], [], null)

    const result = await structuralGapChecker.check(ctx)
    expect(result.skipped).toBeDefined()
    expect(result.skipped!.reason).toBe('missing_dep')
    expect(result.skipped!.missing).toContain('graphReader')
    expect(result.issues).toHaveLength(0)
  })

  it('ignores edges not in the allowlist (e.g. calls)', async () => {
    const edges: GraphEdge[] = [
      { from: 'class:App\\A', to: 'class:App\\B', kind: 'calls', confidence: 'exact', source: 'parser' },
    ]
    const reader = makeMockGraphReader(nodes, edges)
    const ctx = makeCtx(['src/A.php'], [], reader)

    const result = await structuralGapChecker.check(ctx)
    // calls is not in the allowlist nor implements/extends, so no issues
    expect(result.issues).toHaveLength(0)
  })

  it('preserves non-file neighbors as relatedSymbols', async () => {
    const edges: GraphEdge[] = [
      { from: 'class:App\\A', to: 'event:SomeEvent', kind: 'emits_event', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = makeMockGraphReader(nodes, edges)
    const ctx = makeCtx(['src/A.php'], [], reader)

    const result = await structuralGapChecker.check(ctx)
    const eventIssue = result.issues.find(i => i.issueKey.includes('node:event:SomeEvent'))
    expect(eventIssue).toBeDefined()
    expect(eventIssue!.relatedSymbols).toContain('event:SomeEvent')
    expect(eventIssue!.severity).toBe('warning')
  })

  it('deduplicates multiple edges to same missing neighbor into one issue', async () => {
    const edges: GraphEdge[] = [
      { from: 'class:App\\A', to: 'class:App\\B', kind: 'emits_event', confidence: 'exact', source: 'laravel_scanner' },
      { from: 'class:App\\A', to: 'class:App\\B', kind: 'dispatches_job', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = makeMockGraphReader(nodes, edges)
    const ctx = makeCtx(['src/A.php'], [], reader)

    const result = await structuralGapChecker.check(ctx)
    const bIssues = result.issues.filter(i => i.issueKey.includes('src/B.php'))
    expect(bIssues).toHaveLength(1)
    expect(bIssues[0].evidence.length).toBe(2)
  })

  it('evidence includes source node, edge kind, and neighbor key', async () => {
    const edges: GraphEdge[] = [
      { from: 'class:App\\A', to: 'class:App\\B', kind: 'emits_event', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = makeMockGraphReader(nodes, edges)
    const ctx = makeCtx(['src/A.php'], [], reader)

    const result = await structuralGapChecker.check(ctx)
    const bIssue = result.issues.find(i => i.issueKey.includes('src/B.php'))
    expect(bIssue).toBeDefined()
    expect(bIssue!.evidence.length).toBeGreaterThanOrEqual(1)
    const ev = bIssue!.evidence[0]
    expect(ev).toContain('class:App\\A')
    expect(ev).toContain('emits_event')
    expect(ev).toContain('class:App\\B')
  })

  it('filters noise filePath neighbors', async () => {
    const noiseNode: GraphNode = {
      key: 'class:App\\Migration', kind: 'class', name: 'Migration',
      filePath: 'database/migrations/2024_01_01_create_table.php',
    }
    const allNodes = [...nodes, noiseNode]
    const edges: GraphEdge[] = [
      { from: 'class:App\\A', to: 'class:App\\Migration', kind: 'observes_model', confidence: 'exact', source: 'laravel_scanner' },
    ]
    const reader = makeMockGraphReader(allNodes, edges)
    const ctx = makeCtx(['src/A.php'], [], reader)

    const result = await structuralGapChecker.check(ctx)
    const migrationIssue = result.issues.find(i =>
      i.issueKey.includes('database/migrations')
    )
    expect(migrationIssue).toBeUndefined()
  })
})
