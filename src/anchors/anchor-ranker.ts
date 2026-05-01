// pipeline/knowledge/consumers/anchor-ranker.ts
import {
  type TargetAnchor,
  type AnchorConfidence,
  type AnchorSource,
  type RankedAnchorResult,
  CONFIDENCE_ORDER,
  SOURCE_PRIORITY,
  MIN_CONSUMER_CONFIDENCE,
  MAX_TOTAL_ANCHORS,
  isNoisePath,
  canonicalKey,
} from './anchor-types'
import type { GraphReader } from '../graphs/graph-reader'
import type { PhorgeProjectConfig } from '../profiles/contracts'
import { fileKey } from '../graphs/node-keys'

// The role-keyword map lives here (not under profiles/) because boosting is a
// ranking concern, not a profile-extraction concern: every profile's tags pass
// through the same anchor-ranker. Keeping the map central avoids per-profile
// drift and lets future profiles emit role tags from this same vocabulary.
const ROLE_PROMPT_HINTS: Record<string, readonly string[]> = {
  'member-endpoint': ['member', 'endpoint', 'api', 'route'],
  'admin-tool': ['admin', 'dashboard', 'console'],
  'application-api': ['application', 'mobile-app', 'app'],
  'customer-admin': ['customer'],
  'auth-flow': ['auth', 'login', 'session', 'token'],
  'route': ['endpoint', 'api', 'route', 'page'],
  'component': ['component', 'widget', 'ui'],
  'composable': ['composable', 'hook'],
  'store': ['store', 'state'],
  'api-endpoint': ['endpoint', 'api', 'handler'],
}

const ROLE_BOOST_HIT = 1.4
const ROLE_BOOST_MISS = 0.85
const EDGE_BOOST_MIN = 0.7
const EDGE_BOOST_MAX = 1.5

// Endpoint-y prompt detection lives in anchor-ranker (not a profile concern):
// the route-edge boost reorders WITHIN a confidence tier, identical to the
// role-tag boost above. Centralizing the keyword list keeps both passes in sync.
const ENDPOINT_PROMPT_KEYWORDS = [
  'endpoint', 'endpoints', 'route', 'routes', 'api',
  'controller', 'request', 'http', 'page', 'pages', 'handler',
] as const

const ROUTE_EDGE_KINDS = new Set<string>([
  'route_to_controller',
  'route_to_component',
  'route_to_handler',
])

const ROUTE_BOOST_HIT = 1.5
const ROUTE_BOOST_MISS = 0.85

export type AnchorRankerOpts = {
  minConfidence?: AnchorConfidence
  maxPaths?: number
  maxSymbols?: number
  /** Optional graph reader for role-tag and edge-weight boosts. No-op if absent. */
  graphReader?: GraphReader | null
  /** Project config for edgeWeights[] rules. */
  projectConfig?: PhorgeProjectConfig
  /** Original prompt text — drives keyword matching for boosts. */
  promptText?: string
}

function tokenizePrompt(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean))
}

function clampMultiplier(m: number): number {
  if (m < EDGE_BOOST_MIN) return EDGE_BOOST_MIN
  if (m > EDGE_BOOST_MAX) return EDGE_BOOST_MAX
  return m
}

// Compute a multiplicative boost for an anchor based on graph node roles and
// project edgeWeights. Returns 1 when no signals apply.
function computeBoost(
  anchor: TargetAnchor,
  promptTokens: Set<string>,
  graphReader: GraphReader | null,
  edgeRules: NonNullable<PhorgeProjectConfig['edgeWeights']>,
): number {
  if (anchor.kind !== 'path' || !graphReader) return 1
  const node = graphReader.getNode(fileKey(anchor.value))
  if (!node) return 1

  let boost = 1

  if (node.roles && node.roles.length > 0) {
    let any = false
    let hit = false
    for (const role of node.roles) {
      const hints = ROLE_PROMPT_HINTS[role]
      if (!hints) continue
      any = true
      for (const h of hints) {
        if (promptTokens.has(h)) { hit = true; break }
      }
      if (hit) break
    }
    if (any) boost *= hit ? ROLE_BOOST_HIT : ROLE_BOOST_MISS
  }

  // Edge-weight rules: an outgoing edge of matching kind, with prompt
  // mentioning any trigger token, yields the configured multiplier.
  if (edgeRules.length > 0) {
    const sub = graphReader.getNeighbors(fileKey(anchor.value), { maxHops: 1, maxNodes: 50, maxEdges: 100 })
    const outgoingKinds = new Set(sub.edges.filter(e => e.from === fileKey(anchor.value)).map(e => e.kind))
    for (const rule of edgeRules) {
      if (!outgoingKinds.has(rule.edgeKind as never)) continue
      const promptHit = rule.whenPromptContains.some(t => promptTokens.has(t.toLowerCase()))
      if (!promptHit) continue
      boost *= clampMultiplier(rule.multiplier)
    }
  }

  return clampMultiplier(boost)
}

function isEndpointyPrompt(promptTokens: Set<string>): boolean {
  for (const k of ENDPOINT_PROMPT_KEYWORDS) {
    if (promptTokens.has(k)) return true
  }
  return false
}

function computeRouteBoost(
  anchor: TargetAnchor,
  graphReader: GraphReader,
): number {
  if (anchor.kind !== 'path') return 1
  const key = fileKey(anchor.value)
  if (!graphReader.getNode(key)) return 1
  const sub = graphReader.getNeighbors(key, { maxHops: 1, maxNodes: 50, maxEdges: 100 })
  for (const e of sub.edges) {
    if (e.to === key && ROUTE_EDGE_KINDS.has(e.kind)) return ROUTE_BOOST_HIT
  }
  return ROUTE_BOOST_MISS
}

