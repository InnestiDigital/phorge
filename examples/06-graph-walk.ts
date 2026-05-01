/**
 * Example 06 — Structural exploration via the Laravel graph
 *
 * What this surfaces:
 *   Load a previously-built `.phorge/graph.json`, pick a controller
 *   class, and render its 1-hop and 2-hop structural neighbourhood.
 *   Edges include defines / extends / calls / routes-to / dispatches /
 *   listens-to / observes / etc.
 *
 * Why this is useful for a coding agent:
 *   Walks a Laravel codebase the way a senior engineer would — through
 *   structural relationships, not file names. Lets an agent discover
 *   "what does OrderController actually depend on?" without reading
 *   every file or invoking an LLM.
 *
 * Prerequisite:
 *   Run `phorge graph build --repo <path>` first. This example needs
 *   the cached graph and will exit if it is missing.
 *
 * Phorge surface exercised:
 *   loadGraph, createGraphReader, renderSubgraph, GraphReader.search
 */

import { createGraphReader, type GraphReader } from '../src/graphs/graph-reader'
import { renderSubgraph } from '../src/graphs/graph-renderer'
import { loadGraph } from '../src/cli/graph-cache'

const repoPath = process.argv[2] ?? process.cwd()
const PREFERRED = ['UserController', 'OrderController', 'ProductController', 'AuthController']

function pickCenter(reader: GraphReader): string | null {
  for (const name of PREFERRED) {
    const hits = reader.search(name, { kinds: ['class'], limit: 1 })
    if (hits.length > 0) return hits[0].key
  }
  // Fall back to the first controller-like class node.
  const fallback = reader.search('Controller', { kinds: ['class'], limit: 1 })
  return fallback.length > 0 ? fallback[0].key : null
}

function main(): void {
  let graph
  try {
    graph = loadGraph(repoPath)
  } catch (err) {
    console.error('graph not found — run: phorge graph build --repo', repoPath)
    console.error('  (', err instanceof Error ? err.message : err, ')')
    process.exit(1)
  }

  const reader = createGraphReader(graph.nodes, graph.edges)
  const center = pickCenter(reader)
  if (!center) {
    console.error('no controller class found in graph')
    process.exit(1)
  }

  console.log(`# Graph walk for ${center}`)
  console.log(`# Repo: ${repoPath}`)
  console.log(`# Total: ${graph.nodes.length} nodes, ${graph.edges.length} edges`)
  console.log('')

  for (const depth of [1, 2] as const) {
    console.log('='.repeat(60))
    console.log(`Depth ${depth}`)
    console.log('='.repeat(60))
    const sub = reader.getNeighbors(center, { maxHops: depth })
    const rendered = renderSubgraph(sub, { maxChars: 4000 })
    console.log(rendered || '(empty)')
    console.log('')
  }
}

main()
