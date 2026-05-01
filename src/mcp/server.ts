// MCP server wrapper exposing phorge primitives as typed RPC tools.
//
// Uses the low-level Server + ListTools/CallTool request handlers (rather than
// the high-level McpServer) because phorge ships hand-written JSON Schemas; the
// high-level API funnels everything through Zod shapes and we don't need that
// extra layer.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'

import { resolvePromptAnchors } from '../anchors/index.js'
import { loadRepoSignals } from '../cli/corpus-cache.js'
import { loadGraph } from '../cli/graph-cache.js'
import { createGraphReader, type GraphReader } from '../graphs/graph-reader.js'
import { renderSubgraph } from '../graphs/graph-renderer.js'
import { scanLaravelProject } from '../graphs/laravel-project-scanner.js'
import { buildFileComplexityProfile } from '../profiles/file-complexity-profile.js'
import { validatePlan, type DraftPlan, type PlanValidationDeps } from '../checkers/index.js'
import { loadRulesFromDirs } from '../cli/rules-loader.js'
import { buildBrief, renderBriefMarkdown } from '../cli/commands/brief.js'
import type { RepoResolver } from '../resolvers/index.js'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { graphPath, type LoadedGraph } from '../cli/graph-cache.js'

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

type ToolEntry = {
  tool: Tool
  handler: ToolHandler
}

