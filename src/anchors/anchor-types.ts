import { z } from 'zod'
import { EdgeKind } from '../graphs/schema'

export const AnchorKind = z.enum(['path', 'symbol'])
export type AnchorKind = z.infer<typeof AnchorKind>

export const AnchorSource = z.enum(['explicit', 'corpus_match', 'lexical', 'cochange_expand', 'graph_expand', 'project_config'])
export type AnchorSource = z.infer<typeof AnchorSource>

export const AnchorConfidence = z.enum(['high', 'medium', 'low'])
export type AnchorConfidence = z.infer<typeof AnchorConfidence>

export const AnchorMetadataSchema = z.object({
  retrievalScore: z.number().optional(),
  pathBonus: z.number().optional(),
  supportCount: z.number().int().nonnegative().optional(),
  coupling: z.number().min(0).max(1).optional(),
  parent: z.string().optional(),
  edgeKind: z.string().optional(),
}).strict()
export type AnchorMetadata = z.infer<typeof AnchorMetadataSchema>

export const TargetAnchorSchema = z.object({
  kind: AnchorKind,
  value: z.string().min(1),
  source: AnchorSource,
  confidence: AnchorConfidence,
  evidence: z.array(z.string()).min(1),
  metadata: AnchorMetadataSchema.optional(),
})
export type TargetAnchor = z.infer<typeof TargetAnchorSchema>

export type ExplicitExtractionResult = {
  anchors: TargetAnchor[]
  unresolvedMentions: string[]
}

export type CorpusRetrievalResult = {
  anchors: TargetAnchor[]
  matchedCommitShas: string[]
  queryTokens: string[]
  stats: {
    docsSeen: number
    docsMatched: number
    pathsConsidered: number
    droppedBelowThreshold: number
  }
}

export type LexicalRetrievalResult = {
  anchors: TargetAnchor[]
  queryTokens: string[]
  expandedTokens: string[]
  stats: {
    filesScanned: number
    pathsMatched: number
  }
}

export type ExpansionResult = {
  anchors: TargetAnchor[]
  expandedFrom: Record<string, string[]>
  stats: {
    coChangeAdded: number
    graphAdded: number
    skippedExisting: number
    skippedUnresolved: number
  }
}

export type RankedAnchorResult = {
  anchors: TargetAnchor[]
  targetPaths: string[]
  targetSymbols: string[]
  stats: {
    totalAnchors: number
    totalAnchorsPostCap: number
    bySource: Record<AnchorSource, number>
    byConfidence: Record<AnchorConfidence, number>
    droppedLow: number
    droppedDuplicates: number
    droppedNoisePaths: number
    keptPaths: number
    keptSymbols: number
    cappedPaths: number
    cappedSymbols: number
  }
}

export type SingleSubjectResult = {
  version: 'v2'
  anchors: TargetAnchor[]
  targetPaths: string[]
  targetSymbols: string[]
  stages: {
    explicit: ExplicitExtractionResult
    corpus: CorpusRetrievalResult | null
    lexical: LexicalRetrievalResult | null
    expansion: ExpansionResult | null
    ranked: RankedAnchorResult
  }
}

export type TargetSourcingV2Result = SingleSubjectResult & {
  /**
   * When the prompt is compositional (e.g. "X vs Y"), one entry per subject
   * with anchors resolved independently. `null` for single-subject prompts.
   */
  subjects: ReadonlyArray<{ label: string; result: SingleSubjectResult }> | null
}

export const CONFIDENCE_ORDER: Record<AnchorConfidence, number> = {
  high: 2,
  medium: 1,
  low: 0,
}

export const SOURCE_PRIORITY: Record<AnchorSource, number> = {
  project_config: 5,
  explicit: 4,
  corpus_match: 3,
  lexical: 2,
  cochange_expand: 1,
  graph_expand: 0,
}

export const MIN_CONSUMER_CONFIDENCE: AnchorConfidence = 'medium'

export const MAX_TOTAL_ANCHORS = 40

export const NOISE_PATH_PATTERNS: RegExp[] = [
  /\/factories\//i,
  /\/seeders?\//i,
  /\/fixtures?\//i,
  /\/stubs?\//i,
  /^stubs?\//i,
  /^database\/migrations\//,
  /\.generated\./,
  /^config\/(app|auth|cache|database|filesystems|logging|mail|queue|services|session)\.php$/,
  /composer\.(json|lock)$/,
  /package(-lock)?\.json$/,
  /^CHANGELOG\.md$/i,
  /^README\.md$/i,
  /^\.env/,
  /^\.gitignore$/,
]

export function isNoisePath(path: string): boolean {
  return NOISE_PATH_PATTERNS.some(re => re.test(path))
}

export function canonicalKey(kind: AnchorKind, value: string): string {
  return `${kind}:${value}`
}

export function edgeKindsToStrings(kinds: readonly z.infer<typeof EdgeKind>[]): string[] {
  return [...kinds]
}

export const GRAPH_EXPAND_EDGE_KINDS: readonly z.infer<typeof EdgeKind>[] = [
  'route_to_controller',
  'controller_uses_request',
  'controller_dispatches_job',
  'dispatches_job',
  'emits_event',
  'listens_to_event',
  'observes_model',
  'implements',
  'extends',
]
