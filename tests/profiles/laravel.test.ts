import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laravelProfile } from '../../src/profiles/laravel'

describe('laravelProfile', () => {
  it('has the laravel id and a populated lexical profile', () => {
    expect(laravelProfile.id).toBe('laravel')
    expect(laravelProfile.lexical.synonymGroups.length).toBeGreaterThan(5)
    expect(laravelProfile.lexical.pathStopwords.has('controllers')).toBe(true)
  })

  it('fileScope matches .php files only', () => {
    expect(laravelProfile.fileScope.matches('app/Foo.php')).toBe(true)
    expect(laravelProfile.fileScope.matches('app/foo.ts')).toBe(false)
  })

  it('detector matches when composer.json declares laravel/framework', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phorge-laravel-'))
    try {
      writeFileSync(
        join(dir, 'composer.json'),
        JSON.stringify({ require: { 'laravel/framework': '^10.0' } }),
      )
      expect(await laravelProfile.detector.detect(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detector rejects directories without composer.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phorge-laravel-'))
    try {
      expect(await laravelProfile.detector.detect(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('testPaths emits Laravel Unit + Feature candidates', () => {
    const c = laravelProfile.testPaths.candidates('app/Services/PaymentService.php')
    expect(c).toContain('tests/Unit/Services/PaymentServiceTest.php')
    expect(c).toContain('tests/Feature/Services/PaymentServiceTest.php')
  })

  it('complexity analyzer returns AST counts for PHP', () => {
    const result = laravelProfile.complexity.analyze(
      'app/Foo.php',
      '<?php class Foo { public function bar() { if (true) { return 1; } return 2; } }',
    )
    expect(result).not.toBeNull()
    expect(result!.cyclomatic).toBeGreaterThanOrEqual(2)
    expect(result!.methodCount).toBeGreaterThanOrEqual(1)
  })

  it('complexity analyzer returns null for non-PHP files', () => {
    expect(laravelProfile.complexity.analyze('foo.ts', 'const x = 1')).toBeNull()
  })
})
