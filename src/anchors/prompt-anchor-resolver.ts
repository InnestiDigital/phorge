// anchors/prompt-anchor-resolver.ts
//
// Public API: given user prompt text + repo signals, return ranked
// anchor files/symbols. Pre-planning context for coding agents.
//
// Pipeline: regex extraction → repo resolution → corpus retrieval
// → graph/co-change expansion → relevance ranking.

import type { CommitCorpusEntry, CoChangeView } from '../commit-mining'
import type { GraphReader } from '../graphs/graph-reader'
import type { RepoResolver } from '../resolvers/repo-resolver'
import type { LexicalProfile, PhorgeProjectConfig } from '../profiles/contracts'
import { matchGlob } from '../profiles/contracts'
import { NullLanguageProfile } from '../profiles/null-objects'
import {
  extractCandidateAnchors,
  resolveCandidateAnchors,
} from './prompt-symbol-extractor'
import {
  type TargetAnchor,
  type ExplicitExtractionResult,
  type TargetSourcingV2Result,
  type SingleSubjectResult,
  TargetAnchorSchema,
  canonicalKey,
} from './anchor-types'
import { retrieveFromCorpus, type CorpusRetrieverOpts } from './corpus-retriever'
import { retrieveLexical, type LexicalRetrieverOpts } from './lexical-retriever'
import { expandAnchors, type AnchorExpanderOpts } from './anchor-expander'
import { rankAnchors, type AnchorRankerOpts } from './anchor-ranker'
import { splitCompositionalPrompt } from './compositional-prompt'

// Per-subject cap when merging compositional results into the back-compat
// top-level anchor list — keeps neither subject from starving the other.
const PER_SUBJECT_MERGE_CAP = 8

export type PromptAnchorDeps = {
  resolver?: RepoResolver
  corpus?: CommitCorpusEntry[]
  coChangeView?: CoChangeView
  graphReader?: GraphReader
  /** Candidate files for lexical matching (path strings, repo-root relative). */
  allFiles?: string[]
  lexical?: LexicalProfile
  projectConfig?: PhorgeProjectConfig
}

export type PromptAnchorOpts = {
  retrieval?: CorpusRetrieverOpts
  lexical?: LexicalRetrieverOpts
  expansion?: AnchorExpanderOpts
  ranking?: AnchorRankerOpts
}

export type PromptAnchorInput = {
  /** Free-form user prompt: natural-language request, ticket title+body, etc. */
  promptText: string
  /** Optional structured criteria (acceptance criteria, requirement bullets). */
  acceptanceCriteria?: string[]
  deps: PromptAnchorDeps
  opts?: PromptAnchorOpts
}

export type PromptAnchorResult = TargetSourcingV2Result

export type { TargetSourcingV2Result, TargetAnchor } from './anchor-types'

type SymbolClassification = {
  confidence: 'high' | 'low'
  category: 'resolved_class' | 'resolved_method' | 'unresolved_class_method' | 'unresolved_method'
}

export function classifyExplicitSymbol(sym: string): SymbolClassification {
  if (sym.startsWith('class:')) return { confidence: 'high', category: 'resolved_class' }
  if (sym.startsWith('method:')) return { confidence: 'high', category: 'resolved_method' }
  if (sym.includes('::')) return { confidence: 'low', category: 'unresolved_class_method' }
  return { confidence: 'low', category: 'unresolved_method' }
}

export function extractAndResolve(
  promptText: string,
  acceptanceCriteria: string[],
  resolver?: RepoResolver,
): ExplicitExtractionResult {
  // Underlying extractor accepts (title, body, criteria) — fold prompt into title slot,
  // body empty, since regex pattern-matches across all three identically.
  const candidates = extractCandidateAnchors(promptText, '', acceptanceCriteria)

  if (!resolver) {
    const anchors: TargetAnchor[] = []
    for (const p of candidates.filePaths) {
      anchors.push({ kind: 'path', value: p, source: 'explicit', confidence: 'low', evidence: ['explicit: regex match, unverified'] })
    }
    for (const cn of candidates.classNames) {
      anchors.push({ kind: 'symbol', value: cn, source: 'explicit', confidence: 'low', evidence: ['explicit: regex match, unverified'] })
    }
    for (const ref of candidates.methodRefs) {
      anchors.push({ kind: 'symbol', value: ref, source: 'explicit', confidence: 'low', evidence: ['explicit: regex match, unverified'] })
    }
    return { anchors, unresolvedMentions: [] }
  }

  const resolved = resolveCandidateAnchors(candidates, resolver)
  const anchors: TargetAnchor[] = []

  for (const p of resolved.targetPaths) {
    anchors.push({ kind: 'path', value: p, source: 'explicit', confidence: 'high', evidence: [`explicit: resolved path ${p}`] })
  }

  for (const sym of resolved.targetSymbols) {
    const classified = classifyExplicitSymbol(sym)
    anchors.push({
      kind: 'symbol',
      value: sym,
      source: 'explicit',
      confidence: classified.confidence,
      evidence: [`explicit: ${classified.category}`],
    })
  }

  return { anchors, unresolvedMentions: resolved.unresolvedMentions }
}

