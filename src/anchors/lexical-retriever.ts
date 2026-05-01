// Lexical fallback: tokenize prompt, expand domain synonyms, score
// candidate file paths by token overlap. Surfaces relevant files
// even when prompt vocabulary doesn't overlap commit history.

import type { LexicalRetrievalResult, TargetAnchor } from './anchor-types'
import { isNoisePath } from './anchor-types'
import { tokenizePrompt } from './prompt-tokenizer'
import { buildSynonymExpander } from './synonym-expander'
import { matchPathsByTokens, type MatchOpts } from './path-token-matcher'
import type { LexicalProfile } from '../profiles/contracts'

export type LexicalRetrieverOpts = MatchOpts & {
  topK?: number
  /** Minimum filename-match count to upgrade confidence from low → medium. */
  mediumScoreThreshold?: number
}

export function retrieveLexical(
  promptText: string,
  acceptanceCriteria: string[],
  allFiles: string[],
  lexical: LexicalProfile,
  opts?: LexicalRetrieverOpts,
): LexicalRetrievalResult {
  const topK = opts?.topK ?? 15
  const mediumThreshold = opts?.mediumScoreThreshold ?? 2

  const queryText = [promptText, ...acceptanceCriteria].join(' ')
  const baseTokens = tokenizePrompt(queryText)
  const expand = buildSynonymExpander(lexical)
  const expanded = expand(baseTokens)

  if (expanded.length === 0 || allFiles.length === 0) {
    return {
      anchors: [],
      queryTokens: baseTokens,
      expandedTokens: expanded,
      stats: { filesScanned: allFiles.length, pathsMatched: 0 },
    }
  }

  const matches = matchPathsByTokens(expanded, allFiles, lexical.pathStopwords, opts)
    .filter(m => !isNoisePath(m.path))
    .slice(0, topK)

  const anchors: TargetAnchor[] = matches.map(m => {
    const confidence: 'medium' | 'low' = m.score >= mediumThreshold ? 'medium' : 'low'
    return {
      kind: 'path',
      value: m.path,
      source: 'lexical',
      confidence,
      evidence: [
        `lexical: tokens=[${m.matchedTokens.join(',')}] filename=[${m.filenameMatches.join(',')}] score=${m.score}`,
      ],
      metadata: { retrievalScore: m.score },
    }
  })

  return {
    anchors,
    queryTokens: baseTokens,
    expandedTokens: expanded,
    stats: { filesScanned: allFiles.length, pathsMatched: matches.length },
  }
}
