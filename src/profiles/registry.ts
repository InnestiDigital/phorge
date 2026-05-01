import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageProfile, LexicalProfile, PhorgeProjectConfig } from './contracts'
import { PhorgeProjectConfigSchema } from './contracts'
import { NullLanguageProfile } from './null-objects'

export type ProfileRegistry = {
  register(profile: LanguageProfile): void
  byId(id: string): LanguageProfile | null
  detect(repoPath: string): Promise<LanguageProfile | null>
  list(): readonly LanguageProfile[]
}

export function createRegistry(): ProfileRegistry {
  const profiles = new Map<string, LanguageProfile>()
  return {
    register(profile) {
      profiles.set(profile.id, profile)
    },
    byId(id) {
      return profiles.get(id) ?? null
    },
    async detect(repoPath) {
      for (const profile of profiles.values()) {
        if (await profile.detector.detect(repoPath)) return profile
      }
      return null
    },
    list() {
      return [...profiles.values()]
    },
  }
}

export const defaultRegistry: ProfileRegistry = createRegistry()

export type ResolveProfileInput = {
  repoPath: string
  override?: string
  registry?: ProfileRegistry
}

const CONFIG_LOCATIONS = ['.phorge/config.json', 'phorge.config.json']

export function loadProjectConfig(repoPath: string): PhorgeProjectConfig | undefined {
  for (const rel of CONFIG_LOCATIONS) {
    const full = join(repoPath, rel)
    if (!existsSync(full)) continue
    try {
      const raw = JSON.parse(readFileSync(full, 'utf-8'))
      const parsed = PhorgeProjectConfigSchema.safeParse(raw)
      if (!parsed.success) {
        process.stderr.write(
          `phorge: ignoring invalid ${rel}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}\n`,
        )
        return undefined
      }
      return parsed.data
    } catch (err) {
      process.stderr.write(`phorge: ignoring unreadable ${rel}: ${(err as Error).message}\n`)
      return undefined
    }
  }
  return undefined
}

// Additive merge: profile groups + config groups concatenated. Stopwords as
// set union. We never replace profile defaults — config tunes, doesn't override.
export function applyProjectConfig(
  profile: LanguageProfile,
  config: PhorgeProjectConfig | undefined,
): LanguageProfile {
  if (!config) return profile
  const mergedLexical: LexicalProfile = {
    synonymGroups: [
      ...profile.lexical.synonymGroups,
      ...(config.synonyms ?? []),
    ],
    pathStopwords: new Set([
      ...profile.lexical.pathStopwords,
      ...(config.pathStopwords ?? []),
    ]),
  }
  return {
    ...profile,
    lexical: mergedLexical,
    projectConfig: config,
  }
}

export async function resolveProfile(input: ResolveProfileInput): Promise<LanguageProfile> {
  const reg = input.registry ?? defaultRegistry
  const config = loadProjectConfig(input.repoPath)

  // Config-declared profileOverride wins over auto-detect but yields to an
  // explicit caller override (e.g. CLI --lang).
  const overrideId = input.override ?? config?.profileOverride

  if (overrideId) {
    const explicit = reg.byId(overrideId)
    if (explicit) return applyProjectConfig(explicit, config)
    return applyProjectConfig(NullLanguageProfile, config)
  }
  const detected = await reg.detect(input.repoPath)
  return applyProjectConfig(detected ?? NullLanguageProfile, config)
}
