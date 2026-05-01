/**
 * Example 05 — Pre-planning context bundle for prompt injection
 *
 * What this surfaces:
 *   Compose anchors + co-change + complexity + structural neighbourhood
 *   into a single markdown block. This is exactly the kind of static
 *   context you would inject into a Claude / GPT / Cursor agent's
 *   system prompt before asking it to plan changes.
 *
 * Agent dataflow:
 *   ┌──────────────┐    ┌─────────────────┐   ┌─────────────────┐
 *   │ ticket text  │ -> │ phorge (zero    │ -> │ system prompt   │
 *   │ user prompt  │    │   LLM, this     │    │ for LLM agent   │
 *   └──────────────┘    │   bundle here)  │    │  (Claude/GPT)   │
 *                       └─────────────────┘    └─────────────────┘
 *
 *   Phorge runs no LLM. Its output is text, designed to be appended to
 *   the agent's system message before the agent starts reasoning.
 *
 * Why this is useful for a coding agent:
 *   The agent receives deterministic, repo-grounded context (which
 *   files matter, how they couple, what's risky, structural neighbours)
 *   instead of guessing from cold start.
 *
 * Phorge surface exercised:
 *   resolvePromptAnchors, buildFileComplexityProfile, renderSubgraph
 */

import { resolvePromptAnchors } from '../src/anchors'
import { buildFileComplexityProfile, formatComplexityHints, type FileComplexityProfile } from '../src/profiles'
import { createGraphReader, type GraphReader } from '../src/graphs/graph-reader'
import { renderSubgraph } from '../src/graphs/graph-renderer'
import { loadRepoSignals } from '../src/cli/corpus-cache'
import { loadGraph } from '../src/cli/graph-cache'

const repoPath = process.argv[2] ?? process.cwd()
const prompt = process.argv[3] ?? 'fix the refund flow for split-pay orders'

async function main(): Promise<void> {
  const signals = await loadRepoSignals({ repoPath })

  let graphReader: GraphReader | undefined
  try {
    const g = loadGraph(repoPath)
    graphReader = createGraphReader(g.nodes, g.edges)
  } catch { /* degrade — graph optional */ }

  const result = resolvePromptAnchors({
    promptText: prompt,
    deps: {
      corpus: signals.corpus.entries,
      coChangeView: signals.coChange.all,
      allFiles: signals.allFiles,
      ...(graphReader ? { graphReader } : {}),
    },
  })

  const topPaths = result.targetPaths.slice(0, 6)
  const profiles: FileComplexityProfile[] = []
  for (const p of topPaths) {
    const prof = buildFileComplexityProfile(p, {
      repoRoot: repoPath,
      volatilityEntries: signals.volatility.entries,
      revertStats: signals.reverts.pathStats,
    })
    if (prof) profiles.push(prof)
  }

  const ccIndex = new Map(signals.coChange.all.entries.map(e => [e.path, e]))

  // ---- Compose the markdown block ------------------------------------------
  const out: string[] = []
  out.push('# Repo Context (phorge — zero-LLM static signals)')
  out.push('')
  out.push(`**Prompt:** ${prompt}`)
  out.push('')

  out.push('## Suggested files to read first')
  for (const p of topPaths) out.push(`- \`${p}\``)
  out.push('')

  out.push('## Likely co-change targets')
  let any = false
  for (const p of topPaths) {
    const cc = ccIndex.get(p)
    if (!cc || cc.neighbors.length === 0) continue
    for (const n of cc.neighbors.slice(0, 3)) {
      const pct = (n.coupling * 100).toFixed(0)
      out.push(`- \`${p}\` -> \`${n.path}\` (${pct}%, ${n.jointCommits} joint commits)`)
      any = true
    }
  }
  if (!any) out.push('_no strong co-change signals_')
  out.push('')

  const hints = formatComplexityHints(profiles)
  if (hints) { out.push(hints); out.push('') }

  if (graphReader && topPaths[0]) {
    const center = `file:${topPaths[0]}`
    if (graphReader.getNode(center)) {
      const sub = graphReader.getNeighbors(center, { maxHops: 1 })
      const rendered = renderSubgraph(sub)
      if (rendered) { out.push(rendered); out.push('') }
    }
  }

  out.push('## Instructions to the agent')
  out.push('Read the suggested files first. Consider the co-change targets')
  out.push('when scoping the plan. Treat HIGH-risk files with extra care.')

  console.log(out.join('\n'))
}

main().catch(err => {
  console.error('example failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
