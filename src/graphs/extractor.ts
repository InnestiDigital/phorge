import { parsePhpFile } from './php-parser'
import {
  fileKey,
  classKey,
  interfaceKey,
  traitKey,
  methodKey,
  normalizeNamespace,
  normalizeRepoPath,
} from './node-keys'
import type { GraphNode, GraphEdge } from './schema'

export type ExtractFromSourceResult = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  namespace: string
  useMap: Map<string, string>
  declaredSymbols: string[]
  parseErrors: number
}

type Ctx = {
  filePath: string
  namespace: string
  useMap: Map<string, string>
  currentType: { kind: 'class' | 'interface' | 'trait'; fqcn: string; parentFqcn: string | null } | null
}

function resolveType(name: string, ctx: Ctx): string {
  if (!name) return ''
  const normalized = normalizeNamespace(name)
  if (normalized.includes('\\')) return normalized
  const fromUse = ctx.useMap.get(normalized)
  if (fromUse) return fromUse
  if (ctx.namespace) return `${ctx.namespace}\\${normalized}`
  return normalized
}

function typeKeyForKind(kind: 'class' | 'interface' | 'trait', fqcn: string): string {
  switch (kind) {
    case 'class': return classKey(fqcn)
    case 'interface': return interfaceKey(fqcn)
    case 'trait': return traitKey(fqcn)
  }
}

function addEdge(
  edges: GraphEdge[],
  edgeSet: Set<string>,
  from: string,
  to: string,
  kind: GraphEdge['kind'],
): void {
  const sig = `${from}|${to}|${kind}`
  if (edgeSet.has(sig)) return
  edgeSet.add(sig)
  edges.push({ from, to, kind, confidence: 'exact', source: 'parser' })
}

function extractName(node: any): string {
  if (typeof node === 'string') return node
  if (node && typeof node.name === 'string') return node.name
  if (node && node.kind === 'identifier' && typeof node.name === 'string') return node.name
  return ''
}

function resolveNameNode(node: any, ctx: Ctx): string {
  if (!node) return ''
  if (typeof node === 'string') return resolveType(node, ctx)
  if (node.kind === 'name' || node.kind === 'identifier') {
    const raw = extractName(node)
    if (node.resolution === 'fqn' || (raw && raw.includes('\\'))) {
      return normalizeNamespace(raw)
    }
    return resolveType(raw, ctx)
  }
  if (node.kind === 'classtreference' || node.kind === 'typereference') {
    const raw = extractName(node)
    if (node.resolution === 'fqn' || (raw && raw.includes('\\'))) {
      return normalizeNamespace(raw)
    }
    return resolveType(raw, ctx)
  }
  const raw = extractName(node)
  return raw ? resolveType(raw, ctx) : ''
}

function getVisibility(node: any): 'public' | 'protected' | 'private' {
  if (node.visibility === 'protected') return 'protected'
  if (node.visibility === 'private') return 'private'
  return 'public'
}

export function extractFromSource(source: string, filePath: string): ExtractFromSourceResult {
  const normalizedPath = normalizeRepoPath(filePath)
  const { ast, errors } = parsePhpFile(source)

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const edgeSet = new Set<string>()
  const declaredSymbols: string[] = []

  const fKey = fileKey(normalizedPath)
  const fileName = normalizedPath.split('/').pop() ?? normalizedPath
  nodes.push({ key: fKey, kind: 'file', name: fileName, filePath: normalizedPath })

  const ctx: Ctx = {
    filePath: normalizedPath,
    namespace: '',
    useMap: new Map(),
    currentType: null,
  }

  walkAst(ast, ctx, nodes, edges, edgeSet, declaredSymbols)

  return {
    nodes,
    edges,
    namespace: ctx.namespace,
    useMap: ctx.useMap,
    declaredSymbols,
    parseErrors: errors.length,
  }
}

function walkAst(
  node: any,
  ctx: Ctx,
  nodes: GraphNode[],
  edges: GraphEdge[],
  edgeSet: Set<string>,
  declaredSymbols: string[],
): void {
  if (!node || typeof node !== 'object') return

  if (node.kind === 'program' && Array.isArray(node.children)) {
    for (const child of node.children) {
      walkAst(child, ctx, nodes, edges, edgeSet, declaredSymbols)
    }
    return
  }

  if (node.kind === 'namespace') {
    ctx.namespace = extractName(node.name) || (typeof node.name === 'string' ? node.name : '')
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walkAst(child, ctx, nodes, edges, edgeSet, declaredSymbols)
      }
    }
    return
  }

  if (node.kind === 'usegroup') {
    if (Array.isArray(node.items)) {
      for (const item of node.items) {
        walkUseItem(item, ctx)
      }
    }
    return
  }

  if (node.kind === 'useitem') {
    walkUseItem(node, ctx)
    return
  }

  if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
    walkTypeDeclaration(node, ctx, nodes, edges, edgeSet, declaredSymbols)
    return
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      walkAst(child, ctx, nodes, edges, edgeSet, declaredSymbols)
    }
  }
  if (Array.isArray(node.body)) {
    for (const child of node.body) {
      walkAst(child, ctx, nodes, edges, edgeSet, declaredSymbols)
    }
  }
}

