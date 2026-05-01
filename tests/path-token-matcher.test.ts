import { describe, it, expect } from 'vitest'
import { matchPathsByTokens, tokenizePath } from '../src/anchors/path-token-matcher'

describe('tokenizePath', () => {
  it('splits camelCase + slashes + extensions', () => {
    const { all, filename } = tokenizePath('app/Http/Controllers/AuthController.php')
    expect(all).toContain('auth')
    expect(filename).toContain('auth')
    expect(filename).not.toContain('php')
  })

  it('handles dashes and snake_case', () => {
    const { all } = tokenizePath('app/services/payment-processor/refund_handler.php')
    expect(all).toContain('payment')
    expect(all).toContain('processor')
    expect(all).toContain('refund')
    expect(all).toContain('handl') // stem of handler
  })
})

describe('matchPathsByTokens', () => {
  const files = [
    'app/Http/Controllers/AuthController.php',
    'app/Http/Controllers/ProductController.php',
    'app/Services/Billing/ChargeService.php',
    'app/Models/User.php',
    'tests/Feature/AuthTest.php',
  ]

  it('scores filename matches higher than dir-only matches', () => {
    const matches = matchPathsByTokens(['auth'], files, new Set())
    expect(matches[0].path).toBe('app/Http/Controllers/AuthController.php')
    expect(matches[0].filenameMatches).toContain('auth')
  })

  it('returns empty when no tokens match', () => {
    expect(matchPathsByTokens(['nonexistent'], files, new Set())).toEqual([])
  })

  it('matches multiple tokens and accumulates score', () => {
    // Caller is expected to pass stemmed tokens (matches prompt-tokenizer output).
    const matches = matchPathsByTokens(['charge', 'bill'], files, new Set())
    expect(matches[0].path).toBe('app/Services/Billing/ChargeService.php')
    expect(matches[0].score).toBeGreaterThanOrEqual(3) // filename + dir hit
  })

  it('drops files below minScore', () => {
    const matches = matchPathsByTokens(['user'], files, new Set(), { minScore: 2 })
    // User.php filename match scores 2 (filenameBoost) — passes
    expect(matches.some(m => m.path === 'app/Models/User.php')).toBe(true)
  })
})
