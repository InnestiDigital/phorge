// phorge/src/worker/execution-pack.ts
//
// Worker execution pack — third top-level integration surface.
//
// Composes existing phorge primitives (parsed plan, complexity profile,
// historical signals, graph context, plan validation result, rule records)
// into one narrow, pre-rendered bundle scoped to the planned files/symbols.
//
// Producer: planner (Lambda or local). Consumer: implementation worker.
// All inputs are already-built artifacts — this function does NOT rebuild
// the corpus / co-change matrix / volatility map. Avoids double-cost.

import { matchGlob } from '../profiles/contracts'
import type { RuleRecord } from '../schemas/rule-schema'
import type {
  CoChangeEntry,
  RevertPathStat,
  VolatilityEntry,
} from '../commit-mining'
import type { GraphReader } from '../graphs/graph-reader'
import {
  buildFileComplexityProfile,
  type FileComplexityProfile,
} from '../profiles/file-complexity-profile'
import type { ComplexityAnalyzer } from '../profiles/contracts'
import type {
  DraftPlan,
  ParsedPlan,
  PlanIssue,
  PlanReviewResult,
} from '../checkers/plan-validator-types'
import { parsePlanForValidation } from '../checkers/plan-validator'
import type { RepoResolver } from '../resolvers'
import { formatGraphContextForPlanner } from '../formatters/graph-formatter'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Narrow, JSON-friendly bundle for an implementation worker.
 * Every field is pre-trimmed and pre-rendered. No raw signal objects.
 *
 * NOTE: `applicableRules` is populated by glob-matching `RuleRecord.scope`
 * against target paths. The full rule-checker enforcement engine
 * (`plan-checker-rule.ts`) is currently stubbed — rule-aware execution
 * is therefore PARTIAL until that ships.
 */
export type WorkerExecutionPack = {
  /** Files the plan touches, normalized. */
  targetPaths: string[]
  /** Symbols the plan references (classes, functions, components). */
  targetSymbols: string[]
  /**
   * Rule guidance lines applicable to the implementer for these paths.
   * Empty until rule engine ships, OR pre-curated rules pass through.
   */
  applicableRules: string[]
  /** Bullet lines: per-path volatility / co-change / revert hints. */
  historicalSignals: string[]
  /** Bullet lines: per-path complexity warnings. */
  complexitySignals: string[]
  /** Pre-rendered structural-context markdown block (graph subgraph). */
  graphContext: string
  /** Plan validation issues forwarded as warnings (critical + warning only). */
  reviewWarnings: string[]
}

export type WorkerPackDeps = {
  repoResolver: RepoResolver
  repoRoot: string
  /** Optional — pre-parsed plan. If absent, we parse from `plan`. */
  parsedPlan?: ParsedPlan
  coChangeEntries: CoChangeEntry[]
  volatilityEntries: VolatilityEntry[]
  revertStats: RevertPathStat[]
  graphReader?: GraphReader | null
  rules?: RuleRecord[]
  complexityAnalyzer?: ComplexityAnalyzer
  /** Optional — pre-computed validator output. Populates reviewWarnings. */
  validationResult?: PlanReviewResult | null
}

export type BuildWorkerExecutionPackOpts = {
  /** Cap reviewWarnings; default 8. */
  maxReviewWarnings?: number
  /** Cap historicalSignals lines; default 10. */
  maxHistoricalSignals?: number
  /** Cap complexitySignals lines; default 10. */
  maxComplexitySignals?: number
  /** Cap applicableRules lines; default 8. */
  maxApplicableRules?: number
}

const DEFAULT_MAX_REVIEW = 8
const DEFAULT_MAX_HISTORICAL = 10
const DEFAULT_MAX_COMPLEXITY = 10
const DEFAULT_MAX_RULES = 8

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

export async function buildWorkerExecutionPack(
  plan: DraftPlan,
  deps: WorkerPackDeps,
  opts: BuildWorkerExecutionPackOpts = {},
): Promise<WorkerExecutionPack> {
  const parsed = deps.parsedPlan ?? parsePlanForValidation(plan, deps.repoResolver)

  const targetPaths = parsed.files.map(f => f.normalized)
  const targetSymbols = parsed.symbols.map(s => s.symbol)

  const applicableRules = collectApplicableRules(
    deps.rules ?? [],
    targetPaths,
    opts.maxApplicableRules ?? DEFAULT_MAX_RULES,
  )

  const historicalSignals = collectHistoricalSignals(
    targetPaths,
    deps.volatilityEntries,
    deps.coChangeEntries,
    deps.revertStats,
    opts.maxHistoricalSignals ?? DEFAULT_MAX_HISTORICAL,
  )

  const complexitySignals = collectComplexitySignals(
    targetPaths,
    deps,
    opts.maxComplexitySignals ?? DEFAULT_MAX_COMPLEXITY,
  )

  const graphContext = deps.graphReader
    ? formatGraphContextForPlanner(deps.graphReader, {
        targetSymbols,
        maxAnchors: 3,
        maxCharsTotal: 8000,
      })
    : ''

  const reviewWarnings = collectReviewWarnings(
    deps.validationResult ?? null,
    opts.maxReviewWarnings ?? DEFAULT_MAX_REVIEW,
  )

  return {
    targetPaths,
    targetSymbols,
    applicableRules,
    historicalSignals,
    complexitySignals,
    graphContext,
    reviewWarnings,
  }
}

// ---------------------------------------------------------------------------
// Markdown renderer (worker-ready)
// ---------------------------------------------------------------------------

/**
 * Render the pack as a single markdown block ready to inject into a worker
 * prompt. Producer should persist BOTH the JSON pack (for debugging /
 * future evolution) AND this rendered markdown (for direct injection).
 */
