import { describe, it, expect } from 'vitest'
import {
  applyHoldout,
  buildPrompt,
  computeAggregate,
  evaluateSample,
  isPhpSourceFile,
  percentile,
} from '../src/benchmark/anchor-precision'
import type { CommitCorpusEntry } from '../src/commit-mining'

function entry(sha: string, committedAt: string): CommitCorpusEntry {
  return {
    sha,
    parentSha: null,
    authorNickname: 'a',
    authorEmail: 'a@a',
    authorIsBot: false,
    committedAt,
    subject: 's',
    bodyDigest: '0'.repeat(64),
    filesTouched: [],
    additions: 0,
    deletions: 0,
    intentCategory: 'other',
  }
}

describe('isPhpSourceFile', () => {
  it('keeps PHP source under app/ and routes/', () => {
    expect(isPhpSourceFile('app/Services/RefundService.php')).toBe(true)
    expect(isPhpSourceFile('routes/web.php')).toBe(true)
  })
  it('rejects tests, configs, migrations, non-php', () => {
    expect(isPhpSourceFile('tests/Unit/Foo.php')).toBe(false)
    expect(isPhpSourceFile('config/app.php')).toBe(false)
    expect(isPhpSourceFile('database/migrations/2024_x.php')).toBe(false)
    expect(isPhpSourceFile('app/Tests/Foo.php')).toBe(false)
    expect(isPhpSourceFile('README.md')).toBe(false)
    expect(isPhpSourceFile('app/Foo.js')).toBe(false)
  })
})

describe('precision / recall math', () => {
  it('computes precision@K and recall@K against ground truth', () => {
    // ground truth: 4 files; predicted top-10 contains 2 of them in first 5,
    // plus 1 more between rank 6-10.
    const groundTruth = ['a.php', 'b.php', 'c.php', 'd.php']
    const predicted = [
      'a.php', 'x.php', 'b.php', 'y.php', 'z.php',  // top 5 → 2 hits
      'q.php', 'c.php', 'r.php', 's.php', 't.php',  // top 10 → 3 hits
      'u.php', 'v.php', 'w.php', 'aa.php', 'bb.php',
      'cc.php', 'dd.php', 'ee.php', 'ff.php', 'gg.php', // top 20 → 3 hits still
    ]
    const s = evaluateSample('sha1', 'p', predicted, groundTruth)
    expect(s.precisionAt5).toBeCloseTo(2 / 5)
    expect(s.recallAt5).toBeCloseTo(2 / 4)
    expect(s.precisionAt10).toBeCloseTo(3 / 10)
    expect(s.recallAt10).toBeCloseTo(3 / 4)
    expect(s.precisionAt20).toBeCloseTo(3 / 20)
    expect(s.recallAt20).toBeCloseTo(3 / 4)
  })

  it('zero predictions and zero ground truth produce zeros', () => {
    const s = evaluateSample('sha', 'p', [], ['a.php'])
    expect(s.precisionAt10).toBe(0)
    expect(s.recallAt10).toBe(0)
  })
})

describe('aggregate stats', () => {
  it('averages and percentiles compute correctly, zero-hit rate counts no-overlap samples', () => {
    const a = evaluateSample('1', 'p', ['a.php'], ['a.php']) // P@10 = 0.1
    const b = evaluateSample('2', 'p', ['b.php', 'c.php'], ['c.php', 'd.php']) // P@10 = 0.2 (1 hit / 2 predicted... actually computed over k=10 → 1/10=0.1 — let's use cleaner case)
    const samples = [
      evaluateSample('1', 'p', Array(10).fill('x.php'), ['a.php']), // 0 hits
      evaluateSample('2', 'p', ['a.php', ...Array(9).fill('x.php')], ['a.php']), // 1/10
      evaluateSample('3', 'p', ['a.php', 'b.php', ...Array(8).fill('x.php')], ['a.php', 'b.php']), // 2/10
    ]
    void a; void b
    const agg = computeAggregate(samples)
    expect(agg.sampleCount).toBe(3)
    expect(agg.avgPrecisionAt10).toBeCloseTo((0 + 0.1 + 0.2) / 3)
    expect(agg.zeroHitRate).toBeCloseTo(1 / 3)
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5], 90)).toBe(5)
  })
})

describe('applyHoldout', () => {
  it('excludes the target sha and same-UTC-day commits', () => {
    const corpus = [
      entry('aaaaaaaa', '2024-05-01T10:00:00.000Z'), // target
      entry('bbbbbbbb', '2024-05-01T23:00:00.000Z'), // same day → excluded
      entry('cccccccc', '2024-04-30T23:00:00.000Z'), // prior day → kept
      entry('dddddddd', '2024-05-02T01:00:00.000Z'), // next day → kept
    ]
    const filtered = applyHoldout(corpus, 'aaaaaaaa', '2024-05-01T10:00:00.000Z')
    const shas = filtered.map((c) => c.sha).sort()
    expect(shas).toEqual(['cccccccc', 'dddddddd'])
  })
})

describe('buildPrompt', () => {
  it('combines subject and body for default strategy', () => {
    expect(buildPrompt('fix bug', 'details here', 'subject_body')).toBe('fix bug\n\ndetails here')
    expect(buildPrompt('fix bug', 'details', 'subject')).toBe('fix bug')
    expect(buildPrompt('fix bug', 'details', 'body_only')).toBe('details')
  })
})
