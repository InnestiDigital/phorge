#!/usr/bin/env node
// phorge-benchmark — anchor precision/recall harness against a real repo.
// Dev tooling, not user-facing CLI surface.

import { parseArgs } from 'node:util'
import {
  runAnchorBenchmark,
  formatResult,
  type PromptStrategy,
} from '../src/benchmark/anchor-precision'

const HELP = `phorge-benchmark — measure anchor precision against real merged commits.

Usage:
  phorge-benchmark --repo <path> --since <YYYY-MM-DD> [--limit N] [--strategy S] [--json]

Flags:
  --repo <path>      Target repo (required)
  --since <date>     Commit window start (required)
  --limit <n>        Max samples (default 50)
  --min-truth <n>    Skip commits touching <n PHP src files (default 1)
  --max-truth <n>    Skip commits touching >n PHP src files (default 20)
  --strategy <s>     Prompt strategy: subject | subject_body | body_only (default subject_body)
  --json             Emit full BenchmarkResult JSON
  --help             Show this help
`

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    strict: false,
    options: {
      repo: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      'min-truth': { type: 'string' },
      'max-truth': { type: 'string' },
      strategy: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help) {
    process.stdout.write(HELP)
    return
  }

  const repo = typeof values.repo === 'string' ? values.repo : null
  const since = typeof values.since === 'string' ? values.since : null
  if (!repo || !since) {
    process.stderr.write(HELP)
    process.exit(1)
  }

  const limit = typeof values.limit === 'string' ? Number.parseInt(values.limit, 10) : undefined
  const minTruth = typeof values['min-truth'] === 'string' ? Number.parseInt(values['min-truth'] as string, 10) : undefined
  const maxTruth = typeof values['max-truth'] === 'string' ? Number.parseInt(values['max-truth'] as string, 10) : undefined
  const strategy = typeof values.strategy === 'string' ? (values.strategy as PromptStrategy) : undefined

  const result = await runAnchorBenchmark({
    repoPath: repo,
    since,
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    ...(minTruth !== undefined && Number.isFinite(minTruth) ? { minTruthFiles: minTruth } : {}),
    ...(maxTruth !== undefined && Number.isFinite(maxTruth) ? { maxTruthFiles: maxTruth } : {}),
    ...(strategy ? { promptStrategy: strategy } : {}),
  })

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    process.stdout.write(formatResult(result) + '\n')
  }
}

main().catch((err) => {
  process.stderr.write(`phorge-benchmark: ${err instanceof Error ? err.message : String(err)}\n`)
  if (process.env.PHORGE_DEBUG) console.error(err)
  process.exit(1)
})
