import { describe, it, expect } from 'vitest'
import {
  CommitCorpusManifest,
  DEFAULT_FILTER_CONFIG,
  StaticCommitReader,
  buildCommitCorpus,
  classifyIntent,
  evaluateFilter,
  extractTicketId,
  isBotAuthor,
  isDependencyChurn,
  isDocsOnly,
  isMergeCommit,
  isNoiseSubject,
  type ParsedCommit,
} from '../src/commit-mining'

function commit(overrides: Partial<ParsedCommit> & { sha: string }): ParsedCommit {
  return {
    sha: overrides.sha,
    parentShas: overrides.parentShas ?? ['parent0000000'],
    authorNickname: overrides.authorNickname ?? 'alice',
    authorEmail: overrides.authorEmail ?? 'alice@example.com',
    committedAt: overrides.committedAt ?? '2026-02-01T10:00:00.000Z',
    subject: overrides.subject ?? 'feat(checkout): add idempotency guard',
    body: overrides.body ?? 'Detailed description.',
    filesTouched: overrides.filesTouched ?? ['app/Shop/Checkout/Step.php'],
    additions: overrides.additions ?? 50,
    deletions: overrides.deletions ?? 10,
  }
}

describe('classifyIntent', () => {
  it('recognizes Conventional Commits prefixes with scope', () => {
    const r = classifyIntent('feat(checkout): add idempotency guard')
    expect(r.category).toBe('feat')
    expect(r.conventionalScope).toBe('checkout')
    expect(r.source).toBe('conventional')
  })

  it('maps alias types (bugfix, feature, perf) to canonical categories', () => {
    expect(classifyIntent('bugfix: correct null handling').category).toBe('fix')
    expect(classifyIntent('feature(cart): add bulk add').category).toBe('feat')
    expect(classifyIntent('performance: speed up catalog').category).toBe('perf')
  })

  it('recognizes revert-prefix messages', () => {
    const r = classifyIntent('Revert "feat(checkout): add idempotency guard"')
    expect(r.category).toBe('revert')
    expect(r.source).toBe('revert_prefix')
  })

  it('falls back to keyword cascade for non-conventional messages', () => {
    expect(classifyIntent('Fix the crash when user is null').category).toBe('fix')
    expect(classifyIntent('Refactor the checkout step interface').category).toBe('refactor')
    expect(classifyIntent('Add tests for AuthorizePayment retry path').category).toBe('test')
    expect(classifyIntent('Update README with new setup instructions').category).toBe('docs')
    expect(classifyIntent('Speed up catalog search by caching').category).toBe('perf')
    expect(classifyIntent('Introduce new DiscountService').category).toBe('feat')
  })

  it("returns 'other' when nothing matches", () => {
    expect(classifyIntent('something').category).toBe('other')
    expect(classifyIntent('').category).toBe('other')
  })

  it('omits conventionalScope when commit has no parens', () => {
    const r = classifyIntent('chore: bump')
    expect(r.conventionalScope).toBeUndefined()
  })
})

describe('extractTicketId', () => {
  it('finds ticket ids in subject first', () => {
    expect(extractTicketId('FOR-42 feat(checkout): x', 'POD-7')).toBe('FOR-42')
  })
  it('falls back to body', () => {
    expect(extractTicketId('feat: x', 'see REACH-1234')).toBe('REACH-1234')
  })
  it('returns undefined for no match', () => {
    expect(extractTicketId('feat: x', 'no tickets here')).toBeUndefined()
  })
  it('does not match lowercase prefixes', () => {
    expect(extractTicketId('for-42', '')).toBeUndefined()
  })
})

