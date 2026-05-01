import { describe, it, expect } from 'vitest'
import { tokenize, retrieveFromCorpus } from '../src/anchors/corpus-retriever'
import type { CommitCorpusEntry } from '../src/commit-mining'

function makeEntry(overrides: Partial<CommitCorpusEntry> & { sha: string }): CommitCorpusEntry {
  return {
    sha: overrides.sha,
    parentSha: overrides.parentSha ?? 'parent0000',
    authorNickname: overrides.authorNickname ?? 'alice',
    authorEmail: overrides.authorEmail ?? 'alice@example.com',
    authorIsBot: false,
    committedAt: overrides.committedAt ?? '2026-01-15T00:00:00.000Z',
    subject: overrides.subject ?? 'feat: something',
    bodyDigest: overrides.bodyDigest ?? 'a'.repeat(64),
    filesTouched: overrides.filesTouched ?? [],
    additions: overrides.additions ?? 10,
    deletions: overrides.deletions ?? 2,
    intentCategory: overrides.intentCategory ?? 'feat',
    ticketId: overrides.ticketId,
  }
}

describe('tokenize', () => {
  it('lowercases all tokens', () => {
    const tokens = tokenize('AuthorizePayment')
    expect(tokens.every(t => t === t.toLowerCase())).toBe(true)
  })

  it('splits on whitespace', () => {
    const tokens = tokenize('fix checkout bug')
    expect(tokens).toContain('fix')
    expect(tokens).toContain('checkout')
    expect(tokens).toContain('bug')
  })

  it('splits on slashes', () => {
    const tokens = tokenize('src/Shop/Checkout/Steps')
    expect(tokens).toContain('shop')
    expect(tokens).toContain('checkout')
    expect(tokens).toContain('steps')
  })

  it('splits camelCase', () => {
    const tokens = tokenize('AuthorizePayment')
    expect(tokens).toContain('authorize')
    expect(tokens).toContain('payment')
  })

  it('splits on underscores and hyphens', () => {
    const tokens = tokenize('order_item point-bank')
    expect(tokens).toContain('order')
    expect(tokens).toContain('item')
    expect(tokens).toContain('point')
    expect(tokens).toContain('bank')
  })

  it('removes stopwords', () => {
    const tokens = tokenize('the class should return public static function')
    expect(tokens).not.toContain('the')
    expect(tokens).not.toContain('class')
    expect(tokens).not.toContain('return')
    expect(tokens).not.toContain('public')
    expect(tokens).not.toContain('static')
    expect(tokens).not.toContain('function')
  })

  it('filters tokens shorter than 3 chars', () => {
    const tokens = tokenize('a to be fix')
    expect(tokens).not.toContain('a')
    expect(tokens).not.toContain('to')
    expect(tokens).not.toContain('be')
    expect(tokens).toContain('fix')
  })

  it('strips .php extension from path segments', () => {
    const tokens = tokenize('OrderItem.php')
    expect(tokens).not.toContain('php')
    expect(tokens).toContain('order')
    expect(tokens).toContain('item')
  })

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([])
  })

  it('handles consecutive uppercase (acronyms)', () => {
    const tokens = tokenize('HTMLParser')
    expect(tokens).toContain('html')
    expect(tokens).toContain('parser')
  })
})

// ── retrieveFromCorpus ──

const baseCorpus: CommitCorpusEntry[] = [
  makeEntry({ sha: 'aaa1111', subject: 'feat: add checkout authorization step', filesTouched: ['src/Shop/Checkout/Steps/AuthorizePayment.php', 'src/Shop/Checkout/Steps/ValidateOrder.php'] }),
  makeEntry({ sha: 'bbb2222', subject: 'fix: checkout payment failure', filesTouched: ['src/Shop/Checkout/Steps/AuthorizePayment.php'] }),
  makeEntry({ sha: 'ccc3333', subject: 'feat: add user profile page', filesTouched: ['src/User/Profile/ProfileController.php', 'src/User/Profile/ProfileService.php'] }),
]

describe('retrieveFromCorpus — basic scoring', () => {
  it('returns anchors matching ticket text', () => {
    const result = retrieveFromCorpus('Fix checkout authorization', '', [], baseCorpus)
    expect(result.anchors.length).toBeGreaterThan(0)
    const paths = result.anchors.map(a => a.value)
    expect(paths).toContain('src/Shop/Checkout/Steps/AuthorizePayment.php')
  })

  it('ranks relevant paths higher than irrelevant ones', () => {
    const result = retrieveFromCorpus('Fix checkout authorization', '', [], baseCorpus)
    const paths = result.anchors.map(a => a.value)
    const checkoutIdx = paths.indexOf('src/Shop/Checkout/Steps/AuthorizePayment.php')
    const profileIdx = paths.indexOf('src/User/Profile/ProfileController.php')
    if (profileIdx >= 0) {
      expect(checkoutIdx).toBeLessThan(profileIdx)
    }
  })

  it('all anchors have source corpus_match', () => {
    const result = retrieveFromCorpus('Fix checkout', '', [], baseCorpus)
    for (const anchor of result.anchors) {
      expect(anchor.source).toBe('corpus_match')
      expect(anchor.kind).toBe('path')
    }
  })

  it('includes matched commit SHAs', () => {
    const result = retrieveFromCorpus('Fix checkout authorization', '', [], baseCorpus)
    expect(result.matchedCommitShas.length).toBeGreaterThan(0)
  })

  it('includes query tokens', () => {
    const result = retrieveFromCorpus('Fix checkout authorization', '', [], baseCorpus)
    expect(result.queryTokens).toContain('checkout')
    expect(result.queryTokens).toContain('authorization')
  })

  it('returns stats', () => {
    const result = retrieveFromCorpus('Fix checkout', '', [], baseCorpus)
    expect(result.stats.docsSeen).toBe(3)
    expect(result.stats.docsMatched).toBeGreaterThan(0)
    expect(result.stats.pathsConsidered).toBeGreaterThan(0)
  })
})

