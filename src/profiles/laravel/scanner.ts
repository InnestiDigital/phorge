import {
  routeKey,
  methodKey,
  classKey,
  jobKey,
  eventKey,
  listenerKey,
  observerKey,
  modelKey,
  policyKey,
  serviceBindingKey,
  commandKey,
  transformerKey,
  normalizeNamespace,
  normalizeHttpMethod,
} from '../../graphs/node-keys'
import type { GraphNode, GraphEdge } from '../../graphs/schema'

export type LaravelScannerContext = {
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  edgeSet: Set<string>
  astCache: Map<string, { ast: any; filePath: string; namespace: string; useMap: Map<string, string> }>
  fqcnIndex: Map<string, string>
}

export type ScannerResult = {
  nodes: number
  edges: number
  skipped: number
  unresolvedRefs: number
  duplicateEdges: number
}

function addNode(ctx: LaravelScannerContext, node: GraphNode): boolean {
  if (ctx.nodes.has(node.key)) return false
  ctx.nodes.set(node.key, node)
  return true
}

function addEdge(ctx: LaravelScannerContext, edge: GraphEdge): boolean {
  const sig = `${edge.from}|${edge.to}|${edge.kind}`
  if (ctx.edgeSet.has(sig)) return false
  ctx.edgeSet.add(sig)
  ctx.edges.push(edge)
  return true
}

function extractName(node: any): string {
  if (typeof node === 'string') return node
  if (node && typeof node.name === 'string') return node.name
  if (node && node.kind === 'identifier' && typeof node.name === 'string') return node.name
  return ''
}

function resolveType(name: string, useMap: Map<string, string>, namespace: string): string {
  if (!name) return ''
  const normalized = normalizeNamespace(name)
  if (normalized.includes('\\')) return normalized
  const fromUse = useMap.get(normalized)
  if (fromUse) return fromUse
  if (namespace) return `${namespace}\\${normalized}`
  return normalized
}

function isRouteFile(filePath: string): boolean {
  return filePath.startsWith('routes/') || filePath.startsWith('routes\\')
}

function isControllerFile(filePath: string): boolean {
  return filePath.includes('Controllers/') || filePath.includes('Controllers\\')
}

const ROUTE_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match',
])

const BASE_REQUEST_CLASSES = new Set([
  'Illuminate\\Http\\Request',
  'Request',
])

// ── scanRoutes ──

