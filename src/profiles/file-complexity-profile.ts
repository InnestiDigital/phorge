import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { VolatilityEntry } from '../commit-mining/schema'
import type { RevertPathStat } from '../commit-mining/schema'
import type { ComplexityAnalyzer } from './contracts'
import { LocOnlyComplexityAnalyzer } from './null-objects'

export type FileComplexityProfile = {
  path: string
  lineCount: number
  commitCount: number
  bugFixDensity: number
  riskScore: number
  revertCount: number
  revertDensity: number
  refactorRisk: 'high' | 'medium' | 'low'
  refactorSignals: string[]
  cyclomatic?: number
  maxNesting?: number
  methodCount?: number
  longestMethodLines?: number
}

export type FileComplexityProfileDeps = {
  repoRoot: string
  volatilityEntries: VolatilityEntry[]
  revertStats: RevertPathStat[]
  complexityAnalyzer?: ComplexityAnalyzer
}

const LARGE_FILE_LINES = 300
const VERY_LARGE_FILE_LINES = 600
const HIGH_CHURN_COMMITS = 15
const HIGH_BUGFIX_DENSITY = 0.4
const HIGH_RISK_SCORE = 0.7
const REVERT_THRESHOLD = 1
const HIGH_CYCLOMATIC = 30
const DEEP_NESTING = 5
const VERY_LONG_METHOD = 100

export function buildFileComplexityProfile(
  path: string,
  deps: FileComplexityProfileDeps,
): FileComplexityProfile | null {
  const fullPath = resolve(deps.repoRoot, path)
  let lineCount: number
  let content: string
  try {
    content = readFileSync(fullPath, 'utf-8')
    lineCount = content.split('\n').length
  } catch {
    return null
  }

  let cyclomatic: number | undefined
  let maxNesting: number | undefined
  let methodCount: number | undefined
  let longestMethodLines: number | undefined
  const analyzer = deps.complexityAnalyzer ?? LocOnlyComplexityAnalyzer
  const ast = analyzer.analyze(path, content)
  if (ast) {
    cyclomatic = ast.cyclomatic
    maxNesting = ast.maxNesting
    methodCount = ast.methodCount
    longestMethodLines = ast.longestMethodLines
  }

  const volEntry = deps.volatilityEntries.find(e => e.path === path)
  const revEntry = deps.revertStats.find(e => e.path === path)

  const commitCount = volEntry?.commitCount ?? 0
  const bugFixDensity = volEntry?.bugFixDensity ?? 0
  const riskScore = volEntry?.riskScore ?? 0
  const revertCount = revEntry?.revertCount ?? 0
  const revertDensity = revEntry?.revertDensity ?? 0

  const signals: string[] = []

  if (lineCount >= VERY_LARGE_FILE_LINES) {
    signals.push(`very large file (${lineCount} lines)`)
  } else if (lineCount >= LARGE_FILE_LINES) {
    signals.push(`large file (${lineCount} lines)`)
  }

  if (commitCount >= HIGH_CHURN_COMMITS) {
    signals.push(`high churn (${commitCount} commits)`)
  }

  if (bugFixDensity >= HIGH_BUGFIX_DENSITY) {
    signals.push(`high bug-fix density (${(bugFixDensity * 100).toFixed(0)}%)`)
  }

  if (riskScore >= HIGH_RISK_SCORE) {
    signals.push(`high volatility risk (${riskScore.toFixed(2)})`)
  }

  if (revertCount >= REVERT_THRESHOLD) {
    signals.push(`reverted ${revertCount}x`)
  }

  if (cyclomatic !== undefined && cyclomatic > HIGH_CYCLOMATIC) {
    signals.push(`high cyclomatic complexity (${cyclomatic})`)
  }
  if (maxNesting !== undefined && maxNesting > DEEP_NESTING) {
    signals.push(`deep nesting (${maxNesting} levels)`)
  }
  if (longestMethodLines !== undefined && longestMethodLines > VERY_LONG_METHOD) {
    signals.push(`very long method (${longestMethodLines} lines)`)
  }

  let refactorRisk: 'high' | 'medium' | 'low' = 'low'
  const astSignalCount =
    (cyclomatic !== undefined && cyclomatic > HIGH_CYCLOMATIC ? 1 : 0) +
    (maxNesting !== undefined && maxNesting > DEEP_NESTING ? 1 : 0) +
    (longestMethodLines !== undefined && longestMethodLines > VERY_LONG_METHOD ? 1 : 0)
  if (signals.length >= 3 && lineCount >= LARGE_FILE_LINES) {
    refactorRisk = 'high'
  } else if (astSignalCount >= 2) {
    // multiple AST-level red flags = high risk regardless of LOC
    refactorRisk = 'high'
  } else if (signals.length >= 2) {
    refactorRisk = 'medium'
  } else if (astSignalCount >= 1 && signals.length >= 1) {
    refactorRisk = 'medium'
  }

  return {
    path,
    lineCount,
    commitCount,
    bugFixDensity,
    riskScore,
    revertCount,
    revertDensity,
    refactorRisk,
    refactorSignals: signals,
    cyclomatic,
    maxNesting,
    methodCount,
    longestMethodLines,
  }
}

export function formatComplexityHints(profiles: FileComplexityProfile[]): string {
  const risky = profiles.filter(p => p.refactorRisk !== 'low')

  // For non-risky single-file invocations, still emit AST summary so users see
  // cyclomatic / nesting / method counts even when no warnings fire.
  if (risky.length === 0) {
    const withAst = profiles.filter(p => p.cyclomatic !== undefined)
    if (withAst.length === 0) return ''
    const lines = ['## Complexity Profile']
    for (const p of withAst) {
      lines.push(
        `- \`${p.path}\` (${p.lineCount} lines): ` +
          `cyclomatic=${p.cyclomatic}, max-nesting=${p.maxNesting}, ` +
          `methods=${p.methodCount}, longest-method=${p.longestMethodLines} lines` +
          (p.refactorSignals.length ? ` — ${p.refactorSignals.join(', ')}` : ''),
      )
    }
    return lines.join('\n')
  }

  risky.sort((a, b) => {
    const riskOrder = { high: 2, medium: 1, low: 0 }
    return riskOrder[b.refactorRisk] - riskOrder[a.refactorRisk]
  })

  const lines = ['## Complexity Warnings']
  for (const p of risky) {
    const tag = p.refactorRisk === 'high' ? 'HIGH' : 'MEDIUM'
    const astBits: string[] = []
    if (p.cyclomatic !== undefined) astBits.push(`cyclomatic=${p.cyclomatic}`)
    if (p.maxNesting !== undefined) astBits.push(`max-nesting=${p.maxNesting}`)
    if (p.methodCount !== undefined) astBits.push(`methods=${p.methodCount}`)
    if (p.longestMethodLines !== undefined) astBits.push(`longest-method=${p.longestMethodLines}`)
    const astSuffix = astBits.length ? ` [${astBits.join(', ')}]` : ''
    lines.push(`- [${tag}] \`${p.path}\` (${p.lineCount} lines): ${p.refactorSignals.join(', ')}${astSuffix}`)
  }

  if (risky.some(p => p.refactorRisk === 'high')) {
    lines.push('')
    lines.push('For files marked HIGH: consider extracting responsibilities or decomposing before making changes. Large, high-churn, bug-heavy files are risky to patch in place.')
  }

  return lines.join('\n')
}
