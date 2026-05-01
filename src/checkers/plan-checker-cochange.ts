import { isNoisePath } from '../anchors/anchor-types'
import {
  type PlanChecker,
  type PlanValidationContext,
  type CheckerResult,
  type PlanIssue,
  type PlanIssueSeverity,
  SEVERITY_ORDER,
  makeIssueKey,
  capEvidence,
  normalizePath,
} from './plan-validator-types'

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const MIN_COUPLING = 0.5
const MIN_JOINT_COMMITS = 3
const MIN_JOINT_COMMITS_WARNING = 5
const COUPLING_WARNING = 0.65
const COUPLING_CRITICAL = 0.8
const HIGH_VOLATILITY = 0.7
const HIGH_REVERT_DENSITY = 0.1

const CONFIDENCE_LOW = 0.4
const CONFIDENCE_MEDIUM = 0.6
const CONFIDENCE_HIGH = 0.85

const EVIDENCE_CAP = 5

// ---------------------------------------------------------------------------
// Internal types for dedup accumulation
// ---------------------------------------------------------------------------

type MissingNeighborAccum = {
  neighborPath: string
  maxCoupling: number
  maxJointCommits: number
  evidence: string[]
  relatedPaths: string[]
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export const cochangeChecker: PlanChecker = {
  id: 'cochange',
  strength: 4,

  async check(ctx: PlanValidationContext): Promise<CheckerResult> {
    const entries = ctx.deps.cochangeEntries

    // Null guard
    if (entries == null) {
      return {
        issues: [],
        suggestedPaths: [],
        suggestedSymbols: [],
        skipped: { reason: 'missing_dep', missing: ['coChangeByPath'] },
      }
    }

    // Build lookup maps
    const coChangeByPath = new Map<string, (typeof entries)[number]>()
    for (const entry of entries) {
      coChangeByPath.set(normalizePath(entry.path), entry)
    }

    const volatilityByPath = new Map<string, number>()
    for (const v of ctx.deps.volatilityEntries) {
      volatilityByPath.set(normalizePath(v.path), v.riskScore)
    }

    const revertByPath = new Map<string, number>()
    for (const r of ctx.deps.revertStats) {
      revertByPath.set(normalizePath(r.path), r.revertDensity)
    }

    const plannedPaths = ctx.parsed.files
    const plannedPathSet = new Set(plannedPaths.map((f) => f.normalized))

    // Accumulate per missing neighbor
    const accumByNeighbor = new Map<string, MissingNeighborAccum>()

    for (const file of plannedPaths) {
      const norm = file.normalized

      // Skip noise planned files
      if (isNoisePath(norm)) continue

      const entry = coChangeByPath.get(norm)
      if (!entry) continue

      for (const neighbor of entry.neighbors) {
        const neighborNorm = normalizePath(neighbor.path)

        // Filter by thresholds
        if (neighbor.coupling < MIN_COUPLING) continue
        if (neighbor.jointCommits < MIN_JOINT_COMMITS) continue

        // Skip if already in plan
        if (plannedPathSet.has(neighborNorm)) continue

        // Skip noise neighbors
        if (isNoisePath(neighborNorm)) continue

        const ev = `co-change: ${neighborNorm} coupled ${neighbor.coupling.toFixed(2)} with planned ${norm} (${neighbor.jointCommits} joint commits)`

        let accum = accumByNeighbor.get(neighborNorm)
        if (!accum) {
          accum = {
            neighborPath: neighborNorm,
            maxCoupling: neighbor.coupling,
            maxJointCommits: neighbor.jointCommits,
            evidence: [],
            relatedPaths: [],
          }
          accumByNeighbor.set(neighborNorm, accum)
        }

        // Always accumulate evidence
        accum.evidence.push(ev)
        accum.relatedPaths.push(norm)

        if (neighbor.coupling > accum.maxCoupling) {
          accum.maxCoupling = neighbor.coupling
        }
        if (neighbor.jointCommits > accum.maxJointCommits) {
          accum.maxJointCommits = neighbor.jointCommits
        }
      }
    }

    // Build issues from accumulated neighbors
    const issues: PlanIssue[] = []
    const suggestedPaths: string[] = []

    for (const accum of accumByNeighbor.values()) {
      const { neighborPath, maxCoupling, maxJointCommits, evidence, relatedPaths } = accum

      // Determine severity — warning+ requires sufficient support
      let severity: PlanIssueSeverity
      let confidence: number
      const hasSufficientSupport = maxJointCommits >= MIN_JOINT_COMMITS_WARNING

      if (maxCoupling >= COUPLING_CRITICAL && hasSufficientSupport) {
        const vol = volatilityByPath.get(neighborPath) ?? 0
        const rev = revertByPath.get(neighborPath) ?? 0

        if (vol >= HIGH_VOLATILITY || rev >= HIGH_REVERT_DENSITY) {
          severity = 'critical'
          confidence = CONFIDENCE_HIGH
        } else {
          severity = 'warning'
          confidence = CONFIDENCE_MEDIUM
        }
      } else if (maxCoupling >= COUPLING_WARNING && hasSufficientSupport) {
        severity = 'warning'
        confidence = CONFIDENCE_MEDIUM
      } else {
        severity = 'info'
        confidence = CONFIDENCE_LOW
      }

      // Sort evidence alphabetically (stable)
      evidence.sort()

      suggestedPaths.push(neighborPath)

      issues.push({
        issueKey: makeIssueKey('co_change_gap', 'cochange', neighborPath),
        severity,
        confidence,
        kind: 'co_change_gap',
        message: `Historically co-changed file ${neighborPath} is not in the plan. Consider whether it should be included.`,
        evidence: capEvidence(evidence, EVIDENCE_CAP),
        checkerId: 'cochange',
        relatedPaths: [...new Set(relatedPaths)],
      })
    }

    return {
      issues,
      suggestedPaths,
      suggestedSymbols: [],
    }
  },
}
