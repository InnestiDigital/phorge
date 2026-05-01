import { isNoisePath } from '../anchors/anchor-types'
import { GenericTestPathStrategy } from '../profiles/null-objects'
import {
  type PlanChecker,
  type PlanValidationContext,
  type CheckerResult,
  type PlanIssue,
  type TestPathStrategy,
  makeIssueKey,
  capEvidence,
  normalizePath,
} from './plan-validator-types'

const HIGH_RISK_THRESHOLD = 0.7
const CONFIDENCE_TEST_IN_REPO = 0.8
const CONFIDENCE_NO_TEST = 0.3
const EVIDENCE_CAP = 5

export const missingTestChecker: PlanChecker = {
  id: 'missing-test',
  strength: 5,

  async check(ctx: PlanValidationContext): Promise<CheckerResult> {
    const strategy: TestPathStrategy = ctx.testPathStrategy ?? GenericTestPathStrategy
    const resolver = ctx.deps.repoResolver
    const plannedFiles = ctx.parsed.files

    const plannedPathSet = new Set(plannedFiles.map((f) => f.normalized))

    const volByPath = new Map<string, number>()
    for (const entry of ctx.deps.volatilityEntries) {
      volByPath.set(normalizePath(entry.path), entry.riskScore)
    }

    const issues: PlanIssue[] = []
    const suggestedPaths: string[] = []

    for (const file of plannedFiles) {
      const norm = file.normalized

      if (strategy.isTestPath(norm)) continue
      if (isNoisePath(norm)) continue

      const candidates = [...strategy.candidates(norm)]

      const coveredByPlan = candidates.some((c) => plannedPathSet.has(normalizePath(c)))
      if (coveredByPlan) continue

      const existsInRepo = candidates.filter((c) => resolver.fileExists(c))

      const riskScore = volByPath.get(norm) ?? 0
      const isHighRisk = riskScore >= HIGH_RISK_THRESHOLD

      if (existsInRepo.length > 0) {
        const ev = existsInRepo.map((t) => `Test file exists but not in plan: ${t}`)
        suggestedPaths.push(...existsInRepo)
        issues.push({
          issueKey: makeIssueKey('missing_test', 'missing-test', norm),
          severity: 'warning',
          confidence: CONFIDENCE_TEST_IN_REPO,
          kind: 'missing_test',
          message: `Source file ${norm} has test(s) in repo but none included in plan`,
          evidence: capEvidence(ev, EVIDENCE_CAP),
          checkerId: 'missing-test',
          relatedPaths: existsInRepo,
        })
      } else {
        const severity = isHighRisk ? 'warning' : 'info'
        const confidence = isHighRisk ? CONFIDENCE_TEST_IN_REPO : CONFIDENCE_NO_TEST
        const ev = [`No test file found in repo for: ${norm}`]
        if (isHighRisk) {
          ev.push(`High volatility risk (${riskScore.toFixed(2)}) — consider adding tests`)
        }

        issues.push({
          issueKey: makeIssueKey('missing_test', 'missing-test', norm),
          severity,
          confidence,
          kind: 'missing_test',
          message: `No test file found for ${norm}`,
          evidence: capEvidence(ev, EVIDENCE_CAP),
          checkerId: 'missing-test',
          relatedPaths: candidates,
        })
      }
    }

    return {
      issues,
      suggestedPaths,
      suggestedSymbols: [],
    }
  },
}

export const defaultTestPathStrategy: TestPathStrategy = GenericTestPathStrategy
