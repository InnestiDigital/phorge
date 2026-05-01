import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveProfile } from '../../profiles/registry'
import { NullLanguageProfile } from '../../profiles/null-objects'
import { createGraphReader } from '../../graphs/graph-reader'
import { renderSubgraph } from '../../graphs/graph-renderer'
import { fail, printJson, printText, type ParsedCli } from '../args'
import { graphPath, loadGraph, type LoadedGraph } from '../graph-cache'

export async function runGraph(cli: ParsedCli): Promise<void> {
  const sub = cli.positionals[0]
  if (!sub) fail('graph: subcommand required (build | query | stats)')

  switch (sub) {
    case 'build': return buildCmd(cli)
    case 'query': return queryCmd(cli)
    case 'stats': return statsCmd(cli)
    default: fail(`graph: unknown subcommand "${sub}" (expected build | query | stats)`)
  }
}

async function buildCmd(cli: ParsedCli): Promise<void> {
  const repoRoot = cli.repoPath
  if (!existsSync(repoRoot)) fail(`graph build: repo not found: ${repoRoot}`)

  const override = typeof cli.flags.lang === 'string' ? cli.flags.lang : undefined
  const profile = await resolveProfile({ repoPath: repoRoot, override })

  if (profile === NullLanguageProfile) {
    fail(
      `graph build: no language profile detected for ${repoRoot}.\n` +
      `Pass --lang <id> explicitly, or run from a directory containing a recognized project.`,
    )
  }

  const start = Date.now()
  const result = profile.graph.scan({ repoRoot })
  const elapsedMs = Date.now() - start

  const out: LoadedGraph = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoRoot,
    nodes: result.nodes,
    edges: result.edges,
    stats: result.stats,
  }

  const dest = graphPath(repoRoot)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, JSON.stringify(out))

  if (cli.json) {
    printJson({ path: dest, elapsedMs, stats: result.stats, profile: profile.id })
    return
  }

  printText(
    `Graph written to ${dest}\n` +
    `  profile: ${profile.id}\n` +
    `  ${result.stats.filesScanned} files scanned, ${result.stats.parseErrors} parse errors\n` +
    `  ${result.stats.nodes} nodes, ${result.stats.edges} edges\n` +
    `  ${elapsedMs}ms`,
  )
}

function statsCmd(cli: ParsedCli): void {
  const graph = loadGraph(cli.repoPath)

  if (cli.json) {
    printJson({ generatedAt: graph.generatedAt, stats: graph.stats })
    return
  }

  const lines: string[] = []
  lines.push(`# Graph stats: ${cli.repoPath}`)
  lines.push(`Generated: ${graph.generatedAt}`)
  lines.push(`Files scanned:  ${graph.stats.filesScanned}`)
  lines.push(`Parse errors:   ${graph.stats.parseErrors}`)
  lines.push(`Total nodes:    ${graph.stats.nodes}`)
  lines.push(`Total edges:    ${graph.stats.edges}`)
  lines.push('')
  lines.push('Per-scanner:')
  for (const [name, r] of Object.entries(graph.stats.perScanner)) {
    lines.push(`  ${name.padEnd(28)} nodes=${r.nodes}  edges=${r.edges}  skipped=${r.skipped}  unresolved=${r.unresolvedRefs}  dup=${r.duplicateEdges}`)
  }

  const byKind = new Map<string, number>()
  for (const n of graph.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1)
  lines.push('')
  lines.push('Nodes by kind:')
  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind.padEnd(20)} ${count}`)
  }

  printText(lines.join('\n'))
}

function queryCmd(cli: ParsedCli): void {
  const symbol = cli.positionals[1]
  if (!symbol) fail('graph query: <symbol> positional argument required')

  const depthRaw = typeof cli.flags.depth === 'string' ? cli.flags.depth : undefined
  const depth = depthRaw ? parseInt(depthRaw, 10) : 2
  if (depth !== 1 && depth !== 2) fail('graph query: --depth must be 1 or 2')

  const graph = loadGraph(cli.repoPath)
  const reader = createGraphReader(graph.nodes, graph.edges)

  let centerKey = reader.getNode(symbol) ? symbol : null
  if (!centerKey) {
    const matches = reader.search(symbol, { limit: 5 })
    if (matches.length === 0) {
      if (cli.json) { printJson({ symbol, found: false, matches: [] }); return }
      printText(`No node found for "${symbol}"`)
      return
    }
    centerKey = matches[0].key
    if (!cli.json && matches.length > 1) {
      process.stderr.write(`phorge: multiple matches for "${symbol}", using ${centerKey}\n`)
    }
  }

  const sub = reader.getNeighbors(centerKey, { maxHops: depth as 1 | 2 })

  if (cli.json) {
    printJson(sub)
    return
  }

  const rendered = renderSubgraph(sub)
  printText(rendered || `(empty subgraph for ${centerKey})`)
}
