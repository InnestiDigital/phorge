import { describe, it, expect, vi } from 'vitest'
import {
  loadHistoricalSignals,
  type HistoricalSignalsLoaderDeps,
} from '../src/profiles/historical-signals-loader'
import type {
  VolatilityMapManifest,
  CoChangeMatrixManifest,
  RevertChainsManifest,
} from '../src/commit-mining'

function volatilityFixture(): VolatilityMapManifest {
  return {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-23T00:00:00.000Z',
    asOf: '2026-04-23T00:00:00.000Z',
    weights: { churn: 0.35, bugDensity: 0.3, ownershipFragmentation: 0.15, recency: 0.2 },
    stats: { totalEntries: 0, excludedPaths: 0, churnP95: 4, topRiskPathCount: 0, topRiskThreshold: 0.7 },
    entries: [],
  }
}

function coChangeFixture(): CoChangeMatrixManifest {
  return {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-23T00:00:00.000Z',
    config: { minCoupling: 0.3, minJointCommits: 3, topK: 10, excludedPaths: 0 },
    all: { intentFilter: 'all', entries: [], stats: { anchors: 0, pairs: 0, commitsConsidered: 0 } },
    fix: { intentFilter: 'fix', entries: [], stats: { anchors: 0, pairs: 0, commitsConsidered: 0 } },
    feat: { intentFilter: 'feat', entries: [], stats: { anchors: 0, pairs: 0, commitsConsidered: 0 } },
  }
}

function revertChainsFixture(): RevertChainsManifest {
  return {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-23T00:00:00.000Z',
    stats: { totalRevertCommits: 0, resolvedReverts: 0, unresolvedReverts: 0, chains: 0, chainsWithReapply: 0, excludedPaths: 0 },
    links: [],
    chains: [],
    pathStats: [],
  }
}

describe('loadHistoricalSignals — returns all null when no env set', () => {
  it('returns null for all manifests', async () => {
    const result = await loadHistoricalSignals({ env: {}, logger: vi.fn() })
    expect(result.volatility).toBeNull()
    expect(result.coChange).toBeNull()
    expect(result.revertChains).toBeNull()
  })
})

describe('loadHistoricalSignals — local path resolution', () => {
  it('loads volatility from local path', async () => {
    const fixture = volatilityFixture()
    const readLocal = vi.fn().mockResolvedValue(JSON.stringify(fixture))
    const result = await loadHistoricalSignals({
      env: { FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/v.json' },
      readLocal,
      logger: vi.fn(),
    })
    expect(result.volatility).toEqual(fixture)
    expect(readLocal).toHaveBeenCalledWith('/tmp/v.json')
  })

  it('loads co-change from local path', async () => {
    const fixture = coChangeFixture()
    const readLocal = vi.fn().mockResolvedValue(JSON.stringify(fixture))
    const result = await loadHistoricalSignals({
      env: { FORGE_COCHANGE_MANIFEST_PATH: '/tmp/cc.json' },
      readLocal,
      logger: vi.fn(),
    })
    expect(result.coChange).toEqual(fixture)
  })

  it('loads revert-chains from local path', async () => {
    const fixture = revertChainsFixture()
    const readLocal = vi.fn().mockResolvedValue(JSON.stringify(fixture))
    const result = await loadHistoricalSignals({
      env: { FORGE_REVERT_CHAINS_MANIFEST_PATH: '/tmp/rc.json' },
      readLocal,
      logger: vi.fn(),
    })
    expect(result.revertChains).toEqual(fixture)
  })
})

describe('loadHistoricalSignals — S3 resolution', () => {
  it('loads from S3 when no local path but bucket+key set', async () => {
    const fixture = volatilityFixture()
    const readS3 = vi.fn().mockResolvedValue(JSON.stringify(fixture))
    const result = await loadHistoricalSignals({
      env: { FORGE_VOLATILITY_BUCKET: 'b', FORGE_VOLATILITY_KEY: 'k' },
      readS3,
      logger: vi.fn(),
    })
    expect(result.volatility).toEqual(fixture)
    expect(readS3).toHaveBeenCalledWith('b', 'k')
  })
})

describe('loadHistoricalSignals — local takes precedence over S3', () => {
  it('uses local path even when S3 vars are also set', async () => {
    const fixture = volatilityFixture()
    const readLocal = vi.fn().mockResolvedValue(JSON.stringify(fixture))
    const readS3 = vi.fn()
    const result = await loadHistoricalSignals({
      env: {
        FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/v.json',
        FORGE_VOLATILITY_BUCKET: 'b',
        FORGE_VOLATILITY_KEY: 'k',
      },
      readLocal,
      readS3,
      logger: vi.fn(),
    })
    expect(result.volatility).toEqual(fixture)
    expect(readS3).not.toHaveBeenCalled()
  })
})

describe('loadHistoricalSignals — failure isolation', () => {
  it('returns null for failed manifest without affecting others', async () => {
    const ccFixture = coChangeFixture()
    const readLocal = vi.fn().mockImplementation((path: string) => {
      if (path === '/tmp/v.json') throw new Error('disk error')
      return Promise.resolve(JSON.stringify(ccFixture))
    })
    const logger = vi.fn()
    const result = await loadHistoricalSignals({
      env: {
        FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/v.json',
        FORGE_COCHANGE_MANIFEST_PATH: '/tmp/cc.json',
      },
      readLocal,
      logger,
    })
    expect(result.volatility).toBeNull()
    expect(result.coChange).toEqual(ccFixture)
    expect(logger).toHaveBeenCalledOnce()
  })

  it('returns null for invalid JSON without throwing', async () => {
    const readLocal = vi.fn().mockResolvedValue('not json')
    const logger = vi.fn()
    const result = await loadHistoricalSignals({
      env: { FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/v.json' },
      readLocal,
      logger,
    })
    expect(result.volatility).toBeNull()
    expect(logger).toHaveBeenCalled()
  })

  it('returns null for schema-invalid JSON without throwing', async () => {
    const readLocal = vi.fn().mockResolvedValue(JSON.stringify({ bad: true }))
    const logger = vi.fn()
    const result = await loadHistoricalSignals({
      env: { FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/v.json' },
      readLocal,
      logger,
    })
    expect(result.volatility).toBeNull()
    expect(logger).toHaveBeenCalled()
  })
})

describe('loadHistoricalSignals — loads all three together', () => {
  it('loads all manifests when all env vars set', async () => {
    const vf = volatilityFixture()
    const cf = coChangeFixture()
    const rf = revertChainsFixture()
    const readLocal = vi.fn().mockImplementation((path: string) => {
      if (path.includes('vol')) return Promise.resolve(JSON.stringify(vf))
      if (path.includes('cc')) return Promise.resolve(JSON.stringify(cf))
      if (path.includes('rc')) return Promise.resolve(JSON.stringify(rf))
      throw new Error(`unexpected path: ${path}`)
    })
    const result = await loadHistoricalSignals({
      env: {
        FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/vol.json',
        FORGE_COCHANGE_MANIFEST_PATH: '/tmp/cc.json',
        FORGE_REVERT_CHAINS_MANIFEST_PATH: '/tmp/rc.json',
      },
      readLocal,
      logger: vi.fn(),
    })
    expect(result.volatility).toEqual(vf)
    expect(result.coChange).toEqual(cf)
    expect(result.revertChains).toEqual(rf)
  })
})
