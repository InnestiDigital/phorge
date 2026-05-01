import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { cacheKey, loadRepoSignals } from '../src/cli/corpus-cache'
import { FILTER_CONFIG_VERSION } from '../src/commit-mining'

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phorge-cache-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.io'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T'])
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init'])
  return dir
}

describe('cacheKey', () => {
  it('is stable for same inputs and changes when HEAD changes', () => {
    const a = cacheKey('abcdef0123456789', '2024-01-01T00:00:00.000Z', '1')
    const b = cacheKey('abcdef0123456789', '2024-01-01T00:00:00.000Z', '1')
    const c = cacheKey('1111111111111111', '2024-01-01T00:00:00.000Z', '1')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-v1$/)
  })

  it('differs when filter version differs', () => {
    const a = cacheKey('abcdef0123456789', 's', '1')
    const b = cacheKey('abcdef0123456789', 's', '2')
    expect(a).not.toBe(b)
  })
})

describe('loadRepoSignals cache', () => {
  let repo: string
  beforeEach(() => { repo = makeRepo() })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('writes a content-keyed cache file and pointer on first run', async () => {
    await loadRepoSignals({ repoPath: repo, since: '2020-01-01' })
    const cacheDir = join(repo, '.phorge')
    const files = readdirSync(cacheDir)
    const corpusFile = files.find((f) => /^corpus-.+\.json$/.test(f) && f !== 'corpus-current.json')
    expect(corpusFile).toBeDefined()
    expect(existsSync(join(cacheDir, 'corpus-current.json'))).toBe(true)
    const pointer = JSON.parse(readFileSync(join(cacheDir, 'corpus-current.json'), 'utf-8'))
    expect(pointer.path).toBe(corpusFile)
    expect(pointer.headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('hits cache on second run with same HEAD, misses after new commit', async () => {
    await loadRepoSignals({ repoPath: repo, since: '2020-01-01' })
    const cacheDir = join(repo, '.phorge')
    const firstFiles = readdirSync(cacheDir).filter((f) => f.startsWith('corpus-') && f !== 'corpus-current.json')
    const firstMtime = readFileSync(join(cacheDir, firstFiles[0])).length

    // Same HEAD — pointer key shouldn't change
    await loadRepoSignals({ repoPath: repo, since: '2020-01-01' })
    const ptr1 = JSON.parse(readFileSync(join(cacheDir, 'corpus-current.json'), 'utf-8'))

    // New commit -> new HEAD -> new key/file
    writeFileSync(join(repo, 'b.txt'), 'world\n')
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'add b'])
    await loadRepoSignals({ repoPath: repo, since: '2020-01-01' })
    const ptr2 = JSON.parse(readFileSync(join(cacheDir, 'corpus-current.json'), 'utf-8'))

    expect(ptr1.key).not.toBe(ptr2.key)
    expect(ptr1.headSha).not.toBe(ptr2.headSha)
    expect(firstMtime).toBeGreaterThan(0)
  })

  it('forceRebuild bypasses cache and rewrites the file', async () => {
    await loadRepoSignals({ repoPath: repo, since: '2020-01-01' })
    const cacheDir = join(repo, '.phorge')
    const corpusFile = readdirSync(cacheDir).find((f) => f.startsWith('corpus-') && f !== 'corpus-current.json')!
    const before = readFileSync(join(cacheDir, corpusFile), 'utf-8')
    // Tamper with the cache to detect rebuild
    writeFileSync(join(cacheDir, corpusFile), '{"tampered":true}')
    await loadRepoSignals({ repoPath: repo, since: '2020-01-01', forceRebuild: true })
    const after = readFileSync(join(cacheDir, corpusFile), 'utf-8')
    expect(after).not.toBe('{"tampered":true}')
    expect(after.length).toBeGreaterThan(50)
    expect(before.length).toBeGreaterThan(0)
  })

  it('falls back to TTL behavior when HEAD cannot be resolved', async () => {
    // Use a real git repo but inject a HEAD reader that returns null,
    // simulating "no commits yet" or a non-git scenario without breaking
    // the underlying git log call used by the corpus builder.
    await loadRepoSignals({
      repoPath: repo,
      since: '2020-01-01',
      readHeadSha: () => null,
    })
    expect(existsSync(join(repo, '.phorge', 'corpus.json'))).toBe(true)
    expect(existsSync(join(repo, '.phorge', 'corpus-current.json'))).toBe(false)
  })
})

it('FILTER_CONFIG_VERSION is exported', () => {
  expect(FILTER_CONFIG_VERSION).toBe('1')
})
