// Anchor precision/recall benchmark harness.
//
// Methodology
// -----------
// The most honest test of `phorge anchors` is: given a real change request,
// does the resolver point at the files that ended up being modified? We don't
// have a corpus of (ticket, merged-PR) pairs at hand, so we use a proxy:
//
//   - Walk recent merged commits in a target Laravel repo via `GitCommitReader`.
//   - For each commit, treat `subject + body` as a synthetic prompt — what a
//     ticket might look like if it described the change tersely.
//   - Treat `filesTouched` (filtered to PHP source under `app/` and `routes/`,
//     excluding tests/configs/migrations/vendor) as the ground-truth set the
//     anchor resolver "should" have predicted.
//   - Run `resolvePromptAnchors` against that prompt and compute precision@K
//     and recall@K vs. ground truth.
//
// Holdout discipline
// ------------------
// To avoid trivially leaking the ground truth via the corpus, we exclude
// from the corpus passed to anchors:
//   1. The target sha itself.
//   2. Any commit committed on the same calendar day (UTC) — same-day
//      commits often touch overlapping files (related fixups, follow-ups)
//      and would inflate scores.
//
// Limits — read before drawing conclusions
// ----------------------------------------
//   - Commit messages are NOT user prompts. They're written after the fact,
//     often referencing the very files just touched. This biases scores up
//     in some cases (subject mentions class name) and down in others (terse
//     "fix bug" style messages provide almost no signal).
//   - Ground truth conflates "files actually changed" with "files anchors
//     should surface". Anchors are pre-planning context — surfacing a parent
//     class or related service is correct, even if the commit only touched
//     a child. Precision under-counts that case.
//   - Mega-commits (refactors touching 50+ files) drown the metric. We cap
//     ground-truth size via `maxTruthFiles`.
//   - Single-file commits trivially boost recall. We allow opting into a
//     `minTruthFiles` floor.
//
// Verdict thresholds (starting points, tune as data accrues)
// ----------------------------------------------------------
//   HEALTHY:    avg P@10 > 0.30 AND zero-hit-rate < 0.40
//   NEEDS WORK: anything else
// These were picked by gut, not by calibration. Treat them as a sanity rail,
// not a SLA.

import { spawnSync } from 'node:child_process'
import { resolvePromptAnchors } from '../anchors'
import {
  GitCommitReader,
  buildCommitCorpus,
  buildCoChangeMatrix,
  type CommitCorpusEntry,
} from '../commit-mining'
import { listPhpFiles } from '../cli/corpus-cache'

// In-memory cache so re-runs / repeated lookups don't re-shell to git.
const bodyCache = new Map<string, string>()

// Strip merge-commit autoboilerplate that drowns real ticket descriptions.
// Bitbucket / GitHub merge commits dump "Merged in feature/x", trailers, and
// PR commit lists that match every file in the merge — pure noise for anchors.
const MERGE_BOILERPLATE_PREFIXES = [
  'Merged in ',
  'Merge branch ',
  'Merge pull request ',
  'Merge remote-tracking ',
  'Approved-by:',
  'Co-authored-by:',
  'Reviewed-by:',
  'Signed-off-by:',
]

