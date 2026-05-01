import type { LexicalProfile } from '../contracts'
import { LARAVEL_SYNONYM_GROUPS } from './synonyms'

const LARAVEL_PATH_STOP: ReadonlySet<string> = new Set([
  'app', 'src', 'php', 'tests', 'test', 'http', 'controllers', 'controller', 'models', 'model',
])

export const laravelLexical: LexicalProfile = {
  synonymGroups: LARAVEL_SYNONYM_GROUPS,
  pathStopwords: LARAVEL_PATH_STOP,
}
