import type {
  PlanChecker,
  PlanValidationContext,
  CheckerResult,
  PlanIssue,
} from './plan-validator-types'
import { makeIssueKey, capEvidence } from './plan-validator-types'
import type { RuleRecord } from '../schemas/rule-schema'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIDENCE_MEDIUM = 0.5
const CONFIDENCE_HIGH = 0.7
const EVIDENCE_CAP = 10
const RELATED_PATHS_CAP = 10

// ---------------------------------------------------------------------------
// Simple glob matching (no external dependency)
// ---------------------------------------------------------------------------

export function simpleGlobMatch(pattern: string, path: string): boolean {
  // Escape regex-special chars except * and ?
  let re = pattern.replace(/([.+^${}()|[\]\\])/g, '\\$1')
  // ** must be handled before *
  // Replace ** with a placeholder first
  re = re.replace(/\*\*/g, '\0DOUBLESTAR\0')
  // Replace single * with segment match
  re = re.replace(/\*/g, '[^/]*')
  // Replace placeholder with cross-segment match
  re = re.replace(/\0DOUBLESTAR\0/g, '.*')
  // Replace ? with single non-slash char
  re = re.replace(/\?/g, '[^/]')
  return new RegExp(`^${re}$`).test(path)
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export const ruleChecker: PlanChecker = {
  id: 'rule',
  strength: 2,

  async check(ctx: PlanValidationContext): Promise<CheckerResult> {
    const rules = ctx.deps.rules
    const repoName = ctx.opts.repoName

    if (!rules || rules.length === 0) {
      return { issues: [], suggestedPaths: [], suggestedSymbols: [] }
    }

    const plannedPaths = ctx.parsed.files.map((f) => f.normalized)
    const issues: PlanIssue[] = []

    for (const rule of rules) {
      // Filter: must be approved
      if (rule.state !== 'approved') continue

      // Filter: must apply to validator
      if (!rule.appliesTo.includes('validator')) continue

      // Filter: scope.repos must match current repo (or be empty/undefined)
      if (rule.scope.repos && rule.scope.repos.length > 0) {
        if (!repoName || !rule.scope.repos.includes(repoName)) continue
      }

      // Glob-match scope.globs against planned file paths
      const globs = rule.scope.globs
      if (!globs || globs.length === 0) continue

      const matchedFiles: string[] = []
      const matchedGlobs: string[] = []

      for (const filePath of plannedPaths) {
        for (const glob of globs) {
          if (simpleGlobMatch(glob, filePath)) {
            if (!matchedFiles.includes(filePath)) {
              matchedFiles.push(filePath)
            }
            if (!matchedGlobs.includes(glob)) {
              matchedGlobs.push(glob)
            }
            break // one glob match per file is enough
          }
        }
      }

      if (matchedFiles.length === 0) continue

      // Sort matched files for deterministic issueKey
      matchedFiles.sort()

      // Determine confidence based on security tag
      const isSecurity = rule.tags?.includes('security') ?? false
      const confidence = isSecurity ? CONFIDENCE_HIGH : CONFIDENCE_MEDIUM

      // Severity capped at warning in v1
      const severity = 'warning' as const

      // Build evidence
      const evidence: string[] = [
        `rule: ${rule.id} — ${rule.title}`,
        `matched globs: ${matchedGlobs.join(', ')}`,
        `matched files: ${matchedFiles.slice(0, EVIDENCE_CAP).join(', ')}`,
      ]

      const issueKey = makeIssueKey('rule_risk', 'rule', `${rule.id}:${matchedFiles[0]}`)

      issues.push({
        issueKey,
        severity,
        confidence,
        kind: 'rule_risk',
        message: `Applicable approved rule surfaced for review; validator did not verify compliance. Rule "${rule.title}" (${rule.id}) applies to ${matchedFiles.length} planned file(s).`,
        evidence: capEvidence(evidence, EVIDENCE_CAP),
        checkerId: 'rule',
        relatedPaths: matchedFiles.slice(0, RELATED_PATHS_CAP),
        ruleId: rule.id,
      })
    }

    return { issues, suggestedPaths: [], suggestedSymbols: [] }
  },
}
