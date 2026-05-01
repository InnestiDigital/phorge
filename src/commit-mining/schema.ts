// pipeline/knowledge/commit-mining/schema.ts
//
// K1.3 commit corpus schemas. Per spec §5.1 in
// coding-brain/19-k1-3-commit-corpus-volatility-map-spec.md.
//
// v1 fields landing in K1.3.1 (this module):
//   sha, parentSha, authorNickname, authorIsBot, committedAt,
//   subject, bodyDigest (sha256), filesTouched, additions,
//   deletions, ticketId?, conventionalScope?, intentCategory.
//
// Deferred to K1.3.1b (git log parser) and later phases:
//   diffHash (sha256 of concatenated hunks — requires git show
//   per commit), laravelVersion / phpVersion (composer.json read
//   at each commit), mergedIntoPrNumber (derives from merge
//   commits that this corpus intentionally excludes via
//   --first-parent).

import { z } from 'zod'

export const CommitIntentCategory = z.enum([
  'feat',
  'fix',
  'refactor',
  'chore',
  'test',
  'docs',
  'style',
  'perf',
  'build',
  'ci',
  'revert',
  'other',
])
export type CommitIntentCategoryCode = z.infer<typeof CommitIntentCategory>

export const PerFileDelta = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
})
export type PerFileDelta = z.infer<typeof PerFileDelta>

export const CommitCorpusEntry = z.object({
  sha: z.string().min(7),
  parentSha: z.string().min(7).nullable(),
  authorNickname: z.string().min(1),
  authorEmail: z.string().min(1),
  authorIsBot: z.boolean(),
  committedAt: z.string().datetime(),
  subject: z.string().min(1),
  bodyDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'sha256 hex digest expected'),
  filesTouched: z.array(z.string().min(1)),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  perFileDelta: z.array(PerFileDelta).optional(),
  ticketId: z.string().min(1).optional(),
  conventionalScope: z.string().min(1).optional(),
  intentCategory: CommitIntentCategory,
})
export type CommitCorpusEntry = z.infer<typeof CommitCorpusEntry>

export const FilterExclusionReason = z.enum([
  'merge_commit',
  'bot_author',
  'noise_message',
  'mega_file_count',
  'mega_line_count',
  'docs_only',
  'dependency_churn',
])
export type FilterExclusionReasonCode = z.infer<typeof FilterExclusionReason>

export const FilterConfig = z.object({
  megaFileThreshold: z.number().int().positive(),
  megaLineThreshold: z.number().int().positive(),
  excludeDocsOnly: z.boolean(),
  excludeDependencyChurn: z.boolean(),
  botNicknames: z.array(z.string().min(1)),
  extraBotEmailSuffixes: z.array(z.string().min(1)),
})
export type FilterConfig = z.infer<typeof FilterConfig>

export const VolatilityWeights = z.object({
  churn: z.number().min(0).max(1),
  bugDensity: z.number().min(0).max(1),
  ownershipFragmentation: z.number().min(0).max(1),
  recency: z.number().min(0).max(1),
})
export type VolatilityWeights = z.infer<typeof VolatilityWeights>

export const VolatilityRiskBreakdown = z.object({
  churnComponent: z.number().min(0).max(1),
  bugDensityComponent: z.number().min(0).max(1),
  ownershipFragmentationComponent: z.number().min(0).max(1),
  recencyComponent: z.number().min(0).max(1),
  // Optional small-N dampener applied to the weighted sum (1.0 = no dampening).
  smallSampleDampener: z.number().min(0).max(1).optional(),
  // Optional raw weighted-sum risk before percentile normalization.
  rawRiskScore: z.number().min(0).max(1).optional(),
})
export type VolatilityRiskBreakdown = z.infer<typeof VolatilityRiskBreakdown>

export const VolatilityAuthor = z.object({
  nickname: z.string().min(1),
  commitCount: z.number().int().positive(),
  lastTouchedAt: z.string().datetime(),
})
export type VolatilityAuthor = z.infer<typeof VolatilityAuthor>

export const VolatilityEntry = z.object({
  path: z.string().min(1),
  commitCount: z.number().int().positive(),
  lineDeltaAdded: z.number().int().nonnegative(),
  lineDeltaDeleted: z.number().int().nonnegative(),
  firstTouchedAt: z.string().datetime(),
  lastTouchedAt: z.string().datetime(),
  bugFixCommitCount: z.number().int().nonnegative(),
  bugFixDensity: z.number().min(0).max(1),
  topAuthors: z.array(VolatilityAuthor),
  laravelVersionSpan: z.array(z.string().min(1)),
  riskScore: z.number().min(0).max(1),
  riskBreakdown: VolatilityRiskBreakdown,
})
export type VolatilityEntry = z.infer<typeof VolatilityEntry>

