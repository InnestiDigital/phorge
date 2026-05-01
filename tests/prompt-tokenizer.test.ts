import { describe, it, expect } from 'vitest'
import { tokenizePrompt, stem } from '../src/anchors/prompt-tokenizer'

describe('stem', () => {
  it('strips common suffixes', () => {
    expect(stem('running')).toBe('runn')
    expect(stem('refunded')).toBe('refund')
    expect(stem('authentication')).toBe('authentic')
    expect(stem('quickly')).toBe('quick')
    expect(stem('policies')).toBe('policy')
  })

  it('leaves short words alone', () => {
    expect(stem('the')).toBe('the')
    expect(stem('go')).toBe('go')
  })
})

describe('tokenizePrompt', () => {
  it('drops stopwords and punctuation', () => {
    const out = tokenizePrompt('The auth thing is broken!!')
    expect(out).not.toContain('the')
    expect(out).not.toContain('thing')
    expect(out).not.toContain('is')
    expect(out).toContain('auth')
  })

  it('lowercases and stems content words', () => {
    const out = tokenizePrompt('Fixing the merchandise products syncing')
    // "fix" is in stopwords, so dropped
    expect(out).not.toContain('fix')
    expect(out).toContain('merchandise')
    expect(out).toContain('product')
    expect(out).toContain('sync')
  })

  it('returns empty for empty input', () => {
    expect(tokenizePrompt('')).toEqual([])
    expect(tokenizePrompt('the a is')).toEqual([])
  })

  it('handles natural-language vague prompts', () => {
    const out = tokenizePrompt('the auth thing the client mentioned')
    expect(out).toContain('auth')
    expect(out).toContain('client')
    expect(out).toContain('mention')
  })
})
