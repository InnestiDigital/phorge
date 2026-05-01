/**
 * Example 04 — Programmatic plan validation
 *
 * What this surfaces:
 *   Build a draft plan in-code (any plain text — bullet list, markdown,
 *   ticket body) and run the deterministic validator against it. The
 *   validator returns issues across six checkers: missing-test,
 *   cochange, revert, rule, structural-gap, complexity.
 *
 * Why this is useful for a coding agent:
 *   This is the pre-merge / pre-implementation gate. The agent produces
 *   a plan; phorge tells it (deterministically, no LLM) whether the
 *   plan misses obvious co-change targets, lacks tests, touches risky
 *   files, or violates project rules. Feed `formatFindingsForRerun`
 *   output back into the agent for a corrected plan.
 *
 * Phorge surface exercised:
 *   validatePlan with full deps (corpus + graph + rules)
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { validatePlan, type PlanValidationDeps, type DraftPlan } from '../src/checkers'
import { createGraphReader, type GraphReader } from '../src/graphs/graph-reader'
import { loadRepoSignals } from '../src/cli/corpus-cache'
import { loadGraph } from '../src/cli/graph-cache'
import type { RepoResolver } from '../src/resolvers'

const repoPath = process.argv[2] ?? process.cwd()

// A synthetic plan — the kind of bulleted markdown an LLM agent would emit
// after reading a ticket. Deliberately incomplete to demonstrate findings.
// Note: replace these paths with real files in your repo for the most
// informative output. The validator only acts on plans referencing
// files that actually exist in the working tree.
const SYNTHETIC_PLAN = `
# Plan: refactor refund flow

Steps:
1. Update app/Services/RefundService.php to support partial refunds.
2. Adjust app/Http/Controllers/RefundController.php accordingly.

Notes: tests and co-change targets not yet considered.
`.trim()

function passthroughResolver(repoRoot: string): RepoResolver {
  return {
    fileExists: (p: string) => {
      const full = resolve(repoRoot, p)
      try { return existsSync(full) && statSync(full).isFile() } catch { return false }
    },
    findFileForClass: () => null,
    findMethodKey: () => null,
  }
}

async function main(): Promise<void> {
  console.log(`# Validating synthetic plan against ${repoPath}`)
  console.log('')

  const signals = await loadRepoSignals({ repoPath })

  let graphReader: GraphReader | null = null
  try {
    const g = loadGraph(repoPath)
    graphReader = createGraphReader(g.nodes, g.edges)
  } catch {
    console.warn('warn: graph not built — structural-gap checker will be skipped')
  }

  const deps: PlanValidationDeps = {
    repoResolver: passthroughResolver(repoPath),
    graphReader,
    cochangeEntries: signals.coChange.all.entries,
    volatilityEntries: signals.volatility.entries,
    revertStats: signals.reverts.pathStats,
    rules: [],
    repoRoot: repoPath,
  }

  const plan: DraftPlan = { rawText: SYNTHETIC_PLAN, sourceLabel: 'synthetic' }
  const result = await validatePlan(plan, deps)

  console.log(`Verdict: ${result.verdict.toUpperCase()}`)
  console.log(`Issues:  ${result.issues.length}`)
  console.log(`Checkers run: ${result.stats.checkersRun} / attempted ${result.stats.checkersAttempted}`)
  console.log('')

  console.log('## Findings')
  if (result.issues.length === 0) {
    console.log('  (none)')
  } else {
    for (const issue of result.issues) {
      console.log(`  [${issue.severity}] ${issue.kind} (${issue.checkerId}): ${issue.message}`)
      for (const ev of issue.evidence.slice(0, 2)) console.log(`      ${ev}`)
    }
  }
}

main().catch(err => {
  console.error('example failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
