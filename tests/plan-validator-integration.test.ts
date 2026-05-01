import { describe, it, expect } from 'vitest'
import type { RepoResolver } from '../src/resolvers/repo-resolver'
import type {
  DraftPlan,
  PlanValidationDeps,
  PlanValidatorOpts,
  PlanReviewResult,
} from '../src/checkers/plan-validator-types'
import type { CoChangeEntry, VolatilityEntry, RevertPathStat } from '../src/commit-mining/schema'
import type { GraphReader } from '../src/graphs/graph-reader'
import type { RuleRecord } from '../src/schemas/rule-schema'
import { validatePlan } from '../src/checkers/plan-validator'
import { laravelTestPaths } from '../src/profiles/laravel'

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const ALL_REPO_FILES = [
  'src/Shop/Checkout/Steps/AuthorizePayment.php',
  'src/Shop/Checkout/Steps/CreatePointsTransactions.php',
  'src/Shop/Webhooks/WebhookOrderEvent.php',
  'tests/Unit/Shop/Checkout/Steps/AuthorizePaymentTest.php',
]

function makeResolver(files: string[] = ALL_REPO_FILES): RepoResolver {
  const fileSet = new Set(files)
  const classMap = new Map<string, string>()
  for (const f of files) {
    const basename = f.split('/').pop()?.replace('.php', '') ?? ''
    if (/^[A-Z]/.test(basename)) classMap.set(basename, f)
  }
  return {
    fileExists: (p) => fileSet.has(p),
    findFileForClass: (cn) => classMap.get(cn.split('\\').pop() ?? cn) ?? null,
    findMethodKey: () => null,
  }
}

function makeCochangeEntries(): CoChangeEntry[] {
  return [
    {
      path: 'src/Shop/Checkout/Steps/AuthorizePayment.php',
      commitCount: 20,
      neighbors: [
        {
          path: 'src/Shop/Checkout/Steps/CreatePointsTransactions.php',
          jointCommits: 12,
          coupling: 0.85,
        },
      ],
    },
  ]
}

function makeVolatilityEntries(): VolatilityEntry[] {
  return [
    {
      path: 'src/Shop/Checkout/Steps/CreatePointsTransactions.php',
      commitCount: 30,
      lineDeltaAdded: 500,
      lineDeltaDeleted: 200,
      firstTouchedAt: '2024-01-01T00:00:00Z',
      lastTouchedAt: '2026-03-01T00:00:00Z',
      bugFixCommitCount: 5,
      bugFixDensity: 0.17,
      topAuthors: [{ nickname: 'dev1', commitCount: 15, lastTouchedAt: '2026-03-01T00:00:00Z' }],
      laravelVersionSpan: ['10'],
      riskScore: 0.78,
      riskBreakdown: {
        churnComponent: 0.3,
        bugDensityComponent: 0.2,
        ownershipFragmentationComponent: 0.18,
        recencyComponent: 0.1,
      },
    },
  ]
}

function makeRevertStats(): RevertPathStat[] {
  return [
    {
      path: 'src/Shop/Webhooks/WebhookOrderEvent.php',
      commitCount: 18,
      revertCount: 3,
      revertDensity: 0.17,
      medianDaysToRevert: 2,
      chainsInvolvingPath: 2,
      lastRevertedAt: '2026-03-15T00:00:00Z',
    },
  ]
}

function makePlan(overrides: Record<string, unknown> = {}): DraftPlan {
  const plan = {
    summary: 'Fix checkout flow',
    steps: [
      {
        description: 'Update authorize payment step',
        files: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
      },
      {
        description: 'Update webhook event',
        files: ['src/Shop/Webhooks/WebhookOrderEvent.php'],
      },
    ],
    riskFlags: [],
    ...overrides,
  }
  return { rawText: JSON.stringify(plan) }
}

