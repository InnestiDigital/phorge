// `phorge install-hooks` — write a Husky-compatible pre-commit hook that runs
// `phorge validate-plan` against `<repo>/.phorge/pending-plan.txt` and aborts
// the commit if the verdict is `revise` (validate-plan exits 2).

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { printText, type ParsedCli } from '../args'

const PHORGE_BLOCK_START = '# >>> phorge pre-commit hook >>>'
const PHORGE_BLOCK_END = '# <<< phorge pre-commit hook <<<'

const PHORGE_BLOCK = `${PHORGE_BLOCK_START}
# Validates a pending plan before letting the commit through.
# Disable with PHORGE_SKIP_PRECOMMIT=1.

PENDING_PLAN="$(git rev-parse --show-toplevel)/.phorge/pending-plan.txt"
if [ -f "$PENDING_PLAN" ] && [ "\${PHORGE_SKIP_PRECOMMIT:-0}" != "1" ]; then
  if ! command -v phorge >/dev/null 2>&1; then
    echo "[phorge] not installed — skipping plan validation. Install: npm i -g @innestidigital/phorge"
  else
    phorge validate-plan "$PENDING_PLAN" --repo "$(git rev-parse --show-toplevel)"
    PHORGE_STATUS=$?
    # phorge validate-plan exits 2 on verdict=revise; treat as commit-block.
    if [ "$PHORGE_STATUS" -eq 2 ]; then
      echo ""
      echo "[phorge] Plan validation: revise required. Fix the findings above (or set PHORGE_SKIP_PRECOMMIT=1)."
      exit 1
    fi
  fi
fi
${PHORGE_BLOCK_END}`

const HOOK_HEADER = `#!/usr/bin/env sh
# phorge pre-commit hook — see \`phorge install-hooks\`.
`

export type InstallHooksResult = {
  repoPath: string
  hookPath: string
  created: boolean
  appended: boolean
}

export function installHooks(repoPath: string): InstallHooksResult {
  const root = resolve(repoPath)
  if (!existsSync(root)) throw new Error(`install-hooks: repo path not found: ${root}`)

  const huskyDir = join(root, '.husky')
  mkdirSync(huskyDir, { recursive: true })

  const hookPath = join(huskyDir, 'pre-commit')
  let created = false
  let appended = false

  if (!existsSync(hookPath)) {
    writeFileSync(hookPath, `${HOOK_HEADER}\n${PHORGE_BLOCK}\n`, 'utf-8')
    created = true
  } else {
    const existing = readFileSync(hookPath, 'utf-8')
    if (existing.includes(PHORGE_BLOCK_START)) {
      // Replace existing block (idempotent re-install picks up template changes).
      const before = existing.slice(0, existing.indexOf(PHORGE_BLOCK_START))
      const afterIdx = existing.indexOf(PHORGE_BLOCK_END)
      const after = afterIdx >= 0
        ? existing.slice(afterIdx + PHORGE_BLOCK_END.length)
        : ''
      writeFileSync(hookPath, `${before}${PHORGE_BLOCK}${after}`, 'utf-8')
    } else {
      const sep = existing.endsWith('\n') ? '' : '\n'
      writeFileSync(hookPath, `${existing}${sep}\n${PHORGE_BLOCK}\n`, 'utf-8')
      appended = true
    }
  }

  try { chmodSync(hookPath, 0o755) } catch { /* best-effort: some FS lack chmod */ }

  return { repoPath: root, hookPath, created, appended }
}

export async function runInstallHooks(cli: ParsedCli): Promise<void> {
  const result = installHooks(cli.repoPath)

  const lines = [
    `phorge: pre-commit hook ${result.created ? 'installed' : result.appended ? 'appended' : 'updated'} at ${result.hookPath}`,
    '',
    'Workflow:',
    `  1. Agent writes draft plan to ${join(result.repoPath, '.phorge/pending-plan.txt')}`,
    '  2. Developer runs `git commit`',
    '  3. Hook invokes `phorge validate-plan` — verdict=revise blocks the commit',
    '',
    'Disable for one commit:  PHORGE_SKIP_PRECOMMIT=1 git commit ...',
    '',
    'Husky users: ensure `"prepare": "husky"` is in package.json scripts and run `npm run prepare` once.',
    'Without husky: symlink it into .git/hooks so git picks it up:',
    `  ln -s ../../.husky/pre-commit ${join(result.repoPath, '.git/hooks/pre-commit')}`,
  ]
  printText(lines.join('\n'))
}
