import { describe, it, expect } from 'vitest'
import {
  formatVolatilityForPlanner,
  PLANNER_VOLATILITY_HEADER,
  PLANNER_FIXTURE_EXCLUDE_RE,
  DEFAULT_PLANNER_MIN_RISK,
} from '../src/formatters/volatility-formatter'
import type {
  VolatilityEntry,
  VolatilityMapManifest,
  VolatilityRiskBreakdown,
} from '../src/commit-mining'

function breakdown(overrides: Partial<VolatilityRiskBreakdown> = {}): VolatilityRiskBreakdown {
  return {
    churnComponent: overrides.churnComponent ?? 0,
    bugDensityComponent: overrides.bugDensityComponent ?? 0,
    ownershipFragmentationComponent: overrides.ownershipFragmentationComponent ?? 0,
    recencyComponent: overrides.recencyComponent ?? 0,
  }
}

function ventry(overrides: Partial<VolatilityEntry> & { path: string; riskScore: number }): VolatilityEntry {
  return {
    path: overrides.path,
    commitCount: overrides.commitCount ?? 5,
    lineDeltaAdded: overrides.lineDeltaAdded ?? 100,
    lineDeltaDeleted: overrides.lineDeltaDeleted ?? 30,
    firstTouchedAt: overrides.firstTouchedAt ?? '2025-01-01T00:00:00.000Z',
    lastTouchedAt: overrides.lastTouchedAt ?? '2026-03-01T00:00:00.000Z',
    bugFixCommitCount: overrides.bugFixCommitCount ?? 1,
    bugFixDensity: overrides.bugFixDensity ?? 0.2,
    topAuthors: overrides.topAuthors ?? [
      { nickname: 'alice', commitCount: 5, lastTouchedAt: '2026-03-01T00:00:00.000Z' },
    ],
    laravelVersionSpan: overrides.laravelVersionSpan ?? [],
    riskScore: overrides.riskScore,
    riskBreakdown: overrides.riskBreakdown ?? breakdown({ churnComponent: 0.8 }),
  }
}

function manifest(entries: VolatilityEntry[]): VolatilityMapManifest {
  return {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-22T00:00:00.000Z',
    asOf: '2026-04-22T00:00:00.000Z',
    weights: { churn: 0.35, bugDensity: 0.3, ownershipFragmentation: 0.15, recency: 0.2 },
    stats: {
      totalEntries: entries.length,
      excludedPaths: 0,
      churnP95: 4,
      topRiskPathCount: entries.filter((e) => e.riskScore >= 0.7).length,
      topRiskThreshold: 0.7,
    },
    entries,
  }
}

describe('formatVolatilityForPlanner — empty cases', () => {
  it('returns empty string on empty manifest', () => {
    const out = formatVolatilityForPlanner(manifest([]), {})
    expect(out).toBe('')
  })

  it('returns empty string when no targetPaths and fallback off', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.9 })]),
      {},
    )
    expect(out).toBe('')
  })

  it('returns empty string when targetPaths miss and fallback off', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.9 })]),
      { targetPaths: ['src/unrelated.php'] },
    )
    expect(out).toBe('')
  })

  it('returns empty string when all entries below minRisk', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.1 })]),
      { targetPaths: ['src/a.php'], minRisk: 0.5 },
    )
    expect(out).toBe('')
  })
})

