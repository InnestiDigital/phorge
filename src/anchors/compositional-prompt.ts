// anchors/compositional-prompt.ts
//
// Detects "X vs Y" / "X against Y" / "differences between X and Y" style
// prompts where the user is asking phorge to compare two distinct subjects.
// Without this split, both subjects collapse into one token bag and ranked
// files come back interleaved, forcing manual demixing.
//
// Zero LLM. Pure regex + lightweight tokenization.

export type CompositionalSubject = {
  label: string
  promptText: string
}

export type CompositionalSplit =
  | { kind: 'single'; promptText: string }
  | { kind: 'compositional'; subjects: ReadonlyArray<CompositionalSubject> }

const MIN_SUBJECT_TOKENS = 3

// Order matters: longer/more-specific patterns first, otherwise short ones
// (e.g. "X against Y") swallow longer ones ("gaps in X vs Y").
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'review-and-find-gaps',
    re: /(?:review|audit|inspect)\s+(.+?)\s+(?:and|alongside|with)\s+(?:identify|find|spot|surface)\s+(?:gaps|bugs|issues|differences)[\s\S]*?\b(?:against|vs\.?|compared\s+to)\s+(.+)/i,
  },
  {
    name: 'gaps-in-X-vs-Y',
    re: /\bgaps?\s+(?:in|of|between)\s+(.+?)\s+(?:vs\.?|versus|compared\s+to|against)\s+(.+)/i,
  },
  {
    name: 'differences-between-X-and-Y',
    re: /\bdifferences?\s+between\s+(.+?)\s+and\s+(.+)/i,
  },
  {
    name: 'X-compared-to-Y',
    re: /(.+?)\s+compared\s+(?:to|with|against)\s+(.+)/i,
  },
  {
    name: 'X-vs-Y',
    re: /^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i,
  },
  {
    name: 'X-against-Y',
    re: /(.+?)\s+against\s+(.+)/i,
  },
]

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'i',
  'want', 'need', 'would', 'like', 'please', 'usual', 'just', 'really',
  'implementation', 'implementations', 'code', 'codebase',
])

function deriveLabel(subject: string): string {
  const toks = tokenize(subject).filter(t => !STOPWORDS.has(t))
  const picked = toks.slice(0, 4)
  if (picked.length === 0) return subject.trim().slice(0, 40)
  return picked.join(' ')
}

export function splitCompositionalPrompt(promptText: string): CompositionalSplit {
  const trimmed = promptText.trim()
  if (!trimmed) return { kind: 'single', promptText }

  for (const { re } of PATTERNS) {
    const m = trimmed.match(re)
    if (!m) continue
    const a = (m[1] ?? '').trim()
    const b = (m[2] ?? '').trim()
    if (!a || !b) continue
    const aTokens = tokenize(a)
    const bTokens = tokenize(b)
    if (aTokens.length < MIN_SUBJECT_TOKENS || bTokens.length < MIN_SUBJECT_TOKENS) continue
    return {
      kind: 'compositional',
      subjects: [
        { label: deriveLabel(a), promptText: a },
        { label: deriveLabel(b), promptText: b },
      ],
    }
  }

  return { kind: 'single', promptText }
}
