import type { FileScopeProvider } from './file-scope-provider'
import type { LexicalProfile } from './lexical-profile'
import type { GraphScanner } from './graph-scanner'
import type { ComplexityAnalyzer } from './complexity-analyzer'
import type { TestPathStrategy } from './test-path-strategy'
import type { ProfileDetector } from './profile-detector'
import type { PhorgeProjectConfig } from './project-config'

export type LanguageProfile = {
  readonly id: string
  readonly name: string
  readonly fileScope: FileScopeProvider
  readonly lexical: LexicalProfile
  readonly detector: ProfileDetector
  readonly graph: GraphScanner
  readonly complexity: ComplexityAnalyzer
  readonly testPaths: TestPathStrategy
  readonly projectConfig?: PhorgeProjectConfig
}
