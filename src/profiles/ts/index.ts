import type { LanguageProfile } from '../contracts'
import { defaultRegistry } from '../registry'
import { tsFileScope } from './file-scope'
import { tsLexical } from './lexical'
import { tsDetector } from './detector'
import { tsGraphScanner } from './scanner'
import { tsComplexity } from './ts-complexity'
import { tsTestPaths } from './test-paths'

export const tsProfile: LanguageProfile = {
  id: 'ts',
  name: 'TypeScript / Vue / Nuxt',
  fileScope: tsFileScope,
  lexical: tsLexical,
  detector: tsDetector,
  graph: tsGraphScanner,
  complexity: tsComplexity,
  testPaths: tsTestPaths,
}

defaultRegistry.register(tsProfile)

export { tsFileScope } from './file-scope'
export { tsLexical } from './lexical'
export { tsDetector } from './detector'
export { tsGraphScanner } from './scanner'
export { tsComplexity } from './ts-complexity'
export { tsTestPaths } from './test-paths'
export { TS_SYNONYM_GROUPS, expandSynonyms, synonymsOf } from './synonyms'