function makeFullDeps(overrides: Partial<PlanValidationDeps> = {}): PlanValidationDeps {
  return {
    repoResolver: makeResolver(),
    graphReader: null,
    cochangeEntries: makeCochangeEntries(),
    volatilityEntries: makeVolatilityEntries(),
    revertStats: makeRevertStats(),
    rules: [],
    testPathStrategy: laravelTestPaths,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('plan-validator integration (full flow with real checkers)', () => {
  it('1. detects known omissions: co_change_gap for CreatePointsTransactions + missing_test for AuthorizePayment', async () => {
    // Plan has AuthorizePayment + WebhookOrderEvent but NOT CreatePointsTransactions or its test
    const deps = makeFullDeps()
    const result = await validatePlan(makePlan(), deps)

    // co_change_gap: CreatePointsTransactions is co-changed with AuthorizePayment but not in plan
    const cochangeIssues = result.issues.filter((i) => i.kind === 'co_change_gap')
    expect(cochangeIssues.length).toBeGreaterThanOrEqual(1)
    const cptGap = cochangeIssues.find((i) =>
      i.issueKey.includes('CreatePointsTransactions'),
    )
    expect(cptGap).toBeDefined()

    // missing_test: AuthorizePayment has a test file in repo but not in plan
    const missingTestIssues = result.issues.filter((i) => i.kind === 'missing_test')
    expect(missingTestIssues.length).toBeGreaterThanOrEqual(1)
    const authTest = missingTestIssues.find((i) =>
      i.issueKey.includes('AuthorizePayment'),
    )
    expect(authTest).toBeDefined()

    // suggestedPaths should include the missing co-change file
    expect(result.suggestedPaths).toContain(
      'src/Shop/Checkout/Steps/CreatePointsTransactions.php',
    )
  })

  it('2. no omissions when plan includes all 4 files', async () => {
    const plan = makePlan({
      steps: [
        {
          description: 'Update authorize payment',
          files: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        },
        {
          description: 'Update points transactions',
          files: ['src/Shop/Checkout/Steps/CreatePointsTransactions.php'],
        },
        {
          description: 'Update webhook',
          files: ['src/Shop/Webhooks/WebhookOrderEvent.php'],
        },
        {
          description: 'Update tests',
          files: ['tests/Unit/Shop/Checkout/Steps/AuthorizePaymentTest.php'],
        },
      ],
    })
    const deps = makeFullDeps()
    const result = await validatePlan(plan, deps)

    // No co_change_gap for CreatePointsTransactions (it is in plan)
    const cptGap = result.issues.find(
      (i) =>
        i.kind === 'co_change_gap' &&
        i.issueKey.includes('CreatePointsTransactions'),
    )
    expect(cptGap).toBeUndefined()

    // No missing_test for AuthorizePayment (test file is in plan)
    const authMissing = result.issues.find(
      (i) =>
        i.kind === 'missing_test' &&
        i.issueKey.includes('AuthorizePayment.php'),
    )
    expect(authMissing).toBeUndefined()
  })

  it('3. mixed severities are sorted severity desc', async () => {
    const deps = makeFullDeps()
    const result = await validatePlan(makePlan(), deps)

    // Verify issues sorted by severity descending
    const severityOrder: Record<string, number> = { critical: 2, warning: 1, info: 0 }
    for (let i = 1; i < result.issues.length; i++) {
      const prev = severityOrder[result.issues[i - 1].severity]
      const curr = severityOrder[result.issues[i].severity]
      expect(prev).toBeGreaterThanOrEqual(curr)
    }
  })

  it('4. graceful degradation when K deps are minimal (only resolver + empty arrays)', async () => {
    // cochange null-guards entries, revert null-guards both revertStats + volatility,
    // structural-gap null-guards graphReader. missing-test iterates volatilityEntries
    // without null-guard, so pass empty arrays for iterable fields.
    const deps: PlanValidationDeps = {
      repoResolver: makeResolver(),
      graphReader: null,
      cochangeEntries: null as unknown as CoChangeEntry[],
      volatilityEntries: [],
      revertStats: null as unknown as RevertPathStat[],
      rules: [],
    }

    const result = await validatePlan(makePlan(), deps)

    expect(result.stats.checkersSkipped).toBeGreaterThan(0)
    expect(result.skippedCheckers.length).toBeGreaterThan(0)
    // Each skipped checker should have id and reason
    for (const skipped of result.skippedCheckers) {
      expect(skipped.id).toBeTruthy()
      expect(skipped.reason).toBe('missing_dep')
    }
  })

  it('5. empty plan yields validation_limited info issue and verdict ok', async () => {
    const emptyPlan: DraftPlan = {
      rawText: JSON.stringify({ summary: '', steps: [], riskFlags: [] }),
    }
    const deps = makeFullDeps()
    const result = await validatePlan(emptyPlan, deps)

    const limitedIssue = result.issues.find((i) => i.kind === 'validation_limited')
    expect(limitedIssue).toBeDefined()
    expect(limitedIssue!.severity).toBe('info')

    // No blocking issues -> pass
    expect(result.verdict).toBe('pass')
  })

  it('6. determinism: same inputs produce identical issueKeys, verdict, suggestedPaths', async () => {
    const plan = makePlan()
    const deps = makeFullDeps()

    const run1 = await validatePlan(plan, deps)
    const run2 = await validatePlan(plan, deps)

    expect(run1.verdict).toBe(run2.verdict)
    expect(run1.issues.map((i) => i.issueKey)).toEqual(run2.issues.map((i) => i.issueKey))
    expect(run1.suggestedPaths).toEqual(run2.suggestedPaths)
    expect(run1.suggestedSymbols).toEqual(run2.suggestedSymbols)
    expect(run1.stats).toEqual(run2.stats)
  })

  it('7. kill switch: disabledCheckers removes cochange issues', async () => {
    const deps = makeFullDeps()
    const opts: PlanValidatorOpts = {
      disabledCheckers: ['cochange'],
    }
    const result = await validatePlan(makePlan(), deps, opts)

    const cochangeIssues = result.issues.filter((i) => i.kind === 'co_change_gap')
    expect(cochangeIssues).toHaveLength(0)

    expect(result.disabledCheckers).toContain('cochange')
    expect(result.stats.checkersDisabled).toBeGreaterThanOrEqual(1)
  })

  it('8. signal-absent: null-guarded deps null, iterables empty -> high checkersSkipped', async () => {
    // cochange null-guards entries; revert null-guards both arrays;
    // structural-gap null-guards graphReader; missing-test iterates volatilityEntries.
    const deps: PlanValidationDeps = {
      repoResolver: makeResolver(),
      graphReader: null,
      cochangeEntries: null as unknown as CoChangeEntry[],
      volatilityEntries: [],
      revertStats: null as unknown as RevertPathStat[],
      rules: null as unknown as RuleRecord[],
    }

    const result = await validatePlan(makePlan(), deps)

    // cochange (null entries), revert (null both), structural-gap (null graphReader) -> 3 skipped
    expect(result.stats.checkersSkipped).toBeGreaterThanOrEqual(2)
    expect(result.skippedCheckers.length).toBeGreaterThanOrEqual(2)

    const skippedIds = result.skippedCheckers.map((s) => s.id)
    expect(skippedIds).toContain('cochange')
    expect(skippedIds).toContain('structural-gap')
  })

  it('9. suppression + dampening interaction: suppress revert_risk by kind, dampen structural_gap for webhook path', async () => {
    const deps = makeFullDeps()

    const opts: PlanValidatorOpts = {
      riskFlags: ['Unstable area around src/Shop/Webhooks/WebhookOrderEvent.php already known'],
      suppressions: {
        kinds: ['revert_risk'],
      },
    }
    const result = await validatePlan(makePlan(), deps, opts)

    // All revert_risk issues suppressed
    const revertIssues = result.issues.filter((i) => i.kind === 'revert_risk')
    expect(revertIssues).toHaveLength(0)
    expect(result.suppressedIssueCount).toBeGreaterThanOrEqual(1)

    // Any remaining issues for WebhookOrderEvent path should be dampened to info
    // (riskFlags mention the webhook path -> dampening applies)
    const webhookIssues = result.issues.filter(
      (i) =>
        i.relatedPaths?.some((p) =>
          p.includes('WebhookOrderEvent'),
        ) && i.kind !== 'revert_risk',
    )
    for (const issue of webhookIssues) {
      expect(issue.severity).toBe('info')
    }
  })
})