describe('isBotAuthor', () => {
  it('flags known nicknames', () => {
    expect(isBotAuthor('dependabot', 'dep@example.com')).toBe(true)
    expect(isBotAuthor('renovate', 'r@example.com')).toBe(true)
  })
  it('flags [bot] and -bot suffixes', () => {
    expect(isBotAuthor('custom[bot]', 'c@example.com')).toBe(true)
    expect(isBotAuthor('ci-pusher-bot', 'c@example.com')).toBe(true)
  })
  it('flags bot email suffixes', () => {
    expect(isBotAuthor('name', '12345+dependabot[bot]@users.noreply.github.com')).toBe(true)
  })
  it('does not flag real humans', () => {
    expect(isBotAuthor('alice', 'alice@example.com')).toBe(false)
  })
})

describe('isMergeCommit / isNoiseSubject / isDocsOnly / isDependencyChurn', () => {
  it('detects merge commits via >1 parents', () => {
    expect(isMergeCommit(['a', 'b'])).toBe(true)
    expect(isMergeCommit(['a'])).toBe(false)
  })
  it('detects one-word noise subjects', () => {
    expect(isNoiseSubject('wip')).toBe(true)
    expect(isNoiseSubject('fix')).toBe(true)
    expect(isNoiseSubject('typo')).toBe(true)
    expect(isNoiseSubject('revert')).toBe(true)
    expect(isNoiseSubject('feat(x): real message')).toBe(false)
  })
  it('detects docs-only file sets', () => {
    expect(isDocsOnly(['README.md', 'docs/setup.md'])).toBe(true)
    expect(isDocsOnly(['README.md', 'app/Foo.php'])).toBe(false)
    expect(isDocsOnly([])).toBe(false)
  })
  it('detects dependency-churn-only file sets', () => {
    expect(isDependencyChurn(['composer.lock', 'package-lock.json'])).toBe(true)
    expect(isDependencyChurn(['vendor/foo/bar.php'])).toBe(true)
    expect(isDependencyChurn(['app/Foo.php', 'composer.lock'])).toBe(false)
    expect(isDependencyChurn([])).toBe(false)
  })
})

describe('evaluateFilter — exclusion reasons', () => {
  it('keeps a healthy commit', () => {
    const r = evaluateFilter(commit({ sha: 'a1234567890' }))
    expect(r.kept).toBe(true)
  })
  it('excludes merge commits', () => {
    const r = evaluateFilter(commit({ sha: 'a', parentShas: ['x', 'y'] }))
    expect(r.kept).toBe(false)
    if (!r.kept) expect(r.reason).toBe('merge_commit')
  })
  it('excludes bot-authored commits', () => {
    const r = evaluateFilter(
      commit({ sha: 'a', authorNickname: 'dependabot', authorEmail: 'd@example.com' }),
    )
    expect(r.kept).toBe(false)
    if (!r.kept) expect(r.reason).toBe('bot_author')
  })
  it('excludes one-word noise subjects', () => {
    const r = evaluateFilter(commit({ sha: 'a', subject: 'wip' }))
    expect(r.kept).toBe(false)
    if (!r.kept) expect(r.reason).toBe('noise_message')
  })
  it('excludes mega-file commits', () => {
    const files = Array.from({ length: 60 }, (_, i) => `app/F${i}.php`)
    const r = evaluateFilter(commit({ sha: 'a', filesTouched: files }))
    expect(r.kept).toBe(false)
    if (!r.kept) expect(r.reason).toBe('mega_file_count')
  })
  it('excludes mega-line commits', () => {
    const r = evaluateFilter(commit({ sha: 'a', additions: 1500, deletions: 700 }))
    expect(r.kept).toBe(false)
    if (!r.kept) expect(r.reason).toBe('mega_line_count')
  })
  it('excludes docs-only commits by default', () => {
    const r = evaluateFilter(commit({ sha: 'a', filesTouched: ['docs/x.md'] }))
    expect(r.kept).toBe(false)
    if (!r.kept) expect(r.reason).toBe('docs_only')
  })
  it('excludes dependency-churn commits by default', () => {
    const r = evaluateFilter(
      commit({ sha: 'a', filesTouched: ['composer.lock', 'package-lock.json'] }),
    )
    expect(r.kept).toBe(false)
    if (!r.kept) expect(r.reason).toBe('dependency_churn')
  })
  it('can be configured to keep docs-only and dependency churn', () => {
    const cfg = { ...DEFAULT_FILTER_CONFIG, excludeDocsOnly: false, excludeDependencyChurn: false }
    expect(evaluateFilter(commit({ sha: 'a', filesTouched: ['docs/x.md'] }), cfg).kept).toBe(true)
    expect(
      evaluateFilter(commit({ sha: 'a', filesTouched: ['composer.lock'] }), cfg).kept,
    ).toBe(true)
  })
})

