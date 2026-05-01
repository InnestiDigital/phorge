import { describe, it, expect } from 'vitest'
import type {
  PlanIssue,
  PlanReviewResult,
  DraftPlan,
  PlanIssueSeverity,
  PlanIssueKind,
  CheckerId,
} from '../src/checkers/plan-validator-types'
import { formatFindingsForRerun } from '../src/checkers/plan-review-formatter'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides?: Partial<PlanIssue>): PlanIssue {
  return {
    issueKey: 'test:missing-test:default',
    severity: 'warning',
    confidence: 0.8,
    kind: 'missing_test',
    message: 'Missing test for Foo',
    evidence: ['no test file found'],
    checkerId: 'missing-test',
    ...overrides,
  }
}

function makeReview(issues: PlanIssue[], extra?: Partial<PlanReviewResult>): PlanReviewResult {
  const hasCritical = issues.some((i) => i.severity === 'critical')
  const hasWarning = issues.some((i) => i.severity === 'warning')
  return {
    verdict: hasCritical ? 'revise' : hasWarning ? 'warn' : 'pass',
    issues,
    suggestedPaths: [],
    suggestedSymbols: [],
    groupedByPath: {},
    stats: { checkersAttempted: 5, checkersRun: 5, checkersSkipped: 0, checkersDisabled: 0 },
    skippedCheckers: [],
    disabledCheckers: [],
    suppressedIssueCount: 0,
    ...extra,
  }
}

function makePlan(obj: Record<string, unknown> = {}): DraftPlan {
  const plan = {
    summary: 'Fix checkout flow',
    steps: [
      { description: 'Update authorize step', files: ['src/Checkout/Authorize.php'] },
      { description: 'Add webhook handler', files: ['src/Webhooks/Handler.php'] },
    ],
    riskFlags: ['Payment gateway timeout'],
    ...obj,
  }
  return { rawText: JSON.stringify(plan) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatFindingsForRerun', () => {
  it('lists critical issues first, warnings second', () => {
    const issues = [
      makeIssue({ severity: 'warning', message: 'warn-A', checkerId: 'cochange' }),
      makeIssue({ severity: 'critical', message: 'crit-B', checkerId: 'revert' }),
      makeIssue({ severity: 'warning', message: 'warn-C', checkerId: 'missing-test' }),
      makeIssue({ severity: 'critical', message: 'crit-D', checkerId: 'rule' }),
    ]
    const review = makeReview(issues)
    const out = formatFindingsForRerun(makePlan(), review)

    const critIdx = out.indexOf('### Critical Issues')
    const warnIdx = out.indexOf('### Warnings')
    expect(critIdx).toBeGreaterThan(-1)
    expect(warnIdx).toBeGreaterThan(-1)
    expect(critIdx).toBeLessThan(warnIdx)

    // Within critical section, both critical messages appear before warnings section
    const critBIdx = out.indexOf('crit-B')
    const critDIdx = out.indexOf('crit-D')
    expect(critBIdx).toBeGreaterThan(-1)
    expect(critDIdx).toBeGreaterThan(-1)
    expect(critBIdx).toBeLessThan(warnIdx)
    expect(critDIdx).toBeLessThan(warnIdx)
  })

  it('omits info-severity issues from the rerun prompt', () => {
    const issues = [
      makeIssue({ severity: 'warning', message: 'warn-1' }),
      makeIssue({ severity: 'info', message: 'info-1', issueKey: 'info:a' }),
      makeIssue({ severity: 'info', message: 'info-2', issueKey: 'info:b' }),
    ]
    const review = makeReview(issues)
    const out = formatFindingsForRerun(makePlan(), review)

    expect(out).toContain('warn-1')
    expect(out).not.toContain('info-1')
    expect(out).not.toContain('info-2')
  })

  it('truncates at maxIssuesInRerunPrompt with summary count', () => {
    const issues: PlanIssue[] = []
    for (let i = 0; i < 12; i++) {
      issues.push(
        makeIssue({
          issueKey: `warn:cochange:${i}`,
          severity: 'warning',
          message: `warning-${i}`,
          checkerId: (['cochange', 'revert', 'missing-test', 'rule'] as CheckerId[])[i % 4],
        }),
      )
    }
    const review = makeReview(issues)
    const out = formatFindingsForRerun(makePlan(), review, { maxIssuesInRerunPrompt: 4 })

    // Only 4 issues should appear in detail
    let detailCount = 0
    for (let i = 0; i < 12; i++) {
      if (out.includes(`warning-${i}`)) detailCount++
    }
    expect(detailCount).toBeLessThanOrEqual(4)

    // Should mention omitted count
    expect(out).toMatch(/\.\.\.\s*and\s+\d+\s+more/)
  })

  it('sorts and deduplicates suggested paths', () => {
    const review = makeReview([], {
      suggestedPaths: [
        'src/Zebra.php',
        'src/Alpha.php',
        'src/Zebra.php', // duplicate
        'src/Middle.php',
      ],
    })
    const out = formatFindingsForRerun(makePlan(), review)

    const alphaIdx = out.indexOf('src/Alpha.php')
    const middleIdx = out.indexOf('src/Middle.php')
    const zebraIdx = out.indexOf('src/Zebra.php')
    expect(alphaIdx).toBeGreaterThan(-1)
    expect(middleIdx).toBeGreaterThan(-1)
    expect(zebraIdx).toBeGreaterThan(-1)
    expect(alphaIdx).toBeLessThan(middleIdx)
    expect(middleIdx).toBeLessThan(zebraIdx)

    // Only one occurrence of Zebra after dedup
    const zebraMatches = out.match(/src\/Zebra\.php/g)
    expect(zebraMatches?.length).toBe(1)
  })

  it('renders original plan as compact markdown', () => {
    const plan = makePlan()
    const review = makeReview([makeIssue()])
    const out = formatFindingsForRerun(plan, review)

    expect(out).toContain('Fix checkout flow')
    expect(out).toContain('Update authorize step')
    expect(out).toContain('src/Checkout/Authorize.php')
    expect(out).toContain('Payment gateway timeout')
  })

  it('rerun instructions include "keep plan minimal" and "Do not remove existing steps"', () => {
    const review = makeReview([makeIssue()])
    const out = formatFindingsForRerun(makePlan(), review)

    // Case-insensitive checks for key instruction phrases
    const lower = out.toLowerCase()
    expect(lower).toContain('keep your plan minimal')
    expect(lower).toContain('do not remove existing steps')
    expect(lower).toContain('revise your plan')
  })
})
