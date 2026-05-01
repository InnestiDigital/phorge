---
name: phorge-pre-planning
description: Fetch deterministic pre-planning context for a Laravel/PHP, TypeScript/Vue/Nuxt, or any other supported language profile repo before producing a plan. Use when the user describes any non-trivial change ("fix", "refactor", "add", "modify") to a codebase that contains composer.json with laravel/framework, OR package.json with typescript/nuxt/vue/next/react/svelte. Returns ranked anchor files, co-change relationships, AST complexity warnings, graph subgraph, and volatility hints — without LLM cost. Skip for trivial single-line edits or unsupported projects.
allowed-tools: Bash(phorge:*) Bash(grep:*) Bash(test:*)
paths: "**/composer.json,**/package.json,**/*.php,**/*.ts,**/*.tsx,**/*.vue"
---

# Phorge — pre-planning context

Before producing a plan for any non-trivial change in a supported repo
(Laravel or TypeScript / Vue / Nuxt today; more profiles pluggable), fetch
deterministic context via `phorge_brief` (MCP) or `phorge brief` (CLI fallback).

## When to invoke

Trigger when ALL of the following hold:

1. The repo matches a supported language profile — either `composer.json`
   with `"laravel/framework"`, OR `package.json` with one of
   `typescript`/`nuxt`/`vue`/`next`/`react`/`svelte`/`astro`/`vite` (verify
   with `test -f composer.json && grep -q laravel/framework composer.json`,
   or `test -f package.json && grep -qE '"(typescript|nuxt|vue|next|react|svelte)"' package.json`).
2. The user is asking for a change that will likely touch more than one file
   or symbol — refactor, feature add, bug fix spanning components, etc.
3. You haven't already fetched a brief for this prompt in this turn.

## How to invoke

Prefer the MCP tool when available:

```
phorge_brief({
  promptText: "<user's full request, as-is>",
  repoPath: "<absolute path to repo root, usually $CLAUDE_PROJECT_DIR>",
  top: 8
})
```

CLI fallback if MCP not configured:

```bash
phorge brief --prompt "<user's request>" --repo "$CLAUDE_PROJECT_DIR"
```

## What you'll receive

A markdown bundle with:
- Ranked anchor files (top 8) with inline complexity + churn + risk metadata
- Co-change relationships (files that historically change together)
- Volatility hints (fragile files in scope)
- Graph subgraph showing structural neighbors (Laravel: Controller → Service → Model; TS: component → composable → store, route → page, etc.)
- Notes section confirming graph + corpus state

## What to do with it

Treat the brief as primary planning context. When you produce your plan:
- Reference the anchor files as starting points
- Mention co-change targets that need parallel updates (e.g. tests)
- Flag HIGH-complexity files as risky to patch in place
- Use the graph subgraph to understand wiring before suggesting structural changes

## Skip when

- Single-file trivial edit (typo, comment, formatting)
- Project matches no supported language profile (no Laravel composer marker, no TS/Vue/Nuxt package marker)
- User is asking a pure question (no edit intent)

## First-time setup

If the brief reports `Graph: not built` or fails with "no corpus", trigger
the `phorge-setup` skill once before retrying.
