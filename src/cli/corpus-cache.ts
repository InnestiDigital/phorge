// Lazy corpus + derived signals with on-disk content-keyed cache.
//
// Building the commit corpus is the expensive step (git log walk
// over many years of history). Cache it in `.phorge/corpus-<key>.json`
// where the key is derived from HEAD sha + since + filter config version.
// Derived signals (co-change, volatility, revert chains) are cheap to
// recompute from the cached corpus.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  buildCommitCorpus,
  buildCoChangeMatrix,
  buildVolatilityMap,
  buildRevertChains,
  GitCommitReader,
  FILTER_CONFIG_VERSION,
  type CommitCorpusManifest,
  type CoChangeMatrixManifest,
  type VolatilityMapManifest,
  type RevertChainsManifest,
} from '../commit-mining'
import type { FileScopeProvider } from '../profiles/contracts'
import { NullLanguageProfile } from '../profiles/null-objects'

export type RepoSignals = {
  corpus: CommitCorpusManifest
  coChange: CoChangeMatrixManifest
  volatility: VolatilityMapManifest
  reverts: RevertChainsManifest
  /** PHP file paths (repo-root relative) for lexical anchor matching. */
  allFiles: string[]
}

const LEXICAL_FILES_TTL_MS = 1000 * 60 * 60 * 24 // 24h

export function listScopedFiles(repoPath: string, scope: FileScopeProvider): string[] {
  // Prefer git's view of "what's source" — respects nested .gitignore + per-repo
  // customs (cdk.out, .terraform, .serverless, etc) without us hardcoding them.
  const gitFiles = tryGitListFiles(repoPath)
  if (gitFiles) {
    const matched = gitFiles.filter(p => scope.matches(p))
    if (scope.scanRoots.length === 0) return matched.sort()
    return matched.filter(p => scope.scanRoots.some(r => p === r || p.startsWith(r + '/'))).sort()
  }

  // Fallback: recursive walk + manual ignoreDirs (non-git directories).
  const out: string[] = []
  const ignore = new Set(scope.ignoreDirs)
  if (scope.scanRoots.length === 0) {
    walkScope(repoPath, repoPath, scope, ignore, out)
  } else {
    for (const root of scope.scanRoots) {
      const abs = join(repoPath, root)
      if (!existsSync(abs)) continue
      walkScope(abs, repoPath, scope, ignore, out)
    }
  }
  out.sort()
  return out
}

function tryGitListFiles(repoPath: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function walkScope(
  dir: string,
  repoRoot: string,
  scope: FileScopeProvider,
  ignore: Set<string>,
  acc: string[],
): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (ignore.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      walkScope(full, repoRoot, scope, ignore, acc)
    } else if (e.isFile()) {
      const rel = relative(repoRoot, full)
      if (scope.matches(rel)) acc.push(rel)
    }
  }
}

/** @deprecated kept for back-compat with existing imports — use listScopedFiles. */
export function listPhpFiles(repoPath: string, roots?: string[]): string[] {
  const scope: FileScopeProvider = roots
    ? {
        extensions: ['.php'],
        scanRoots: roots,
        ignoreDirs: ['node_modules', 'vendor'],
        matches: (p) => p.endsWith('.php'),
      }
    : {
        extensions: ['.php'],
        scanRoots: ['app', 'routes', 'tests', 'database/migrations', 'config'],
        ignoreDirs: ['node_modules', 'vendor'],
        matches: (p) => p.endsWith('.php'),
      }
  return listScopedFiles(repoPath, scope)
}

function loadOrBuildAllFiles(
  repoPath: string,
  cacheDir: string,
  scope: FileScopeProvider,
  profileId: string,
): string[] {
  const cachePath = join(cacheDir, `lexical-files-${profileId}.json`)
  if (existsSync(cachePath)) {
    try {
      const age = Date.now() - statSync(cachePath).mtimeMs
      if (age < LEXICAL_FILES_TTL_MS) {
        const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as { files: string[] }
        if (Array.isArray(parsed.files)) return parsed.files
      }
    } catch {
      // fallthrough
    }
  }
  const files = listScopedFiles(repoPath, scope)
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachePath, JSON.stringify({ files }, null, 2))
  } catch {
    // cache write is best-effort
  }
  return files
}

export type HeadShaReader = (repoPath: string) => string | null

export type LoadOpts = {
  repoPath: string
  repoName?: string
  since?: string
  forceRebuild?: boolean
  cacheDir?: string
  // Injectable for tests; default reads via `git rev-parse HEAD`.
  readHeadSha?: HeadShaReader
  fileScope?: FileScopeProvider
  profileId?: string
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 // 24h fallback (no-git case)
const MAX_CACHE_ENTRIES = 5
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30 // 30d

let warnedNoGit = false

export function cacheKey(
  headSha: string,
  since: string,
  filterConfigVersion: string,
): string {
  const head8 = headSha.slice(0, 8)
  const digest = createHash('sha256')
    .update(`${headSha}|${since}|${filterConfigVersion}`)
    .digest('hex')
    .slice(0, 8)
  return `${head8}-${digest}-v${filterConfigVersion}`
}

export const defaultReadHeadSha: HeadShaReader = (repoPath) => {
  try {
    const out = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    })
    return out.trim() || null
  } catch {
    return null
  }
}

