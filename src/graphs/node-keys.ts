export function normalizeRepoPath(path: string): string {
  let p = path.replace(/\\/g, '/')
  p = p.replace(/^\.\//, '')
  p = p.replace(/^\/+/, '')
  p = p.replace(/\/\/+/g, '/')
  return p
}

export function stripLeadingSlash(fqcn: string): string {
  return fqcn.replace(/^\\/, '')
}

export function normalizeNamespace(fqcn: string): string {
  return stripLeadingSlash(fqcn)
}

export function normalizeHttpMethod(method: string): string {
  return method.toUpperCase()
}

function fqcnKey(prefix: string, fqcn: string): string {
  return `${prefix}:${normalizeNamespace(fqcn)}`
}

export function fileKey(path: string): string {
  return `file:${normalizeRepoPath(path)}`
}

export function classKey(fqcn: string): string {
  return fqcnKey('class', fqcn)
}

export function interfaceKey(fqcn: string): string {
  return fqcnKey('interface', fqcn)
}

export function traitKey(fqcn: string): string {
  return fqcnKey('trait', fqcn)
}

export function methodKey(classFqcn: string, methodName: string): string {
  return `method:${normalizeNamespace(classFqcn)}::${methodName}`
}

export function functionKey(name: string): string {
  return `function:${normalizeNamespace(name)}`
}

export function routeKey(method: string, uri: string): string {
  return `route:${normalizeHttpMethod(method)}:${uri.trim()}`
}

export function eventKey(fqcn: string): string {
  return fqcnKey('event', fqcn)
}

export function listenerKey(fqcn: string): string {
  return fqcnKey('listener', fqcn)
}

export function jobKey(fqcn: string): string {
  return fqcnKey('job', fqcn)
}

export function observerKey(fqcn: string): string {
  return fqcnKey('observer', fqcn)
}

export function policyKey(fqcn: string): string {
  return fqcnKey('policy', fqcn)
}

export function modelKey(fqcn: string): string {
  return fqcnKey('model', fqcn)
}

export function serviceBindingKey(fqcn: string): string {
  return fqcnKey('service_binding', fqcn)
}

export function commandKey(fqcn: string): string {
  return fqcnKey('command', fqcn)
}

export function resourceKey(fqcn: string): string {
  return fqcnKey('resource', fqcn)
}

export function transformerKey(fqcn: string): string {
  return fqcnKey('transformer', fqcn)
}