export function scanRoutes(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0

  for (const [filePath, cached] of ctx.astCache) {
    if (!isRouteFile(filePath)) continue
    walkForRoutes(cached.ast, cached.useMap, cached.namespace, ctx,
      { nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++, unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++ })
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

type Counters = { nodes: () => void; edges: () => void; skipped: () => void; unresolved: () => void; dup: () => void }

function walkForRoutes(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  if (!node || typeof node !== 'object') return

  if (isRouteCall(node)) {
    processRouteCall(node, useMap, namespace, ctx, counters)
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkForRoutes(child, useMap, namespace, ctx, counters)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      walkForRoutes(val, useMap, namespace, ctx, counters)
    }
  }
}

function isRouteCall(node: any): boolean {
  if (node.kind !== 'call') return false
  const what = node.what
  if (!what || what.kind !== 'staticlookup') return false
  const cls = what.what
  const method = extractName(what.offset)?.toLowerCase()
  if (!method) return false
  if (!ROUTE_METHODS.has(method) && method !== 'group' && method !== 'apiresource' && method !== 'resource') return false
  const clsName = extractName(cls)
  return clsName === 'Route'
}

function processRouteCall(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  const what = node.what
  const httpMethod = extractName(what.offset)?.toLowerCase()
  if (!httpMethod) return

  // Route::group — recurse into the closure body
  if (httpMethod === 'group') {
    const args = node.arguments ?? []
    const closureArg = args.find((a: any) =>
      a.kind === 'closure' || a.kind === 'arrowfunc',
    )
    if (closureArg?.body) {
      walkForRoutes(closureArg.body, useMap, namespace, ctx, counters)
    }
    return
  }

  // apiResource / resource — skip for now, complex expansion
  if (httpMethod === 'apiresource' || httpMethod === 'resource') {
    counters.skipped()
    return
  }

  const args = node.arguments ?? []
  if (args.length < 2) return

  // Extract URI
  const uriArg = args[0]
  const uri = extractStringValue(uriArg)
  if (!uri) { counters.unresolved(); return }

  const normalizedMethod = normalizeHttpMethod(httpMethod)
  const rKey = routeKey(normalizedMethod, uri)

  // Create route node
  const added = addNode(ctx, {
    key: rKey,
    kind: 'route',
    name: `${normalizedMethod} ${uri}`,
  })
  if (added) counters.nodes()

  // Extract handler
  const handlerArg = args[1]
  const handler = extractHandler(handlerArg, useMap, namespace)

  if (handler) {
    const mKey = methodKey(handler.classFqcn, handler.method)
    const edgeAdded = addEdge(ctx, {
      from: rKey,
      to: mKey,
      kind: 'route_to_controller',
      confidence: 'exact',
      source: 'laravel_scanner',
    })
    if (edgeAdded) counters.edges()
    else counters.dup()
  } else if (handlerArg?.kind === 'closure' || handlerArg?.kind === 'arrowfunc') {
    counters.skipped()
  } else {
    counters.unresolved()
  }
}

type HandlerRef = { classFqcn: string; method: string }

function extractHandler(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
): HandlerRef | null {
  if (!node) return null

  // Array form: [Controller::class, 'method']
  if (node.kind === 'array') {
    const items = node.items ?? node.value ?? []
    if (items.length >= 2) {
      const classRef = items[0]?.value ?? items[0]
      const methodRef = items[1]?.value ?? items[1]

      let classFqcn: string | null = null
      if (classRef?.kind === 'staticlookup' && extractName(classRef.offset) === 'class') {
        const className = extractName(classRef.what)
        if (className) classFqcn = resolveType(className, useMap, namespace)
      }
      const method = extractStringValue(methodRef)
      if (classFqcn && method) return { classFqcn, method }
    }
    return null
  }

  // String form: 'Namespace\Controller@method'
  const str = extractStringValue(node)
  if (str && str.includes('@')) {
    const [controller, method] = str.split('@', 2)
    if (controller && method) {
      return { classFqcn: normalizeNamespace(controller), method }
    }
  }

  return null
}

function extractStringValue(node: any): string | null {
  if (!node) return null
  if (node.kind === 'string' && typeof node.value === 'string') return node.value
  if (node.kind === 'encapsed' && Array.isArray(node.value) && node.value.length === 1) {
    return extractStringValue(node.value[0])
  }
  if (typeof node.value === 'string') return node.value
  return null
}

// ── scanControllerMethods ──

export function scanControllerMethods(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0

  for (const [filePath, cached] of ctx.astCache) {
    if (!isControllerFile(filePath)) continue

    // Find class nodes in this file
    for (const [key, node] of ctx.nodes) {
      if (node.kind !== 'class') continue
      if (node.filePath !== filePath) continue

      // Check if class extends Controller (by hierarchy or path convention)
      const isController = isControllerClass(key, ctx)
      if (!isController) continue

      // Tag with laravelRole
      node.laravelRole = 'controller'

      // Scan methods
      walkControllerAst(cached.ast, cached.useMap, cached.namespace, node.fqcn!, ctx,
        { nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++, unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++ })
    }
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

function isControllerClass(classKey: string, ctx: LaravelScannerContext): boolean {
  // Check extends chain for Controller
  const visited = new Set<string>()
  let current = classKey
  while (current && !visited.has(current)) {
    visited.add(current)
    if (current.endsWith('Controller') || current.includes('\\Controller')) return true
    const extendsEdge = ctx.edges.find(e => e.from === current && e.kind === 'extends')
    if (!extendsEdge) break
    current = extendsEdge.to
  }
  return false
}

function walkControllerAst(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  classFqcn: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  if (!node || typeof node !== 'object') return

  if (node.kind === 'class') {
    const body = node.body ?? node.children ?? []
    if (Array.isArray(body)) {
      for (const member of body) {
        if (member.kind === 'method') {
          scanControllerMethod(member, useMap, namespace, classFqcn, ctx, counters)
        }
      }
    }
    return
  }

  // Recurse to find class
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkControllerAst(child, useMap, namespace, classFqcn, ctx, counters)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      walkControllerAst(val, useMap, namespace, classFqcn, ctx, counters)
    }
  }
}

function scanControllerMethod(
  methodNode: any,
  useMap: Map<string, string>,
  namespace: string,
  classFqcn: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  const methodName = extractName(methodNode.name) || (typeof methodNode.name === 'string' ? methodNode.name : '')
  if (!methodName) return
  if (methodNode.visibility === 'private' || methodNode.visibility === 'protected') return

  const mKey = methodKey(classFqcn, methodName)

  // Check typed parameters for FormRequest subclasses
  const params = methodNode.arguments ?? methodNode.params ?? []
  if (Array.isArray(params)) {
    for (const param of params) {
      const type = param.type ?? param.typehint
      if (!type) continue
      const typeFqcn = resolveParamType(type, useMap, namespace)
      if (!typeFqcn) continue
      if (BASE_REQUEST_CLASSES.has(typeFqcn)) continue

      // Check if type name suggests it's a request (heuristic: ends with Request)
      const shortName = typeFqcn.split('\\').pop() ?? ''
      if (shortName.endsWith('Request') || isFormRequestClass(typeFqcn, ctx)) {
        const edgeAdded = addEdge(ctx, {
          from: mKey,
          to: classKey(typeFqcn),
          kind: 'controller_uses_request',
          confidence: 'exact',
          source: 'laravel_scanner',
        })
        if (edgeAdded) counters.edges()
        else counters.dup()
      }
    }
  }
}

function resolveParamType(type: any, useMap: Map<string, string>, namespace: string): string {
  if (!type) return ''
  const name = extractName(type)
  if (!name) return ''
  if (type.resolution === 'fqn' || name.includes('\\')) return normalizeNamespace(name)
  return resolveType(name, useMap, namespace)
}

function isFormRequestClass(fqcn: string, ctx: LaravelScannerContext): boolean {
  const key = classKey(fqcn)
  const visited = new Set<string>()
  let current = key
  while (current && !visited.has(current)) {
    visited.add(current)
    if (current.includes('FormRequest')) return true
    const extendsEdge = ctx.edges.find(e => e.from === current && e.kind === 'extends')
    if (!extendsEdge) break
    current = extendsEdge.to
  }
  return false
}

// ── scanJobs ──

const JOB_DISPATCH_PATTERNS = ['dispatch', 'dispatch_sync', 'dispatch_now']

export function scanJobs(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0

  for (const [filePath, cached] of ctx.astCache) {
    const isCtrl = isControllerFile(filePath)
    walkForJobDispatches(cached.ast, cached.useMap, cached.namespace, filePath, isCtrl, ctx,
      { nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++, unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++ })
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

function walkForJobDispatches(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  filePath: string,
  isCtrl: boolean,
  ctx: LaravelScannerContext,
  counters: Counters,
  currentMethod?: string,
  currentClassFqcn?: string,
): void {
  if (!node || typeof node !== 'object') return

  if (node.kind === 'class') {
    const name = extractName(node.name) || (typeof node.name === 'string' ? node.name : '')
    const fqcn = namespace ? `${namespace}\\${name}` : name
    const body = node.body ?? node.children ?? []
    if (Array.isArray(body)) {
      for (const member of body) {
        if (member.kind === 'method') {
          const mName = extractName(member.name) || (typeof member.name === 'string' ? member.name : '')
          if (mName && member.body) {
            walkForJobDispatches(member.body, useMap, namespace, filePath, isCtrl, ctx, counters, mName, fqcn)
          }
        }
      }
    }
    return
  }

  // Job::dispatch(...) — static call on a class
  if (node.kind === 'call' && node.what?.kind === 'staticlookup') {
    const method = extractName(node.what.offset)?.toLowerCase()
    if (method && JOB_DISPATCH_PATTERNS.includes(method)) {
      const cls = node.what.what
      if (cls && cls.kind !== 'selfreference' && cls.kind !== 'staticreference' && cls.kind !== 'parentreference') {
        const classFqcn = resolveNodeName(cls, useMap, namespace)
        if (classFqcn && currentMethod && currentClassFqcn) {
          emitJobEdge(classFqcn, currentClassFqcn, currentMethod, isCtrl, ctx, counters)
        }
      }
    }
  }

  // dispatch(new JobClass(...)) — function call with new
  if (node.kind === 'call') {
    const what = node.what
    const funcName = what?.kind === 'name' ? extractName(what) : (what?.kind === 'identifier' ? extractName(what) : '')
    if (funcName && JOB_DISPATCH_PATTERNS.includes(funcName.toLowerCase())) {
      const args = node.arguments ?? []
      if (args.length > 0) {
        const firstArg = args[0]?.value ?? args[0]
        if (firstArg?.kind === 'new') {
          const jobFqcn = resolveNodeName(firstArg.what, useMap, namespace)
          if (jobFqcn && currentMethod && currentClassFqcn) {
            emitJobEdge(jobFqcn, currentClassFqcn, currentMethod, isCtrl, ctx, counters)
          }
        }
      }
    }
  }

  // $this->dispatch(new JobClass(...))
  if (node.kind === 'call' && node.what?.kind === 'propertylookup') {
    const obj = node.what.what
    const method = extractName(node.what.offset)
    if (obj?.kind === 'variable' && obj.name === 'this' && method && JOB_DISPATCH_PATTERNS.includes(method.toLowerCase())) {
      const args = node.arguments ?? []
      if (args.length > 0) {
        const firstArg = args[0]?.value ?? args[0]
        if (firstArg?.kind === 'new') {
          const jobFqcn = resolveNodeName(firstArg.what, useMap, namespace)
          if (jobFqcn && currentMethod && currentClassFqcn) {
            emitJobEdge(jobFqcn, currentClassFqcn, currentMethod, isCtrl, ctx, counters)
          }
        }
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkForJobDispatches(child, useMap, namespace, filePath, isCtrl, ctx, counters, currentMethod, currentClassFqcn)
        }
      }
    } else if (val && typeof val === 'object' && val.kind && key !== 'what') {
      walkForJobDispatches(val, useMap, namespace, filePath, isCtrl, ctx, counters, currentMethod, currentClassFqcn)
    }
  }
}

function resolveNodeName(node: any, useMap: Map<string, string>, namespace: string): string {
  if (!node) return ''
  const name = extractName(node)
  if (!name) return ''
  if (node.resolution === 'fqn' || name.includes('\\')) return normalizeNamespace(name)
  return resolveType(name, useMap, namespace)
}

function emitJobEdge(
  jobFqcn: string,
  callerClassFqcn: string,
  callerMethod: string,
  isCtrl: boolean,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  const jKey = jobKey(jobFqcn)
  if (addNode(ctx, { key: jKey, kind: 'job', name: jobFqcn.split('\\').pop() ?? jobFqcn, fqcn: jobFqcn })) {
    counters.nodes()
  }
  const mKey = methodKey(callerClassFqcn, callerMethod)
  const edgeKind = isCtrl ? 'controller_dispatches_job' : 'dispatches_job'
  if (addEdge(ctx, { from: mKey, to: jKey, kind: edgeKind as any, confidence: 'exact', source: 'laravel_scanner' })) {
    counters.edges()
  } else {
    counters.dup()
  }
}

// ── scanEventsAndListeners ──

export function scanEventsAndListeners(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0
  const counters: Counters = {
    nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++,
    unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++,
  }

  // Scan EventServiceProvider $listen maps
  for (const [filePath, cached] of ctx.astCache) {
    if (!filePath.includes('EventServiceProvider')) continue
    scanListenMap(cached.ast, cached.useMap, cached.namespace, ctx, counters)
  }

  // Scan all files for event(new X()) / Event::dispatch(new X())
  for (const [filePath, cached] of ctx.astCache) {
    walkForEventEmissions(cached.ast, cached.useMap, cached.namespace, ctx, counters)
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

function scanListenMap(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  if (!node || typeof node !== 'object') return

  // Look for $listen property
  if (node.kind === 'propertystatement') {
    const props = node.properties ?? []
    for (const prop of props) {
      const name = extractName(prop.name) || (typeof prop.name === 'string' ? prop.name : '')
      if (name === 'listen' && prop.value?.kind === 'array') {
        processListenArray(prop.value, useMap, namespace, ctx, counters)
        return
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          scanListenMap(child, useMap, namespace, ctx, counters)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      scanListenMap(val, useMap, namespace, ctx, counters)
    }
  }
}

function processListenArray(
  arrayNode: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  const items = arrayNode.items ?? arrayNode.value ?? []
  for (const item of items) {
    const entry = item?.value ? item : { key: item?.key, value: item?.value ?? item }
    const eventRef = entry.key
    const listenersRef = entry.value

    if (!eventRef || !listenersRef) continue

    // Event class reference: EventClass::class
    const eventFqcn = extractClassReference(eventRef, useMap, namespace)
    if (!eventFqcn) { counters.unresolved(); continue }

    const eKey = eventKey(eventFqcn)
    if (addNode(ctx, { key: eKey, kind: 'event', name: eventFqcn.split('\\').pop() ?? eventFqcn, fqcn: eventFqcn })) {
      counters.nodes()
    }

    // Listeners array
    const listeners = listenersRef.kind === 'array' ? (listenersRef.items ?? listenersRef.value ?? []) : []
    for (const listener of listeners) {
      const listenerNode = listener?.value ?? listener
      const listenerFqcn = extractClassReference(listenerNode, useMap, namespace)
      if (!listenerFqcn) { counters.unresolved(); continue }

      const lKey = listenerKey(listenerFqcn)
      if (addNode(ctx, { key: lKey, kind: 'listener', name: listenerFqcn.split('\\').pop() ?? listenerFqcn, fqcn: listenerFqcn })) {
        counters.nodes()
      }
      if (addEdge(ctx, { from: lKey, to: eKey, kind: 'listens_to_event', confidence: 'exact', source: 'laravel_scanner' })) {
        counters.edges()
      } else {
        counters.dup()
      }
    }
  }
}

function extractClassReference(node: any, useMap: Map<string, string>, namespace: string): string {
  if (!node) return ''
  // ClassName::class
  if (node.kind === 'staticlookup' && extractName(node.offset) === 'class') {
    const className = extractName(node.what)
    if (className) return resolveType(className, useMap, namespace)
  }
  // String literal
  const str = extractStringValue(node)
  if (str && /^[A-Z]/.test(str)) return normalizeNamespace(str)
  return ''
}

function walkForEventEmissions(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
  currentMethod?: string,
  currentClassFqcn?: string,
): void {
  if (!node || typeof node !== 'object') return

  if (node.kind === 'class') {
    const name = extractName(node.name) || (typeof node.name === 'string' ? node.name : '')
    const fqcn = namespace ? `${namespace}\\${name}` : name
    const body = node.body ?? node.children ?? []
    if (Array.isArray(body)) {
      for (const member of body) {
        if (member.kind === 'method') {
          const mName = extractName(member.name) || (typeof member.name === 'string' ? member.name : '')
          if (mName && member.body) {
            walkForEventEmissions(member.body, useMap, namespace, ctx, counters, mName, fqcn)
          }
        }
      }
    }
    return
  }

  // event(new EventClass(...))
  if (node.kind === 'call') {
    const what = node.what
    const funcName = what?.kind === 'name' ? extractName(what) : (what?.kind === 'identifier' ? extractName(what) : '')
    if (funcName === 'event') {
      const args = node.arguments ?? []
      if (args.length > 0) {
        const firstArg = args[0]?.value ?? args[0]
        if (firstArg?.kind === 'new') {
          const evFqcn = resolveNodeName(firstArg.what, useMap, namespace)
          if (evFqcn && currentMethod && currentClassFqcn) {
            const eKey = eventKey(evFqcn)
            if (addNode(ctx, { key: eKey, kind: 'event', name: evFqcn.split('\\').pop() ?? evFqcn, fqcn: evFqcn })) {
              counters.nodes()
            }
            const mKey = methodKey(currentClassFqcn, currentMethod)
            if (addEdge(ctx, { from: mKey, to: eKey, kind: 'emits_event', confidence: 'exact', source: 'laravel_scanner' })) {
              counters.edges()
            } else {
              counters.dup()
            }
          }
        }
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkForEventEmissions(child, useMap, namespace, ctx, counters, currentMethod, currentClassFqcn)
        }
      }
    } else if (val && typeof val === 'object' && val.kind && key !== 'what') {
      walkForEventEmissions(val, useMap, namespace, ctx, counters, currentMethod, currentClassFqcn)
    }
  }
}

// ── scanObservers ──

export function scanObservers(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0
  const counters: Counters = {
    nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++,
    unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++,
  }

  for (const [, cached] of ctx.astCache) {
    walkForObserveRegistrations(cached.ast, cached.useMap, cached.namespace, ctx, counters)
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

function walkForObserveRegistrations(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  if (!node || typeof node !== 'object') return

  // Model::observe(Observer::class)
  if (node.kind === 'call' && node.what?.kind === 'staticlookup') {
    const method = extractName(node.what.offset)
    if (method === 'observe') {
      const modelRef = node.what.what
      const modelFqcn = resolveNodeName(modelRef, useMap, namespace)
      if (!modelFqcn) { counters.unresolved(); return }

      const args = node.arguments ?? []
      if (args.length > 0) {
        const observerRef = args[0]?.value ?? args[0]
        const observerFqcn = extractClassReference(observerRef, useMap, namespace)
        if (observerFqcn) {
          const oKey = observerKey(observerFqcn)
          const mKey = modelKey(modelFqcn)

          if (addNode(ctx, { key: oKey, kind: 'observer', name: observerFqcn.split('\\').pop() ?? observerFqcn, fqcn: observerFqcn })) {
            counters.nodes()
          }
          if (addNode(ctx, { key: mKey, kind: 'model', name: modelFqcn.split('\\').pop() ?? modelFqcn, fqcn: modelFqcn })) {
            counters.nodes()
          }
          if (addEdge(ctx, { from: oKey, to: mKey, kind: 'observes_model', confidence: 'exact', source: 'laravel_scanner' })) {
            counters.edges()
          } else {
            counters.dup()
          }
        } else {
          counters.unresolved()
        }
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkForObserveRegistrations(child, useMap, namespace, ctx, counters)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      walkForObserveRegistrations(val, useMap, namespace, ctx, counters)
    }
  }
}

// ── scanPolicies ──

export function scanPolicies(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0
  const counters: Counters = {
    nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++,
    unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++,
  }

  for (const [, cached] of ctx.astCache) {
    walkForPolicies(cached.ast, cached.useMap, cached.namespace, ctx, counters)
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

function walkForPolicies(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  if (!node || typeof node !== 'object') return

  // $policies property array
  if (node.kind === 'propertystatement') {
    const props = node.properties ?? []
    for (const prop of props) {
      const name = extractName(prop.name) || (typeof prop.name === 'string' ? prop.name : '')
      if (name === 'policies' && prop.value?.kind === 'array') {
        processPoliciesArray(prop.value, useMap, namespace, ctx, counters)
        return
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkForPolicies(child, useMap, namespace, ctx, counters)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      walkForPolicies(val, useMap, namespace, ctx, counters)
    }
  }
}

function processPoliciesArray(
  arrayNode: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  const items = arrayNode.items ?? arrayNode.value ?? []
  for (const item of items) {
    const entry = item?.value ? item : { key: item?.key, value: item?.value ?? item }
    const modelRef = entry.key
    const policyRef = entry.value

    const modelFqcn = extractClassReference(modelRef, useMap, namespace)
    const policyFqcn = extractClassReference(policyRef, useMap, namespace)
    if (!modelFqcn || !policyFqcn) { counters.unresolved(); continue }

    const pKey = policyKey(policyFqcn)
    const mKey = modelKey(modelFqcn)

    if (addNode(ctx, { key: pKey, kind: 'policy', name: policyFqcn.split('\\').pop() ?? policyFqcn, fqcn: policyFqcn })) counters.nodes()
    if (addNode(ctx, { key: mKey, kind: 'model', name: modelFqcn.split('\\').pop() ?? modelFqcn, fqcn: modelFqcn })) counters.nodes()
    if (addEdge(ctx, { from: pKey, to: mKey, kind: 'authorizes_policy', confidence: 'exact', source: 'laravel_scanner' })) counters.edges()
    else counters.dup()
  }
}

// ── scanBindings ──

const BINDING_METHODS = new Set(['bind', 'singleton', 'instance'])

export function scanBindings(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0
  const counters: Counters = {
    nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++,
    unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++,
  }

  for (const [filePath, cached] of ctx.astCache) {
    walkForBindings(cached.ast, cached.useMap, cached.namespace, filePath, ctx, counters)
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

function walkForBindings(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  filePath: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  if (!node || typeof node !== 'object') return

  // $this->app->bind|singleton|instance(Abstract::class, Concrete::class)
  if (node.kind === 'call' && node.what?.kind === 'propertylookup') {
    const method = extractName(node.what.offset)
    if (method && BINDING_METHODS.has(method)) {
      const obj = node.what.what
      if (obj?.kind === 'propertylookup') {
        const innerObj = obj.what
        const prop = extractName(obj.offset)
        if (innerObj?.kind === 'variable' && innerObj.name === 'this' && prop === 'app') {
          processBindingCall(node, method, useMap, namespace, filePath, ctx, counters)
          return
        }
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkForBindings(child, useMap, namespace, filePath, ctx, counters)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      walkForBindings(val, useMap, namespace, filePath, ctx, counters)
    }
  }
}

function processBindingCall(
  node: any,
  bindingKind: string,
  useMap: Map<string, string>,
  namespace: string,
  filePath: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  const args = node.arguments ?? []
  if (args.length < 1) return

  const abstractRef = args[0]?.value ?? args[0]
  const abstractFqcn = extractClassReference(abstractRef, useMap, namespace)

  if (!abstractFqcn) {
    // String-keyed binding like 'mcp.server' — skip, not class reference
    counters.skipped()
    return
  }

  const sbKey = serviceBindingKey(abstractFqcn)
  const fKey = `file:${filePath}`

  const sbNode: GraphNode = {
    key: sbKey,
    kind: 'service_binding',
    name: abstractFqcn.split('\\').pop() ?? abstractFqcn,
    fqcn: abstractFqcn,
    filePath,
    metadata: { bindingKind, providerFile: filePath },
  }
  if (addNode(ctx, sbNode)) counters.nodes()
  else {
    // Update metadata on existing node
    const existing = ctx.nodes.get(sbKey)
    if (existing) {
      existing.metadata = { ...existing.metadata, bindingKind, providerFile: filePath }
    }
  }

  if (addEdge(ctx, { from: fKey, to: sbKey, kind: 'binds_service', confidence: 'exact', source: 'laravel_scanner' })) counters.edges()
  else counters.dup()

  // Concrete resolution
  if (args.length >= 2) {
    const concreteRef = args[1]?.value ?? args[1]
    const concreteFqcn = extractClassReference(concreteRef, useMap, namespace)
    if (concreteFqcn) {
      if (addEdge(ctx, { from: sbKey, to: classKey(concreteFqcn), kind: 'binds_concrete', confidence: 'exact', source: 'laravel_scanner' })) counters.edges()
      else counters.dup()
    }
    // Closure concrete — no edge, acceptable
  }
}

// ── scanCommands ──

export function scanCommands(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0

  for (const [, cached] of ctx.astCache) {
    walkForCommands(cached.ast, cached.useMap, cached.namespace, ctx,
      { nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++, unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++ })
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

function walkForCommands(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  if (!node || typeof node !== 'object') return

  if (node.kind === 'class') {
    const name = extractName(node.name) || (typeof node.name === 'string' ? node.name : '')
    if (!name) return
    const fqcn = namespace ? `${namespace}\\${name}` : name

    // Check extends chain for Command
    const cKey = classKey(fqcn)
    if (extendsClass(cKey, 'Command', ctx)) {
      const cmdKey = commandKey(fqcn)
      const signature = extractPropertyString(node, 'signature')
      const cmdNode: GraphNode = {
        key: cmdKey,
        kind: 'command',
        name: name,
        fqcn,
        metadata: signature ? { signature } : undefined,
      }
      if (addNode(ctx, cmdNode)) counters.nodes()
    }
    return
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkForCommands(child, useMap, namespace, ctx, counters)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      walkForCommands(val, useMap, namespace, ctx, counters)
    }
  }
}

function extendsClass(classNodeKey: string, targetName: string, ctx: LaravelScannerContext): boolean {
  const visited = new Set<string>()
  let current = classNodeKey
  while (current && !visited.has(current)) {
    visited.add(current)
    const extendsEdge = ctx.edges.find(e => e.from === current && e.kind === 'extends')
    if (!extendsEdge) return false
    const parentKey = extendsEdge.to
    if (parentKey.endsWith(targetName) || parentKey.includes(`\\${targetName}`)) return true
    current = parentKey
  }
  return false
}

function extractPropertyString(classNode: any, propName: string): string | null {
  const body = classNode.body ?? classNode.children ?? []
  if (!Array.isArray(body)) return null
  for (const member of body) {
    if (member.kind === 'propertystatement') {
      const props = member.properties ?? []
      for (const prop of props) {
        const name = extractName(prop.name) || (typeof prop.name === 'string' ? prop.name : '')
        if (name === propName && prop.value) {
          return extractStringValue(prop.value)
        }
      }
    }
  }
  return null
}

// ── scanResourcesAndTransformers ──

export function scanResourcesAndTransformers(ctx: LaravelScannerContext): ScannerResult {
  let nodes = 0, edges = 0, skipped = 0, unresolvedRefs = 0, duplicateEdges = 0

  for (const [, cached] of ctx.astCache) {
    walkForResourcesTransformers(cached.ast, cached.useMap, cached.namespace, ctx,
      { nodes: () => nodes++, edges: () => edges++, skipped: () => skipped++, unresolved: () => unresolvedRefs++, dup: () => duplicateEdges++ })
  }

  return { nodes, edges, skipped, unresolvedRefs, duplicateEdges }
}

function walkForResourcesTransformers(
  node: any,
  useMap: Map<string, string>,
  namespace: string,
  ctx: LaravelScannerContext,
  counters: Counters,
): void {
  if (!node || typeof node !== 'object') return

  if (node.kind === 'class') {
    const name = extractName(node.name) || (typeof node.name === 'string' ? node.name : '')
    if (!name) return
    const fqcn = namespace ? `${namespace}\\${name}` : name
    const cKey = classKey(fqcn)

    // Transformer: extends Transformer or TransformerAbstract
    if (extendsClass(cKey, 'Transformer', ctx) || extendsClass(cKey, 'TransformerAbstract', ctx)) {
      const tKey = transformerKey(fqcn)
      if (addNode(ctx, { key: tKey, kind: 'transformer', name, fqcn })) counters.nodes()

      // Check transform() method for typed model param
      const modelFqcn = findTransformMethodModelParam(node, useMap, namespace)
      if (modelFqcn) {
        const mKey = modelKey(modelFqcn)
        if (addNode(ctx, { key: mKey, kind: 'model', name: modelFqcn.split('\\').pop() ?? modelFqcn, fqcn: modelFqcn })) counters.nodes()
        if (addEdge(ctx, { from: tKey, to: mKey, kind: 'transformer_transforms_model', confidence: 'exact', source: 'laravel_scanner' })) counters.edges()
        else counters.dup()
      }
    }

    // TODO: JsonResource detection can be added here for repos that use them
    return
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.kind) {
          walkForResourcesTransformers(child, useMap, namespace, ctx, counters)
        }
      }
    } else if (val && typeof val === 'object' && val.kind) {
      walkForResourcesTransformers(val, useMap, namespace, ctx, counters)
    }
  }
}

// ── tagPathRoles ──
//
// Advisory role tags derived from controller subdirectory conventions. Run
// AFTER all other scanners so it can tag controller class nodes (which the
// extractor emits with filePath set) plus any framework-aware node that
// carries a filePath. Conventions are common Laravel patterns at Engage:
// app/Http/Controllers/{Member,Admin,Application,Customer,Auth}/* — anything
// else under Controllers/ gets the lower-cased subdirectory name as a tag,
// but only when there IS a subdirectory (top-level Controllers/Foo.php is
// undifferentiated and skipped to avoid noise).

const KNOWN_CONTROLLER_ROLES: Record<string, string> = {
  Member: 'member-endpoint',
  Admin: 'admin-tool',
  Application: 'application-api',
  Customer: 'customer-admin',
  Auth: 'auth-flow',
}

function rolesForControllerPath(filePath: string): readonly string[] {
  const norm = filePath.replace(/\\/g, '/')
  const m = norm.match(/(?:^|\/)Http\/Controllers\/([^/]+)\/[^/]+\.php$/)
  if (!m) return []
  const segment = m[1]
  const known = KNOWN_CONTROLLER_ROLES[segment]
  if (known) return [known]
  // Fall back to a hyphenated, lowercased version of the segment. PascalCase
  // (OrderManagement) → order-management; single tokens (Order) → order.
  const tag = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
  return tag ? [tag] : []
}

export function tagPathRoles(ctx: LaravelScannerContext): void {
  for (const node of ctx.nodes.values()) {
    if (!node.filePath) continue
    const roles = rolesForControllerPath(node.filePath)
    if (roles.length === 0) continue
    node.roles = mergeRoles(node.roles, roles)
  }
}

function mergeRoles(existing: readonly string[] | undefined, add: readonly string[]): readonly string[] {
  const set = new Set(existing ?? [])
  for (const r of add) set.add(r)
  // Cap at 3 to avoid pollution; preserve insertion order.
  return [...set].slice(0, 3)
}

function findTransformMethodModelParam(
  classNode: any,
  useMap: Map<string, string>,
  namespace: string,
): string | null {
  const body = classNode.body ?? classNode.children ?? []
  if (!Array.isArray(body)) return null
  for (const member of body) {
    if (member.kind !== 'method') continue
    const mName = extractName(member.name) || (typeof member.name === 'string' ? member.name : '')
    if (mName !== 'transform') continue
    const params = member.arguments ?? member.params ?? []
    if (!Array.isArray(params) || params.length === 0) continue
    const firstParam = params[0]
    const type = firstParam.type ?? firstParam.typehint
    if (!type) continue
    const typeName = extractName(type)
    if (!typeName) continue
    if (type.resolution === 'fqn' || typeName.includes('\\')) return normalizeNamespace(typeName)
    return resolveType(typeName, useMap, namespace)
  }
  return null
}