export function cleanCommitBody(raw: string): string {
  const lines = raw.split('\n')
  const kept: string[] = []
  let inCommitsSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\*\s+commits?:/i.test(trimmed)) {
      inCommitsSection = true
      continue
    }
    if (inCommitsSection) {
      // Bullet continuation lines under "* commits:" — drop until blank line.
      if (trimmed === '') {
        inCommitsSection = false
        continue
      }
      if (trimmed.startsWith('*') || /^[0-9a-f]{7,40}\s/.test(trimmed)) continue
      inCommitsSection = false
    }
    if (MERGE_BOILERPLATE_PREFIXES.some((p) => trimmed.startsWith(p))) continue
    kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function readCommitBody(repoPath: string, sha: string): Promise<string> {
  const key = `${repoPath}::${sha}`
  const cached = bodyCache.get(key)
  if (cached !== undefined) return cached
  const res = spawnSync('git', ['-C', repoPath, 'show', '--no-patch', '--format=%B', sha], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (res.status !== 0) {
    bodyCache.set(key, '')
    return ''
  }
  const body = (res.stdout ?? '').replace(/\s+$/, '')
  bodyCache.set(key, body)
  return body
}

export function _resetBodyCacheForTests(): void {
  bodyCache.clear()
}

export type PromptStrategy = 'subject' | 'subject_body' | 'body_only'

export type SampleCohort = 'body' | 'subject_only'

export type BenchmarkSample = {
  sha: string
  prompt: string
  cohort: SampleCohort
  groundTruth: string[]
  predicted: string[]
  precisionAt5: number
  recallAt5: number
  precisionAt10: number
  recallAt10: number
  precisionAt20: number
  recallAt20: number
}

export type CohortStats = {
  count: number
  avgPrecisionAt10: number
  avgRecallAt10: number
  zeroHitRate: number
}

export type BenchmarkAggregate = {
  sampleCount: number
  samplesWithBody: number
  samplesSubjectOnly: number
  avgPrecisionAt5: number
  avgPrecisionAt10: number
  avgPrecisionAt20: number
  avgRecallAt5: number
  avgRecallAt10: number
  avgRecallAt20: number
  p50PrecisionAt10: number
  p90PrecisionAt10: number
  zeroHitRate: number
  bodyCohort: CohortStats
  subjectOnlyCohort: CohortStats
}

export type BenchmarkResult = {
  samples: BenchmarkSample[]
  aggregate: BenchmarkAggregate
}

export type BenchmarkOptions = {
  repoPath: string
  since: string
  limit?: number
  minTruthFiles?: number
  maxTruthFiles?: number
  promptStrategy?: PromptStrategy
}

const PHP_SRC_INCLUDE_PREFIXES = ['app/', 'routes/']
const PHP_SRC_EXCLUDE_PREFIXES = [
  'tests/',
  'config/',
  'database/migrations/',
  'database/seeders/',
  'database/factories/',
  'vendor/',
  'storage/',
  'bootstrap/',
  'public/',
]

export function isPhpSourceFile(path: string): boolean {
  if (!path.endsWith('.php')) return false
  if (PHP_SRC_EXCLUDE_PREFIXES.some((p) => path.startsWith(p))) return false
  if (path.includes('/Tests/') || path.includes('/tests/')) return false
  return PHP_SRC_INCLUDE_PREFIXES.some((p) => path.startsWith(p))
}

export function buildPrompt(
  subject: string,
  body: string,
  strategy: PromptStrategy,
): string {
  switch (strategy) {
    case 'subject':
      return subject.trim()
    case 'body_only':
      return body.trim()
    case 'subject_body':
    default:
      return `${subject.trim()}\n\n${body.trim()}`.trim()
  }
}

/** Same calendar day in UTC. */
function sameUtcDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10)
}

export function applyHoldout(
  corpus: CommitCorpusEntry[],
  targetSha: string,
  targetCommittedAt: string,
): CommitCorpusEntry[] {
  return corpus.filter(
    (c) => c.sha !== targetSha && !sameUtcDay(c.committedAt, targetCommittedAt),
  )
}

function precisionRecall(
  predicted: string[],
  groundTruth: Set<string>,
  k: number,
): { precision: number; recall: number } {
  if (k === 0 || groundTruth.size === 0) return { precision: 0, recall: 0 }
  const top = predicted.slice(0, k)
  let hits = 0
  for (const p of top) if (groundTruth.has(p)) hits += 1
  const precision = top.length === 0 ? 0 : hits / top.length
  const recall = hits / groundTruth.size
  return { precision, recall }
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return sorted[idx]
}

function isZeroHit(s: BenchmarkSample): boolean {
  const truth = new Set(s.groundTruth)
  return s.predicted.every((p) => !truth.has(p))
}

function cohortStats(samples: BenchmarkSample[]): CohortStats {
  if (samples.length === 0) {
    return { count: 0, avgPrecisionAt10: 0, avgRecallAt10: 0, zeroHitRate: 0 }
  }
  const zero = samples.filter(isZeroHit).length
  return {
    count: samples.length,
    avgPrecisionAt10: average(samples.map((s) => s.precisionAt10)),
    avgRecallAt10: average(samples.map((s) => s.recallAt10)),
    zeroHitRate: zero / samples.length,
  }
}

