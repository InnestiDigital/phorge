---
name: phorge-cochange-check
description: Find files that historically change together with a target file. Use when you are about to edit any source file in a supported repo (Laravel, TS/Vue/Nuxt, etc.) and want to surface its co-change neighbors — sibling files that the team consistently updates in the same commits (tests, related models, parallel jobs/listeners, paired components/composables). Prevents incomplete plans that miss obvious sibling updates.
allowed-tools: Bash(phorge:*)
paths: "**/*.php,**/*.ts,**/*.tsx,**/*.vue"
argument-hint: <relative-path-to-source-file>
---

# Phorge — co-change neighbors

Before finalizing edits to a file, surface its co-change neighbors. If a file
has consistently been edited alongside test files or sibling implementations,
the user's plan probably needs to update those too.

## When to invoke

- After picking the primary file to edit, before producing the multi-file plan
- When the user asks "what else needs to change if I touch X?"
- When the plan only touches one file but the file has known sibling
  dependencies (controller without test update, job without listener update,
  etc.)

## How to invoke

MCP:
```
phorge_cochange({
  filePath: "<repo-relative path>",
  repoPath: "$CLAUDE_PROJECT_DIR"
})
```

CLI:
```bash
phorge cochange <path/to/File.php-or-File.ts-or-Component.vue> --repo "$CLAUDE_PROJECT_DIR"
```

## What you'll receive

A list of files with coupling percentages and joint-commit counts:

```
60%  tests/Feature/Foo/BarTest.php  (6 joint commits)
50%  app/Jobs/Foo/SiblingJob.php     (4 joint commits)
33%  app/Models/Foo.php              (3 joint commits)
```

## What to do with it

- **>= 60% coupling, >= 5 joint commits**: very likely needs parallel edit.
  Add to plan or ask user explicitly if they want to defer.
- **30–60% coupling**: mention as a soft suggestion in plan output.
- **< 30%**: ignore unless user asks.

## Skip when

- File has no co-change data (fresh file, low churn)
- Co-change list is empty (file is touched in isolation by convention)
