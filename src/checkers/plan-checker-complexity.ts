import {
  type PlanChecker,
  type PlanValidationContext,
  type CheckerResult,
  type PlanIssue,
  type PlanIssueSeverity,
  makeIssueKey,
  capEvidence,
} from './plan-validator-types'
import { buildFileComplexityProfile, type FileComplexityProfileDeps } from '../profiles/file-complexity-profile'

export const complexityChecker: PlanChecker = {
  id: 'complexity' as any,
  strength: 2,
  check: async (ctx: PlanValidationContext): Promise<CheckerResult> => {
    const { parsed, deps } = ctx

    if (!deps.repoRoot) {
      return { issues: [], suggestedPaths: [], suggestedSymbols: [], skipped: { reason: 'missing_dep', missing: ['repoRoot'] } }
    }

    const profileDeps: FileComplexityProfileDeps = {
      repoRoot: deps.repoRoot,
      volatilityEntries: deps.volatilityEntries,
      revertStats: deps.revertStats,
    }

    const issues: PlanIssue[] = []

    for (const file of parsed.files) {
      const profile = buildFileComplexityProfile(file.normalized, profileDeps)
      if (!profile) continue
      if (profile.refactorRisk === 'low') continue

      const severity: PlanIssueSeverity = profile.refactorRisk === 'high' ? 'warning' : 'info'
      const confidence = profile.refactorRisk === 'high' ? 0.7 : 0.5

      const evidence = profile.refactorSignals.map(s => `complexity: ${s}`)

      issues.push({
        issueKey: makeIssueKey('structural_gap', 'complexity' as any, file.normalized),
        severity,
        confidence,
        kind: 'structural_gap',
        message: `Planned file ${file.normalized} has ${profile.refactorRisk} refactor risk (${profile.lineCount} lines, ${profile.commitCount} commits, ${(profile.bugFixDensity * 100).toFixed(0)}% bugfix). Consider extracting responsibilities before patching.`,
        evidence: capEvidence(evidence, 5),
        checkerId: 'complexity' as any,
        relatedPaths: [file.normalized],
      })
    }

    return { issues, suggestedPaths: [], suggestedSymbols: [] }
  },
}
