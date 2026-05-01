import { describe, it, expect } from 'vitest'
import {
  SEVERITY_ORDER,
  CHECKER_IDS,
  CHECKER_PRIORITY,
  DEFAULT_MAX_ISSUES_IN_RERUN,
  DEFAULT_EVIDENCE_CAP,
  normalizePath,
  makeIssueKey,
  capEvidence,
  type PlanIssueSeverity,
  type PlanIssueKind,
  type PlanIssue,
  type CheckerResult,
  type PlanChecker,
  type PlanReviewResult,
  type DraftPlan,
  type PlannedFileRef,
  type PlannedSymbolRef,
  type ParsedPlan,
  type PlanValidationContext,
  type PlanValidationDeps,
  type PlanValidatorOpts,
  type PlannerResultWithReview,
  type TestPathStrategy,
  type CheckerId,
} from '../src/checkers/plan-validator-types'

describe('SEVERITY_ORDER', () => {
  it('orders critical > warning > info', () => {
    expect(SEVERITY_ORDER.critical).toBeGreaterThan(SEVERITY_ORDER.warning)
    expect(SEVERITY_ORDER.warning).toBeGreaterThan(SEVERITY_ORDER.info)
  })
})

describe('CHECKER_IDS', () => {
  it('contains all canonical IDs', () => {
    expect(CHECKER_IDS).toContain('missing-test')
    expect(CHECKER_IDS).toContain('cochange')
    expect(CHECKER_IDS).toContain('revert')
    expect(CHECKER_IDS).toContain('rule')
    expect(CHECKER_IDS).toContain('structural-gap')
  })
})

describe('CHECKER_PRIORITY', () => {
  it('orders missing-test first, structural-gap last', () => {
    expect(CHECKER_PRIORITY['missing-test']).toBeGreaterThan(CHECKER_PRIORITY['cochange'])
    expect(CHECKER_PRIORITY['cochange']).toBeGreaterThan(CHECKER_PRIORITY['revert'])
    expect(CHECKER_PRIORITY['revert']).toBeGreaterThan(CHECKER_PRIORITY['rule'])
    expect(CHECKER_PRIORITY['rule']).toBeGreaterThan(CHECKER_PRIORITY['structural-gap'])
  })
})

describe('normalizePath', () => {
  it('collapses backslashes to forward slashes', () => {
    expect(normalizePath('src\\Shop\\Foo.php')).toBe('src/Shop/Foo.php')
  })
  it('strips leading ./', () => {
    expect(normalizePath('./src/Foo.php')).toBe('src/Foo.php')
  })
  it('strips leading /', () => {
    expect(normalizePath('/src/Foo.php')).toBe('src/Foo.php')
  })
  it('strips trailing /', () => {
    expect(normalizePath('src/Shop/')).toBe('src/Shop')
  })
  it('collapses repeated slashes', () => {
    expect(normalizePath('src//Shop///Foo.php')).toBe('src/Shop/Foo.php')
  })
  it('strips Windows drive prefix', () => {
    expect(normalizePath('C:\\src\\Foo.php')).toBe('src/Foo.php')
  })
  it('trims backticks', () => {
    expect(normalizePath('`src/Foo.php`')).toBe('src/Foo.php')
  })
  it('trims quotes', () => {
    expect(normalizePath('"src/Foo.php"')).toBe('src/Foo.php')
  })
  it('preserves case', () => {
    expect(normalizePath('src/Shop/AuthorizePayment.php')).toBe('src/Shop/AuthorizePayment.php')
  })
  it('handles empty string', () => {
    expect(normalizePath('')).toBe('')
  })
})

describe('makeIssueKey', () => {
  it('builds cochange key', () => {
    expect(makeIssueKey('co_change_gap', 'cochange', 'src/A.php')).toBe('co_change_gap:cochange:src/A.php')
  })
  it('builds rule key with ruleId', () => {
    expect(makeIssueKey('rule_risk', 'rule', 'rule-42:src/B.php')).toBe('rule_risk:rule:rule-42:src/B.php')
  })
})

describe('capEvidence', () => {
  it('returns unchanged if under cap', () => {
    expect(capEvidence(['a', 'b'], 5)).toEqual(['a', 'b'])
  })
  it('truncates and adds count', () => {
    const result = capEvidence(['a', 'b', 'c', 'd', 'e', 'f'], 3)
    expect(result).toHaveLength(4)
    expect(result[3]).toContain('3 more')
  })
})
