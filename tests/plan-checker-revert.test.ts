import { describe, it, expect } from 'vitest'
import type {
  PlanValidationContext,
  ParsedPlan,
  PlannedFileRef,
  PlanValidationDeps,
  PlanValidatorOpts,
} from '../src/checkers/plan-validator-types'
import { normalizePath } from '../src/checkers/plan-validator-types'
import { revertChecker } from '../src/checkers/plan-checker-revert'
import type { VolatilityEntry } from '../src/commit-mining/schema'
import type { RevertPathStat } from '../src/commit-mining/schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVolatilityEntry(
  path: string,
  riskScore: number,
  breakdown?: Partial<{
    churnComponent: number
    bugDensityComponent: number
    ownershipFragmentationComponent: number
    recencyComponent: number
  }>,
): VolatilityEntry {
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
      churnComponent: breakdown?.churnComponent ?? 0.25,
      bugDensityComponent: breakdown?.bugDensityComponent ?? 0.25,
      ownershipFragmentationComponent: breakdown?.ownershipFragmentationComponent ?? 0.25,
      recencyComponent: breakdown?.recencyComponent ?? 0.25,
    },
  }
}

function makeRevertStat(
  path: string,
  overrides?: Partial<RevertPathStat>,
): RevertPathStat {
  return {
    path,
    commitCount: 20,
    revertCount: overrides?.revertCount ?? 3,
    revertDensity: overrides?.revertDensity ?? 0.15,
    medianDaysToRevert: overrides?.medianDaysToRevert ?? 3,
    chainsInvolvingPath: overrides?.chainsInvolvingPath ?? 1,
    lastRevertedAt: overrides?.lastRevertedAt ?? '2024-06-01T00:00:00Z',
  }
}

