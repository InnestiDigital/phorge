import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry, resolveProfile, defaultRegistry } from '../../src/profiles/registry'
import { NullLanguageProfile } from '../../src/profiles/null-objects'
import { laravelProfile } from '../../src/profiles/laravel'
import type { LanguageProfile } from '../../src/profiles/contracts'

function makeFakeProfile(id: string, detect: (r: string) => Promise<boolean>): LanguageProfile {
  return {
    id,
    name: id,
    fileScope: NullLanguageProfile.fileScope,
    lexical: NullLanguageProfile.lexical,
    detector: { detect },
    graph: NullLanguageProfile.graph,
    complexity: NullLanguageProfile.complexity,
    testPaths: NullLanguageProfile.testPaths,
  }
}

describe('ProfileRegistry', () => {
  it('registers and looks up profiles by id', () => {
    const reg = createRegistry()
    const p = makeFakeProfile('foo', async () => false)
    reg.register(p)
    expect(reg.byId('foo')).toBe(p)
    expect(reg.byId('missing')).toBeNull()
  })

  it('detect returns the first profile whose detector matches', async () => {
    const reg = createRegistry()
    const a = makeFakeProfile('a', async () => false)
    const b = makeFakeProfile('b', async () => true)
    reg.register(a)
    reg.register(b)
    expect(await reg.detect('/repo')).toBe(b)
  })

  it('detect returns null when no profile matches', async () => {
    const reg = createRegistry()
    reg.register(makeFakeProfile('x', async () => false))
    expect(await reg.detect('/repo')).toBeNull()
  })

  it('list returns all registered profiles', () => {
    const reg = createRegistry()
    reg.register(makeFakeProfile('a', async () => false))
    reg.register(makeFakeProfile('b', async () => false))
    expect(reg.list().map((p) => p.id).sort()).toEqual(['a', 'b'])
  })
})

describe('resolveProfile', () => {
  it('honors override id when provided', async () => {
    const reg = createRegistry()
    const p = makeFakeProfile('explicit', async () => false)
    reg.register(p)
    const resolved = await resolveProfile({ repoPath: '/x', override: 'explicit', registry: reg })
    expect(resolved).toBe(p)
  })

  it('returns NullLanguageProfile when override id is unknown', async () => {
    const reg = createRegistry()
    const resolved = await resolveProfile({ repoPath: '/x', override: 'nope', registry: reg })
    expect(resolved).toBe(NullLanguageProfile)
  })

  it('detects a profile when no override', async () => {
    const reg = createRegistry()
    const p = makeFakeProfile('hit', async () => true)
    reg.register(p)
    const resolved = await resolveProfile({ repoPath: '/x', registry: reg })
    expect(resolved).toBe(p)
  })

  it('falls back to NullLanguageProfile when nothing detects', async () => {
    const reg = createRegistry()
    reg.register(makeFakeProfile('miss', async () => false))
    const resolved = await resolveProfile({ repoPath: '/x', registry: reg })
    expect(resolved).toBe(NullLanguageProfile)
  })
})

describe('defaultRegistry has laravel registered', () => {
  it('exposes laravel by id', () => {
    expect(defaultRegistry.byId('laravel')).toBe(laravelProfile)
  })

  it('detects a Laravel composer.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phorge-detect-'))
    try {
      writeFileSync(
        join(dir, 'composer.json'),
        JSON.stringify({ require: { 'laravel/framework': '^10.0' } }),
      )
      const resolved = await resolveProfile({ repoPath: dir })
      expect(resolved).toBe(laravelProfile)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to null profile in a non-Laravel directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phorge-detect-'))
    try {
      const resolved = await resolveProfile({ repoPath: dir })
      expect(resolved).toBe(NullLanguageProfile)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
