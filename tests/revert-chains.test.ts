import { describe, it, expect } from 'vitest'
import {
  RevertChainsManifest,
  buildRevertChains,
  type CommitCorpusEntry,
  type CommitCorpusManifest,
} from '../src/commit-mining'

function entry(overrides: Partial<CommitCorpusEntry> & { sha: string }): CommitCorpusEntry {
  return {
    sha: overrides.sha.padEnd(10, '0'),
    parentSha: overrides.parentSha ?? 'parent0000',
    authorNickname: overrides.authorNickname ?? 'alice',
    authorEmail: overrides.authorEmail ?? 'alice@example.com',
    authorIsBot: overrides.authorIsBot ?? false,
    committedAt: overrides.committedAt ?? '2025-01-01T00:00:00.000Z',
    subject: overrides.subject ?? 'feat: something',
    bodyDigest: overrides.bodyDigest ?? 'a'.repeat(64),
    filesTouched: overrides.filesTouched ?? ['app/A.php'],
    additions: overrides.additions ?? 10,
    deletions: overrides.deletions ?? 2,
    intentCategory: overrides.intentCategory ?? 'feat',
    perFileDelta: overrides.perFileDelta,
    ticketId: overrides.ticketId,
    conventionalScope: overrides.conventionalScope,
  }
}

function corpus(entries: CommitCorpusEntry[]): CommitCorpusManifest {
  return {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-22T00:00:00.000Z',
    filter: {
      megaFileThreshold: 50,
      megaLineThreshold: 2000,
      excludeDocsOnly: true,
      excludeDependencyChurn: true,
      botNicknames: [],
      extraBotEmailSuffixes: [],
    },
    stats: { totalConsidered: entries.length, kept: entries.length, excluded: {}, byIntent: {} },
    entries,
  }
}

describe('buildRevertChains — schema shape', () => {
  it('validates empty corpus', () => {
    const m = buildRevertChains({ corpus: corpus([]) })
    expect(RevertChainsManifest.safeParse(m).success).toBe(true)
    expect(m.links).toHaveLength(0)
    expect(m.chains).toHaveLength(0)
    expect(m.pathStats).toHaveLength(0)
  })

  it('validates corpus without any reverts', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({ sha: 'abc1', intentCategory: 'feat' }),
        entry({ sha: 'abc2', intentCategory: 'fix' }),
      ]),
    })
    expect(m.stats.totalRevertCommits).toBe(0)
    expect(m.links).toHaveLength(0)
  })
})

describe('buildRevertChains — revert detection', () => {
  it('detects revert by intentCategory', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({ sha: 'rev1', intentCategory: 'revert', subject: 'custom revert message' }),
      ]),
    })
    expect(m.stats.totalRevertCommits).toBe(1)
  })

  it('detects revert by subject pattern even when intent differs', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({ sha: 'rev1', intentCategory: 'other', subject: 'Revert "feat: thing"' }),
      ]),
    })
    expect(m.stats.totalRevertCommits).toBe(1)
  })
})

describe('buildRevertChains — resolution by SHA mention', () => {
  it('resolves via "This reverts commit <sha>" in body', () => {
    // Body is not in corpus entry — we pass a separate bodies map to builder
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'abcdef1234',
          subject: 'feat: thing',
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'bbbbbbbb11',
          intentCategory: 'revert',
          subject: 'Revert "feat: thing"',
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
      ]),
      revertBodies: { bbbbbbbb11: 'This reverts commit abcdef1234.' },
    })
    expect(m.links).toHaveLength(1)
    expect(m.links[0].resolution).toBe('sha_mention')
    expect(m.links[0].revertedSha).toBe('abcdef1234')
    expect(m.links[0].daysToRevert).toBe(1)
  })

  it('accepts 7+ char prefix of SHA', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({ sha: 'abcdef1234567890', subject: 'orig' }),
        entry({
          sha: 'revert12',
          intentCategory: 'revert',
          subject: 'Revert "orig"',
        }),
      ]),
      revertBodies: { revert1200: 'This reverts commit abcdef1.' },
    })
    expect(m.links[0].resolution).toBe('sha_mention')
    expect(m.links[0].revertedSha).toBe('abcdef1234567890')
  })
})