describe('retrieveFromCorpus — weighted path aggregation', () => {
  it('normalizes contribution by filesTouched count', () => {
    const corpus: CommitCorpusEntry[] = [
      makeEntry({ sha: 'aaa1111', subject: 'feat: checkout fix', filesTouched: ['src/A.php'] }),
      makeEntry({ sha: 'bbb2222', subject: 'feat: checkout refactor', filesTouched: Array.from({ length: 20 }, (_, i) => `src/File${i}.php`) }),
    ]
    const result = retrieveFromCorpus('checkout', '', [], corpus)
    const aAnchor = result.anchors.find(a => a.value === 'src/A.php')
    expect(aAnchor).toBeDefined()
    expect(aAnchor!.metadata?.supportCount).toBe(1)
  })
})

describe('retrieveFromCorpus — confidence assignment', () => {
  it('assigns high confidence when path has 2+ supporting commits and strong score above median', () => {
    const corpus: CommitCorpusEntry[] = [
      makeEntry({ sha: 'aaa1111', subject: 'feat: add checkout step', filesTouched: ['src/Checkout.php'] }),
      makeEntry({ sha: 'bbb2222', subject: 'fix: checkout validation', filesTouched: ['src/Checkout.php'] }),
      makeEntry({ sha: 'ccc3333', subject: 'feat: checkout refactor', filesTouched: ['src/Checkout.php'] }),
      // weak match — shares "checkout" but also has many unrelated files (dilutes weighted score)
      makeEntry({ sha: 'ddd4444', subject: 'chore: checkout config tweak', filesTouched: ['src/Config.php', 'src/Other1.php', 'src/Other2.php', 'src/Other3.php', 'src/Other4.php', 'src/Other5.php', 'src/Other6.php', 'src/Other7.php', 'src/Other8.php', 'src/Other9.php'] }),
    ]
    const result = retrieveFromCorpus('checkout', '', [], corpus)
    const anchor = result.anchors.find(a => a.value === 'src/Checkout.php')
    expect(anchor).toBeDefined()
    expect(anchor!.confidence).toBe('high')
    expect(anchor!.metadata?.supportCount).toBeGreaterThanOrEqual(2)
  })
})

describe('retrieveFromCorpus — noise filtering', () => {
  it('excludes noise paths', () => {
    const corpus: CommitCorpusEntry[] = [
      makeEntry({ sha: 'aaa1111', subject: 'feat: checkout', filesTouched: ['src/Checkout.php', 'database/factories/CheckoutFactory.php', 'database/migrations/2024_01_create.php'] }),
    ]
    const result = retrieveFromCorpus('checkout', '', [], corpus)
    const paths = result.anchors.map(a => a.value)
    expect(paths).not.toContain('database/factories/CheckoutFactory.php')
    expect(paths).not.toContain('database/migrations/2024_01_create.php')
  })
})

describe('retrieveFromCorpus — evidence and metadata', () => {
  it('includes evidence with commit SHA and score', () => {
    const corpus: CommitCorpusEntry[] = [
      makeEntry({ sha: 'aaa1111', subject: 'feat: checkout fix', filesTouched: ['src/Checkout.php'] }),
    ]
    const result = retrieveFromCorpus('checkout', '', [], corpus)
    const anchor = result.anchors[0]
    expect(anchor.evidence.length).toBeGreaterThan(0)
    expect(anchor.evidence[0]).toContain('corpus_match')
    expect(anchor.evidence[0]).toContain('aaa1111')
  })

  it('includes metadata with retrievalScore and supportCount', () => {
    const corpus: CommitCorpusEntry[] = [
      makeEntry({ sha: 'aaa1111', subject: 'feat: checkout fix', filesTouched: ['src/Checkout.php'] }),
    ]
    const result = retrieveFromCorpus('checkout', '', [], corpus)
    const anchor = result.anchors[0]
    expect(anchor.metadata).toBeDefined()
    expect(anchor.metadata!.retrievalScore).toBeDefined()
    expect(anchor.metadata!.supportCount).toBeDefined()
  })
})

describe('retrieveFromCorpus — empty/edge cases', () => {
  it('returns empty result for empty corpus', () => {
    const result = retrieveFromCorpus('checkout', '', [], [])
    expect(result.anchors).toHaveLength(0)
    expect(result.matchedCommitShas).toHaveLength(0)
    expect(result.stats.docsSeen).toBe(0)
  })

  it('returns empty result for empty query', () => {
    const corpus = [makeEntry({ sha: 'aaa1111', subject: 'feat: something', filesTouched: ['src/A.php'] })]
    const result = retrieveFromCorpus('', '', [], corpus)
    expect(result.anchors).toHaveLength(0)
  })

  it('respects topK option', () => {
    const corpus = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ sha: `sha${i}`.padEnd(7, '0'), subject: `feat: checkout item ${i}`, filesTouched: [`src/File${i}.php`] })
    )
    const result = retrieveFromCorpus('checkout', '', [], corpus, { topK: 3 })
    expect(result.matchedCommitShas.length).toBeLessThanOrEqual(3)
  })

  it('camelCase path segments match query tokens', () => {
    const corpus: CommitCorpusEntry[] = [
      makeEntry({ sha: 'aaa1111', subject: 'feat: something', filesTouched: ['src/Steps/AuthorizePayment.php'] }),
    ]
    const result = retrieveFromCorpus('authorize payment', '', [], corpus)
    expect(result.anchors.length).toBeGreaterThan(0)
  })
})
