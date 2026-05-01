// Walks a Laravel repo, parses all PHP files, extracts core graph
// (classes/methods/calls/extends), then runs the 9 Laravel scanners
// over a shared AST cache to enrich with framework-aware edges.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parsePhpFile } from './php-parser'
import { extractFromSource } from '../../graphs/extractor'
import { normalizeRepoPath, normalizeNamespace } from '../../graphs/node-keys'
import {
  scanRoutes,
  scanControllerMethods,
  scanJobs,
  scanEventsAndListeners,
  scanObservers,
  scanPolicies,
  scanBindings,
  scanCommands,
  scanResourcesAndTransformers,
  tagPathRoles,
  type LaravelScannerContext,
  type ScannerResult,
} from './scanner'
import type { GraphNode, GraphEdge } from '../../graphs/schema'

export type ScanStats = {
  filesScanned: number
  parseErrors: number
  nodes: number
  edges: number
  perScanner: Record<string, ScannerResult>
}

export type ScanResult = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: ScanStats
}

const SCAN_DIRS = ['app', 'routes', 'database', 'config', 'tests']
const EXCLUDED_DIRS = new Set(['vendor', 'node_modules', '.git', '.phorge', 'storage', 'bootstrap'])

export function scanLaravelProject(opts: { repoRoot: string }): ScanResult {
  const repoRoot = opts.repoRoot
  const phpFiles = collectPhpFiles(repoRoot)

  const ctx: LaravelScannerContext = {
    nodes: new Map(),
    edges: [],
    edgeSet: new Set(),
    astCache: new Map(),
    fqcnIndex: new Map(),
  }

  let parseErrors = 0
  let scanned = 0

  for (const absPath of phpFiles) {
    const relPath = normalizeRepoPath(relative(repoRoot, absPath))
    let source: string
    try {
      source = readFileSync(absPath, 'utf-8')
    } catch (err) {
      process.stderr.write(`phorge: skip ${relPath} (read error: ${err instanceof Error ? err.message : String(err)})\n`)
      continue
    }

    // Pass 1: extractor populates core nodes/edges (file/class/method/extends/calls/...)
    let extracted
    try {
      extracted = extractFromSource(source, relPath)
    } catch (err) {
      parseErrors++
      process.stderr.write(`phorge: skip ${relPath} (extract error: ${err instanceof Error ? err.message : String(err)})\n`)
      continue
    }
    parseErrors += extracted.parseErrors
    scanned++

    for (const node of extracted.nodes) {
      if (!ctx.nodes.has(node.key)) ctx.nodes.set(node.key, node)
    }
    for (const edge of extracted.edges) {
      const sig = `${edge.from}|${edge.to}|${edge.kind}`
      if (!ctx.edgeSet.has(sig)) {
        ctx.edgeSet.add(sig)
        ctx.edges.push(edge)
      }
    }
    for (const fqcn of extracted.declaredSymbols) {
      ctx.fqcnIndex.set(normalizeNamespace(fqcn), relPath)
    }

    // Pass 2: AST cache for the Laravel scanners (re-parse — cheap vs. full scan).
    const { ast } = parsePhpFile(source)
    ctx.astCache.set(relPath, {
      ast,
      filePath: relPath,
      namespace: extracted.namespace,
      useMap: extracted.useMap,
    })
  }

  const perScanner: Record<string, ScannerResult> = {
    routes: scanRoutes(ctx),
    controllerMethods: scanControllerMethods(ctx),
    jobs: scanJobs(ctx),
    eventsAndListeners: scanEventsAndListeners(ctx),
    observers: scanObservers(ctx),
    policies: scanPolicies(ctx),
    bindings: scanBindings(ctx),
    commands: scanCommands(ctx),
    resourcesAndTransformers: scanResourcesAndTransformers(ctx),
  }

  // Path-role tagging runs last so it can decorate nodes added by any scanner.
  tagPathRoles(ctx)

  return {
    nodes: [...ctx.nodes.values()],
    edges: ctx.edges,
    stats: {
      filesScanned: scanned,
      parseErrors,
      nodes: ctx.nodes.size,
      edges: ctx.edges.length,
      perScanner,
    },
  }
}

function collectPhpFiles(repoRoot: string): string[] {
  const out: string[] = []
  for (const dir of SCAN_DIRS) {
    const abs = join(repoRoot, dir)
    try {
      const s = statSync(abs)
      if (!s.isDirectory()) continue
    } catch {
      continue
    }
    walk(abs, out)
  }
  return out
}

function walk(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.php')) {
      out.push(full)
    }
  }
}

// Silence unused import warning in some toolchains.
void sep
