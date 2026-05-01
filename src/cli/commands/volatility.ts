// `phorge volatility [<file>]` — churn + bug-fix density + risk score.

import { loadRepoSignals } from '../corpus-cache'
import { resolveProfile } from '../../profiles/registry'
import { printJson, printText, type ParsedCli } from '../args'

export async function runVolatility(cli: ParsedCli): Promise<void> {
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
  })

  const entries = target
    ? signals.volatility.entries.filter(e => e.path === target)
    : signals.volatility.entries.slice(0, 20)

  if (cli.json) {
    printJson(target ? (entries[0] ?? null) : entries)
    return
  }

  if (entries.length === 0) {
    printText(target ? `No volatility data for ${target}` : 'No volatility data available')
    return
  }

  const lines: string[] = []
  lines.push(target ? `# Volatility: ${target}` : '# Top volatile files')
  lines.push('')
  for (const e of entries) {
    const risk = (e.riskScore * 100).toFixed(0)
    const bugDensity = (e.bugFixDensity * 100).toFixed(0)
    lines.push(`  risk=${risk}%  commits=${e.commitCount}  bugfix=${bugDensity}%  ${e.path}`)
  }
  printText(lines.join('\n'))
}
