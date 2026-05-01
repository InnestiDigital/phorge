// Walks a TS/Vue/Nuxt repo, builds a structural graph: file imports, component
// renders, composables, Pinia stores, Nuxt page routes. Reuses the shared
// graphs/schema kinds (component / composable / store / route nodes; imports /
// vue_renders / route_to_component / defines / component_uses_* edges).
//
// Workspace-aware: detects npm/yarn `workspaces` and pnpm-workspace.yaml so
// monorepo packages (e.g. agentic-wallet's packages/strand-agent) participate
// in scanning. Without this, scanRoots like `src/` or `app/` only resolve at
// the repo root and skip all package-internal source.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, basename, extname, resolve, isAbsolute } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Project, SyntaxKind, ScriptKind, type SourceFile, type Node } from 'ts-morph'
import type { GraphScanner, GraphScanResult, ScannerStat } from '../contracts'
import type { GraphNode, GraphEdge } from '../../graphs/schema'
import { fileKey, normalizeRepoPath, functionKey, classKey } from '../../graphs/node-keys'
import { tsFileScope } from './file-scope'

// Cap CallExpression visits per file. Pathological generated files (large
// hand-rolled state tables) blow up the call pass otherwise; 200 is well
// above any human-authored module's call density.
const MAX_CALLS_PER_FILE = 200

const VUE_SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
const VUE_TEMPLATE_RE = /<template\b[^>]*>([\s\S]*?)<\/template>/gi

type Ctx = {
  repoRoot: string
  project: Project
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  edgeSet: Set<string>
  // component name (basename, no ext) -> file rel path
  componentByName: Map<string, string>
  // file rel path -> set of imported component names (resolved later)
  importedComponents: Map<string, Set<string>>
  // file rel path -> component defined in that file (Vue SFCs only)
  componentByFile: Map<string, string>
  // file rel path -> composable names defined in that file
  composablesByFile: Map<string, Set<string>>
  // file rel path -> all symbols defined in that file (for call resolution)
  definesByFile: Map<string, DefinedSymbol[]>
  // file rel path -> intra-project import entries (for call resolution)
  importsByFile: Map<string, ImportEntry[]>
  // raw sources retained for the second (call-graph) pass
  fileSources: Array<{ rel: string; ext: string; source: string }>
  stats: ScannerStat
}

// Symbol kinds the call resolver targets. The TS scanner does not emit
// `method:` so we limit the union to the kinds it actually produces.
type DefinedSymbolKind = 'function' | 'class' | 'composable' | 'store' | 'component'

type DefinedSymbol = { kind: DefinedSymbolKind; name: string; key: string }

// Intra-project named/namespace import. `localName` is what the caller
// writes (alias, default ident, or namespace ident); `importedName` is
// the symbol to look up in the target file (null for namespace imports,
// where resolution falls back to the property chain `ns.foo()`).
type ImportEntry = {
  localName: string
  importedName: string | null
  isNamespace: boolean
  targetRel: string
}

function addNode(ctx: Ctx, n: GraphNode): void {
  if (!ctx.nodes.has(n.key)) {
    ctx.nodes.set(n.key, n)
    ctx.stats.nodes++
  }
}

function pushDefine(ctx: Ctx, relPath: string, sym: DefinedSymbol): void {
  const list = ctx.definesByFile.get(relPath) ?? []
  list.push(sym)
  ctx.definesByFile.set(relPath, list)
}

function pushImport(ctx: Ctx, relPath: string, entry: ImportEntry): void {
  const list = ctx.importsByFile.get(relPath) ?? []
  list.push(entry)
  ctx.importsByFile.set(relPath, list)
}

function addEdge(ctx: Ctx, e: GraphEdge): void {
  const sig = `${e.from}|${e.to}|${e.kind}`
  if (ctx.edgeSet.has(sig)) {
    ctx.stats.duplicateEdges++
    return
  }
  ctx.edgeSet.add(sig)
  ctx.edges.push(e)
  ctx.stats.edges++
}

function componentKey(name: string): string {
  return `component:${name}`
}
function composableKey(name: string): string {
  return `composable:${name}`
}
function storeKey(name: string): string {
  return `store:${name}`
}
function routeKeyFromPath(routePath: string): string {
  return `route:${routePath}`
}

