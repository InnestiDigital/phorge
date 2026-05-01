import type { RepoResolver } from '../resolvers/repo-resolver'
import { isNoisePath } from '../anchors/anchor-types'
import {
  type DraftPlan,
  type ParsedPlan,
  type PlannedFileRef,
  type PlannedSymbolRef,
  type ParserStats,
  type PlanChecker,
  type PlanIssue,
  type PlanIssueKind,
  type PlanIssueSeverity,
  type PlanReviewResult,
  type PlanValidationContext,
  type PlanValidationDeps,
  type PlanValidatorOpts,
  type CheckerResult,
  type CheckerId,
  SEVERITY_ORDER,
  makeIssueKey,
  normalizePath,
  MAX_UNRESOLVED_CANDIDATES,
  MAX_SOURCE_TEXT_LENGTH,
} from './plan-validator-types'
import { missingTestChecker } from './plan-checker-missing-test'
import { cochangeChecker } from './plan-checker-cochange'
import { revertChecker } from './plan-checker-revert'
import { ruleChecker } from './plan-checker-rule'
import { structuralGapChecker } from './plan-checker-structural-gap'
import { complexityChecker } from './plan-checker-complexity'

// ---------------------------------------------------------------------------
// Regex patterns (mirrored from target-symbol-extractor.ts)
// ---------------------------------------------------------------------------

const FILE_PATH_RE = /(?:src|app|tests|database|routes|config)\/[\w\/.-]+\.php/g

const NAMESPACED_CLASS_RE = /(?:[A-Z][a-zA-Z0-9]*\\){2,}[A-Z][a-zA-Z0-9]*/g

const CLASS_NAME_RE = /\b([A-Z][a-z][a-zA-Z0-9]{2,}(?:Controller|Service|Repository|Job|Event|Listener|Observer|Policy|Request|Resource|Transformer|Model|Exception|Interface|Trait|Test|Command|Handler|Factory|Seeder|Migration|Middleware|Guard|Step|Provider|Config|Manager|Builder|Validator|Rule|Notification|Mail|Cast|Scope)?)\b/g

// ---------------------------------------------------------------------------
// STOP_WORDS (same set as target-symbol-extractor.ts)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'What',
  'Which', 'Should', 'Could', 'Would', 'Must', 'Will', 'Also',
  'After', 'Before', 'During', 'Between', 'About', 'Above', 'Below',
  'Into', 'Through', 'From', 'With', 'Without', 'Under', 'Over',
  'Each', 'Every', 'Some', 'Any', 'All', 'Both', 'Either', 'Neither',
  'Other', 'Another', 'Such', 'Only', 'Just', 'Very', 'Most', 'More',
  'Less', 'Few', 'Many', 'Much', 'However', 'Therefore', 'Because',
  'Since', 'While', 'Although', 'Though', 'Unless', 'Until', 'Once',
  'Here', 'There', 'Then', 'Now', 'Already', 'Still', 'Yet',
  'Update', 'Add', 'Fix', 'Remove', 'Change', 'Modify', 'Create',
  'Delete', 'Check', 'Verify', 'Ensure', 'Handle', 'Support',
  'Return', 'Set', 'Get', 'Make', 'Use', 'Need', 'Allow',
  'Enable', 'Disable', 'Include', 'Exclude', 'Implement',
])

// ---------------------------------------------------------------------------
// Internal raw plan shape (parsed from DraftPlan.rawText JSON)
// ---------------------------------------------------------------------------

type RawPlanStep = {
  description?: string
  files?: string[]
}

type RawPlan = {
  summary?: string
  steps?: RawPlanStep[]
  riskFlags?: string[]
}

// ---------------------------------------------------------------------------
// Prose extraction result
// ---------------------------------------------------------------------------

export type ProseAnchorResult = {
  paths: Array<{ path: string; sourceText: string }>
  symbols: Array<{ symbol: string; sourceText: string }>
  unresolvedPaths: string[]
  ambiguousSymbols: string[]
}