describe('StaticCommitReader', () => {
  it('filters by since and until on committedAt', async () => {
    const reader = new StaticCommitReader([
      commit({ sha: 'a1', committedAt: '2025-01-01T00:00:00.000Z' }),
      commit({ sha: 'a2', committedAt: '2026-01-01T00:00:00.000Z' }),
      commit({ sha: 'a3', committedAt: '2026-06-01T00:00:00.000Z' }),
    ])
    const recent = await reader.readCommits({ repoRoot: '.', since: '2026-01-01T00:00:00.000Z' })
    expect(recent.map((c) => c.sha)).toEqual(['a2', 'a3'])
    const window = await reader.readCommits({
      repoRoot: '.',
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-03-01T00:00:00.000Z',
    })
    expect(window.map((c) => c.sha)).toEqual(['a2'])
  })
})

describe('buildCommitCorpus — orchestrator', () => {
  it('produces a schema-valid manifest from a mixed commit pool', async () => {
    const pool: ParsedCommit[] = [
      commit({ sha: 'a00000000001', subject: 'feat(checkout): add idempotency guard', additions: 60, deletions: 10 }),
      commit({ sha: 'a00000000002', subject: 'fix: handle null member in refund', additions: 20, deletions: 5 }),
      commit({ sha: 'a00000000003', subject: 'wip' }),
      commit({ sha: 'a00000000004', parentShas: ['x', 'y'], subject: 'merge thing' }),
      commit({ sha: 'a00000000005', authorNickname: 'dependabot', subject: 'bump dep' }),
      commit({ sha: 'a00000000006', filesTouched: ['README.md'] }),
      commit({ sha: 'a00000000007', filesTouched: ['composer.lock'] }),
      commit({ sha: 'a00000000008', subject: 'refactor(checkout): extract IdempotencyGuard service', body: 'FOR-42 delivers this.' }),
    ]
    const reader = new StaticCommitReader(pool)
    const manifest = await buildCommitCorpus({
      reader,
      repo: 'podium.api',
      repoRoot: '/tmp/fake',
      createdAt: '2026-04-22T00:00:00.000Z',
    })
    expect(CommitCorpusManifest.safeParse(manifest).success).toBe(true)
    expect(manifest.stats.totalConsidered).toBe(8)
    expect(manifest.stats.kept).toBe(3)
    expect(manifest.stats.excluded.noise_message).toBe(1)
    expect(manifest.stats.excluded.merge_commit).toBe(1)
    expect(manifest.stats.excluded.bot_author).toBe(1)
    expect(manifest.stats.excluded.docs_only).toBe(1)
    expect(manifest.stats.excluded.dependency_churn).toBe(1)
    expect(manifest.stats.byIntent.feat).toBe(1)
    expect(manifest.stats.byIntent.fix).toBe(1)
    expect(manifest.stats.byIntent.refactor).toBe(1)
  })

  it('attaches ticketId and conventionalScope when present', async () => {
    const reader = new StaticCommitReader([
      commit({
        sha: 'b00000000001',
        subject: 'feat(checkout): FOR-123 idempotency',
        body: 'Details.',
      }),
    ])
    const manifest = await buildCommitCorpus({
      reader,
      repo: 'podium.api',
      repoRoot: '/tmp/fake',
    })
    const entry = manifest.entries[0]
    expect(entry.ticketId).toBe('FOR-123')
    expect(entry.conventionalScope).toBe('checkout')
  })

  it('computes a deterministic sha256 bodyDigest', async () => {
    const reader = new StaticCommitReader([
      commit({ sha: 'c00000000001', body: 'alpha\nbeta\nco-authored-by: x <x@y>' }),
    ])
    const manifest = await buildCommitCorpus({
      reader,
      repo: 'podium.api',
      repoRoot: '/tmp/fake',
    })
    const digest = manifest.entries[0].bodyDigest
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    // Re-running produces the same digest
    const manifest2 = await buildCommitCorpus({
      reader,
      repo: 'podium.api',
      repoRoot: '/tmp/fake',
    })
    expect(manifest2.entries[0].bodyDigest).toBe(digest)
  })

  it('normalizes bodies (strips Signed-off-by / Co-Authored-By) before hashing', async () => {
    const readerA = new StaticCommitReader([
      commit({ sha: 'd00000000001', body: 'core change' }),
    ])
    const readerB = new StaticCommitReader([
      commit({
        sha: 'd00000000001',
        body: 'core change\n\nSigned-off-by: alice <a@x>\nCo-Authored-By: bot <b@x>',
      }),
    ])
    const mA = await buildCommitCorpus({ reader: readerA, repo: 'r', repoRoot: '.' })
    const mB = await buildCommitCorpus({ reader: readerB, repo: 'r', repoRoot: '.' })
    expect(mA.entries[0].bodyDigest).toBe(mB.entries[0].bodyDigest)
  })

  it('respects since/until window through the reader', async () => {
    const pool: ParsedCommit[] = [
      commit({ sha: 'e00000000001', committedAt: '2024-01-01T00:00:00.000Z', subject: 'feat: old one' }),
      commit({ sha: 'e00000000002', committedAt: '2026-01-01T00:00:00.000Z', subject: 'feat: recent' }),
    ]
    const reader = new StaticCommitReader(pool)
    const recent = await buildCommitCorpus({
      reader,
      repo: 'podium.api',
      repoRoot: '/tmp/fake',
      since: '2025-06-01T00:00:00.000Z',
    })
    expect(recent.stats.totalConsidered).toBe(1)
    expect(recent.entries[0].sha).toBe('e00000000002')
  })

  it('records stats.byIntent for every kept intent category', async () => {
    const reader = new StaticCommitReader([
      commit({ sha: 'f00000000001', subject: 'feat(x): add thing' }),
      commit({ sha: 'f00000000002', subject: 'feat(y): add another' }),
      commit({ sha: 'f00000000003', subject: 'fix: handle null' }),
      commit({ sha: 'f00000000004', subject: 'docs: update readme' }),
    ])
    const m = await buildCommitCorpus({ reader, repo: 'r', repoRoot: '.' })
    expect(m.stats.byIntent.feat).toBe(2)
    expect(m.stats.byIntent.fix).toBe(1)
    // docs-only file set would drop, but docs commits with a `feat`/`fix`
    // would survive; this one has subject `docs:` and default filesTouched
    // is non-docs, so it keeps.
    expect(m.stats.byIntent.docs).toBe(1)
  })

  it('throws when manifest output violates schema (defense in depth)', async () => {
    const badReader: import('../src/commit-mining').CommitReader = {
      async readCommits() {
        return [
          {
            sha: 'short',
            parentShas: [],
            authorNickname: '',
            authorEmail: '',
            committedAt: 'not-a-date',
            subject: 'feat: x',
            body: '',
            filesTouched: [],
            additions: 0,
            deletions: 0,
          },
        ]
      },
    }
    await expect(
      buildCommitCorpus({ reader: badReader, repo: 'r', repoRoot: '.' }),
    ).rejects.toThrow(/schema validation/)
  })
})
