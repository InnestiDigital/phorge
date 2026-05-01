import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../src/cli/commands/install-hooks'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'phorge-install-hooks-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('installHooks', () => {
  it('creates .husky/pre-commit with executable bit and phorge block', () => {
    const result = installHooks(repo)

    expect(result.created).toBe(true)
    expect(existsSync(result.hookPath)).toBe(true)

    const content = readFileSync(result.hookPath, 'utf-8')
    expect(content).toMatch(/#!\/usr\/bin\/env sh/)
    expect(content).toContain('phorge validate-plan')
    expect(content).toContain('PHORGE_SKIP_PRECOMMIT')
    expect(content).toContain('.phorge/pending-plan.txt')
    expect(content).toContain('>>> phorge pre-commit hook >>>')

    // Executable bit set (POSIX). Skip on platforms without chmod semantics.
    if (process.platform !== 'win32') {
      const mode = statSync(result.hookPath).mode & 0o777
      expect(mode & 0o111).not.toBe(0)
    }
  })

  it('is idempotent — re-running does not duplicate the phorge block', () => {
    installHooks(repo)
    const second = installHooks(repo)

    const content = readFileSync(second.hookPath, 'utf-8')
    const occurrences = content.match(/>>> phorge pre-commit hook >>>/g) ?? []
    expect(occurrences.length).toBe(1)
    expect(content).toContain('phorge validate-plan')
  })

  it('appends phorge block when .husky/pre-commit already exists with other content', () => {
    const huskyDir = join(repo, '.husky')
    mkdirSync(huskyDir, { recursive: true })
    const hookPath = join(huskyDir, 'pre-commit')
    const existing = '#!/usr/bin/env sh\n# user hook\nnpm test\n'
    writeFileSync(hookPath, existing, 'utf-8')

    const result = installHooks(repo)
    expect(result.appended).toBe(true)

    const content = readFileSync(result.hookPath, 'utf-8')
    expect(content).toContain('npm test')
    expect(content).toContain('phorge validate-plan')
    expect(content.indexOf('npm test')).toBeLessThan(content.indexOf('phorge validate-plan'))
  })
})
