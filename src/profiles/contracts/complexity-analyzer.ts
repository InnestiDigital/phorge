export type AstComplexity = {
  cyclomatic: number
  maxNesting: number
  methodCount: number
  longestMethodLines: number
}

export type ComplexityAnalyzer = {
  analyze(filePath: string, source: string): AstComplexity | null
}
