// pipeline/knowledge/commit-mining/commit-corpus.ts
//
// K1.3.1 commit-corpus orchestrator. Composes CommitReader +
// evaluateFilter + classifyIntent + extractTicketId into a single
// pass producing a CommitCorpusManifest. The reader is injectable
// (static for tests, git-log-backed for production in K1.3.1b).

import { createHash } from 'node:crypto'
import {
  CommitCorpusManifest,
  type CommitCorpusEntry,
  type CommitIntentCategoryCode,
  type FilterConfig,
  type FilterExclusionReasonCode,
} from './schema'
import {
  DEFAULT_FILTER_CONFIG,
  evaluateFilter,
  isBotAuthor,
  type ParsedCommit,
} from './commit-filter'
import { classifyIntent, extractTicketId } from './intent-classifier'

export type CommitReaderOptions = {
  repoRoot: string
  since?: string
  until?: string
}

export interface CommitReader {
  readCommits(opts: CommitReaderOptions): Promise<ParsedCommit[]>
}

/**
 * In-memory commit reader for tests and offline analysis. Applies
 * since/until filtering on committedAt so tests can exercise the
 * same window semantics as the git-log backed reader.
 */
export class StaticCommitReader implements CommitReader {
  constructor(private readonly commits: readonly ParsedCommit[]) {}

  async readCommits(opts: CommitReaderOptions): Promise<ParsedCommit[]> {
    const since = opts.since ? Date.parse(opts.since) : undefined
    const until = opts.until ? Date.parse(opts.until) : undefined
    return this.commits.filter((c) => {
      const ts = Date.parse(c.committedAt)
      if (!Number.isFinite(ts)) return false
      if (since !== undefined && ts < since) return false
      if (until !== undefined && ts > until) return false
      return true
    })
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function normalizeBody(body: string): string {
  // Normalize EOLs, strip trailer lines (Signed-off-by, Co-Authored-By)
  // and collapse trailing whitespace so equivalent commits produce
  // equivalent bodyDigests.
  const lines = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(?:signed-off-by|co-authored-by|reviewed-by):/i.test(l))
    .map((l) => l.replace(/[ \t]+$/g, ''))
  return lines.join('\n').replace(/\n+$/, '')
}

function emptyStats(): CommitCorpusManifest['stats'] {
  return {
    totalConsidered: 0,
    kept: 0,
    excluded: {},
    byIntent: {},
  }
}

export type BuildCommitCorpusArgs = {
  reader: CommitReader
  repo: string
  repoRoot: string
  since?: string
  until?: string
  filterConfig?: FilterConfig
  createdAt?: string
}

/**
 * Build a CommitCorpusManifest from a reader + window. All filter
 * decisions are recorded in stats.excluded so calibration runs can
 * inspect why commits were dropped.
 */
export async function buildCommitCorpus(
  args: BuildCommitCorpusArgs,
): Promise<CommitCorpusManifest> {
  const filter = args.filterConfig ?? DEFAULT_FILTER_CONFIG
  const commits = await args.reader.readCommits({
    repoRoot: args.repoRoot,
    since: args.since,
    until: args.until,
  })

  const stats = emptyStats()
  const entries: CommitCorpusEntry[] = []

  for (const commit of commits) {
    stats.totalConsidered += 1
    const decision = evaluateFilter(commit, filter)
    if (!decision.kept) {
      const reason: FilterExclusionReasonCode = decision.reason
      stats.excluded[reason] = (stats.excluded[reason] ?? 0) + 1
      continue
    }

    const intent = classifyIntent(commit.subject)
    const ticketId = extractTicketId(commit.subject, commit.body)
    const body = normalizeBody(commit.body)
    const entry: CommitCorpusEntry = {
      sha: commit.sha,
      parentSha: commit.parentShas[0] ?? null,
      authorNickname: commit.authorNickname,
      authorEmail: commit.authorEmail,
      authorIsBot: isBotAuthor(commit.authorNickname, commit.authorEmail, filter),
      committedAt: commit.committedAt,
      subject: commit.subject.trim(),
      bodyDigest: sha256Hex(body),
      filesTouched: [...commit.filesTouched],
      additions: commit.additions,
      deletions: commit.deletions,
      intentCategory: intent.category,
    }
    if (commit.perFileDelta && commit.perFileDelta.length > 0) {
      entry.perFileDelta = commit.perFileDelta.map((d) => ({ ...d }))
    }
    if (ticketId) entry.ticketId = ticketId
    if (intent.conventionalScope) entry.conventionalScope = intent.conventionalScope

    entries.push(entry)
    stats.kept += 1
    const cat: CommitIntentCategoryCode = intent.category
    stats.byIntent[cat] = (stats.byIntent[cat] ?? 0) + 1
  }

  const manifest: CommitCorpusManifest = {
    schemaVersion: 1,
    repo: args.repo,
    window: {
      ...(args.since ? { from: args.since } : {}),
      ...(args.until ? { to: args.until } : {}),
    },
    createdAt: args.createdAt ?? new Date().toISOString(),
    filter,
    stats,
    entries,
  }

  const parsed = CommitCorpusManifest.safeParse(manifest)
  if (!parsed.success) {
    throw new Error(
      `commit corpus manifest failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}
