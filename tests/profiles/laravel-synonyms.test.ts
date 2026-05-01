import { describe, it, expect } from 'vitest'
import { expandSynonyms } from '../../src/profiles/laravel/synonyms'
import { stem } from '../../src/anchors/prompt-tokenizer'

const expand = (tokens: string[]) => new Set(expandSynonyms(tokens.map(stem)))

describe('laravel synonyms — persona split', () => {
  it('member does not expand into customer or account', () => {
    const out = expand(['member'])
    expect(out.has(stem('customer'))).toBe(false)
    expect(out.has(stem('account'))).toBe(false)
    expect(out.has(stem('user'))).toBe(false)
    expect(out.has(stem('profile'))).toBe(false)
  })

  it('customer does not expand into member', () => {
    const out = expand(['customer'])
    expect(out.has(stem('member'))).toBe(false)
    expect(out.has(stem('user'))).toBe(false)
    expect(out.has(stem('account'))).toBe(false)
  })

  it('user/account/profile do not expand into member or customer', () => {
    const out = expand(['user'])
    expect(out.has(stem('member'))).toBe(false)
    expect(out.has(stem('customer'))).toBe(false)
    expect(out.has(stem('account'))).toBe(true)
    expect(out.has(stem('profile'))).toBe(true)
    expect(out.has(stem('identity'))).toBe(true)
  })

  it('member still expands into auth-flow neighbors via login/session', () => {
    const out = expand(['member'])
    expect(out.has(stem('login'))).toBe(true)
    expect(out.has(stem('session'))).toBe(true)
    expect(out.has(stem('authenticate'))).toBe(true)
  })
})

describe('laravel synonyms — payment/billing/refund split', () => {
  it('payment does not expand into billing or refund', () => {
    const out = expand(['payment'])
    expect(out.has(stem('billing'))).toBe(false)
    expect(out.has(stem('invoice'))).toBe(false)
    expect(out.has(stem('refund'))).toBe(false)
    expect(out.has(stem('credit'))).toBe(false)
    expect(out.has(stem('voucher'))).toBe(false)
  })

  it('payment still expands into charge/transaction/checkout', () => {
    const out = expand(['payment'])
    expect(out.has(stem('charge'))).toBe(true)
    expect(out.has(stem('transaction'))).toBe(true)
    expect(out.has(stem('checkout'))).toBe(true)
  })

  it('refund expands into credit/voucher but not payment', () => {
    const out = expand(['refund'])
    expect(out.has(stem('credit'))).toBe(true)
    expect(out.has(stem('voucher'))).toBe(true)
    expect(out.has(stem('payment'))).toBe(false)
    expect(out.has(stem('billing'))).toBe(false)
  })

  it('billing expands into invoice but not payment or refund', () => {
    const out = expand(['billing'])
    expect(out.has(stem('invoice'))).toBe(true)
    expect(out.has(stem('payment'))).toBe(false)
    expect(out.has(stem('refund'))).toBe(false)
  })
})

describe('laravel synonyms — classic positive cases still work', () => {
  it('login expands into session/signin/auth', () => {
    const out = expand(['login'])
    expect(out.has(stem('session'))).toBe(true)
    expect(out.has(stem('signin'))).toBe(true)
    expect(out.has(stem('auth'))).toBe(true)
    expect(out.has(stem('jwt'))).toBe(true)
  })

  it('order expands into purchase/cart/basket', () => {
    const out = expand(['order'])
    expect(out.has(stem('purchase'))).toBe(true)
    expect(out.has(stem('cart'))).toBe(true)
    expect(out.has(stem('basket'))).toBe(true)
  })

  it('notification expands with email/mail but not alert/error', () => {
    const out = expand(['notification'])
    expect(out.has(stem('email'))).toBe(true)
    expect(out.has(stem('mail'))).toBe(true)
    expect(out.has(stem('alert'))).toBe(false)
    expect(out.has(stem('error'))).toBe(false)
  })
})
