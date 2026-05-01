#!/usr/bin/env node
// Thin shim — direct invocation of `phorge install-hooks` for users who'd rather
// run the installer as its own binary. Delegates to the shared CLI command.

import { parseCli } from '../src/cli/args'
import { runInstallHooks } from '../src/cli/commands/install-hooks'

async function main(): Promise<void> {
  // Re-shape argv so parseCli sees a command name. Accept either:
  //   phorge-install-hooks --repo /path
  //   phorge-install-hooks /path
  const argv = process.argv.slice(2)
  const synthetic = ['install-hooks', ...argv]
  const cli = parseCli(synthetic)
  if (cli.positionals[0] && !cli.flags.repo) {
    cli.repoPath = cli.positionals[0]
  }
  await runInstallHooks(cli)
}

main().catch(err => {
  process.stderr.write(`phorge-install-hooks: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
