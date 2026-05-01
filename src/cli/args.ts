// CLI argument parsing — thin wrapper around node:util parseArgs.
//
// Phorge CLI uses a stable subcommand/flag layout:
//   phorge <command> [positional...] [--flag value] [--bool]

import { parseArgs as nodeParseArgs } from 'node:util'
import { resolve } from 'node:path'

export type ParsedCli = {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean | string[]>
  json: boolean
  repoPath: string
  since: string | undefined
}

export function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    return { command: 'help', positionals: [], flags: { help: true }, json: false, repoPath: process.cwd(), since: undefined }
  }

  const [command, ...rest] = argv

  const { values, positionals } = nodeParseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      repo: { type: 'string', short: 'r' },
      since: { type: 'string' },
      json: { type: 'boolean' },
      prompt: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
      output: { type: 'string', short: 'o' },
      'min-coupling': { type: 'string' },
      'min-commits': { type: 'string' },
      'top-k': { type: 'string' },
      top: { type: 'string' },
      symbol: { type: 'string', short: 's' },
      depth: { type: 'string' },
      plan: { type: 'string' },
      corpus: { type: 'string' },
      cochange: { type: 'string' },
      volatility: { type: 'string' },
      reverts: { type: 'string' },
      graph: { type: 'string' },
      'rules-dir': { type: 'string', multiple: true },
      lang: { type: 'string' },
    },
  })

  return {
    command,
    positionals,
    flags: values as Record<string, string | boolean | string[]>,
    json: Boolean(values.json),
    repoPath: resolve(typeof values.repo === 'string' ? values.repo : process.cwd()),
    since: typeof values.since === 'string' ? values.since : undefined,
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

export function printText(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : value + '\n')
}

export function fail(msg: string, exitCode = 1): never {
  process.stderr.write(`phorge: ${msg}\n`)
  process.exit(exitCode)
}

export function defaultSince(): string {
  // 36 months ago, ISO date
  const d = new Date()
  d.setMonth(d.getMonth() - 36)
  return d.toISOString().slice(0, 10)
}
