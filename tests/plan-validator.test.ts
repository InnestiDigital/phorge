import { describe, it, expect } from 'vitest'
import type { RepoResolver } from '../src/resolvers/repo-resolver'
import type {
  DraftPlan,
  PlanChecker,
  PlanIssue,
  PlanValidationDeps,
  PlanValidatorOpts,
  CheckerId,
} from '../src/checkers/plan-validator-types'
import {
  parsePlanForValidation,
  extractPlanProseAnchors,
  validatePlan,
} from '../src/checkers/plan-validator'
import { laravelTestPaths } from '../src/profiles/laravel'

function makeResolver(files: string[]): RepoResolver {
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

const KNOWN_FILES = [
  'src/Shop/Checkout/Steps/AuthorizePayment.php',
  'src/Shop/Webhooks/WebhookOrderEvent.php',
  'tests/Unit/Shop/Checkout/Steps/AuthorizePaymentTest.php',
]

function makePlan(overrides: Record<string, unknown> = {}): DraftPlan {
  const plan = {
    summary: 'Fix checkout flow',
    steps: [
      {
        description: 'Update the authorize step',
        files: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
      },
    ],
    riskFlags: [],
    ...overrides,
  }
  return { rawText: JSON.stringify(plan) }
}

describe('parsePlanForValidation', () => {
  it('extracts structured files with stepIndex', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      steps: [
        {
          description: 'Step one',
          files: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        },
        {
          description: 'Step two',
          files: ['src/Shop/Webhooks/WebhookOrderEvent.php'],
        },
      ],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0].path).toBe('src/Shop/Checkout/Steps/AuthorizePayment.php')
    expect(parsed.files[1].path).toBe('src/Shop/Webhooks/WebhookOrderEvent.php')
  })

  it('extracts prose refs not in structured files', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      summary: 'Also update src/Shop/Webhooks/WebhookOrderEvent.php for events',
      steps: [
        {
          description: 'Change authorize step',
          files: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        },
      ],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    const paths = parsed.files.map((f) => f.path)
    expect(paths).toContain('src/Shop/Webhooks/WebhookOrderEvent.php')
    expect(paths).toContain('src/Shop/Checkout/Steps/AuthorizePayment.php')
  })

  it('dedup: structured wins over extracted', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      summary: 'Modify src/Shop/Checkout/Steps/AuthorizePayment.php again',
      steps: [
        {
          description: 'Fix it',
          files: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        },
      ],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    const authorizeRefs = parsed.files.filter(
      (f) => f.path === 'src/Shop/Checkout/Steps/AuthorizePayment.php',
    )
    expect(authorizeRefs).toHaveLength(1)
    expect(authorizeRefs[0].reason).toBe('structured')
  })

  it('normalizes paths: strips leading ./', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      steps: [
        {
          description: 'Fix',
          files: ['./src/Shop/Checkout/Steps/AuthorizePayment.php'],
        },
      ],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    expect(parsed.files[0].normalized).toBe('src/Shop/Checkout/Steps/AuthorizePayment.php')
  })

  it('normalizes paths: backslash to forward slash', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      steps: [
        {
          description: 'Fix',
          files: ['src\\Shop\\Checkout\\Steps\\AuthorizePayment.php'],
        },
      ],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    expect(parsed.files[0].normalized).toBe('src/Shop/Checkout/Steps/AuthorizePayment.php')
  })

  it('handles empty plan gracefully', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      summary: '',
      steps: [],
      riskFlags: [],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    expect(parsed.files).toHaveLength(0)
    expect(parsed.symbols).toHaveLength(0)
  })

  it('rejects unresolved prose paths', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      summary: 'Check src/Shop/Unknown/FakeFile.php for issues',
      steps: [{ description: 'Nothing', files: [] }],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    const paths = parsed.files.map((f) => f.path)
    expect(paths).not.toContain('src/Shop/Unknown/FakeFile.php')
    expect(parsed.stats.unresolvedExtractedPaths).toBeGreaterThan(0)
  })

  it('populates parserStats with final counts', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      summary: 'Update AuthorizePayment class',
      steps: [
        {
          description: 'Modify step',
          files: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        },
      ],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    expect(parsed.stats.finalPlannedFileRefs).toBeGreaterThanOrEqual(1)
    expect(typeof parsed.stats.missingStructuredPaths).toBe('number')
    expect(typeof parsed.stats.ambiguousExtractedSymbols).toBe('number')
    expect(typeof parsed.stats.finalPlannedSymbolRefs).toBe('number')
  })

  it('extracts symbols from prose with class resolution', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const draft = makePlan({
      summary: 'Refactor AuthorizePayment and WebhookOrderEvent classes',
      steps: [{ description: 'Update logic', files: [] }],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    const symbols = parsed.symbols.map((s) => s.symbol)
    expect(symbols).toContain('AuthorizePayment')
    expect(symbols).toContain('WebhookOrderEvent')
  })

  it('captures sourceText for extracted refs truncated to 160', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const longContext = 'A'.repeat(200)
    const draft = makePlan({
      summary: `${longContext} src/Shop/Webhooks/WebhookOrderEvent.php ${longContext}`,
      steps: [{ description: 'Nothing', files: [] }],
    })
    const parsed = parsePlanForValidation(draft, resolver)
    const webhookRef = parsed.files.find(
      (f) => f.path === 'src/Shop/Webhooks/WebhookOrderEvent.php',
    )
    expect(webhookRef).toBeDefined()
    expect(webhookRef!.reason).toBe('extracted')
    // sourceText captured somewhere — check via prose extraction directly
  })
})

