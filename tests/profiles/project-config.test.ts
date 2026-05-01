import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PhorgeProjectConfigSchema, matchGlob } from '../../src/profiles/contracts/project-config'
import { applyProjectConfig, loadProjectConfig, resolveProfile, createRegistry } from '../../src/profiles/registry'
import { NullLanguageProfile } from '../../src/profiles/null-objects'
import { resolvePromptAnchors } from '../../src/anchors/prompt-anchor-resolver'
import type { LanguageProfile } from '../../src/profiles/contracts'

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'phorge-cfg-'))
}

describe('PhorgeProjectConfigSchema', () => {
  it('accepts a minimal empty config', () => {
    expect(PhorgeProjectConfigSchema.parse({}).profileOverride).toBeUndefined()
  })

  it('rejects unknown keys (strict)', () => {
    expect(PhorgeProjectConfigSchema.safeParse({ bogus: 1 }).success).toBe(false)
  })

  it('rejects synonym groups with fewer than two members', () => {
    expect(
      PhorgeProjectConfigSchema.safeParse({ synonyms: [['solo']] }).success,
    ).toBe(false)
  })

  it('rejects empty pathRoles tags', () => {
    expect(
      PhorgeProjectConfigSchema.safeParse({
        pathRoles: [{ glob: 'app/**', tags: [] }],
      }).success,
    ).toBe(false)
  })

  it('rejects non-positive edgeWeight multipliers', () => {
    expect(
      PhorgeProjectConfigSchema.safeParse({
        edgeWeights: [{ edgeKind: 'x', whenPromptContains: ['y'], multiplier: 0 }],
      }).success,
    ).toBe(false)
  })

  it('accepts a fully populated config', () => {
    const r = PhorgeProjectConfigSchema.safeParse({
      profileOverride: 'laravel',
      synonyms: [['a', 'b']],
      pathStopwords: ['http'],
      pathRoles: [{ glob: 'app/**', tags: ['x'] }],
      edgeWeights: [{ edgeKind: 'dispatches_job', whenPromptContains: ['async'], multiplier: 1.2 }],
      alwaysInclude: ['app/X.php'],
      alwaysExclude: ['app/Legacy/**'],
      confidenceBoosts: [{ source: 'lexical', from: 'low', to: 'medium' }],
    })
    expect(r.success).toBe(true)
  })
})

describe('matchGlob', () => {
  it('matches **', () => {
    expect(matchGlob('app/Legacy/**', 'app/Legacy/Foo/Bar.php')).toBe(true)
    expect(matchGlob('app/Legacy/**', 'app/Other/Foo.php')).toBe(false)
  })

  it('matches single segment *', () => {
    expect(matchGlob('app/*.php', 'app/Foo.php')).toBe(true)
    expect(matchGlob('app/*.php', 'app/sub/Foo.php')).toBe(false)
  })

  it('matches exact path', () => {
    expect(matchGlob('app/Services/Foo.php', 'app/Services/Foo.php')).toBe(true)
  })
})