export function computeAggregate(samples: BenchmarkSample[]): BenchmarkAggregate {
  const p10 = samples.map((s) => s.precisionAt10)
  const zeroHits = samples.filter(isZeroHit).length
  const body = samples.filter((s) => s.cohort === 'body')
  const subjectOnly = samples.filter((s) => s.cohort === 'subject_only')
  return {
    sampleCount: samples.length,
    samplesWithBody: body.length,
    samplesSubjectOnly: subjectOnly.length,
    avgPrecisionAt5: average(samples.map((s) => s.precisionAt5)),
    avgPrecisionAt10: average(p10),
    avgPrecisionAt20: average(samples.map((s) => s.precisionAt20)),
    avgRecallAt5: average(samples.map((s) => s.recallAt5)),
    avgRecallAt10: average(samples.map((s) => s.recallAt10)),
    avgRecallAt20: average(samples.map((s) => s.recallAt20)),
    p50PrecisionAt10: percentile(p10, 50),
    p90PrecisionAt10: percentile(p10, 90),
    zeroHitRate: samples.length === 0 ? 0 : zeroHits / samples.length,
    bodyCohort: cohortStats(body),
    subjectOnlyCohort: cohortStats(subjectOnly),
  }
}

export function evaluateSample(
  sha: string,
  prompt: string,
  predicted: string[],
  groundTruth: string[],
  cohort: SampleCohort = 'subject_only',
): BenchmarkSample {
  const truth = new Set(groundTruth)
  const at5 = precisionRecall(predicted, truth, 5)
  const at10 = precisionRecall(predicted, truth, 10)
  const at20 = precisionRecall(predicted, truth, 20)
  return {
    sha,
    prompt,
    cohort,
    groundTruth,
    predicted,
    precisionAt5: at5.precision,
    recallAt5: at5.recall,
    precisionAt10: at10.precision,
    recallAt10: at10.recall,
    precisionAt20: at20.precision,
    recallAt20: at20.recall,
  }
}

export async function runAnchorBenchmark(
  opts: BenchmarkOptions,
): Promise<BenchmarkResult> {
  const limit = opts.limit ?? 50
  const minTruth = opts.minTruthFiles ?? 1
  const maxTruth = opts.maxTruthFiles ?? 20
  const strategy: PromptStrategy = opts.promptStrategy ?? 'subject_body'

  const reader = new GitCommitReader()
  const since = /^\d{4}-\d{2}-\d{2}$/.test(opts.since)
    ? `${opts.since}T00:00:00.000Z`
    : opts.since
  const corpusManifest = await buildCommitCorpus({
    reader,
    repo: 'benchmark',
    repoRoot: opts.repoPath,
    since,
  })
  const allFiles = listPhpFiles(opts.repoPath)

  // Pick samples newest-first, filtered to commits with usable ground truth.
  const candidates = [...corpusManifest.entries].sort((a, b) =>
    b.committedAt.localeCompare(a.committedAt),
  )

  const samples: BenchmarkSample[] = []
  for (const entry of candidates) {
    if (samples.length >= limit) break
    const truthFiles = entry.filesTouched.filter(isPhpSourceFile)
    if (truthFiles.length < minTruth || truthFiles.length > maxTruth) continue

    // Corpus stores only bodyDigest, so re-read body via git for an honest
    // subject_body / body_only test. Subject strategy still skips this.
    let body = ''
    if (strategy !== 'subject') {
      const raw = await readCommitBody(opts.repoPath, entry.sha)
      // Drop the subject line — `%B` includes it.
      const withoutSubject = raw.replace(/^[^\n]*\n?/, '')
      body = cleanCommitBody(withoutSubject)
    }
    const cohort: SampleCohort = body.length > 0 ? 'body' : 'subject_only'
    const effectiveStrategy: PromptStrategy =
      strategy === 'body_only' && body.length === 0 ? 'subject' : strategy
    const prompt = buildPrompt(entry.subject, body, effectiveStrategy)
    if (!prompt.trim()) continue

    const filteredCorpus = applyHoldout(
      corpusManifest.entries,
      entry.sha,
      entry.committedAt,
    )
    const coChange = buildCoChangeMatrix({
      corpus: { ...corpusManifest, entries: filteredCorpus },
    })

    const result = resolvePromptAnchors({
      promptText: prompt,
      deps: {
        corpus: filteredCorpus,
        coChangeView: coChange.all,
        allFiles,
      },
    })

    const predicted = result.targetPaths.slice(0, 20)
    samples.push(evaluateSample(entry.sha, prompt, predicted, truthFiles, cohort))
  }

  return { samples, aggregate: computeAggregate(samples) }
}

