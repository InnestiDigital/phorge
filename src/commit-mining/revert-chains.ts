// pipeline/knowledge/commit-mining/revert-chains.ts
//
// K1.3.4 revert chain detection. Consumes a CommitCorpusManifest
// (plus an optional sha → body map) and produces a
// RevertChainsManifest with three layers:
//   - RevertLink[]      — per-revert resolution record
//   - RevertChain[]     — ordered commit lineage where reverts
//                         themselves get reverted (re-applied)
//   - RevertPathStat[]  — per-path revert density, median time to
//                         revert, chain participation count
//
// Locked contract with user:
//   - resolution hierarchy is conservative:
//       1. explicit SHA mention (body substring)
//       2. exact subject match (Revert "<subject>")
//       3. bodyDigest match
//       else: unresolved, not guessed
//   - revert-of-revert is first-class (role='reapply')
//   - path stats derive from the ORIGINAL commit's filesTouched —
//     that's what was undone by the revert
//   - noise paths excluded via EXCLUDED_PATH_RE
//   - determinism over cleverness: under-link rather than invent

import {
  RevertChainsManifest,
  type CommitCorpusEntry,
  type CommitCorpusManifest,
  type RevertChain,
  type RevertChainCommit,
  type RevertChainRole,
  type RevertLink,
  type RevertPathStat,
  type RevertResolutionCode,
} from './schema'
import { EXCLUDED_PATH_RE } from './volatility-map'

const DAY_MS = 24 * 60 * 60 * 1000

const REVERT_SUBJECT_RE = /^\s*Revert "(?<inner>.*)"\s*$/
const SHA_MENTION_RE = /This reverts commit ([0-9a-f]{7,40})/i

export type BuildRevertChainsArgs = {
  corpus: CommitCorpusManifest
  /** Optional sha → commit body map. Required for SHA-mention resolution. */
  revertBodies?: Record<string, string>
  pathExcludeRe?: RegExp
}

function isRevertCommit(commit: CommitCorpusEntry): boolean {
  if (commit.intentCategory === 'revert') return true
  return REVERT_SUBJECT_RE.test(commit.subject)
}

function extractInnerSubject(subject: string): string | null {
  const m = subject.match(REVERT_SUBJECT_RE)
  return m?.groups?.inner ?? null
}

function parseMs(iso: string): number {
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : 0
}

function resolveBySha(
  body: string | undefined,
  shaIndex: Map<string, string>,
): string | null {
  if (!body) return null
  const m = body.match(SHA_MENTION_RE)
  if (!m) return null
  const prefix = m[1].toLowerCase()
  // Prefer exact match, then prefix lookup
  if (shaIndex.has(prefix)) return shaIndex.get(prefix)!
  for (const fullSha of shaIndex.values()) {
    if (fullSha.startsWith(prefix)) return fullSha
  }
  return null
}

function resolveBySubject(
  revert: CommitCorpusEntry,
  subjectIndex: Map<string, CommitCorpusEntry[]>,
): string | null {
  const inner = extractInnerSubject(revert.subject)
  if (!inner) return null
  const candidates = subjectIndex.get(inner)
  if (!candidates || candidates.length === 0) return null
  const revertMs = parseMs(revert.committedAt)
  const pre = candidates
    .filter((c) => parseMs(c.committedAt) < revertMs)
    .sort((a, b) => parseMs(b.committedAt) - parseMs(a.committedAt))
  return pre[0]?.sha ?? null
}

