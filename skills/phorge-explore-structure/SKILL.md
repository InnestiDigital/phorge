---
name: phorge-explore-structure
description: Render the structural neighborhood of a language-aware symbol (class, controller, component, composable, store, etc.). Use when you need to understand how a piece of code is wired (what dispatches it, what it implements, what traits it uses, where its routes are; or for TS/Vue/Nuxt: what imports it, where it's mounted, what composables it consumes) before suggesting structural changes. Returns a depth-1 or depth-2 subgraph with annotated edges.
allowed-tools: Bash(phorge:*)
paths: "**/*.php,**/*.ts,**/*.tsx,**/*.vue"
argument-hint: <symbol-name-or-FQN-or-method-ref>
---

# Phorge — structural neighborhood

Before proposing structural changes (renaming a class, splitting a service,
moving a job), inspect how the symbol is connected to the rest of the codebase.

## When to invoke

- Plan involves renaming, moving, or restructuring an artifact (Laravel class/job/listener; TS/Vue component, composable, store, route handler)
- User asks "how is X used?" / "what depends on X?" / "what does X dispatch?"
- About to suggest extracting an interface or splitting responsibilities
- Investigating a bug where the wiring (events, listeners, observers) is
  unclear

## How to invoke

MCP:
```
phorge_graph_query({
  symbol: "<ClassName | App\\Foo\\Bar | App\\Foo\\Bar::method>",
  repoPath: "$CLAUDE_PROJECT_DIR",
  depth: 1
})
```

CLI:
```bash
phorge graph query <Symbol> --repo "$CLAUDE_PROJECT_DIR" --depth 1
```

`depth: 2` for wider neighborhood (more nodes, slower to read).

Examples:

```bash
# Laravel: trace a service from its controllers down through dispatched jobs
phorge graph query "App\\Services\\RefundService" --repo . --depth 2

# Laravel: inspect a single method's call sites
phorge graph query "App\\Jobs\\ProcessRefund::handle" --repo . --depth 1

# TS / Vue: see what imports a composable and what it imports in turn
phorge graph query "useCheckoutCart" --repo . --depth 2

# TS / Nuxt: structural neighbors of a page component
phorge graph query "pages/checkout/index.vue" --repo . --depth 1
```

## What you'll receive

A rendered subgraph showing the symbol and its connected nodes. Edge types
depend on the active language profile.

Laravel profile (richest coverage):
- `defines` (file → class)
- `contains_method` (class → methods)
- `extends`, `implements`, `uses_trait`
- `route_to_controller`, `controller_dispatches_job`
- `emits_event`, `listens_to_event`
- `observes_model`, `service_binding`

TS / Vue / Nuxt profile (narrower — newer):
- `defines` (file → exported symbol)
- `imports` / `imported_by`
- `component_uses_composable`, `component_renders_component`
- `route_to_handler` (Nuxt / Next pages → handler)

## What to do with it

- Identify dependent symbols you might break with a rename
- Find the dispatch sites of a job/event before touching its signature
- Discover hidden listeners/observers that consume something you're modifying

## Skip when

- Pure data/config edit (no source artifact involved)
- Symbol is too generic to resolve (e.g. a vendor class or third-party export)
- Graph not built — trigger `phorge-setup` first