const SERVER_NAME = 'phorge'
const SERVER_VERSION = '0.1.0'

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required string argument: ${key}`)
  }
  return v
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' ? v : undefined
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
}

async function loadGraphReader(repoPath: string): Promise<{ reader?: GraphReader; loaded: boolean }> {
  try {
    const g = loadGraph(repoPath)
    return { reader: createGraphReader(g.nodes, g.edges), loaded: true }
  } catch {
    return { loaded: false }
  }
}

function passthroughResolver(repoRoot: string): RepoResolver {
  return {
    fileExists: (p: string) => {
      const full = resolve(repoRoot, p)
      try { return existsSync(full) && statSync(full).isFile() }
      catch { return false }
    },
    findFileForClass: () => null,
    findMethodKey: () => null,
  }
}

function buildTools(): ToolEntry[] {
  const tools: ToolEntry[] = []

  tools.push({
    tool: {
      name: 'phorge_anchors',
      description: 'Resolve a user prompt to ranked anchor files and symbols using corpus, lexical, and graph signals.',
      inputSchema: {
        type: 'object',
        properties: {
          promptText: { type: 'string', description: 'User prompt to resolve' },
          repoPath: { type: 'string', description: 'Absolute path to repo' },
          top: { type: 'number', description: 'Max anchors to keep (default 20)' },
        },
        required: ['promptText', 'repoPath'],
      },
    },
    handler: async (args) => {
      const promptText = requireString(args, 'promptText')
      const repoPath = requireString(args, 'repoPath')
      const top = optionalNumber(args, 'top') ?? 20
      const signals = await loadRepoSignals({ repoPath })
      const { reader } = await loadGraphReader(repoPath)
      const result = resolvePromptAnchors({
        promptText,
        deps: {
          corpus: signals.corpus.entries,
          coChangeView: signals.coChange.all,
          allFiles: signals.allFiles,
          ...(reader ? { graphReader: reader } : {}),
        },
      })
      return jsonResult({
        targetPaths: result.targetPaths.slice(0, top),
        targetSymbols: result.targetSymbols.slice(0, top),
        totalRanked: result.anchors.length,
      })
    },
  })

  tools.push({
    tool: {
      name: 'phorge_cochange',
      description: 'List files that historically co-change with the given file (coupling % and joint commit count).',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Repo-relative file path' },
          repoPath: { type: 'string', description: 'Absolute path to repo' },
        },
        required: ['filePath', 'repoPath'],
      },
    },
    handler: async (args) => {
      const filePath = requireString(args, 'filePath')
      const repoPath = requireString(args, 'repoPath')
      const signals = await loadRepoSignals({ repoPath })
      const entry = signals.coChange.all.entries.find((e) => e.path === filePath)
      return jsonResult(entry ?? { path: filePath, neighbors: [] })
    },
  })

  tools.push({
    tool: {
      name: 'phorge_volatility',
      description: 'Risk profile (churn + bug-fix density + risk score) per file or top-N volatile files.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string', description: 'Absolute path to repo' },
          filePath: { type: 'string', description: 'Optional repo-relative file path (omit for top-N)' },
          top: { type: 'number', description: 'Max entries when filePath omitted (default 20)' },
        },
        required: ['repoPath'],
      },
    },
    handler: async (args) => {
      const repoPath = requireString(args, 'repoPath')
      const filePath = optionalString(args, 'filePath')
      const top = optionalNumber(args, 'top') ?? 20
      const signals = await loadRepoSignals({ repoPath })
      const entries = filePath
        ? signals.volatility.entries.filter((e) => e.path === filePath)
        : signals.volatility.entries.slice(0, top)
      return jsonResult(entries)
    },
  })

  tools.push({
    tool: {
      name: 'phorge_complexity',
      description: 'LOC, cyclomatic, churn, and refactor-risk profile for the given files.',
      inputSchema: {
        type: 'object',
        properties: {
          filePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Repo-relative file paths',
          },
          repoPath: { type: 'string', description: 'Absolute path to repo' },
        },
        required: ['filePaths', 'repoPath'],
      },
    },
    handler: async (args) => {
      const repoPath = requireString(args, 'repoPath')
      const fp = args.filePaths
      if (!Array.isArray(fp) || fp.length === 0) {
        throw new Error('filePaths must be a non-empty array of strings')
      }
      const signals = await loadRepoSignals({ repoPath })
      const profiles = fp
        .filter((p): p is string => typeof p === 'string')
        .map((p) => buildFileComplexityProfile(p, {
          repoRoot: repoPath,
          volatilityEntries: signals.volatility.entries,
          revertStats: signals.reverts.pathStats,
        }))
        .filter((p): p is NonNullable<typeof p> => p !== null)
      return jsonResult(profiles)
    },
  })

  tools.push({
    tool: {
      name: 'phorge_graph_query',
      description: 'Render the structural neighborhood (rendered subgraph text) around a symbol, FQCN, file path, or graph key.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name, FQCN, file path, or graph key' },
          repoPath: { type: 'string', description: 'Absolute path to repo' },
          depth: { type: 'number', description: 'Hops from center (1 or 2, default 2)' },
        },
        required: ['symbol', 'repoPath'],
      },
    },
    handler: async (args) => {
      const symbol = requireString(args, 'symbol')
      const repoPath = requireString(args, 'repoPath')
      const depthRaw = optionalNumber(args, 'depth') ?? 2
      const depth: 1 | 2 = depthRaw === 1 ? 1 : 2
      const g = loadGraph(repoPath)
      const reader = createGraphReader(g.nodes, g.edges)
      let centerKey = reader.getNode(symbol) ? symbol : null
      if (!centerKey) {
        const matches = reader.search(symbol, { limit: 1 })
        if (matches.length === 0) return textResult(`No node found for "${symbol}"`)
        centerKey = matches[0].key
      }
      const sub = reader.getNeighbors(centerKey, { maxHops: depth })
      const rendered = renderSubgraph(sub) || `(empty subgraph for ${centerKey})`
      return textResult(rendered)
    },
  })

  tools.push({
    tool: {
      name: 'phorge_validate_plan',
      description: 'Run the deterministic plan validator against plan text. Returns verdict + structured findings.',
      inputSchema: {
        type: 'object',
        properties: {
          planText: { type: 'string', description: 'Raw plan text (markdown or freeform)' },
          repoPath: { type: 'string', description: 'Absolute path to repo' },
          rulesDirs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional rule directories. Defaults to .forge/rules and .phorge/rules under repoPath.',
          },
        },
        required: ['planText', 'repoPath'],
      },
    },
    handler: async (args) => {
      const planText = requireString(args, 'planText')
      const repoPath = requireString(args, 'repoPath')
      const rulesDirsRaw = args.rulesDirs
      const rulesDirs = Array.isArray(rulesDirsRaw)
        ? rulesDirsRaw.filter((d): d is string => typeof d === 'string').map((d) => resolve(d))
        : [join(repoPath, '.forge', 'rules'), join(repoPath, '.phorge', 'rules')]

      const signals = await loadRepoSignals({ repoPath })
      const { reader: graphReader } = await loadGraphReader(repoPath)
      const rules = await loadRulesFromDirs(rulesDirs)

      const deps: PlanValidationDeps = {
        repoResolver: passthroughResolver(repoPath),
        graphReader: graphReader ?? null,
        cochangeEntries: signals.coChange.all.entries,
        volatilityEntries: signals.volatility.entries,
        revertStats: signals.reverts.pathStats,
        rules,
        repoRoot: repoPath,
      }
      const plan: DraftPlan = { rawText: planText, sourceLabel: 'mcp' }
      const result = await validatePlan(plan, deps)
      return jsonResult({ ...result, rulesLoaded: rules.length, graphLoaded: Boolean(graphReader) })
    },
  })

  tools.push({
    tool: {
      name: 'phorge_brief',
      description: 'Bundled pre-planning markdown brief (anchors + co-change + complexity + volatility + subgraph). Killer tool for prompt injection.',
      inputSchema: {
        type: 'object',
        properties: {
          promptText: { type: 'string', description: 'User prompt' },
          repoPath: { type: 'string', description: 'Absolute path to repo' },
          top: { type: 'number', description: 'Top N anchors to include (default 8)' },
        },
        required: ['promptText', 'repoPath'],
      },
    },
    handler: async (args) => {
      const promptText = requireString(args, 'promptText')
      const repoPath = requireString(args, 'repoPath')
      const top = optionalNumber(args, 'top') ?? 8
      const signals = await loadRepoSignals({ repoPath })
      const { reader, loaded } = await loadGraphReader(repoPath)
      const brief = buildBrief({
        promptText,
        topN: top,
        signals,
        graphReader: reader,
        graphLoaded: loaded,
        repoPath,
      })
      return textResult(renderBriefMarkdown(brief))
    },
  })

  tools.push({
    tool: {
      name: 'phorge_corpus_build',
      description: 'Force rebuild the commit corpus cache. Returns commit counts considered/kept.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string', description: 'Absolute path to repo' },
          since: { type: 'string', description: 'ISO date or YYYY-MM-DD lower bound (default 36 months ago)' },
        },
        required: ['repoPath'],
      },
    },
    handler: async (args) => {
      const repoPath = requireString(args, 'repoPath')
      const since = optionalString(args, 'since')
      const signals = await loadRepoSignals({ repoPath, since, forceRebuild: true })
      const s = signals.corpus.stats
      return textResult(`ok, ${s.totalConsidered} commits considered, ${s.kept} kept`)
    },
  })

  tools.push({
    tool: {
      name: 'phorge_graph_build',
      description: 'Scan repo and persist the Laravel-aware code graph to .phorge/graph.json. Returns node and edge counts.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string', description: 'Absolute path to repo' },
        },
        required: ['repoPath'],
      },
    },
    handler: async (args) => {
      const repoPath = requireString(args, 'repoPath')
      if (!existsSync(repoPath)) throw new Error(`repo not found: ${repoPath}`)
      const result = scanLaravelProject({ repoRoot: repoPath })
      const out: LoadedGraph = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        repoRoot: repoPath,
        nodes: result.nodes,
        edges: result.edges,
        stats: result.stats,
      }
      const dest = graphPath(repoPath)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, JSON.stringify(out))
      return textResult(`ok, ${result.stats.nodes} nodes, ${result.stats.edges} edges`)
    },
  })

  return tools
}

export const PHORGE_MCP_TOOL_NAMES = [
  'phorge_anchors',
  'phorge_cochange',
  'phorge_volatility',
  'phorge_complexity',
  'phorge_graph_query',
  'phorge_validate_plan',
  'phorge_brief',
  'phorge_corpus_build',
  'phorge_graph_build',
] as const

export type PhorgeMcpToolName = (typeof PHORGE_MCP_TOOL_NAMES)[number]

export type PhorgeMcpServer = {
  server: Server
  tools: ToolEntry[]
}

export function createMcpServer(): PhorgeMcpServer {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  const tools = buildTools()
  const byName = new Map(tools.map((t) => [t.tool.name, t]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => t.tool),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const entry = byName.get(name)
    if (!entry) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      }
    }
    try {
      return await entry.handler((req.params.arguments ?? {}) as Record<string, unknown>)
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      }
    }
  })

  return { server, tools }
}