// Advisory role tags derived from directory conventions. Free-form lower-case
// hyphenated strings consumed by anchor-ranker; not used for graph topology.
function rolesForTsPath(rel: string): readonly string[] {
  const norm = rel.replace(/\\/g, '/')
  const roles: string[] = []
  if (/(^|\/)server\/api\//.test(norm)) roles.push('api-endpoint')
  if (/(^|\/)pages\//.test(norm)) roles.push('route')
  if (/(^|\/)components\//.test(norm)) roles.push('component')
  if (/(^|\/)composables\//.test(norm)) roles.push('composable')
  if (/(^|\/)stores\//.test(norm)) roles.push('store')
  return roles.slice(0, 3)
}

function withTsRoles<T extends GraphNode>(node: T, rel: string): T {
  const roles = rolesForTsPath(rel)
  if (roles.length === 0) return node
  return { ...node, roles }
}

function pagesPathToRoute(rel: string): string | null {
  // e.g. pages/orders/[id].vue -> /orders/:id, pages/index.vue -> /
  const norm = rel.replace(/\\/g, '/')
  const idx = norm.indexOf('pages/')
  if (idx === -1) return null
  let inner = norm.slice(idx + 'pages/'.length)
  inner = inner.replace(/\.[^.]+$/, '')
  // dynamic segments [id] -> :id, [...slug] -> :slug*
  inner = inner.replace(/\[\.\.\.([^\]]+)\]/g, ':$1*')
  inner = inner.replace(/\[([^\]]+)\]/g, ':$1')
  if (inner === 'index') return '/'
  if (inner.endsWith('/index')) inner = inner.slice(0, -'/index'.length)
  return '/' + inner
}

function scriptKindFor(ext: string): ScriptKind {
  if (ext === '.tsx') return ScriptKind.TSX
  if (ext === '.jsx') return ScriptKind.JSX
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ScriptKind.JS
  return ScriptKind.TS
}

function extractVueScript(source: string): string {
  const parts: string[] = []
  let m: RegExpExecArray | null
  while ((m = VUE_SCRIPT_RE.exec(source)) !== null) parts.push(m[1])
  return parts.join('\n')
}

function extractVueTemplate(source: string): string {
  const parts: string[] = []
  let m: RegExpExecArray | null
  while ((m = VUE_TEMPLATE_RE.exec(source)) !== null) parts.push(m[1])
  return parts.join('\n')
}

function resolveRelativeImport(fromFile: string, spec: string, repoRoot: string): string | null {
  if (!spec.startsWith('.') && !isAbsolute(spec)) return null
  const fromAbs = join(repoRoot, fromFile)
  const baseDir = dirname(fromAbs)
  const target = resolve(baseDir, spec)
  const candidates = [
    target,
    target + '.ts', target + '.tsx', target + '.vue',
    target + '.js', target + '.jsx', target + '.mjs', target + '.cjs',
    join(target, 'index.ts'), join(target, 'index.tsx'),
    join(target, 'index.js'), join(target, 'index.vue'),
  ]
  for (const c of candidates) {
    try {
      const s = statSync(c)
      if (s.isFile()) {
        const rel = normalizeRepoPath(relative(repoRoot, c))
        return rel
      }
    } catch {
      // continue
    }
  }
  return null
}

// --- Workspace detection -------------------------------------------------

// Expand a workspace pattern (e.g. 'packages/*', 'apps/web', 'libs/**') under
// `repoRoot` into concrete absolute directory paths that contain a package.json.
// We support only a single trailing '*' segment (the universal case for
// pnpm/npm/yarn workspaces); '**' degrades to a single-level expansion since
// nested workspace packages are exceedingly rare in practice and any deeper
// nesting would still be reachable via per-package scanRoot walks.
function expandWorkspacePattern(repoRoot: string, pattern: string): string[] {
  const clean = pattern.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!clean) return []
  if (!clean.includes('*')) {
    const abs = join(repoRoot, clean)
    return existsSync(join(abs, 'package.json')) ? [abs] : []
  }
  // Take the segment before the first '*'; treat that as the parent dir.
  const starIdx = clean.indexOf('*')
  const beforeStar = clean.slice(0, starIdx).replace(/\/$/, '')
  const parent = beforeStar ? join(repoRoot, beforeStar) : repoRoot
  let entries
  try { entries = readdirSync(parent, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    const abs = join(parent, e.name)
    if (existsSync(join(abs, 'package.json'))) out.push(abs)
  }
  return out
}

function readWorkspacePatterns(repoRoot: string): string[] {
  const patterns: string[] = []

  // npm / yarn: package.json#workspaces (array or { packages: [...] }).
  const pkgJsonPath = join(repoRoot, 'package.json')
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as unknown
      if (pkg && typeof pkg === 'object') {
        const ws = (pkg as Record<string, unknown>).workspaces
        if (Array.isArray(ws)) {
          for (const p of ws) if (typeof p === 'string') patterns.push(p)
        } else if (ws && typeof ws === 'object') {
          const inner = (ws as Record<string, unknown>).packages
          if (Array.isArray(inner)) {
            for (const p of inner) if (typeof p === 'string') patterns.push(p)
          }
        }
      }
    } catch {
      // malformed package.json — silently fall through
    }
  }

  // pnpm: pnpm-workspace.yaml#packages.
  const pnpmPath = join(repoRoot, 'pnpm-workspace.yaml')
  if (existsSync(pnpmPath)) {
    try {
      const doc = parseYaml(readFileSync(pnpmPath, 'utf-8')) as unknown
      if (doc && typeof doc === 'object') {
        const pkgs = (doc as Record<string, unknown>).packages
        if (Array.isArray(pkgs)) {
          for (const p of pkgs) if (typeof p === 'string') patterns.push(p)
        }
      }
    } catch {
      // malformed yaml — silently fall through
    }
  }

  return patterns
}

// Resolve concrete package roots (absolute paths) for a repo. Always include
// repoRoot itself so files outside any workspace package (e.g. tooling at the
// root) are still reachable. Returns deduplicated, existing directories.
function resolvePackageRoots(repoRoot: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (abs: string): void => {
    const norm = resolve(abs)
    if (seen.has(norm)) return
    seen.add(norm)
    out.push(norm)
  }
  push(repoRoot)
  for (const pat of readWorkspacePatterns(repoRoot)) {
    for (const abs of expandWorkspacePattern(repoRoot, pat)) push(abs)
  }
  return out
}

// --- Source processing --------------------------------------------------

function processSource(
  ctx: Ctx,
  relPath: string,
  source: string,
): { ok: boolean } {
  const ext = extname(relPath).toLowerCase()
  let code = source
  let scriptKind: ScriptKind = scriptKindFor(ext)
  if (ext === '.vue') {
    code = extractVueScript(source)
    scriptKind = ScriptKind.TS
  }

  const fKey = fileKey(relPath)
  addNode(ctx, withTsRoles({ key: fKey, kind: 'file', name: relPath, filePath: relPath }, relPath))

  // Vue: register component + Nuxt route.
  let componentName: string | null = null
  if (ext === '.vue') {
    componentName = basename(relPath, '.vue')
    const cKey = componentKey(componentName)
    addNode(ctx, withTsRoles({ key: cKey, kind: 'component', name: componentName, filePath: relPath }, relPath))
    addEdge(ctx, { from: fKey, to: cKey, kind: 'defines', confidence: 'exact', source: 'ts_scanner' })
    ctx.componentByName.set(componentName, relPath)
    ctx.componentByFile.set(relPath, componentName)
    pushDefine(ctx, relPath, { kind: 'component', name: componentName, key: cKey })

    if (relPath.includes('pages/')) {
      const routePath = pagesPathToRoute(relPath)
      if (routePath) {
        const rKey = routeKeyFromPath(routePath)
        addNode(ctx, withTsRoles({ key: rKey, kind: 'route', name: routePath, filePath: relPath }, relPath))
        addEdge(ctx, { from: rKey, to: cKey, kind: 'route_to_component', confidence: 'exact', source: 'ts_scanner' })
      }
    }
  }

  // Vue template: collect referenced PascalCase tags as component imports.
  if (ext === '.vue') {
    const tpl = extractVueTemplate(source)
    if (tpl) {
      const tagRe = /<([A-Z][A-Za-z0-9]*)\b/g
      let m: RegExpExecArray | null
      const set = ctx.importedComponents.get(relPath) ?? new Set<string>()
      while ((m = tagRe.exec(tpl)) !== null) set.add(m[1])
      ctx.importedComponents.set(relPath, set)
    }
  }

  if (!code.trim()) return { ok: true }

  let sf: SourceFile
  try {
    const virtName = `__phorge__/${relPath.replace(/[^A-Za-z0-9._/-]/g, '_')}${ext === '.vue' ? '.ts' : ''}`
    sf = ctx.project.createSourceFile(virtName, code, { overwrite: true, scriptKind })
  } catch {
    return { ok: false }
  }

  // Imports
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue()
    if (!spec) continue
    const targetRel = resolveRelativeImport(relPath, spec, ctx.repoRoot)
    if (!targetRel) continue
    const targetKey = fileKey(targetRel)
    if (!ctx.nodes.has(targetKey)) {
      addNode(ctx, withTsRoles({ key: targetKey, kind: 'file', name: targetRel, filePath: targetRel }, targetRel))
    }
    addEdge(ctx, { from: fKey, to: targetKey, kind: 'imports', confidence: 'exact', source: 'ts_scanner' })

    // Record import bindings for call resolution.
    for (const named of imp.getNamedImports()) {
      const importedName = named.getNameNode().getText()
      const alias = named.getAliasNode()?.getText() ?? importedName
      pushImport(ctx, relPath, {
        localName: alias,
        importedName,
        isNamespace: false,
        targetRel,
      })
    }
    const ns = imp.getNamespaceImport()
    if (ns) {
      pushImport(ctx, relPath, {
        localName: ns.getText(),
        importedName: null,
        isNamespace: true,
        targetRel,
      })
    }
    const def = imp.getDefaultImport()
    if (def) {
      // Default imports: bind to whatever the target file's default-export
      // symbol resolves to. We model this conservatively as a namespace-style
      // entry on the file so simple cases (`import Foo from './foo'; Foo()`)
      // can resolve to a same-named function/class/component.
      pushImport(ctx, relPath, {
        localName: def.getText(),
        importedName: def.getText(),
        isNamespace: false,
        targetRel,
      })
    }

    // If the imported file is a .vue, treat as component import.
    if (targetRel.endsWith('.vue')) {
      const compName = basename(targetRel, '.vue')
      const set = ctx.importedComponents.get(relPath) ?? new Set<string>()
      set.add(compName)
      ctx.importedComponents.set(relPath, set)
    }
  }

  const recordComposable = (name: string): void => {
    const cKey = composableKey(name)
    addNode(ctx, withTsRoles({ key: cKey, kind: 'composable', name, filePath: relPath }, relPath))
    addEdge(ctx, { from: fKey, to: cKey, kind: 'defines', confidence: 'exact', source: 'ts_scanner' })
    const set = ctx.composablesByFile.get(relPath) ?? new Set<string>()
    set.add(name)
    ctx.composablesByFile.set(relPath, set)
    pushDefine(ctx, relPath, { kind: 'composable', name, key: cKey })
  }

  const recordFunction = (name: string): void => {
    const fnKey = functionKey(name)
    addNode(ctx, withTsRoles({ key: fnKey, kind: 'function', name, filePath: relPath }, relPath))
    addEdge(ctx, { from: fKey, to: fnKey, kind: 'defines', confidence: 'exact', source: 'ts_scanner' })
    pushDefine(ctx, relPath, { kind: 'function', name, key: fnKey })
  }

  const recordClass = (name: string): void => {
    const cKey = classKey(name)
    addNode(ctx, withTsRoles({ key: cKey, kind: 'class', name, filePath: relPath }, relPath))
    addEdge(ctx, { from: fKey, to: cKey, kind: 'defines', confidence: 'exact', source: 'ts_scanner' })
    pushDefine(ctx, relPath, { kind: 'class', name, key: cKey })
  }

  // Function declarations: composables (use[A-Z]...) get a `composable:` node;
  // everything else gets a plain `function:` node so call edges can attach.
  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (!name) continue
    if (/^use[A-Z]/.test(name)) recordComposable(name)
    else recordFunction(name)
  }
  // Variable-bound arrow / function expressions.
  for (const v of sf.getVariableDeclarations()) {
    const name = v.getName()
    const init = v.getInitializer()
    if (!init) continue
    const k = init.getKind()
    if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue
    if (/^use[A-Z]/.test(name)) recordComposable(name)
    else recordFunction(name)
  }
  // Class declarations.
  for (const cls of sf.getClasses()) {
    const name = cls.getName()
    if (!name) continue
    recordClass(name)
  }

  // Pinia / Vuex stores: defineStore('id', ...)
  sf.forEachDescendant((node: Node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node.asKind(SyntaxKind.CallExpression)
    if (!call) return
    const expr = call.getExpression().getText()
    if (expr !== 'defineStore') return
    const args = call.getArguments()
    if (args.length === 0) return
    const first = args[0]
    if (first.getKind() !== SyntaxKind.StringLiteral) return
    const id = first.getText().slice(1, -1)
    if (!id) return
    const sKey = storeKey(id)
    addNode(ctx, withTsRoles({ key: sKey, kind: 'store', name: id, filePath: relPath }, relPath))
    addEdge(ctx, { from: fKey, to: sKey, kind: 'defines', confidence: 'exact', source: 'ts_scanner' })
    pushDefine(ctx, relPath, { kind: 'store', name: id, key: sKey })
  })

  // Free the source file from the in-memory project to bound memory.
  try { ctx.project.removeSourceFile(sf) } catch { /* ignore */ }
  return { ok: true }
}

