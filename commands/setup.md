---
description: Phorge — first-time setup; build the commit corpus and language-aware code graph caches under .phorge/
---

Call the `phorge_corpus_build` and `phorge_graph_build` MCP tools in parallel, both with `repoPath: "$CLAUDE_PROJECT_DIR"`.

If the MCP tools are unavailable, fall back to the CLI (run sequentially):

!`phorge corpus build --repo "$CLAUDE_PROJECT_DIR"`

!`phorge graph build --repo "$CLAUDE_PROJECT_DIR"`

Report commit count, file count, node count, and edge count so the user can confirm the caches were populated.