describe('buildRevertChains — resolution by exact subject', () => {
  it('resolves when subject unambiguously matches', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'orig1',
          subject: 'feat: uniquely titled change',
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'rev1',
          intentCategory: 'revert',
          subject: 'Revert "feat: uniquely titled change"',
          committedAt: '2026-01-05T00:00:00.000Z',
        }),
      ]),
    })
    expect(m.links[0].resolution).toBe('exact_subject')
    expect(m.links[0].revertedSha).toBe('orig100000')
    expect(m.links[0].daysToRevert).toBe(4)
  })

  it('picks most recent pre-revert candidate when subject is ambiguous', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'early',
          subject: 'feat: reused subject',
          committedAt: '2025-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'late',
          subject: 'feat: reused subject',
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'rev1',
          intentCategory: 'revert',
          subject: 'Revert "feat: reused subject"',
          committedAt: '2026-02-01T00:00:00.000Z',
        }),
      ]),
    })
    expect(m.links[0].revertedSha).toBe('late000000')
  })

  it('marks unresolved when exact subject match has no pre-revert candidate', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'rev1',
          intentCategory: 'revert',
          subject: 'Revert "feat: ghost"',
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
      ]),
    })
    expect(m.links[0].resolution).toBe('unresolved')
    expect(m.links[0].revertedSha).toBeNull()
    expect(m.links[0].daysToRevert).toBeNull()
  })
})

describe('buildRevertChains — resolution by digest', () => {
  it('resolves when bodyDigest matches', () => {
    const SHARED_DIGEST = 'b'.repeat(64)
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'orig1',
          subject: 'something obscure',
          bodyDigest: SHARED_DIGEST,
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'rev1',
          intentCategory: 'revert',
          subject: 'revert by digest',
          bodyDigest: SHARED_DIGEST,
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
      ]),
    })
    expect(m.links[0].resolution).toBe('digest_match')
  })
})

describe('buildRevertChains — chains', () => {
  it('builds a simple original → revert chain', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({ sha: 'orig1', subject: 'feat: X', filesTouched: ['src/a.php'] }),
        entry({
          sha: 'rev1',
          intentCategory: 'revert',
          subject: 'Revert "feat: X"',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
      ]),
    })
    expect(m.chains).toHaveLength(1)
    expect(m.chains[0].commits).toHaveLength(2)
    expect(m.chains[0].commits[0].role).toBe('original')
    expect(m.chains[0].commits[1].role).toBe('revert')
    expect(m.chains[0].hasReapply).toBe(false)
    expect(m.chains[0].depth).toBe(2)
  })

  it('detects revert-of-revert as reapply and extends chain', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'orig1',
          subject: 'feat: thing',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'rev1',
          intentCategory: 'revert',
          subject: 'Revert "feat: thing"',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
        entry({
          sha: 'rev2',
          intentCategory: 'revert',
          subject: 'Revert "Revert "feat: thing""',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-03T00:00:00.000Z',
        }),
      ]),
    })
    expect(m.chains).toHaveLength(1)
    const chain = m.chains[0]
    expect(chain.commits.map((c) => c.role)).toEqual(['original', 'revert', 'reapply'])
    expect(chain.hasReapply).toBe(true)
    expect(chain.depth).toBe(3)
  })

  it('extends to another revert after reapply', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({ sha: 'c1', subject: 'feat: thing', committedAt: '2026-01-01T00:00:00.000Z' }),
        entry({
          sha: 'c2',
          intentCategory: 'revert',
          subject: 'Revert "feat: thing"',
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
        entry({
          sha: 'c3',
          intentCategory: 'revert',
          subject: 'Revert "Revert "feat: thing""',
          committedAt: '2026-01-03T00:00:00.000Z',
        }),
        entry({
          sha: 'c4',
          intentCategory: 'revert',
          subject: 'Revert "Revert "Revert "feat: thing"""',
          committedAt: '2026-01-04T00:00:00.000Z',
        }),
      ]),
    })
    expect(m.chains[0].commits.map((c) => c.role)).toEqual([
      'original',
      'revert',
      'reapply',
      'revert',
    ])
    expect(m.chains[0].depth).toBe(4)
  })

  it('does not build a chain when revert is unresolved', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'rev1',
          intentCategory: 'revert',
          subject: 'Revert "feat: ghost"',
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
      ]),
    })
    expect(m.chains).toHaveLength(0)
    expect(m.stats.unresolvedReverts).toBe(1)
  })
})

