---
description: Phorge — fetch pre-planning context (anchors + co-change + complexity + graph + volatility) for the current Laravel or TypeScript/Vue/Nuxt repo
---

Call the `phorge_brief` MCP tool with `promptText: "$ARGUMENTS"` and `repoPath: "$CLAUDE_PROJECT_DIR"`.

If the MCP tool is unavailable, fall back to the CLI:

!`phorge brief --prompt "$ARGUMENTS" --repo "$CLAUDE_PROJECT_DIR"`

Use the returned markdown bundle as the primary planning context. Cite anchor files when proposing edits and respect complexity / volatility warnings before writing.
