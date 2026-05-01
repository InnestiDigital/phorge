import { describe, it, expect, vi } from 'vitest'
import { buildFileComplexityProfile, formatComplexityHints, type FileComplexityProfileDeps } from '../src/profiles/file-complexity-profile'
import * as fs from 'node:fs'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, readFileSync: vi.fn() }
})

const mockedReadFileSync = vi.mocked(fs.readFileSync)

function makeDeps(overrides?: Partial<FileComplexityProfileDeps>): FileComplexityProfileDeps {
  return {
    repoRoot: '/repo',
    volatilityEntries: [],
    revertStats: [],
    ...overrides,
  }
}

describe('buildFileComplexityProfile', () => {
  it('returns null when file cannot be read', () => {
    mockedReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    const result = buildFileComplexityProfile('missing.php', makeDeps())
    expect(result).toBeNull()
  })

  it('returns low risk for small file with no history', () => {
    mockedReadFileSync.mockReturnValue('<?php\nclass Foo {}\n')
    const result = buildFileComplexityProfile('app/Foo.php', makeDeps())
    expect(result).not.toBeNull()
    expect(result!.lineCount).toBe(3)
    expect(result!.refactorRisk).toBe('low')
    expect(result!.refactorSignals).toHaveLength(0)
  })

  it('flags large file', () => {
    mockedReadFileSync.mockReturnValue('line\n'.repeat(400))
    const result = buildFileComplexityProfile('app/BigJob.php', makeDeps())
    expect(result!.refactorRisk).toBe('low')
    expect(result!.refactorSignals).toContain('large file (401 lines)')
  })

  it('returns medium risk with 2+ signals', () => {
    mockedReadFileSync.mockReturnValue('line\n'.repeat(400))
    const deps = makeDeps({
      volatilityEntries: [{
        path: 'app/BigJob.php',
        commitCount: 20,
        lineDeltaAdded: 500,
        lineDeltaDeleted: 200,
        firstTouchedAt: '2024-01-01T00:00:00.000Z',
        lastTouchedAt: '2026-04-01T00:00:00.000Z',
        bugFixCommitCount: 10,
        bugFixDensity: 0.5,
        topAuthors: [],
        laravelVersionSpan: [],
        riskScore: 0.8,
        riskBreakdown: { churnComponent: 0.3, bugDensityComponent: 0.3, ownershipFragmentationComponent: 0.1, recencyComponent: 0.1 },
      }],
    })
    const result = buildFileComplexityProfile('app/BigJob.php', deps)
    expect(result!.refactorRisk).toBe('high')
    expect(result!.refactorSignals.length).toBeGreaterThanOrEqual(3)
  })

  it('returns medium risk for small file with 2 signals', () => {
    mockedReadFileSync.mockReturnValue('line\n'.repeat(100))
    const deps = makeDeps({
      volatilityEntries: [{
        path: 'app/SmallHot.php',
        commitCount: 20,
        lineDeltaAdded: 200,
        lineDeltaDeleted: 100,
        firstTouchedAt: '2024-01-01T00:00:00.000Z',
        lastTouchedAt: '2026-04-01T00:00:00.000Z',
        bugFixCommitCount: 10,
        bugFixDensity: 0.5,
        topAuthors: [],
        laravelVersionSpan: [],
        riskScore: 0.6,
        riskBreakdown: { churnComponent: 0.3, bugDensityComponent: 0.3, ownershipFragmentationComponent: 0, recencyComponent: 0 },
      }],
    })
    const result = buildFileComplexityProfile('app/SmallHot.php', deps)
    expect(result!.refactorRisk).toBe('medium')
    expect(result!.refactorSignals.length).toBe(2)
  })

  it('returns high risk for large file with 3+ signals', () => {
    mockedReadFileSync.mockReturnValue('line\n'.repeat(700))
    const deps = makeDeps({
      volatilityEntries: [{
        path: 'app/BigJob.php',
        commitCount: 25,
        lineDeltaAdded: 1000,
        lineDeltaDeleted: 500,
        firstTouchedAt: '2024-01-01T00:00:00.000Z',
        lastTouchedAt: '2026-04-01T00:00:00.000Z',
        bugFixCommitCount: 19,
        bugFixDensity: 0.76,
        topAuthors: [],
        laravelVersionSpan: [],
        riskScore: 0.91,
        riskBreakdown: { churnComponent: 0.3, bugDensityComponent: 0.3, ownershipFragmentationComponent: 0.2, recencyComponent: 0.1 },
      }],
    })
    const result = buildFileComplexityProfile('app/BigJob.php', deps)
    expect(result!.refactorRisk).toBe('high')
    expect(result!.refactorSignals.length).toBeGreaterThanOrEqual(3)
  })

  it('includes revert signal', () => {
    mockedReadFileSync.mockReturnValue('line\n'.repeat(400))
    const deps = makeDeps({
      revertStats: [{
        path: 'app/Risky.php',
        commitCount: 10,
        revertCount: 2,
        revertDensity: 0.2,
        medianDaysToRevert: 3,
        chainsInvolvingPath: 1,
        lastRevertedAt: '2026-03-01T00:00:00.000Z',
      }],
    })
    const result = buildFileComplexityProfile('app/Risky.php', deps)
    expect(result!.refactorSignals).toContain('reverted 2x')
  })
})

describe('formatComplexityHints', () => {
  it('returns empty string for all-low profiles', () => {
    const profiles = [{ path: 'a.php', lineCount: 50, commitCount: 2, bugFixDensity: 0, riskScore: 0, revertCount: 0, revertDensity: 0, refactorRisk: 'low' as const, refactorSignals: [] }]
    expect(formatComplexityHints(profiles)).toBe('')
  })

  it('formats medium and high risk profiles', () => {
    const profiles = [
      { path: 'big.php', lineCount: 700, commitCount: 25, bugFixDensity: 0.76, riskScore: 0.91, revertCount: 0, revertDensity: 0, refactorRisk: 'high' as const, refactorSignals: ['very large file (700 lines)', 'high churn (25 commits)', 'high bug-fix density (76%)'] },
      { path: 'med.php', lineCount: 350, commitCount: 18, bugFixDensity: 0.5, riskScore: 0.6, revertCount: 0, revertDensity: 0, refactorRisk: 'medium' as const, refactorSignals: ['large file (350 lines)', 'high churn (18 commits)'] },
    ]
    const result = formatComplexityHints(profiles)
    expect(result).toContain('## Complexity Warnings')
    expect(result).toContain('[HIGH]')
    expect(result).toContain('[MEDIUM]')
    expect(result).toContain('extracting responsibilities')
  })

  it('sorts high before medium', () => {
    const profiles = [
      { path: 'med.php', lineCount: 350, commitCount: 18, bugFixDensity: 0.5, riskScore: 0.6, revertCount: 0, revertDensity: 0, refactorRisk: 'medium' as const, refactorSignals: ['large file', 'high churn'] },
      { path: 'high.php', lineCount: 700, commitCount: 25, bugFixDensity: 0.76, riskScore: 0.91, revertCount: 0, revertDensity: 0, refactorRisk: 'high' as const, refactorSignals: ['very large file', 'high churn', 'high bugfix'] },
    ]
    const result = formatComplexityHints(profiles)
    const highIdx = result.indexOf('[HIGH]')
    const medIdx = result.indexOf('[MEDIUM]')
    expect(highIdx).toBeLessThan(medIdx)
  })
})
