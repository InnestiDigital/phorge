---
description: Phorge — validate a draft plan with 6 deterministic checkers (cochange, revert, missing-test, structural-gap, complexity, rule)
---

Read the plan file at `$ARGUMENTS`, then call the `phorge_validate_plan` MCP tool with the file's contents as `planText` and `repoPath: "$CLAUDE_PROJECT_DIR"`.

If the MCP tool is unavailable, fall back to the CLI:

!`phorge validate-plan "$ARGUMENTS" --repo "$CLAUDE_PROJECT_DIR"`

Surface the verdict (pass / warn / revise) and every issue to the user. If the verdict is `revise`, do not start coding — refine the plan first.