function walkUseItem(item: any, ctx: Ctx): void {
  if (!item) return
  const raw = extractName(item.name) || (typeof item.name === 'string' ? item.name : '')
  if (!raw) return
  const fqcn = normalizeNamespace(raw)
  const alias = item.alias ? extractName(item.alias) : fqcn.split('\\').pop() ?? fqcn
  ctx.useMap.set(alias, fqcn)
}

function walkTypeDeclaration(
  node: any,
  ctx: Ctx,
  nodes: GraphNode[],
  edges: GraphEdge[],
  edgeSet: Set<string>,
  declaredSymbols: string[],
): void {
  const kind = node.kind as 'class' | 'interface' | 'trait'
  const name = extractName(node.name) || (typeof node.name === 'string' ? node.name : '')
  if (!name) return

  const fqcn = ctx.namespace ? `${ctx.namespace}\\${name}` : name
  const key = typeKeyForKind(kind, fqcn)
  const fKey = fileKey(ctx.filePath)

  const nodeObj: GraphNode = {
    key,
    kind,
    name,
    filePath: ctx.filePath,
    line: node.loc?.start?.line,
    fqcn,
  }
  if (node.isAbstract) nodeObj.isAbstract = true

  nodes.push(nodeObj)
  declaredSymbols.push(fqcn)
  addEdge(edges, edgeSet, fKey, key, 'defines')

  // extends
  if (node.extends) {
    const extendees = Array.isArray(node.extends) ? node.extends : [node.extends]
    for (const ext of extendees) {
      const extFqcn = resolveNameNode(ext, ctx)
      if (extFqcn) {
        const targetKind = kind === 'interface' ? 'interface' : 'class'
        const targetKey = targetKind === 'interface' ? interfaceKey(extFqcn) : classKey(extFqcn)
        addEdge(edges, edgeSet, key, targetKey, 'extends')
      }
    }
  }

  // implements
  if (node.implements && Array.isArray(node.implements)) {
    for (const impl of node.implements) {
      const implFqcn = resolveNameNode(impl, ctx)
      if (implFqcn) {
        addEdge(edges, edgeSet, key, interfaceKey(implFqcn), 'implements')
      }
    }
  }

  // Resolve parent FQCN for parent:: calls
  let parentFqcn: string | null = null
  if (node.extends && !Array.isArray(node.extends)) {
    parentFqcn = resolveNameNode(node.extends, ctx) || null
  } else if (Array.isArray(node.extends) && node.extends.length > 0) {
    parentFqcn = resolveNameNode(node.extends[0], ctx) || null
  }

  // Save parent context and set current type
  const prevType = ctx.currentType
  ctx.currentType = { kind, fqcn, parentFqcn }

  // Walk body for methods and traits
  const body = node.body ?? node.children ?? []
  if (Array.isArray(body)) {
    for (const member of body) {
      if (member.kind === 'method') {
        walkMethod(member, ctx, nodes, edges, edgeSet, key, fqcn)
      } else if (member.kind === 'traituse') {
        walkTraitUse(member, ctx, edges, edgeSet, key)
      }
    }
  }

  ctx.currentType = prevType
}

function walkMethod(
  node: any,
  ctx: Ctx,
  nodes: GraphNode[],
  edges: GraphEdge[],
  edgeSet: Set<string>,
  typeKey: string,
  typeFqcn: string,
): void {
  const name = extractName(node.name) || (typeof node.name === 'string' ? node.name : '')
  if (!name) return

  const mKey = methodKey(typeFqcn, name)
  const mNode: GraphNode = {
    key: mKey,
    kind: 'method',
    name,
    filePath: ctx.filePath,
    line: node.loc?.start?.line,
    fqcn: `${typeFqcn}::${name}`,
    visibility: getVisibility(node),
  }
  if (node.isAbstract) mNode.isAbstract = true
  if (node.isStatic) mNode.isStatic = true

  nodes.push(mNode)
  addEdge(edges, edgeSet, typeKey, mKey, 'contains_method')

  // Pass 2: walk method body for calls + throws
  if (node.body) {
    const localTypes = buildLocalTypeMap(node, ctx)
    walkMethodBody(node.body, ctx, edges, edgeSet, mKey, typeFqcn, localTypes)
  }
}

type LocalTypeMap = Map<string, string>

function buildLocalTypeMap(methodNode: any, ctx: Ctx): LocalTypeMap {
  const map: LocalTypeMap = new Map()

  // Typed parameters
  const params = methodNode.arguments ?? methodNode.params ?? []
  if (Array.isArray(params)) {
    for (const param of params) {
      const paramName = extractParamName(param)
      const paramType = extractParamType(param, ctx)
      if (paramName && paramType) {
        map.set(paramName, paramType)
      }
    }
  }

  // Scan body for `$var = new ClassName()` assignments
  if (methodNode.body) {
    scanNewAssignments(methodNode.body, ctx, map)
  }

  return map
}

