import { describe, it, expect } from 'vitest'
import {
  formatHistoricalSignals,
  HISTORICAL_SIGNALS_HEADER,
  DEFAULT_HISTORICAL_MIN_RISK,
  DEFAULT_HISTORICAL_MIN_COUPLING,
  type FormatHistoricalSignalsOpts,
} from '../src/formatters/historical-signals-formatter'
import type {
  VolatilityMapManifest,
  VolatilityEntry,
  VolatilityRiskBreakdown,
  CoChangeMatrixManifest,
  CoChangeEntry,
  RevertChainsManifest,
  RevertPathStat,
} from '../src/commit-mining'
import type { HistoricalSignalsBundle } from '../src/profiles/historical-signals-loader'

// -- fixture helpers --

function breakdown(overrides: Partial<VolatilityRiskBreakdown> = {}): VolatilityRiskBreakdown {
  return {
    churnComponent: overrides.churnComponent ?? 0,
    bugDensityComponent: overrides.bugDensityComponent ?? 0,
    ownershipFragmentationComponent: overrides.ownershipFragmentationComponent ?? 0,
    recencyComponent: overrides.recencyComponent ?? 0,
  }
}

function ventry(path: string, riskScore: number, bd?: Partial<VolatilityRiskBreakdown>): VolatilityEntry {
  return {
    path,
    commitCount: 10,
    lineDeltaAdded: 100,
    lineDeltaDeleted: 30,
    firstTouchedAt: '2025-01-01T00:00:00.000Z',
    lastTouchedAt: '2026-03-01T00:00:00.000Z',
    bugFixCommitCount: 2,
    bugFixDensity: 0.2,
    topAuthors: [{ nickname: 'alice', commitCount: 10, lastTouchedAt: '2026-03-01T00:00:00.000Z' }],
    laravelVersionSpan: [],
    riskScore,
    riskBreakdown: breakdown(bd ?? { churnComponent: 0.8 }),
  }
}

function volatilityManifest(entries: VolatilityEntry[]): VolatilityMapManifest {
  return {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-23T00:00:00.000Z',
    asOf: '2026-04-23T00:00:00.000Z',
    weights: { churn: 0.35, bugDensity: 0.3, ownershipFragmentation: 0.15, recency: 0.2 },
    stats: { totalEntries: entries.length, excludedPaths: 0, churnP95: 4, topRiskPathCount: 0, topRiskThreshold: 0.7 },
    entries,
  }
}

function coChangeManifest(entries: CoChangeEntry[]): CoChangeMatrixManifest {
  return {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-23T00:00:00.000Z',
    config: { minCoupling: 0.3, minJointCommits: 3, topK: 10, excludedPaths: 0 },
    all: { intentFilter: 'all', entries, stats: { anchors: entries.length, pairs: 0, commitsConsidered: 0 } },
    fix: { intentFilter: 'fix', entries: [], stats: { anchors: 0, pairs: 0, commitsConsidered: 0 } },
    feat: { intentFilter: 'feat', entries: [], stats: { anchors: 0, pairs: 0, commitsConsidered: 0 } },
  }
}

function revertManifest(pathStats: RevertPathStat[]): RevertChainsManifest {
  return {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-23T00:00:00.000Z',
    stats: { totalRevertCommits: 0, resolvedReverts: 0, unresolvedReverts: 0, chains: 0, chainsWithReapply: 0, excludedPaths: 0 },
    links: [],
    chains: [],
    pathStats,
  }
}

function emptyBundle(): HistoricalSignalsBundle {
  return { volatility: null, coChange: null, revertChains: null }
}

function opts(targetPaths: string[], overrides?: Partial<FormatHistoricalSignalsOpts>): FormatHistoricalSignalsOpts {
  return { targetPaths, ...overrides }
}

// -- tests --

describe('formatHistoricalSignals — empty cases', () => {
  it('returns empty when bundle is all null', () => {
    expect(formatHistoricalSignals(emptyBundle(), opts(['src/a.php']))).toBe('')
  })

  it('returns empty when no targetPaths', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([ventry('src/a.php', 0.8)]),
      coChange: null,
      revertChains: null,
    }
    expect(formatHistoricalSignals(bundle, opts([]))).toBe('')
  })

  it('returns empty when targetPaths miss all manifests', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([ventry('src/a.php', 0.8)]),
      coChange: null,
      revertChains: null,
    }
    expect(formatHistoricalSignals(bundle, opts(['src/miss.php']))).toBe('')
  })

  it('returns empty when all signals below quality gate', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([ventry('src/a.php', 0.2)]),
      coChange: coChangeManifest([{ path: 'src/a.php', commitCount: 5, neighbors: [{ path: 'src/b.php', jointCommits: 3, coupling: 0.3 }] }]),
      revertChains: null,
    }
    expect(formatHistoricalSignals(bundle, opts(['src/a.php']))).toBe('')
  })
})

