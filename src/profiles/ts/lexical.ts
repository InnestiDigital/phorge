import type { LexicalProfile } from '../contracts'
import { TS_SYNONYM_GROUPS } from './synonyms'

const TS_PATH_STOP: ReadonlySet<string> = new Set([
  'components', 'composables', 'pages', 'server', 'stores', 'layouts',
  'middleware', 'routes', 'plugins', 'packages', 'src', 'app', 'lib',
  'types', 'utils', 'common', 'shared', 'helpers', 'internal',
])

export const tsLexical: LexicalProfile = {
  synonymGroups: TS_SYNONYM_GROUPS,
  pathStopwords: TS_PATH_STOP,
}
