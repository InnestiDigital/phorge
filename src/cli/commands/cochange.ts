// `phorge cochange <file>` — neighbors that historically change with this file.

import { loadRepoSignals } from '../corpus-cache'
import { resolveProfile } from '../../profiles/registry'
import { fail, printJson, printText, type ParsedCli } from '../args'

export async function runCoChange(cli: ParsedCli): Promise<void> {
  const target = cli.positionals[0]
  if (!target) fail('cochange: <file> positional argument required')

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

  const entry = signals.coChange.all.entries.find(e => e.path === target)

  if (cli.json) {
    printJson(entry ?? { path: target, neighbors: [] })
    return
  }

  if (!entry || entry.neighbors.length === 0) {
    printText(`No co-change neighbors for ${target}`)
    return
  }

  const lines: string[] = []
  lines.push(`# Co-change neighbors: ${target}`)
  lines.push(`(${entry.commitCount} commits touched this file)`)
  lines.push('')
  for (const n of entry.neighbors) {
    const pct = (n.coupling * 100).toFixed(0)
    lines.push(`  ${pct}%  ${n.path}  (${n.jointCommits} joint commits)`)
  }
  printText(lines.join('\n'))
}
