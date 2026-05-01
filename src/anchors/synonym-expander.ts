import { stem } from './prompt-tokenizer'
import type { LexicalProfile } from '../profiles/contracts'

export type SynonymExpander = (tokens: string[]) => string[]

export function buildSynonymExpander(profile: LexicalProfile): SynonymExpander {
  const idx = new Map<string, Set<string>>()
  for (const group of profile.synonymGroups) {
    const stemmed = group.map(stem)
    const set = new Set(stemmed)
    for (const t of stemmed) {
      const existing = idx.get(t)
      if (existing) for (const s of set) existing.add(s)
      else idx.set(t, new Set(set))
    }
  }
  return (tokens) => {
    const out = new Set(tokens)
    for (const t of tokens) {
      const syns = idx.get(t)
      if (syns) for (const s of syns) out.add(s)
    }
    return [...out]
  }
}
