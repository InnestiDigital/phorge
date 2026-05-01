import type { CoChangeEntry } from '../commit-mining/schema'
import type { VolatilityEntry } from '../commit-mining/schema'
import type { RevertPathStat } from '../commit-mining/schema'
import type { GraphReader } from '../graphs/graph-reader'
import type { RuleRecord } from '../schemas/rule-schema'
import type { RepoResolver } from '../resolvers/repo-resolver'
import type { TestPathStrategy } from '../profiles/contracts'

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export type PlanIssueSeverity = 'critical' | 'warning' | 'info'

export const SEVERITY_ORDER: Record<PlanIssueSeverity, number> = {
  critical: 2,
  warning: 1,
  info: 0,
}

// ---------------------------------------------------------------------------
// Issue kinds
// ---------------------------------------------------------------------------

export type PlanIssueKind =
  | 'missing_test'
  | 'co_change_gap'
  | 'revert_risk'
  | 'rule_risk'
  | 'structural_gap'
  | 'validation_limited'

// ---------------------------------------------------------------------------
// Checker identity & ordering
// ---------------------------------------------------------------------------

export const CHECKER_IDS = [
  'missing-test',
  'cochange',
  'revert',
  'rule',
  'structural-gap',
  'complexity',
] as const

export type CheckerId = (typeof CHECKER_IDS)[number]

export const CHECKER_PRIORITY: Record<CheckerId, number> = {
  'missing-test': 4,
  'cochange': 3,
  'revert': 2,
  'rule': 1,
  'structural-gap': 0,
  'complexity': 0,
}

export const CHECKER_STRENGTH: Record<CheckerId, number> = {
  'missing-test': 5,
  'cochange': 4,
  'revert': 3,
  'rule': 2,
  'structural-gap': 1,
  'complexity': 2,
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ISSUES_IN_RERUN = 8
export const DEFAULT_EVIDENCE_CAP = 5
export const MAX_UNRESOLVED_CANDIDATES = 20
export const MAX_SOURCE_TEXT_LENGTH = 160

// ---------------------------------------------------------------------------
// Plan parsing types
// ---------------------------------------------------------------------------

export type DraftPlan = {
  rawText: string
  sourceLabel?: string
}

export type PlannedFileRef = {
  path: string
  normalized: string
  reason?: string
}

export type PlannedSymbolRef = {
  symbol: string
  filePath?: string
  reason?: string
}

export type ParserStats = {
  missingStructuredPaths: number
  unresolvedExtractedPaths: number
  ambiguousExtractedSymbols: number
  finalPlannedFileRefs: number
  finalPlannedSymbolRefs: number
}

export type ParsedPlan = {
  files: PlannedFileRef[]
  symbols: PlannedSymbolRef[]
  stats: ParserStats
}

// ---------------------------------------------------------------------------
// Checker types
// ---------------------------------------------------------------------------

export type CheckerSkipReason = 'missing_dep' | 'empty_input' | 'unsupported'

export type CheckerResult = {
  issues: PlanIssue[]
  suggestedPaths: string[]
  suggestedSymbols: string[]
  skipped?: { reason: CheckerSkipReason; missing: string[] }
}

export type PlanChecker = {
  id: CheckerId
  strength: number
  check: (ctx: PlanValidationContext) => Promise<CheckerResult>
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export type PlanIssue = {
  issueKey: string
  severity: PlanIssueSeverity
  confidence: number
  kind: PlanIssueKind
  message: string
  evidence: string[]
  checkerId: CheckerId
  relatedPaths?: string[]
  relatedSymbols?: string[]
  ruleId?: string
}

// ---------------------------------------------------------------------------
// Review result
// ---------------------------------------------------------------------------

export type PlanReviewResult = {
  verdict: 'pass' | 'warn' | 'revise'
  issues: PlanIssue[]
  suggestedPaths: string[]
  suggestedSymbols: string[]
  groupedByPath: Record<string, PlanIssue[]>
  stats: {
    checkersAttempted: number
    checkersRun: number
    checkersSkipped: number
    checkersDisabled: number
  }
  skippedCheckers: Array<{ id: CheckerId; reason: CheckerSkipReason; missing: string[] }>
  disabledCheckers: CheckerId[]
  checkerTimings?: Record<CheckerId, number>
  suppressedIssueCount: number
}

// ---------------------------------------------------------------------------
// Test path strategy
// ---------------------------------------------------------------------------

export type { TestPathStrategy }

// ---------------------------------------------------------------------------
// Validation context & deps
// ---------------------------------------------------------------------------

export type PlanValidationContext = {
  parsed: ParsedPlan
  deps: PlanValidationDeps
  opts: PlanValidatorOpts
  testPathStrategy?: TestPathStrategy
}

export type PlanValidationDeps = {
  repoResolver: RepoResolver
  graphReader: GraphReader | null
  cochangeEntries: CoChangeEntry[]
  volatilityEntries: VolatilityEntry[]
  revertStats: RevertPathStat[]
  rules: RuleRecord[]
  repoRoot?: string
  testPathStrategy?: import('../profiles/contracts').TestPathStrategy
}

export type PlanSuppressions = {
  paths?: string[]
  rules?: string[]
  kinds?: PlanIssueKind[]
}

export type VerdictPolicy = (issues: PlanIssue[]) => 'pass' | 'warn' | 'revise'

export type PlanValidatorOpts = {
  maxIssuesInRerun?: number
  evidenceCap?: number
  suppressions?: PlanSuppressions
  disabledCheckers?: CheckerId[]
  repoName?: string
  riskFlags?: string[]
  verdictPolicy?: VerdictPolicy
}

// ---------------------------------------------------------------------------
// Planner integration
// ---------------------------------------------------------------------------

export type PlannerResultWithReview = {
  plan: DraftPlan
  parsed: ParsedPlan
  review: PlanReviewResult
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function normalizePath(raw: string): string {
  if (!raw) return ''
  let p = raw
  // trim backticks and quotes
  p = p.replace(/^[`"']+|[`"']+$/g, '')
  // backslashes to forward slashes
  p = p.replace(/\\/g, '/')
  // strip Windows drive prefix (e.g. C:/)
  p = p.replace(/^[A-Za-z]:\//, '')
  // collapse repeated slashes
  p = p.replace(/\/{2,}/g, '/')
  // strip leading ./
  p = p.replace(/^\.\//, '')
  // strip leading /
  p = p.replace(/^\//, '')
  // strip trailing /
  p = p.replace(/\/$/, '')
  return p
}

export function makeIssueKey(kind: PlanIssueKind, checkerId: CheckerId, discriminator: string): string {
  return `${kind}:${checkerId}:${discriminator}`
}

export function capEvidence(items: string[], cap: number): string[] {
  if (items.length <= cap) return items
  const kept = items.slice(0, cap)
  const remaining = items.length - cap
  kept.push(`...and ${remaining} more`)
  return kept
}
