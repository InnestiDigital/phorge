// pipeline/knowledge/commit-mining/volatility-map.ts
//
// K1.3.2 volatility map. Rolls up per-path signals from a
// CommitCorpusManifest into a VolatilityMapManifest the planner,
// reviewer, and future graph-prioritization layers can read.
//
// riskScore formula:
//   raw = w.churn         * churnComponent
//       + w.bugDensity    * bugDensityComponent
//       + w.ownershipFragmentation * ownershipFragmentationComponent
//       + w.recency       * recencyComponent
//   raw *= smallSampleDampener           (see below)
//   risk = percentile-normalized(raw)    (default; or 'raw')
//
// All components in [0, 1]. Weights default to churn 0.35 /
// bugDensity 0.30 / ownership 0.15 / recency 0.20 (sums to 1.0).
//
// Components:
//   churn            = min(commitCount / churnP95, 1.0)
//   bugDensity       = bugFixCommits / (commitCount + bugDensityPriorPseudoCommits)
//                      Laplace-smoothed (default prior = 5). Prevents 100%
//                      bugfix-on-tiny-N from saturating the component.
//   ownershipFragm.  = 1 - topAuthorShare^2
//   recency          = 1.0 if <=6mo, 0.5 if <=18mo, else 0.2
//
// Small-N tuning (Task #184):
// Real volatility = sustained churn over time. A file with 5 fix-only
// commits is not "high agent risk" — it is a small infra knob.
//   1. smallSampleDampener: when commitCount < minCommitsForRisk,
//      raw risk is multiplied by commitCount/minCommitsForRisk.
//      Default minCommitsForRisk = 5.
//   2. Laplace smoothing on bugFixDensity (above) prevents
//      tiny-denominator inflation without a hard cutoff.
//   3. normalizationMethod = 'percentile' (default) post-processes
//      risk so the top score is the 95th-percentile raw value
//      mapped to 1.0; values above p95 are clamped to 1.0. This
//      makes the score a within-repo ranking instead of an
//      absolute weighted sum, so a few extreme files don't crowd
//      the legitimately churn-heavy ones out of the top-20.

import {
  VolatilityMapManifest,
  type CommitCorpusEntry,
  type CommitCorpusManifest,
  type VolatilityAuthor,
  type VolatilityEntry,
  type VolatilityRiskBreakdown,
  type VolatilityWeights,
} from './schema'

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_VOLATILITY_WEIGHTS: VolatilityWeights = {
  churn: 0.35,
  bugDensity: 0.3,
  ownershipFragmentation: 0.15,
  recency: 0.2,
}

export const EXCLUDED_PATH_RE =
  /^(?:vendor\/|node_modules\/|bootstrap\/cache\/|storage\/|composer\.lock$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|README(?:\.|$)|CHANGELOG(?:\.|$)|LICENSE(?:\.|$)|docs\/|.*\.min\.(?:js|css)$)/i

export type VolatilityNormalizationMethod = 'raw' | 'percentile'

export const DEFAULT_MIN_COMMITS_FOR_RISK = 5
export const DEFAULT_BUG_DENSITY_PRIOR = 5
export const DEFAULT_NORMALIZATION_METHOD: VolatilityNormalizationMethod =
  'percentile'

export type BuildVolatilityMapArgs = {
  corpus: CommitCorpusManifest
  weights?: VolatilityWeights
  asOf?: string
  topRiskThreshold?: number
  maxTopAuthors?: number
  pathExcludeRe?: RegExp
  // Files with fewer than this many commits get their raw risk
  // multiplied by commitCount / minCommitsForRisk. Default 5.
  minCommitsForRisk?: number
  // Laplace prior added to commitCount when computing bugFixDensity
  // for the risk component. The reported `bugFixDensity` field is
  // still the raw ratio (schema-stable). Default 5.
  bugDensityPriorPseudoCommits?: number
  // 'percentile' rescales raw risks so the 95th percentile maps to
  // 1.0 (top-20 reflects within-repo ranking, not absolute score).
  // 'raw' preserves the legacy weighted-sum behavior.
  normalizationMethod?: VolatilityNormalizationMethod
}

type PathAggregate = {
  path: string
  commitCount: number
  lineDeltaAdded: number
  lineDeltaDeleted: number
  firstTouchedMs: number
  lastTouchedMs: number
  bugFixCommitCount: number
  authorCommits: Map<string, { commitCount: number; lastTouchedMs: number }>
}

function p95(values: number[]): number {
  return percentile(values, 0.95)
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q))
  return sorted[idx]
}

function recencyComponent(lastTouchedMs: number, asOfMs: number): number {
  const ageDays = (asOfMs - lastTouchedMs) / DAY_MS
  if (ageDays <= 180) return 1
  if (ageDays <= 540) return 0.5
  return 0.2
}