// --- Call graph (second pass) -------------------------------------------

// Pick the rightmost identifier in a property-access chain (e.g.
// `client.send` -> `send`, `OAuth.refresh` -> `refresh`). For namespace
// imports (`ns.foo()`) we use the leftmost ident as the local binding and
// the rightmost as the symbol name in the target file.
function callExpressionResolution(
  callExprNode: Node,
): { localName: string; symbolName: string } | null {
  const call = callExprNode.asKind(SyntaxKind.CallExpression)
  if (!call) return null
  const expr = call.getExpression()
  const k = expr.getKind()
  if (k === SyntaxKind.Identifier) {
    const name = expr.getText()
    return { localName: name, symbolName: name }
  }
  if (k === SyntaxKind.PropertyAccessExpression) {
    const pa = expr.asKind(SyntaxKind.PropertyAccessExpression)
    if (!pa) return null
    // Walk to the leftmost identifier — this is the local binding.
    let cursor: Node = pa.getExpression()
    while (cursor.getKind() === SyntaxKind.PropertyAccessExpression) {
      const inner = cursor.asKind(SyntaxKind.PropertyAccessExpression)
      if (!inner) break
      cursor = inner.getExpression()
    }
    if (cursor.getKind() !== SyntaxKind.Identifier) return null
    const localName = cursor.getText()
    const symbolName = pa.getName()
    return { localName, symbolName }
  }
  return null
}