describe('formatHistoricalSignals — volatility-only bullet', () => {
  it('emits risk + reason when path has high volatility', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([ventry('src/a.php', 0.82, { churnComponent: 0.9 })]),
      coChange: null,
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php']))
    expect(out).toContain(HISTORICAL_SIGNALS_HEADER)
    expect(out).toContain('`src/a.php`')
    expect(out).toContain('risk 0.82')
    expect(out.toLowerCase()).toContain('high churn')
  })
})

describe('formatHistoricalSignals — co-change-only bullet', () => {
  it('emits co-change hint when coupling >= threshold', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: null,
      coChange: coChangeManifest([{
        path: 'src/a.php',
        commitCount: 10,
        neighbors: [
          { path: 'src/b.php', jointCommits: 8, coupling: 0.8 },
          { path: 'src/c.php', jointCommits: 5, coupling: 0.5 },
        ],
      }]),
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php']))
    expect(out).toContain('co-changes with')
    expect(out).toContain('b.php')
    expect(out).toContain('c.php')
  })
})

describe('formatHistoricalSignals — revert-only bullet', () => {
  it('emits revert warning when revertCount >= 1', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: null,
      coChange: null,
      revertChains: revertManifest([{
        path: 'src/a.php',
        commitCount: 20,
        revertCount: 2,
        revertDensity: 0.1,
        medianDaysToRevert: 3,
        chainsInvolvingPath: 1,
        lastRevertedAt: '2026-03-01T00:00:00.000Z',
      }]),
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php']))
    expect(out).toContain('reverted 2x')
    expect(out).toContain('median 3d')
  })
})

describe('formatHistoricalSignals — combined bullet', () => {
  it('joins all three segments with semicolons', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([ventry('src/a.php', 0.82, { churnComponent: 0.9 })]),
      coChange: coChangeManifest([{
        path: 'src/a.php',
        commitCount: 10,
        neighbors: [{ path: 'src/b.php', jointCommits: 8, coupling: 0.8 }],
      }]),
      revertChains: revertManifest([{
        path: 'src/a.php',
        commitCount: 20,
        revertCount: 1,
        revertDensity: 0.05,
        medianDaysToRevert: 0.5,
        chainsInvolvingPath: 1,
        lastRevertedAt: '2026-03-01T00:00:00.000Z',
      }]),
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php']))
    expect(out).toContain('risk 0.82')
    expect(out).toContain('co-changes with')
    expect(out).toContain('reverted 1x')
    const bullet = out.split('\n').find(l => l.startsWith('- '))!
    expect((bullet.match(/;/g) ?? []).length).toBe(2)
  })
})

describe('formatHistoricalSignals — ordering and capping', () => {
  it('sorts by risk desc, then path asc', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([
        ventry('src/b.php', 0.7),
        ventry('src/a.php', 0.8),
        ventry('src/c.php', 0.8),
      ]),
      coChange: null,
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php', 'src/b.php', 'src/c.php']))
    const bullets = out.split('\n').filter(l => l.startsWith('- '))
    expect(bullets[0]).toContain('src/a.php')
    expect(bullets[1]).toContain('src/c.php')
    expect(bullets[2]).toContain('src/b.php')
  })

  it('caps at topN=3 by default', () => {
    const entries: VolatilityEntry[] = []
    for (let i = 0; i < 6; i++) {
      entries.push(ventry(`src/${i}.php`, 0.8 - i * 0.01))
    }
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest(entries),
      coChange: null,
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, opts(entries.map(e => e.path)))
    const bullets = out.split('\n').filter(l => l.startsWith('- '))
    expect(bullets).toHaveLength(3)
  })

  it('drops trailing bullets when exceeding maxChars', () => {
    const entries: VolatilityEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(ventry(`src/very/long/nested/path/segment/file-${i}.php`, 0.8 - i * 0.01))
    }
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest(entries),
      coChange: null,
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, opts(entries.map(e => e.path), { maxChars: 250, topN: 5 }))
    expect(out.length).toBeLessThanOrEqual(250)
    expect(out.split('\n').some(l => l.startsWith('- '))).toBe(true)
  })
})