describe('formatVolatilityForPlanner — matching entries', () => {
  it('emits markdown block with header when targetPaths match', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({ path: 'src/a.php', riskScore: 0.91, riskBreakdown: breakdown({ churnComponent: 0.9 }) }),
      ]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out).toContain(PLANNER_VOLATILITY_HEADER)
    expect(out).toContain('`src/a.php`')
    expect(out).toContain('risk 0.91')
  })

  it('orders by risk desc then path asc (deterministic)', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({ path: 'src/b.php', riskScore: 0.70 }),
        ventry({ path: 'src/a.php', riskScore: 0.80 }),
        ventry({ path: 'src/c.php', riskScore: 0.80 }),
      ]),
      { targetPaths: ['src/a.php', 'src/b.php', 'src/c.php'] },
    )
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    expect(lines[0]).toContain('src/a.php')
    expect(lines[1]).toContain('src/c.php')
    expect(lines[2]).toContain('src/b.php')
  })

  it('caps bullets at topN (default 3)', () => {
    const entries: VolatilityEntry[] = []
    for (let i = 0; i < 6; i++) {
      entries.push(ventry({ path: `src/${i}.php`, riskScore: 0.8 - i * 0.01 }))
    }
    const out = formatVolatilityForPlanner(manifest(entries), {
      targetPaths: entries.map((e) => e.path),
    })
    const bullets = out.split('\n').filter((l) => l.startsWith('- '))
    expect(bullets).toHaveLength(3)
  })

  it('honors explicit topN override', () => {
    const entries: VolatilityEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(ventry({ path: `src/${i}.php`, riskScore: 0.8 - i * 0.01 }))
    }
    const out = formatVolatilityForPlanner(manifest(entries), {
      targetPaths: entries.map((e) => e.path),
      topN: 2,
    })
    const bullets = out.split('\n').filter((l) => l.startsWith('- '))
    expect(bullets).toHaveLength(2)
  })
})

describe('formatVolatilityForPlanner — reason derivation', () => {
  it('surfaces dominant churn component', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({
          path: 'src/a.php',
          riskScore: 0.85,
          riskBreakdown: breakdown({ churnComponent: 0.95, bugDensityComponent: 0.1 }),
        }),
      ]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out.toLowerCase()).toContain('high churn')
  })

  it('surfaces dominant bug-fix density', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({
          path: 'src/a.php',
          riskScore: 0.7,
          riskBreakdown: breakdown({ bugDensityComponent: 0.9, churnComponent: 0.2 }),
        }),
      ]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out.toLowerCase()).toContain('bug-fix density')
  })

  it('surfaces ownership spread', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({
          path: 'src/a.php',
          riskScore: 0.65,
          riskBreakdown: breakdown({ ownershipFragmentationComponent: 0.9, churnComponent: 0.2 }),
        }),
      ]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out.toLowerCase()).toContain('ownership spread')
  })

  it('joins top two components with " and " when both are strong', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({
          path: 'src/a.php',
          riskScore: 0.9,
          riskBreakdown: breakdown({ churnComponent: 0.9, bugDensityComponent: 0.85 }),
        }),
      ]),
      { targetPaths: ['src/a.php'] },
    )
    const bulletLine = out.split('\n').find((l) => l.startsWith('- '))!
    expect(bulletLine.toLowerCase()).toMatch(/high churn and (high )?bug-fix density/)
  })
})

describe('formatVolatilityForPlanner — char cap', () => {
  it('drops trailing bullets rather than truncating mid-line when over maxChars', () => {
    const entries: VolatilityEntry[] = []
    for (let i = 0; i < 10; i++) {
      entries.push(
        ventry({
          path: `src/very/long/path/segment/file-${i}-with-extra-descriptor.php`,
          riskScore: 0.8 - i * 0.001,
        }),
      )
    }
    const out = formatVolatilityForPlanner(manifest(entries), {
      targetPaths: entries.map((e) => e.path),
      topN: 10,
      maxChars: 200,
    })
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith('.')).toBe(true)
    expect(out.split('\n').some((l) => l.startsWith('- '))).toBe(true)
  })

  it('returns empty string if header alone exceeds maxChars', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.9 })]),
      { targetPaths: ['src/a.php'], maxChars: 5 },
    )
    expect(out).toBe('')
  })
})

describe('formatVolatilityForPlanner — global fallback', () => {
  it('emits global top-N when no targetPaths and globalFallback on', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({ path: 'src/a.php', riskScore: 0.9 }),
        ventry({ path: 'src/b.php', riskScore: 0.8 }),
      ]),
      { globalFallback: true },
    )
    expect(out).toContain('src/a.php')
    expect(out).toContain('src/b.php')
  })

  it('emits global top-N when targetPaths miss and globalFallback on', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.9 })]),
      { targetPaths: ['src/missing.php'], globalFallback: true },
    )
    expect(out).toContain('src/a.php')
  })
})