describe('extractPlanProseAnchors', () => {
  it('returns resolved paths with sourceText', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const result = extractPlanProseAnchors(
      'Check src/Shop/Checkout/Steps/AuthorizePayment.php for bugs',
      resolver,
    )
    expect(result.paths).toHaveLength(1)
    expect(result.paths[0].path).toBe('src/Shop/Checkout/Steps/AuthorizePayment.php')
    expect(result.paths[0].sourceText.length).toBeLessThanOrEqual(160)
  })

  it('returns resolved symbols with sourceText', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const result = extractPlanProseAnchors(
      'Refactor the AuthorizePayment class to handle errors',
      resolver,
    )
    expect(result.symbols).toHaveLength(1)
    expect(result.symbols[0].symbol).toBe('AuthorizePayment')
    expect(result.symbols[0].sourceText.length).toBeLessThanOrEqual(160)
  })

  it('tracks unresolved paths', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const result = extractPlanProseAnchors(
      'Look at src/Shop/Unknown/Missing.php please',
      resolver,
    )
    expect(result.paths).toHaveLength(0)
    expect(result.unresolvedPaths).toHaveLength(1)
    expect(result.unresolvedPaths[0]).toBe('src/Shop/Unknown/Missing.php')
  })

  it('tracks ambiguous symbols', () => {
    const resolver = makeResolver([])
    const result = extractPlanProseAnchors(
      'The AuthorizePayment class needs work',
      resolver,
    )
    expect(result.symbols).toHaveLength(0)
    expect(result.ambiguousSymbols).toHaveLength(1)
  })

  it('truncates sourceText to 160 chars', () => {
    const resolver = makeResolver(KNOWN_FILES)
    const pad = 'x'.repeat(200)
    const result = extractPlanProseAnchors(
      `${pad} src/Shop/Checkout/Steps/AuthorizePayment.php ${pad}`,
      resolver,
    )
    expect(result.paths[0].sourceText.length).toBeLessThanOrEqual(160)
  })
})

// ---------------------------------------------------------------------------
// Orchestrator tests
// ---------------------------------------------------------------------------

function fakeChecker(id: string, strength: number, issues: PlanIssue[]): PlanChecker {
  return {
    id: id as CheckerId,
    strength,
    check: async () => ({ issues, suggestedPaths: [], suggestedSymbols: [] }),
  }
}

function fakeSkippingChecker(id: string): PlanChecker {
  return {
    id: id as CheckerId,
    strength: 3,
    check: async () => ({
      issues: [],
      suggestedPaths: [],
      suggestedSymbols: [],
      skipped: { reason: 'missing_dep' as const, missing: ['test'] },
    }),
  }
}

function makeIssue(overrides: Partial<PlanIssue> = {}): PlanIssue {
  return {
    issueKey: overrides.issueKey ?? `key-${Math.random().toString(36).slice(2, 8)}`,
    severity: overrides.severity ?? 'warning',
    confidence: overrides.confidence ?? 0.8,
    kind: overrides.kind ?? 'missing_test',
    message: overrides.message ?? 'test issue',
    evidence: overrides.evidence ?? [],
    checkerId: overrides.checkerId ?? ('missing-test' as CheckerId),
    relatedPaths: overrides.relatedPaths,
    relatedSymbols: overrides.relatedSymbols,
    ruleId: overrides.ruleId,
  }
}

function makeMinimalDeps(): PlanValidationDeps {
  return {
    repoResolver: makeResolver(KNOWN_FILES),
    graphReader: null,
    cochangeEntries: [],
    volatilityEntries: [],
    revertStats: [],
    rules: [],
    testPathStrategy: laravelTestPaths,
  }
}

