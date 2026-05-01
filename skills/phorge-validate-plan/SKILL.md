---
name: phorge-validate-plan
description: Run the deterministic plan validator on a draft plan before writing code. Use after producing a multi-file plan but before issuing Edit/Write tool calls. Surfaces missing tests, broken co-change pairs, structural gaps, revert-risk warnings, and complexity hot spots — six checkers, all zero-LLM. Returns pass/warn/revise verdict. If verdict is revise, refine the plan before coding.
allowed-tools: Bash(phorge:*) Write
paths: "**/composer.json,**/package.json,**/*.php,**/*.ts,**/*.tsx,**/*.vue"
---

# Phorge — plan validator

Once you've drafted a multi-file plan, validate it deterministically before
writing any code. Faster and cheaper than asking the user to review.

## When to invoke

- You've produced a plan that touches >= 2 files
- Plan is in a form you'd be about to execute (file paths + change summaries)
- Repo matches a supported language profile (Laravel, TS/Vue/Nuxt, etc.)

## How to invoke

1. Write the plan as plain markdown text to a temp file:
   ```
   /tmp/phorge-plan-<session>.txt
   ```
   Format example (Laravel):
   ```
   # Plan: <short title>

   1. Update <path/to/File.php> to <change>
   2. Adjust <path/to/Other.php>
   3. Add test in <path/to/SomeTest.php>
   ```

   Format example (TS / Vue / Nuxt):
   ```
   # Plan: <short title>

   1. Update <src/composables/useCart.ts> to <change>
   2. Adjust <components/Cart.vue>
   3. Add test in <tests/unit/useCart.spec.ts>
   ```

2. Validate via MCP:
   ```
   phorge_validate_plan({
     planText: "<plan markdown>",
     repoPath: "$CLAUDE_PROJECT_DIR"
   })
   ```

   Or CLI:
   ```bash
   phorge validate-plan /tmp/phorge-plan-<session>.txt --repo "$CLAUDE_PROJECT_DIR"
   ```

## What you'll receive

A verdict (`pass | warn | revise`) plus a list of issues across six checkers:
- `missing-test` — code change without test update
- `cochange` — file edited without its co-change sibling
- `revert-risk` — file with revert chain history flagged
- `structural-gap` — graph relation missing in plan (e.g. job dispatched but
  not listed)
- `complexity` — high-complexity file edited without decomposition
- `rule` — explicit `.mdc` rule violation (if rules are configured)

## What to do with it

- **pass**: proceed to code execution
- **warn**: surface the warnings to the user, ask whether to amend or proceed
- **revise**: amend the plan to address the findings, then re-validate. Don't
  start coding yet.

## Pre-commit hook (optional)

For developers who want validation enforced at the git layer, install the
Husky-compatible pre-commit hook:

```bash
phorge install-hooks --repo .
```

Workflow: agent writes the draft plan to `.phorge/pending-plan.txt`, the
developer runs `git commit`, and the hook runs `phorge validate-plan`. If the
verdict is `revise`, the commit is blocked with the validator output as
feedback. Bypass with `PHORGE_SKIP_PRECOMMIT=1 git commit ...`.

## Skip when

- Single-file trivial edit (no co-change/structural risk)
- User explicitly skips validation ("just do it")
- Plan is exploratory / hypothetical