// ---------------------------------------------------------------------------
// truncateSourceText — extract ~30 chars before/after match, cap length
// ---------------------------------------------------------------------------

function truncateSourceText(fullText: string, match: string): string {
  const idx = fullText.indexOf(match)
  if (idx < 0) return match.slice(0, MAX_SOURCE_TEXT_LENGTH)

  const before = Math.max(0, idx - 30)
  const after = Math.min(fullText.length, idx + match.length + 30)
  let snippet = fullText.slice(before, after)
  // collapse whitespace
  snippet = snippet.replace(/\s+/g, ' ').trim()
  if (snippet.length > MAX_SOURCE_TEXT_LENGTH) {
    snippet = snippet.slice(0, MAX_SOURCE_TEXT_LENGTH)
  }
  return snippet
}

// ---------------------------------------------------------------------------
// extractPlanProseAnchors
// ---------------------------------------------------------------------------

export function extractPlanProseAnchors(
  proseText: string,
  resolver: RepoResolver,
): ProseAnchorResult {
  const paths: Array<{ path: string; sourceText: string }> = []
  const symbols: Array<{ symbol: string; sourceText: string }> = []
  const unresolvedPaths: string[] = []
  const ambiguousSymbols: string[] = []

  // --- Extract file paths ---
  const pathMatches = proseText.match(FILE_PATH_RE) ?? []
  const seenPaths = new Set<string>()
  for (const raw of pathMatches) {
    const normalized = normalizePath(raw)
    if (seenPaths.has(normalized)) continue
    seenPaths.add(normalized)
    if (resolver.fileExists(normalized)) {
      paths.push({ path: normalized, sourceText: truncateSourceText(proseText, raw) })
    } else {
      if (unresolvedPaths.length < MAX_UNRESOLVED_CANDIDATES) {
        unresolvedPaths.push(normalized)
      }
    }
  }

  // --- Extract namespaced classes ---
  const namespacedMatches = proseText.match(NAMESPACED_CLASS_RE) ?? []
  const seenSymbols = new Set<string>()
  for (const ns of namespacedMatches) {
    const shortName = ns.split('\\').pop() ?? ns
    if (seenSymbols.has(shortName)) continue
    seenSymbols.add(shortName)
    const resolved = resolver.findFileForClass(ns)
    if (resolved) {
      symbols.push({ symbol: shortName, sourceText: truncateSourceText(proseText, ns) })
    } else {
      if (ambiguousSymbols.length < MAX_UNRESOLVED_CANDIDATES) {
        ambiguousSymbols.push(ns)
      }
    }
  }

  // --- Extract single class names ---
  for (const m of proseText.matchAll(CLASS_NAME_RE)) {
    const name = m[1]
    if (seenSymbols.has(name)) continue
    if (STOP_WORDS.has(name)) continue
    if (name.length <= 4) continue
    seenSymbols.add(name)
    const resolved = resolver.findFileForClass(name)
    if (resolved) {
      symbols.push({ symbol: name, sourceText: truncateSourceText(proseText, name) })
    } else {
      if (ambiguousSymbols.length < MAX_UNRESOLVED_CANDIDATES) {
        ambiguousSymbols.push(name)
      }
    }
  }

  return { paths, symbols, unresolvedPaths, ambiguousSymbols }
}

// ---------------------------------------------------------------------------
// parsePlanForValidation
// ---------------------------------------------------------------------------

