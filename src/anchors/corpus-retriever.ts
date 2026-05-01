import type { CommitCorpusEntry } from '../commit-mining'
import type { CorpusRetrievalResult, TargetAnchor } from './anchor-types'
import { isNoisePath } from './anchor-types'

const STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'when', 'where', 'what', 'which',
  'should', 'could', 'would', 'must', 'will', 'also', 'after', 'before',
  'during', 'between', 'about', 'above', 'below', 'into', 'through', 'from',
  'with', 'without', 'under', 'over', 'each', 'every', 'some', 'any', 'all',
  'both', 'either', 'neither', 'other', 'another', 'such', 'only', 'just',
  'very', 'most', 'more', 'less', 'few', 'many', 'much', 'however',
  'therefore', 'because', 'since', 'while', 'although', 'though', 'unless',
  'until', 'once', 'here', 'there', 'then', 'now', 'already', 'still', 'yet',
  'and', 'but', 'for', 'nor', 'not', 'are', 'was', 'were', 'been', 'being',
  'have', 'has', 'had', 'does', 'did', 'can',
  'php', 'class', 'function', 'return', 'public', 'private', 'protected',
  'static', 'use', 'namespace', 'new', 'throw', 'try', 'catch', 'extends',
  'implements', 'interface', 'trait', 'abstract', 'final', 'const',
])

export function tokenize(text: string): string[] {
  if (!text) return []
  const stripped = text.replace(/\.php\b/g, '')
  const parts = stripped.split(/[\s\/\\_\-]+/)
  const tokens: string[] = []
  for (const part of parts) {
    if (!part) continue
    const camelSplit = part.replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
    for (const seg of camelSplit) {
      const lower = seg.toLowerCase()
      if (lower.length < 3) continue
      if (STOPWORDS.has(lower)) continue
      tokens.push(lower)
    }
  }
  return tokens
}

export type CorpusRetrieverOpts = {
  topK?: number
  recencyHalfLifeDays?: number
  intentBoost?: number
  pathSegmentBoost?: number
}

