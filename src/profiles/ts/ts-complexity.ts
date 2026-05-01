// AST-based complexity for TypeScript / JavaScript / Vue SFC.
// Cyclomatic = 1 + branching points. `??` is a real runtime branch (null check)
// so it counts the same as `||` and `&&`.

import { extname } from 'node:path'
import { Project, SyntaxKind, type Node, ScriptKind } from 'ts-morph'
import type { ComplexityAnalyzer, AstComplexity } from '../contracts'

const NESTING_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.TryStatement,
  SyntaxKind.CatchClause,
])

const FUNCTION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.FunctionExpression,
])

const VUE_SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi

function extractVueScript(source: string): string {
  const parts: string[] = []
  let m: RegExpExecArray | null
  while ((m = VUE_SCRIPT_RE.exec(source)) !== null) parts.push(m[1])
  return parts.join('\n')
}

export function analyzeTsComplexity(filePath: string, source: string): AstComplexity | null {
  const ext = extname(filePath).toLowerCase()
  let code = source
  let scriptKind: ScriptKind = ScriptKind.TS
  if (ext === '.vue') {
    code = extractVueScript(source)
    if (!code.trim()) return { cyclomatic: 1, maxNesting: 0, methodCount: 0, longestMethodLines: 0 }
  } else if (ext === '.tsx') {
    scriptKind = ScriptKind.TSX
  } else if (ext === '.jsx') {
    scriptKind = ScriptKind.JSX
  } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    scriptKind = ScriptKind.JS
  }

  let project: Project
  let sf
  try {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, noResolve: true },
    })
    const virtName = ext === '.vue' ? '__phorge__.ts'
      : ext ? `__phorge__${ext}` : '__phorge__.ts'
    sf = project.createSourceFile(virtName, code, { overwrite: true, scriptKind })
  } catch {
    return null
  }

  let cyclomatic = 1
  let maxNesting = 0
  let methodCount = 0
  let longestMethodLines = 0

  const visit = (node: Node, depth: number): void => {
    const kind = node.getKind()
    let nextDepth = depth
    if (NESTING_KINDS.has(kind)) {
      nextDepth = depth + 1
      if (nextDepth > maxNesting) maxNesting = nextDepth
    }

    switch (kind) {
      case SyntaxKind.IfStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.ConditionalExpression:
      case SyntaxKind.CatchClause:
        cyclomatic++
        break
      case SyntaxKind.CaseClause:
        cyclomatic++
        break
      case SyntaxKind.BinaryExpression: {
        const op = (node as any).getOperatorToken?.().getKind?.()
        if (
          op === SyntaxKind.AmpersandAmpersandToken
          || op === SyntaxKind.BarBarToken
          || op === SyntaxKind.QuestionQuestionToken
        ) cyclomatic++
        break
      }
    }

    if (FUNCTION_KINDS.has(kind)) {
      methodCount++
      const start = node.getStartLineNumber(true)
      const end = node.getEndLineNumber()
      const lines = Math.max(0, end - start + 1)
      if (lines > longestMethodLines) longestMethodLines = lines
    }

    for (const child of node.getChildren()) visit(child, nextDepth)
  }

  try {
    visit(sf, 0)
  } catch {
    return null
  }

  return { cyclomatic, maxNesting, methodCount, longestMethodLines }
}

export const tsComplexity: ComplexityAnalyzer = {
  analyze(filePath: string, source: string): AstComplexity | null {
    const ext = extname(filePath).toLowerCase()
    const supported = ['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.cjs']
    if (!supported.includes(ext)) return null
    try {
      return analyzeTsComplexity(filePath, source)
    } catch {
      return null
    }
  },
}
