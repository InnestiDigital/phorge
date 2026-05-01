import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync, statSync as fsStat } from 'node:fs'
import { resolve, join } from 'node:path'
import { validatePlan } from '../src/checkers/plan-validator'
import type {
  DraftPlan,
  PlanValidationDeps,
  PlanIssueKind,
} from '../src/checkers/plan-validator-types'
import type { RepoResolver } from '../src/resolvers/repo-resolver'
import type {
  CoChangeEntry,
  VolatilityEntry,
  RevertPathStat,
} from '../src/commit-mining/schema'
import { createGraphReader } from '../src/graphs/graph-reader'
import type { GraphNode, GraphEdge } from '../src/graphs/schema'
import { RuleRecord } from '../src/schemas/rule-schema'
import { loadRulesFromDirs } from '../src/cli/rules-loader'
import { laravelTestPaths } from '../src/profiles/laravel'

const FIXTURE_ROOT = resolve(__dirname, 'fixtures/validate-plan')
const REPO_ROOT = join(FIXTURE_ROOT, 'realistic-laravel-repo')
const RULES_DIR = join(FIXTURE_ROOT, 'realistic-rules')
const PLAN_PATH = join(FIXTURE_ROOT, 'realistic-plan.txt')

const CONTROLLER = 'app/Http/Controllers/OrderController.php'
const SERVICE = 'app/Services/OrderService.php'
const JOB = 'app/Jobs/ProcessOrderJob.php'
const TEST_FILE = 'tests/Feature/Services/OrderServiceTest.php'

function passthroughResolver(repoRoot: string): RepoResolver {
  return {
    fileExists: (path: string) => {
      const full = resolve(repoRoot, path)
      try {
        return existsSync(full) && fsStat(full).isFile()
      } catch {
        return false
      }
    },
    findFileForClass: () => null,
    findMethodKey: () => null,
  }
}

function buildDeps(rules: RuleRecord[]): PlanValidationDeps {
  // --- Volatility: SERVICE is high-risk; CONTROLLER is moderate. ---
  const volatilityEntries: VolatilityEntry[] = [
    {
      path: SERVICE,
      commitCount: 22,
      lineDeltaAdded: 800,
      lineDeltaDeleted: 400,
      firstTouchedAt: '2024-01-01T00:00:00.000Z',
      lastTouchedAt: '2025-09-01T00:00:00.000Z',
      bugFixCommitCount: 10,
      bugFixDensity: 0.45,
      topAuthors: [
        { nickname: 'alice', commitCount: 12, lastTouchedAt: '2025-09-01T00:00:00.000Z' },
      ],
      laravelVersionSpan: ['10.x'],
      riskScore: 0.82,
      riskBreakdown: {
        churnComponent: 0.7,
        bugDensityComponent: 0.6,
        ownershipFragmentationComponent: 0.3,
        recencyComponent: 0.8,
      },
    },
    {
      path: CONTROLLER,
      commitCount: 8,
      lineDeltaAdded: 120,
      lineDeltaDeleted: 60,
      firstTouchedAt: '2024-01-01T00:00:00.000Z',
      lastTouchedAt: '2025-09-01T00:00:00.000Z',
      bugFixCommitCount: 2,
      bugFixDensity: 0.25,
      topAuthors: [
        { nickname: 'alice', commitCount: 8, lastTouchedAt: '2025-09-01T00:00:00.000Z' },
      ],
      laravelVersionSpan: ['10.x'],
      riskScore: 0.4,
      riskBreakdown: {
        churnComponent: 0.4,
        bugDensityComponent: 0.3,
        ownershipFragmentationComponent: 0.2,
        recencyComponent: 0.5,
      },
    },
  ]

  // --- Revert stats: SERVICE has critical revert risk. ---
  const recentDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const revertStats: RevertPathStat[] = [
    {
      path: SERVICE,
      commitCount: 22,
      revertCount: 3,
      revertDensity: 0.18,
      medianDaysToRevert: 4,
      chainsInvolvingPath: 1,
      lastRevertedAt: recentDate,
    },
  ]

  // --- Co-change: CONTROLLER strongly co-changes with TEST_FILE. ---
  const cochangeEntries: CoChangeEntry[] = [
    {
      path: CONTROLLER,
      commitCount: 8,
      neighbors: [
        { path: TEST_FILE, jointCommits: 6, coupling: 0.85 },
      ],
    },
    {
      path: SERVICE,
      commitCount: 22,
      neighbors: [
        { path: TEST_FILE, jointCommits: 7, coupling: 0.7 },
      ],
    },
  ]

  // --- Graph: file:CONTROLLER --[controller_dispatches_job]--> file:JOB ---
  const nodes: GraphNode[] = [
    { key: `file:${CONTROLLER}`, kind: 'file', name: 'OrderController.php', filePath: CONTROLLER },
    { key: `file:${SERVICE}`, kind: 'file', name: 'OrderService.php', filePath: SERVICE },
    { key: `file:${JOB}`, kind: 'file', name: 'ProcessOrderJob.php', filePath: JOB },
  ]
  const edges: GraphEdge[] = [
    {
      from: `file:${CONTROLLER}`,
      to: `file:${JOB}`,
      kind: 'controller_dispatches_job',
      confidence: 'exact',
      source: 'laravel_scanner',
    },
  ]
  const graphReader = createGraphReader(nodes, edges)

  return {
    repoResolver: passthroughResolver(REPO_ROOT),
    graphReader,
    cochangeEntries,
    volatilityEntries,
    revertStats,
    rules,
    repoRoot: REPO_ROOT,
    testPathStrategy: laravelTestPaths,
  }
}

