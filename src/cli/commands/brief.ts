// `phorge brief` — one-shot pre-planning context bundle for coding agents.
//
// Single command that fans out to anchors + co-change + complexity + volatility
// + graph subgraph and emits one structured Markdown block (or JSON) suitable
// for direct prompt injection. Composes existing primitives — no new logic.

import { resolvePromptAnchors, type TargetAnchor } from '../../anchors'
import { loadRepoSignals, type RepoSignals } from '../corpus-cache'
import { loadGraph, graphPath } from '../graph-cache'
import { createGraphReader, type GraphReader } from '../../graphs/graph-reader'
import { renderSubgraph } from '../../graphs/graph-renderer'
import { buildFileComplexityProfile, type FileComplexityProfile } from '../../profiles/file-complexity-profile'
import { resolveProfile } from '../../profiles/registry'
import { NullLanguageProfile } from '../../profiles/null-objects'
import type { LanguageProfile } from '../../profiles/contracts'
import { fail, printJson, printText, type ParsedCli } from '../args'
import type { CoChangeNeighbor, VolatilityEntry } from '../../commit-mining/schema'

const DEFAULT_TOP = 8
const COCHANGE_NEIGHBORS_PER_FILE = 3

export type BriefInput = {
  promptText: string
  topN: number
  signals: RepoSignals
  graphReader?: GraphReader
  graphLoaded: boolean
  repoPath: string
  profile?: LanguageProfile
}

export type BriefAnchorEntry = {
  path: string
  source: TargetAnchor['source']
  confidence: TargetAnchor['confidence']
  complexity?: FileComplexityProfile
  volatility?: VolatilityEntry
  coChange: CoChangeNeighbor[]
}

export type BriefSubjectSection = {
  label: string
  anchors: BriefAnchorEntry[]
  symbols: string[]
}

export type BriefResult = {
  prompt: string
  anchors: BriefAnchorEntry[]
  symbols: string[]
  subgraph: string | null
  subgraphCenter: string | null
  /** Populated only for compositional prompts (e.g. "X vs Y"). */
  subjects: BriefSubjectSection[] | null
  meta: {
    graphLoaded: boolean
    corpusCommitsConsidered: number
    corpusCommitsKept: number
    totalRankedAnchors: number
    topN: number
  }
}

// Resolve a candidate (symbol name, fqcn, file path, or graph key) to a graph
// node key. File nodes are typically leaves carrying only their declaration
// edge; profiles supply an ordered `promotionEdges` list naming edge kinds to
// follow from a file node toward a richer center (Laravel: file -> class via
// `defines`; TS: file -> component/composable via `defines`). The first edge
// landing on a node with > 1 outgoing edge wins; otherwise we keep the file.
function resolveGraphCenter(
  reader: GraphReader,
  candidate: string,
  promotionEdges: readonly string[],
): string | null {
  const promoteFileNode = (fileKey: string): string => {
    for (const kind of promotionEdges) {
      const sub = reader.getNeighbors(fileKey, { maxHops: 1, edgeKinds: [kind] })
      for (const e of sub.edges) {
        if (e.from !== fileKey) continue
        const next = reader.getNeighbors(e.to, { maxHops: 1 })
        const outgoing = next.edges.filter(x => x.from === e.to).length
        if (outgoing > 1) return e.to
      }
    }
    return fileKey
  }

  if (reader.getNode(candidate)) {
    if (candidate.startsWith('file:')) return promoteFileNode(candidate)
    return candidate
  }
  const fileKey = `file:${candidate}`
  if (reader.getNode(fileKey)) return promoteFileNode(fileKey)

  const anyMatch = reader.search(candidate, { limit: 1 })
  return anyMatch.length > 0 ? anyMatch[0].key : null
}