// Find the nearest enclosing symbol (function / class / composable /
// component) that we registered for this file. Returns the symbol's graph
// key, or the file key if the call sits at module top-level.
function resolveCallerKey(
  ctx: Ctx,
  relPath: string,
  callExprNode: Node,
  componentNameForFile: string | undefined,
): string {
  const fKey = fileKey(relPath)
  const defines = ctx.definesByFile.get(relPath) ?? []
  if (defines.length === 0 && !componentNameForFile) return fKey

  let cursor: Node | undefined = callExprNode.getParent()
  while (cursor) {
    const k = cursor.getKind()
    if (k === SyntaxKind.FunctionDeclaration) {
      const fn = cursor.asKind(SyntaxKind.FunctionDeclaration)
      const name = fn?.getName()
      if (name) {
        const match = defines.find(d => d.name === name &&
          (d.kind === 'function' || d.kind === 'composable'))
        if (match) return match.key
      }
    } else if (k === SyntaxKind.ClassDeclaration) {
      const cls = cursor.asKind(SyntaxKind.ClassDeclaration)
      const name = cls?.getName()
      if (name) {
        const match = defines.find(d => d.name === name && d.kind === 'class')
        if (match) return match.key
      }
    } else if (k === SyntaxKind.VariableDeclaration) {
      const vd = cursor.asKind(SyntaxKind.VariableDeclaration)
      const name = vd?.getName()
      if (name) {
        const match = defines.find(d => d.name === name &&
          (d.kind === 'function' || d.kind === 'composable'))
        if (match) return match.key
      }
    }
    cursor = cursor.getParent()
  }

  // Vue SFC: top-level setup-script calls attribute to the component node.
  if (componentNameForFile) return componentKey(componentNameForFile)
  return fKey
}