export function parsePlanForValidation(
  draft: DraftPlan,
  resolver: RepoResolver,
): ParsedPlan {
  // Parse raw text into structured plan
  let raw: RawPlan
  try {
    raw = JSON.parse(draft.rawText) as RawPlan
  } catch {
    // If rawText is not valid JSON, treat entire text as prose
    raw = { summary: draft.rawText, steps: [], riskFlags: [] }
  }

  const files: PlannedFileRef[] = []
  const symbols: PlannedSymbolRef[] = []
  const structuredNormalized = new Set<string>()
  let missingStructuredPaths = 0

  // Structured file refs from steps[].files[]
  const steps = raw.steps ?? []
  for (const step of steps) {
    for (const rawPath of step.files ?? []) {
      const normalized = normalizePath(rawPath)
      if (structuredNormalized.has(normalized)) continue
      structuredNormalized.add(normalized)
      if (!resolver.fileExists(normalized)) {
        missingStructuredPaths++
      }
      files.push({
        path: normalized,
        normalized,
        reason: 'structured',
      })
    }
  }

  // Prose extraction from summary + step descriptions (NOT riskFlags)
  const proseChunks: string[] = []
  if (raw.summary) proseChunks.push(raw.summary)
  for (const step of steps) {
    if (step.description) proseChunks.push(step.description)
  }
  const proseText = proseChunks.join('\n')

  const proseResult = extractPlanProseAnchors(proseText, resolver)

  // --- Phase 3: Merge prose paths (dedup: structured wins) ---
  for (const { path, sourceText } of proseResult.paths) {
    if (structuredNormalized.has(path)) continue
    files.push({
      path,
      normalized: path,
      reason: 'extracted',
    })
  }

  // --- Phase 4: Symbols from prose ---
  const seenSymbols = new Set<string>()
  for (const { symbol, sourceText } of proseResult.symbols) {
    if (seenSymbols.has(symbol)) continue
    seenSymbols.add(symbol)
    const filePath = resolver.findFileForClass(symbol) ?? undefined
    symbols.push({
      symbol,
      filePath,
      reason: 'extracted',
    })
  }

  // --- Build stats ---
  const stats: ParserStats = {
    missingStructuredPaths,
    unresolvedExtractedPaths: proseResult.unresolvedPaths.length,
    ambiguousExtractedSymbols: proseResult.ambiguousSymbols.length,
    finalPlannedFileRefs: files.length,
    finalPlannedSymbolRefs: symbols.length,
  }

  return { files, symbols, stats }
}

// ---------------------------------------------------------------------------
// Default checkers
// ---------------------------------------------------------------------------

export const DEFAULT_CHECKERS: PlanChecker[] = [
  missingTestChecker,
  cochangeChecker,
  revertChecker,
  ruleChecker,
  structuralGapChecker,
  complexityChecker,
]

// ---------------------------------------------------------------------------
// RiskFlag dampening
// ---------------------------------------------------------------------------

const RISK_FLAG_PATH_RE = /(?:src|app|tests|config|database|routes)\/[\w\/.-]+/g
const RISK_FLAG_PASCAL_RE = /\b([A-Z][a-zA-Z0-9]{2,})\b/g
const RISK_FLAG_RULE_ID_RE = /\brule-\w+\b/gi

const ALL_ISSUE_KINDS: PlanIssueKind[] = [
  'missing_test',
  'co_change_gap',
  'revert_risk',
  'rule_risk',
  'structural_gap',
  'validation_limited',
]

type RiskFlagTokens = {
  paths: Set<string>
  basenames: Set<string>
  ruleIds: Set<string>
  kinds: Set<PlanIssueKind>
}

function extractRiskFlagTokens(flags: string[]): RiskFlagTokens {
  const paths = new Set<string>()
  const basenames = new Set<string>()
  const ruleIds = new Set<string>()
  const kinds = new Set<PlanIssueKind>()

  for (const flag of flags) {
    for (const m of flag.matchAll(RISK_FLAG_PATH_RE)) {
      paths.add(m[0])
    }
    for (const m of flag.matchAll(RISK_FLAG_PASCAL_RE)) {
      basenames.add(m[1])
    }
    for (const m of flag.matchAll(RISK_FLAG_RULE_ID_RE)) {
      ruleIds.add(m[0].toLowerCase())
    }
    for (const kind of ALL_ISSUE_KINDS) {
      if (flag.includes(kind)) {
        kinds.add(kind)
      }
    }
  }

  return { paths, basenames, ruleIds, kinds }
}

