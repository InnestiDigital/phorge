# phorge

**Zero-LLM static intelligence for Laravel and TypeScript / Vue / Nuxt coding agents.**

Phorge gives a coding agent (Claude, Cursor, Copilot, custom) deterministic signals about your codebase **before it starts planning** — and validates the plan **before it starts coding**. No LLM calls. Pure git history + static analysis. Built-in profiles cover Laravel/PHP and TypeScript / Vue / Nuxt today; the profile interface is extensible (see [Language profiles](#language-profiles)).

## Install

```bash
npm install -g @innestidigital/phorge
```

Then in any supported repo (Laravel or TypeScript/Vue/Nuxt):

```bash
phorge corpus build
phorge graph build
phorge brief --prompt "fix refund flow"
```

Claude Code plugin:

```
/plugin install phorge
```

## Why

LLM coding agents walk blind into a repo. They guess which files matter, miss co-change patterns, ignore volatility, and produce plans that skip critical structural touchpoints. Phorge fixes that with cheap, fast, deterministic signals.

## What it provides

Given a user prompt like *"fix the refund flow for split-pay orders"*, phorge answers:

| Question | Output |
|----------|--------|
| Which files are involved? | Lexical anchor resolution (regex + synonyms + path tokens + graph expansion) → ranked file list |
| Which files usually co-change with these? | Co-change matrix from git history |
| Which are volatile / fragile? | Volatility map (churn, revert chains) |
| What's the structural neighborhood? | Language-aware code graph (Laravel: Controller → Service → Model; TS: component → composable → store, etc.) |
| How complex is this code? | File complexity profile (LOC, cyclomatic, refactor risk) |
| Does this plan look right? | Post-plan validator with deterministic checkers |

## Pipeline

```
User prompt
  → resolvePromptAnchors()           ── ranked anchor files
  → buildCommitCorpus()              ── git walk
  → buildCoChangeMatrix()            ── pair coupling
  → buildVolatilityMap()             ── churn metrics
  → buildRevertChains()              ── fragility signals
  → buildFileComplexityProfile()     ── per-file complexity
  → graph.getSubgraph(anchors)       ── language-aware structure
  → format*()                        ── prompt-ready text

[Agent plans...]

  → validatePlan(plan, deps)         ── pass | warn | revise
  → formatFindingsForRerun()         ── feedback for re-prompt
```

## Install

```bash
npm install @innestidigital/phorge
```

## Library usage

```ts
import {
  resolvePromptAnchors,
  buildCommitCorpus,
  buildCoChangeMatrix,
  buildVolatilityMap,
  validatePlan,
  GitCommitReader,
} from 'phorge'

const reader = new GitCommitReader()
const corpus = await buildCommitCorpus({
  reader,
  repo: 'my-laravel-app',
  repoRoot: '/path/to/repo',
  since: '2024-01-01',
})
const coChange = buildCoChangeMatrix({ corpus })

const anchors = await resolvePromptAnchors({
  promptText: 'fix the refund flow for split-pay orders',
  deps: { corpus, coChangeView: coChange, /* ... */ },
})
```

## CLI usage

```bash
phorge anchors --prompt "fix refund flow" --repo .
phorge cochange app/Services/RefundService.php --repo .
phorge volatility app/Services/RefundService.php --repo .
phorge graph app/Services/RefundService.php --repo .
phorge complexity app/Services/RefundService.php --repo .
phorge validate-plan plan.json --repo .
```

Output: text (prompt-ready) by default, `--json` for tool integrations.

## Examples

The `examples/` directory is the canonical entry point for new users. Each example is a single self-contained TypeScript file runnable directly:

```bash
npx tsx examples/01-anchors.ts /path/to/laravel-app
```

| Example | What it shows |
|---------|---------------|
| `01-anchors.ts` | Resolve a free-form prompt to a ranked list of anchor files (corpus + lexical + graph signals fused) |
| `02-cochange.ts` | List the files that historically co-change with a given file — "if you change X, you'll likely also change..." |
| `03-volatility-and-complexity.ts` | Top-N volatile files combined with AST complexity for refactor-risk profiling |
| `04-validate-plan.ts` | Programmatic `validatePlan()` against a synthetic plan, with full deps (corpus + graph + rules) |
| `05-prompt-injection.ts` | Compose anchors + co-change + complexity + subgraph into one markdown bundle to inject into a Claude/GPT/Cursor agent system prompt |
| `06-graph-walk.ts` | Load `.phorge/graph.json` and render a Laravel symbol's structural neighbourhood at depth 1 and 2 (run `phorge graph build` first) |

Each example takes the repo path as its first argument (defaults to `cwd`). They build any missing corpus cache automatically; only `06-graph-walk.ts` requires a pre-built graph.

## MCP Integration

`phorge mcp serve` starts an MCP (Model Context Protocol) server over stdio so any MCP-capable agent — Claude Desktop, Claude Code, Cursor, OpenAI Codex agents, custom MCP clients — can call phorge primitives as native tools.

Add to your client config (Claude Desktop / Claude Code `mcp.json`):

```json
{
  "mcpServers": {
    "phorge": {
      "command": "npx",
      "args": ["--package=@innestidigital/phorge", "--", "phorge", "mcp", "serve"],
      "env": {}
    }
  }
}
```

Tools exposed:

- `phorge_anchors` — prompt to ranked anchor files+symbols
- `phorge_cochange` — co-change neighbors for a file
- `phorge_volatility` — risk/churn profile per file or top-N
- `phorge_complexity` — LOC, cyclomatic, refactor-risk per file
- `phorge_graph_query` — rendered subgraph around a symbol (language-aware)
- `phorge_validate_plan` — run deterministic validator on plan text
- `phorge_brief` — bundled markdown brief for prompt injection
- `phorge_corpus_build` — pre-build the commit corpus cache
- `phorge_graph_build` — pre-build the language-aware code graph

All tools are zero-LLM — phorge stays deterministic; MCP is transport only.

## Claude Code plugin

Phorge ships as an installable Claude Code plugin. The plugin bundles:

- An MCP server registration (`.mcp.json`)
- Six skills that auto-trigger Claude to call phorge at the right session moments
- Optional `SessionStart` hook that auto-builds the corpus + graph caches when entering a supported repo (Laravel or TS/Vue/Nuxt)

### Skills (auto-triggered by Claude)

| Skill | Fires when |
|-------|-----------|
| `phorge-pre-planning` | User describes a non-trivial change to a supported repo (Laravel or TS/Vue/Nuxt) — before producing a plan |
| `phorge-risk-check` | Claude is about to edit a source file (PHP, TS, Vue, etc.) — checks volatility + complexity |
| `phorge-cochange-check` | Claude has picked a file to edit — surfaces co-changing siblings (tests, etc) |
| `phorge-explore-structure` | Claude needs to understand how a symbol is wired before structural changes |
| `phorge-validate-plan` | Claude has a draft plan — validates deterministically before writing code |
| `phorge-setup` | First time in a repo — builds corpus + graph caches |

### Install paths

**Plugin marketplace** (once published):

```
/plugin install phorge
```

**Manual plugin install** from a local checkout:

```bash
# In Claude Code:
/plugin install /path/to/phorge
```

**MCP only** (skip skills, manual config):

Add to `~/.claude.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "phorge": {
      "type": "stdio",
      "command": "npx",
      "args": ["--package=@innestidigital/phorge", "--", "phorge", "mcp", "serve"]
    }
  }
}
```

The plugin's `.mcp.json` registers the same server, so installing the plugin
auto-configures MCP — no extra step.

### Optional auto-build hook

The plugin includes a `SessionStart` hook (`hooks/hooks.json`) that runs
`phorge corpus build` and `phorge graph build` in the background when you
open a supported project (Laravel or TS/Vue/Nuxt) that doesn't yet have a
`.phorge/` cache. It's silent,
async, and bounded (timeouts of 30s/60s respectively). Disable by removing
the hook from your local plugin copy.

## Pre-commit hook

Install a Husky-compatible pre-commit hook that runs `phorge validate-plan`
against `<repo>/.phorge/pending-plan.txt` before each commit. If the verdict
is `revise`, the commit is blocked with the validator findings as feedback.

```bash
phorge install-hooks --repo <path>
```

Workflow:

1. Agent (or developer) writes the draft plan to `<repo>/.phorge/pending-plan.txt`
2. `git commit` triggers `.husky/pre-commit`
3. Hook calls `phorge validate-plan` — exit code `2` (verdict=revise) blocks the commit
4. Bypass for one commit: `PHORGE_SKIP_PRECOMMIT=1 git commit ...`

The hook is a vanilla shell script that lives at `.husky/pre-commit`. Husky
auto-runs it via `prepare`. Without husky, symlink it manually:

```bash
ln -s ../../.husky/pre-commit .git/hooks/pre-commit
```

Re-running `phorge install-hooks` is idempotent — it replaces the phorge block
in-place and preserves any other hook content.

## Language profiles

Phorge ships two built-in language profiles. The profile drives file-scope filtering, lexical synonyms, graph extraction, and complexity analysis.

| Profile id | Detection | Notes |
|-----------|-----------|-------|
| `laravel` | `composer.json` containing `laravel/framework` | Battle-tested. Full graph (routes, jobs, events, listeners, observers, service bindings) via `php-parser`. |
| `ts` | `package.json` with one of: `typescript`, `nuxt`, `@nuxt/kit`, `vue`, `@vue/compiler-sfc`, `next`, `react`, `svelte`, `astro`, `vite` (root or up to depth 2 for monorepos); OR `tsconfig.json` plus `.ts` / `.tsx` / `.vue` files under `src/`, `app/`, or `packages/` | Newer profile. Covers TS / Vue / Nuxt / Next / React / Svelte / Astro repos. Graph coverage is narrower than Laravel's — expect fewer edge types. |

Profiles are auto-detected from `repoPath`. To force a profile, pass `--lang <id>`:

```bash
phorge brief --prompt "..." --repo . --lang ts
phorge anchors --prompt "..." --repo . --lang laravel
```

If detection fails and no override is given, phorge falls back to a language-neutral null profile (lexical-only — no graph, no AST complexity).

### Writing your own profile

A profile is one module that exports an object satisfying `LanguageProfile` (`src/profiles/contracts/language-profile.ts`): `{ id, name, fileScope, lexical, detector, graph, complexity, testPaths }`. Each contract is a small interface in `src/profiles/contracts/`. Implement them, then call `defaultRegistry.register(yourProfile)` at startup. The Laravel and TS profiles under `src/profiles/laravel/` and `src/profiles/ts/` are the reference implementations.

## Project config

Tune phorge per-repo without forking the package. Drop a `.phorge/config.json` (preferred — committed so the team shares it) or `phorge.config.json` at the repo root. `.phorge/config.json` wins when both exist.

```json
{
  "profileOverride": "laravel",
  "synonyms": [["refund", "reimburse", "credit"]],
  "pathStopwords": ["http", "controllers"],
  "pathRoles": [
    { "glob": "app/Http/Controllers/Member/**", "tags": ["member-facing"] }
  ],
  "edgeWeights": [
    { "edgeKind": "dispatches_job", "whenPromptContains": ["async"], "multiplier": 1.5 }
  ],
  "alwaysInclude": ["app/Services/RefundService.php"],
  "alwaysExclude": ["app/Legacy/**"],
  "confidenceBoosts": [
    { "source": "lexical", "from": "low", "to": "medium" }
  ]
}
```

| Field | Effect |
|-------|--------|
| `profileOverride` | Force a profile id, skipping auto-detect. Caller `--lang` still wins. |
| `synonyms` | Extra synonym groups, concatenated with the active profile's. |
| `pathStopwords` | Extra path-token stopwords, set-unioned with the profile's. |
| `pathRoles` | Tag globs with semantic roles for downstream consumers. Stored only. |
| `edgeWeights` | Boost graph edge weights when prompt matches keywords. Stored only. |
| `alwaysInclude` | Hard-include paths — surfaced as `project_config`/`high` regardless of score. |
| `alwaysExclude` | Hard-exclude paths — dropped from anchor results. Glob (`**`, `*`, `?`). |
| `confidenceBoosts` | Lift anchor confidence per `(source, from)` rule. |

Validation errors print a stderr warning and phorge proceeds with the built-in profile — config is optional and additive. See `examples/phorge-config-example.json` for the full reference.

## Limits & honest expectations

Phorge is deterministic static intelligence, not a model. Calibrate expectations accordingly.

**Lexical, not semantic.** Prompts resolve via regex + synonym + path-token matching plus graph expansion. Phorge does not understand intent. "the auth thing the client mentioned yesterday" works only if the synonym map covers those tokens; "the bug Bob reported last Friday" cannot resolve.

**Synonym tuning is per-domain.** Built-in `laravel` and `ts` profiles ship sensible defaults, but every codebase has conventions phorge does not know. Add domain groups via `<repo>/.phorge/config.json` synonyms — e.g. `[engagement, points, redemption]` or `[member-app, mobile, capacitor]`. See [Project config](#project-config). Most precision wins come from this file.

**Compositional prompts are best-effort.** Patterns like "X vs Y", "review X against Y", "gaps between X and Y" trigger split-anchor pipelines and render two subject sections. False positives exist: "protect the API against XSS attacks" will incorrectly split. Inspect the brief and rephrase if the split is wrong; a `--compositional/--no-compositional` flag may land later.

**Graph coverage varies by language.** The Laravel scanner has 9 specialized passes (routes, controllers, jobs, events, observers, policies, bindings, commands, resources/transformers) — the graph is dense. The TS scanner is shallower: file/component/composable/store/route nodes with `imports`, `defines`, `vue_renders`, `route_to_component`, `component_uses_*`, `calls`. Both are extensible — see `src/profiles/contracts/`.

**Quality benchmarks.** `npm run bench` runs the harness. Most-recent reach-api numbers (pre-call-graph, pre-role-boost): avg P@10 ~10%, R@10 ~55%, zero-hit ~23%. Recall is the stronger metric; precision still has room on irrelevant top-K matches. Treat phorge output as "places to look", not "exact files to edit". Numbers improve as the repo's `phorge.config.json` is tuned.

**Where phorge surprises in a good way.** The co-change matrix surfaces non-obvious sibling tests/jobs/listeners that experienced devs forget. Volatility flags fragile high-churn files before edits. AST complexity catches refactor risk LOC alone misses. The validator's structural-gap checker catches plans that touch a controller without updating its dispatched job.

**Where phorge will fail you.** Prompts needing semantic reasoning ("compare these implementations for correctness", "find the bug in our SSO flow"). Repos with poor commit hygiene (squash merges, autotitled merge commits, empty bodies) — corpus signal degrades. New repos with <50 commits — no co-change/volatility signal. Unsupported languages — empty graph, brief degrades to LOC + file-token matching only.

**Tuning.** Most precision wins come from tuning `<repo>/.phorge/config.json` synonyms + `alwaysInclude`/`alwaysExclude`. See [Project config](#project-config).

## Cache

Phorge caches the commit corpus under `<repo>/.phorge/corpus-<key>.json`, where `<key>` is derived from `git HEAD sha + --since + filter config version`. The cache invalidates automatically when:

- HEAD moves (new commits, rebase, branch switch)
- `--since` changes
- The filter config version is bumped (filter logic change)

`corpus-current.json` is a pointer file with the current key, HEAD, and generated-at timestamp. Stale entries are pruned on write: anything older than 30 days, or beyond the 5 most-recent entries, is deleted.

Add `.phorge/` to your repo's `.gitignore` — it's a per-checkout cache, not source.

If `git rev-parse HEAD` fails (non-git directory or no commits), phorge falls back to a 24h TTL cache at `.phorge/corpus.json` and logs a one-time warning.

## Status

Two built-in profiles: `laravel` (battle-tested; PHP graph via `php-parser`) and `ts` (newer; TypeScript / Vue / Nuxt / Next / React / Svelte / Astro). Other languages plug in via the `LanguageProfile` contract — see [Language profiles](#language-profiles).

## License

MIT
