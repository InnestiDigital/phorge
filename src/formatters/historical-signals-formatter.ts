import type {
  CoChangeEntry,
  RevertPathStat,
  VolatilityEntry,
  VolatilityRiskBreakdown,
  VolatilityWeights,
} from '../commit-mining'
import type { HistoricalSignalsBundle } from '../profiles/historical-signals-loader'

export const HISTORICAL_SIGNALS_HEADER = '## Historical Signals'
export const DEFAULT_HISTORICAL_MIN_RISK = 0.4
export const DEFAULT_HISTORICAL_MIN_COUPLING = 0.5
export const DEFAULT_HISTORICAL_TOP_N = 3
export const DEFAULT_HISTORICAL_MAX_CHARS = 2000
export const MAX_COCHANGE_NEIGHBORS_PER_BULLET = 3

export const FIXTURE_EXCLUDE_RE =
  /^tests\/(ModelFactories\.php|TestCase\.php|Factories\/|Fixtures\/)/

export type FormatHistoricalSignalsOpts = {
  targetPaths: string[]
  globalFallback?: boolean
  topN?: number
  maxChars?: number
  minRisk?: number
  minCoupling?: number
  fixtureExcludeRe?: RegExp
}

type PathSignal = {
  path: string
  volatility: VolatilityEntry | undefined
  coChange: CoChangeEntry | undefined
  revert: RevertPathStat | undefined
  sortKey: number
}

export function formatHistoricalSignals(
  bundle: HistoricalSignalsBundle,
  opts: FormatHistoricalSignalsOpts,
): string {
  const topN = opts.topN ?? DEFAULT_HISTORICAL_TOP_N
  const maxChars = opts.maxChars ?? DEFAULT_HISTORICAL_MAX_CHARS
  const minRisk = opts.minRisk ?? DEFAULT_HISTORICAL_MIN_RISK
  const minCoupling = opts.minCoupling ?? DEFAULT_HISTORICAL_MIN_COUPLING
  const fixtureRe = opts.fixtureExcludeRe ?? FIXTURE_EXCLUDE_RE

  const hasTargets = opts.targetPaths && opts.targetPaths.length > 0
  if (!hasTargets && !opts.globalFallback) return ''

  const targets = hasTargets ? new Set(opts.targetPaths) : null

  const volIndex = new Map<string, VolatilityEntry>()
  if (bundle.volatility) {
    for (const e of bundle.volatility.entries) {
      if (!targets || targets.has(e.path)) volIndex.set(e.path, e)
    }
  }

  const ccIndex = new Map<string, CoChangeEntry>()
  if (bundle.coChange) {
    for (const e of bundle.coChange.all.entries) {
      if (!targets || targets.has(e.path)) ccIndex.set(e.path, e)
    }
  }

  const revIndex = new Map<string, RevertPathStat>()
  if (bundle.revertChains) {
    for (const ps of bundle.revertChains.pathStats) {
      if (!targets || targets.has(ps.path)) revIndex.set(ps.path, ps)
    }
  }

  // When targetPaths provided but nothing matched, fall back to global if enabled
  if (targets && volIndex.size === 0 && ccIndex.size === 0 && revIndex.size === 0) {
    if (!opts.globalFallback) return ''
    if (bundle.volatility) {
      for (const e of bundle.volatility.entries) volIndex.set(e.path, e)
    }
    if (bundle.coChange) {
      for (const e of bundle.coChange.all.entries) ccIndex.set(e.path, e)
    }
    if (bundle.revertChains) {
      for (const ps of bundle.revertChains.pathStats) revIndex.set(ps.path, ps)
    }
  }

  const allPaths = new Set([...volIndex.keys(), ...ccIndex.keys(), ...revIndex.keys()])

  const signals: PathSignal[] = []
  for (const path of allPaths) {
    if (fixtureRe.test(path)) continue
    const vol = volIndex.get(path)
    const cc = ccIndex.get(path)
    const rev = revIndex.get(path)
    if (!passesQualityGate(vol, cc, rev, minRisk, minCoupling)) continue
    signals.push({
      path,
      volatility: vol,
      coChange: cc,
      revert: rev,
      sortKey: vol?.riskScore ?? 0,
    })
  }

  if (signals.length === 0) return ''

  signals.sort((a, b) => {
    if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey
    return a.path.localeCompare(b.path)
  })

  const capped = signals.slice(0, topN)
  const weights = bundle.volatility?.weights

  if (HISTORICAL_SIGNALS_HEADER.length > maxChars) return ''

  let out = HISTORICAL_SIGNALS_HEADER
  for (const sig of capped) {
    const bullet = formatBullet(sig, weights, minCoupling)
    const next = `${out}\n${bullet}`
    if (next.length > maxChars) break
    out = next
  }

  if (out === HISTORICAL_SIGNALS_HEADER) return ''
  return out
}

