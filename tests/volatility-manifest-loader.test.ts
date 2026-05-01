import { describe, it, expect, vi } from 'vitest'
import { loadVolatilityManifest } from '../src/profiles/volatility-manifest-loader'
import type { VolatilityMapManifest } from '../src/commit-mining'

function validManifestJson(): string {
  const m: VolatilityMapManifest = {
    schemaVersion: 1,
    repo: 'podium.api',
    window: {},
    createdAt: '2026-04-22T00:00:00.000Z',
    asOf: '2026-04-22T00:00:00.000Z',
    weights: { churn: 0.35, bugDensity: 0.3, ownershipFragmentation: 0.15, recency: 0.2 },
    stats: { totalEntries: 0, excludedPaths: 0, churnP95: 0, topRiskPathCount: 0, topRiskThreshold: 0.7 },
    entries: [],
  }
  return JSON.stringify(m)
}

describe('loadVolatilityManifest — resolution', () => {
  it('returns null when no envs set', async () => {
    const result = await loadVolatilityManifest({ env: {}, logger: vi.fn() })
    expect(result).toBeNull()
  })

  it('returns null when only bucket set (key missing)', async () => {
    const logger = vi.fn()
    const result = await loadVolatilityManifest({
      env: { FORGE_VOLATILITY_BUCKET: 'b' },
      logger,
    })
    expect(result).toBeNull()
  })

  it('returns null when only key set (bucket missing)', async () => {
    const result = await loadVolatilityManifest({
      env: { FORGE_VOLATILITY_KEY: 'k' },
      logger: vi.fn(),
    })
    expect(result).toBeNull()
  })
})

describe('loadVolatilityManifest — local path', () => {
  it('reads and parses valid manifest from local path', async () => {
    const readLocal = vi.fn().mockResolvedValue(validManifestJson())
    const result = await loadVolatilityManifest({
      env: { FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/vm.json' },
      readLocal,
      logger: vi.fn(),
    })
    expect(result).not.toBeNull()
    expect(result!.repo).toBe('podium.api')
    expect(readLocal).toHaveBeenCalledWith('/tmp/vm.json')
  })

  it('returns null and logs when local read throws', async () => {
    const readLocal = vi.fn().mockRejectedValue(new Error('ENOENT'))
    const logger = vi.fn()
    const result = await loadVolatilityManifest({
      env: { FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/missing.json' },
      readLocal,
      logger,
    })
    expect(result).toBeNull()
    expect(logger).toHaveBeenCalled()
  })

  it('returns null and logs on invalid JSON', async () => {
    const readLocal = vi.fn().mockResolvedValue('{ not json')
    const logger = vi.fn()
    const result = await loadVolatilityManifest({
      env: { FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/bad.json' },
      readLocal,
      logger,
    })
    expect(result).toBeNull()
    expect(logger).toHaveBeenCalled()
  })

  it('returns null and logs when manifest fails schema validation', async () => {
    const readLocal = vi.fn().mockResolvedValue(JSON.stringify({ schemaVersion: 999, bogus: true }))
    const logger = vi.fn()
    const result = await loadVolatilityManifest({
      env: { FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/bad.json' },
      readLocal,
      logger,
    })
    expect(result).toBeNull()
    expect(logger).toHaveBeenCalled()
  })
})

describe('loadVolatilityManifest — S3', () => {
  it('reads and parses valid manifest from S3', async () => {
    const readS3 = vi.fn().mockResolvedValue(validManifestJson())
    const result = await loadVolatilityManifest({
      env: { FORGE_VOLATILITY_BUCKET: 'b', FORGE_VOLATILITY_KEY: 'k/v.json' },
      readS3,
      logger: vi.fn(),
    })
    expect(result).not.toBeNull()
    expect(readS3).toHaveBeenCalledWith('b', 'k/v.json')
  })

  it('returns null and logs when S3 read throws', async () => {
    const readS3 = vi.fn().mockRejectedValue(new Error('AccessDenied'))
    const logger = vi.fn()
    const result = await loadVolatilityManifest({
      env: { FORGE_VOLATILITY_BUCKET: 'b', FORGE_VOLATILITY_KEY: 'k' },
      readS3,
      logger,
    })
    expect(result).toBeNull()
    expect(logger).toHaveBeenCalled()
  })
})

describe('loadVolatilityManifest — precedence', () => {
  it('local path takes precedence over S3 when both set', async () => {
    const readLocal = vi.fn().mockResolvedValue(validManifestJson())
    const readS3 = vi.fn()
    const result = await loadVolatilityManifest({
      env: {
        FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/vm.json',
        FORGE_VOLATILITY_BUCKET: 'b',
        FORGE_VOLATILITY_KEY: 'k',
      },
      readLocal,
      readS3,
      logger: vi.fn(),
    })
    expect(result).not.toBeNull()
    expect(readLocal).toHaveBeenCalled()
    expect(readS3).not.toHaveBeenCalled()
  })

  it('does NOT fall back to S3 when local path fails', async () => {
    const readLocal = vi.fn().mockRejectedValue(new Error('ENOENT'))
    const readS3 = vi.fn()
    const result = await loadVolatilityManifest({
      env: {
        FORGE_VOLATILITY_MANIFEST_PATH: '/tmp/vm.json',
        FORGE_VOLATILITY_BUCKET: 'b',
        FORGE_VOLATILITY_KEY: 'k',
      },
      readLocal,
      readS3,
      logger: vi.fn(),
    })
    expect(result).toBeNull()
    expect(readS3).not.toHaveBeenCalled()
  })
})
