// `phorge anchors` — given a user prompt, return ranked anchor files+symbols.

import { resolvePromptAnchors } from '../../anchors'
import { loadRepoSignals } from '../corpus-cache'
import { loadGraph, graphPath } from '../graph-cache'
import { createGraphReader, type GraphReader } from '../../graphs/graph-reader'
import { resolveProfile } from '../../profiles/registry'
import { fail, printJson, printText, type ParsedCli } from '../args'

export async function runAnchors(cli: ParsedCli): Promise<void> {
  const promptText = typeof cli.flags.prompt === 'string'
    ? cli.flags.prompt
    : cli.positionals.join(' ')

  if (!promptText) {
    fail('anchors: --prompt or positional prompt text required')
  }

  const profile = await resolveProfile({
    repoPath: cli.repoPath,
    override: typeof cli.flags.lang === 'string' ? cli.flags.lang : undefined,
  })

  const signals = await loadRepoSignals({
    repoPath: cli.repoPath,
    since: cli.since,
    fileScope: profile.fileScope,
    profileId: profile.id,
      volatility: profile.projectConfig?.volatility,
  })

  let graphReader: GraphReader | undefined
  let graphLoaded = false
  try {
    const graph = loadGraph(cli.repoPath)
    graphReader = createGraphReader(graph.nodes, graph.edges)
    graphLoaded = true
  } catch {
    process.stderr.write(
      `phorge: graph not built (${graphPath(cli.repoPath)}) — run \`phorge graph build --repo ${cli.repoPath}\` for richer anchor expansion\n`,
    )
  }

  const result = resolvePromptAnchors({
    promptText,
    deps: {
      corpus: signals.corpus.entries,
      coChangeView: signals.coChange.all,
      allFiles: signals.allFiles,
      lexical: profile.lexical,
      ...(graphReader ? { graphReader } : {}),
    },
  })

  if (cli.json) {
    printJson(result)
    return
  }

  const lines: string[] = []
  lines.push(`# Anchors for prompt: "${truncate(promptText, 80)}"`)
  lines.push('')
  if (result.subjects && result.subjects.length > 0) {
    for (const sub of result.subjects) {
      if (sub.result.targetPaths.length > 0) {
        lines.push(`## Files (subject: ${sub.label})`)
        for (const p of sub.result.targetPaths.slice(0, 20)) lines.push(`  - ${p}`)
        lines.push('')
      }
      if (sub.result.targetSymbols.length > 0) {
        lines.push(`## Symbols (subject: ${sub.label})`)
        for (const s of sub.result.targetSymbols.slice(0, 20)) lines.push(`  - ${s}`)
        lines.push('')
      }
    }
  } else {
    if (result.targetPaths.length > 0) {
      lines.push('## Files')
      for (const p of result.targetPaths.slice(0, 20)) lines.push(`  - ${p}`)
      lines.push('')
    }
    if (result.targetSymbols.length > 0) {
      lines.push('## Symbols')
      for (const s of result.targetSymbols.slice(0, 20)) lines.push(`  - ${s}`)
      lines.push('')
    }
  }
  lines.push(`## Stats`)
  lines.push(`  profile: ${profile.id}`)
  lines.push(`  explicit anchors: ${result.stages.explicit.anchors.length}`)
  lines.push(`  corpus retrieved: ${result.stages.corpus?.anchors.length ?? 0}`)
  lines.push(`  lexical retrieved: ${result.stages.lexical?.anchors.length ?? 0}`)
  lines.push(`  expanded: ${result.stages.expansion?.anchors.length ?? 0}`)
  lines.push(`  ranked total: ${result.anchors.length}`)
  lines.push(`  graph: ${graphLoaded ? 'loaded' : 'not built'}`)
  printText(lines.join('\n'))
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
