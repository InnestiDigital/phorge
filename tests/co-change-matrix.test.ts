import { describe, it, expect } from 'vitest'
import {
  CoChangeMatrixManifest,
  buildCoChangeMatrix,
  type CommitCorpusEntry,
  type CommitCorpusManifest,
} from '../src/commit-mining'

function entry(overrides: Partial<CommitCorpusEntry> & { sha: string }): CommitCorpusEntry {
  return {
    sha: overrides.sha,
    parentSha: overrides.parentSha ?? 'parent00000',
    authorNickname: overrides.authorNickname ?? 'alice',
    authorEmail: overrides.authorEmail ?? 'alice@example.com',
    authorIsBot: overrides.authorIsBot ?? false,
    committedAt: overrides.committedAt ?? '2026-02-01T10:00:00.000Z',
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

describe('buildCoChangeMatrix — basic shape', () => {
  it('produces a schema-valid manifest on empty corpus', () => {
    const m = buildCoChangeMatrix({ corpus: corpus([]) })
    expect(CoChangeMatrixManifest.safeParse(m).success).toBe(true)
    expect(m.all.entries).toHaveLength(0)
    expect(m.fix.entries).toHaveLength(0)
    expect(m.feat.entries).toHaveLength(0)
  })

  it('includes all three intent views in the output', () => {
    const m = buildCoChangeMatrix({ corpus: corpus([entry({ sha: 'a1' })]) })
    expect(m.all.intentFilter).toBe('all')
    expect(m.fix.intentFilter).toBe('fix')
    expect(m.feat.intentFilter).toBe('feat')
  })

  it('records config values in the manifest', () => {
    const m = buildCoChangeMatrix({
      corpus: corpus([]),
      minCoupling: 0.5,
      minJointCommits: 4,
      topK: 7,
    })
    expect(m.config.minCoupling).toBe(0.5)
    expect(m.config.minJointCommits).toBe(4)
    expect(m.config.topK).toBe(7)
  })
})

describe('buildCoChangeMatrix — pair counting', () => {
  it('computes coupling = joint / min(commits(a), commits(b))', () => {
    // 3 commits all touching [a, b] → joint=3, commits(a)=3, commits(b)=3 → coupling=1.0
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'c3', filesTouched: ['src/a.php', 'src/b.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    const a = m.all.entries.find((e) => e.path === 'src/a.php')!
    expect(a.commitCount).toBe(3)
    const neighbor = a.neighbors.find((n) => n.path === 'src/b.php')!
    expect(neighbor.jointCommits).toBe(3)
    expect(neighbor.coupling).toBe(1)
  })

  it('coupling is symmetric between pair', () => {
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'c3', filesTouched: ['src/a.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    const a = m.all.entries.find((e) => e.path === 'src/a.php')!
    const b = m.all.entries.find((e) => e.path === 'src/b.php')!
    const ab = a.neighbors.find((n) => n.path === 'src/b.php')!
    const ba = b.neighbors.find((n) => n.path === 'src/a.php')!
    expect(ab.jointCommits).toBe(2)
    expect(ba.jointCommits).toBe(2)
    // coupling = 2 / min(3, 2) = 1.0
    expect(ab.coupling).toBe(1)
    expect(ba.coupling).toBe(1)
  })

  it('handles three-file commits (enumerates all pairs)', () => {
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'src/b.php', 'src/c.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/a.php', 'src/b.php', 'src/c.php'] }),
      entry({ sha: 'c3', filesTouched: ['src/a.php', 'src/b.php', 'src/c.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    const a = m.all.entries.find((e) => e.path === 'src/a.php')!
    expect(a.neighbors).toHaveLength(2)
    expect(a.neighbors.every((n) => n.coupling === 1)).toBe(true)
  })
})

describe('buildCoChangeMatrix — thresholds', () => {
  it('drops pairs below minJointCommits', () => {
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/a.php', 'src/b.php'] }),
      // 3rd commit only touches a and c individually
      entry({ sha: 'c3', filesTouched: ['src/a.php'] }),
      entry({ sha: 'c4', filesTouched: ['src/a.php'] }),
      entry({ sha: 'c5', filesTouched: ['src/a.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 3,  // requires ≥ 3 joint
      minCoupling: 0,
    })
    const a = m.all.entries.find((e) => e.path === 'src/a.php')
    // a-b joint = 2 < 3, so pair dropped → no entry for a at all
    expect(a).toBeUndefined()
  })

  it('drops pairs below minCoupling', () => {
    // a appears in 10 commits, b only co-occurs in 3 of them
    // coupling(a,b) = 3 / min(10, 3) = 1.0 — actually that's high
    // need: joint low relative to both counts
    // a appears in 20, b appears in 10, joint = 3 → coupling = 3/10 = 0.3 exactly on threshold
    const entries: CommitCorpusEntry[] = []
    // 3 joint commits
    for (let i = 0; i < 3; i++) {
      entries.push(entry({ sha: `j${i}`, filesTouched: ['src/a.php', 'src/b.php'] }))
    }
    // 17 commits of a alone
    for (let i = 0; i < 17; i++) {
      entries.push(entry({ sha: `a${i}`, filesTouched: ['src/a.php'] }))
    }
    // 7 commits of b alone
    for (let i = 0; i < 7; i++) {
      entries.push(entry({ sha: `b${i}`, filesTouched: ['src/b.php'] }))
    }
    // coupling = 3 / min(20, 10) = 0.3
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0.5,  // pair should drop
    })
    const a = m.all.entries.find((e) => e.path === 'src/a.php')
    expect(a).toBeUndefined()
  })
})

describe('buildCoChangeMatrix — intent filters', () => {
  it('fix view uses only intent=fix commits', () => {
    const entries = [
      entry({ sha: 'f1', intentCategory: 'fix', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'f2', intentCategory: 'fix', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'f3', intentCategory: 'fix', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'x1', intentCategory: 'feat', filesTouched: ['src/c.php', 'src/d.php'] }),
      entry({ sha: 'x2', intentCategory: 'feat', filesTouched: ['src/c.php', 'src/d.php'] }),
      entry({ sha: 'x3', intentCategory: 'feat', filesTouched: ['src/c.php', 'src/d.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    expect(m.fix.entries.map((e) => e.path).sort()).toEqual(['src/a.php', 'src/b.php'])
    expect(m.feat.entries.map((e) => e.path).sort()).toEqual(['src/c.php', 'src/d.php'])
    expect(m.all.entries.map((e) => e.path).sort()).toEqual([
      'src/a.php',
      'src/b.php',
      'src/c.php',
      'src/d.php',
    ])
  })

  it('reports commitsConsidered per view', () => {
    const entries = [
      entry({ sha: 'f1', intentCategory: 'fix', filesTouched: ['a.php', 'b.php'] }),
      entry({ sha: 'x1', intentCategory: 'feat', filesTouched: ['a.php', 'b.php'] }),
      entry({ sha: 'x2', intentCategory: 'refactor', filesTouched: ['a.php', 'b.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    expect(m.all.stats.commitsConsidered).toBe(3)
    expect(m.fix.stats.commitsConsidered).toBe(1)
    expect(m.feat.stats.commitsConsidered).toBe(1)
  })
})

describe('buildCoChangeMatrix — path exclusion', () => {
  it('drops vendor/node_modules/docs/lockfile paths before counting', () => {
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'vendor/foo/bar.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/a.php', 'vendor/foo/bar.php'] }),
      entry({ sha: 'c3', filesTouched: ['src/a.php', 'vendor/foo/bar.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    const paths = m.all.entries.map((e) => e.path)
    expect(paths).not.toContain('vendor/foo/bar.php')
  })

  it('reports excluded paths in config', () => {
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'vendor/foo/bar.php'] }),
    ]
    const m = buildCoChangeMatrix({ corpus: corpus(entries) })
    expect(m.config.excludedPaths).toBeGreaterThan(0)
  })
})

describe('buildCoChangeMatrix — neighbor sort + topK', () => {
  it('sorts neighbors by coupling desc, joint desc, path asc', () => {
    // anchor 'src/a.php' is touched by 7 commits overall.
    //   b: commits(b)=3, joint=3 → coupling = 3/min(7,3) = 1.0
    //   e: commits(e)=3, joint=3 → coupling 1.0
    //   c: commits(c)=3, joint=3 → coupling 1.0
    //   d: commits(d)=2, joint=2 → coupling 2/min(7,2) = 1.0
    // All tie on coupling=1.0. Sort by joint desc (b=e=c=3 before d=2),
    // then path asc among joint=3 → b, c, e; d last.
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'src/b.php', 'src/e.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/a.php', 'src/b.php', 'src/e.php'] }),
      entry({ sha: 'c3', filesTouched: ['src/a.php', 'src/b.php', 'src/e.php', 'src/c.php'] }),
      entry({ sha: 'c4', filesTouched: ['src/a.php', 'src/d.php'] }),
      entry({ sha: 'c5', filesTouched: ['src/a.php', 'src/d.php'] }),
      entry({ sha: 'c6', filesTouched: ['src/a.php', 'src/c.php'] }),
      entry({ sha: 'c7', filesTouched: ['src/a.php', 'src/c.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    const a = m.all.entries.find((e) => e.path === 'src/a.php')!
    const neighbors = a.neighbors.map((n) => n.path)
    expect(neighbors).toEqual(['src/b.php', 'src/c.php', 'src/e.php', 'src/d.php'])
  })

  it('sorts purely by coupling when coupling values differ', () => {
    // a appears 10 times, b joint=10 → coupling 1.0
    // a with c joint=5 and c appears 10 times too → coupling 5/min(10,10) = 0.5
    const entries: CommitCorpusEntry[] = []
    for (let i = 0; i < 10; i++) {
      entries.push(entry({ sha: `ab${i}`, filesTouched: ['src/a.php', 'src/b.php'] }))
    }
    for (let i = 0; i < 5; i++) {
      entries.push(entry({ sha: `ac${i}`, filesTouched: ['src/a.php', 'src/c.php'] }))
    }
    for (let i = 0; i < 5; i++) {
      entries.push(entry({ sha: `c${i}`, filesTouched: ['src/c.php'] }))
    }
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    const a = m.all.entries.find((e) => e.path === 'src/a.php')!
    expect(a.neighbors[0].path).toBe('src/b.php')
    expect(a.neighbors[0].coupling).toBe(1)
    expect(a.neighbors[1].path).toBe('src/c.php')
    expect(a.neighbors[1].coupling).toBe(0.5)
  })

  it('caps neighbors per anchor at topK (default 10)', () => {
    const neighbors: string[] = []
    for (let i = 0; i < 15; i++) neighbors.push(`src/n${i.toString().padStart(2, '0')}.php`)
    const entries: CommitCorpusEntry[] = []
    for (let c = 0; c < 5; c++) {
      entries.push(entry({ sha: `c${c}`, filesTouched: ['src/anchor.php', ...neighbors] }))
    }
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
    })
    const anchor = m.all.entries.find((e) => e.path === 'src/anchor.php')!
    expect(anchor.neighbors.length).toBeLessThanOrEqual(10)
  })

  it('respects explicit topK override', () => {
    const neighbors: string[] = []
    for (let i = 0; i < 15; i++) neighbors.push(`src/n${i.toString().padStart(2, '0')}.php`)
    const entries: CommitCorpusEntry[] = []
    for (let c = 0; c < 5; c++) {
      entries.push(entry({ sha: `c${c}`, filesTouched: ['src/anchor.php', ...neighbors] }))
    }
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 1,
      minCoupling: 0,
      topK: 3,
    })
    const anchor = m.all.entries.find((e) => e.path === 'src/anchor.php')!
    expect(anchor.neighbors).toHaveLength(3)
  })
})

describe('buildCoChangeMatrix — determinism', () => {
  it('returns identical output for identical input', () => {
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'c3', filesTouched: ['src/a.php', 'src/b.php', 'src/c.php'] }),
    ]
    const a = buildCoChangeMatrix({ corpus: corpus(entries), minJointCommits: 1, minCoupling: 0 })
    const b = buildCoChangeMatrix({ corpus: corpus(entries), minJointCommits: 1, minCoupling: 0 })
    expect(JSON.stringify({ ...a, createdAt: '' })).toBe(JSON.stringify({ ...b, createdAt: '' }))
  })

  it('anchor entries sorted by path asc', () => {
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/z.php', 'src/a.php', 'src/m.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/z.php', 'src/a.php', 'src/m.php'] }),
      entry({ sha: 'c3', filesTouched: ['src/z.php', 'src/a.php', 'src/m.php'] }),
    ]
    const m = buildCoChangeMatrix({ corpus: corpus(entries), minJointCommits: 1, minCoupling: 0 })
    const paths = m.all.entries.map((e) => e.path)
    expect(paths).toEqual(['src/a.php', 'src/m.php', 'src/z.php'])
  })
})

describe('buildCoChangeMatrix — anchors with no qualifying neighbors', () => {
  it('omits paths whose only pairs fall below thresholds', () => {
    const entries = [
      entry({ sha: 'c1', filesTouched: ['src/a.php', 'src/b.php'] }),
      entry({ sha: 'c2', filesTouched: ['src/a.php'] }),
      entry({ sha: 'c3', filesTouched: ['src/a.php'] }),
    ]
    const m = buildCoChangeMatrix({
      corpus: corpus(entries),
      minJointCommits: 3,  // pair a-b has joint=1 < 3
      minCoupling: 0,
    })
    expect(m.all.entries).toHaveLength(0)
  })
})