export function rankAnchors(
  anchors: TargetAnchor[],
  opts?: AnchorRankerOpts,
): RankedAnchorResult {
  const minConf = opts?.minConfidence ?? MIN_CONSUMER_CONFIDENCE
  const maxPaths = opts?.maxPaths ?? 10
  const maxSymbols = opts?.maxSymbols ?? 5

  let droppedDuplicates = 0
  let droppedNoisePaths = 0

  // Dedup by canonical key
  const dedupMap = new Map<string, { anchor: TargetAnchor; allEvidence: string[] }>()
  for (const a of anchors) {
    const key = canonicalKey(a.kind, a.value)
    const existing = dedupMap.get(key)
    if (!existing) {
      dedupMap.set(key, { anchor: { ...a }, allEvidence: [...a.evidence] })
      continue
    }
    droppedDuplicates++
    existing.allEvidence.push(...a.evidence)
    const existConf = CONFIDENCE_ORDER[existing.anchor.confidence]
    const newConf = CONFIDENCE_ORDER[a.confidence]
    if (newConf > existConf || (newConf === existConf && SOURCE_PRIORITY[a.source] > SOURCE_PRIORITY[existing.anchor.source])) {
      existing.anchor = { ...a, evidence: existing.allEvidence }
    }
  }

  // Merge evidence and dedup
  let deduped: TargetAnchor[] = []
  for (const { anchor, allEvidence } of dedupMap.values()) {
    const uniqueEvidence = [...new Set(allEvidence)].sort()
    deduped.push({ ...anchor, evidence: uniqueEvidence })
  }

  // Noise path filtering
  deduped = deduped.filter(a => {
    if (a.kind === 'path' && isNoisePath(a.value)) {
      droppedNoisePaths++
      return false
    }
    return true
  })

  // Compute role/edge boosts once. Multiplicative on a synthetic score (default
  // 1) used as a tiebreaker AFTER confidence + source priority — boost never
  // promotes a low-confidence anchor over a medium one, just reorders within
  // a tier so role-matched files surface first.
  const promptTokens = opts?.promptText ? tokenizePrompt(opts.promptText) : new Set<string>()
  const edgeRules = opts?.projectConfig?.edgeWeights ?? []
  const reader = opts?.graphReader ?? null
  const boostByKey = new Map<string, number>()
  const endpointy = promptTokens.size > 0 && isEndpointyPrompt(promptTokens)
  if (promptTokens.size > 0 && (reader || edgeRules.length > 0)) {
    for (const a of deduped) {
      let b = computeBoost(a, promptTokens, reader, edgeRules)
      if (endpointy && reader && a.kind === 'path') {
        b *= computeRouteBoost(a, reader)
      }
      if (b !== 1) boostByKey.set(canonicalKey(a.kind, a.value), b)
    }
  }

  // Sort: confidence desc, source priority desc, boost desc, supportCount desc, value asc
  deduped.sort((a, b) => {
    const confDiff = CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence]
    if (confDiff !== 0) return confDiff
    const srcDiff = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]
    if (srcDiff !== 0) return srcDiff
    const boostA = boostByKey.get(canonicalKey(a.kind, a.value)) ?? 1
    const boostB = boostByKey.get(canonicalKey(b.kind, b.value)) ?? 1
    if (boostA !== boostB) return boostB - boostA
    const supportDiff = (b.metadata?.supportCount ?? 0) - (a.metadata?.supportCount ?? 0)
    if (supportDiff !== 0) return supportDiff
    return a.value.localeCompare(b.value)
  })

  const totalAnchorsPreCap = deduped.length

  // Stats computed on full deduped set (pre-cap)
  const minConfOrder = CONFIDENCE_ORDER[minConf]
  const bySource: Record<AnchorSource, number> = { explicit: 0, corpus_match: 0, lexical: 0, cochange_expand: 0, graph_expand: 0, project_config: 0 }
  const byConfidence: Record<AnchorConfidence, number> = { high: 0, medium: 0, low: 0 }
  let droppedLow = 0

  for (const a of deduped) {
    bySource[a.source]++
    byConfidence[a.confidence]++
    if (CONFIDENCE_ORDER[a.confidence] < minConfOrder) droppedLow++
  }

  // Derive eligible high/medium subset FIRST, then cap
  // This prevents low-confidence anchors from crowding out medium ones
  const eligible = deduped.filter(a => CONFIDENCE_ORDER[a.confidence] >= minConfOrder)
  const allPaths = eligible.filter(a => a.kind === 'path').map(a => a.value)
  const allSymbols = eligible.filter(a => a.kind === 'symbol').map(a => a.value)

  // Anti-explosion cap on consumer-facing arrays (not on anchors[] for eval)
  const capped = deduped.slice(0, MAX_TOTAL_ANCHORS)
  const totalAnchorsPostCap = capped.length
  const cappedPaths = Math.max(0, allPaths.length - maxPaths)
  const cappedSymbols = Math.max(0, allSymbols.length - maxSymbols)

  return {
    anchors: capped,
    targetPaths: allPaths.slice(0, maxPaths),
    targetSymbols: allSymbols.slice(0, maxSymbols),
    stats: {
      totalAnchors: totalAnchorsPreCap,
      totalAnchorsPostCap,
      bySource,
      byConfidence,
      droppedLow,
      droppedDuplicates,
      droppedNoisePaths,
      keptPaths: Math.min(allPaths.length, maxPaths),
      keptSymbols: Math.min(allSymbols.length, maxSymbols),
      cappedPaths,
      cappedSymbols,
    },
  }
}
