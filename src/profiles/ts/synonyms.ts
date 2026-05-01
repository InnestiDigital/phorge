// Domain synonym groups for TypeScript / Vue / Nuxt codebases.
// Same shape as the Laravel groups: bidirectional, stems pre-applied via
// SYNONYM_INDEX so they line up with `tokenizePrompt` output.

import { stem } from '../../anchors/prompt-tokenizer'

export const TS_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['auth', 'login', 'signin', 'signup', 'session', 'authenticate', 'credential', 'token', 'jwt'],
  ['payment', 'wallet', 'balance', 'charge', 'transaction'],
  ['store', 'state', 'pinia', 'vuex', 'redux'],
  ['route', 'page', 'middleware', 'handler'],
  ['composable', 'hook'],
  ['component', 'widget', 'element'],
  ['api', 'endpoint', 'request', 'response'],
  ['sync', 'import', 'ingest', 'fetch', 'poll'],
  ['user', 'account', 'profile', 'identity'],
  ['email', 'notification', 'message', 'alert'],
  ['upload', 'file', 'asset', 'media'],
  ['search', 'query', 'filter', 'index'],
  ['admin', 'dashboard', 'console'],
  ['mobile', 'capacitor', 'native'],
  ['test', 'spec', 'fixture', 'mock'],
]

const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const idx = new Map<string, Set<string>>()
  for (const group of TS_SYNONYM_GROUPS) {
    const stemmed: string[] = group.map((g) => stem(g as string))
    const set = new Set<string>(stemmed)
    for (const t of stemmed) {
      const existing = idx.get(t)
      if (existing) for (const s of set) existing.add(s)
      else idx.set(t, new Set(set))
    }
  }
  return idx
})()

export function expandSynonyms(tokens: string[]): string[] {
  const out = new Set<string>(tokens)
  for (const t of tokens) {
    const syns = SYNONYM_INDEX.get(t)
    if (syns) for (const s of syns) out.add(s)
  }
  return [...out]
}

export function synonymsOf(token: string): string[] {
  const set = SYNONYM_INDEX.get(token)
  if (!set) return []
  return [...set].filter(s => s !== token)
}
