---
name: phorge-risk-check
description: Profile the refactor risk of a specific PHP, TypeScript, Vue, or any source file in a supported language before editing it. Use right before issuing Edit or Write on a source file when you have not already checked it in this session. Returns volatility (churn, bug-fix density), AST complexity (cyclomatic, nesting, methods), and a HIGH/MEDIUM/LOW classification. If the file is HIGH risk, surface the warning to the user before patching in place.
allowed-tools: Bash(phorge:*)
paths: "**/*.php,**/*.ts,**/*.tsx,**/*.vue"
argument-hint: <relative-path-to-source-file>
---

# Phorge — file risk check

Before editing any source file in a supported repo (PHP for Laravel; TS / TSX
/ Vue for the TypeScript profile), check whether it's a high-risk target.
Large, churn-heavy, branch-heavy files often need decomposition before
in-place patching, not after.

## When to invoke

- About to call Edit or Write on a source file (`.php`, `.ts`, `.tsx`, `.vue`)
- File is in a typical source root (Laravel: `app/`, `routes/`, `database/`,
  `config/`, `tests/`; TS: `src/`, `app/`, `pages/`, `components/`,
  `composables/`, `stores/`, `tests/`)
- Haven't already checked this exact file in this session

## How to invoke

MCP:
```
phorge_complexity({
  filePaths: ["<repo-relative path>"],
  repoPath: "$CLAUDE_PROJECT_DIR"
})
```

CLI:
```bash
phorge complexity <path/to/File.php-or-File.ts-or-Component.vue> --repo "$CLAUDE_PROJECT_DIR"
```

## What to do with the result

- **risk=high**: tell the user "this file is high-risk: <reasons>". Suggest
  smaller atomic changes or a decomposition step before the planned edit.
- **risk=medium**: proceed but mention the warning briefly.
- **risk=low**: proceed silently — no need to mention.

## Reasons that push a file to HIGH

- `large file` (>300 lines) or `very large file` (>600 lines)
- `high churn` (>15 commits in window)
- `high bug-fix density` (>40% of commits were fixes)
- `high cyclomatic complexity` (>30 branches)
- `deep nesting` (>5 levels)
- `very long method` (single method >100 lines)
- Multiple revert chains in history

## Skip when

- The file is fresh / new (won't have churn data)
- Trivial single-line edit (typo)
- File outside the supported source roots for the active profile
