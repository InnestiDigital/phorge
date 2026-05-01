import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBrief, renderBriefMarkdown } from '../src/cli/commands/brief'
import type { RepoSignals } from '../src/cli/corpus-cache'
import { laravelProfile } from '../src/profiles/laravel'

function makeSignals(repoRoot: string): RepoSignals {
  return {
    corpus: {
      schemaVersion: 1,
      repo: 'test',
      window: {},
      createdAt: new Date().toISOString(),
      filter: {} as never,
      stats: { totalConsidered: 10, kept: 5, excluded: {}, byIntent: {} },
      entries: [],
    } as RepoSignals['corpus'],
    coChange: {
      schemaVersion: 1,
      repo: 'test',
      window: {},
      createdAt: new Date().toISOString(),
      config: { minCoupling: 0.1, minJointCommits: 1, topK: 10, excludedPaths: 0 },
      all: {
        intentFilter: 'all',
        entries: [{
          path: 'app/Foo.php',
          commitCount: 4,
          neighbors: [{ path: 'tests/FooTest.php', jointCommits: 3, coupling: 0.75 }],
        }],
        stats: { anchors: 1, pairs: 1, commitsConsidered: 4 },
      },
      fix: { intentFilter: 'fix', entries: [], stats: { anchors: 0, pairs: 0, commitsConsidered: 0 } },
      feat: { intentFilter: 'feat', entries: [], stats: { anchors: 0, pairs: 0, commitsConsidered: 0 } },
    } as RepoSignals['coChange'],
    volatility: {
      schemaVersion: 1,
      repo: 'test',
      window: {},
      createdAt: new Date().toISOString(),
      asOf: new Date().toISOString(),
      weights: {} as never,
      stats: { totalEntries: 1, excludedPaths: 0, churnP95: 4, topRiskPathCount: 1, topRiskThreshold: 0.5 },
      entries: [{
        path: 'app/Foo.php',
        commitCount: 4,
        lineDeltaAdded: 100,
        lineDeltaDeleted: 50,
        firstTouchedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
        bugFixCommitCount: 2,
        bugFixDensity: 0.5,
        topAuthors: [],
        laravelVersionSpan: [],
        riskScore: 0.8,
        riskBreakdown: {} as never,
      }],
    } as RepoSignals['volatility'],
    reverts: {
      schemaVersion: 1,
      repo: 'test',
      window: {},
      createdAt: new Date().toISOString(),
      stats: {} as never,
      chains: [],
      pathStats: [],
    } as unknown as RepoSignals['reverts'],
    allFiles: ['app/Foo.php', 'tests/FooTest.php'],
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phorge-brief-'))
  mkdirSync(join(dir, 'app'), { recursive: true })
  writeFileSync(join(dir, 'app/Foo.php'), '<?php\nclass Foo {\n  public function bar() { return 1; }\n}\n')
  return dir
}

describe('buildBrief', () => {
  it('produces non-empty markdown with expected sections', () => {
    const repo = makeRepo()
    try {
      const brief = buildBrief({
        promptText: 'fix Foo bug',
        topN: 5,
        signals: makeSignals(repo),
        graphLoaded: false,
        repoPath: repo,
        profile: laravelProfile,
      })
      const md = renderBriefMarkdown(brief)
      expect(md).toContain('# Phorge Brief')
      expect(md).toContain('## Prompt')
      expect(md).toContain('fix Foo bug')
      expect(md).toContain('## Suggested files (ranked)')
      expect(md).toContain('## Co-change relationships')
      expect(md).toContain('## Volatility hints')
      expect(md).toContain('## Notes')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('JSON-serializable result has expected top-level keys', () => {
    const repo = makeRepo()
    try {
      const brief = buildBrief({
        promptText: 'fix Foo bug',
        topN: 5,
        signals: makeSignals(repo),
        graphLoaded: false,
        repoPath: repo,
        profile: laravelProfile,
      })
      const json = JSON.parse(JSON.stringify(brief))
      expect(json).toHaveProperty('prompt')
      expect(json).toHaveProperty('anchors')
      expect(json).toHaveProperty('symbols')
      expect(json).toHaveProperty('subgraph')
      expect(json).toHaveProperty('meta')
      expect(json.meta).toHaveProperty('graphLoaded', false)
      expect(json.meta).toHaveProperty('topN', 5)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
