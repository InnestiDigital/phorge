// `phorge revert-risk [<file>]` — files with revert chains (fragility signal).

import { loadRepoSignals } from '../corpus-cache'
import { resolveProfile } from '../../profiles/registry'
import { printJson, printText, type ParsedCli } from '../args'

export async function runRevertRisk(cli: ParsedCli): Promise<void> {
  const target = cli.positionals[0]
  const profile = await resolveProfile({
    repoPath: cli.repoPath,
    override: typeof cli.flags.lang === 'string' ? cli.flags.lang : undefined,
  })
  const signals = await loadRepoSignals({
    repoPath: cli.repoPath,
    since: cli.since,
    fileScope: profile.fileScope,
    profileId: profile.id,
      volatility: profile.projectConfig?.volatility,
  })

  const stats = signals.reverts.pathStats
  const entries = target
    ? stats.filter(e => e.path === target)
    : stats.slice(0, 20)

  if (cli.json) {
    printJson(target ? (entries[0] ?? null) : entries)
    return
  }

  if (entries.length === 0) {
    printText(target ? `No revert history for ${target}` : 'No revert history available')
    return
  }

  const lines: string[] = []
  lines.push(target ? `# Revert risk: ${target}` : '# Files with revert history')
  lines.push('')
  for (const e of entries) {
    const density = (e.revertDensity * 100).toFixed(0)
    lines.push(`  reverts=${e.revertCount}  density=${density}%  ${e.path}`)
  }
  printText(lines.join('\n'))
}
