---
name: phorge-setup
description: One-time setup helper for phorge in a new repo (Laravel or TS/Vue/Nuxt — any supported language profile). Use when any other phorge tool reports "no corpus" or "graph not built" — builds the commit corpus and language-aware graph caches under .phorge/. Idempotent. Takes 5-15s on first run, sub-second on subsequent calls (cached). Run once per repo per HEAD.
allowed-tools: Bash(phorge:*) Bash(test:*)
paths: "**/composer.json,**/package.json,**/*.php,**/*.ts,**/*.tsx,**/*.vue"
---

# Phorge — first-time setup

Phorge needs two caches in a repo before its other tools can return useful
data:

1. **Commit corpus** (`<repo>/.phorge/corpus-<key>.json`) — git history walk
2. **Code graph** (`<repo>/.phorge/graph.json`) — language-aware AST scan
   (PHP for the Laravel profile; TS / Vue for the TypeScript profile)

Both are cheap (seconds) and cached, but not auto-built.

## When to invoke

- Another phorge skill reports "graph not built" or "no corpus"
- First time using phorge in this repo
- After a major rebase or branch change (corpus auto-invalidates by HEAD,
  graph does not — rebuild manually if classes were renamed)

## How to invoke

MCP (run both in parallel):
```
phorge_corpus_build({ repoPath: "$CLAUDE_PROJECT_DIR" })
phorge_graph_build({ repoPath: "$CLAUDE_PROJECT_DIR" })
```

CLI:
```bash
phorge corpus build --repo "$CLAUDE_PROJECT_DIR"
phorge graph build --repo "$CLAUDE_PROJECT_DIR"
```

## What you'll receive

Status messages confirming:
- Corpus: `<N> commits considered, <M> kept`
- Graph: `<N> source files, <K> nodes, <E> edges` (file kind depends on the active profile)

## What to do with it

After both succeed, retry whatever phorge skill failed previously. The cache
will satisfy subsequent calls until HEAD changes.

## Don't run when

- Already built within this session (idempotent but wasteful)
- Repo matches no supported language profile (graph build will be a no-op)
- Repo is non-git (corpus build will degrade to TTL-only mode with a warning)

## .phorge cache directory

Both files land under `<repo>/.phorge/`. Add this dir to `.gitignore` if not
already excluded — it's per-checkout, not source.
