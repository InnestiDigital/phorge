/**
 * Example 02 — Co-change neighbours
 *
 * What this surfaces:
 *   For a given anchor file, list other files that historically change
 *   together with it (same git commit). High coupling = hidden contract.
 *
 * Why this is useful for a coding agent:
 *   Answers the question "if I change X, what else am I likely to need
 *   to touch?" before the agent has read a single line of code. This is
 *   the bridge between a single-file edit and a complete plan.
 *
 * Phorge surface exercised:
 *   loadRepoSignals (drives buildCommitCorpus + buildCoChangeMatrix)
 */

import { loadRepoSignals } from '../src/cli/corpus-cache'

const repoPath = process.argv[2] ?? process.cwd()
const fileArg = process.argv[3]

async function main(): Promise<void> {
  console.log(`# Co-change neighbours`)
  console.log(`# Repo: ${repoPath}`)
  console.log('')

  const signals = await loadRepoSignals({ repoPath })
  const entries = signals.coChange.all.entries

  // Pick the file: explicit arg, else the file with the most co-change pairs.
  let target = fileArg
  if (!target) {
    const sorted = [...entries].sort((a, b) => b.neighbors.length - a.neighbors.length)
    target = sorted[0]?.path
    if (!target) {
      console.log('no co-change data — repo may have too little history')
      return
    }
    console.log(`(no file arg given — picked top co-changing file: ${target})`)
    console.log('')
  }

  const entry = entries.find(e => e.path === target)
  if (!entry) {
    console.log(`no co-change record for ${target}`)
    return
  }

  console.log(`## ${target}`)
  console.log(`  appeared in ${entry.commitCount} commits`)
  console.log(`  ${entry.neighbors.length} co-changing neighbours`)
  console.log('')
  console.log('## Top neighbours (coupling, joint commits)')
  for (const n of entry.neighbors.slice(0, 15)) {
    const pct = (n.coupling * 100).toFixed(0)
    console.log(`  - ${n.path}  (${pct}%, ${n.jointCommits} joint commits)`)
  }
}

main().catch(err => {
  console.error('example failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
