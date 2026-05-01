import { describe, it, expect } from 'vitest'
import {
  CONFIDENCE_ORDER,
  SOURCE_PRIORITY,
  MIN_CONSUMER_CONFIDENCE,
  MAX_TOTAL_ANCHORS,
  GRAPH_EXPAND_EDGE_KINDS,
  isNoisePath,
  canonicalKey,
  edgeKindsToStrings,
  TargetAnchorSchema,
} from '../src/anchors/anchor-types'

describe('CONFIDENCE_ORDER', () => {
  it('orders high > medium > low', () => {
    expect(CONFIDENCE_ORDER.high).toBeGreaterThan(CONFIDENCE_ORDER.medium)
    expect(CONFIDENCE_ORDER.medium).toBeGreaterThan(CONFIDENCE_ORDER.low)
  })
})

describe('SOURCE_PRIORITY', () => {
  it('orders explicit > corpus_match > cochange_expand > graph_expand', () => {
    expect(SOURCE_PRIORITY.explicit).toBeGreaterThan(SOURCE_PRIORITY.corpus_match)
    expect(SOURCE_PRIORITY.corpus_match).toBeGreaterThan(SOURCE_PRIORITY.cochange_expand)
    expect(SOURCE_PRIORITY.cochange_expand).toBeGreaterThan(SOURCE_PRIORITY.graph_expand)
  })
})

describe('MIN_CONSUMER_CONFIDENCE', () => {
  it('is medium', () => {
    expect(MIN_CONSUMER_CONFIDENCE).toBe('medium')
  })
})

describe('MAX_TOTAL_ANCHORS', () => {
  it('is 40', () => {
    expect(MAX_TOTAL_ANCHORS).toBe(40)
  })
})

describe('isNoisePath', () => {
  it('matches factory paths', () => {
    expect(isNoisePath('database/factories/UserFactory.php')).toBe(true)
  })

  it('matches seeder paths', () => {
    expect(isNoisePath('database/seeders/DatabaseSeeder.php')).toBe(true)
  })

  it('matches fixture paths', () => {
    expect(isNoisePath('tests/fixtures/sample.php')).toBe(true)
  })

  it('matches stub paths', () => {
    expect(isNoisePath('stubs/model.stub')).toBe(true)
  })

  it('matches migration paths', () => {
    expect(isNoisePath('database/migrations/2024_01_create_users.php')).toBe(true)
  })

  it('matches generated files', () => {
    expect(isNoisePath('src/Models/User.generated.php')).toBe(true)
  })

  it('matches generic config files', () => {
    expect(isNoisePath('config/app.php')).toBe(true)
    expect(isNoisePath('config/database.php')).toBe(true)
  })

  it('matches composer files', () => {
    expect(isNoisePath('composer.json')).toBe(true)
    expect(isNoisePath('composer.lock')).toBe(true)
  })

  it('matches CHANGELOG', () => {
    expect(isNoisePath('CHANGELOG.md')).toBe(true)
  })

  it('matches README', () => {
    expect(isNoisePath('README.md')).toBe(true)
  })

  it('matches .env files', () => {
    expect(isNoisePath('.env')).toBe(true)
    expect(isNoisePath('.env.example')).toBe(true)
  })

  it('matches .gitignore', () => {
    expect(isNoisePath('.gitignore')).toBe(true)
  })

  it('does not match regular source files', () => {
    expect(isNoisePath('src/Shop/Checkout/Steps/AuthorizePayment.php')).toBe(false)
  })

  it('does not match non-generic config files', () => {
    expect(isNoisePath('config/checkout.php')).toBe(false)
  })
})

describe('GRAPH_EXPAND_EDGE_KINDS', () => {
  it('contains structural Laravel edges', () => {
    expect(GRAPH_EXPAND_EDGE_KINDS).toContain('route_to_controller')
    expect(GRAPH_EXPAND_EDGE_KINDS).toContain('dispatches_job')
    expect(GRAPH_EXPAND_EDGE_KINDS).toContain('emits_event')
  })

  it('does not contain calls edge', () => {
    expect(GRAPH_EXPAND_EDGE_KINDS).not.toContain('calls')
  })
})

describe('canonicalKey', () => {
  it('combines kind and value', () => {
    expect(canonicalKey('path', 'src/A.php')).toBe('path:src/A.php')
  })

  it('works for symbols', () => {
    expect(canonicalKey('symbol', 'class:AuthorizePayment')).toBe('symbol:class:AuthorizePayment')
  })
})

describe('edgeKindsToStrings', () => {
  it('converts readonly EdgeKind[] to string[]', () => {
    const result = edgeKindsToStrings(GRAPH_EXPAND_EDGE_KINDS)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toContain('route_to_controller')
  })
})

describe('TargetAnchorSchema', () => {
  it('validates a well-formed anchor', () => {
    const result = TargetAnchorSchema.safeParse({
      kind: 'path',
      value: 'src/A.php',
      source: 'explicit',
      confidence: 'high',
      evidence: ['explicit: resolved path'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty evidence', () => {
    const result = TargetAnchorSchema.safeParse({
      kind: 'path',
      value: 'src/A.php',
      source: 'explicit',
      confidence: 'high',
      evidence: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty value', () => {
    const result = TargetAnchorSchema.safeParse({
      kind: 'path',
      value: '',
      source: 'explicit',
      confidence: 'high',
      evidence: ['test'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid source', () => {
    const result = TargetAnchorSchema.safeParse({
      kind: 'path',
      value: 'src/A.php',
      source: 'unknown',
      confidence: 'high',
      evidence: ['test'],
    })
    expect(result.success).toBe(false)
  })

  it('accepts anchor with metadata', () => {
    const result = TargetAnchorSchema.safeParse({
      kind: 'path',
      value: 'src/A.php',
      source: 'corpus_match',
      confidence: 'medium',
      evidence: ['corpus_match: commit abc'],
      metadata: { retrievalScore: 2.5, supportCount: 3 },
    })
    expect(result.success).toBe(true)
  })

  it('rejects metadata with extra fields', () => {
    const result = TargetAnchorSchema.safeParse({
      kind: 'path',
      value: 'src/A.php',
      source: 'explicit',
      confidence: 'high',
      evidence: ['test'],
      metadata: { unknownField: 'nope' },
    })
    expect(result.success).toBe(false)
  })
})