export function buildBrief(input: BriefInput): BriefResult {
  const { promptText, topN, signals, graphReader, graphLoaded, repoPath } = input
  const profile = input.profile ?? NullLanguageProfile

  const result = resolvePromptAnchors({
    promptText,
    deps: {
      corpus: signals.corpus.entries,
      coChangeView: signals.coChange.all,
      allFiles: signals.allFiles,
      lexical: profile.lexical,
      ...(profile.projectConfig ? { projectConfig: profile.projectConfig } : {}),
      ...(graphReader ? { graphReader } : {}),
    },
  })

  const coChangeIndex = new Map(
    signals.coChange.all.entries.map(e => [e.path, e]),
  )
  const volIndex = new Map(signals.volatility.entries.map(e => [e.path, e]))

  const buildEntries = (paths: string[], anchorList: ReadonlyArray<TargetAnchor>): BriefAnchorEntry[] => {
    const byPath = new Map<string, TargetAnchor>()
    for (const a of anchorList) {
      if (a.kind !== 'path') continue
      if (!byPath.has(a.value)) byPath.set(a.value, a)
    }
    return paths.map(path => {
      const anchor = byPath.get(path)
      const fileProfile = buildFileComplexityProfile(path, {
        repoRoot: repoPath,
        volatilityEntries: signals.volatility.entries,
        revertStats: signals.reverts.pathStats,
        complexityAnalyzer: profile.complexity,
      })
      const cc = coChangeIndex.get(path)
      const neighbors = (cc?.neighbors ?? []).slice(0, COCHANGE_NEIGHBORS_PER_FILE)
      return {
        path,
        source: anchor?.source ?? 'lexical',
        confidence: anchor?.confidence ?? 'low',
        complexity: fileProfile ?? undefined,
        volatility: volIndex.get(path),
        coChange: neighbors,
      }
    })
  }

  const topPaths = result.targetPaths.slice(0, topN)
  const anchors: BriefAnchorEntry[] = buildEntries(topPaths, result.anchors)

  const subjects: BriefSubjectSection[] | null = result.subjects
    ? result.subjects.map(s => ({
        label: s.label,
        anchors: buildEntries(s.result.targetPaths.slice(0, topN), s.result.anchors),
        symbols: s.result.targetSymbols.slice(0, topN),
      }))
    : null

  // Subgraph: try top symbols then top paths. For path candidates, prefer the
  // class node defined by that file (richer outgoing edges than the file node).
  let subgraph: string | null = null
  let subgraphCenter: string | null = null
  if (graphReader) {
    const candidates: string[] = [
      ...result.targetSymbols.slice(0, 3),
      ...topPaths.slice(0, 3),
    ]
    const promotionEdges = profile.graph.promotionEdges ?? []
    let bestRendered: string | null = null
    let bestCenter: string | null = null
    let bestEdgeCount = 0
    for (const cand of candidates) {
      const centerKey = resolveGraphCenter(graphReader, cand, promotionEdges)
      if (!centerKey) continue
      const sub = graphReader.getNeighbors(centerKey, { maxHops: 1 })
      const rendered = renderSubgraph(sub)
      if (!rendered) continue
      if (sub.edges.length > bestEdgeCount) {
        bestRendered = rendered
        bestCenter = centerKey
        bestEdgeCount = sub.edges.length
      }
    }
    subgraph = bestRendered
    subgraphCenter = bestCenter
  }

  return {
    prompt: promptText,
    anchors,
    symbols: result.targetSymbols.slice(0, topN),
    subgraph,
    subgraphCenter,
    subjects,
    meta: {
      graphLoaded,
      corpusCommitsConsidered: signals.corpus.stats.totalConsidered,
      corpusCommitsKept: signals.corpus.stats.kept,
      totalRankedAnchors: result.anchors.length,
      topN,
    },
  }
}

