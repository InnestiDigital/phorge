---
description: Phorge — resolve a free-form prompt to a ranked list of anchor files (corpus + lexical + graph expansion)
---

Call the `phorge_anchors` MCP tool with `promptText: "$ARGUMENTS"` and `repoPath: "$CLAUDE_PROJECT_DIR"`.

If the MCP tool is unavailable, fall back to the CLI:

!`phorge anchors --prompt "$ARGUMENTS" --repo "$CLAUDE_PROJECT_DIR"`

Present the ranked anchor files with their scores and reasons. Treat the top entries as the entry points for further exploration or planning.
