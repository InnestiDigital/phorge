// Score files by token overlap between prompt tokens and path tokens.
//
// Path tokens come from splitting on `/`, `.`, `-`, `_`, and camelCase
// boundaries, then stemming with the same stemmer as the prompt
// tokenizer so vocabularies line up.

import { stem } from './prompt-tokenizer'

export type PathMatch = {
  path: string
  score: number
  matchedTokens: string[]
  filenameMatches: string[]
}

export function tokenizePath(path: string): { all: string[]; filename: string[] } {
  const lastSlash = path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : ''
  const file = lastSlash >= 0 ? path.slice(lastSlash + 1) : path
  const fileBase = file.replace(/\.[a-z0-9]+$/i, '')

  const split = (s: string): string[] => {
    const parts = s.split(/[\/.\-_]+/)
    const out: string[] = []
    for (const p of parts) {
      if (!p) continue
      const camel = p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/\s+/)
      for (const seg of camel) {
        const lower = seg.toLowerCase()
        if (lower.length < 3) continue
        out.push(stem(lower))
      }
    }
    return out
  }

  return { all: [...split(dir), ...split(fileBase)], filename: split(fileBase) }
}

export type MatchOpts = {
  /** Bonus multiplier when a token appears in the filename vs only in dir. */
  filenameBoost?: number
  /** Drop any file whose score is below this. */
  minScore?: number
}

export function matchPathsByTokens(
  tokens: string[],
  allFiles: string[],
  pathStopwords: ReadonlySet<string>,
  opts?: MatchOpts,
): PathMatch[] {
  const filenameBoost = opts?.filenameBoost ?? 2
  const minScore = opts?.minScore ?? 1

  const queryTokens = new Set(tokens.filter(t => !pathStopwords.has(t)))
  if (queryTokens.size === 0) return []

  const results: PathMatch[] = []
  for (const file of allFiles) {
    const { all, filename } = tokenizePath(file)
    if (all.length === 0) continue
    const allSet = new Set(all)
    const fileSet = new Set(filename)

    let score = 0
    const matched: string[] = []
    const fnameMatched: string[] = []
    for (const qt of queryTokens) {
      if (fileSet.has(qt)) {
        score += filenameBoost
        matched.push(qt)
        fnameMatched.push(qt)
      } else if (allSet.has(qt)) {
        score += 1
        matched.push(qt)
      }
    }

    if (score >= minScore) {
      results.push({ path: file, score, matchedTokens: matched, filenameMatches: fnameMatched })
    }
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return results
}