function extractCallEdges(ctx: Ctx): void {
  for (const { rel, ext, source } of ctx.fileSources) {
    let code = source
    let scriptKind: ScriptKind = scriptKindFor(ext)
    if (ext === '.vue') {
      code = extractVueScript(source)
      scriptKind = ScriptKind.TS
    }
    if (!code.trim()) continue

    let sf: SourceFile
    try {
      const virtName = `__phorge_calls__/${rel.replace(/[^A-Za-z0-9._/-]/g, '_')}${ext === '.vue' ? '.ts' : ''}`
      sf = ctx.project.createSourceFile(virtName, code, { overwrite: true, scriptKind })
    } catch {
      continue
    }

    const importsForFile = ctx.importsByFile.get(rel) ?? []
    // Index imports by local binding name for O(1) lookup.
    const importsByLocal = new Map<string, ImportEntry>()
    for (const e of importsForFile) importsByLocal.set(e.localName, e)
    const ownDefines = ctx.definesByFile.get(rel) ?? []
    const componentName = ctx.componentByFile.get(rel)

    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression)
    const limited = calls.length > MAX_CALLS_PER_FILE
      ? calls.slice(0, MAX_CALLS_PER_FILE)
      : calls

    for (const call of limited) {
      const resolved = callExpressionResolution(call)
      if (!resolved) continue
      const { localName, symbolName } = resolved

      // First try the file's own imports.
      const imp = importsByLocal.get(localName)
      let calleeKey: string | null = null
      if (imp) {
        const targetDefines = ctx.definesByFile.get(imp.targetRel) ?? []
        const lookupName = imp.isNamespace
          ? symbolName
          : (imp.importedName ?? symbolName)
        const match = targetDefines.find(d => d.name === lookupName)
        if (match) calleeKey = match.key
      } else {
        // Same-file resolution: function defined locally.
        const match = ownDefines.find(d => d.name === localName)
        if (match) calleeKey = match.key
      }

      if (!calleeKey) continue

      const callerKey = resolveCallerKey(ctx, rel, call, componentName)
      if (callerKey === calleeKey) continue
      addEdge(ctx, {
        from: callerKey,
        to: calleeKey,
        kind: 'calls',
        confidence: 'inferred',
        source: 'ts_scanner',
      })
    }

    try { ctx.project.removeSourceFile(sf) } catch { /* ignore */ }
  }
}