describe('validatePlan end-to-end against realistic Laravel fixture', () => {
  let rules: RuleRecord[]
  let plan: DraftPlan

  beforeAll(async () => {
    rules = await loadRulesFromDirs([RULES_DIR])
    // Hard validation — fail loudly if a fixture rule frontmatter drifts.
    for (const r of rules) {
      RuleRecord.parse(r)
    }
    plan = { rawText: readFileSync(PLAN_PATH, 'utf-8'), sourceLabel: 'realistic-plan' }
  })

  it('loads exactly the two rules whose frontmatter is valid', () => {
    expect(rules).toHaveLength(2)
    const ids = rules.map((r) => r.id).sort()
    expect(ids).toEqual(['rule-mail-templates', 'rule-services-need-tests'])
  })

  it('returns verdict "revise" with issues from every checker that should fire', async () => {
    const deps = buildDeps(rules)
    const result = await validatePlan(plan, deps)

    // High-level verdict
    expect(result.verdict, `expected revise, got ${result.verdict}. issues: ${JSON.stringify(result.issues.map(i => ({ kind: i.kind, sev: i.severity, msg: i.message })), null, 2)}`).toBe('revise')

    // Total issue count: at least 6 (one per checker that should fire).
    expect(result.issues.length, 'expected >5 issues from full pipeline').toBeGreaterThan(5)

    // Each expected issue kind is present, with informative diagnostics on failure.
    const kinds = new Set(result.issues.map((i) => i.kind))
    const expectedKinds: PlanIssueKind[] = [
      'co_change_gap',
      'revert_risk',
      'rule_risk',
      'structural_gap', // emitted by both structural-gap and complexity checkers
      'missing_test',
    ]
    for (const k of expectedKinds) {
      expect(kinds.has(k), `missing issue kind "${k}". got: ${[...kinds].join(', ')}`).toBe(true)
    }

    // Each checker that should fire produced at least one issue.
    const checkerIds = new Set(result.issues.map((i) => i.checkerId))
    for (const c of ['cochange', 'revert', 'rule', 'structural-gap', 'complexity', 'missing-test'] as const) {
      expect(checkerIds.has(c), `expected checker "${c}" to fire. fired: ${[...checkerIds].join(', ')}`).toBe(true)
    }

    // Spot-check: messages reference the right files.
    const cochangeIssue = result.issues.find((i) => i.checkerId === 'cochange')!
    expect(cochangeIssue.message).toContain(TEST_FILE)

    const structuralIssue = result.issues.find((i) => i.checkerId === 'structural-gap')!
    expect(structuralIssue.message).toContain(JOB)

    const revertIssue = result.issues.find((i) => i.checkerId === 'revert')!
    expect(revertIssue.relatedPaths).toContain(SERVICE)

    const ruleIssue = result.issues.find((i) => i.checkerId === 'rule')!
    expect(ruleIssue.ruleId).toBe('rule-services-need-tests')
    expect(ruleIssue.relatedPaths).toContain(SERVICE)

    const complexityIssue = result.issues.find((i) => i.checkerId === 'complexity')!
    expect(complexityIssue.relatedPaths).toContain(SERVICE)

    const missingTestIssue = result.issues.find((i) => i.checkerId === 'missing-test')!
    // Test file exists in repo but not in plan -> should reference the test path.
    expect(missingTestIssue.relatedPaths?.some((p) => p === TEST_FILE)).toBe(true)

    // No checker should be skipped (all deps provided).
    expect(result.skippedCheckers).toEqual([])
  })

  it('honors suppressions to hide a checker family of issues', async () => {
    const deps = buildDeps(rules)
    const baseline = await validatePlan(plan, deps)
    const cochangeBaseline = baseline.issues.filter((i) => i.kind === 'co_change_gap').length
    expect(cochangeBaseline).toBeGreaterThan(0)

    const suppressed = await validatePlan(plan, deps, {
      suppressions: { kinds: ['co_change_gap'] },
    })
    const cochangeAfter = suppressed.issues.filter((i) => i.kind === 'co_change_gap').length
    expect(cochangeAfter).toBe(0)
    expect(suppressed.suppressedIssueCount).toBe(cochangeBaseline)
    // Other kinds remain.
    expect(suppressed.issues.some((i) => i.kind === 'revert_risk')).toBe(true)
  })

  it('handles an empty plan with the validation_limited info path', async () => {
    const deps = buildDeps(rules)
    const emptyPlan: DraftPlan = {
      rawText: JSON.stringify({ summary: 'noop', steps: [] }),
      sourceLabel: 'empty-plan',
    }
    const result = await validatePlan(emptyPlan, deps)

    const limited = result.issues.find((i) => i.kind === 'validation_limited')
    expect(limited, 'expected a validation_limited issue for empty plan').toBeDefined()
    expect(limited!.severity).toBe('info')
    // No critical/warning issues from any checker (nothing to chew on).
    expect(result.issues.every((i) => i.severity === 'info')).toBe(true)
    expect(result.verdict).toBe('pass')
  })
})
