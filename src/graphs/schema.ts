import { z } from 'zod'

export const NodeKind = z.enum([
  'file',
  'class',
  'interface',
  'trait',
  'method',
  'function',
  'route',
  'event',
  'listener',
  'job',
  'observer',
  'policy',
  'model',
  'service_binding',
  'command',
  'resource',
  'transformer',
  // TS / Vue / Nuxt
  'component',
  'composable',
  'store',
])
export type NodeKind = z.infer<typeof NodeKind>

export const EdgeKind = z.enum([
  // Core
  'defines',
  'contains_method',
  'extends',
  'implements',
  'uses_trait',
  'calls',
  'imports',
  'throws',
  // Laravel
  'route_to_controller',
  'controller_uses_request',
  'controller_returns_resource',
  'controller_returns_transformer',
  'controller_dispatches_job',
  'dispatches_job',
  'emits_event',
  'listens_to_event',
  'observes_model',
  'authorizes_policy',
  'binds_service',
  'binds_concrete',
  'resource_transforms_model',
  'transformer_transforms_model',
  // TS / Vue / Nuxt
  'vue_renders',
  'route_to_component',
  'component_uses_component',
  'component_uses_composable',
])
export type EdgeKind = z.infer<typeof EdgeKind>

export const Confidence = z.enum(['exact', 'inferred'])
export type Confidence = z.infer<typeof Confidence>

export const EdgeSource = z.enum(['parser', 'laravel_scanner', 'ts_scanner'])
export type EdgeSource = z.infer<typeof EdgeSource>

export const GraphNode = z.object({
  key: z.string().min(1),
  kind: NodeKind,
  name: z.string().min(1),
  filePath: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  fqcn: z.string().min(1).optional(),
  visibility: z.enum(['public', 'protected', 'private']).optional(),
  isAbstract: z.boolean().optional(),
  isStatic: z.boolean().optional(),
  laravelRole: z.string().min(1).optional(),
  // Free-form, lower-case-with-hyphens advisory tags (e.g. 'member-endpoint',
  // 'admin-tool', 'composable'). Auto-emitted by scanners from path conventions
  // and additively merged with user pathRoles config. Consumed by anchor-ranker
  // to boost prompts that mention role keywords. Not used for graph topology.
  roles: z.array(z.string().min(1)).readonly().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type GraphNode = z.infer<typeof GraphNode>

export const GraphEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: EdgeKind,
  confidence: Confidence,
  source: EdgeSource,
})
export type GraphEdge = z.infer<typeof GraphEdge>

export const ExtractorMetrics = z.object({
  filesFound: z.number().int().nonnegative(),
  filesParsed: z.number().int().nonnegative(),
  filesErrored: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  parseErrorCount: z.number().int().nonnegative(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  unresolvedTypeRefs: z.number().int().nonnegative(),
  unresolvedCalls: z.number().int().nonnegative(),
  unresolvedImports: z.number().int().nonnegative(),
  byNodeKind: z.record(z.string(), z.number().int().nonnegative()),
  byEdgeKind: z.record(z.string(), z.number().int().nonnegative()),
  parseMs: z.number().nonnegative(),
  extractMs: z.number().nonnegative(),
})
export type ExtractorMetrics = z.infer<typeof ExtractorMetrics>

export const RepoGraphManifest = z.object({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  commitSha: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  stats: z.object({
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    byNodeKind: z.record(z.string(), z.number().int().nonnegative()),
    byEdgeKind: z.record(z.string(), z.number().int().nonnegative()),
    byEdgeSource: z.record(z.string(), z.number().int().nonnegative()),
  }),
  metrics: ExtractorMetrics.optional(),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
})
export type RepoGraphManifest = z.infer<typeof RepoGraphManifest>