describe('loadProjectConfig', () => {
  it('returns undefined when no config present', () => {
    const dir = makeTmp()
    try {
      expect(loadProjectConfig(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers .phorge/config.json over phorge.config.json', () => {
    const dir = makeTmp()
    try {
      mkdirSync(join(dir, '.phorge'))
      writeFileSync(join(dir, '.phorge/config.json'), JSON.stringify({ profileOverride: 'a' }))
      writeFileSync(join(dir, 'phorge.config.json'), JSON.stringify({ profileOverride: 'b' }))
      expect(loadProjectConfig(dir)?.profileOverride).toBe('a')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to phorge.config.json at repo root', () => {
    const dir = makeTmp()
    try {
      writeFileSync(join(dir, 'phorge.config.json'), JSON.stringify({ profileOverride: 'b' }))
      expect(loadProjectConfig(dir)?.profileOverride).toBe('b')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined and warns on invalid config', () => {
    const dir = makeTmp()
    const errs: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    ;(process.stderr as any).write = (s: string) => { errs.push(s); return true }
    try {
      mkdirSync(join(dir, '.phorge'))
      writeFileSync(join(dir, '.phorge/config.json'), JSON.stringify({ bogus: 1 }))
      expect(loadProjectConfig(dir)).toBeUndefined()
      expect(errs.join('')).toMatch(/ignoring invalid/)
    } finally {
      process.stderr.write = orig
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined and warns on malformed JSON', () => {
    const dir = makeTmp()
    const orig = process.stderr.write.bind(process.stderr)
    ;(process.stderr as any).write = () => true
    try {
      mkdirSync(join(dir, '.phorge'))
      writeFileSync(join(dir, '.phorge/config.json'), '{not json')
      expect(loadProjectConfig(dir)).toBeUndefined()
    } finally {
      process.stderr.write = orig
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('applyProjectConfig', () => {
  const baseProfile: LanguageProfile = {
    ...NullLanguageProfile,
    lexical: {
      synonymGroups: [['orig', 'baseline']],
      pathStopwords: new Set(['app']),
    },
  }

  it('returns profile unchanged when no config', () => {
    expect(applyProjectConfig(baseProfile, undefined)).toBe(baseProfile)
  })

  it('concatenates synonym groups (additive, not replacing)', () => {
    const out = applyProjectConfig(baseProfile, {
      synonyms: [['foo', 'bar']],
    })
    expect(out.lexical.synonymGroups).toEqual([['orig', 'baseline'], ['foo', 'bar']])
  })

  it('unions path stopwords', () => {
    const out = applyProjectConfig(baseProfile, {
      pathStopwords: ['http', 'app'],
    })
    expect([...out.lexical.pathStopwords].sort()).toEqual(['app', 'http'])
  })

  it('attaches projectConfig to the profile', () => {
    const cfg = { synonyms: [['a', 'b']] as [string, string][] }
    const out = applyProjectConfig(baseProfile, cfg)
    expect(out.projectConfig).toEqual(cfg)
  })
})

describe('resolveProfile honors config.profileOverride', () => {
  it('uses config profileOverride when no caller override', async () => {
    const dir = makeTmp()
    try {
      mkdirSync(join(dir, '.phorge'))
      writeFileSync(join(dir, '.phorge/config.json'), JSON.stringify({ profileOverride: 'forced' }))
      const reg = createRegistry()
      const forced: LanguageProfile = { ...NullLanguageProfile, id: 'forced', name: 'forced' }
      reg.register(forced)
      const out = await resolveProfile({ repoPath: dir, registry: reg })
      expect(out.id).toBe('forced')
      expect(out.projectConfig?.profileOverride).toBe('forced')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caller override beats config override', async () => {
    const dir = makeTmp()
    try {
      mkdirSync(join(dir, '.phorge'))
      writeFileSync(join(dir, '.phorge/config.json'), JSON.stringify({ profileOverride: 'a' }))
      const reg = createRegistry()
      reg.register({ ...NullLanguageProfile, id: 'a', name: 'a' })
      reg.register({ ...NullLanguageProfile, id: 'b', name: 'b' })
      const out = await resolveProfile({ repoPath: dir, override: 'b', registry: reg })
      expect(out.id).toBe('b')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolvePromptAnchors applies projectConfig post-rank', () => {
  it('alwaysInclude force-injects an anchor with project_config source', () => {
    const result = resolvePromptAnchors({
      promptText: 'unrelated prompt about widgets',
      deps: {
        allFiles: ['app/Other.php'],
        projectConfig: { alwaysInclude: ['app/Services/RefundService.php'] },
      },
    })
    const inc = result.anchors.find(a => a.value === 'app/Services/RefundService.php')
    expect(inc).toBeDefined()
    expect(inc?.source).toBe('project_config')
    expect(inc?.confidence).toBe('high')
    expect(result.targetPaths[0]).toBe('app/Services/RefundService.php')
  })

  it('alwaysExclude removes a path from results', () => {
    // Synthesize an explicit anchor by mentioning the path in the prompt text
    const before = resolvePromptAnchors({
      promptText: 'fix app/Legacy/Old.php behavior',
      deps: { allFiles: ['app/Legacy/Old.php'] },
    })
    expect(before.anchors.some(a => a.value === 'app/Legacy/Old.php')).toBe(true)

    const after = resolvePromptAnchors({
      promptText: 'fix app/Legacy/Old.php behavior',
      deps: {
        allFiles: ['app/Legacy/Old.php'],
        projectConfig: { alwaysExclude: ['app/Legacy/**'] },
      },
    })
    expect(after.anchors.some(a => a.value === 'app/Legacy/Old.php')).toBe(false)
    expect(after.targetPaths).not.toContain('app/Legacy/Old.php')
  })

  it('confidenceBoosts upgrade matching source/from anchors', () => {
    const opts = { ranking: { minConfidence: 'low' as const } }
    // No allFiles — only the explicit regex extractor produces an anchor at
    // low confidence (no resolver to upgrade it).
    const before = resolvePromptAnchors({
      promptText: 'fix app/Foo.php',
      deps: {},
      opts,
    })
    const beforeAnchor = before.anchors.find(a => a.value === 'app/Foo.php')
    expect(beforeAnchor?.source).toBe('explicit')
    expect(beforeAnchor?.confidence).toBe('low')

    const after = resolvePromptAnchors({
      promptText: 'fix app/Foo.php',
      deps: {
        projectConfig: {
          confidenceBoosts: [{ source: 'explicit', from: 'low', to: 'high' }],
        },
      },
      opts,
    })
    const afterAnchor = after.anchors.find(a => a.value === 'app/Foo.php')
    expect(afterAnchor?.confidence).toBe('high')
    expect(afterAnchor?.evidence.some(e => e.includes('confidence boosted'))).toBe(true)
  })

  it('integration: alwaysInclude + synonyms + confidenceBoosts produce anchor delta', () => {
    const profile: LanguageProfile = {
      ...NullLanguageProfile,
      lexical: { synonymGroups: [], pathStopwords: new Set() },
    }
    const merged = applyProjectConfig(profile, {
      synonyms: [['refund', 'reimburse']],
    })
    // Synonym propagates: prompt mentions "reimburse", file path contains "refund"
    const result = resolvePromptAnchors({
      promptText: 'handle the reimburse flow',
      deps: {
        allFiles: ['app/Services/RefundProcessor.php', 'app/Services/Other.php'],
        lexical: merged.lexical,
        projectConfig: {
          synonyms: [['refund', 'reimburse']],
          alwaysInclude: ['app/Forced.php'],
          confidenceBoosts: [{ source: 'lexical', from: 'low', to: 'medium' }],
        },
      },
    })
    expect(result.anchors.some(a => a.value === 'app/Forced.php' && a.source === 'project_config')).toBe(true)
    // RefundProcessor surfaced via synonym expansion
    expect(result.anchors.some(a => a.value === 'app/Services/RefundProcessor.php')).toBe(true)
  })
})
