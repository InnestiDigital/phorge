import { describe, it, expect } from 'vitest'
import type { RepoResolver } from '../src/resolvers/repo-resolver'
import type {
  PlanValidationContext,
  ParsedPlan,
  PlannedFileRef,
  PlanValidationDeps,
  PlanValidatorOpts,
} from '../src/checkers/plan-validator-types'
import { normalizePath } from '../src/checkers/plan-validator-types'
import { missingTestChecker } from '../src/checkers/plan-checker-missing-test'
import { laravelTestPaths } from '../src/profiles/laravel'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolver(files: string[]): RepoResolver {
  const fileSet = new Set(files)
  return {
    fileExists: (p: string) => fileSet.has(p),
    findFileForClass: () => null,
    findMethodKey: () => null,
  }
}

function makeCtx(
  files: Array<{ path: string; origin: 'structured' | 'extracted' }>,
  resolverFiles: string[],
  overrides?: Partial<PlanValidationContext>,
): PlanValidationContext {
  const fileRefs: PlannedFileRef[] = files.map((f) => ({
    path: f.path,
    normalized: normalizePath(f.path),
    reason: f.origin,
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
    repoResolver: makeResolver(resolverFiles),
    graphReader: null,
    cochangeEntries: [],
    volatilityEntries: [],
    revertStats: [],
    rules: [],
  }

  const opts: PlanValidatorOpts = {}

  return { parsed, deps, opts, testPathStrategy: laravelTestPaths, ...overrides }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('missingTestChecker', () => {
  it('has correct id and strength', () => {
    expect(missingTestChecker.id).toBe('missing-test')
    expect(missingTestChecker.strength).toBe(5)
  })

  it('warns when test exists in repo but not in plan', async () => {
    const ctx = makeCtx(
      [{ path: 'src/Shop/Checkout/AuthorizePayment.php', origin: 'structured' }],
      [
        'src/Shop/Checkout/AuthorizePayment.php',
        'tests/Unit/Shop/Checkout/AuthorizePaymentTest.php',
      ],
    )

    const result = await missingTestChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('warning')
    expect(result.issues[0].confidence).toBe(0.8)
    expect(result.issues[0].kind).toBe('missing_test')
    expect(result.suggestedPaths).toContain('tests/Unit/Shop/Checkout/AuthorizePaymentTest.php')
  })

  it('emits info when no test exists in repo', async () => {
    const ctx = makeCtx(
      [{ path: 'src/Shop/Checkout/AuthorizePayment.php', origin: 'structured' }],
      ['src/Shop/Checkout/AuthorizePayment.php'],
    )

    const result = await missingTestChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('info')
    expect(result.issues[0].confidence).toBe(0.3)
  })

  it('emits no issue when test is already in plan', async () => {
    const ctx = makeCtx(
      [
        { path: 'src/Shop/Checkout/AuthorizePayment.php', origin: 'structured' },
        { path: 'tests/Unit/Shop/Checkout/AuthorizePaymentTest.php', origin: 'structured' },
      ],
      [
        'src/Shop/Checkout/AuthorizePayment.php',
        'tests/Unit/Shop/Checkout/AuthorizePaymentTest.php',
      ],
    )

    const result = await missingTestChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })

  it('skips test files as source', async () => {
    const ctx = makeCtx(
      [{ path: 'tests/Unit/Shop/Checkout/AuthorizePaymentTest.php', origin: 'structured' }],
      ['tests/Unit/Shop/Checkout/AuthorizePaymentTest.php'],
    )

    const result = await missingTestChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })

  it('skips noise paths', async () => {
    const ctx = makeCtx(
      [{ path: 'database/migrations/2024_01_01_create_users_table.php', origin: 'structured' }],
      ['database/migrations/2024_01_01_create_users_table.php'],
    )

    const result = await missingTestChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })

  it('escalates to warning with high confidence for high-risk files', async () => {
    const ctx = makeCtx(
      [{ path: 'src/Shop/Checkout/AuthorizePayment.php', origin: 'structured' }],
      ['src/Shop/Checkout/AuthorizePayment.php'],
    )
    // Add volatility entry with high riskScore
    ctx.deps.volatilityEntries = [
      {
        path: 'src/Shop/Checkout/AuthorizePayment.php',
        commitCount: 50,
        lineDeltaAdded: 1000,
        lineDeltaDeleted: 500,
        firstTouchedAt: '2024-01-01T00:00:00Z',
        lastTouchedAt: '2024-06-01T00:00:00Z',
        bugFixCommitCount: 10,
        bugFixDensity: 0.2,
        topAuthors: [],
        laravelVersionSpan: ['10'],
        riskScore: 0.85,
        riskBreakdown: {
          churnComponent: 0.8,
          bugDensityComponent: 0.7,
          ownershipFragmentationComponent: 0.5,
          recencyComponent: 0.9,
        },
      },
    ]

    const result = await missingTestChecker.check(ctx)
    expect(result.issues).toHaveLength(1)
    // Even though test doesn't exist in repo (normally info), high risk escalates to warning
    expect(result.issues[0].severity).toBe('warning')
    expect(result.issues[0].confidence).toBe(0.8)
  })

  it('emits no issue when Feature test variant is in plan', async () => {
    const ctx = makeCtx(
      [
        { path: 'src/Shop/Checkout/AuthorizePayment.php', origin: 'structured' },
        { path: 'tests/Feature/Shop/Checkout/AuthorizePaymentTest.php', origin: 'structured' },
      ],
      [
        'src/Shop/Checkout/AuthorizePayment.php',
        'tests/Feature/Shop/Checkout/AuthorizePaymentTest.php',
      ],
    )

    const result = await missingTestChecker.check(ctx)
    expect(result.issues).toHaveLength(0)
  })

  it('generates correct issueKey', async () => {
    const ctx = makeCtx(
      [{ path: 'src/Shop/Checkout/AuthorizePayment.php', origin: 'structured' }],
      [
        'src/Shop/Checkout/AuthorizePayment.php',
        'tests/Unit/Shop/Checkout/AuthorizePaymentTest.php',
      ],
    )

    const result = await missingTestChecker.check(ctx)
    expect(result.issues[0].issueKey).toBe(
      'missing_test:missing-test:src/Shop/Checkout/AuthorizePayment.php',
    )
  })
})

describe('laravelTestPaths', () => {
  it('generates Unit + Feature paths for src/ files', () => {
    const paths = laravelTestPaths.candidates('src/Shop/Checkout/AuthorizePayment.php')
    expect(paths).toContain('tests/Unit/Shop/Checkout/AuthorizePaymentTest.php')
    expect(paths).toContain('tests/Feature/Shop/Checkout/AuthorizePaymentTest.php')
    expect(paths).toHaveLength(2)
  })

  it('generates Unit + Feature paths for app/ files', () => {
    const paths = laravelTestPaths.candidates('app/Services/PaymentService.php')
    expect(paths).toContain('tests/Unit/Services/PaymentServiceTest.php')
    expect(paths).toContain('tests/Feature/Services/PaymentServiceTest.php')
    expect(paths).toHaveLength(2)
  })
})
