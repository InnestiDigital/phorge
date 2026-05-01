// Prompt tokenizer + lightweight stemmer.
//
// Goal: turn a free-form natural-language prompt into a small bag of
// stemmed content tokens suitable for matching against file paths
// or commit text. NO npm deps — pure string ops.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'must', 'shall',
  'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while', 'as',
  'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between',
  'into', 'through', 'during', 'to', 'from', 'in', 'on', 'off',
  'out', 'over', 'under', 'again', 'further', 'so', 'than', 'too',
  'very', 'just', 'also', 'only', 'own', 'same', 'such', 'no', 'not',
  'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'she', 'it', 'its', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'how', 'why', 'where',
  // Common imperative verbs in tickets — semantically empty for retrieval.
  'fix', 'add', 'make', 'use', 'using', 'need', 'needs', 'needed',
  'want', 'wants', 'please', 'thing', 'things', 'stuff', 'something',
  'correctly', 'properly', 'currently', 'still', 'now',
])

/** Strip a small set of common English suffixes. Approximate, not Porter-perfect. */
export function stem(word: string): string {
  if (word.length <= 3) return word
  const suffixes = ['ations', 'ation', 'tions', 'tion', 'ings', 'ing', 'ies', 'edly', 'ed', 'ly', 'es', 'er', 's']
  for (const suf of suffixes) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      let base = word.slice(0, -suf.length)
      // -ies → -y (e.g., "policies" → "polic" → "policy")
      if (suf === 'ies') base = base + 'y'
      return base
    }
  }
  return word
}

export function tokenizePrompt(text: string): string[] {
  if (!text) return []
  const lowered = text.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ')
  const out: string[] = []
  for (const raw of lowered.split(/\s+/)) {
    if (!raw) continue
    if (raw.length < 3) continue
    if (STOPWORDS.has(raw)) continue
    const stemmed = stem(raw)
    if (stemmed.length < 3) continue
    if (STOPWORDS.has(stemmed)) continue
    out.push(stemmed)
  }
  return out
}
