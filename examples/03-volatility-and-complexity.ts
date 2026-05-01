/**
 * Example 03 — Volatility + complexity risk profile
 *
 * What this surfaces:
 *   For the most volatile files in the repo (high churn, high bug-fix
 *   density, frequent reverts), combine git-history signals with AST
 *   complexity (cyclomatic, nesting, method size) to flag refactor risk.
 *
 * Why this is useful for a coding agent:
 *   A file that is large + churny + bug-heavy + reverted is the worst
 *   place to add a quick patch. Surfacing this up-front lets the agent
 *   decompose the change before touching it.
 *
 * Phorge surface exercised:
 *   loadRepoSignals (volatility), buildFileComplexityProfile,
 *   formatComplexityHints
 */

import {
  buildFileComplexityProfile,
  formatComplexityHints,
  type FileComplexityProfile,
} from '../src/profiles'
import { loadRepoSignals } from '../src/cli/corpus-cache'

const repoPath = process.argv[2] ?? process.cwd()
const TOP_N = 5

async function main(): Promise<void> {
  console.log(`# Volatility + complexity profile (top ${TOP_N})`)
  console.log(`# Repo: ${repoPath}`)
  console.log('')

  const signals = await loadRepoSignals({ repoPath })

  const ranked = [...signals.volatility.entries]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, TOP_N)

  if (ranked.length === 0) {
    console.log('no volatility data — repo may have too little history')
    return
  }

  console.log('## Top volatile files')
  for (const v of ranked) {
    const risk = (v.riskScore * 100).toFixed(0)
    const bug = (v.bugFixDensity * 100).toFixed(0)
    console.log(`  - ${v.path}`)
    console.log(`      commits=${v.commitCount}  risk=${risk}%  bug-fix-density=${bug}%`)
  }
  console.log('')

  const profiles: FileComplexityProfile[] = []
  for (const v of ranked) {
    const p = buildFileComplexityProfile(v.path, {
      repoRoot: repoPath,
      volatilityEntries: signals.volatility.entries,
      revertStats: signals.reverts.pathStats,
    })
    if (p) profiles.push(p)
  }

  if (profiles.length === 0) {
    console.log('(no profiles built — files may not exist on disk anymore)')
    return
  }

  const hints = formatComplexityHints(profiles)
  if (hints) console.log(hints)
  else console.log('## Complexity\n  no notable warnings')
}

main().catch(err => {
  console.error('example failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
