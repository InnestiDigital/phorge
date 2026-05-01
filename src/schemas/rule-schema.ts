import { z } from 'zod'

export const RuleState = z.enum([
  'candidate',
  'approved',
  'experimental',
  'deprecated',
])
export type RuleState = z.infer<typeof RuleState>

export const RuleSource = z.enum([
  'human',
  'review_mined',
  'commit_mined',
  'adr_mined',
  'memory_promoted',
])
export type RuleSource = z.infer<typeof RuleSource>

export const RuleAppliesTo = z.enum([
  'planner',
  'validator',
  'implementer',
  'reviewer',
])
export type RuleAppliesTo = z.infer<typeof RuleAppliesTo>

export const RuleConfidence = z.enum(['low', 'medium', 'high'])
export type RuleConfidence = z.infer<typeof RuleConfidence>

export const RuleSeverity = z.enum(['info', 'warning', 'critical'])
export type RuleSeverity = z.infer<typeof RuleSeverity>

export const RuleScope = z.object({
  repos: z.array(z.string().min(1)).optional(),
  globs: z.array(z.string().min(1)).optional(),
  workflows: z.array(z.string().min(1)).optional(),
  domains: z.array(z.string().min(1)).optional(),
})
export type RuleScope = z.infer<typeof RuleScope>

export const RuleExamples = z.object({
  good: z.array(z.string().min(1)).optional(),
  bad: z.array(z.string().min(1)).optional(),
})
export type RuleExamples = z.infer<typeof RuleExamples>

export const RuleRecord = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    state: RuleState,
    source: RuleSource,
    appliesTo: z.array(RuleAppliesTo).min(1),
    scope: RuleScope,
    confidence: RuleConfidence,
    severity: RuleSeverity.optional(),
    reviewDueAt: z.string().datetime().optional(),
    version: z.number().int().positive(),
    rationale: z.string().min(1),
    guidance: z.string().min(1),
    examples: RuleExamples.optional(),
    verification: z.array(z.string().min(1)).optional(),
    evidenceRefs: z.array(z.string().min(1)).optional(),
    supersedes: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .refine((r) => r.state !== 'experimental' || !!r.reviewDueAt, {
    message: 'experimental rules require reviewDueAt',
    path: ['reviewDueAt'],
  })
export type RuleRecord = z.infer<typeof RuleRecord>
