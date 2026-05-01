import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRulesFromDirs } from '../src/cli/rules-loader'

const VALID_FRONTMATTER = `---
id: rule-test-1
title: Test rule
state: approved
source: human
appliesTo:
  - validator
scope: {}
confidence: high
version: 1
rationale: Because we say so.
guidance: Do this thing carefully.
---

Rule body markdown.
`

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'phorge-rules-'))
}

describe('loadRulesFromDirs', () => {
  let dir: string
  let warn: ReturnType<typeof vi.fn>
  let origWrite: typeof process.stderr.write

  beforeEach(() => {
    dir = makeDir()
    warn = vi.fn(() => true)
    origWrite = process.stderr.write
    process.stderr.write = warn as unknown as typeof process.stderr.write
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    process.stderr.write = origWrite
  })

  it('loads a valid .mdc file', async () => {
    writeFileSync(join(dir, 'a.mdc'), VALID_FRONTMATTER)
    const rules = await loadRulesFromDirs([dir])
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('rule-test-1')
    expect(rules[0].appliesTo).toContain('validator')
  })

  it('skips .mdc with invalid frontmatter without throwing', async () => {
    writeFileSync(join(dir, 'good.mdc'), VALID_FRONTMATTER)
    writeFileSync(join(dir, 'bad.mdc'), '---\nid: only-id\n---\nbody\n')
    writeFileSync(join(dir, 'no-front.mdc'), 'just markdown\n')
    const rules = await loadRulesFromDirs([dir])
    expect(rules).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })

  it('recurses into subdirectories', async () => {
    const sub = join(dir, 'nested', 'deeper')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'r.mdc'), VALID_FRONTMATTER)
    writeFileSync(join(dir, 'ignore.txt'), 'not a rule')
    const rules = await loadRulesFromDirs([dir])
    expect(rules).toHaveLength(1)
  })

  it('returns [] when no rules dir is present', async () => {
    const missing = join(dir, 'does-not-exist')
    const rules = await loadRulesFromDirs([missing])
    expect(rules).toEqual([])
  })
})