function ownershipFragmentation(
  topAuthorShare: number,
  commitCount: number,
): number {
  if (commitCount <= 1) return 0
  const clamped = Math.max(0, Math.min(1, topAuthorShare))
  return 1 - clamped * clamped
}

function pickTopAuthors(
  authorCommits: Map<string, { commitCount: number; lastTouchedMs: number }>,
  max: number,
): VolatilityAuthor[] {
  const entries = Array.from(authorCommits.entries())
    .map(([nickname, v]) => ({
      nickname,
      commitCount: v.commitCount,
      lastTouchedMs: v.lastTouchedMs,
    }))
    .sort((a, b) => {
      if (b.commitCount !== a.commitCount) return b.commitCount - a.commitCount
      if (b.lastTouchedMs !== a.lastTouchedMs) return b.lastTouchedMs - a.lastTouchedMs
      return a.nickname.localeCompare(b.nickname)
    })
    .slice(0, max)
  return entries.map((e) => ({
    nickname: e.nickname,
    commitCount: e.commitCount,
    lastTouchedAt: new Date(e.lastTouchedMs).toISOString(),
  }))
}

/**
 * Compute per-file additions/deletions for a commit. Prefers
 * commit.perFileDelta when populated (from GitCommitReader's numstat
 * parser); falls back to proportional attribution of the aggregate
 * additions/deletions across filesTouched when the per-file detail
 * is absent (StaticCommitReader / legacy fixtures).
 */
function perFileDelta(
  commit: CommitCorpusEntry,
  path: string,
): { additions: number; deletions: number } {
  if (commit.perFileDelta && commit.perFileDelta.length > 0) {
    const hit = commit.perFileDelta.find((d) => d.path === path)
    if (hit) return { additions: hit.additions, deletions: hit.deletions }
    return { additions: 0, deletions: 0 }
  }
  const fileCount = commit.filesTouched.length
  if (fileCount === 0) return { additions: 0, deletions: 0 }
  return {
    additions: Math.round(commit.additions / fileCount),
    deletions: Math.round(commit.deletions / fileCount),
  }
}

