import { extname } from 'node:path'
import type { ComplexityAnalyzer, AstComplexity } from '../contracts'
import { analyzePhpComplexity } from './php-complexity'

export const laravelComplexity: ComplexityAnalyzer = {
  analyze(filePath: string, source: string): AstComplexity | null {
    if (extname(filePath).toLowerCase() !== '.php') return null
    try {
      return analyzePhpComplexity(source)
    } catch {
      return null
    }
  },
}