function passesQualityGate(
  vol: VolatilityEntry | undefined,
  cc: CoChangeEntry | undefined,
  rev: RevertPathStat | undefined,
  minRisk: number,
  minCoupling: number,
): boolean {
  if (vol && vol.riskScore >= minRisk) return true
  if (cc && cc.neighbors.some(n => n.coupling >= minCoupling)) return true
  if (rev && rev.revertCount >= 1) return true
  return false
}

function formatBullet(
  sig: PathSignal,
  weights: VolatilityWeights | undefined,
  minCoupling: number,
): string {
  const segments: string[] = []

  if (sig.volatility && weights) {
    const risk = sig.volatility.riskScore.toFixed(2)
    const reason = deriveReason(sig.volatility.riskBreakdown, weights)
    segments.push(`risk ${risk}, ${reason.toLowerCase()}`)
  }

  if (sig.coChange) {
    const qualified = sig.coChange.neighbors
      .filter(n => n.coupling >= minCoupling)
      .slice(0, MAX_COCHANGE_NEIGHBORS_PER_BULLET)
    if (qualified.length > 0) {
      const names = qualified.map(n => n.path.split('/').pop() ?? n.path)
      segments.push(`co-changes with ${names.join(', ')}`)
    }
  }

  if (sig.revert) {
    let revertStr = `reverted ${sig.revert.revertCount}x`
    if (sig.revert.medianDaysToRevert !== null) {
      const md = sig.revert.medianDaysToRevert
      const dayLabel = md < 1 ? '<1d' : `${Math.round(md)}d`
      revertStr += ` (median ${dayLabel})`
    }
    segments.push(revertStr)
  }

  return `- \`${sig.path}\` — ${segments.join('; ')}.`
}

type ComponentLabel = {
  key: keyof VolatilityRiskBreakdown
  weighted: number
  phrase: string
}

const STRONG_SECOND_RATIO = 0.8

function deriveReason(b: VolatilityRiskBreakdown, w: VolatilityWeights): string {
  const comps: ComponentLabel[] = [
    { key: 'churnComponent', weighted: b.churnComponent * w.churn, phrase: 'high churn' },
    { key: 'bugDensityComponent', weighted: b.bugDensityComponent * w.bugDensity, phrase: 'high bug-fix density' },
    { key: 'ownershipFragmentationComponent', weighted: b.ownershipFragmentationComponent * w.ownershipFragmentation, phrase: 'ownership spread' },
    { key: 'recencyComponent', weighted: b.recencyComponent * w.recency, phrase: 'recent activity' },
  ]
  comps.sort((a, b) => {
    if (b.weighted !== a.weighted) return b.weighted - a.weighted
    return a.key.localeCompare(b.key)
  })
  const first = comps[0]
  if (first.weighted <= 0) return 'historically volatile'
  const second = comps[1]
  if (second.weighted >= first.weighted * STRONG_SECOND_RATIO) {
    return `${first.phrase} and ${second.phrase}`
  }
  return first.phrase
}
