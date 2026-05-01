import { isNoisePath } from '../anchors/anchor-types'
import type { GraphReader } from '../graphs/graph-reader'
import type { GraphNode, GraphEdge, EdgeKind } from '../graphs/schema'
import {
  type PlanChecker,
  type PlanValidationContext,
  type CheckerResult,
  type PlanIssue,
  type PlanIssueSeverity,
  makeIssueKey,
  capEvidence,
  normalizePath,
} from './plan-validator-types'

// ---------------------------------------------------------------------------
// Edge allowlist
// ---------------------------------------------------------------------------

export const VALIDATOR_STRUCTURAL_EDGE_KINDS: EdgeKind[] = [
  'route_to_controller',
  'controller_uses_request',
  'controller_dispatches_job',
  'dispatches_job',
  'emits_event',
  'listens_to_event',
  'observes_model',
]

const INHERITANCE_EDGE_KINDS: EdgeKind[] = ['implements', 'extends']

const ALL_QUERIED_EDGE_KINDS: string[] = [
  ...VALIDATOR_STRUCTURAL_EDGE_KINDS,
  ...INHERITANCE_EDGE_KINDS,
]

const INHERITANCE_SET = new Set<string>(INHERITANCE_EDGE_KINDS)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIDENCE_LOW = 0.4
const CONFIDENCE_MEDIUM = 0.6
const EVIDENCE_CAP = 5

// ---------------------------------------------------------------------------
// Internal accumulator
// ---------------------------------------------------------------------------

type GapAccum = {
  /** file path OR node key for non-file neighbors */
  discriminator: string
  isFileBased: boolean
  severity: PlanIssueSeverity
  confidence: number
  evidence: string[]
  relatedSymbols: string[]
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export const structuralGapChecker: PlanChecker = {
  id: 'structural-gap',
  strength: 1,

  async check(ctx: PlanValidationContext): Promise<CheckerResult> {
    const graphReader = ctx.deps.graphReader

    if (graphReader == null) {
      return {
        issues: [],
        suggestedPaths: [],
        suggestedSymbols: [],
        skipped: { reason: 'missing_dep', missing: ['graphReader'] },
      }
    }

    const plannedPathSet = new Set(ctx.parsed.files.map(f => f.normalized))

    // Collect all seed keys to query
    const seedKeys = new Set<string>()

    // From planned files: look up file node and search for class nodes by filePath
    for (const file of ctx.parsed.files) {
      const norm = file.normalized
      if (isNoisePath(norm)) continue

      // Try file:<path> node
      const fileKey = `file:${norm}`
      if (graphReader.getNode(fileKey)) {
        seedKeys.add(fileKey)
      }

      // Search by filePath to find class/interface/etc nodes in that file
      const classNodes = graphReader.search(norm)
      for (const cn of classNodes) {
        if (cn.filePath === norm) {
          seedKeys.add(cn.key)
        }
      }
    }

    // From planned symbols
    for (const sym of ctx.parsed.symbols) {
      const node = graphReader.getNode(sym.symbol)
      if (node) {
        seedKeys.add(node.key)
      }
    }

    // Accumulate gaps per discriminator (filePath or node key)
    const accumByDiscriminator = new Map<string, GapAccum>()

    for (const seedKey of seedKeys) {
      const subgraph = graphReader.getNeighbors(seedKey, {
        edgeKinds: ALL_QUERIED_EDGE_KINDS,
        maxHops: 1,
      })

      for (const edge of subgraph.edges) {
        const neighborKey = edge.from === seedKey ? edge.to : edge.from
        const neighborNode = subgraph.nodes.find(n => n.key === neighborKey)

        const neighborFilePath = neighborNode?.filePath
          ? normalizePath(neighborNode.filePath)
          : undefined

        // Skip noise file paths
        if (neighborFilePath && isNoisePath(neighborFilePath)) continue

        // Skip if already in plan
        if (neighborFilePath && plannedPathSet.has(neighborFilePath)) continue

        // Determine discriminator
        const isFileBased = !!neighborFilePath
        const discriminator = isFileBased ? neighborFilePath! : neighborKey

        // Determine severity based on edge kind
        const isInheritance = INHERITANCE_SET.has(edge.kind)
        const severity: PlanIssueSeverity = isInheritance ? 'info' : 'warning'
        const confidence = isInheritance ? CONFIDENCE_LOW : CONFIDENCE_MEDIUM

        // Build evidence string
        const fileHint = neighborFilePath ? ` (file: ${neighborFilePath})` : ''
        const ev = `structural_gap: ${seedKey} --[${edge.kind}]--> ${neighborKey}${fileHint}`

        let accum = accumByDiscriminator.get(discriminator)
        if (!accum) {
          accum = {
            discriminator,
            isFileBased,
            severity,
            confidence,
            evidence: [],
            relatedSymbols: [],
          }
          accumByDiscriminator.set(discriminator, accum)
        }

        accum.evidence.push(ev)

        // Escalate: warning > info
        if (severity === 'warning' && accum.severity === 'info') {
          accum.severity = 'warning'
          accum.confidence = CONFIDENCE_MEDIUM
        }

        // Track non-file neighbor keys as relatedSymbols
        if (!isFileBased && !accum.relatedSymbols.includes(neighborKey)) {
          accum.relatedSymbols.push(neighborKey)
        }
      }
    }

    // Build issues
    const issues: PlanIssue[] = []
    const suggestedPaths: string[] = []
    const suggestedSymbols: string[] = []

    for (const accum of accumByDiscriminator.values()) {
      const { discriminator, isFileBased, severity, confidence, evidence, relatedSymbols } = accum

      // Sort evidence alphabetically, cap at 5
      evidence.sort()

      const issueKeyDiscriminator = isFileBased
        ? discriminator
        : `node:${discriminator}`

      const message = isFileBased
        ? `Graph neighbor ${discriminator} is not in the plan. Consider whether it should be included.`
        : `Graph neighbor ${discriminator} (no file path) is connected to planned code. Consider whether related files should be included.`

      const issue: PlanIssue = {
        issueKey: makeIssueKey('structural_gap', 'structural-gap', issueKeyDiscriminator),
        severity,
        confidence,
        kind: 'structural_gap',
        message,
        evidence: capEvidence(evidence, EVIDENCE_CAP),
        checkerId: 'structural-gap',
      }

      if (relatedSymbols.length > 0) {
        issue.relatedSymbols = relatedSymbols
      }

      if (isFileBased) {
        issue.relatedPaths = [discriminator]
        suggestedPaths.push(discriminator)
      } else {
        suggestedSymbols.push(...relatedSymbols)
      }

      issues.push(issue)
    }

    return {
      issues,
      suggestedPaths,
      suggestedSymbols,
    }
  },
}