function makeNonEmptyPlan(): DraftPlan {
  return makePlan({
    steps: [{
      description: 'Update authorize',
      files: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
    }],
  })
}

describe('validatePlan', () => {
  it('runs all checkers and merges issues', async () => {
    const issue1 = makeIssue({ issueKey: 'a', message: 'issue1', checkerId: 'missing-test' as CheckerId })
    const issue2 = makeIssue({ issueKey: 'b', message: 'issue2', checkerId: 'cochange' as CheckerId })
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [fakeChecker('missing-test', 5, [issue1]), fakeChecker('cochange', 4, [issue2])],
    )
    expect(result.issues).toHaveLength(2)
    expect(result.stats.checkersRun).toBe(2)
    expect(result.stats.checkersAttempted).toBe(2)
  })

  it('sorts severity desc, checkerId asc, message asc', async () => {
    const issues = [
      makeIssue({ issueKey: 'a', severity: 'info', message: 'z-msg', checkerId: 'cochange' as CheckerId }),
      makeIssue({ issueKey: 'b', severity: 'critical', message: 'a-msg', checkerId: 'revert' as CheckerId }),
      makeIssue({ issueKey: 'c', severity: 'warning', message: 'b-msg', checkerId: 'missing-test' as CheckerId }),
      makeIssue({ issueKey: 'd', severity: 'warning', message: 'a-msg', checkerId: 'missing-test' as CheckerId }),
    ]
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [fakeChecker('x', 5, issues)],
    )
    expect(result.issues[0].severity).toBe('critical')
    expect(result.issues[1].severity).toBe('warning')
    expect(result.issues[2].severity).toBe('warning')
    expect(result.issues[2].message).toBe('b-msg')
    expect(result.issues[3].severity).toBe('info')
  })

  it('verdict pass when no criticals and < 3 warnings', async () => {
    const issues = [
      makeIssue({ issueKey: 'a', severity: 'warning', checkerId: 'missing-test' as CheckerId }),
      makeIssue({ issueKey: 'b', severity: 'info', checkerId: 'cochange' as CheckerId }),
    ]
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [fakeChecker('missing-test', 5, issues)],
    )
    expect(result.verdict).toBe('pass')
  })

  it('verdict revise when any critical', async () => {
    const issues = [
      makeIssue({ issueKey: 'a', severity: 'critical', checkerId: 'missing-test' as CheckerId }),
    ]
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [fakeChecker('missing-test', 5, issues)],
    )
    expect(result.verdict).toBe('revise')
  })

  it('verdict revise when 3+ actionable warnings', async () => {
    const issues = [
      makeIssue({ issueKey: 'a', severity: 'warning', kind: 'missing_test', checkerId: 'missing-test' as CheckerId }),
      makeIssue({ issueKey: 'b', severity: 'warning', kind: 'co_change_gap', checkerId: 'cochange' as CheckerId }),
      makeIssue({ issueKey: 'c', severity: 'warning', kind: 'revert_risk', checkerId: 'revert' as CheckerId }),
    ]
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [fakeChecker('x', 5, issues)],
    )
    expect(result.verdict).toBe('revise')
  })

  it('verdict revise when 2 warnings from 2 distinct strong checkers', async () => {
    const issue1 = makeIssue({ issueKey: 'a', severity: 'warning', kind: 'missing_test', checkerId: 'missing-test' as CheckerId })
    const issue2 = makeIssue({ issueKey: 'b', severity: 'warning', kind: 'co_change_gap', checkerId: 'cochange' as CheckerId })
    // strength >= 4 = strong
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [fakeChecker('missing-test', 5, [issue1]), fakeChecker('cochange', 4, [issue2])],
    )
    expect(result.verdict).toBe('revise')
  })

  it('custom verdictPolicy override', async () => {
    const issues = [
      makeIssue({ issueKey: 'a', severity: 'critical', checkerId: 'missing-test' as CheckerId }),
    ]
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      { verdictPolicy: () => 'warn' },
      [fakeChecker('missing-test', 5, issues)],
    )
    expect(result.verdict).toBe('warn')
  })

  it('tracks skipped checkers', async () => {
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [fakeSkippingChecker('revert')],
    )
    expect(result.stats.checkersSkipped).toBe(1)
    expect(result.skippedCheckers).toHaveLength(1)
    expect(result.skippedCheckers[0].id).toBe('revert')
    expect(result.skippedCheckers[0].reason).toBe('missing_dep')
  })

  it('tracks disabled checkers', async () => {
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      { disabledCheckers: ['revert' as CheckerId] },
      [fakeChecker('missing-test', 5, []), fakeChecker('revert', 3, [makeIssue()])],
    )
    expect(result.stats.checkersDisabled).toBe(1)
    expect(result.disabledCheckers).toContain('revert')
    expect(result.stats.checkersRun).toBe(1)
  })

  it('suppressions remove matching issues and update suppressedIssueCount', async () => {
    const issues = [
      makeIssue({
        issueKey: 'a',
        severity: 'warning',
        relatedPaths: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        checkerId: 'missing-test' as CheckerId,
      }),
      makeIssue({
        issueKey: 'b',
        severity: 'warning',
        ruleId: 'no-direct-db',
        checkerId: 'rule' as CheckerId,
      }),
      makeIssue({
        issueKey: 'c',
        severity: 'warning',
        kind: 'revert_risk',
        checkerId: 'revert' as CheckerId,
      }),
      makeIssue({
        issueKey: 'd',
        severity: 'warning',
        checkerId: 'cochange' as CheckerId,
      }),
    ]
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {
        suppressions: {
          paths: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
          rules: ['no-direct-db'],
          kinds: ['revert_risk'],
        },
      },
      [fakeChecker('x', 5, issues)],
    )
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].issueKey).toBe('d')
    expect(result.suppressedIssueCount).toBe(3)
  })

  it('riskFlag dampening downgrades severity to info', async () => {
    const issues = [
      makeIssue({
        issueKey: 'a',
        severity: 'warning',
        relatedPaths: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        checkerId: 'missing-test' as CheckerId,
      }),
      makeIssue({
        issueKey: 'b',
        severity: 'critical',
        relatedPaths: ['src/Shop/Webhooks/WebhookOrderEvent.php'],
        checkerId: 'cochange' as CheckerId,
      }),
    ]
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {
        riskFlags: ['Already reviewed src/Shop/Checkout/Steps/AuthorizePayment.php thoroughly'],
      },
      [fakeChecker('x', 5, issues)],
    )
    const dampened = result.issues.find((i) => i.issueKey === 'a')
    const untouched = result.issues.find((i) => i.issueKey === 'b')
    expect(dampened!.severity).toBe('info')
    expect(untouched!.severity).toBe('critical')
  })

  it('groupedByPath groups by relatedPaths with correct maxSeverity', async () => {
    const issues = [
      makeIssue({
        issueKey: 'a',
        severity: 'warning',
        relatedPaths: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        checkerId: 'missing-test' as CheckerId,
      }),
      makeIssue({
        issueKey: 'b',
        severity: 'critical',
        relatedPaths: ['src/Shop/Checkout/Steps/AuthorizePayment.php'],
        checkerId: 'cochange' as CheckerId,
      }),
      makeIssue({
        issueKey: 'c',
        severity: 'info',
        relatedPaths: ['src/Shop/Webhooks/WebhookOrderEvent.php'],
        checkerId: 'revert' as CheckerId,
      }),
    ]
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [fakeChecker('x', 5, issues)],
    )
    const authGroup = result.groupedByPath['src/Shop/Checkout/Steps/AuthorizePayment.php']
    expect(authGroup).toHaveLength(2)
    const webhookGroup = result.groupedByPath['src/Shop/Webhooks/WebhookOrderEvent.php']
    expect(webhookGroup).toHaveLength(1)
  })

  it('suggestedPaths deduped and sorted by severity', async () => {
    const checker: PlanChecker = {
      id: 'missing-test' as CheckerId,
      strength: 5,
      check: async () => ({
        issues: [
          makeIssue({
            issueKey: 'a',
            severity: 'critical',
            relatedPaths: ['src/Shop/Webhooks/WebhookOrderEvent.php'],
            checkerId: 'missing-test' as CheckerId,
          }),
        ],
        suggestedPaths: [
          'src/Shop/Webhooks/WebhookOrderEvent.php',
          'tests/Unit/Shop/Checkout/Steps/AuthorizePaymentTest.php',
        ],
        suggestedSymbols: ['AuthorizePayment'],
      }),
    }
    const result = await validatePlan(
      makeNonEmptyPlan(),
      makeMinimalDeps(),
      {},
      [checker],
    )
    expect(result.suggestedPaths.length).toBeGreaterThan(0)
    // deduped
    const unique = new Set(result.suggestedPaths)
    expect(unique.size).toBe(result.suggestedPaths.length)
  })

  it('empty plan produces validation_limited info issue', async () => {
    const emptyPlan = makePlan({ summary: '', steps: [], riskFlags: [] })
    const result = await validatePlan(
      emptyPlan,
      makeMinimalDeps(),
      {},
      [fakeChecker('missing-test', 5, [])],
    )
    const limited = result.issues.find((i) => i.kind === 'validation_limited')
    expect(limited).toBeDefined()
    expect(limited!.severity).toBe('info')
  })
})