function resolveOneSubject(
  promptText: string,
  acceptanceCriteria: string[],
  deps: PromptAnchorDeps,
  opts: PromptAnchorOpts | undefined,
): SingleSubjectResult {
  const explicit = extractAndResolve(promptText, acceptanceCriteria, deps.resolver)

  const corpus = deps.corpus
    ? retrieveFromCorpus(promptText, '', acceptanceCriteria, deps.corpus, opts?.retrieval)
    : null

  const lexicalProfile = deps.lexical ?? NullLanguageProfile.lexical
  const lexical = deps.allFiles && deps.allFiles.length > 0
    ? retrieveLexical(promptText, acceptanceCriteria, deps.allFiles, lexicalProfile, opts?.lexical)
    : null

  const merged = [...explicit.anchors, ...(corpus?.anchors ?? []), ...(lexical?.anchors ?? [])]
  const expansion = (deps.coChangeView || deps.graphReader)
    ? expandAnchors(merged, { coChangeView: deps.coChangeView, graphReader: deps.graphReader }, opts?.expansion)
    : null

  const allAnchors = [...merged, ...(expansion?.anchors ?? [])]
  const rankingOpts: AnchorRankerOpts = {
    ...(opts?.ranking ?? {}),
    graphReader: deps.graphReader ?? null,
    projectConfig: deps.projectConfig,
    promptText,
  }
  const rankedRaw = rankAnchors(allAnchors, rankingOpts)
  const ranked = applyProjectConfigToRanked(rankedRaw, deps.projectConfig)

  for (const a of ranked.anchors) {
    TargetAnchorSchema.parse(a)
  }

  return {
    version: 'v2',
    anchors: ranked.anchors,
    targetPaths: ranked.targetPaths,
    targetSymbols: ranked.targetSymbols,
    stages: { explicit, corpus, lexical, expansion, ranked },
  }
}

// Project-config post-processing applied AFTER ranking so user overrides win
// over heuristic ordering. alwaysExclude prunes; alwaysInclude force-injects;
// confidenceBoosts upgrade lexical/corpus signal classes for this repo only.
function applyProjectConfigToRanked(
  ranked: ReturnType<typeof rankAnchors>,
  config: PhorgeProjectConfig | undefined,
): ReturnType<typeof rankAnchors> {
  if (!config) return ranked

  const exclude = config.alwaysExclude ?? []
  const include = config.alwaysInclude ?? []
  const boosts = config.confidenceBoosts ?? []

  const matchesAny = (path: string, globs: string[]): boolean =>
    globs.some(g => matchGlob(g, path))

  let anchors = ranked.anchors.filter(a =>
    !(a.kind === 'path' && exclude.length > 0 && matchesAny(a.value, exclude)),
  )

  if (boosts.length > 0) {
    anchors = anchors.map(a => {
      const rule = boosts.find(b => b.source === a.source && b.from === a.confidence)
      if (!rule) return a
      return {
        ...a,
        confidence: rule.to,
        evidence: [...a.evidence, `project_config: confidence boosted ${rule.from}->${rule.to}`],
      }
    })
  }

  const have = new Set(anchors.filter(a => a.kind === 'path').map(a => a.value))
  const injected: TargetAnchor[] = []
  for (const path of include) {
    if (have.has(path)) continue
    injected.push({
      kind: 'path',
      value: path,
      source: 'project_config',
      confidence: 'high',
      evidence: [`project_config: alwaysInclude ${path}`],
    })
  }

  const finalAnchors = [...injected, ...anchors]
  const filteredPaths = ranked.targetPaths.filter(p => !matchesAny(p, exclude))
  const targetPaths = [
    ...injected.map(a => a.value),
    ...filteredPaths.filter(p => !injected.some(i => i.value === p)),
  ]

  return {
    ...ranked,
    anchors: finalAnchors,
    targetPaths,
  }
}

export function resolvePromptAnchors(input: PromptAnchorInput): PromptAnchorResult {
  const { promptText, acceptanceCriteria = [], deps, opts } = input

  const split = splitCompositionalPrompt(promptText)
  if (split.kind === 'single') {
    const single = resolveOneSubject(promptText, acceptanceCriteria, deps, opts)
    return { ...single, subjects: null }
  }

  const subjectResults = split.subjects.map(s => ({
    label: s.label,
    result: resolveOneSubject(s.promptText, acceptanceCriteria, deps, opts),
  }))

  // Merged top-level view: take top-N anchors from each subject (fairness cap),
  // then re-rank globally so back-compat consumers still see one ordered list.
  const seen = new Set<string>()
  const merged: TargetAnchor[] = []
  for (const sr of subjectResults) {
    let taken = 0
    for (const a of sr.result.anchors) {
      if (taken >= PER_SUBJECT_MERGE_CAP) break
      const key = canonicalKey(a.kind, a.value)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(a)
      taken++
    }
  }
  const reranked = rankAnchors(merged, opts?.ranking)

  // Top-level stages = first subject's stages (kept for back-compat shape);
  // detailed per-subject stages live under `subjects[i].result.stages`.
  const primary = subjectResults[0].result

  return {
    version: 'v2',
    anchors: reranked.anchors,
    targetPaths: reranked.targetPaths,
    targetSymbols: reranked.targetSymbols,
    stages: primary.stages,
    subjects: subjectResults,
  }
}
