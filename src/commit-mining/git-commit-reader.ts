// pipeline/knowledge/commit-mining/git-commit-reader.ts
//
// K1.3.1b — GitCommitReader. Spawns `git log` twice against a local
// clone and parses the output into ParsedCommit[]. Injectable
// ProcessRunner so tests run without a real git binary.
//
// Two-pass strategy (cheapest robust parser):
//   Pass A: metadata + body, NULL-delimited records, %x1f field
//           separator. No numstat interleaving to parse.
//   Pass B: per-commit numstat blocks keyed by a stable 'CM<sha>'
//           marker preceding each block.
//
// Results merged by sha. Any commit missing from the numstat side
// is emitted with filesTouched=[], additions=0, deletions=0 (rare:
// empty commits or history rewrites).

import type { CommitReader, CommitReaderOptions } from './commit-corpus'
import type { ParsedCommit, PerFileDelta } from './commit-filter'

export type ProcessRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>

const defaultRunner: ProcessRunner = async (cmd, args, opts) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const res = await run(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  })
  return { stdout: res.stdout.toString(), stderr: res.stderr.toString() }
}

export type GitCommitReaderOptions = {
  runner?: ProcessRunner
  timeoutMs?: number
  gitBinary?: string
}

export type ParsedCommitMetadata = Omit<
  ParsedCommit,
  'filesTouched' | 'additions' | 'deletions'
>

export type ParsedNumstat = {
  files: string[]
  additions: number
  deletions: number
  perFile: PerFileDelta[]
}

const METADATA_FORMAT =
  '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B%x00'

const NUMSTAT_FORMAT = 'CM%H'

function buildLogArgs(
  format: string,
  extra: string[],
  opts: CommitReaderOptions,
): string[] {
  const args = [
    'log',
    '--first-parent',
    '--no-show-signature',
    `--format=${format}`,
    ...extra,
  ]
  if (opts.since) args.push(`--since=${opts.since}`)
  if (opts.until) args.push(`--until=${opts.until}`)
  return args
}

export function parseMetadataOutput(raw: string): ParsedCommitMetadata[] {
  const commits: ParsedCommitMetadata[] = []
  const records = raw.split('\u0000')
  for (const record of records) {
    const trimmed = record.replace(/^\s+/, '')
    if (trimmed.length === 0) continue
    const fields = trimmed.split('\u001f')
    if (fields.length < 7) continue
    const [sha, parentsRaw, authorNickname, authorEmail, committedAtRaw, subject, ...bodyParts] =
      fields
    const body = bodyParts.join('\u001f')
    const shaClean = sha.trim()
    if (shaClean.length < 7) continue
    const parents = parentsRaw.trim().length > 0
      ? parentsRaw.trim().split(/\s+/).filter((p) => p.length > 0)
      : []
    const committedAtMs = Date.parse(committedAtRaw.trim())
    if (!Number.isFinite(committedAtMs)) continue
    const committedAt = new Date(committedAtMs).toISOString()
    commits.push({
      sha: shaClean,
      parentShas: parents,
      authorNickname: authorNickname.trim(),
      authorEmail: authorEmail.trim(),
      committedAt,
      subject,
      body: body.replace(/\r\n/g, '\n').replace(/\n+$/, ''),
    })
  }
  return commits
}

export function parseNumstatOutput(raw: string): Map<string, ParsedNumstat> {
  const map = new Map<string, ParsedNumstat>()
  const lines = raw.split('\n')
  let currentSha: string | null = null
  let current: ParsedNumstat | null = null
  const finalize = () => {
    if (currentSha !== null && current !== null) {
      map.set(currentSha, current)
    }
  }
  for (const line of lines) {
    if (line.startsWith('CM')) {
      finalize()
      const sha = line.slice(2).trim()
      currentSha = sha
      current = { files: [], additions: 0, deletions: 0, perFile: [] }
      continue
    }
    if (line.trim().length === 0) continue
    if (current === null) continue
    const tab = line.split('\t')
    if (tab.length < 3) continue
    const [addsRaw, delsRaw, ...pathParts] = tab
    const path = pathParts.join('\t').trim()
    if (path.length === 0) continue
    const adds = addsRaw === '-' ? 0 : Number.parseInt(addsRaw, 10)
    const dels = delsRaw === '-' ? 0 : Number.parseInt(delsRaw, 10)
    const addsSafe = Number.isFinite(adds) ? adds : 0
    const delsSafe = Number.isFinite(dels) ? dels : 0
    current.additions += addsSafe
    current.deletions += delsSafe
    current.files.push(path)
    current.perFile.push({ path, additions: addsSafe, deletions: delsSafe })
  }
  finalize()
  return map
}

export class GitCommitReader implements CommitReader {
  private readonly runner: ProcessRunner
  private readonly timeoutMs: number
  private readonly gitBinary: string

  constructor(opts: GitCommitReaderOptions = {}) {
    this.runner = opts.runner ?? defaultRunner
    this.timeoutMs = opts.timeoutMs ?? 300_000
    this.gitBinary = opts.gitBinary ?? 'git'
  }

  async readCommits(opts: CommitReaderOptions): Promise<ParsedCommit[]> {
    const metaArgs = buildLogArgs(METADATA_FORMAT, [], opts)
    const numArgs = buildLogArgs(NUMSTAT_FORMAT, ['--numstat'], opts)

    const metaResult = await this.runner(this.gitBinary, metaArgs, {
      cwd: opts.repoRoot,
      timeout: this.timeoutMs,
    })
    const numResult = await this.runner(this.gitBinary, numArgs, {
      cwd: opts.repoRoot,
      timeout: this.timeoutMs,
    })

    const metadata = parseMetadataOutput(metaResult.stdout)
    const numstat = parseNumstatOutput(numResult.stdout)

    return metadata.map((m) => {
      const ns = numstat.get(m.sha)
      const out: ParsedCommit = {
        ...m,
        filesTouched: ns?.files ?? [],
        additions: ns?.additions ?? 0,
        deletions: ns?.deletions ?? 0,
      }
      if (ns && ns.perFile.length > 0) out.perFileDelta = ns.perFile
      return out
    })
  }
}
