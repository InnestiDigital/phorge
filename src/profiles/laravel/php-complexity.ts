// AST-based complexity for PHP files.
// Cyclomatic complexity = 1 + count of branching points.
// We count `??` because it introduces a runtime conditional path (null check),
// same as a ternary or `||` short-circuit — it's a real branch in execution.

import { parsePhpFile } from './php-parser'

export type PhpComplexity = {
  cyclomatic: number
  maxNesting: number
  methodCount: number
  longestMethodLines: number
}

const NESTING_KINDS = new Set([
  'if', 'while', 'do', 'for', 'foreach', 'switch', 'try', 'catch', 'match',
])

const FUNCTION_KINDS = new Set(['function', 'closure', 'method', 'arrowfunc'])

export function analyzePhpComplexity(source: string): PhpComplexity {
  const empty: PhpComplexity = {
    cyclomatic: 1,
    maxNesting: 0,
    methodCount: 0,
    longestMethodLines: 0,
  }

  let parseResult
  try {
    parseResult = parsePhpFile(source)
  } catch {
    return empty
  }

  const ast = parseResult.ast
  if (!ast || !Array.isArray(ast.children)) return empty

  let cyclomatic = 1
  let maxNesting = 0
  let methodCount = 0
  let longestMethodLines = 0

  const visit = (node: any, depth: number): void => {
    if (!node || typeof node !== 'object') return

    // Arrays are containers (e.g. body lists)
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth)
      return
    }

    const kind: string | undefined = node.kind
    if (!kind) return

    let nextDepth = depth

    if (NESTING_KINDS.has(kind)) {
      nextDepth = depth + 1
      if (nextDepth > maxNesting) maxNesting = nextDepth
    }

    switch (kind) {
      case 'if':
        cyclomatic++
        // `alternate` may be another `if` (elseif) or a block (else); recursion handles both
        break
      case 'while':
      case 'do':
      case 'for':
      case 'foreach':
        cyclomatic++
        break
      case 'case':
        // `default` cases have null `test` — don't count those
        if (node.test != null) cyclomatic++
        break
      case 'matcharm':
        // each non-default match arm is a branch
        if (node.conds != null) cyclomatic++
        break
      case 'catch':
        cyclomatic++
        break
      case 'retif':
        // ternary `? :`
        cyclomatic++
        break
      case 'bin': {
        const t = node.type
        if (t === '&&' || t === '||' || t === 'and' || t === 'or' || t === '??') {
          cyclomatic++
        }
        break
      }
    }

    if (FUNCTION_KINDS.has(kind)) {
      methodCount++
      const lines = methodBodyLines(node)
      if (lines > longestMethodLines) longestMethodLines = lines
    }

    // Walk all child properties generically.
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'kind' || key === 'leadingComments' || key === 'trailingComments') continue
      const val = node[key]
      if (val && typeof val === 'object') visit(val, nextDepth)
    }
  }

  try {
    for (const child of ast.children) visit(child, 0)
  } catch {
    return empty
  }

  return { cyclomatic, maxNesting, methodCount, longestMethodLines }
}

function methodBodyLines(node: any): number {
  const body = node.body
  if (body && body.loc?.start?.line && body.loc?.end?.line) {
    return Math.max(0, body.loc.end.line - body.loc.start.line + 1)
  }
  if (node.loc?.start?.line && node.loc?.end?.line) {
    return Math.max(0, node.loc.end.line - node.loc.start.line + 1)
  }
  return 0
}
