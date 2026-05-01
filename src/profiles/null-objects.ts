import { extname } from 'node:path'
import type {
  FileScopeProvider,
  LexicalProfile,
  GraphScanner,
  GraphScanResult,
  ComplexityAnalyzer,
  AstComplexity,
  TestPathStrategy,
  ProfileDetector,
  LanguageProfile,
} from './contracts'

export const NullGraphScanner: GraphScanner = {
  promotionEdges: [],
  scan(_opts: { repoRoot: string }): GraphScanResult {
    return {
      nodes: [],
      edges: [],
      stats: {
        filesScanned: 0,
        parseErrors: 0,
        nodes: 0,
        edges: 0,
        perScanner: {},
      },
    }
  },
}

export const LocOnlyComplexityAnalyzer: ComplexityAnalyzer = {
  analyze(_filePath: string, _source: string): AstComplexity | null {
    return null
  },
}

export const GenericTestPathStrategy: TestPathStrategy = {
  candidates(sourcePath: string): readonly string[] {
    const ext = extname(sourcePath)
    if (!ext) return [`${sourcePath}.test`, `${sourcePath}.spec`]
    const base = sourcePath.slice(0, -ext.length)
    return [`${base}.test${ext}`, `${base}.spec${ext}`]
  },
  isTestPath(path: string): boolean {
    return /(?:^|\/)tests?\//.test(path) || /\.(test|spec)\.[a-z0-9]+$/i.test(path)
  },
}

const NEVER_DETECT: ProfileDetector = {
  async detect(_repoPath: string): Promise<boolean> {
    return false
  },
}

const GENERIC_IGNORE = ['node_modules', 'vendor', '.git', 'dist', 'build', '.phorge']

const NullFileScope: FileScopeProvider = {
  extensions: [],
  scanRoots: [],
  ignoreDirs: GENERIC_IGNORE,
  matches(_path: string): boolean {
    return false
  },
}

const GENERIC_PATH_STOP: ReadonlySet<string> = new Set([
  'src', 'lib', 'app', 'test', 'tests', 'spec',
])

const NullLexical: LexicalProfile = {
  synonymGroups: [],
  pathStopwords: GENERIC_PATH_STOP,
}

export const NullLanguageProfile: LanguageProfile = {
  id: 'null',
  name: 'Generic (no language profile detected)',
  fileScope: NullFileScope,
  lexical: NullLexical,
  detector: NEVER_DETECT,
  graph: NullGraphScanner,
  complexity: LocOnlyComplexityAnalyzer,
  testPaths: GenericTestPathStrategy,
}