function shouldDampen(issue: PlanIssue, tokens: RiskFlagTokens): boolean {
  // path match
  if (issue.relatedPaths) {
    for (const rp of issue.relatedPaths) {
      const normalized = normalizePath(rp)
      if (tokens.paths.has(normalized)) return true
      // basename match (e.g. AuthorizePayment from path)
      const basename = normalized.split('/').pop()?.replace(/\.\w+$/, '') ?? ''
      if (basename && tokens.basenames.has(basename)) return true
    }
  }
  // ruleId match
  if (issue.ruleId && tokens.ruleIds.has(issue.ruleId.toLowerCase())) return true
  // kind match
  if (tokens.kinds.has(issue.kind)) return true

  return false
}

function applyDampening(issues: PlanIssue[], riskFlags: string[]): PlanIssue[] {
  if (!riskFlags.length) return issues
  const tokens = extractRiskFlagTokens(riskFlags)
  return issues.map((issue) => {
    if (issue.severity === 'info') return issue
    if (shouldDampen(issue, tokens)) {
      return { ...issue, severity: 'info' as PlanIssueSeverity }
    }
    return issue
  })
}

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

function applySuppression(
  issues: PlanIssue[],
  suppressions: PlanValidatorOpts['suppressions'],
): { kept: PlanIssue[]; suppressedCount: number } {
  if (!suppressions) return { kept: issues, suppressedCount: 0 }
  const pathSet = new Set(suppressions.paths ?? [])
  const ruleSet = new Set(suppressions.rules ?? [])
  const kindSet = new Set<PlanIssueKind>(suppressions.kinds ?? [])

  let suppressedCount = 0
  const kept: PlanIssue[] = []

  for (const issue of issues) {
    let suppressed = false
    if (issue.relatedPaths?.some((p) => pathSet.has(p))) suppressed = true
    if (issue.ruleId && ruleSet.has(issue.ruleId)) suppressed = true
    if (kindSet.has(issue.kind)) suppressed = true

    if (suppressed) {
      suppressedCount++
    } else {
      kept.push(issue)
    }
  }

  return { kept, suppressedCount }
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupeByIssueKey(issues: PlanIssue[]): PlanIssue[] {
  const seen = new Set<string>()
  const result: PlanIssue[] = []
  for (const issue of issues) {
    if (seen.has(issue.issueKey)) continue
    seen.add(issue.issueKey)
    result.push(issue)
  }
  return result
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortIssues(issues: PlanIssue[]): PlanIssue[] {
  return [...issues].sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]
    if (sevDiff !== 0) return sevDiff
    const checkerCmp = a.checkerId.localeCompare(b.checkerId)
    if (checkerCmp !== 0) return checkerCmp
    return a.message.localeCompare(b.message)
  })
}

// ---------------------------------------------------------------------------
// Default verdict policy
// ---------------------------------------------------------------------------

const STRONG_THRESHOLD = 4

