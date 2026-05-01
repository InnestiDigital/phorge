// Tests for buildVolatilityMap small-N tuning (Task #184).

import { describe, it, expect } from 'vitest'
import {
  buildVolatilityMap,
  DEFAULT_MIN_COMMITS_FOR_RISK,
} from '../src/commit-mining/volatility-map'
import type {
  CommitCorpusManifest,
  CommitCorpusEntry,
} from '../src/commit-mining/schema'
import { createHash } from 'node:crypto'

const DIGEST = createHash('sha256').update('x').digest('hex')

function commit(
  i: number,
  paths: string[],
  opts: { intent?: 'fix' | 'feat'; author?: string; date?: string } = {},
): CommitCorpusEntry {
  return {
    sha: `abcdef${String(i).padStart(4, '0')}`,
    parentSha: null,
    authorNickname: opts.author ?? 'alice',
    authorEmail: 'alice@example.com',
    authorIsBot: false,
    committedAt: opts.date ?? `2025-01-${String((i % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
    subject: `commit ${i}`,
    bodyDigest: DIGEST,
    filesTouched: paths,
    additions: 10,
    deletions: 5,
    intentCategory: opts.intent ?? 'feat',
  }
}

function corpusOf(entries: CommitCorpusEntry[]): CommitCorpusManifest {
  return {
    schemaVersion: 1,
    repo: 'test',
    window: {},
    createdAt: new Date().toISOString(),
    filter: {
      megaFileThreshold: 100,
      megaLineThreshold: 1000,
      excludeDocsOnly: false,
      excludeDependencyChurn: false,
      botNicknames: [],
      extraBotEmailSuffixes: [],
    },
    stats: {
      totalConsidered: entries.length,
      kept: entries.length,
      excluded: {},
      byIntent: {},
    },
    entries,
  }
}

describe('buildVolatilityMap small-N tuning', () => {
  it('dampens risk for files below the minimum-commits floor', () => {
    const entries: CommitCorpusEntry[] = []
    // Big file: 20 commits, half fixes
    for (let i = 0; i < 20; i++) {
      entries.push(commit(i, ['app/Big.php'], { intent: i % 2 ? 'fix' : 'feat' }))
    }
    // Tiny file: 3 commits, all fixes
    for (let i = 0; i < 3; i++) {
      entries.push(commit(100 + i, ['app/Tiny.php'], { intent: 'fix' }))
    }
    const map = buildVolatilityMap({
      corpus: corpusOf(entries),
      asOf: '2025-06-01T00:00:00.000Z',
      normalizationMethod: 'raw',
    })
    const big = map.entries.find((e) => e.path === 'app/Big.php')!
    const tiny = map.entries.find((e) => e.path === 'app/Tiny.php')!
    expect(big.riskScore).toBeGreaterThan(tiny.riskScore)
    // Tiny file dampener = 3/5
    expect(tiny.riskBreakdown.smallSampleDampener).toBeCloseTo(3 / DEFAULT_MIN_COMMITS_FOR_RISK)
    expect(big.riskBreakdown.smallSampleDampener).toBe(1)
  })

  it('Laplace-smooths bug density so 100%-on-tiny-N does not saturate', () => {
    const entries: CommitCorpusEntry[] = []
    // 5 fix-only commits on tiny
    for (let i = 0; i < 5; i++) {
      entries.push(commit(i, ['app/Tiny.php'], { intent: 'fix' }))
    }
    // 50 commits, 25 fixes on big
    for (let i = 0; i < 50; i++) {
      entries.push(commit(100 + i, ['app/Big.php'], { intent: i % 2 ? 'fix' : 'feat' }))
    }
    const map = buildVolatilityMap({
      corpus: corpusOf(entries),
      asOf: '2025-06-01T00:00:00.000Z',
      normalizationMethod: 'raw',
    })
    const tiny = map.entries.find((e) => e.path === 'app/Tiny.php')!
    const big = map.entries.find((e) => e.path === 'app/Big.php')!
    // Raw bugFixDensity stays 1.0 on tiny (back-compat).
    expect(tiny.bugFixDensity).toBe(1)
    // But the smoothed component used in risk is 5/(5+5)=0.5, vs big's 25/(50+5)=~0.45
    expect(tiny.riskBreakdown.bugDensityComponent).toBeCloseTo(0.5)
    expect(big.riskBreakdown.bugDensityComponent).toBeCloseTo(25 / 55)
    // Big should outrank tiny on risk because of churn + dampener.
    expect(big.riskScore).toBeGreaterThan(tiny.riskScore)
  })

  it('percentile normalization clamps top score and is the default', () => {
    const entries: CommitCorpusEntry[] = []
    for (let f = 0; f < 10; f++) {
      const path = `app/F${f}.php`
      const n = f === 0 ? 30 : 6 // one outlier with 30 commits
      for (let i = 0; i < n; i++) {
        entries.push(commit(f * 100 + i, [path], { intent: 'fix' }))
      }
    }
    const map = buildVolatilityMap({
      corpus: corpusOf(entries),
      asOf: '2025-06-01T00:00:00.000Z',
    })
    // Default is percentile, so the outlier should clamp at 1.0.
    const top = map.entries[0]
    expect(top.riskScore).toBe(1)
    // Raw weighted-sum should still be reported and >= clamped.
    expect(top.riskBreakdown.rawRiskScore).toBeDefined()
  })
})
