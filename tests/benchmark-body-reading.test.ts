import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  readCommitBody,
  cleanCommitBody,
  computeAggregate,
  evaluateSample,
  _resetBodyCacheForTests,
} from '../src/benchmark/anchor-precision'

const PHORGE_REPO = new URL('..', import.meta.url).pathname

// Resolve at test time so the test is robust against history rewrites
// (squash/rebase/force-push) that change the initial commit's sha.
const HEAD_SHA = execFileSync('git', ['-C', PHORGE_REPO, 'rev-parse', 'HEAD'], {
  encoding: 'utf-8',
}).trim()

describe('readCommitBody', () => {
  beforeEach(() => _resetBodyCacheForTests())

  it('returns the commit message for a real sha', async () => {
    const body = await readCommitBody(PHORGE_REPO, HEAD_SHA)
    expect(body.length).toBeGreaterThan(0)
  })

  it('returns empty string for an unknown sha (no throw)', async () => {
    const body = await readCommitBody(PHORGE_REPO, '0'.repeat(40))
    expect(body).toBe('')
  })
})

describe('cleanCommitBody', () => {
  it('strips merge boilerplate prefixes and commit-list sections', () => {
    const raw = [
      'Real description line one.',
      '',
      'Merged in feature/foo (pull request #123)',
      'Approved-by: Alice',
      'Co-authored-by: Bob <b@b>',
      '',
      '* commits:',
      '  abc1234 fix one thing',
      '  def5678 fix another',
      '',
      'Trailing content.',
    ].join('\n')
    const cleaned = cleanCommitBody(raw)
    expect(cleaned).toContain('Real description line one.')
    expect(cleaned).toContain('Trailing content.')
    expect(cleaned).not.toContain('Merged in')
    expect(cleaned).not.toContain('Approved-by')
    expect(cleaned).not.toContain('Co-authored-by')
    expect(cleaned).not.toMatch(/abc1234|def5678/)
  })
})

describe('cohort accounting', () => {
  it('classifies samples and aggregates by cohort', () => {
    const samples = [
      evaluateSample('1', 'p', ['a.php'], ['a.php'], 'body'),
      evaluateSample('2', 'p', ['x.php'], ['a.php'], 'subject_only'),
      evaluateSample('3', 'p', ['a.php', 'b.php'], ['a.php'], 'body'),
    ]
    const agg = computeAggregate(samples)
    expect(agg.samplesWithBody).toBe(2)
    expect(agg.samplesSubjectOnly).toBe(1)
    expect(agg.bodyCohort.count).toBe(2)
    expect(agg.subjectOnlyCohort.count).toBe(1)
    expect(agg.subjectOnlyCohort.zeroHitRate).toBe(1)
    expect(agg.bodyCohort.zeroHitRate).toBe(0)
  })

  it('defaults to subject_only cohort when not specified', () => {
    const s = evaluateSample('1', 'p', ['a.php'], ['a.php'])
    expect(s.cohort).toBe('subject_only')
  })
})