describe('formatHistoricalSignals — co-change neighbor cap', () => {
  it('shows at most 3 co-change neighbors per bullet', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: null,
      coChange: coChangeManifest([{
        path: 'src/a.php',
        commitCount: 10,
        neighbors: [
          { path: 'src/b.php', jointCommits: 8, coupling: 0.8 },
          { path: 'src/c.php', jointCommits: 7, coupling: 0.7 },
          { path: 'src/d.php', jointCommits: 6, coupling: 0.6 },
          { path: 'src/e.php', jointCommits: 5, coupling: 0.5 },
        ],
      }]),
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php']))
    const bullet = out.split('\n').find(l => l.startsWith('- '))!
    expect(bullet).toContain('b.php')
    expect(bullet).toContain('c.php')
    expect(bullet).toContain('d.php')
    expect(bullet).not.toContain('e.php')
  })
})

describe('formatHistoricalSignals — fixture exclusion', () => {
  it('excludes shared test fixture paths', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([
        ventry('tests/ModelFactories.php', 0.9),
        ventry('src/a.php', 0.5),
      ]),
      coChange: null,
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, opts(['tests/ModelFactories.php', 'src/a.php']))
    expect(out).not.toContain('ModelFactories')
    expect(out).toContain('src/a.php')
  })
})

describe('formatHistoricalSignals — revert median formatting', () => {
  it('shows integer days when whole number', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: null,
      coChange: null,
      revertChains: revertManifest([{
        path: 'src/a.php',
        commitCount: 10,
        revertCount: 1,
        revertDensity: 0.1,
        medianDaysToRevert: 5,
        chainsInvolvingPath: 1,
        lastRevertedAt: '2026-03-01T00:00:00.000Z',
      }]),
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php']))
    expect(out).toContain('median 5d')
  })

  it('shows <1d for sub-day median', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: null,
      coChange: null,
      revertChains: revertManifest([{
        path: 'src/a.php',
        commitCount: 10,
        revertCount: 1,
        revertDensity: 0.1,
        medianDaysToRevert: 0.3,
        chainsInvolvingPath: 1,
        lastRevertedAt: '2026-03-01T00:00:00.000Z',
      }]),
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php']))
    expect(out).toContain('median <1d')
  })

  it('omits median when null', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: null,
      coChange: null,
      revertChains: revertManifest([{
        path: 'src/a.php',
        commitCount: 10,
        revertCount: 1,
        revertDensity: 0.1,
        medianDaysToRevert: null,
        chainsInvolvingPath: 1,
        lastRevertedAt: '2026-03-01T00:00:00.000Z',
      }]),
    }
    const out = formatHistoricalSignals(bundle, opts(['src/a.php']))
    expect(out).toContain('reverted 1x')
    expect(out).not.toContain('median')
  })
})

describe('formatHistoricalSignals — determinism', () => {
  it('produces stable output for same input', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([ventry('src/a.php', 0.8), ventry('src/b.php', 0.7)]),
      coChange: coChangeManifest([{ path: 'src/a.php', commitCount: 10, neighbors: [{ path: 'src/b.php', jointCommits: 5, coupling: 0.5 }] }]),
      revertChains: revertManifest([{ path: 'src/a.php', commitCount: 20, revertCount: 1, revertDensity: 0.05, medianDaysToRevert: 2, chainsInvolvingPath: 1, lastRevertedAt: '2026-03-01T00:00:00.000Z' }]),
    }
    const o = opts(['src/a.php', 'src/b.php'])
    const a = formatHistoricalSignals(bundle, o)
    const b = formatHistoricalSignals(bundle, o)
    expect(a).toBe(b)
  })
})

describe('formatHistoricalSignals — globalFallback', () => {
  it('emits global top-N when no targetPaths and globalFallback on', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([
        ventry('src/a.php', 0.9),
        ventry('src/b.php', 0.8),
      ]),
      coChange: null,
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, { targetPaths: [], globalFallback: true })
    expect(out).toContain('src/a.php')
    expect(out).toContain('src/b.php')
  })

  it('emits global top-N when targetPaths miss and globalFallback on', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([ventry('src/a.php', 0.9)]),
      coChange: null,
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, { targetPaths: ['src/miss.php'], globalFallback: true })
    expect(out).toContain('src/a.php')
  })

  it('returns empty when globalFallback off and targetPaths empty', () => {
    const bundle: HistoricalSignalsBundle = {
      volatility: volatilityManifest([ventry('src/a.php', 0.9)]),
      coChange: null,
      revertChains: null,
    }
    const out = formatHistoricalSignals(bundle, { targetPaths: [] })
    expect(out).toBe('')
  })
})

describe('formatHistoricalSignals — exports', () => {
  it('exports correct defaults', () => {
    expect(HISTORICAL_SIGNALS_HEADER).toBe('## Historical Signals')
    expect(DEFAULT_HISTORICAL_MIN_RISK).toBe(0.4)
    expect(DEFAULT_HISTORICAL_MIN_COUPLING).toBe(0.5)
  })
})
