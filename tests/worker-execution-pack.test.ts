import { describe, it, expect } from 'vitest'
import type { RepoResolver } from '../src/resolvers/repo-resolver'
import type {
  CoChangeEntry,
  VolatilityEntry,
  RevertPathStat,
} from '../src/commit-mining/schema'
import type { PlanReviewResult, DraftPlan } from '../src/checkers/plan-validator-types'
import type { RuleRecord } from '../src/schemas/rule-schema'
import {
  buildWorkerExecutionPack,
  renderWorkerExecutionPackMarkdown,
} from '../src/worker/execution-pack'

const FILES = [
  'src/Shop/Checkout/Steps/AuthorizePayment.php',
  'src/Shop/Checkout/Steps/CreatePointsTransactions.php',
  'tests/Unit/Shop/Checkout/AuthorizePaymentTest.php',
]

function makeResolver(): RepoResolver {
  const fileSet = new Set(FILES)
  const classMap = new Map<string, string>([
    ['AuthorizePayment', FILES[0]],
    ['CreatePointsTransactions', FILES[1]],
  ])
  return {
    fileExists: (p) => fileSet.has(p),
    findFileForClass: (cn) => classMap.get(cn.split('\\').pop() ?? cn) ?? null,
    findMethodKey: () => null,
  }
}

function makeVolatility(): VolatilityEntry[] {
  return [
    {
      path: FILES[0],
      commitCount: 25,
      lineDeltaAdded: 400,
      lineDeltaDeleted: 100,
      firstTouchedAt: '2024-01-01T00:00:00Z',
      lastTouchedAt: '2026-03-01T00:00:00Z',
      bugFixCommitCount: 6,
      bugFixDensity: 0.24,
      topAuthors: [{ nickname: 'dev1', commitCount: 10, lastTouchedAt: '2026-03-01T00:00:00Z' }],
      laravelVersionSpan: ['10'],
      riskScore: 0.82,
      riskBreakdown: {
        churnComponent: 0.3,
        bugDensityComponent: 0.2,
        ownershipFragmentationComponent: 0.2,
        recencyComponent: 0.12,
      },
    },
  ]
}

function makeCochange(): CoChangeEntry[] {
  return [
    {
      path: FILES[0],
      commitCount: 25,
      neighbors: [
        { path: FILES[1], jointCommits: 12, coupling: 0.85 },
      ],
    },
  ]
}

function makeReverts(): RevertPathStat[] {
  return [
    {
      path: FILES[0],
      commitCount: 25,
      revertCount: 2,
      revertDensity: 0.08,
      medianDaysToRevert: 3,
      chainsInvolvingPath: 1,
      lastRevertedAt: '2026-02-01T00:00:00Z',
    },
  ]
}

function makeReview(): PlanReviewResult {
  return {
    verdict: 'warn',
    issues: [
      {
        issueKey: 'k1',
        severity: 'warning',
        confidence: 0.9,
        kind: 'missing_test',
        message: 'No test update for AuthorizePayment',
        evidence: [],
        checkerId: 'missing-test',
        relatedPaths: [FILES[0]],
      },
      {
        issueKey: 'k2',
        severity: 'critical',
        confidence: 0.95,
        kind: 'rule_risk',
        message: 'Plan modifies frozen file',
        evidence: [],
        checkerId: 'rule',
        relatedPaths: [FILES[0]],
        ruleId: 'frozen-file',
      },
      {
        issueKey: 'k3',
        severity: 'info',
        confidence: 0.5,
        kind: 'validation_limited',
        message: 'should be filtered',
        evidence: [],
        checkerId: 'missing-test',
      },
    ],
    suggestedPaths: [],
    suggestedSymbols: [],
    groupedByPath: {},
    stats: { checkersAttempted: 6, checkersRun: 6, checkersSkipped: 0, checkersDisabled: 0 },
    skippedCheckers: [],
    disabledCheckers: [],
    suppressedIssueCount: 0,
  }
}

const draft: DraftPlan = {
  rawText: 'Modify src/Shop/Checkout/Steps/AuthorizePayment.php to add new validation.',
  sourceLabel: 'test',
}