export function renderWorkerExecutionPackMarkdown(
  pack: WorkerExecutionPack,
): string {
  const sections: string[] = []
  sections.push('# Worker Execution Pack')

  if (pack.targetPaths.length > 0) {
    sections.push('## Target Files')
    sections.push(pack.targetPaths.map(p => `- \`${p}\``).join('\n'))
  }

  if (pack.targetSymbols.length > 0) {
    sections.push('## Target Symbols')
    sections.push(pack.targetSymbols.map(s => `- \`${s}\``).join('\n'))
  }

  if (pack.applicableRules.length > 0) {
    sections.push('## Applicable Rules')
    sections.push(pack.applicableRules.map(r => `- ${r}`).join('\n'))
  }

  if (pack.reviewWarnings.length > 0) {
    sections.push('## Plan Review Warnings')
    sections.push(pack.reviewWarnings.map(w => `- ${w}`).join('\n'))
  }

  if (pack.historicalSignals.length > 0) {
    sections.push('## Historical Signals')
    sections.push(pack.historicalSignals.map(s => `- ${s}`).join('\n'))
  }

  if (pack.complexitySignals.length > 0) {
    sections.push('## Complexity Signals')
    sections.push(pack.complexitySignals.map(s => `- ${s}`).join('\n'))
  }

  if (pack.graphContext) {
    sections.push(pack.graphContext)
  }

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectApplicableRules(
  rules: RuleRecord[],
  targetPaths: string[],
  cap: number,
): string[] {
  if (rules.length === 0 || targetPaths.length === 0) return []
  const out: string[] = []
  for (const rule of rules) {
    if (!rule.appliesTo.includes('implementer')) continue
    if (rule.state !== 'approved' && rule.state !== 'experimental') continue
    const globs = rule.scope.globs
    const inScope =
      !globs || globs.length === 0
        ? true
        : targetPaths.some(p => globs.some(g => matchGlob(g, p)))
    if (!inScope) continue
    out.push(`[${rule.id}] ${rule.title} — ${rule.guidance}`)
    if (out.length >= cap) break
  }
  return out
}

function collectHistoricalSignals(
  targetPaths: string[],
  volatility: VolatilityEntry[],
  coChange: CoChangeEntry[],
  reverts: RevertPathStat[],
  cap: number,
): string[] {
  if (targetPaths.length === 0) return []
  const targets = new Set(targetPaths)
  const volIdx = new Map(volatility.filter(e => targets.has(e.path)).map(e => [e.path, e]))
  const ccIdx = new Map(coChange.filter(e => targets.has(e.path)).map(e => [e.path, e]))
  const revIdx = new Map(reverts.filter(e => targets.has(e.path)).map(e => [e.path, e]))

  const lines: string[] = []
  for (const path of targetPaths) {
    const v = volIdx.get(path)
    const cc = ccIdx.get(path)
    const r = revIdx.get(path)
    if (!v && !cc && !r) continue

    const parts: string[] = [`\`${path}\``]
    if (v) parts.push(`risk=${v.riskScore.toFixed(2)} (${v.commitCount} commits)`)
    if (r && r.revertCount > 0) parts.push(`reverted ${r.revertCount}x`)
    if (cc && cc.neighbors.length > 0) {
      const top = cc.neighbors.slice(0, 3).map(n => `${n.path} (${(n.coupling * 100).toFixed(0)}%)`)
      parts.push(`cochange: ${top.join(', ')}`)
    }
    lines.push(parts.join(' — '))
    if (lines.length >= cap) break
  }
  return lines
}

function collectComplexitySignals(
  targetPaths: string[],
  deps: WorkerPackDeps,
  cap: number,
): string[] {
  if (targetPaths.length === 0) return []
  const lines: string[] = []
  for (const path of targetPaths) {
    let profile: FileComplexityProfile | null = null
    try {
      profile = buildFileComplexityProfile(path, {
        repoRoot: deps.repoRoot,
        volatilityEntries: deps.volatilityEntries,
        revertStats: deps.revertStats,
        complexityAnalyzer: deps.complexityAnalyzer,
      })
    } catch {
      profile = null
    }
    if (!profile) continue
    if (profile.refactorRisk === 'low' && profile.refactorSignals.length === 0) continue

    const parts: string[] = [`\`${path}\` (${profile.lineCount} lines, risk=${profile.refactorRisk})`]
    if (profile.cyclomatic !== undefined) {
      parts.push(`cyclomatic=${profile.cyclomatic}`)
    }
    if (profile.refactorSignals.length > 0) {
      parts.push(profile.refactorSignals.join(', '))
    }
    lines.push(parts.join(' — '))
    if (lines.length >= cap) break
  }
  return lines
}

function collectReviewWarnings(
  review: PlanReviewResult | null,
  cap: number,
): string[] {
  if (!review) return []
  const issues: PlanIssue[] = review.issues.filter(
    i => i.severity === 'critical' || i.severity === 'warning',
  )
  // Critical first, then warning. Stable beyond that.
  issues.sort((a, b) => {
    if (a.severity === b.severity) return 0
    return a.severity === 'critical' ? -1 : 1
  })
  return issues.slice(0, cap).map(i => {
    const tag = `[${i.severity}/${i.checkerId}]`
    const paths = i.relatedPaths && i.relatedPaths.length > 0
      ? ` (${i.relatedPaths.slice(0, 2).join(', ')})`
      : ''
    return `${tag} ${i.message}${paths}`
  })
}

// Re-export for convenience.
export type { ParsedPlan, DraftPlan }
