// `phorge corpus build` — pre-build the commit corpus and cache it.
// `phorge corpus stats` — summarize the cached corpus.

import { loadRepoSignals } from '../corpus-cache'
import { resolveProfile } from '../../profiles/registry'
import { fail, printJson, printText, type ParsedCli } from '../args'

export async function runCorpus(cli: ParsedCli): Promise<void> {
  const sub = cli.positionals[0] ?? 'stats'
  const profile = await resolveProfile({
    repoPath: cli.repoPath,
    override: typeof cli.flags.lang === 'string' ? cli.flags.lang : undefined,
  })

  if (sub === 'build') {
    await loadRepoSignals({
      repoPath: cli.repoPath,
      since: cli.since,
      forceRebuild: true,
      fileScope: profile.fileScope,
      profileId: profile.id,
      volatility: profile.projectConfig?.volatility,
    })
    printText(`Corpus rebuilt and cached under ${cli.repoPath}/.phorge/`)
    return
  }

  if (sub === 'stats') {
    const signals = await loadRepoSignals({
      repoPath: cli.repoPath,
      since: cli.since,
      fileScope: profile.fileScope,
      profileId: profile.id,
      volatility: profile.projectConfig?.volatility,
    })
    if (cli.json) {
      printJson(signals.corpus.stats)
      return
    }
    const s = signals.corpus.stats
    const lines = [
      `# Corpus stats`,
      `  total commits considered: ${s.totalConsidered}`,
      `  kept: ${s.kept}`,
      `  filtered: ${s.totalConsidered - s.kept}`,
      `  files in volatility map: ${signals.volatility.entries.length}`,
      `  cochange entries: ${signals.coChange.all.entries.length}`,
      `  revert chains: ${signals.reverts.chains.length}`,
    ]
    printText(lines.join('\n'))
    return
  }

  fail(`corpus: unknown subcommand "${sub}". Use: build | stats`)
}