function resolveByDigest(
  revert: CommitCorpusEntry,
  digestIndex: Map<string, CommitCorpusEntry[]>,
): string | null {
  const matches = digestIndex.get(revert.bodyDigest)
  if (!matches || matches.length === 0) return null
  const revertMs = parseMs(revert.committedAt)
  const pre = matches
    .filter((c) => c.sha !== revert.sha && parseMs(c.committedAt) < revertMs)
    .sort((a, b) => parseMs(b.committedAt) - parseMs(a.committedAt))
  return pre[0]?.sha ?? null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function buildChains(
  entries: CommitCorpusEntry[],
  links: RevertLink[],
  pathExcludeRe: RegExp,
): RevertChain[] {
  const shaToEntry = new Map<string, CommitCorpusEntry>()
  for (const e of entries) shaToEntry.set(e.sha, e)

  const revertOf = new Map<string, string>()
  const revertedBy = new Map<string, string[]>()
  for (const link of links) {
    if (!link.revertedSha) continue
    revertOf.set(link.revertSha, link.revertedSha)
    const arr = revertedBy.get(link.revertedSha) ?? []
    arr.push(link.revertSha)
    revertedBy.set(link.revertedSha, arr)
  }

  // Chain roots: reverted commits that are NOT themselves a resolved
  // revert of something earlier. Sort for deterministic chain ordering.
  const rootShas: string[] = []
  for (const origSha of revertedBy.keys()) {
    if (!revertOf.has(origSha)) rootShas.push(origSha)
  }
  rootShas.sort()

  const chains: RevertChain[] = []
  for (const root of rootShas) {
    const rootEntry = shaToEntry.get(root)
    if (!rootEntry) continue
    const commits: RevertChainCommit[] = [
      {
        sha: root,
        role: 'original',
        committedAt: rootEntry.committedAt,
        subject: rootEntry.subject,
      },
    ]
    let cursor = root
    let nextRole: RevertChainRole = 'revert'
    while (true) {
      const reverters = revertedBy.get(cursor) ?? []
      if (reverters.length === 0) break
      const sorted = reverters
        .map((sha) => shaToEntry.get(sha))
        .filter((e): e is CommitCorpusEntry => !!e)
        .sort((a, b) => {
          const ta = parseMs(a.committedAt)
          const tb = parseMs(b.committedAt)
          if (ta !== tb) return ta - tb
          return a.sha.localeCompare(b.sha)
        })
      const first = sorted[0]
      if (!first) break
      commits.push({
        sha: first.sha,
        role: nextRole,
        committedAt: first.committedAt,
        subject: first.subject,
      })
      cursor = first.sha
      nextRole = nextRole === 'revert' ? 'reapply' : 'revert'
    }
    if (commits.length < 2) continue
    const filesInvolvedSet = new Set<string>()
    for (const c of commits) {
      const e = shaToEntry.get(c.sha)
      if (!e) continue
      for (const p of e.filesTouched) {
        if (pathExcludeRe.test(p)) continue
        filesInvolvedSet.add(p)
      }
    }
    const filesInvolved = Array.from(filesInvolvedSet).sort()
    chains.push({
      chainId: `chain-${root}`,
      commits,
      filesInvolved,
      depth: commits.length,
      hasReapply: commits.some((c) => c.role === 'reapply'),
    })
  }

  return chains
}

export function buildRevertChains(
  args: BuildRevertChainsArgs,
): RevertChainsManifest {
  const pathExcludeRe = args.pathExcludeRe ?? EXCLUDED_PATH_RE
  const entries = args.corpus.entries

  // Indexes for resolution
  const shaIndex = new Map<string, string>()
  const subjectIndex = new Map<string, CommitCorpusEntry[]>()
  const digestIndex = new Map<string, CommitCorpusEntry[]>()
  const shaToEntry = new Map<string, CommitCorpusEntry>()
  for (const e of entries) {
    shaIndex.set(e.sha.toLowerCase(), e.sha)
    shaToEntry.set(e.sha, e)
    const s = subjectIndex.get(e.subject) ?? []
    s.push(e)
    subjectIndex.set(e.subject, s)
    const d = digestIndex.get(e.bodyDigest) ?? []
    d.push(e)
    digestIndex.set(e.bodyDigest, d)
  }

  const reverts = entries.filter(isRevertCommit)
  const links: RevertLink[] = []
  for (const rev of reverts) {
    const body = args.revertBodies?.[rev.sha]
    let resolved: string | null = null
    let resolution: RevertResolutionCode = 'unresolved'

    const viaSha = resolveBySha(body, shaIndex)
    if (viaSha) {
      resolved = viaSha
      resolution = 'sha_mention'
    } else {
      const viaSubject = resolveBySubject(rev, subjectIndex)
      if (viaSubject) {
        resolved = viaSubject
        resolution = 'exact_subject'
      } else {
        const viaDigest = resolveByDigest(rev, digestIndex)
        if (viaDigest) {
          resolved = viaDigest
          resolution = 'digest_match'
        }
      }
    }

    const daysToRevert =
      resolved && shaToEntry.has(resolved)
        ? (parseMs(rev.committedAt) - parseMs(shaToEntry.get(resolved)!.committedAt)) / DAY_MS
        : null

    links.push({
      revertSha: rev.sha,
      revertedSha: resolved,
      resolution,
      revertedAt: rev.committedAt,
      daysToRevert,
    })
  }

  const chains = buildChains(entries, links, pathExcludeRe)

  // Per-path stats
  const commitsByPath = new Map<string, Set<string>>()
  let excludedPaths = 0
  for (const e of entries) {
    for (const p of e.filesTouched) {
      if (pathExcludeRe.test(p)) {
        excludedPaths += 1
        continue
      }
      const s = commitsByPath.get(p) ?? new Set<string>()
      s.add(e.sha)
      commitsByPath.set(p, s)
    }
  }

  const revertCountByPath = new Map<string, number>()
  const daysByPath = new Map<string, number[]>()
  const lastRevertedAtByPath = new Map<string, number>()
  for (const link of links) {
    if (!link.revertedSha) continue
    const orig = shaToEntry.get(link.revertedSha)
    if (!orig) continue
    const revertMs = parseMs(link.revertedAt)
    for (const p of orig.filesTouched) {
      if (pathExcludeRe.test(p)) continue
      revertCountByPath.set(p, (revertCountByPath.get(p) ?? 0) + 1)
      const arr = daysByPath.get(p) ?? []
      if (link.daysToRevert !== null) arr.push(link.daysToRevert)
      daysByPath.set(p, arr)
      const prev = lastRevertedAtByPath.get(p) ?? 0
      if (revertMs > prev) lastRevertedAtByPath.set(p, revertMs)
    }
  }

  const chainsByPath = new Map<string, Set<string>>()
  for (const chain of chains) {
    for (const p of chain.filesInvolved) {
      const s = chainsByPath.get(p) ?? new Set<string>()
      s.add(chain.chainId)
      chainsByPath.set(p, s)
    }
  }

  const pathStats: RevertPathStat[] = []
  for (const [path, revertCount] of revertCountByPath) {
    const commitSet = commitsByPath.get(path)
    if (!commitSet || commitSet.size === 0) continue
    const commitCount = commitSet.size
    const density = revertCount / commitCount
    const lastMs = lastRevertedAtByPath.get(path) ?? 0
    pathStats.push({
      path,
      commitCount,
      revertCount,
      revertDensity: Math.max(0, Math.min(1, density)),
      medianDaysToRevert: median(daysByPath.get(path) ?? []),
      chainsInvolvingPath: chainsByPath.get(path)?.size ?? 0,
      lastRevertedAt: new Date(lastMs).toISOString(),
    })
  }

  pathStats.sort((a, b) => {
    if (b.revertCount !== a.revertCount) return b.revertCount - a.revertCount
    if (b.revertDensity !== a.revertDensity) return b.revertDensity - a.revertDensity
    return a.path.localeCompare(b.path)
  })

  const resolvedReverts = links.filter((l) => l.revertedSha !== null).length
  const unresolvedReverts = links.length - resolvedReverts

  const manifest: RevertChainsManifest = {
    schemaVersion: 1,
    repo: args.corpus.repo,
    window: args.corpus.window,
    createdAt: new Date().toISOString(),
    stats: {
      totalRevertCommits: reverts.length,
      resolvedReverts,
      unresolvedReverts,
      chains: chains.length,
      chainsWithReapply: chains.filter((c) => c.hasReapply).length,
      excludedPaths,
    },
    links,
    chains,
    pathStats,
  }

  const parsed = RevertChainsManifest.safeParse(manifest)
  if (!parsed.success) {
    throw new Error(
      `revert chains manifest failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}
