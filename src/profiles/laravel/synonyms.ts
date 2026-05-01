// Domain synonym groups for Laravel/loyalty codebases.
//
// Why: users describe features in human terms ("the auth thing",
// "billing problem") but file paths use canonical names ("login",
// "charge"). Expanding tokens to a synonym group bridges the gap
// without LLMs/embeddings.
//
// Each group is bidirectional: any token in the group expands to
// the rest of the group. Stems are pre-applied so they line up with
// `tokenizePrompt` output.

import { stem } from '../../anchors/prompt-tokenizer'

export const LARAVEL_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['auth', 'login', 'signin', 'signup', 'session', 'authenticate', 'credential', 'token', 'jwt'],
  // Payment vs billing vs refund split: a "payment" prompt should not pull
  // refund/credit/voucher controllers or invoice/billing surfaces.
  ['payment', 'charge', 'transaction', 'pay', 'checkout'],
  ['refund', 'credit', 'voucher'],
  ['billing', 'invoice'],
  ['sync', 'syncing', 'import', 'ingest', 'fetch', 'pull', 'feed'],
  // Persona split: "member" = end-user (member JWT guard); "customer" =
  // admin-managed entity; "user/account/profile" = generic principal.
  ['member', 'login', 'session', 'authenticate'],
  ['customer', 'admin'],
  ['user', 'account', 'profile', 'identity'],
  ['order', 'purchase', 'cart', 'basket'],
  ['product', 'item', 'sku', 'merchandise', 'catalog', 'catalogue', 'inventory', 'stock'],
  ['email', 'mail', 'notification', 'message', 'notify'],
  ['role', 'permission', 'policy', 'ability', 'access', 'guard'],
  ['point', 'reward', 'loyalty', 'redemption', 'redeem'],
  ['shipping', 'shipment', 'fulfillment', 'delivery', 'tracking'],
  ['admin', 'dashboard', 'backoffice'],
  ['api', 'endpoint', 'controller', 'route'],
  ['report', 'analytics', 'metric', 'stat', 'statistics'],
  ['search', 'query', 'filter', 'find'],
  ['upload', 'file', 'attachment', 'document', 'asset', 'media'],
]

const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const idx = new Map<string, Set<string>>()
  for (const group of LARAVEL_SYNONYM_GROUPS) {
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

/** Returns originals + any synonyms (deduped). Token order not guaranteed. */
export function expandSynonyms(tokens: string[]): string[] {
  const out = new Set<string>(tokens)
  for (const t of tokens) {
    const syns = SYNONYM_INDEX.get(t)
    if (syns) for (const s of syns) out.add(s)
  }
  return [...out]
}

/** Returns the set of tokens that share a synonym group with `token` (excluding itself). */
export function synonymsOf(token: string): string[] {
  const set = SYNONYM_INDEX.get(token)
  if (!set) return []
  return [...set].filter(s => s !== token)
}
