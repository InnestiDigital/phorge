// `phorge complexity <file...>` — refactor-risk profile per file.

import { buildFileComplexityProfile, formatComplexityHints } from '../../profiles'
import { resolveProfile } from '../../profiles/registry'
import { loadRepoSignals } from '../corpus-cache'
import { fail, printJson, printText, type ParsedCli } from '../args'

export async function runComplexity(cli: ParsedCli): Promise<void> {
  if (cli.positionals.length === 0) fail('complexity: <file...> positional arguments required')

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

  const profiles = cli.positionals
    .map(p => buildFileComplexityProfile(p, {
      repoRoot: cli.repoPath,
      volatilityEntries: signals.volatility.entries,
      revertStats: signals.reverts.pathStats,
      complexityAnalyzer: profile.complexity,
    }))
    .filter((p): p is NonNullable<typeof p> => p !== null)

  if (cli.json) {
    printJson(profiles)
    return
  }

  if (profiles.length === 0) {
    printText('No complexity data — files not found in repo')
    return
  }

  printText(formatComplexityHints(profiles))
}
