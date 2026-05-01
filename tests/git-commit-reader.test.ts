import { describe, it, expect } from 'vitest'
import {
  GitCommitReader,
  ProcessRunner,
  parseMetadataOutput,
  parseNumstatOutput,
} from '../src/commit-mining/git-commit-reader'

function record(fields: {
  sha: string
  parents?: string
  author?: string
  email?: string
  date?: string
  subject: string
  body?: string
}): string {
  return [
    fields.sha,
    fields.parents ?? 'p0000000',
    fields.author ?? 'alice',
    fields.email ?? 'alice@example.com',
    fields.date ?? '2026-02-01T10:00:00+00:00',
    fields.subject,
    fields.body ?? '',
  ].join('\u001f')
}

function metadataStream(records: string[]): string {
  return records.join('\u0000') + '\u0000'
}

describe('parseMetadataOutput', () => {
  it('parses a single commit record', () => {
    const out = parseMetadataOutput(
      metadataStream([
        record({
          sha: 'abc1234567890',
          subject: 'feat(checkout): guard',
          body: 'Detailed explanation.\nMore detail.',
        }),
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0].sha).toBe('abc1234567890')
    expect(out[0].subject).toBe('feat(checkout): guard')
    expect(out[0].body).toBe('Detailed explanation.\nMore detail.')
    expect(out[0].committedAt).toBe('2026-02-01T10:00:00.000Z')
  })

  it('handles multi-line bodies without truncation', () => {
    const body = 'line 1\nline 2\n\nline 4'
    const out = parseMetadataOutput(
      metadataStream([record({ sha: 'abcdef0000', subject: 'x', body })]),
    )
    expect(out[0].body).toBe(body)
  })

  it('parses multiple records separated by NULL', () => {
    const out = parseMetadataOutput(
      metadataStream([
        record({ sha: 'aaaaaaa0000', subject: 'one' }),
        record({ sha: 'bbbbbbb0000', subject: 'two' }),
        record({ sha: 'ccccccc0000', subject: 'three' }),
      ]),
    )
    expect(out.map((c) => c.sha)).toEqual(['aaaaaaa0000', 'bbbbbbb0000', 'ccccccc0000'])
  })

  it('splits multi-parent SHAs on whitespace', () => {
    const out = parseMetadataOutput(
      metadataStream([
        record({
          sha: 'merge12345',
          parents: 'aaa00000 bbb00000',
          subject: 'merge',
        }),
      ]),
    )
    expect(out[0].parentShas).toEqual(['aaa00000', 'bbb00000'])
  })

  it('emits empty parentShas on root commit', () => {
    const out = parseMetadataOutput(
      metadataStream([
        record({ sha: 'root123456', parents: '', subject: 'initial' }),
      ]),
    )
    expect(out[0].parentShas).toEqual([])
  })

  it('skips malformed records (too few fields)', () => {
    const malformed = ['abc1234567', 'partial-only'].join('\u001f')
    const out = parseMetadataOutput(malformed + '\u0000')
    expect(out).toEqual([])
  })

  it('skips records with unparseable committedAt', () => {
    const bad = record({
      sha: 'abcdef1234',
      date: 'not-a-date',
      subject: 'x',
    })
    const out = parseMetadataOutput(metadataStream([bad]))
    expect(out).toEqual([])
  })

  it('normalizes CRLF line endings in bodies to LF', () => {
    const out = parseMetadataOutput(
      metadataStream([
        record({ sha: 'abcdef1234', subject: 'x', body: 'line one\r\nline two\r\n' }),
      ]),
    )
    expect(out[0].body).toBe('line one\nline two')
  })

  it('ignores empty segments between NULLs', () => {
    const raw =
      record({ sha: 'abcdef1234', subject: 'x' }) + '\u0000\u0000' +
      record({ sha: 'ghijkl1234', subject: 'y' }) + '\u0000'
    const out = parseMetadataOutput(raw)
    expect(out.map((c) => c.sha)).toEqual(['abcdef1234', 'ghijkl1234'])
  })
})

describe('parseNumstatOutput', () => {
  it('parses a single commit numstat block', () => {
    const raw = [
      'CMabcdef1234',
      '10\t5\tapp/Foo.php',
      '2\t1\tapp/Bar.php',
    ].join('\n') + '\n'
    const map = parseNumstatOutput(raw)
    const entry = map.get('abcdef1234')
    expect(entry).toBeDefined()
    expect(entry?.files).toEqual(['app/Foo.php', 'app/Bar.php'])
    expect(entry?.additions).toBe(12)
    expect(entry?.deletions).toBe(6)
  })

  it('handles multiple commits separated by blank lines', () => {
    const raw = [
      'CMaaaaaaa0000',
      '1\t1\tapp/A.php',
      '',
      'CMbbbbbbb0000',
      '3\t2\tapp/B.php',
      '4\t0\tapp/C.php',
      '',
    ].join('\n')
    const map = parseNumstatOutput(raw)
    expect(map.get('aaaaaaa0000')?.files).toEqual(['app/A.php'])
    expect(map.get('bbbbbbb0000')?.files.sort()).toEqual(['app/B.php', 'app/C.php'])
    expect(map.get('bbbbbbb0000')?.additions).toBe(7)
  })

  it('treats - (binary) as 0 for additions/deletions', () => {
    const raw = ['CMabcdef1234', '-\t-\timages/logo.png'].join('\n') + '\n'
    const map = parseNumstatOutput(raw)
    const entry = map.get('abcdef1234')
    expect(entry?.additions).toBe(0)
    expect(entry?.deletions).toBe(0)
    expect(entry?.files).toEqual(['images/logo.png'])
  })

  it('returns empty map on empty input', () => {
    expect(parseNumstatOutput('')).toEqual(new Map())
  })

  it('ignores orphan numstat lines with no preceding CM marker', () => {
    const raw = ['1\t1\tapp/A.php', 'CMabcdef1234', '2\t2\tapp/B.php'].join('\n')
    const map = parseNumstatOutput(raw)
    expect(map.get('abcdef1234')?.files).toEqual(['app/B.php'])
    expect(Array.from(map.keys())).toEqual(['abcdef1234'])
  })

  it('handles tab characters inside file paths', () => {
    const raw =
      'CMabcdef1234\n5\t3\tweird\tpath with tab.php\n'
    const map = parseNumstatOutput(raw)
    expect(map.get('abcdef1234')?.files).toEqual(['weird\tpath with tab.php'])
  })
})

describe('GitCommitReader — end-to-end with mocked runner', () => {
  function runner(responses: Record<string, string>): {
    runner: ProcessRunner
    calls: Array<{ cmd: string; args: string[]; cwd: string }>
  } {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = []
    const r: ProcessRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd })
      const formatFlag = args.find((a) => a.startsWith('--format='))
      const format = formatFlag ? formatFlag.slice('--format='.length) : ''
      const key = args.includes('--numstat') ? 'numstat' : 'metadata'
      const stdout = responses[key] ?? ''
      void format
      return { stdout, stderr: '' }
    }
    return { runner: r, calls }
  }

  it('runs two git log calls (metadata + numstat) with repoRoot as cwd', async () => {
    const metadata = metadataStream([
      record({ sha: 'abc1234567890', subject: 'feat: x' }),
    ])
    const numstat = ['CMabc1234567890', '10\t5\tapp/Foo.php', ''].join('\n')
    const { runner: rn, calls } = runner({ metadata, numstat })
    const reader = new GitCommitReader({ runner: rn })
    const commits = await reader.readCommits({ repoRoot: '/tmp/repo' })
    expect(commits).toHaveLength(1)
    expect(commits[0].sha).toBe('abc1234567890')
    expect(commits[0].filesTouched).toEqual(['app/Foo.php'])
    expect(commits[0].additions).toBe(10)
    expect(commits[0].deletions).toBe(5)

    expect(calls).toHaveLength(2)
    expect(calls[0].cmd).toBe('git')
    expect(calls[0].cwd).toBe('/tmp/repo')
    expect(calls.every((c) => c.args.includes('log'))).toBe(true)
    expect(calls.every((c) => c.args.includes('--first-parent'))).toBe(true)
    const flagSets = calls.map((c) => c.args.includes('--numstat'))
    expect(flagSets.sort()).toEqual([false, true])
  })

  it('propagates since/until to both git log calls', async () => {
    const { runner: rn, calls } = runner({ metadata: '', numstat: '' })
    const reader = new GitCommitReader({ runner: rn })
    await reader.readCommits({
      repoRoot: '/tmp/repo',
      since: '2025-01-01T00:00:00.000Z',
      until: '2026-01-01T00:00:00.000Z',
    })
    for (const call of calls) {
      expect(call.args).toContain('--since=2025-01-01T00:00:00.000Z')
      expect(call.args).toContain('--until=2026-01-01T00:00:00.000Z')
    }
  })

  it('merges metadata with numstat by sha', async () => {
    const metadata = metadataStream([
      record({ sha: 'aaaaaaa0000', subject: 'a' }),
      record({ sha: 'bbbbbbb0000', subject: 'b' }),
    ])
    const numstat = [
      'CMaaaaaaa0000',
      '1\t0\tapp/A.php',
      '',
      'CMbbbbbbb0000',
      '5\t2\tapp/B.php',
      '',
    ].join('\n')
    const { runner: rn } = runner({ metadata, numstat })
    const reader = new GitCommitReader({ runner: rn })
    const commits = await reader.readCommits({ repoRoot: '/tmp/repo' })
    const byId = Object.fromEntries(commits.map((c) => [c.sha, c]))
    expect(byId['aaaaaaa0000'].filesTouched).toEqual(['app/A.php'])
    expect(byId['bbbbbbb0000'].filesTouched).toEqual(['app/B.php'])
  })

  it('emits commits without numstat as empty-touched / 0/0', async () => {
    const metadata = metadataStream([
      record({ sha: 'orphan1234x', subject: 'empty commit' }),
    ])
    const numstat = ''
    const { runner: rn } = runner({ metadata, numstat })
    const reader = new GitCommitReader({ runner: rn })
    const commits = await reader.readCommits({ repoRoot: '/tmp/repo' })
    expect(commits[0].filesTouched).toEqual([])
    expect(commits[0].additions).toBe(0)
    expect(commits[0].deletions).toBe(0)
  })

  it('propagates runner errors', async () => {
    const throwingRunner: ProcessRunner = async () => {
      throw new Error('git not found')
    }
    const reader = new GitCommitReader({ runner: throwingRunner })
    await expect(reader.readCommits({ repoRoot: '/tmp/repo' })).rejects.toThrow(
      /git not found/,
    )
  })
})
