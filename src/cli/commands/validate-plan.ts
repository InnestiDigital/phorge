// `phorge validate-plan <file>` — run deterministic plan validator against a plan.

import { readFileSync, existsSync, statSync as fsStat } from 'node:fs'
import { resolve, join } from 'node:path'
import { validatePlan, type DraftPlan, type PlanValidationDeps } from '../../checkers'
import { resolveProfile } from '../../profiles/registry'
import { loadRepoSignals } from '../corpus-cache'
import { loadGraph } from '../graph-cache'
import { createGraphReader, type GraphReader } from '../../graphs/graph-reader'
import { loadRulesFromDirs } from '../rules-loader'
import { fail, printJson, printText, type ParsedCli } from '../args'
import type { RepoResolver } from '../../resolvers'

export async function runValidatePlan(cli: ParsedCli): Promise<void> {
  const planPath = cli.positionals[0]
  if (!planPath) fail('validate-plan: <plan-file> positional argument required')

  const fullPath = resolve(planPath)
  if (!existsSync(fullPath)) fail(`validate-plan: plan file not found: ${fullPath}`)

  const rawText = readFileSync(fullPath, 'utf-8')
  const plan: DraftPlan = { rawText, sourceLabel: planPath }

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

  // Try to load the graph. Absent graph disables structural-gap checker
  // rather than aborting — the rest of the validator is still useful.
  let graphReader: GraphReader | null = null
  let graphStatus: 'loaded' | 'not built' = 'not built'
  try {
    const g = loadGraph(cli.repoPath)
    graphReader = createGraphReader(g.nodes, g.edges)
    graphStatus = 'loaded'
  } catch {
    process.stderr.write(
      `phorge: graph not built — run \`phorge graph build --repo ${cli.repoPath}\` to enable structural-gap checker\n`,
    )
  }

  const ruleDirs = resolveRuleDirs(cli)
  const rules = await loadRulesFromDirs(ruleDirs)
  process.stderr.write(`phorge: ${rules.length} rule(s) loaded from ${ruleDirs.length} dir(s)\n`)

  const deps: PlanValidationDeps = {
    repoResolver: passthroughResolver(cli.repoPath),
    graphReader,
    cochangeEntries: signals.coChange.all.entries,
    volatilityEntries: signals.volatility.entries,
    revertStats: signals.reverts.pathStats,
    rules,
    repoRoot: cli.repoPath,
    testPathStrategy: profile.testPaths,
  }

  const result = await validatePlan(plan, deps)

  if (cli.json) {
    printJson({ ...result, graph: graphStatus, rulesLoaded: rules.length })
    return
  }

  const lines: string[] = []
  lines.push(`# Plan validation: ${planPath}`)
  lines.push(`Verdict: ${result.verdict.toUpperCase()}`)
  lines.push(`graph: ${graphStatus}`)
  lines.push(`rules: ${rules.length} loaded`)
  lines.push(`Issues: ${result.issues.length}`)
  lines.push('')
  for (const issue of result.issues) {
    lines.push(`  [${issue.severity}] ${issue.kind}: ${issue.message}`)
    for (const ev of issue.evidence.slice(0, 3)) {
      lines.push(`      ${ev}`)
    }
  }
  printText(lines.join('\n'))

  if (result.verdict === 'revise') process.exit(2)
}

function resolveRuleDirs(cli: ParsedCli): string[] {
  const flag = cli.flags['rules-dir']
  const overrides: string[] = Array.isArray(flag)
    ? flag
    : typeof flag === 'string' ? [flag] : []
  if (overrides.length > 0) return overrides.map((d) => resolve(d))
  return [
    join(cli.repoPath, '.forge', 'rules'),
    join(cli.repoPath, '.phorge', 'rules'),
  ]
}

function passthroughResolver(repoRoot: string): RepoResolver {
  return {
    fileExists: (path: string) => {
      const full = resolve(repoRoot, path)
      try { return existsSync(full) && fsStat(full).isFile() }
      catch { return false }
    },
    findFileForClass: () => null,
    findMethodKey: () => null,
  }
}
