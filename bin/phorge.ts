#!/usr/bin/env node
// phorge — zero-LLM static intelligence for Laravel coding agents.

import { parseCli, fail, printText } from '../src/cli/args'
import { runAnchors } from '../src/cli/commands/anchors'
import { runCoChange } from '../src/cli/commands/cochange'
import { runVolatility } from '../src/cli/commands/volatility'
import { runRevertRisk } from '../src/cli/commands/revert-risk'
import { runComplexity } from '../src/cli/commands/complexity'
import { runCorpus } from '../src/cli/commands/corpus'
import { runValidatePlan } from '../src/cli/commands/validate-plan'
import { runGraph } from '../src/cli/commands/graph'
import { runBrief } from '../src/cli/commands/brief'
import { runMcp } from '../src/cli/commands/mcp'
import { runInstallHooks } from '../src/cli/commands/install-hooks'

const HELP = `phorge — static signals for Laravel coding agents

Usage: phorge <command> [args] [--repo <path>] [--json]

Commands:
  brief          One-shot pre-planning context bundle (anchors + co-change +
                 complexity + volatility + graph subgraph) for prompt injection
                   phorge brief --prompt "fix refund flow" --repo . [--top 8]

  anchors        Resolve a user prompt to ranked anchor files+symbols
                   phorge anchors --prompt "fix refund flow" --repo .

  cochange       List files that historically co-change with <file>
                   phorge cochange app/Services/RefundService.php

  volatility     Risk profile (churn + bug-fix density) per file or top-20
                   phorge volatility app/Services/RefundService.php
                   phorge volatility                       (top 20)

  revert-risk    Files with revert chains (fragility signal)
                   phorge revert-risk app/Services/RefundService.php
                   phorge revert-risk                      (top 20)

  complexity     LOC / churn / refactor-risk profile per file
                   phorge complexity app/Services/RefundService.php

  corpus build   Force rebuild commit corpus cache
  corpus stats   Show stats for cached corpus

  graph build    Scan Laravel repo and persist .phorge/graph.json
                   phorge graph build --repo .
  graph query    Render subgraph for a symbol (key, fqcn, or name)
                   phorge graph query OrderController --repo . [--depth 2]
  graph stats    Show stats for cached graph
                   phorge graph stats --repo .

  validate-plan  Run deterministic plan validator against a plan file
                   phorge validate-plan plan.txt --repo .

  mcp serve      Run an MCP server (stdio) exposing phorge tools to AI agents
                   phorge mcp serve

  install-hooks  Install a Husky-compatible pre-commit hook that runs
                 \`phorge validate-plan\` against .phorge/pending-plan.txt
                   phorge install-hooks --repo .

Common flags:
  --repo <path>     Target repo (default: cwd)
  --since <date>    Commit window start (default: 36 months ago)
  --json            JSON output instead of human-readable text
  --help            Show this help

Cache:
  Corpus cached under <repo>/.phorge/corpus.json with 24h TTL.
  Force refresh with: phorge corpus build
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cli = parseCli(argv)

  if (cli.command === 'help' || cli.flags.help) {
    printText(HELP)
    return
  }

  const dispatch: Record<string, (cli: ReturnType<typeof parseCli>) => Promise<void>> = {
    anchors: runAnchors,
    cochange: runCoChange,
    'co-change': runCoChange,
    volatility: runVolatility,
    'revert-risk': runRevertRisk,
    reverts: runRevertRisk,
    complexity: runComplexity,
    corpus: runCorpus,
    'validate-plan': runValidatePlan,
    graph: runGraph,
    brief: runBrief,
    mcp: runMcp,
    'install-hooks': runInstallHooks,
  }

  const handler = dispatch[cli.command]
  if (!handler) fail(`unknown command: ${cli.command}\n\n${HELP}`)

  await handler(cli)
}

main().catch(err => {
  process.stderr.write(`phorge: ${err instanceof Error ? err.message : String(err)}\n`)
  if (process.env.PHORGE_DEBUG) console.error(err)
  process.exit(1)
})