export const VolatilityMapManifest = z.object({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  window: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  createdAt: z.string().datetime(),
  asOf: z.string().datetime(),
  weights: VolatilityWeights,
  stats: z.object({
    totalEntries: z.number().int().nonnegative(),
    excludedPaths: z.number().int().nonnegative(),
    churnP95: z.number().nonnegative(),
    topRiskPathCount: z.number().int().nonnegative(),
    topRiskThreshold: z.number().min(0).max(1),
  }),
  entries: z.array(VolatilityEntry),
})
export type VolatilityMapManifest = z.infer<typeof VolatilityMapManifest>

export const CoChangeIntentFilter = z.enum(['all', 'fix', 'feat'])
export type CoChangeIntentFilter = z.infer<typeof CoChangeIntentFilter>

export const CoChangeNeighbor = z.object({
  path: z.string().min(1),
  jointCommits: z.number().int().positive(),
  coupling: z.number().min(0).max(1),
})
export type CoChangeNeighbor = z.infer<typeof CoChangeNeighbor>

export const CoChangeEntry = z.object({
  path: z.string().min(1),
  commitCount: z.number().int().positive(),
  neighbors: z.array(CoChangeNeighbor),
})
export type CoChangeEntry = z.infer<typeof CoChangeEntry>

export const CoChangeViewStats = z.object({
  anchors: z.number().int().nonnegative(),
  pairs: z.number().int().nonnegative(),
  commitsConsidered: z.number().int().nonnegative(),
})
export type CoChangeViewStats = z.infer<typeof CoChangeViewStats>

export const CoChangeView = z.object({
  intentFilter: CoChangeIntentFilter,
  entries: z.array(CoChangeEntry),
  stats: CoChangeViewStats,
})
export type CoChangeView = z.infer<typeof CoChangeView>

export const CoChangeMatrixManifest = z.object({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  window: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  createdAt: z.string().datetime(),
  config: z.object({
    minCoupling: z.number().min(0).max(1),
    minJointCommits: z.number().int().positive(),
    topK: z.number().int().positive(),
    excludedPaths: z.number().int().nonnegative(),
  }),
  all: CoChangeView,
  fix: CoChangeView,
  feat: CoChangeView,
})
export type CoChangeMatrixManifest = z.infer<typeof CoChangeMatrixManifest>

export const RevertResolutionCode = z.enum([
  'sha_mention',
  'exact_subject',
  'digest_match',
  'unresolved',
])
export type RevertResolutionCode = z.infer<typeof RevertResolutionCode>

export const RevertLink = z.object({
  revertSha: z.string().min(7),
  revertedSha: z.string().min(7).nullable(),
  resolution: RevertResolutionCode,
  revertedAt: z.string().datetime(),
  daysToRevert: z.number().nonnegative().nullable(),
})
export type RevertLink = z.infer<typeof RevertLink>

export const RevertChainRole = z.enum(['original', 'revert', 'reapply'])
export type RevertChainRole = z.infer<typeof RevertChainRole>

export const RevertChainCommit = z.object({
  sha: z.string().min(7),
  role: RevertChainRole,
  committedAt: z.string().datetime(),
  subject: z.string().min(1),
})
export type RevertChainCommit = z.infer<typeof RevertChainCommit>

export const RevertChain = z.object({
  chainId: z.string().min(1),
  commits: z.array(RevertChainCommit).min(2),
  filesInvolved: z.array(z.string().min(1)),
  depth: z.number().int().min(2),
  hasReapply: z.boolean(),
})
export type RevertChain = z.infer<typeof RevertChain>

export const RevertPathStat = z.object({
  path: z.string().min(1),
  commitCount: z.number().int().positive(),
  revertCount: z.number().int().positive(),
  revertDensity: z.number().min(0).max(1),
  medianDaysToRevert: z.number().nonnegative().nullable(),
  chainsInvolvingPath: z.number().int().nonnegative(),
  lastRevertedAt: z.string().datetime(),
})
export type RevertPathStat = z.infer<typeof RevertPathStat>

export const RevertChainsManifest = z.object({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  window: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  createdAt: z.string().datetime(),
  stats: z.object({
    totalRevertCommits: z.number().int().nonnegative(),
    resolvedReverts: z.number().int().nonnegative(),
    unresolvedReverts: z.number().int().nonnegative(),
    chains: z.number().int().nonnegative(),
    chainsWithReapply: z.number().int().nonnegative(),
    excludedPaths: z.number().int().nonnegative(),
  }),
  links: z.array(RevertLink),
  chains: z.array(RevertChain),
  pathStats: z.array(RevertPathStat),
})
export type RevertChainsManifest = z.infer<typeof RevertChainsManifest>

export const CommitCorpusManifest = z.object({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  window: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  createdAt: z.string().datetime(),
  filter: FilterConfig,
  stats: z.object({
    totalConsidered: z.number().int().nonnegative(),
    kept: z.number().int().nonnegative(),
    excluded: z.record(z.string(), z.number().int().nonnegative()),
    byIntent: z.record(z.string(), z.number().int().nonnegative()),
  }),
  entries: z.array(CommitCorpusEntry),
})
export type CommitCorpusManifest = z.infer<typeof CommitCorpusManifest>
