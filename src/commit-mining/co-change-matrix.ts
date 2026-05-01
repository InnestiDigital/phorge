// pipeline/knowledge/commit-mining/co-change-matrix.ts
//
// K1.3.3 co-change matrix. Consumes a CommitCorpusManifest and
// produces symmetric pair counts + normalized coupling for each
// anchor path, across three intent views (all / fix / feat).
//
// Locked contract with user:
//   - pair weights are symmetric
//   - both raw jointCommits and coupling = joint / min(commits(a),
//     commits(b)) are emitted
//   - fix-only and feat-only views are computed in the same build,
//     not deferred
//   - top-K neighbors per anchor (default 10)
//   - deterministic tiebreaks: coupling desc, jointCommits desc,
//     path asc
//   - noise paths excluded early (reuse EXCLUDED_PATH_RE from
//     volatility-map)
//   - thresholds: coupling ≥ 0.30 AND jointCommits ≥ 3 by default
//
// Performance notes:
//   - pair enumeration is O(k^2) per commit where k = filesTouched;
//     corpus filter already excludes mega-commits (50+ files) so
//     worst case is ~1225 pairs per commit
//   - stores symmetric counts (2× memory) to keep neighbor lookup
//     O(1) per anchor

import {
  CoChangeMatrixManifest,
  type CoChangeEntry,
  type CoChangeIntentFilter,
  type CoChangeNeighbor,
  type CoChangeView,
  type CommitCorpusEntry,
  type CommitCorpusManifest,
} from './schema'
import { EXCLUDED_PATH_RE } from './volatility-map'

export const DEFAULT_COCHANGE_MIN_COUPLING = 0.3
export const DEFAULT_COCHANGE_MIN_JOINT_COMMITS = 3
export const DEFAULT_COCHANGE_TOP_K = 10

export type BuildCoChangeMatrixArgs = {
  corpus: CommitCorpusManifest
  minCoupling?: number
  minJointCommits?: number
  topK?: number
  pathExcludeRe?: RegExp
}

type PairCounts = {
  commitCounts: Map<string, number>  // anchor path → commits touching it
  neighbors: Map<string, Map<string, number>>  // anchor → neighbor → joint
}

function newPairCounts(): PairCounts {
  return { commitCounts: new Map(), neighbors: new Map() }
}

function incPair(pc: PairCounts, a: string, b: string): void {
  const ab = pc.neighbors.get(a) ?? new Map<string, number>()
  ab.set(b, (ab.get(b) ?? 0) + 1)
  pc.neighbors.set(a, ab)
}

function accumulate(
  commits: CommitCorpusEntry[],
  pathExcludeRe: RegExp,
): { counts: PairCounts; excludedPaths: number } {
  const counts = newPairCounts()
  let excludedPaths = 0
  for (const commit of commits) {
    const files: string[] = []
    for (const p of commit.filesTouched) {
      if (pathExcludeRe.test(p)) {
        excludedPaths += 1
        continue
      }
      files.push(p)
    }
    // de-duplicate within a single commit — a path appearing twice
    // in filesTouched would double-count
    const uniq = Array.from(new Set(files)).sort()
    for (const p of uniq) {
      counts.commitCounts.set(p, (counts.commitCounts.get(p) ?? 0) + 1)
    }
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        incPair(counts, uniq[i], uniq[j])
        incPair(counts, uniq[j], uniq[i])
      }
    }
  }
  return { counts, excludedPaths }
}

function buildView(
  commits: CommitCorpusEntry[],
  intentFilter: CoChangeIntentFilter,
  pathExcludeRe: RegExp,
  minCoupling: number,
  minJointCommits: number,
  topK: number,
): { view: CoChangeView; excludedPaths: number } {
  const { counts, excludedPaths } = accumulate(commits, pathExcludeRe)

  const entries: CoChangeEntry[] = []
  let pairCount = 0
  for (const [anchor, neighborMap] of counts.neighbors) {
    const anchorCommits = counts.commitCounts.get(anchor) ?? 0
    if (anchorCommits === 0) continue
    const qualifiedNeighbors: CoChangeNeighbor[] = []
    for (const [neighbor, joint] of neighborMap) {
      if (joint < minJointCommits) continue
      const neighborCommits = counts.commitCounts.get(neighbor) ?? 0
      if (neighborCommits === 0) continue
      const minCommits = Math.min(anchorCommits, neighborCommits)
      if (minCommits === 0) continue
      const coupling = joint / minCommits
      if (coupling < minCoupling) continue
      qualifiedNeighbors.push({
        path: neighbor,
        jointCommits: joint,
        coupling,
      })
    }
    if (qualifiedNeighbors.length === 0) continue
    qualifiedNeighbors.sort((a, b) => {
      if (b.coupling !== a.coupling) return b.coupling - a.coupling
      if (b.jointCommits !== a.jointCommits) return b.jointCommits - a.jointCommits
      return a.path.localeCompare(b.path)
    })
    const capped = qualifiedNeighbors.slice(0, topK)
    pairCount += capped.length
    entries.push({
      path: anchor,
      commitCount: anchorCommits,
      neighbors: capped,
    })
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))

  return {
    view: {
      intentFilter,
      entries,
      stats: {
        anchors: entries.length,
        pairs: pairCount,
        commitsConsidered: commits.length,
      },
    },
    excludedPaths,
  }
}

export function buildCoChangeMatrix(
  args: BuildCoChangeMatrixArgs,
): CoChangeMatrixManifest {
  const minCoupling = args.minCoupling ?? DEFAULT_COCHANGE_MIN_COUPLING
  const minJointCommits = args.minJointCommits ?? DEFAULT_COCHANGE_MIN_JOINT_COMMITS
  const topK = args.topK ?? DEFAULT_COCHANGE_TOP_K
  const pathExcludeRe = args.pathExcludeRe ?? EXCLUDED_PATH_RE

  const all = args.corpus.entries
  const fix = all.filter((c) => c.intentCategory === 'fix')
  const feat = all.filter((c) => c.intentCategory === 'feat')

  const allView = buildView(all, 'all', pathExcludeRe, minCoupling, minJointCommits, topK)
  const fixView = buildView(fix, 'fix', pathExcludeRe, minCoupling, minJointCommits, topK)
  const featView = buildView(feat, 'feat', pathExcludeRe, minCoupling, minJointCommits, topK)

  const manifest: CoChangeMatrixManifest = {
    schemaVersion: 1,
    repo: args.corpus.repo,
    window: args.corpus.window,
    createdAt: new Date().toISOString(),
    config: {
      minCoupling,
      minJointCommits,
      topK,
      excludedPaths: allView.excludedPaths,
    },
    all: allView.view,
    fix: fixView.view,
    feat: featView.view,
  }

  const parsed = CoChangeMatrixManifest.safeParse(manifest)
  if (!parsed.success) {
    throw new Error(
      `co-change matrix manifest failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}
