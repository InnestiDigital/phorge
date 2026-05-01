import {
  type DraftPlan,
  type PlanReviewResult,
  type PlanIssue,
  SEVERITY_ORDER,
  DEFAULT_MAX_ISSUES_IN_RERUN,
} from './plan-validator-types'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type FormatFindingsOpts = {
  maxIssuesInRerunPrompt?: number
}

// ---------------------------------------------------------------------------
// Internal raw plan shape (mirrors plan-validator.ts RawPlan)
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
// Per-checker diversity cap
// ---------------------------------------------------------------------------

const MAX_PER_CHECKER = 3

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function formatFindingsForRerun(
  plan: DraftPlan,
  review: PlanReviewResult,
  opts?: FormatFindingsOpts,
): string {
  const maxIssues = opts?.maxIssuesInRerunPrompt ?? DEFAULT_MAX_ISSUES_IN_RERUN

  // Filter out info-severity issues
  const actionable = review.issues.filter((i) => i.severity !== 'info')

  // Sort: critical first, then warning, stable within same severity
  const sorted = [...actionable].sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity],
  )

  // Per-checker diversity: max MAX_PER_CHECKER per checker
  const selected = applyDiversityCap(sorted, maxIssues)
  const omittedCount = actionable.length - selected.length

  const criticals = selected.filter((i) => i.severity === 'critical')
  const warnings = selected.filter((i) => i.severity === 'warning')

  const sections: string[] = []

  // 1. Header
  sections.push(renderHeader(review, actionable))

  // 2. Critical issues
  if (criticals.length > 0) {
    sections.push(renderIssueSection('### Critical Issues', criticals))
  }

  // 3. Warnings
  if (warnings.length > 0) {
    sections.push(renderIssueSection('### Warnings', warnings))
  }

  // 4. Truncation note
  if (omittedCount > 0) {
    sections.push(`...and ${omittedCount} more warnings/infos omitted`)
  }

  // 5. Suggested paths
  const dedupedPaths = [...new Set(review.suggestedPaths)].sort()
  if (dedupedPaths.length > 0) {
    sections.push(renderSuggestedPaths(dedupedPaths))
  }

  // 6. Instructions
  sections.push(renderInstructions())

  // 7. Machine-readable JSON block
  if (selected.length > 0) {
    sections.push(renderJsonBlock(selected))
  }

  // 8. Original plan compact
  sections.push(renderOriginalPlan(plan))

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyDiversityCap(sorted: PlanIssue[], max: number): PlanIssue[] {
  const perChecker = new Map<string, number>()
  const result: PlanIssue[] = []

  for (const issue of sorted) {
    if (result.length >= max) break
    const count = perChecker.get(issue.checkerId) ?? 0
    if (count >= MAX_PER_CHECKER) continue
    perChecker.set(issue.checkerId, count + 1)
    result.push(issue)
  }

  return result
}

function renderHeader(review: PlanReviewResult, actionable: PlanIssue[]): string {
  const critCount = actionable.filter((i) => i.severity === 'critical').length
  const warnCount = actionable.filter((i) => i.severity === 'warning').length

  const parts: string[] = []
  if (critCount > 0) parts.push(`${critCount} critical`)
  if (warnCount > 0) parts.push(`${warnCount} warning`)

  const summary = parts.length > 0 ? `${parts.join(', ')} findings` : 'no actionable findings'

  return `## Plan Review Findings\n\nVerdict: **${review.verdict}** -- ${summary}`
}

function renderIssueSection(heading: string, issues: PlanIssue[]): string {
  const lines = [heading]
  for (const issue of issues) {
    lines.push(`- **[${issue.kind}]** ${issue.message}`)
    if (issue.evidence.length > 0) {
      for (const ev of issue.evidence) {
        lines.push(`  - ${ev}`)
      }
    }
  }
  return lines.join('\n')
}

function renderSuggestedPaths(paths: string[]): string {
  const lines = ['### Suggested Additions']
  for (const p of paths) {
    lines.push(`- \`${p}\``)
  }
  return lines.join('\n')
}

function renderInstructions(): string {
  return [
    '### Instructions',
    '- Revise your plan to address the findings above.',
    '- Keep your plan minimal and focused.',
    '- For each suggested path: either add it to your plan or justify its omission in riskFlags.',
    '- Do not blindly append every suggestion.',
    '- Do not remove existing steps unless findings justify it.',
  ].join('\n')
}

function renderJsonBlock(issues: PlanIssue[]): string {
  const entries = issues.map((i) => ({
    kind: i.kind,
    severity: i.severity,
    anchor: i.relatedPaths?.[0] ?? null,
    suggestion: i.message,
  }))
  return '```json\n' + JSON.stringify(entries, null, 2) + '\n```'
}

function renderOriginalPlan(plan: DraftPlan): string {
  let raw: RawPlan
  try {
    raw = JSON.parse(plan.rawText) as RawPlan
  } catch {
    return `### Original Plan\n\n${plan.rawText}`
  }

  const lines = ['### Original Plan']

  if (raw.summary) {
    lines.push(`**Summary:** ${raw.summary}`)
  }

  if (raw.steps && raw.steps.length > 0) {
    lines.push('')
    for (let i = 0; i < raw.steps.length; i++) {
      const step = raw.steps[i]
      const desc = step.description ?? '(no description)'
      const files = step.files?.map((f) => `\`${f}\``).join(', ') ?? ''
      lines.push(`${i + 1}. ${desc}${files ? ` -- ${files}` : ''}`)
    }
  }

  if (raw.riskFlags && raw.riskFlags.length > 0) {
    lines.push('')
    lines.push('**Risk flags:**')
    for (const flag of raw.riskFlags) {
      lines.push(`- ${flag}`)
    }
  }

  return lines.join('\n')
}