export function renderBriefMarkdown(brief: BriefResult): string {
  const lines: string[] = []
  lines.push('# Phorge Brief')
  lines.push('')
  lines.push('## Prompt')
  lines.push(brief.prompt)
  lines.push('')

  const renderAnchorList = (entries: BriefAnchorEntry[]): void => {
    if (entries.length === 0) {
      lines.push('_No anchors resolved._')
      return
    }
    for (const a of entries) {
      const bits: string[] = []
      if (a.complexity) {
        const c = a.complexity
        const parts = [`risk=${c.refactorRisk}`, `lines=${c.lineCount}`]
        if (c.cyclomatic !== undefined) parts.push(`cyclomatic=${c.cyclomatic}`)
        if (c.commitCount > 0) parts.push(`churn=${c.commitCount} commits`)
        bits.push(parts.join(', '))
      }
      bits.push(`${a.source}/${a.confidence}`)
      lines.push(`- \`${a.path}\` [${bits.join(' | ')}]`)
    }
  }

  if (brief.subjects && brief.subjects.length > 0) {
    for (const sub of brief.subjects) {
      lines.push(`## Suggested files for: ${sub.label}`)
      renderAnchorList(sub.anchors)
      lines.push('')
      if (sub.symbols.length > 0) {
        lines.push(`### Symbols for: ${sub.label}`)
        for (const s of sub.symbols) lines.push(`- ${s}`)
        lines.push('')
      }
    }
  } else {
    lines.push('## Suggested files (ranked)')
    renderAnchorList(brief.anchors)
    lines.push('')
  }

  if (!brief.subjects && brief.symbols.length > 0) {
    lines.push('## Suggested symbols')
    for (const s of brief.symbols) lines.push(`- ${s}`)
    lines.push('')
  }

  lines.push('## Co-change relationships')
  const ccLines: string[] = []
  for (const a of brief.anchors) {
    for (const n of a.coChange) {
      const pct = (n.coupling * 100).toFixed(0)
      ccLines.push(`- \`${a.path}\` -> \`${n.path}\` (${pct}%, ${n.jointCommits} joint commits)`)
    }
  }
  if (ccLines.length === 0) lines.push('_No co-change neighbors for top files._')
  else lines.push(...ccLines)
  lines.push('')

  lines.push('## Volatility hints')
  const volLines: string[] = []
  for (const a of brief.anchors) {
    if (!a.volatility) continue
    const v = a.volatility
    if (v.riskScore < 0.5 && v.bugFixDensity < 0.3) continue
    const risk = (v.riskScore * 100).toFixed(0)
    const bug = (v.bugFixDensity * 100).toFixed(0)
    volLines.push(`- \`${a.path}\`: risk=${risk}%, bug-fix density=${bug}%, commits=${v.commitCount}`)
  }
  if (volLines.length === 0) lines.push('_No notable volatility among top files._')
  else lines.push(...volLines)
  lines.push('')

  lines.push('## Structural neighborhood (graph)')
  if (brief.subgraph) {
    lines.push(brief.subgraph)
  } else if (brief.meta.graphLoaded) {
    lines.push('_No graph node matched top anchors._')
  } else {
    lines.push('_Graph not built — run `phorge graph build --repo <path>` for structural context._')
  }
  lines.push('')

  lines.push('## Notes')
  lines.push(`- Graph: ${brief.meta.graphLoaded ? 'loaded' : 'not built'}`)
  lines.push(`- Corpus: ${brief.meta.corpusCommitsKept} commits kept (of ${brief.meta.corpusCommitsConsidered} considered)`)
  lines.push(`- Ranked anchors total: ${brief.meta.totalRankedAnchors} (showing top ${brief.meta.topN})`)

  return lines.join('\n')
}

export async function runBrief(cli: ParsedCli): Promise<void> {
  const promptText = typeof cli.flags.prompt === 'string'
    ? cli.flags.prompt
    : cli.positionals.join(' ')

  if (!promptText.trim()) {
    fail('brief: --prompt <text> (or positional prompt) required\n  example: phorge brief --prompt "fix refund flow" --repo .')
  }

  const topRaw = typeof cli.flags.top === 'string' ? cli.flags.top : undefined
  const topN = topRaw ? Math.max(1, parseInt(topRaw, 10) || DEFAULT_TOP) : DEFAULT_TOP

  const profile = await resolveProfile({
    repoPath: cli.repoPath,
    override: typeof cli.flags.lang === 'string' ? cli.flags.lang : undefined,
  })

  const signals = await loadRepoSignals({
    repoPath: cli.repoPath,
    since: cli.since,
    fileScope: profile.fileScope,
    profileId: profile.id,
  })

  let graphReader: GraphReader | undefined
  let graphLoaded = false
  try {
    const graph = loadGraph(cli.repoPath)
    graphReader = createGraphReader(graph.nodes, graph.edges)
    graphLoaded = true
  } catch {
    process.stderr.write(
      `phorge: graph not built (${graphPath(cli.repoPath)}) — run \`phorge graph build --repo ${cli.repoPath}\` for structural context\n`,
    )
  }

  const brief = buildBrief({
    promptText,
    topN,
    signals,
    graphReader,
    graphLoaded,
    repoPath: cli.repoPath,
    profile,
  })

  if (cli.json) {
    printJson(brief)
    return
  }

  printText(renderBriefMarkdown(brief))
}