export function formatResult(result: BenchmarkResult): string {
  const a = result.aggregate
  const pct = (x: number) => (x * 100).toFixed(1) + '%'
  const lines: string[] = []
  lines.push('# phorge anchor-precision benchmark')
  lines.push('')
  lines.push(`samples:           ${a.sampleCount}`)
  lines.push('')
  lines.push('## Precision (fraction of top-K that were actually changed)')
  lines.push(`  avg P@5:         ${pct(a.avgPrecisionAt5)}`)
  lines.push(`  avg P@10:        ${pct(a.avgPrecisionAt10)}`)
  lines.push(`  avg P@20:        ${pct(a.avgPrecisionAt20)}`)
  lines.push(`  p50 P@10:        ${pct(a.p50PrecisionAt10)}`)
  lines.push(`  p90 P@10:        ${pct(a.p90PrecisionAt10)}`)
  lines.push('')
  lines.push('## Recall (fraction of changed files appearing in top-K)')
  lines.push(`  avg R@5:         ${pct(a.avgRecallAt5)}`)
  lines.push(`  avg R@10:        ${pct(a.avgRecallAt10)}`)
  lines.push(`  avg R@20:        ${pct(a.avgRecallAt20)}`)
  lines.push('')
  lines.push(`zero-hit rate:     ${pct(a.zeroHitRate)}  (samples where 0 ground-truth files appeared in top-20)`)
  lines.push('')
  lines.push('## Cohort split (bodyful prompts vs subject-only fallback)')
  lines.push(`  body cohort:     ${a.bodyCohort.count} samples  P@10=${pct(a.bodyCohort.avgPrecisionAt10)}  R@10=${pct(a.bodyCohort.avgRecallAt10)}  zero-hit=${pct(a.bodyCohort.zeroHitRate)}`)
  lines.push(`  subject-only:    ${a.subjectOnlyCohort.count} samples  P@10=${pct(a.subjectOnlyCohort.avgPrecisionAt10)}  R@10=${pct(a.subjectOnlyCohort.avgRecallAt10)}  zero-hit=${pct(a.subjectOnlyCohort.zeroHitRate)}`)
  lines.push('')
  // Verdict honours cohort reality: bodyful cohort is the optimistic upper
  // bound (real ticket descriptions); subject-only cohort represents commits
  // with terse / merge-only messages where anchors have little to chew on.
  const bodyHealthy =
    a.bodyCohort.count === 0 ||
    (a.bodyCohort.avgPrecisionAt10 > 0.3 && a.bodyCohort.zeroHitRate < 0.4)
  const subjectHealthy =
    a.subjectOnlyCohort.count === 0 ||
    (a.subjectOnlyCohort.avgPrecisionAt10 > 0.15 && a.subjectOnlyCohort.zeroHitRate < 0.5)
  let verdict: string
  if (bodyHealthy && subjectHealthy) verdict = 'HEALTHY'
  else if (bodyHealthy && !subjectHealthy) verdict = 'HEALTHY (body) / NEEDS WORK (subject-only)'
  else verdict = 'NEEDS WORK'
  lines.push(`verdict:           ${verdict}`)
  lines.push(`thresholds:        body cohort P@10>30% & zero-hit<40%; subject-only P@10>15% & zero-hit<50%`)
  return lines.join('\n')
}