function walk(dir: string, ignoreDirs: ReadonlySet<string>, out: string[]): void {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    if (ignoreDirs.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      walk(full, ignoreDirs, out)
    } else if (e.isFile() && tsFileScope.matches(e.name)) {
      out.push(full)
    }
  }
}

// Walk scanRoots under each package root. Files at the repo root that don't
// fall under any scanRoot are picked up by the repoRoot package entry.
function collectFiles(packageRoots: readonly string[]): string[] {
  const ignore = new Set<string>(tsFileScope.ignoreDirs)
  const out: string[] = []
  for (const pkgRoot of packageRoots) {
    let walked = false
    for (const root of tsFileScope.scanRoots) {
      const abs = join(pkgRoot, root)
      if (!existsSync(abs)) continue
      walked = true
      walk(abs, ignore, out)
    }
    // Only fall back to walking the package root itself when no scanRoots
    // matched AND this is not the repo root (which would risk traversing
    // every workspace package twice).
    if (!walked && packageRoots.length === 1) walk(pkgRoot, ignore, out)
  }
  // Dedupe — multiple package roots may share files via symlinks/overlap.
  return [...new Set(out)]
}

export const tsGraphScanner: GraphScanner = {
  promotionEdges: ['defines'],
  scan(opts: { repoRoot: string }): GraphScanResult {
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, noResolve: true },
    })

    const ctx: Ctx = {
      repoRoot: opts.repoRoot,
      project,
      nodes: new Map(),
      edges: [],
      edgeSet: new Set(),
      componentByName: new Map(),
      importedComponents: new Map(),
      componentByFile: new Map(),
      composablesByFile: new Map(),
      definesByFile: new Map(),
      importsByFile: new Map(),
      fileSources: [],
      stats: { nodes: 0, edges: 0, skipped: 0, unresolvedRefs: 0, duplicateEdges: 0 },
    }

    const packageRoots = resolvePackageRoots(opts.repoRoot)
    const files = collectFiles(packageRoots)
    let tsFilesScanned = 0
    let vueFilesScanned = 0
    let parseErrors = 0

    for (const abs of files) {
      // Node filePaths are repo-root-relative — same convention as corpus,
      // anchors, and validate-plan. Per-package scanning is purely a
      // discovery mechanism, not a path-rewriting one.
      const rel = normalizeRepoPath(relative(opts.repoRoot, abs))
      let source: string
      try { source = readFileSync(abs, 'utf-8') } catch { ctx.stats.skipped++; continue }
      const r = processSource(ctx, rel, source)
      if (!r.ok) parseErrors++
      else ctx.fileSources.push({ rel, ext: extname(rel).toLowerCase(), source })
      if (rel.endsWith('.vue')) vueFilesScanned++
      else tsFilesScanned++
    }

    // Resolve component references collected from Vue templates / .vue imports.
    // Emit both file-level (file:A → component:X) and symbol-level
    // (component:A → component:X) edges so subgraph promotion via `defines`
    // lands on a node with non-zero outgoing degree.
    for (const [fromRel, names] of ctx.importedComponents) {
      const fKey = fileKey(fromRel)
      const sourceComp = ctx.componentByFile.get(fromRel)
      for (const name of names) {
        const targetRel = ctx.componentByName.get(name)
        if (!targetRel) { ctx.stats.unresolvedRefs++; continue }
        const cKey = componentKey(name)
        addEdge(ctx, { from: fKey, to: cKey, kind: 'vue_renders', confidence: 'inferred', source: 'ts_scanner' })
        if (sourceComp && sourceComp !== name) {
          addEdge(ctx, {
            from: componentKey(sourceComp), to: cKey,
            kind: 'component_uses_component', confidence: 'inferred', source: 'ts_scanner',
          })
        }
      }
    }

    // Promote `imports` edges into symbol-level edges so `component:` and
    // `composable:` nodes have outgoing edges. For an `imports` edge A → B:
    //   - if A defines component:CompA and B defines component:CompB,
    //     emit component_uses_component CompA → CompB
    //   - if A defines component:CompA and B defines composable:useX,
    //     emit component_uses_composable CompA → useX
    //   - if A defines composable:useY and B defines composable:useX,
    //     emit component_uses_composable useY → useX (composables compose).
    // Iterate once over the recorded import edges (snapshot to avoid mutation
    // during iteration — addEdge mutates ctx.edges).
    const importEdges = ctx.edges.filter(e => e.kind === 'imports')
    for (const e of importEdges) {
      const fromRel = e.from.startsWith('file:') ? e.from.slice('file:'.length) : null
      const toRel = e.to.startsWith('file:') ? e.to.slice('file:'.length) : null
      if (!fromRel || !toRel) continue
      const srcComp = ctx.componentByFile.get(fromRel)
      const dstComp = ctx.componentByFile.get(toRel)
      const srcComposables = ctx.composablesByFile.get(fromRel)
      const dstComposables = ctx.composablesByFile.get(toRel)

      if (srcComp && dstComp && srcComp !== dstComp) {
        addEdge(ctx, {
          from: componentKey(srcComp), to: componentKey(dstComp),
          kind: 'component_uses_component', confidence: 'inferred', source: 'ts_scanner',
        })
      }
      if (srcComp && dstComposables) {
        for (const name of dstComposables) {
          addEdge(ctx, {
            from: componentKey(srcComp), to: composableKey(name),
            kind: 'component_uses_composable', confidence: 'inferred', source: 'ts_scanner',
          })
        }
      }
      if (srcComposables && dstComposables) {
        for (const fromName of srcComposables) {
          for (const toName of dstComposables) {
            if (fromName === toName) continue
            addEdge(ctx, {
              from: composableKey(fromName), to: composableKey(toName),
              kind: 'component_uses_composable', confidence: 'inferred', source: 'ts_scanner',
            })
          }
        }
      }
    }

    // Second pass: extract `calls` edges. Reparse each source, walk every
    // CallExpression, resolve callee identifiers via this file's imports
    // (intra-project only) or its own defines, and emit the edge from the
    // enclosing symbol (or the file node, for top-level calls).
    extractCallEdges(ctx)

    return {
      nodes: [...ctx.nodes.values()],
      edges: ctx.edges,
      stats: {
        filesScanned: 0,
        parseErrors,
        nodes: ctx.nodes.size,
        edges: ctx.edges.length,
        perScanner: {
          ts: { ...ctx.stats },
          // surface ts/vue counts under named pseudo-scanners for visibility
          tsFiles: { nodes: tsFilesScanned, edges: 0, skipped: 0, unresolvedRefs: 0, duplicateEdges: 0 },
          vueFiles: { nodes: vueFilesScanned, edges: 0, skipped: 0, unresolvedRefs: 0, duplicateEdges: 0 },
          packages: { nodes: packageRoots.length, edges: 0, skipped: 0, unresolvedRefs: 0, duplicateEdges: 0 },
        },
      },
    }
  },
}
