import { describe, it, expect } from 'vitest'
import { expandSynonyms, synonymsOf } from '../src/anchors/laravel-synonyms'
import { stem } from '../src/anchors/prompt-tokenizer'

describe('expandSynonyms', () => {
  it('preserves originals', () => {
    const out = expandSynonyms(['auth'])
    expect(out).toContain('auth')
  })

  it('expands auth into login/session/credential family', () => {
    const out = new Set(expandSynonyms(['auth']))
    expect(out.has('login')).toBe(true)
    expect(out.has(stem('session'))).toBe(true)
    expect(out.has('credential')).toBe(true)
  })

  it('expands billing into invoice but not payment/refund', () => {
    const out = new Set(expandSynonyms([stem('billing')]))
    expect(out.has(stem('invoice'))).toBe(true)
    expect(out.has('payment')).toBe(false)
    expect(out.has('refund')).toBe(false)
    expect(out.has('charge')).toBe(false)
  })

  it('expands merchandise into product family', () => {
    const out = new Set(expandSynonyms([stem('merchandise')]))
    expect(out.has('product')).toBe(true)
    expect(out.has('item')).toBe(true)
    expect(out.has('sku')).toBe(true)
  })

  it('returns no synonyms for unknown tokens', () => {
    expect(synonymsOf('foobar')).toEqual([])
  })
})