describe('buildWorkerExecutionPack', () => {
  it('returns narrow JSON pack with target paths + symbols', async () => {
    const pack = await buildWorkerExecutionPack(draft, {
      repoResolver: makeResolver(),
      repoRoot: '/tmp/repo-not-real',
      coChangeEntries: makeCochange(),
      volatilityEntries: makeVolatility(),
      revertStats: makeReverts(),
      graphReader: null,
      rules: [],
    })

    expect(pack.targetPaths).toContain(FILES[0])
    expect(pack.applicableRules).toEqual([])
    expect(pack.graphContext).toBe('')
  })

  it('populates historical signals from volatility/cochange/reverts', async () => {
    const pack = await buildWorkerExecutionPack(draft, {
      repoResolver: makeResolver(),
      repoRoot: '/tmp/repo-not-real',
      coChangeEntries: makeCochange(),
      volatilityEntries: makeVolatility(),
      revertStats: makeReverts(),
    })
    expect(pack.historicalSignals.length).toBeGreaterThan(0)
    expect(pack.historicalSignals[0]).toContain(FILES[0])
    expect(pack.historicalSignals[0]).toContain('risk=')
    expect(pack.historicalSignals[0]).toContain('reverted')
    expect(pack.historicalSignals[0]).toContain('cochange')
  })

  it('forwards critical+warning review issues, drops info', async () => {
    const pack = await buildWorkerExecutionPack(draft, {
      repoResolver: makeResolver(),
      repoRoot: '/tmp/repo-not-real',
      coChangeEntries: [],
      volatilityEntries: [],
      revertStats: [],
      validationResult: makeReview(),
    })
    expect(pack.reviewWarnings.length).toBe(2)
    expect(pack.reviewWarnings[0]).toMatch(/^\[critical\//)
    expect(pack.reviewWarnings[1]).toMatch(/^\[warning\//)
    expect(pack.reviewWarnings.join('\n')).not.toContain('should be filtered')
  })

  it('filters rules by appliesTo + scope.globs + state', async () => {
    const rules: RuleRecord[] = [
      {
        id: 'r1',
        title: 'Use repository pattern',
        state: 'approved',
        source: 'human',
        appliesTo: ['implementer'],
        scope: { globs: ['src/Shop/**/*.php'] },
        confidence: 'high',
        version: 1,
        rationale: 'consistency',
        guidance: 'Inject repos via constructor',
      },
      {
        id: 'r2',
        title: 'Reviewer-only',
        state: 'approved',
        source: 'human',
        appliesTo: ['reviewer'],
        scope: {},
        confidence: 'high',
        version: 1,
        rationale: '',
        guidance: 'ignored',
      },
      {
        id: 'r3',
        title: 'Out of scope',
        state: 'approved',
        source: 'human',
        appliesTo: ['implementer'],
        scope: { globs: ['app/Services/**/*.php'] },
        confidence: 'high',
        version: 1,
        rationale: '',
        guidance: 'ignored',
      },
      {
        id: 'r4',
        title: 'Deprecated',
        state: 'deprecated',
        source: 'human',
        appliesTo: ['implementer'],
        scope: {},
        confidence: 'high',
        version: 1,
        rationale: '',
        guidance: 'ignored',
      },
    ]
    const pack = await buildWorkerExecutionPack(draft, {
      repoResolver: makeResolver(),
      repoRoot: '/tmp/repo-not-real',
      coChangeEntries: [],
      volatilityEntries: [],
      revertStats: [],
      rules,
    })
    expect(pack.applicableRules.length).toBe(1)
    expect(pack.applicableRules[0]).toContain('[r1]')
  })
})

describe('renderWorkerExecutionPackMarkdown', () => {
  it('renders sections only for non-empty fields', () => {
    const md = renderWorkerExecutionPackMarkdown({
      targetPaths: ['a.php'],
      targetSymbols: [],
      applicableRules: [],
      historicalSignals: ['line1'],
      complexitySignals: [],
      graphContext: '',
      reviewWarnings: ['[critical/rule] X'],
    })
    expect(md).toContain('# Worker Execution Pack')
    expect(md).toContain('## Target Files')
    expect(md).not.toContain('## Target Symbols')
    expect(md).toContain('## Historical Signals')
    expect(md).toContain('## Plan Review Warnings')
    expect(md).not.toContain('## Complexity Signals')
  })
})