export function buildVolatilityMap(
  args: BuildVolatilityMapArgs,
): VolatilityMapManifest {
  const weights = args.weights ?? DEFAULT_VOLATILITY_WEIGHTS
  const asOf = args.asOf ?? new Date().toISOString()
  const asOfMs = Date.parse(asOf)
  if (!Number.isFinite(asOfMs)) {
    throw new Error(`asOf must be a valid ISO datetime; got ${asOf}`)
  }
  const topRiskThreshold = args.topRiskThreshold ?? 0.7
  const maxTopAuthors = args.maxTopAuthors ?? 5
  const pathExcludeRe = args.pathExcludeRe ?? EXCLUDED_PATH_RE
  const minCommitsForRisk =
    args.minCommitsForRisk ?? DEFAULT_MIN_COMMITS_FOR_RISK
  const bugDensityPrior =
    args.bugDensityPriorPseudoCommits ?? DEFAULT_BUG_DENSITY_PRIOR
  const normalizationMethod =
    args.normalizationMethod ?? DEFAULT_NORMALIZATION_METHOD

  const byPath = new Map<string, PathAggregate>()
  let excludedPaths = 0

  for (const commit of args.corpus.entries) {
    const isFix = commit.intentCategory === 'fix'
    const committedMs = Date.parse(commit.committedAt)
    if (!Number.isFinite(committedMs)) continue
    for (const path of commit.filesTouched) {
      if (pathExcludeRe.test(path)) {
        excludedPaths += 1
        continue
      }
      const delta = perFileDelta(commit, path)
      let agg = byPath.get(path)
      if (!agg) {
        agg = {
          path,
          commitCount: 0,
          lineDeltaAdded: 0,
          lineDeltaDeleted: 0,
          firstTouchedMs: committedMs,
          lastTouchedMs: committedMs,
          bugFixCommitCount: 0,
          authorCommits: new Map(),
        }
        byPath.set(path, agg)
      }
      agg.commitCount += 1
      agg.lineDeltaAdded += delta.additions
      agg.lineDeltaDeleted += delta.deletions
      if (committedMs < agg.firstTouchedMs) agg.firstTouchedMs = committedMs
      if (committedMs > agg.lastTouchedMs) agg.lastTouchedMs = committedMs
      if (isFix) agg.bugFixCommitCount += 1
      const authorEntry = agg.authorCommits.get(commit.authorNickname) ?? {
        commitCount: 0,
        lastTouchedMs: committedMs,
      }
      authorEntry.commitCount += 1
      if (committedMs > authorEntry.lastTouchedMs) {
        authorEntry.lastTouchedMs = committedMs
      }
      agg.authorCommits.set(commit.authorNickname, authorEntry)
    }
  }

  const commitCounts = Array.from(byPath.values()).map((a) => a.commitCount)
  const churnP95 = p95(commitCounts)

  type Pending = {
    entry: Omit<VolatilityEntry, 'riskScore'> & {
      riskBreakdown: VolatilityRiskBreakdown
    }
    rawRisk: number
  }
  const pending: Pending[] = []
  for (const agg of byPath.values()) {
    // Raw bugfix density (reported, unchanged for back-compat).
    const bugFixDensity =
      agg.commitCount === 0 ? 0 : agg.bugFixCommitCount / agg.commitCount
    // Laplace-smoothed density used in the risk component only.
    const smoothedBugDensity =
      agg.bugFixCommitCount / (agg.commitCount + bugDensityPrior)
    const topAuthor = pickTopAuthors(agg.authorCommits, 1)[0]
    const topAuthorShare =
      topAuthor && agg.commitCount > 0
        ? topAuthor.commitCount / agg.commitCount
        : 0
    const churnComponent =
      churnP95 === 0 ? 0 : Math.min(1, agg.commitCount / churnP95)
    const bugDensityComponent = Math.max(0, Math.min(1, smoothedBugDensity))
    const ownershipFragmentationComponent = ownershipFragmentation(
      topAuthorShare,
      agg.commitCount,
    )
    const recency = recencyComponent(agg.lastTouchedMs, asOfMs)
    const weighted =
      weights.churn * churnComponent +
      weights.bugDensity * bugDensityComponent +
      weights.ownershipFragmentation * ownershipFragmentationComponent +
      weights.recency * recency
    // Small-N dampener: linear ramp until commitCount reaches the floor.
    const dampener =
      minCommitsForRisk > 0 && agg.commitCount < minCommitsForRisk
        ? agg.commitCount / minCommitsForRisk
        : 1
    const rawRisk = Math.max(0, Math.min(1, weighted * dampener))
    const breakdown: VolatilityRiskBreakdown = {
      churnComponent,
      bugDensityComponent,
      ownershipFragmentationComponent,
      recencyComponent: recency,
      smallSampleDampener: dampener,
      rawRiskScore: rawRisk,
    }
    pending.push({
      entry: {
        path: agg.path,
        commitCount: agg.commitCount,
        lineDeltaAdded: agg.lineDeltaAdded,
        lineDeltaDeleted: agg.lineDeltaDeleted,
        firstTouchedAt: new Date(agg.firstTouchedMs).toISOString(),
        lastTouchedAt: new Date(agg.lastTouchedMs).toISOString(),
        bugFixCommitCount: agg.bugFixCommitCount,
        bugFixDensity,
        topAuthors: pickTopAuthors(agg.authorCommits, maxTopAuthors),
        laravelVersionSpan: [],
        riskBreakdown: breakdown,
      },
      rawRisk,
    })
  }

  // Percentile normalization: rescale raw risk so the 95th-percentile
  // raw value maps to 1.0. The reference percentile is computed over
  // files that meet the minCommitsForRisk floor — singleton-touch
  // files would otherwise drag the reference down and saturate
  // everything above it. Outliers above p95 clamp to 1.0.
  let normalizer = 1
  if (normalizationMethod === 'percentile' && pending.length > 0) {
    const meaningful = pending.filter(
      (p) => p.entry.commitCount >= minCommitsForRisk,
    )
    const sample = meaningful.length > 0 ? meaningful : pending
    const ref = p95(sample.map((p) => p.rawRisk))
    normalizer = ref > 0 ? ref : 1
  }

  const entries: VolatilityEntry[] = pending.map(({ entry, rawRisk }) => {
    const score =
      normalizationMethod === 'percentile'
        ? Math.max(0, Math.min(1, rawRisk / normalizer))
        : rawRisk
    return { ...entry, riskScore: score }
  })

  // Secondary sort by rawRiskScore so files that saturate the
  // percentile normalizer are still ranked by their true weighted sum.
  entries.sort((a, b) => {
    if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore
    const ar = a.riskBreakdown.rawRiskScore ?? a.riskScore
    const br = b.riskBreakdown.rawRiskScore ?? b.riskScore
    if (br !== ar) return br - ar
    return a.path.localeCompare(b.path)
  })

  const topRiskPathCount = entries.filter(
    (e) => e.riskScore >= topRiskThreshold,
  ).length

  const manifest: VolatilityMapManifest = {
    schemaVersion: 1,
    repo: args.corpus.repo,
    window: args.corpus.window,
    createdAt: new Date().toISOString(),
    asOf,
    weights,
    stats: {
      totalEntries: entries.length,
      excludedPaths,
      churnP95,
      topRiskPathCount,
      topRiskThreshold,
    },
    entries,
  }

  const parsed = VolatilityMapManifest.safeParse(manifest)
  if (!parsed.success) {
    throw new Error(
      `volatility map manifest failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}
