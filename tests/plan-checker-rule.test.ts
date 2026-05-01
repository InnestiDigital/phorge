import { describe, it, expect } from 'vitest'
import type {
  PlanValidationContext,
  ParsedPlan,
  PlannedFileRef,
  PlanValidationDeps,
  PlanValidatorOpts,
} from '../src/checkers/plan-validator-types'
import { normalizePath } from '../src/checkers/plan-validator-types'
import { ruleChecker } from '../src/checkers/plan-checker-rule'
import type { RuleRecord } from '../src/schemas/rule-schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides?: Partial<RuleRecord>): RuleRecord {
  return {
    id: 'rule-001',
    title: 'Always include migration tests',
    state: 'approved',
    source: 'human',
    appliesTo: ['validator'],
    scope: { globs: ['src/**/*.php'] },
    confidence: 'medium',
    version: 1,
    rationale: 'Migrations without tests are risky.',
    guidance: 'Add a test for every migration.',
    ...overrides,
  }
}

function makeCtx(
  plannedPaths: string[],
  rules: RuleRecord[],
  opts?: Partial<PlanValidatorOpts>,
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
    volatilityEntries: [],
    revertStats: [],
    rules,
  }

  return { parsed, deps, opts: opts ?? {} }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ruleChecker', () => {
  it('has correct id and strength', () => {
    expect(ruleChecker.id).toBe('rule')
    expect(ruleChecker.strength).toBe(2)
  })

  it('emits issue for approved rule with matching glob', async () => {
    const rule = makeRule()
    const ctx = makeCtx(['src/Shop/Order.php'], [rule])

    const result = await ruleChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].kind).toBe('rule_risk')
    expect(result.issues[0].severity).toBe('warning')
    expect(result.issues[0].checkerId).toBe('rule')
    expect(result.issues[0].ruleId).toBe('rule-001')
    expect(result.issues[0].message).toMatch(
      /^Applicable approved rule surfaced for review; validator did not verify compliance\./,
    )
    expect(result.issues[0].issueKey).toBe(
      'rule_risk:rule:rule-001:src/Shop/Order.php',
    )
    expect(result.issues[0].relatedPaths).toContain('src/Shop/Order.php')
  })

  it('skips rule with appliesTo not including validator', async () => {
    const rule = makeRule({ appliesTo: ['planner'] })
    const ctx = makeCtx(['src/Shop/Order.php'], [rule])

    const result = await ruleChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })

  it('skips rule with scope.repos not matching current repo', async () => {
    const rule = makeRule({ scope: { repos: ['reach-api'], globs: ['src/**/*.php'] } })
    const ctx = makeCtx(['src/Shop/Order.php'], [rule], { repoName: 'podium.api' })

    const result = await ruleChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })

  it('caps severity at warning even if rule.severity is critical', async () => {
    const rule = makeRule({ severity: 'critical' })
    const ctx = makeCtx(['src/Shop/Order.php'], [rule])

    const result = await ruleChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('warning')
  })

  it('assigns high confidence for security-tagged rules', async () => {
    const rule = makeRule({ tags: ['security', 'auth'] })
    const ctx = makeCtx(['src/Shop/Order.php'], [rule])

    const result = await ruleChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('warning')
    expect(result.issues[0].confidence).toBe(0.7)
  })

  it('returns empty issues when no rules provided', async () => {
    const ctx = makeCtx(['src/Shop/Order.php'], [])

    const result = await ruleChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
    expect(result.skipped).toBeUndefined()
  })

  it('aggregates multiple matched files into one issue per ruleId', async () => {
    const rule = makeRule({ scope: { globs: ['src/**/*.php'] } })
    const ctx = makeCtx(
      ['src/Shop/Order.php', 'src/Shop/Payment.php'],
      [rule],
    )

    const result = await ruleChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].ruleId).toBe('rule-001')
    // relatedPaths contains both files
    expect(result.issues[0].relatedPaths).toContain('src/Shop/Order.php')
    expect(result.issues[0].relatedPaths).toContain('src/Shop/Payment.php')
    // issueKey uses first sorted file
    expect(result.issues[0].issueKey).toBe(
      'rule_risk:rule:rule-001:src/Shop/Order.php',
    )
    // Evidence aggregated
    expect(result.issues[0].evidence.length).toBeGreaterThanOrEqual(1)
  })
})
