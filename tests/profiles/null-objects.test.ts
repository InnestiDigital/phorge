import { describe, it, expect } from 'vitest'
import {
  NullGraphScanner,
  LocOnlyComplexityAnalyzer,
  GenericTestPathStrategy,
  NullLanguageProfile,
} from '../../src/profiles/null-objects'

describe('NullGraphScanner', () => {
  it('returns an empty graph result', () => {
    const result = NullGraphScanner.scan({ repoRoot: '/x' })
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.stats.nodes).toBe(0)
    expect(result.stats.edges).toBe(0)
  })
})

describe('LocOnlyComplexityAnalyzer', () => {
  it('always returns null so callers fall back to LOC-only', () => {
    expect(LocOnlyComplexityAnalyzer.analyze('app/Foo.php', '<?php class Foo {}')).toBeNull()
    expect(LocOnlyComplexityAnalyzer.analyze('src/foo.ts', 'export const x = 1')).toBeNull()
  })
})

describe('GenericTestPathStrategy', () => {
  it('produces .test and .spec siblings for a source file', () => {
    const c = GenericTestPathStrategy.candidates('src/foo/bar.ts')
    expect(c).toContain('src/foo/bar.test.ts')
    expect(c).toContain('src/foo/bar.spec.ts')
  })

  it('detects files inside tests/ as test paths', () => {
    expect(GenericTestPathStrategy.isTestPath('tests/foo.spec.ts')).toBe(true)
    expect(GenericTestPathStrategy.isTestPath('test/foo.test.js')).toBe(true)
  })

  it('detects .test/.spec extensions as test paths', () => {
    expect(GenericTestPathStrategy.isTestPath('src/foo.test.ts')).toBe(true)
    expect(GenericTestPathStrategy.isTestPath('src/foo.spec.js')).toBe(true)
  })

  it('treats production files as non-test', () => {
    expect(GenericTestPathStrategy.isTestPath('src/foo.ts')).toBe(false)
  })
})

describe('NullLanguageProfile', () => {
  it('wires every capability to a null implementation', () => {
    expect(NullLanguageProfile.id).toBe('null')
    expect(NullLanguageProfile.fileScope.matches('any/path.ts')).toBe(false)
    expect(NullLanguageProfile.lexical.synonymGroups).toEqual([])
    expect(NullLanguageProfile.graph.scan({ repoRoot: '/' }).nodes).toEqual([])
    expect(NullLanguageProfile.complexity.analyze('a', 'b')).toBeNull()
  })

  it('detector never matches', async () => {
    expect(await NullLanguageProfile.detector.detect('/anything')).toBe(false)
  })
})