export function retrieveFromCorpus(
  ticketTitle: string,
  ticketBody: string,
  acceptanceCriteria: string[],
  corpus: CommitCorpusEntry[],
  opts?: CorpusRetrieverOpts,
): CorpusRetrievalResult {
  const topK = opts?.topK ?? 7
  const halfLife = opts?.recencyHalfLifeDays ?? 180
  const intentBoostVal = opts?.intentBoost ?? 0.1
  const pathBoostVal = opts?.pathSegmentBoost ?? 0.3
  const maxPathBonus = 3 * pathBoostVal

  const queryText = [ticketTitle, ticketBody, ...acceptanceCriteria].join(' ')
  const queryTokens = [...new Set(tokenize(queryText))]
  if (queryTokens.length === 0 || corpus.length === 0) {
    return {
      anchors: [],
      matchedCommitShas: [],
      queryTokens,
      stats: { docsSeen: corpus.length, docsMatched: 0, pathsConsidered: 0, droppedBelowThreshold: 0 },
    }
  }

  type Doc = { entry: CommitCorpusEntry; tokens: string[]; pathSegments: Set<string> }
  const docs: Doc[] = corpus.map(entry => {
    const searchText = entry.subject + ' ' + entry.filesTouched.join(' ')
    const tokens = tokenize(searchText)
    const pathSegments = new Set<string>()
    for (const f of entry.filesTouched) {
      for (const seg of f.replace(/\.php$/, '').split('/')) {
        for (const token of tokenize(seg)) pathSegments.add(token)
      }
    }
    return { entry, tokens, pathSegments }
  })

  const N = docs.length
  const k1 = 1.5
  const b = 0.75
  const avgDl = docs.reduce((s, d) => s + d.tokens.length, 0) / N

  const df = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set<string>()
    for (const t of doc.tokens) {
      if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) ?? 0) + 1) }
    }
  }

  const now = Date.now()
  const scored: Array<{ doc: Doc; score: number }> = []
  for (const doc of docs) {
    const tf = new Map<string, number>()
    for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1)

    let bm25 = 0
    for (const term of queryTokens) {
      const termDf = df.get(term) ?? 0
      const termTf = tf.get(term) ?? 0
      if (termTf === 0) continue
      const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5) + 1)
      const tfNorm = (termTf * (k1 + 1)) / (termTf + k1 * (1 - b + b * doc.tokens.length / avgDl))
      bm25 += idf * tfNorm
    }

    let pathBonus = 0
    for (const qt of queryTokens) {
      if (doc.pathSegments.has(qt)) pathBonus += pathBoostVal
    }
    pathBonus = Math.min(pathBonus, maxPathBonus)

    const ageDays = (now - new Date(doc.entry.committedAt).getTime()) / (1000 * 60 * 60 * 24)
    const recencyFactor = Math.pow(0.5, ageDays / halfLife)
    let score = (bm25 + pathBonus) * (1 + 0.2 * recencyFactor)

    const titleLower = ticketTitle.toLowerCase()
    if (/\b(fix|bug|broken|error|issue)\b/.test(titleLower) && doc.entry.intentCategory === 'fix') {
      score += intentBoostVal
    } else if (/\b(feat|add|implement|create|new)\b/.test(titleLower) && doc.entry.intentCategory === 'feat') {
      score += intentBoostVal
    }

    if (bm25 > 0) scored.push({ doc, score })
  }

  scored.sort((a, b) => b.score - a.score)
  const topDocs = scored.slice(0, topK)

  type PathAgg = { supportCommits: Array<{ sha: string; score: number; rank: number }>; weightedScore: number }
  const pathAgg = new Map<string, PathAgg>()
  for (let rank = 0; rank < topDocs.length; rank++) {
    const { doc, score } = topDocs[rank]
    const fileCount = doc.entry.filesTouched.length || 1
    const weight = score / fileCount
    for (const path of doc.entry.filesTouched) {
      if (isNoisePath(path)) continue
      let agg = pathAgg.get(path)
      if (!agg) { agg = { supportCommits: [], weightedScore: 0 }; pathAgg.set(path, agg) }
      agg.supportCommits.push({ sha: doc.entry.sha, score, rank })
      agg.weightedScore += weight
    }
  }

  const weightedScores = [...pathAgg.values()].map(a => a.weightedScore).sort((a, b) => a - b)
  const median = weightedScores.length > 0
    ? weightedScores[Math.floor(weightedScores.length / 2)]
    : 0

  const sorted = [...pathAgg.entries()].sort((a, b) => b[1].weightedScore - a[1].weightedScore)

  const anchors: TargetAnchor[] = []
  const matchedCommitShas = new Set<string>()
  for (const [path, agg] of sorted) {
    const supportCount = agg.supportCommits.length
    let confidence: 'high' | 'medium' | 'low'
    if (supportCount >= 2 && agg.weightedScore >= median * 1.25) {
      confidence = 'high'
    } else if (supportCount >= 1 && agg.weightedScore >= median) {
      confidence = 'medium'
    } else {
      confidence = 'low'
    }
    const evidence = agg.supportCommits.map(c =>
      `corpus_match: commit ${c.sha.slice(0, 8)} path=${path} score=${c.score.toFixed(2)}`
    )
    for (const c of agg.supportCommits) matchedCommitShas.add(c.sha)
    anchors.push({
      kind: 'path',
      value: path,
      source: 'corpus_match',
      confidence,
      evidence,
      metadata: {
        retrievalScore: agg.weightedScore,
        supportCount,
      },
    })
  }

  return {
    anchors,
    matchedCommitShas: [...matchedCommitShas],
    queryTokens,
    stats: {
      docsSeen: corpus.length,
      docsMatched: scored.length,
      pathsConsidered: pathAgg.size,
      droppedBelowThreshold: 0,
    },
  }
}
