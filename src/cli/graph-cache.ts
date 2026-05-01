// In-memory cache for loaded graph.json — avoids re-reading multi-MB
// graphs across CLI commands invoked in the same process.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GraphNode, GraphEdge } from '../graphs/schema'
import type { GraphScanStats } from '../profiles/contracts'
import { loadProjectConfig } from '../profiles/registry'
import { matchGlob } from '../profiles/contracts'

export type LoadedGraph = {
  schemaVersion: 1
  generatedAt: string
  repoRoot: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphScanStats
}

const cache = new Map<string, LoadedGraph>()

export function graphPath(repoRoot: string): string {
  return join(repoRoot, '.phorge', 'graph.json')
}

export function loadGraph(repoRoot: string): LoadedGraph {
  const path = graphPath(repoRoot)
  const cached = cache.get(path)
  if (cached) return cached

  if (!existsSync(path)) {
    throw new Error(`graph not found at ${path} — run: phorge graph build --repo ${repoRoot}`)
  }
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw) as LoadedGraph

  // Project-config pathRoles tags are applied at load-time (not bake-time) so
  // users can tune role hints without rebuilding the graph. Auto-tags from
  // scanners are preserved; user tags merge additively.
  const config = loadProjectConfig(repoRoot)
  const pathRoles = config?.pathRoles
  if (pathRoles && pathRoles.length > 0) {
    for (const node of parsed.nodes) {
      if (!node.filePath) continue
      const extra: string[] = []
      for (const rule of pathRoles) {
        if (matchGlob(rule.glob, node.filePath)) {
          for (const t of rule.tags) extra.push(t)
        }
      }
      if (extra.length === 0) continue
      const merged = new Set<string>(node.roles ?? [])
      for (const t of extra) merged.add(t)
      node.roles = [...merged]
    }
  }

  cache.set(path, parsed)
  return parsed
}

export function clearGraphCache(): void {
  cache.clear()
}
