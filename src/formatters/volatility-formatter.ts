// pipeline/knowledge/consumers/planner-volatility-formatter.ts
//
// B-lite consumer slice: renders a VolatilityMapManifest into a
// short markdown block the planner can paste into its prompt as a
// hint. Keep it terse — planner attention budget is precious.
//
// Rules (locked with user):
//   - default behavior: empty string unless targetPaths resolve or
//     globalFallback explicitly enabled
//   - at most topN bullets (default 3)
//   - deterministic ordering: risk desc, then path asc
//   - maxChars cap honored by dropping trailing bullets, never
//     truncating mid-line
//   - reason phrased from dominant riskBreakdown components using
//     weighted contribution (value * weight) so recency doesn't
//     always dominate by raw value
//   - default minRisk floor of 0.4 to suppress trivial bullets
//   - shared test fixture paths (ModelFactories, TestCase,
//     tests/Factories/, tests/Fixtures/) excluded at the consumer
//     layer — they're high churn, low signal
//
// Do not wire globalFallback on in production paths; it exists for
// manual calibration runs until a retrieval layer provides
// targetPaths.

import type {
  VolatilityEntry,
  VolatilityMapManifest,
  VolatilityRiskBreakdown,
  VolatilityWeights,
} from '../commit-mining'

export const PLANNER_VOLATILITY_HEADER = '## Volatility Signals'
export const DEFAULT_PLANNER_MIN_RISK = 0.4

// Shared test scaffolding that churns with almost every PR. High
// volatility is expected and adds no planning signal.
export const PLANNER_FIXTURE_EXCLUDE_RE =
  /^tests\/(ModelFactories\.php|TestCase\.php|Factories\/|Fixtures\/)/

export type FormatVolatilityOpts = {
  targetPaths?: string[]
  topN?: number
  maxChars?: number
  globalFallback?: boolean
  minRisk?: number
  fixtureExcludeRe?: RegExp
}

const DEFAULT_TOP_N = 3
const DEFAULT_MAX_CHARS = 1500

export function formatVolatilityForPlanner(
  manifest: VolatilityMapManifest,
  opts: FormatVolatilityOpts,
): string {
  const topN = opts.topN ?? DEFAULT_TOP_N
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const minRisk = opts.minRisk ?? DEFAULT_PLANNER_MIN_RISK
  const fixtureRe = opts.fixtureExcludeRe ?? PLANNER_FIXTURE_EXCLUDE_RE

  if (manifest.entries.length === 0) return ''

  const candidates = selectCandidates(manifest.entries, opts)
  if (candidates.length === 0) return ''

  const filtered = candidates.filter(
    (e) => e.riskScore >= minRisk && !fixtureRe.test(e.path),
  )
  if (filtered.length === 0) return ''

  const sorted = [...filtered]
    .sort((a, b) => {
      if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore
      return a.path.localeCompare(b.path)
    })
    .slice(0, topN)

  if (PLANNER_VOLATILITY_HEADER.length > maxChars) return ''

  let out = PLANNER_VOLATILITY_HEADER
  for (const entry of sorted) {
    const bullet = formatBullet(entry, manifest.weights)
    const next = `${out}\n${bullet}`
    if (next.length > maxChars) break
    out = next
  }
  if (out === PLANNER_VOLATILITY_HEADER) return ''
  return out
}

function selectCandidates(
  entries: VolatilityEntry[],
  opts: FormatVolatilityOpts,
): VolatilityEntry[] {
  if (opts.targetPaths && opts.targetPaths.length > 0) {
    const targets = new Set(opts.targetPaths)
    const matched = entries.filter((e) => targets.has(e.path))
    if (matched.length > 0) return matched
    if (opts.globalFallback) return entries.slice()
    return []
  }
  if (opts.globalFallback) return entries.slice()
  return []
}

function formatBullet(entry: VolatilityEntry, weights: VolatilityWeights): string {
  const risk = entry.riskScore.toFixed(2)
  const reason = deriveReason(entry.riskBreakdown, weights)
  return `- \`${entry.path}\` — risk ${risk}. ${reason}.`
}

type ComponentLabel = {
  key: keyof VolatilityRiskBreakdown
  value: number
  weighted: number
  phrase: string
}

const STRONG_SECOND_VALUE = 0.5
const STRONG_SECOND_RATIO = 0.8

function deriveReason(
  b: VolatilityRiskBreakdown,
  w: VolatilityWeights,
): string {
  const comps: ComponentLabel[] = [
    { key: 'churnComponent', value: b.churnComponent, weighted: b.churnComponent * w.churn, phrase: 'high churn' },
    { key: 'bugDensityComponent', value: b.bugDensityComponent, weighted: b.bugDensityComponent * w.bugDensity, phrase: 'high bug-fix density' },
    { key: 'ownershipFragmentationComponent', value: b.ownershipFragmentationComponent, weighted: b.ownershipFragmentationComponent * w.ownershipFragmentation, phrase: 'ownership spread' },
    { key: 'recencyComponent', value: b.recencyComponent, weighted: b.recencyComponent * w.recency, phrase: 'recent activity' },
  ]
  comps.sort((a, b) => {
    if (b.weighted !== a.weighted) return b.weighted - a.weighted
    return a.key.localeCompare(b.key)
  })
  const first = comps[0]
  if (first.value <= 0) return 'Historically volatile'
  const second = comps[1]
  const secondIsStrong =
    second.value >= STRONG_SECOND_VALUE &&
    second.value >= first.value * STRONG_SECOND_RATIO
  if (secondIsStrong) {
    return `${capitalize(first.phrase)} and ${second.phrase}`
  }
  return capitalize(first.phrase)
}

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
