/**
 * Example 01 — Prompt → ranked anchor files
 *
 * What this surfaces:
 *   Given a free-form user prompt (ticket title, feature request, bug
 *   description), phorge resolves the prompt to a ranked list of files
 *   in the repo most likely to be touched. Three signals are fused:
 *     - corpus retrieval  (commit messages mention these files)
 *     - lexical match     (path tokens overlap prompt tokens)
 *     - graph expansion   (structural neighbours of explicit symbols)
 *
 * Why this is useful for a coding agent:
 *   Stops the agent walking blind into the repo. Anchor list goes into
 *   the system prompt as "start by reading these files".
 *
 * Phorge surface exercised:
 *   resolvePromptAnchors, loadRepoSignals, loadGraph, createGraphReader
 */

import { resolvePromptAnchors } from '../src/anchors'
import { createGraphReader, type GraphReader } from '../src/graphs/graph-reader'
import { loadRepoSignals } from '../src/cli/corpus-cache'
import { loadGraph } from '../src/cli/graph-cache'

const repoPath = process.argv[2] ?? process.cwd()
const prompt = process.argv[3] ?? 'fix the refund flow for split-pay orders'

async function main(): Promise<void> {
  console.log(`# Anchors for: "${prompt}"`)
  console.log(`# Repo: ${repoPath}`)
  console.log('')

  const signals = await loadRepoSignals({ repoPath })

  let graphReader: GraphReader | undefined
  try {
    const g = loadGraph(repoPath)
    graphReader = createGraphReader(g.nodes, g.edges)
  } catch {
    console.warn('warn: graph not built — run `phorge graph build --repo <path>` for richer expansion')
  }

  const result = resolvePromptAnchors({
    promptText: prompt,
    deps: {
      corpus: signals.corpus.entries,
      coChangeView: signals.coChange.all,
      allFiles: signals.allFiles,
      ...(graphReader ? { graphReader } : {}),
    },
  })

  console.log('## Top files (ranked)')
  for (const path of result.targetPaths.slice(0, 10)) {
    const a = result.anchors.find(x => x.kind === 'path' && x.value === path)
    const tag = a ? `${a.source}/${a.confidence}` : 'lexical/low'
    console.log(`  - ${path}  [${tag}]`)
  }
  console.log('')

  if (result.targetSymbols.length > 0) {
    console.log('## Top symbols')
    for (const s of result.targetSymbols.slice(0, 10)) console.log(`  - ${s}`)
    console.log('')
  }

  console.log('## Stats per stage')
  console.log(`  explicit (regex):  ${result.stages.explicit.anchors.length}`)
  console.log(`  corpus retrieval:  ${result.stages.corpus?.anchors.length ?? 0}`)
  console.log(`  lexical match:     ${result.stages.lexical?.anchors.length ?? 0}`)
  console.log(`  graph expansion:   ${result.stages.expansion?.anchors.length ?? 0}`)
  console.log(`  ranked total:      ${result.anchors.length}`)
}

main().catch(err => {
  console.error('example failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
