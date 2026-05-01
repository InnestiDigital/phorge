export type CandidateAnchors = {
  filePaths: string[]
  classNames: string[]
  methodRefs: string[]
}

import type { RepoResolver } from '../resolvers/repo-resolver'
export type { RepoResolver }

export type TargetSymbolExtractionResult = {
  targetPaths: string[]
  targetSymbols: string[]
  unresolvedMentions: string[]
}

// PHP file path pattern: word chars, slashes, dots ending in .php
const FILE_PATH_RE = /(?:src|app|tests|database|routes|config)\/[\w\/.-]+\.php/g

// Namespaced class: two+ PascalCase segments separated by backslashes
const NAMESPACED_CLASS_RE = /(?:[A-Z][a-zA-Z0-9]*\\){2,}[A-Z][a-zA-Z0-9]*/g

// Single PascalCase word that looks like a class name (2+ chars, starts upper, has lower)
const CLASS_NAME_RE = /\b([A-Z][a-z][a-zA-Z0-9]{2,}(?:Controller|Service|Repository|Job|Event|Listener|Observer|Policy|Request|Resource|Transformer|Model|Exception|Interface|Trait|Test|Command|Handler|Factory|Seeder|Migration|Middleware|Guard|Step|Provider|Config|Manager|Builder|Validator|Rule|Notification|Mail|Cast|Scope)?)\b/g

// Class::method pattern
const STATIC_METHOD_RE = /\b([A-Z][a-zA-Z0-9]+)::([a-z][a-zA-Z0-9]+)/g

// ->method() pattern
const INSTANCE_METHOD_RE = /->([a-z][a-zA-Z0-9]+)\s*\(/g

// Common English words that look like PascalCase but aren't classes
const STOP_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'What',
  'Which', 'Should', 'Could', 'Would', 'Must', 'Will', 'Also',
  'After', 'Before', 'During', 'Between', 'About', 'Above', 'Below',
  'Into', 'Through', 'From', 'With', 'Without', 'Under', 'Over',
  'Each', 'Every', 'Some', 'Any', 'All', 'Both', 'Either', 'Neither',
  'Other', 'Another', 'Such', 'Only', 'Just', 'Very', 'Most', 'More',
  'Less', 'Few', 'Many', 'Much', 'However', 'Therefore', 'Because',
  'Since', 'While', 'Although', 'Though', 'Unless', 'Until', 'Once',
  'Here', 'There', 'Then', 'Now', 'Already', 'Still', 'Yet',
  'Update', 'Add', 'Fix', 'Remove', 'Change', 'Modify', 'Create',
  'Delete', 'Check', 'Verify', 'Ensure', 'Handle', 'Support',
  'Return', 'Set', 'Get', 'Make', 'Use', 'Need', 'Allow',
  'Enable', 'Disable', 'Include', 'Exclude', 'Implement',
])

export function extractCandidateAnchors(
  title: string,
  body: string,
  acceptanceCriteria: string[],
): CandidateAnchors {
  const allText = [title, body, ...acceptanceCriteria].join('\n')

  const filePaths = extractFilePaths(allText)
  const classNames = extractClassNames(allText)
  const methodRefs = extractMethodRefs(allText)

  return { filePaths, classNames, methodRefs }
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(FILE_PATH_RE) ?? []
  return [...new Set(matches)]
}

function extractClassNames(text: string): string[] {
  const names = new Set<string>()

  // Namespaced classes (highest confidence)
  for (const m of text.matchAll(NAMESPACED_CLASS_RE)) {
    names.add(m[0])
  }

  // Single PascalCase words with class-like suffixes
  for (const m of text.matchAll(CLASS_NAME_RE)) {
    const name = m[1]
    if (!STOP_WORDS.has(name) && !isLikelyEnglish(name)) {
      names.add(name)
    }
  }

  return [...names]
}

function isLikelyEnglish(word: string): boolean {
  // Short words without class-like suffixes are probably English
  if (word.length <= 4) return true
  // Words that are all uppercase are probably acronyms, not classes
  if (word === word.toUpperCase()) return true
  return false
}

function extractMethodRefs(text: string): string[] {
  const refs = new Set<string>()

  // Class::method
  for (const m of text.matchAll(STATIC_METHOD_RE)) {
    refs.add(`${m[1]}::${m[2]}`)
  }

  // ->method()
  for (const m of text.matchAll(INSTANCE_METHOD_RE)) {
    refs.add(m[1])
  }

  return [...refs]
}

export function resolveCandidateAnchors(
  candidates: CandidateAnchors,
  resolver: RepoResolver,
): TargetSymbolExtractionResult {
  const targetPaths = new Set<string>()
  const targetSymbols = new Set<string>()
  const unresolvedMentions: string[] = []

  // Resolve file paths
  for (const path of candidates.filePaths) {
    if (resolver.fileExists(path)) {
      targetPaths.add(path)
    } else {
      unresolvedMentions.push(path)
    }
  }

  // Resolve class names
  for (const className of candidates.classNames) {
    const file = resolver.findFileForClass(className)
    if (file) {
      targetPaths.add(file)
      targetSymbols.add(`class:${className}`)
    } else {
      unresolvedMentions.push(className)
    }
  }

  // Resolve method refs
  for (const ref of candidates.methodRefs) {
    if (ref.includes('::')) {
      const methodKey = resolver.findMethodKey(ref)
      if (methodKey) {
        targetSymbols.add(methodKey)
      } else {
        // Still useful as search query for graph reader
        targetSymbols.add(ref)
      }
    } else {
      // Bare method name — keep as search query
      targetSymbols.add(ref)
    }
  }

  return {
    targetPaths: [...targetPaths],
    targetSymbols: [...targetSymbols],
    unresolvedMentions,
  }
}

// ── History-aware anchor resolution ──

const HISTORY_NOISE_RE = /^(vendor\/|storage\/|bootstrap\/|node_modules\/|\.git\/|public\/|composer\.(json|lock)|package(-lock)?\.json|\.env|\.gitignore|phpunit\.xml|phpstan\.neon)/

export type HistoryResolutionOpts = {
  maxPaths?: number
}

export type HistoryResolutionResult = {
  targetPaths: string[]
  matchedCommits: number
}

export function resolveFromCommitHistory(
  ticketId: string,
  corpusEntries: Array<{ ticketId?: string; filesTouched: string[] }>,
  opts?: HistoryResolutionOpts,
): HistoryResolutionResult {
  const maxPaths = opts?.maxPaths ?? 30
  const normalizedTicket = ticketId.toUpperCase()

  const paths = new Set<string>()
  let matchedCommits = 0

  for (const entry of corpusEntries) {
    if (!entry.ticketId) continue
    if (entry.ticketId.toUpperCase() !== normalizedTicket) continue
    matchedCommits++
    for (const file of entry.filesTouched) {
      if (HISTORY_NOISE_RE.test(file)) continue
      paths.add(file)
    }
  }

  const sorted = [...paths].sort()
  return {
    targetPaths: sorted.slice(0, maxPaths),
    matchedCommits,
  }
}