function extractParamName(param: any): string {
  if (!param) return ''
  const name = param.name
  if (typeof name === 'string') return name
  if (name && typeof name.name === 'string') return name.name
  if (name && name.kind === 'identifier') return extractName(name)
  return ''
}

function extractParamType(param: any, ctx: Ctx): string {
  const type = param.type ?? param.typehint
  if (!type) return ''
  return resolveNameNode(type, ctx)
}

function scanNewAssignments(node: any, ctx: Ctx, map: LocalTypeMap): void {
  if (!node || typeof node !== 'object') return

  if (node.kind === 'expressionstatement' && node.expression?.kind === 'assign') {
    const assign = node.expression
    const left = assign.left
    const right = assign.right
    if (left?.kind === 'variable' && typeof left.name === 'string' && right?.kind === 'new') {
      const classFqcn = resolveNameNode(right.what, ctx)
      if (classFqcn) {
        map.set(left.name, classFqcn)
      }
    }
  }

  // Recurse into children/body arrays
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          scanNewAssignments(child, ctx, map)
        }
      }
    }
  }
}

function walkMethodBody(
  node: any,
  ctx: Ctx,
  edges: GraphEdge[],
  edgeSet: Set<string>,
  methodKey: string,
  typeFqcn: string,
  localTypes: LocalTypeMap,
): void {
  if (!node || typeof node !== 'object') return

  // throw new ClassName(...)
  if (node.kind === 'throw') {
    const expr = node.what ?? node.expression
    if (expr?.kind === 'new') {
      const thrownFqcn = resolveNameNode(expr.what, ctx)
      if (thrownFqcn) {
        addEdge(edges, edgeSet, methodKey, classKey(thrownFqcn), 'throws')
      }
    }
  }

  // Method calls (includes static calls via staticlookup)
  if (node.kind === 'call') {
    resolveCallEdge(node, ctx, edges, edgeSet, methodKey, typeFqcn, localTypes)
  }

  // Recurse
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkMethodBody(child, ctx, edges, edgeSet, methodKey, typeFqcn, localTypes)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      walkMethodBody(val, ctx, edges, edgeSet, methodKey, typeFqcn, localTypes)
    }
  }
}

function resolveCallEdge(
  node: any,
  ctx: Ctx,
  edges: GraphEdge[],
  edgeSet: Set<string>,
  fromKey: string,
  typeFqcn: string,
  localTypes: LocalTypeMap,
): void {
  const what = node.what
  if (!what) return

  // Static calls: self::, static::, parent::, ClassName::
  if (what.kind === 'staticlookup') {
    const obj = what.what
    const calledMethod = extractName(what.offset)
    if (!calledMethod) return

    // self::method()
    if (obj?.kind === 'selfreference') {
      addEdge(edges, edgeSet, fromKey, `method:${typeFqcn}::${calledMethod}`, 'calls')
      return
    }

    // static::method()
    if (obj?.kind === 'staticreference') {
      addEdge(edges, edgeSet, fromKey, `method:${typeFqcn}::${calledMethod}`, 'calls')
      return
    }

    // parent::method()
    if (obj?.kind === 'parentreference') {
      if (ctx.currentType?.parentFqcn) {
        addEdge(edges, edgeSet, fromKey, `method:${ctx.currentType.parentFqcn}::${calledMethod}`, 'calls')
      }
      return
    }

    // ClassName::method()
    const classFqcn = resolveNameNode(obj, ctx)
    if (classFqcn) {
      addEdge(edges, edgeSet, fromKey, `method:${classFqcn}::${calledMethod}`, 'calls')
    }
    return
  }

  // Instance calls: $this->method(), $var->method()
  if (what.kind === 'propertylookup') {
    const obj = what.what
    // Skip dynamic method names ($this->$method())
    if (what.offset?.kind === 'variable') return
    const calledMethod = extractName(what.offset)
    if (!calledMethod || typeof calledMethod !== 'string') return

    // $this->method()
    if (obj?.kind === 'variable' && obj.name === 'this') {
      addEdge(edges, edgeSet, fromKey, `method:${typeFqcn}::${calledMethod}`, 'calls')
      return
    }

    // $var->method() where $var has a known type
    if (obj?.kind === 'variable' && typeof obj.name === 'string') {
      const varType = localTypes.get(obj.name)
      if (varType) {
        addEdge(edges, edgeSet, fromKey, `method:${varType}::${calledMethod}`, 'calls')
      }
    }
  }
}

function walkTraitUse(
  node: any,
  ctx: Ctx,
  edges: GraphEdge[],
  edgeSet: Set<string>,
  typeKey: string,
): void {
  const traits = node.traits ?? []
  if (!Array.isArray(traits)) return
  for (const t of traits) {
    const tFqcn = resolveNameNode(t, ctx)
    if (tFqcn) {
      addEdge(edges, edgeSet, typeKey, traitKey(tFqcn), 'uses_trait')
    }
  }
}
