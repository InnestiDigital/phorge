---
description: Phorge — risk profile (volatility + AST complexity + churn) for a specific PHP/TS/Vue source file before editing
---

Call the `phorge_complexity` MCP tool with `filePaths: ["$ARGUMENTS"]` and `repoPath: "$CLAUDE_PROJECT_DIR"`.

If the MCP tool is unavailable, fall back to the CLI:

!`phorge complexity "$ARGUMENTS" --repo "$CLAUDE_PROJECT_DIR"`

Report the HIGH / MEDIUM / LOW classification along with cyclomatic complexity, nesting, churn, and bug-fix density. If HIGH, warn the user before any in-place edit.