describe('formatVolatilityForPlanner — default minRisk 0.4', () => {
  it('exports DEFAULT_PLANNER_MIN_RISK = 0.4', () => {
    expect(DEFAULT_PLANNER_MIN_RISK).toBe(0.4)
  })

  it('drops entries below default minRisk when opt not provided', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.3 })]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out).toBe('')
  })

  it('keeps entries at or above default minRisk', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.41 })]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out).toContain('src/a.php')
  })

  it('allows caller to disable floor by passing minRisk: 0', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.2 })]),
      { targetPaths: ['src/a.php'], minRisk: 0 },
    )
    expect(out).toContain('src/a.php')
  })
})

describe('formatVolatilityForPlanner — fixture exclusion', () => {
  it('exports PLANNER_FIXTURE_EXCLUDE_RE', () => {
    expect(PLANNER_FIXTURE_EXCLUDE_RE).toBeInstanceOf(RegExp)
  })

  it('drops shared test fixture paths by default', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({ path: 'tests/ModelFactories.php', riskScore: 0.9 }),
        ventry({ path: 'src/a.php', riskScore: 0.5 }),
      ]),
      { targetPaths: ['tests/ModelFactories.php', 'src/a.php'] },
    )
    expect(out).not.toContain('ModelFactories')
    expect(out).toContain('src/a.php')
  })

  it('drops tests/TestCase.php', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'tests/TestCase.php', riskScore: 0.9 })]),
      { targetPaths: ['tests/TestCase.php'] },
    )
    expect(out).toBe('')
  })

  it('drops tests/Factories/*.php paths', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'tests/Factories/UserFactory.php', riskScore: 0.9 })]),
      { targetPaths: ['tests/Factories/UserFactory.php'] },
    )
    expect(out).toBe('')
  })

  it('keeps non-fixture test paths', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'tests/Integration/CheckoutTest.php', riskScore: 0.8 })]),
      { targetPaths: ['tests/Integration/CheckoutTest.php'] },
    )
    expect(out).toContain('tests/Integration/CheckoutTest.php')
  })
})

describe('formatVolatilityForPlanner — weighted reason derivation', () => {
  it('picks churn over recency when weighted contribution favors churn', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({
          path: 'src/a.php',
          riskScore: 0.65,
          riskBreakdown: breakdown({ churnComponent: 0.7, recencyComponent: 1.0 }),
        }),
      ]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out.toLowerCase()).toContain('high churn')
    expect(out.toLowerCase()).not.toMatch(/^[^-]*recent activity/)
  })

  it('picks recency only when no other component has meaningful weighted contribution', () => {
    const out = formatVolatilityForPlanner(
      manifest([
        ventry({
          path: 'src/a.php',
          riskScore: 0.5,
          riskBreakdown: breakdown({ recencyComponent: 1.0, churnComponent: 0.05 }),
          // weighted: recency 0.2 vs churn 0.0175 → recency wins
        }),
      ]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out.toLowerCase()).toContain('recent activity')
  })
})

describe('formatVolatilityForPlanner — safety', () => {
  it('does not emit raw JSON or manifest field names', () => {
    const out = formatVolatilityForPlanner(
      manifest([ventry({ path: 'src/a.php', riskScore: 0.9 })]),
      { targetPaths: ['src/a.php'] },
    )
    expect(out).not.toContain('riskBreakdown')
    expect(out).not.toContain('{')
    expect(out).not.toContain('"schemaVersion"')
  })

  it('is pure (same inputs → same output)', () => {
    const m = manifest([
      ventry({ path: 'src/a.php', riskScore: 0.9 }),
      ventry({ path: 'src/b.php', riskScore: 0.8 }),
    ])
    const a = formatVolatilityForPlanner(m, { targetPaths: ['src/a.php', 'src/b.php'] })
    const b = formatVolatilityForPlanner(m, { targetPaths: ['src/a.php', 'src/b.php'] })
    expect(a).toBe(b)
  })
})
