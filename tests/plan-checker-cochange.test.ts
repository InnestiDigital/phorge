import { describe, it, expect } from 'vitest'
import type {
  PlanValidationContext,
  ParsedPlan,
  PlannedFileRef,
  PlanValidationDeps,
  PlanValidatorOpts,
} from '../src/checkers/plan-validator-types'
import { normalizePath } from '../src/checkers/plan-validator-types'
import { cochangeChecker } from '../src/checkers/plan-checker-cochange'
import type { CoChangeEntry } from '../src/commit-mining/schema'
import type { VolatilityEntry } from '../src/commit-mining/schema'
import type { RevertPathStat } from '../src/commit-mining/schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  plannedPaths: string[],
  cochangeEntries: CoChangeEntry[],
  overrides?: {
    volatilityEntries?: VolatilityEntry[]
    revertStats?: RevertPathStat[]
  },
): PlanValidationContext {
  const fileRefs: PlannedFileRef[] = plannedPaths.map((p) => ({
    path: p,
    normalized: normalizePath(p),
  }))

  const parsed: ParsedPlan = {
    files: fileRefs,
    symbols: [],
    stats: {
      missingStructuredPaths: 0,
      unresolvedExtractedPaths: 0,
      ambiguousExtractedSymbols: 0,
      finalPlannedFileRefs: fileRefs.length,
      finalPlannedSymbolRefs: 0,
    },
  }

  const deps: PlanValidationDeps = {
    repoResolver: {
      fileExists: () => false,
      findFileForClass: () => null,
      findMethodKey: () => null,
    },
    graphReader: null,
    cochangeEntries,
    volatilityEntries: overrides?.volatilityEntries ?? [],
    revertStats: overrides?.revertStats ?? [],
    rules: [],
  }

  const opts: PlanValidatorOpts = {}

  return { parsed, deps, opts }
}

function makeVolatilityEntry(path: string, riskScore: number): VolatilityEntry {
  return {
    path,
    commitCount: 20,
    lineDeltaAdded: 500,
    lineDeltaDeleted: 200,
    firstTouchedAt: '2024-01-01T00:00:00Z',
    lastTouchedAt: '2024-06-01T00:00:00Z',
    bugFixCommitCount: 5,
    bugFixDensity: 0.25,
    topAuthors: [],
    laravelVersionSpan: ['10'],
    riskScore,
    riskBreakdown: {
      churnComponent: 0.5,
      bugDensityComponent: 0.5,
      ownershipFragmentationComponent: 0.5,
      recencyComponent: 0.5,
    },
  }
}

function makeRevertStat(path: string, revertDensity: number): RevertPathStat {
  return {
    path,
    commitCount: 20,
    revertCount: Math.round(revertDensity * 20),
    revertDensity,
    medianDaysToRevert: 3,
    chainsInvolvingPath: 1,
    lastRevertedAt: '2024-06-01T00:00:00Z',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cochangeChecker', () => {
  it('has correct id and strength', () => {
    expect(cochangeChecker.id).toBe('cochange')
    expect(cochangeChecker.strength).toBe(4)
  })

  it('emits issue for missing neighbor above coupling threshold', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 10, coupling: 0.7 },
          ],
        },
      ],
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].kind).toBe('co_change_gap')
    expect(result.issues[0].issueKey).toBe('co_change_gap:cochange:src/Shop/OrderItem.php')
    expect(result.issues[0].message).toContain('src/Shop/OrderItem.php')
    expect(result.issues[0].message).toContain('not in the plan')
    expect(result.issues[0].evidence).toHaveLength(1)
    expect(result.issues[0].evidence[0]).toContain('coupled 0.70')
    expect(result.issues[0].checkerId).toBe('cochange')
  })

  it('emits no issue when neighbor is already in plan', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php', 'src/Shop/OrderItem.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 10, coupling: 0.7 },
          ],
        },
      ],
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })

  it('assigns info severity for coupling 0.5-0.65', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 5, coupling: 0.55 },
          ],
        },
      ],
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('info')
    expect(result.issues[0].confidence).toBeCloseTo(0.4, 1) // low
  })

  it('assigns warning severity for coupling >= 0.65', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 5, coupling: 0.65 },
          ],
        },
      ],
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('warning')
    expect(result.issues[0].confidence).toBeCloseTo(0.6, 1) // medium
  })

  it('escalates to critical for coupling >= 0.8 with high volatility', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 10, coupling: 0.85 },
          ],
        },
      ],
      {
        volatilityEntries: [makeVolatilityEntry('src/Shop/OrderItem.php', 0.75)],
      },
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('critical')
    expect(result.issues[0].confidence).toBeCloseTo(0.85, 1) // high
  })

  it('escalates to critical for coupling >= 0.8 with high revert density', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 10, coupling: 0.85 },
          ],
        },
      ],
      {
        revertStats: [makeRevertStat('src/Shop/OrderItem.php', 0.15)],
      },
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('critical')
    expect(result.issues[0].confidence).toBeCloseTo(0.85, 1)
  })

  it('skips with reason when cochangeEntries is empty (null equivalent)', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], [])
    // Simulate null by setting cochangeEntries to undefined-like empty
    // The spec says null coChangeByPath -> skip. We treat empty array as equivalent.
    // Actually, let's test with the array being present but having entries for the check.
    // The spec says "Null coChangeByPath -> skip". We'll set it to null via cast.
    ;(ctx.deps as any).cochangeEntries = null

    const result = await cochangeChecker.check(ctx)
    expect(result.skipped).toBeDefined()
    expect(result.skipped!.reason).toBe('missing_dep')
    expect(result.skipped!.missing).toContain('coChangeByPath')
    expect(result.issues).toHaveLength(0)
  })

  it('deduplicates when two planned files suggest same missing neighbor', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php', 'src/Shop/Payment.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 5, coupling: 0.6 },
          ],
        },
        {
          path: 'src/Shop/Payment.php',
          commitCount: 15,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 8, coupling: 0.75 },
          ],
        },
      ],
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    // Highest coupling determines severity: 0.75 -> warning
    expect(result.issues[0].severity).toBe('warning')
    // Evidence aggregated from both planned files
    expect(result.issues[0].evidence).toHaveLength(2)
    // Sorted alphabetically by evidence string
    expect(result.issues[0].evidence[0]).toContain('src/Shop/Order.php')
    expect(result.issues[0].evidence[1]).toContain('src/Shop/Payment.php')
  })

  it('filters neighbors with < 3 joint commits', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 2, coupling: 0.8 },
          ],
        },
      ],
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })

  it('downgrades high coupling to info when joint commits < 5', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'src/Shop/OrderItem.php', jointCommits: 3, coupling: 0.75 },
          ],
        },
      ],
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('info')
  })

  it('filters noise path neighbors', async () => {
    const ctx = makeCtx(
      ['src/Shop/Order.php'],
      [
        {
          path: 'src/Shop/Order.php',
          commitCount: 20,
          neighbors: [
            { path: 'database/migrations/2024_01_01_create_orders.php', jointCommits: 10, coupling: 0.8 },
          ],
        },
      ],
    )

    const result = await cochangeChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })
})
