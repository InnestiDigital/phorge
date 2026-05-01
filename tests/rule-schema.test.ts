import { describe, it, expect } from 'vitest'
import { RuleRecord } from '../src/schemas/rule-schema'

const baseRule = {
  id: 'podium.checkout.step-contract',
  title: 'Use StepInterface for checkout pipeline steps',
  state: 'approved' as const,
  source: 'human' as const,
  appliesTo: ['planner', 'implementer', 'reviewer'] as const,
  scope: {
    repos: ['podium.api'],
    globs: ['src/Shop/Checkout/Steps/**'],
    workflows: ['checkout'],
  },
  confidence: 'high' as const,
  version: 1,
  rationale: 'Checkout pipeline relies on StepInterface.handle contract.',
  guidance: 'All classes in Steps/ must implement StepInterface.',
}

describe('RuleRecord', () => {
  it('accepts a minimal valid approved human-authored rule', () => {
    const parsed = RuleRecord.safeParse(baseRule)
    expect(parsed.success).toBe(true)
  })

  it('rejects rule missing required fields', () => {
    const { guidance: _g, ...missing } = baseRule
    const parsed = RuleRecord.safeParse(missing)
    expect(parsed.success).toBe(false)
  })

  it('rejects invalid state enum value', () => {
    const parsed = RuleRecord.safeParse({ ...baseRule, state: 'bogus' })
    expect(parsed.success).toBe(false)
  })

  it('rejects invalid source enum value', () => {
    const parsed = RuleRecord.safeParse({ ...baseRule, source: 'telepathy' })
    expect(parsed.success).toBe(false)
  })

  it('rejects empty appliesTo array', () => {
    const parsed = RuleRecord.safeParse({ ...baseRule, appliesTo: [] })
    expect(parsed.success).toBe(false)
  })

  it('requires reviewDueAt when state is experimental', () => {
    const parsed = RuleRecord.safeParse({ ...baseRule, state: 'experimental' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join(' ')
      expect(msg).toContain('reviewDueAt')
    }
  })

  it('accepts experimental state when reviewDueAt provided', () => {
    const parsed = RuleRecord.safeParse({
      ...baseRule,
      state: 'experimental',
      reviewDueAt: '2026-06-01T00:00:00.000Z',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts optional reviewDueAt on approved state', () => {
    const parsed = RuleRecord.safeParse({
      ...baseRule,
      reviewDueAt: '2027-01-01T00:00:00.000Z',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects non-integer version', () => {
    const parsed = RuleRecord.safeParse({ ...baseRule, version: 1.5 })
    expect(parsed.success).toBe(false)
  })

  it('rejects version < 1', () => {
    const parsed = RuleRecord.safeParse({ ...baseRule, version: 0 })
    expect(parsed.success).toBe(false)
  })

  it('accepts all optional fields populated', () => {
    const parsed = RuleRecord.safeParse({
      ...baseRule,
      severity: 'warning',
      reviewDueAt: '2026-06-01T00:00:00.000Z',
      examples: { good: ['class X implements StepInterface'], bad: ['class X'] },
      verification: ['grep -r "implements StepInterface" src/Shop/Checkout/Steps'],
      evidenceRefs: ['PR-1234', 'ADR-007'],
      supersedes: ['podium.checkout.old-step-contract'],
      tags: ['architecture', 'checkout'],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects invalid reviewDueAt datetime', () => {
    const parsed = RuleRecord.safeParse({
      ...baseRule,
      state: 'experimental',
      reviewDueAt: 'tuesday',
    })
    expect(parsed.success).toBe(false)
  })

  it('permits distinct state and confidence combinations', () => {
    const candidateHighConf = RuleRecord.safeParse({
      ...baseRule,
      state: 'candidate',
      source: 'review_mined',
      confidence: 'high',
    })
    const experimentalMedConf = RuleRecord.safeParse({
      ...baseRule,
      state: 'experimental',
      confidence: 'medium',
      reviewDueAt: '2026-06-01T00:00:00.000Z',
    })
    expect(candidateHighConf.success).toBe(true)
    expect(experimentalMedConf.success).toBe(true)
  })
})
