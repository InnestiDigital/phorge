---
description: Phorge — list files that historically change together with the given source file
---

Call the `phorge_cochange` MCP tool with `filePath: "$ARGUMENTS"` and `repoPath: "$CLAUDE_PROJECT_DIR"`.

If the MCP tool is unavailable, fall back to the CLI:

!`phorge cochange "$ARGUMENTS" --repo "$CLAUDE_PROJECT_DIR"`

Show the co-change neighbors with their support / confidence scores. Flag any neighbor missing from the current plan as a likely sibling update.