describe('buildRevertChains — path stats', () => {
  it('counts reverts per path from the original commit filesTouched', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'orig1',
          subject: 'feat: X',
          filesTouched: ['src/a.php', 'src/b.php'],
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'rev1',
          intentCategory: 'revert',
          subject: 'Revert "feat: X"',
          filesTouched: ['src/a.php', 'src/b.php'],
          committedAt: '2026-01-05T00:00:00.000Z',
        }),
      ]),
    })
    const a = m.pathStats.find((p) => p.path === 'src/a.php')!
    const b = m.pathStats.find((p) => p.path === 'src/b.php')!
    expect(a.revertCount).toBe(1)
    expect(b.revertCount).toBe(1)
    expect(a.lastRevertedAt).toBe('2026-01-05T00:00:00.000Z')
  })

  it('computes revertDensity = reverts / commits(path)', () => {
    const entries: CommitCorpusEntry[] = []
    // 10 commits on path a, 2 of which get reverted
    for (let i = 0; i < 10; i++) {
      entries.push(entry({ sha: `c${i}`, subject: `feat: item ${i}`, filesTouched: ['src/a.php'] }))
    }
    entries.push(
      entry({
        sha: 'rv1',
        intentCategory: 'revert',
        subject: 'Revert "feat: item 0"',
        filesTouched: ['src/a.php'],
        committedAt: '2026-02-01T00:00:00.000Z',
      }),
    )
    entries.push(
      entry({
        sha: 'rv2',
        intentCategory: 'revert',
        subject: 'Revert "feat: item 1"',
        filesTouched: ['src/a.php'],
        committedAt: '2026-02-02T00:00:00.000Z',
      }),
    )
    const m = buildRevertChains({ corpus: corpus(entries) })
    const a = m.pathStats.find((p) => p.path === 'src/a.php')!
    // commitCount counts ALL commits touching a (10 originals + 2 reverts = 12)
    expect(a.commitCount).toBe(12)
    expect(a.revertCount).toBe(2)
    expect(a.revertDensity).toBeCloseTo(2 / 12)
  })

  it('computes medianDaysToRevert across revert events', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'o1',
          subject: 'feat: one',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'r1',
          intentCategory: 'revert',
          subject: 'Revert "feat: one"',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
        entry({
          sha: 'o2',
          subject: 'feat: two',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'r2',
          intentCategory: 'revert',
          subject: 'Revert "feat: two"',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-11T00:00:00.000Z',
        }),
        entry({
          sha: 'o3',
          subject: 'feat: three',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
        entry({
          sha: 'r3',
          intentCategory: 'revert',
          subject: 'Revert "feat: three"',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-06T00:00:00.000Z',
        }),
      ]),
    })
    const a = m.pathStats.find((p) => p.path === 'src/a.php')!
    // daysToRevert: [1, 10, 5] → sorted [1,5,10] → median 5
    expect(a.medianDaysToRevert).toBe(5)
  })

  it('counts chainsInvolvingPath', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({ sha: 'o1', subject: 'feat: one', filesTouched: ['src/a.php'] }),
        entry({
          sha: 'r1',
          intentCategory: 'revert',
          subject: 'Revert "feat: one"',
          filesTouched: ['src/a.php'],
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
        entry({ sha: 'o2', subject: 'feat: two', filesTouched: ['src/a.php', 'src/b.php'] }),
        entry({
          sha: 'r2',
          intentCategory: 'revert',
          subject: 'Revert "feat: two"',
          filesTouched: ['src/a.php', 'src/b.php'],
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
      ]),
    })
    const a = m.pathStats.find((p) => p.path === 'src/a.php')!
    const b = m.pathStats.find((p) => p.path === 'src/b.php')!
    expect(a.chainsInvolvingPath).toBe(2)
    expect(b.chainsInvolvingPath).toBe(1)
  })

  it('excludes vendor/docs/lockfile paths from pathStats', () => {
    const m = buildRevertChains({
      corpus: corpus([
        entry({
          sha: 'o1',
          subject: 'feat: one',
          filesTouched: ['src/a.php', 'vendor/x/y.php'],
        }),
        entry({
          sha: 'r1',
          intentCategory: 'revert',
          subject: 'Revert "feat: one"',
          filesTouched: ['src/a.php', 'vendor/x/y.php'],
          committedAt: '2026-01-02T00:00:00.000Z',
        }),
      ]),
    })
    const paths = m.pathStats.map((p) => p.path)
    expect(paths).toContain('src/a.php')
    expect(paths).not.toContain('vendor/x/y.php')
    expect(m.stats.excludedPaths).toBeGreaterThan(0)
  })
})

describe('buildRevertChains — determinism', () => {
  it('produces stable output for same input', () => {
    const entries = [
      entry({ sha: 'o1', subject: 'feat: one', filesTouched: ['src/a.php'] }),
      entry({
        sha: 'r1',
        intentCategory: 'revert',
        subject: 'Revert "feat: one"',
        filesTouched: ['src/a.php'],
        committedAt: '2026-01-02T00:00:00.000Z',
      }),
    ]
    const a = buildRevertChains({ corpus: corpus(entries) })
    const b = buildRevertChains({ corpus: corpus(entries) })
    expect(JSON.stringify({ ...a, createdAt: '' })).toBe(JSON.stringify({ ...b, createdAt: '' }))
  })
})
