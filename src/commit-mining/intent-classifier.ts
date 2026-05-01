// pipeline/knowledge/commit-mining/intent-classifier.ts
//
// Deterministic intent-category classifier. Reads a commit subject
// (first line of the message) and returns one of the 12 intent
// categories plus an optional conventionalScope when the message
// follows Conventional Commits shape (e.g. feat(checkout): ...).
//
// No LLM. Rules-based, tight, fast. Matches Conventional Commits
// prefixes first; falls back to keyword heuristics for
// non-conforming messages.

import type { CommitIntentCategoryCode } from './schema'

const CONVENTIONAL_RE =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?!?:\s*(?<rest>.*)$/i

const CONVENTIONAL_TYPE_MAP: Record<string, CommitIntentCategoryCode> = {
  feat: 'feat',
  feature: 'feat',
  fix: 'fix',
  hotfix: 'fix',
  bugfix: 'fix',
  patch: 'fix',
  refactor: 'refactor',
  chore: 'chore',
  test: 'test',
  tests: 'test',
  docs: 'docs',
  doc: 'docs',
  style: 'style',
  perf: 'perf',
  performance: 'perf',
  build: 'build',
  ci: 'ci',
  revert: 'revert',
}

const REVERT_PREFIX_RE = /^\s*Revert\b/i

// Bitbucket merge commit subjects look like:
//   "Merged in bugfix/v3.337.00/POD-14569_2fa_fixes (pull request #8654)"
// The branch prefix carries the intent. Conventional parsing misses
// them because the subject starts with "Merged in".
const BITBUCKET_MERGE_RE = /^\s*Merged in (?<type>[A-Za-z]+)(?:\/|\s|$)/i

const BITBUCKET_TYPE_MAP: Record<string, CommitIntentCategoryCode> = {
  bugfix: 'fix',
  hotfix: 'fix',
  fix: 'fix',
  patch: 'fix',
  feature: 'feat',
  feat: 'feat',
  refactor: 'refactor',
  chore: 'chore',
  docs: 'docs',
  doc: 'docs',
  test: 'test',
  tests: 'test',
  perf: 'perf',
  build: 'build',
  ci: 'ci',
  release: 'chore',
  backmerge: 'chore',
  hotmerge: 'chore',
}
const KEYWORD_FIX_RE =
  /\b(fix(?:es|ed)?|bug|bugs|hotfix|regression|patch|resolve[sd]?|close[sd]?\s+#?\d+)\b/i
const KEYWORD_FEAT_RE = /\b(add|introduce[sd]?|implement(?:s|ed)?|support\s+for|feature)\b/i
const KEYWORD_REFACTOR_RE = /\b(refactor(?:s|ed|ing)?|rename|extract|inline|cleanup|tidy|simplif[yi])\b/i
const KEYWORD_TEST_RE = /\b(tests?|spec|specs|coverage|phpunit|vitest|jest|pest)\b/i
const KEYWORD_DOCS_RE = /\b(docs?|readme|changelog|comments?)\b/i
const KEYWORD_STYLE_RE = /\b(style|format(?:ting)?|indent|whitespace|cs[- ]?fixer|linter?)\b/i
const KEYWORD_PERF_RE = /\b(perf(?:ormance)?|speed(?:\s*up)?|optimi[sz]e[sd]?|faster)\b/i
const KEYWORD_BUILD_RE = /\b(build|webpack|vite|esbuild|rollup|dockerfile|docker(?:-compose)?)\b/i
const KEYWORD_CI_RE = /\b(ci|buildkite|github\s*actions|pipeline|deploy|release)\b/i

export type IntentClassification = {
  category: CommitIntentCategoryCode
  conventionalScope?: string
  source: 'conventional' | 'revert_prefix' | 'keyword' | 'fallback'
}

/**
 * Classify a commit subject. Conventional Commits prefixes take
 * precedence; revert-prefix messages are recognized even when they
 * don't follow Conventional shape; everything else falls through a
 * keyword cascade.
 */
export function classifyIntent(subject: string): IntentClassification {
  const trimmed = subject.trim()
  if (trimmed.length === 0) {
    return { category: 'other', source: 'fallback' }
  }

  const conventional = trimmed.match(CONVENTIONAL_RE)
  if (conventional?.groups) {
    const type = conventional.groups.type.toLowerCase()
    const scope = conventional.groups.scope?.trim()
    const category = CONVENTIONAL_TYPE_MAP[type]
    if (category) {
      const out: IntentClassification = { category, source: 'conventional' }
      if (scope) out.conventionalScope = scope
      return out
    }
  }

  if (REVERT_PREFIX_RE.test(trimmed)) {
    return { category: 'revert', source: 'revert_prefix' }
  }

  const bitbucket = trimmed.match(BITBUCKET_MERGE_RE)
  if (bitbucket?.groups) {
    const type = bitbucket.groups.type.toLowerCase()
    const category = BITBUCKET_TYPE_MAP[type]
    if (category) {
      return { category, source: 'keyword' }
    }
  }

  if (KEYWORD_FIX_RE.test(trimmed)) return { category: 'fix', source: 'keyword' }
  if (KEYWORD_REFACTOR_RE.test(trimmed)) return { category: 'refactor', source: 'keyword' }
  if (KEYWORD_TEST_RE.test(trimmed)) return { category: 'test', source: 'keyword' }
  if (KEYWORD_PERF_RE.test(trimmed)) return { category: 'perf', source: 'keyword' }
  if (KEYWORD_DOCS_RE.test(trimmed)) return { category: 'docs', source: 'keyword' }
  if (KEYWORD_STYLE_RE.test(trimmed)) return { category: 'style', source: 'keyword' }
  if (KEYWORD_BUILD_RE.test(trimmed)) return { category: 'build', source: 'keyword' }
  if (KEYWORD_CI_RE.test(trimmed)) return { category: 'ci', source: 'keyword' }
  if (KEYWORD_FEAT_RE.test(trimmed)) return { category: 'feat', source: 'keyword' }

  return { category: 'other', source: 'fallback' }
}

const TICKET_ID_RE = /\b[A-Z]{2,10}-\d+\b/

/**
 * Extract a ticket id (FOR-123, POD-456, REACH-7) from the subject
 * first, then the body. Same pattern used by the Bitbucket loader
 * so PR ↔ commit correlation is consistent across miners.
 */
export function extractTicketId(subject: string, body: string): string | undefined {
  const fromSubject = subject.match(TICKET_ID_RE)
  if (fromSubject) return fromSubject[0]
  const fromBody = body.match(TICKET_ID_RE)
  if (fromBody) return fromBody[0]
  return undefined
}