function makeCtx(
  plannedPaths: string[],
  overrides?: {
    volatilityEntries?: VolatilityEntry[] | null
    revertStats?: RevertPathStat[] | null
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
    cochangeEntries: [],
    volatilityEntries: (overrides?.volatilityEntries ?? []) as VolatilityEntry[],
    revertStats: (overrides?.revertStats ?? []) as RevertPathStat[],
    rules: [],
  }

  // Allow null to propagate for skip-testing
  if (overrides?.volatilityEntries === null) {
    ;(deps as any).volatilityEntries = null
  }
  if (overrides?.revertStats === null) {
    ;(deps as any).revertStats = null
  }

  const opts: PlanValidatorOpts = {}

  return { parsed, deps, opts }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('revertChecker', () => {
  it('has correct id and strength', () => {
    expect(revertChecker.id).toBe('revert')
    expect(revertChecker.strength).toBe(3)
  })

  // 1. High revert density + count >= 2 + recent -> critical, confidence high
  it('emits critical when revertDensity >= 0.15, count >= 2, and recent revert', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], {
      revertStats: [
        makeRevertStat('src/Shop/Order.php', {
          revertDensity: 0.2,
          revertCount: 3,
          lastRevertedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
        }),
      ],
      volatilityEntries: [makeVolatilityEntry('src/Shop/Order.php', 0.8)],
    })

    const result = await revertChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('critical')
    expect(result.issues[0].confidence).toBeCloseTo(0.85, 1)
    expect(result.issues[0].kind).toBe('revert_risk')
    expect(result.issues[0].checkerId).toBe('revert')
    expect(result.issues[0].issueKey).toBe('revert_risk:revert:src/Shop/Order.php')
  })

  // 2. High density but count = 1 -> not critical
  it('does not escalate to critical when revertCount < 2 despite high density', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], {
      revertStats: [
        makeRevertStat('src/Shop/Order.php', {
          revertDensity: 0.2,
          revertCount: 1,
          lastRevertedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      volatilityEntries: [makeVolatilityEntry('src/Shop/Order.php', 0.75)],
    })

    const result = await revertChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    // Should be warning from volatility riskScore >= 0.7, not critical
    expect(result.issues[0].severity).toBe('warning')
  })

  // 3. High volatility riskScore >= 0.7 -> warning, confidence medium
  it('emits warning when volatility riskScore >= 0.7', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], {
      volatilityEntries: [makeVolatilityEntry('src/Shop/Order.php', 0.75)],
      revertStats: [],
    })

    const result = await revertChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('warning')
    expect(result.issues[0].confidence).toBeCloseTo(0.6, 1)
  })

  // 4. Moderate riskScore 0.5-0.7 -> info, confidence low
  it('emits info when volatility riskScore is 0.5-0.7', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], {
      volatilityEntries: [makeVolatilityEntry('src/Shop/Order.php', 0.55)],
      revertStats: [],
    })

    const result = await revertChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('info')
    expect(result.issues[0].confidence).toBeCloseTo(0.4, 1)
  })

  // 5. Both deps null -> skipped
  it('skips when both revertStats and volatilityEntries are null', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], {
      volatilityEntries: null,
      revertStats: null,
    })

    const result = await revertChecker.check(ctx)
    expect(result.skipped).toBeDefined()
    expect(result.skipped!.reason).toBe('missing_dep')
    expect(result.skipped!.missing).toContain('volatilityByPath')
    expect(result.skipped!.missing).toContain('revertByPath')
    expect(result.issues).toHaveLength(0)
  })

  // 6. Evidence includes top riskBreakdown component name
  it('includes top riskBreakdown component name in evidence', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], {
      volatilityEntries: [
        makeVolatilityEntry('src/Shop/Order.php', 0.75, {
          churnComponent: 0.1,
          bugDensityComponent: 0.5,
          ownershipFragmentationComponent: 0.05,
          recencyComponent: 0.1,
        }),
      ],
      revertStats: [],
    })

    const result = await revertChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    const ev = result.issues[0].evidence.join(' ')
    expect(ev).toContain('bugDensityComponent')
  })

  // 7. Same path with both revert + volatility -> one issue, aggregated evidence
  it('emits one issue per path with aggregated evidence from revert and volatility', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], {
      revertStats: [
        makeRevertStat('src/Shop/Order.php', {
          revertDensity: 0.1,
          revertCount: 2,
          lastRevertedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      volatilityEntries: [makeVolatilityEntry('src/Shop/Order.php', 0.75)],
    })

    const result = await revertChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    const ev = result.issues[0].evidence
    // Should have both revert and volatility evidence
    const hasRevertEvidence = ev.some((e) => e.includes('revert'))
    const hasVolatilityEvidence = ev.some((e) => e.includes('riskScore'))
    expect(hasRevertEvidence).toBe(true)
    expect(hasVolatilityEvidence).toBe(true)
  })

  // 8. Ancient revert does NOT escalate severity
  it('does not escalate severity for ancient reverts (older than 18 months)', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], {
      revertStats: [
        makeRevertStat('src/Shop/Order.php', {
          revertDensity: 0.25,
          revertCount: 5,
          lastRevertedAt: '2020-01-01T00:00:00Z', // ancient
        }),
      ],
      // riskScore 0.45 is below info threshold of 0.5
      volatilityEntries: [makeVolatilityEntry('src/Shop/Order.php', 0.45)],
    })

    const result = await revertChecker.check(ctx)
    // Ancient revert adds evidence but doesn't escalate severity.
    // Volatility is 0.45 (below 0.5 info threshold).
    // Revert data alone with ancient date should yield info at most (evidence only).
    // Expect either no issue or info-level at most from the ancient revert evidence.
    // Per spec: ancient reverts add evidence but severity comes only from volatility.
    // With volatility 0.45 < 0.5 threshold, there should still be an issue from
    // the ancient revert data but it should be info (evidence-only).
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('info')
    // Evidence should include ancient marker
    const ev = result.issues[0].evidence.join(' ')
    expect(ev).toContain('ancient, evidence only')
  })
})
