import type { LanguageProfile } from '../contracts'
import { defaultRegistry } from '../registry'
import { laravelFileScope } from './file-scope'
import { laravelLexical } from './lexical'
import { laravelDetector } from './detector'
import { laravelGraphScanner } from './graph'
import { laravelComplexity } from './complexity'
import { laravelTestPaths } from './test-paths'

export const laravelProfile: LanguageProfile = {
  id: 'laravel',
  name: 'Laravel / PHP',
  fileScope: laravelFileScope,
  lexical: laravelLexical,
  detector: laravelDetector,
  graph: laravelGraphScanner,
  complexity: laravelComplexity,
  testPaths: laravelTestPaths,
}

defaultRegistry.register(laravelProfile)

export { laravelFileScope } from './file-scope'
export { laravelLexical } from './lexical'
export { laravelDetector } from './detector'
export { laravelGraphScanner } from './graph'
export { laravelComplexity } from './complexity'
export { laravelTestPaths } from './test-paths'
export { LARAVEL_SYNONYM_GROUPS, expandSynonyms, synonymsOf } from './synonyms'
export { scanLaravelProject } from './project-scanner'
export type { ScanResult, ScanStats } from './project-scanner'
