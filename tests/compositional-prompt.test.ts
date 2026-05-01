import { describe, it, expect } from 'vitest'
import { splitCompositionalPrompt } from '../src/anchors/compositional-prompt'
import { resolvePromptAnchors } from '../src/anchors/prompt-anchor-resolver'

describe('splitCompositionalPrompt — pattern detection', () => {
  it('detects "X vs Y"', () => {
    const out = splitCompositionalPrompt('refund pricing flow vs cancel order flow')
    expect(out.kind).toBe('compositional')
    if (out.kind !== 'compositional') return
    expect(out.subjects).toHaveLength(2)
    expect(out.subjects[0].label).toContain('refund')
    expect(out.subjects[1].label).toContain('cancel')
  })

  it('detects "X compared to Y"', () => {
    const out = splitCompositionalPrompt('member endpoints handler compared to admin endpoints surface')
    expect(out.kind).toBe('compositional')
  })

  it('detects "X against Y"', () => {
    const out = splitCompositionalPrompt('mcp server tools against member api endpoints')
    expect(out.kind).toBe('compositional')
  })

  it('detects "gaps in X vs Y"', () => {
    const out = splitCompositionalPrompt('gaps in mcp server tools vs member api endpoints')
    expect(out.kind).toBe('compositional')
    if (out.kind !== 'compositional') return
    expect(out.subjects[0].label).toMatch(/mcp/)
    expect(out.subjects[1].label).toMatch(/member/)
  })

  it('detects "differences between X and Y"', () => {
    const out = splitCompositionalPrompt('differences between order pricing flow and refund pricing flow')
    expect(out.kind).toBe('compositional')
  })

  it('detects long-form review-and-find-gaps prompt', () => {
    const out = splitCompositionalPrompt(
      'review the MCP servers implementation and identify gaps and bugs against the usual member endpoints handlers',
    )
    expect(out.kind).toBe('compositional')
    if (out.kind !== 'compositional') return
    expect(out.subjects[0].label).toMatch(/mcp/i)
    expect(out.subjects[1].label).toMatch(/member/i)
  })

  it('returns single for non-comparative prompts', () => {
    expect(splitCompositionalPrompt('fix refund flow').kind).toBe('single')
    expect(splitCompositionalPrompt('add new sale channel').kind).toBe('single')
    expect(splitCompositionalPrompt('').kind).toBe('single')
  })

  it('rejects splits where one side has fewer than 3 tokens', () => {
    // "X vs Y" with too-short sides → not compositional
    const out = splitCompositionalPrompt('foo vs bar')
    expect(out.kind).toBe('single')
  })

  it('produces distinct subject labels', () => {
    const out = splitCompositionalPrompt('mcp server tools vs member api endpoints')
    expect(out.kind).toBe('compositional')
    if (out.kind !== 'compositional') return
    expect(out.subjects[0].label).not.toBe(out.subjects[1].label)
  })
})

describe('resolvePromptAnchors — compositional integration', () => {
  it('returns subjects=null for single prompts', () => {
    const result = resolvePromptAnchors({
      promptText: 'fix refund flow',
      deps: {},
    })
    expect(result.subjects).toBeNull()
  })

  it('populates subjects array for compositional prompts', () => {
    const result = resolvePromptAnchors({
      promptText: 'fix refund pricing flow vs cancel order pricing flow',
      deps: {},
    })
    expect(result.subjects).not.toBeNull()
    expect(result.subjects).toHaveLength(2)
    if (!result.subjects) return
    expect(result.subjects[0].label).not.toBe(result.subjects[1].label)
    // Each subject's result has the standard shape
    for (const s of result.subjects) {
      expect(s.result.version).toBe('v2')
      expect(Array.isArray(s.result.anchors)).toBe(true)
      expect(s.result.stages).toBeDefined()
    }
  })
})