function defaultVerdictPolicy(issues: PlanIssue[]): 'pass' | 'warn' | 'revise' {
  const hasCritical = issues.some((i) => i.severity === 'critical')
  if (hasCritical) return 'revise'

  // actionable warnings: exclude rule_risk with confidence !== 'high' (< 0.9)
  const actionableWarnings = issues.filter((i) => {
    if (i.severity !== 'warning') return false
    if (i.kind === 'rule_risk' && i.confidence < 0.9) return false
    return true
  })

  if (actionableWarnings.length >= 3) return 'revise'

  // 2+ warnings from 2+ distinct strong checkers
  if (actionableWarnings.length >= 2) {
    const strongCheckerIds = new Set<string>()
    for (const w of actionableWarnings) {
      strongCheckerIds.add(w.checkerId)
    }
    // We need to know which checkers are strong. Use the checkers that ran.
    // For the default policy, we use CHECKER_STRENGTH from types.
    // But we don't have access to the checker list here. Instead, track strong checker ids.
    // The spec says "from >= 2 distinct strong checkers". We define strong as strength >= STRONG_THRESHOLD.
    // We'll pass checker strength info via closure. For now, use a simpler approach:
    // We check if the actionable warnings come from >= 2 distinct checkerIds.
    // This is a simplification; the real check needs checker strength.
    if (strongCheckerIds.size >= 2) return 'revise'
  }

  return 'pass'
}

// ---------------------------------------------------------------------------
// groupedByPath builder
// ---------------------------------------------------------------------------

function buildGroupedByPath(issues: PlanIssue[]): Record<string, PlanIssue[]> {
  const grouped: Record<string, PlanIssue[]> = {}
  for (const issue of issues) {
    for (const p of issue.relatedPaths ?? []) {
      if (!grouped[p]) grouped[p] = []
      grouped[p].push(issue)
    }
  }
  return grouped
}

// ---------------------------------------------------------------------------
// suggestedPaths / suggestedSymbols collector
// ---------------------------------------------------------------------------

function collectSuggested(
  checkerResults: Array<{ result: CheckerResult; checkerId: CheckerId }>,
  finalIssues: PlanIssue[],
  suppressions: PlanValidatorOpts['suppressions'],
): { suggestedPaths: string[]; suggestedSymbols: string[] } {
  const suppressedPaths = new Set(suppressions?.paths ?? [])

  // Collect all suggested paths from checkers, dedup, exclude noise and suppressed
  const pathSeverityMap = new Map<string, number>()
  for (const { result } of checkerResults) {
    for (const p of result.suggestedPaths ?? []) {
      if (isNoisePath(p)) continue
      if (suppressedPaths.has(p)) continue
      if (!pathSeverityMap.has(p)) pathSeverityMap.set(p, 0)
    }
  }

  // Boost paths that appear in issues (use max severity)
  for (const issue of finalIssues) {
    for (const p of issue.relatedPaths ?? []) {
      const current = pathSeverityMap.get(p) ?? -1
      const issueSev = SEVERITY_ORDER[issue.severity]
      if (issueSev > current) pathSeverityMap.set(p, issueSev)
    }
  }

  const suggestedPaths = [...pathSeverityMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)

  // Collect symbols
  const symbolSet = new Set<string>()
  for (const { result } of checkerResults) {
    for (const s of result.suggestedSymbols ?? []) {
      symbolSet.add(s)
    }
  }

  return { suggestedPaths, suggestedSymbols: [...symbolSet] }
}

// ---------------------------------------------------------------------------
// validatePlan — main orchestrator
// ---------------------------------------------------------------------------

