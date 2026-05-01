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
import type { VolatilityEntry, RevertPathStat, VolatilityRiskBreakdown } from '../commit-mining/schema'

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const REVERT_DENSITY_CRITICAL = 0.15
const REVERT_COUNT_CRITICAL = 2
const VOLATILITY_WARNING = 0.7
const VOLATILITY_INFO = 0.5

const CONFIDENCE_LOW = 0.4
const CONFIDENCE_MEDIUM = 0.6
const CONFIDENCE_HIGH = 0.85

const EVIDENCE_CAP = 5

/** 18 months in milliseconds */
const FRESHNESS_CUTOFF_MS = 18 * 30 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecentRevert(lastRevertedAt: string): boolean {
  const revertDate = new Date(lastRevertedAt).getTime()
  const cutoff = Date.now() - FRESHNESS_CUTOFF_MS
  return revertDate >= cutoff
}

function topBreakdownComponent(breakdown: VolatilityRiskBreakdown): string {
  const entries: [string, number][] = [
    ['churnComponent', breakdown.churnComponent],
    ['bugDensityComponent', breakdown.bugDensityComponent],
    ['ownershipFragmentationComponent', breakdown.ownershipFragmentationComponent],
    ['recencyComponent', breakdown.recencyComponent],
  ]
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][0]
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export const revertChecker: PlanChecker = {
  id: 'revert',
  strength: 3,

  async check(ctx: PlanValidationContext): Promise<CheckerResult> {
    const rawRevertStats = ctx.deps.revertStats
    const rawVolatility = ctx.deps.volatilityEntries

    // Both null -> skip
    if (rawRevertStats == null && rawVolatility == null) {
      return {
        issues: [],
        suggestedPaths: [],
        suggestedSymbols: [],
        skipped: { reason: 'missing_dep', missing: ['volatilityByPath', 'revertByPath'] },
      }
    }

    // Build lookup maps from available data
    const revertByPath = new Map<string, RevertPathStat>()
    if (rawRevertStats != null) {
      for (const r of rawRevertStats) {
        revertByPath.set(normalizePath(r.path), r)
      }
    }

    const volatilityByPath = new Map<string, VolatilityEntry>()
    if (rawVolatility != null) {
      for (const v of rawVolatility) {
        volatilityByPath.set(normalizePath(v.path), v)
      }
    }

    const issues: PlanIssue[] = []

    for (const file of ctx.parsed.files) {
      const norm = file.normalized
      const revert = revertByPath.get(norm)
      const vol = volatilityByPath.get(norm)

      // Nothing to check for this path
      if (!revert && !vol) continue

      // Accumulate evidence
      const evidence: string[] = []

      // Determine severity candidates
      let severity: PlanIssueSeverity = 'info'
      let confidence = CONFIDENCE_LOW

      // --- Revert signal ---
      if (revert) {
        const recent = isRecentRevert(revert.lastRevertedAt)
        const ancientTag = recent ? '' : ' (ancient, evidence only)'

        evidence.push(
          `revert: density=${revert.revertDensity.toFixed(2)}, count=${revert.revertCount}, last=${revert.lastRevertedAt}${ancientTag}`,
        )

        // Critical escalation: density >= 0.15 AND count >= 2 AND recent
        if (
          recent &&
          revert.revertDensity >= REVERT_DENSITY_CRITICAL &&
          revert.revertCount >= REVERT_COUNT_CRITICAL
        ) {
          severity = 'critical'
          confidence = CONFIDENCE_HIGH
        }
      }

      // --- Volatility signal ---
      if (vol) {
        const topComp = topBreakdownComponent(vol.riskBreakdown)
        evidence.push(
          `volatility: riskScore=${vol.riskScore.toFixed(2)}, top=${topComp} (${(vol.riskBreakdown[topComp as keyof VolatilityRiskBreakdown] ?? 0).toFixed(2)})`,
        )

        // Only escalate from volatility if not already critical
        if (SEVERITY_ORDER[severity] < SEVERITY_ORDER['critical']) {
          if (vol.riskScore >= VOLATILITY_WARNING) {
            if (SEVERITY_ORDER['warning'] > SEVERITY_ORDER[severity]) {
              severity = 'warning'
              confidence = CONFIDENCE_MEDIUM
            }
          } else if (vol.riskScore >= VOLATILITY_INFO) {
            if (SEVERITY_ORDER['info'] > SEVERITY_ORDER[severity]) {
              severity = 'info'
              confidence = CONFIDENCE_LOW
            }
          }
        }
      }

      // If we have revert data but it's ancient and no volatility signal meets threshold,
      // still emit info for the revert evidence
      if (revert && !vol) {
        // Already at info from initialization, evidence is present
      }

      // Skip if no signal reaches any threshold and no revert data
      if (evidence.length === 0) continue

      // If only ancient revert data and volatility below info threshold, still emit info
      // (the initial severity = 'info' handles this)

      issues.push({
        issueKey: makeIssueKey('revert_risk', 'revert', norm),
        severity,
        confidence,
        kind: 'revert_risk',
        message: `Planned file ${norm} is in a historically unstable area. Consider additional safeguards or tests.`,
        evidence: capEvidence(evidence, EVIDENCE_CAP),
        checkerId: 'revert',
        relatedPaths: [norm],
      })
    }

    return {
      issues,
      suggestedPaths: [],
      suggestedSymbols: [],
    }
  },
}
