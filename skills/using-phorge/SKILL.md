---
name: using-phorge
description: Use when starting any conversation in a Laravel or TypeScript/Vue/Nuxt repo with phorge installed. Establishes that phorge skills MUST be invoked when relevant — pre-planning context before producing plans, risk-check before editing source files, validate-plan before writing code, cochange-check when picking files, explore-structure before structural changes, setup when caches missing. Non-negotiable for supported repos.
paths: "**/composer.json,**/package.json"
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a single narrow task (one file edit, one search, one shell command), skip this skill. The dispatching agent has already done the planning work this skill governs.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If any phorge skill or tool might apply to what you are doing, you MUST invoke it.

This is not negotiable. This is not optional. You cannot rationalize your way out of this.

Phorge is zero-LLM. Invoking it costs no tokens of reasoning budget — it returns deterministic facts about the repo. Skipping it means producing plans against a codebase you have not actually inspected. Do not skip.
</EXTREMELY-IMPORTANT>

## Instruction Priority

Phorge skills override default behavior, but **user instructions always take precedence**:

1. **User's explicit instructions** (CLAUDE.md, AGENTS.md, GEMINI.md, direct chat) — highest priority
2. **Phorge skills** — override default planning/editing behavior in supported repos
3. **Default system prompt** — lowest priority

If the user says "skip phorge", "don't use phorge", or "just edit it", obey. The user is in control. Otherwise the rules below apply.

## Detection — does this repo qualify?

Phorge applies when the repo root (or any ancestor of the file you are editing) contains:

- **Laravel profile**: `composer.json` whose `require` includes `laravel/framework`
- **TypeScript profile**: `package.json` whose `dependencies` or `devDependencies` include any of: `typescript`, `nuxt`, `vue`, `next`, `react`, `svelte`, `astro`, `vite`

If neither matches, phorge does not apply — proceed normally.

If a `.phorge/` directory exists at the repo root, caches are present and tools will return instantly.

## Sub-skill routing

Match the moment in the session to the right skill:

| Moment | Skill |
|--------|-------|
| User describes a non-trivial change ("fix", "refactor", "add", "modify") | `phorge-pre-planning` |
| About to call `Edit` or `Write` on a source file | `phorge-risk-check` |
| Picked a file to edit, before finalizing the plan | `phorge-cochange-check` |
| Need to understand how a symbol is wired (routes, dispatchers, traits) | `phorge-explore-structure` |
| Have a draft multi-file plan, before writing code | `phorge-validate-plan` |
| First time in this repo, or any tool reports "no corpus" / "graph not built" | `phorge-setup` |

Invoke skills via the `Skill` tool. Do not Read the SKILL.md files directly.

## MCP tools

When the phorge MCP server is connected, these tools are available directly (no skill wrapper required):

- `phorge_brief` — one-shot bundle: anchors + co-change + volatility + complexity + graph for a ticket. **Preferred when starting fresh.**
- `phorge_anchors` — ranked file list for a ticket
- `phorge_cochange` — sibling files that historically change together
- `phorge_volatility` — churn + bug-fix density per file
- `phorge_complexity` — AST complexity (cyclomatic, nesting, methods)
- `phorge_graph_query` — structural neighborhood of a symbol
- `phorge_validate_plan` — six-checker plan validator
- `phorge_corpus_build` — build commit corpus cache
- `phorge_graph_build` — build structural graph cache

Use `phorge_brief` first when picking up a new ticket. The other tools are for follow-up drilling.

## CLI fallback

If the MCP server is not running, every tool has a `phorge <subcommand>` CLI equivalent runnable via `Bash`:

```
phorge brief --ticket <id>
phorge anchors --ticket <id>
phorge cochange --file <path>
phorge volatility --file <path>
phorge complexity --file <path>
phorge graph query --symbol <name>
phorge validate-plan --plan <path>
phorge corpus build
phorge graph build
```

Skills detect MCP availability and fall back to CLI automatically.

## Slash commands

Users can force invocation directly:

- `/phorge:brief` — full pre-planning bundle
- `/phorge:validate-plan` — run plan validator
- `/phorge:anchors` — ranked candidate files
- `/phorge:risk` — volatility + complexity for a file
- `/phorge:cochange` — sibling files
- `/phorge:setup` — build caches

If the user types one of these, run it — do not second-guess.

## When to skip phorge

- Pure question with no edit intent ("what does this function do?")
- Trivial single-line edit (typo, formatting, import sort)
- Repo matches no phorge profile (not Laravel, not a supported JS/TS framework)
- User explicitly said skip phorge
- You are a subagent given a narrow task by a parent that already planned

In every other case, invoke the relevant skill or tool.

## Common failures and fixes

| Symptom | Fix |
|---------|-----|
| `phorge: no corpus` or `graph not built` | Invoke `phorge-setup` skill, then retry |
| Anchors list is empty or irrelevant | Check `<repo>/.phorge/config.json` synonyms; for comparisons use compositional patterns like "X vs Y" instead of one term |
| Anchor list looks wrong | Tighten `synonyms` in project config or add `alwaysInclude` entries |
| MCP tool returns connection error | Fall back to `phorge <subcommand>` via Bash |
| `validate-plan` returns `revise` | Refine the plan to address the surfaced gaps before writing code — do not override |

## The rule

In a supported repo, before producing a plan or editing source: invoke phorge. Before claiming a plan is ready: validate it. Before patching a file you have not profiled: risk-check it. No exceptions outside the skip list above.