export async function loadRepoSignals(opts: LoadOpts): Promise<RepoSignals> {
  const cacheDir = opts.cacheDir ?? join(opts.repoPath, '.phorge')
  const readHead = opts.readHeadSha ?? defaultReadHeadSha
  const sinceRaw = opts.since ?? defaultSince()
  const since = normalizeSince(sinceRaw)

  const headSha = readHead(opts.repoPath)

  let corpusPath: string
  let key: string | null = null
  let useTtlFallback = false

  if (headSha) {
    key = cacheKey(headSha, since, FILTER_CONFIG_VERSION)
    corpusPath = join(cacheDir, `corpus-${key}.json`)
  } else {
    if (!warnedNoGit) {
      // eslint-disable-next-line no-console
      console.warn(
        '[phorge] could not resolve git HEAD — falling back to 24h TTL cache',
      )
      warnedNoGit = true
    }
    useTtlFallback = true
    corpusPath = join(cacheDir, 'corpus.json')
  }

  let corpus: CommitCorpusManifest | null = null
  if (!opts.forceRebuild) {
    if (useTtlFallback) {
      if (isCacheFresh(corpusPath)) {
        corpus = tryRead(corpusPath)
      }
    } else if (existsSync(corpusPath)) {
      corpus = tryRead(corpusPath)
    }
  }

  if (!corpus) {
    const reader = new GitCommitReader()
    corpus = await buildCommitCorpus({
      reader,
      repo: opts.repoName ?? 'repo',
      repoRoot: opts.repoPath,
      since,
    })
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
    writeFileSync(corpusPath, JSON.stringify(corpus, null, 2))
    if (key && headSha) {
      writePointer(cacheDir, {
        key,
        headSha,
        since,
        generatedAt: new Date().toISOString(),
        path: `corpus-${key}.json`,
      })
      cleanupStaleEntries(cacheDir, `corpus-${key}.json`)
    }
  }

  const coChange = buildCoChangeMatrix({ corpus })
  const volatility = buildVolatilityMap({ corpus })
  const reverts = buildRevertChains({ corpus })
  const scope = opts.fileScope ?? NullLanguageProfile.fileScope
  const profileId = opts.profileId ?? NullLanguageProfile.id
  const allFiles = scope.scanRoots.length > 0
    ? loadOrBuildAllFiles(opts.repoPath, cacheDir, scope, profileId)
    : []

  return { corpus, coChange, volatility, reverts, allFiles }
}

function tryRead(path: string): CommitCorpusManifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CommitCorpusManifest
  } catch {
    return null
  }
}

function isCacheFresh(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const age = Date.now() - statSync(path).mtimeMs
    return age < CACHE_TTL_MS
  } catch {
    return false
  }
}

function normalizeSince(sinceRaw: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)
    ? `${sinceRaw}T00:00:00.000Z`
    : sinceRaw
}

function defaultSince(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 36)
  return d.toISOString()
}

type Pointer = {
  key: string
  headSha: string
  since: string
  generatedAt: string
  path: string
}

function writePointer(cacheDir: string, pointer: Pointer): void {
  writeFileSync(
    join(cacheDir, 'corpus-current.json'),
    JSON.stringify(pointer, null, 2),
  )
}

function cleanupStaleEntries(cacheDir: string, keepFile: string): void {
  let names: string[]
  try {
    names = readdirSync(cacheDir)
  } catch {
    return
  }
  type Entry = { name: string; mtime: number }
  const entries: Entry[] = []
  const now = Date.now()
  for (const name of names) {
    if (!/^corpus-.+\.json$/.test(name)) continue
    if (name === 'corpus-current.json') continue
    const full = join(cacheDir, name)
    let mtime = 0
    try {
      mtime = statSync(full).mtimeMs
    } catch {
      continue
    }
    // Age-based deletion: drop anything older than 30 days (except the one
    // we just wrote).
    if (name !== keepFile && now - mtime > CACHE_MAX_AGE_MS) {
      try {
        unlinkSync(full)
      } catch {
        /* ignore */
      }
      continue
    }
    entries.push({ name, mtime })
  }
  // Count-based deletion: keep newest MAX_CACHE_ENTRIES, drop the rest
  // (but never the file we just wrote).
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries.sort((a, b) => b.mtime - a.mtime) // newest first
    for (const e of entries.slice(MAX_CACHE_ENTRIES)) {
      if (e.name === keepFile) continue
      try {
        unlinkSync(join(cacheDir, e.name))
      } catch {
        /* ignore */
      }
    }
  }
}
