// pipeline/tests/knowledge/consumers/anchor-ranker.test.ts
import { describe, it, expect } from 'vitest'
import { rankAnchors } from '../src/anchors/anchor-ranker'
import type { TargetAnchor } from '../src/anchors/anchor-types'

function makeAnchor(overrides: Partial<TargetAnchor> & { value: string }): TargetAnchor {
  return {
    kind: overrides.kind ?? 'path',
    value: overrides.value,
    source: overrides.source ?? 'explicit',
    confidence: overrides.confidence ?? 'high',
    evidence: overrides.evidence ?? ['test'],
    metadata: overrides.metadata,
  }
}

describe('rankAnchors — dedup', () => {
  it('deduplicates by canonical key, keeping highest confidence', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'medium', source: 'corpus_match', evidence: ['corpus'] }),
      makeAnchor({ value: 'src/A.php', confidence: 'high', source: 'explicit', evidence: ['explicit'] }),
    ]
    const result = rankAnchors(anchors)
    const aAnchors = result.anchors.filter(a => a.value === 'src/A.php')
    expect(aAnchors).toHaveLength(1)
    expect(aAnchors[0].confidence).toBe('high')
  })

  it('merges evidence from duplicates', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'high', source: 'explicit', evidence: ['from regex'] }),
      makeAnchor({ value: 'src/A.php', confidence: 'medium', source: 'corpus_match', evidence: ['from corpus'] }),
    ]
    const result = rankAnchors(anchors)
    const a = result.anchors.find(a => a.value === 'src/A.php')!
    expect(a.evidence).toContain('from regex')
    expect(a.evidence).toContain('from corpus')
  })

  it('prefers higher source priority when same confidence', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'high', source: 'corpus_match' }),
      makeAnchor({ value: 'src/A.php', confidence: 'high', source: 'explicit' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.anchors[0].source).toBe('explicit')
  })

  it('tracks droppedDuplicates count', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'high' }),
      makeAnchor({ value: 'src/A.php', confidence: 'medium' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.stats.droppedDuplicates).toBe(1)
  })

  it('sorts merged evidence deterministically', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'high', source: 'explicit', evidence: ['z_evidence'] }),
      makeAnchor({ value: 'src/A.php', confidence: 'medium', source: 'corpus_match', evidence: ['a_evidence'] }),
    ]
    const result = rankAnchors(anchors)
    const a = result.anchors.find(a => a.value === 'src/A.php')!
    expect(a.evidence[0]).toBe('a_evidence')
    expect(a.evidence[1]).toBe('z_evidence')
  })
})

describe('rankAnchors — noise path filtering', () => {
  it('filters noise paths', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'high' }),
      makeAnchor({ value: 'database/factories/UserFactory.php', confidence: 'high' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.targetPaths).not.toContain('database/factories/UserFactory.php')
    expect(result.stats.droppedNoisePaths).toBe(1)
  })
})

describe('rankAnchors — ranking order', () => {
  it('ranks high before medium before low', () => {
    const anchors = [
      makeAnchor({ value: 'src/C.php', confidence: 'low' }),
      makeAnchor({ value: 'src/A.php', confidence: 'high' }),
      makeAnchor({ value: 'src/B.php', confidence: 'medium' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.anchors[0].value).toBe('src/A.php')
    expect(result.anchors[1].value).toBe('src/B.php')
    expect(result.anchors[2].value).toBe('src/C.php')
  })

  it('ranks by source priority within same confidence', () => {
    const anchors = [
      makeAnchor({ value: 'src/B.php', confidence: 'high', source: 'corpus_match' }),
      makeAnchor({ value: 'src/A.php', confidence: 'high', source: 'explicit' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.anchors[0].value).toBe('src/A.php')
  })

  it('uses alphabetical tie-break', () => {
    const anchors = [
      makeAnchor({ value: 'src/Z.php', confidence: 'high', source: 'explicit' }),
      makeAnchor({ value: 'src/A.php', confidence: 'high', source: 'explicit' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.anchors[0].value).toBe('src/A.php')
  })
})

describe('rankAnchors — confidence filtering', () => {
  it('excludes low confidence from targetPaths', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'high' }),
      makeAnchor({ value: 'src/B.php', confidence: 'low' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.targetPaths).toContain('src/A.php')
    expect(result.targetPaths).not.toContain('src/B.php')
    expect(result.stats.droppedLow).toBe(1)
  })

  it('preserves low confidence in anchors array', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'low' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.anchors).toHaveLength(1)
    expect(result.targetPaths).toHaveLength(0)
  })
})

describe('rankAnchors — capping', () => {
  it('caps targetPaths to maxPaths', () => {
    const anchors = Array.from({ length: 40 }, (_, i) =>
      makeAnchor({ value: `src/File${i}.php`, confidence: 'high' })
    )
    const result = rankAnchors(anchors, { maxPaths: 5 })
    expect(result.targetPaths.length).toBe(5)
    expect(result.stats.cappedPaths).toBe(35)
  })

  it('caps targetSymbols to maxSymbols', () => {
    const anchors = Array.from({ length: 30 }, (_, i) =>
      makeAnchor({ value: `class:Class${i}`, kind: 'symbol', confidence: 'high' })
    )
    const result = rankAnchors(anchors, { maxSymbols: 5 })
    expect(result.targetSymbols.length).toBe(5)
  })

  it('applies MAX_TOTAL_ANCHORS cap', () => {
    const anchors = Array.from({ length: 60 }, (_, i) =>
      makeAnchor({ value: `src/File${i}.php`, confidence: 'high' })
    )
    const result = rankAnchors(anchors)
    expect(result.anchors.length).toBeLessThanOrEqual(40)
  })
})

describe('rankAnchors — flat array derivation', () => {
  it('separates paths and symbols', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', kind: 'path', confidence: 'high' }),
      makeAnchor({ value: 'class:Foo', kind: 'symbol', confidence: 'high' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.targetPaths).toContain('src/A.php')
    expect(result.targetSymbols).toContain('class:Foo')
    expect(result.targetPaths).not.toContain('class:Foo')
  })
})

describe('rankAnchors — stats', () => {
  it('reports complete stats', () => {
    const anchors = [
      makeAnchor({ value: 'src/A.php', confidence: 'high' }),
      makeAnchor({ value: 'src/A.php', confidence: 'medium', source: 'corpus_match' }),
      makeAnchor({ value: 'src/B.php', confidence: 'low' }),
      makeAnchor({ value: 'database/factories/F.php', confidence: 'high' }),
      makeAnchor({ value: 'class:Foo', kind: 'symbol', confidence: 'medium' }),
    ]
    const result = rankAnchors(anchors)
    expect(result.stats.droppedDuplicates).toBe(1)
    expect(result.stats.droppedLow).toBe(1)
    expect(result.stats.droppedNoisePaths).toBe(1)
    expect(result.stats.keptPaths).toBe(1)
    expect(result.stats.keptSymbols).toBe(1)
  })
})

describe('rankAnchors — empty input', () => {
  it('returns empty result for empty input', () => {
    const result = rankAnchors([])
    expect(result.anchors).toHaveLength(0)
    expect(result.targetPaths).toHaveLength(0)
    expect(result.targetSymbols).toHaveLength(0)
    expect(result.stats.totalAnchors).toBe(0)
  })
})