export async function validatePlan(
  plan: DraftPlan,
  deps: PlanValidationDeps,
  opts: PlanValidatorOpts = {},
  checkers: PlanChecker[] = DEFAULT_CHECKERS,
): Promise<PlanReviewResult> {
  // 1. Parse plan
  const parsed = parsePlanForValidation(plan, deps.repoResolver)

  // 2. Build context
  const ctx: PlanValidationContext = {
    parsed,
    deps,
    opts,
    testPathStrategy: deps.testPathStrategy,
  }

  // 3. Detect empty plan
  const isEmpty = parsed.files.length === 0 && parsed.symbols.length === 0
  const emptyIssues: PlanIssue[] = isEmpty
    ? [{
        issueKey: makeIssueKey('validation_limited', 'missing-test', 'empty-plan'),
        severity: 'info',
        confidence: 1,
        kind: 'validation_limited',
        message: 'Plan contains no file or symbol references; validation is limited.',
        evidence: [],
        checkerId: 'missing-test' as CheckerId,
      }]
    : []

  // 4. Run checkers
  const disabledSet = new Set(opts.disabledCheckers ?? [])
  const skippedCheckers: PlanReviewResult['skippedCheckers'] = []
  const disabledCheckers: CheckerId[] = []
  const checkerTimings: Record<string, number> = {}
  const allCheckerResults: Array<{ result: CheckerResult; checkerId: CheckerId }> = []
  let allIssues: PlanIssue[] = [...emptyIssues]

  let checkersRun = 0
  let checkersAttempted = 0

  for (const checker of checkers) {
    if (disabledSet.has(checker.id)) {
      disabledCheckers.push(checker.id)
      continue
    }

    checkersAttempted++
    const start = Date.now()
    const result = await checker.check(ctx)
    const elapsed = Date.now() - start
    checkerTimings[checker.id] = elapsed

    if (result.skipped) {
      skippedCheckers.push({
        id: checker.id,
        reason: result.skipped.reason,
        missing: result.skipped.missing,
      })
    } else {
      checkersRun++
    }

    allCheckerResults.push({ result, checkerId: checker.id })
    allIssues.push(...result.issues)
  }

  // 5. Apply riskFlag dampening
  const riskFlags = opts.riskFlags ?? []
  allIssues = applyDampening(allIssues, riskFlags)

  // 6. Apply suppressions
  const { kept, suppressedCount } = applySuppression(allIssues, opts.suppressions)
  allIssues = kept

  // 7. Dedupe by issueKey
  allIssues = dedupeByIssueKey(allIssues)

  // 8. Sort
  allIssues = sortIssues(allIssues)

  // 9. Derive verdict
  const verdict = opts.verdictPolicy
    ? opts.verdictPolicy(allIssues)
    : defaultVerdictWithStrength(allIssues, checkers)

  // 10. Collect suggestedPaths/suggestedSymbols
  const { suggestedPaths, suggestedSymbols } = collectSuggested(
    allCheckerResults,
    allIssues,
    opts.suppressions,
  )

  // 11. Build groupedByPath
  const groupedByPath = buildGroupedByPath(allIssues)

  // 12. Build stats
  const stats = {
    checkersAttempted,
    checkersRun,
    checkersSkipped: skippedCheckers.length,
    checkersDisabled: disabledCheckers.length,
  }

  // 13. Return
  return {
    verdict,
    issues: allIssues,
    suggestedPaths,
    suggestedSymbols,
    groupedByPath,
    stats,
    skippedCheckers,
    disabledCheckers,
    checkerTimings: checkerTimings as Record<CheckerId, number>,
    suppressedIssueCount: suppressedCount,
  }
}

// ---------------------------------------------------------------------------
// Default verdict with checker strength awareness
// ---------------------------------------------------------------------------

function defaultVerdictWithStrength(
  issues: PlanIssue[],
  checkers: PlanChecker[],
): 'pass' | 'warn' | 'revise' {
  const hasCritical = issues.some((i) => i.severity === 'critical')
  if (hasCritical) return 'revise'

  const actionableWarnings = issues.filter((i) => {
    if (i.severity !== 'warning') return false
    if (i.kind === 'rule_risk' && i.confidence < 0.9) return false
    return true
  })

  if (actionableWarnings.length >= 3) return 'revise'

  if (actionableWarnings.length >= 2) {
    const checkerStrength = new Map<string, number>()
    for (const c of checkers) {
      checkerStrength.set(c.id, c.strength)
    }
    const strongCheckerIds = new Set<string>()
    for (const w of actionableWarnings) {
      const strength = checkerStrength.get(w.checkerId) ?? 0
      if (strength >= STRONG_THRESHOLD) {
        strongCheckerIds.add(w.checkerId)
      }
    }
    if (strongCheckerIds.size >= 2) return 'revise'
  }

  return 'pass'
}
