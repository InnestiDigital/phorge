import { describe, it, expect } from 'vitest'
import { classifyIntent, extractTicketId } from '../src/commit-mining/intent-classifier'

describe('classifyIntent — Conventional Commits prefix', () => {
  it('matches feat:', () => {
    const r = classifyIntent('feat: add new endpoint')
    expect(r.category).toBe('feat')
    expect(r.source).toBe('conventional')
  })

  it('matches fix(scope):', () => {
    const r = classifyIntent('fix(checkout): guard null rate')
    expect(r.category).toBe('fix')
    expect(r.conventionalScope).toBe('checkout')
    expect(r.source).toBe('conventional')
  })

  it('maps synonyms: bugfix/hotfix → fix', () => {
    expect(classifyIntent('bugfix: null pointer').category).toBe('fix')
    expect(classifyIntent('hotfix: urgent').category).toBe('fix')
  })
})

describe('classifyIntent — Bitbucket branch merge pattern', () => {
  it('classifies "Merged in bugfix/..." as fix', () => {
    const r = classifyIntent(
      'Merged in bugfix/v3.337.00/POD-14569_14584_2fa_fixes (pull request #8654)',
    )
    expect(r.category).toBe('fix')
  })

  it('classifies "Merged in hotfix/..." as fix', () => {
    const r = classifyIntent('Merged in hotfix/POD-9999_urgent_fix (pull request #1)')
    expect(r.category).toBe('fix')
  })

  it('classifies "Merged in feature/..." as feat', () => {
    const r = classifyIntent(
      'Merged in feature/POD-14550_update_floating_point_calculations (pull request #8651)',
    )
    expect(r.category).toBe('feat')
  })

  it('classifies "Merged in release/..." as chore', () => {
    const r = classifyIntent('Merged in release/v3.330.00 (pull request #8466)')
    expect(r.category).toBe('chore')
  })

  it('classifies "Merged in backmerge/..." as chore', () => {
    const r = classifyIntent('Merged in backmerge/v3.336.00 (pull request #8639)')
    expect(r.category).toBe('chore')
  })

  it('classifies "Merged in refactor/..." as refactor', () => {
    const r = classifyIntent('Merged in refactor/cleanup-auth (pull request #123)')
    expect(r.category).toBe('refactor')
  })

  it('is case-insensitive on Merged/bugfix', () => {
    expect(classifyIntent('merged in BugFix/whatever (pr #1)').category).toBe('fix')
  })
})

describe('classifyIntent — falls through to keyword cascade', () => {
  it('detects fix keyword', () => {
    expect(classifyIntent('Fixes POD-14270 retry logic').category).toBe('fix')
  })

  it('detects refactor keyword', () => {
    expect(classifyIntent('Refactor checkout step bindings').category).toBe('refactor')
  })

  it('falls back to other when nothing matches', () => {
    const r = classifyIntent('random subject no keywords at all abc xyz')
    expect(r.category).toBe('other')
    expect(r.source).toBe('fallback')
  })
})

describe('extractTicketId', () => {
  it('pulls POD-12345 from subject', () => {
    expect(extractTicketId('Fixes POD-12345 issue', '')).toBe('POD-12345')
  })

  it('falls back to body', () => {
    expect(extractTicketId('random', 'see POD-7 for context')).toBe('POD-7')
  })

  it('returns undefined when no ticket', () => {
    expect(extractTicketId('no ticket here', 'nor here')).toBeUndefined()
  })
})
