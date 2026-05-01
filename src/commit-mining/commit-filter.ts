// commit-mining/commit-filter.ts
//
// K1.3 hard-filter pass applied to parsed commits before they enter
// the corpus.

import type { PerFileDelta } from './schema'
export type { PerFileDelta } from './schema'

import type {
  FilterConfig,
  FilterExclusionReasonCode,
} from './schema'

// Bump when filter logic / DEFAULT_FILTER_CONFIG semantics change.
// Used as part of the corpus cache key so behavior changes invalidate
// previously-cached corpora automatically.
export const FILTER_CONFIG_VERSION = '1'

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  megaFileThreshold: 50,
  megaLineThreshold: 2_000,
  excludeDocsOnly: true,
  excludeDependencyChurn: true,
  botNicknames: [
    'dependabot',
    'renovate',
    'renovate-bot',
    'snyk-bot',
    'atlassian-bitbucket-pipelines',
    'github-actions',
  ],
  extraBotEmailSuffixes: [
    '[bot]',
    '-bot',
    'noreply@github.com',
    'renovate@whitesourcesoftware.com',
  ],
}

export type ParsedCommit = {
  sha: string
  parentShas: string[]
  authorNickname: string
  authorEmail: string
  committedAt: string
  subject: string
  body: string
  filesTouched: string[]
  additions: number
  deletions: number
  perFileDelta?: PerFileDelta[]
}

export type FilterDecision =
  | { kept: true }
  | { kept: false; reason: FilterExclusionReasonCode }

const NOISE_SUBJECT_RE =
  /^\s*(?:wip|update|fix|merge|revert|typo|chore)\s*[.!:]?\s*$/i

const DOCS_ONLY_RE = /^(?:docs\/|README|CHANGELOG|LICENSE|.*\.md$)/i
const DEP_CHURN_RE =
  /^(?:vendor\/|node_modules\/|composer\.lock$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|.*\.min\.(?:js|css)$)/i

export function isBotAuthor(
  nickname: string,
  email: string,
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): boolean {
  const nick = nickname.trim().toLowerCase()
  if (config.botNicknames.some((b) => nick === b.toLowerCase())) return true
  if (nick.endsWith('[bot]') || nick.endsWith('-bot')) return true
  const emailLower = email.trim().toLowerCase()
  if (emailLower.includes('[bot]')) return true
  if (config.extraBotEmailSuffixes.some((s) => emailLower.endsWith(s.toLowerCase()))) {
    return true
  }
  return false
}

export function isMergeCommit(parents: string[]): boolean {
  return parents.length > 1
}

export function isNoiseSubject(subject: string): boolean {
  return NOISE_SUBJECT_RE.test(subject)
}

export function isDocsOnly(filesTouched: string[]): boolean {
  if (filesTouched.length === 0) return false
  return filesTouched.every((f) => DOCS_ONLY_RE.test(f))
}

export function isDependencyChurn(filesTouched: string[]): boolean {
  if (filesTouched.length === 0) return false
  return filesTouched.every((f) => DEP_CHURN_RE.test(f))
}

/**
 * Apply hard excludes in cheapest-first order. Returns the first
 * reason that matches; caller maps into a FilterStats bucket.
 */
export function evaluateFilter(
  commit: ParsedCommit,
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): FilterDecision {
  if (isMergeCommit(commit.parentShas)) {
    return { kept: false, reason: 'merge_commit' }
  }
  if (isBotAuthor(commit.authorNickname, commit.authorEmail, config)) {
    return { kept: false, reason: 'bot_author' }
  }
  if (isNoiseSubject(commit.subject)) {
    return { kept: false, reason: 'noise_message' }
  }
  if (commit.filesTouched.length > config.megaFileThreshold) {
    return { kept: false, reason: 'mega_file_count' }
  }
  if (commit.additions + commit.deletions > config.megaLineThreshold) {
    return { kept: false, reason: 'mega_line_count' }
  }
  if (config.excludeDocsOnly && isDocsOnly(commit.filesTouched)) {
    return { kept: false, reason: 'docs_only' }
  }
  if (config.excludeDependencyChurn && isDependencyChurn(commit.filesTouched)) {
    return { kept: false, reason: 'dependency_churn' }
  }
  return { kept: true }
}
