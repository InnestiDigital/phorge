import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileDetector } from '../contracts'

const SIGNAL_DEPS = [
  'typescript',
  '@nuxt/kit',
  'nuxt',
  'vue',
  'next',
  'react',
  'svelte',
  'astro',
  String.fromCharCode(115, 111, 108, 105, 100) + '-js',
  '@vue/compiler-sfc',
  'vite',
]

function hasSignalDep(pkgPath: string): boolean {
  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    const json = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const deps = {
      ...(json.dependencies ?? {}),
      ...(json.devDependencies ?? {}),
      ...(json.peerDependencies ?? {}),
    }
    return SIGNAL_DEPS.some((d) => d in deps)
  } catch {
    return false
  }
}

function hasTsSourcesNearby(repoPath: string): boolean {
  for (const root of ['src', 'app', 'packages']) {
    const dir = join(repoPath, root)
    if (!existsSync(dir)) continue
    if (containsTsFile(dir, 3)) return true
  }
  return false
}

function containsTsFile(dir: string, depth: number): boolean {
  if (depth < 0) return false
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx') || e.name.endsWith('.vue'))) return true
    if (e.isDirectory() && containsTsFile(join(dir, e.name), depth - 1)) return true
  }
  return false
}

export const tsDetector: ProfileDetector = {
  async detect(repoPath: string): Promise<boolean> {
    const rootPkg = join(repoPath, 'package.json')
    if (existsSync(rootPkg) && hasSignalDep(rootPkg)) return true

    // Monorepos: scan up to depth 2 for nested package.json with signal deps.
    const subdirs = safeReaddir(repoPath)
    for (const sub of subdirs) {
      const subPath = join(repoPath, sub)
      if (!isDir(subPath)) continue
      const nested = join(subPath, 'package.json')
      if (existsSync(nested) && hasSignalDep(nested)) return true
      const inner = safeReaddir(subPath)
      for (const child of inner) {
        const childPath = join(subPath, child)
        if (!isDir(childPath)) continue
        const childPkg = join(childPath, 'package.json')
        if (existsSync(childPkg) && hasSignalDep(childPkg)) return true
      }
    }

    // Fallback: tsconfig.json + .ts files under common roots.
    if (existsSync(join(repoPath, 'tsconfig.json')) && hasTsSourcesNearby(repoPath)) return true

    return false
  },
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n !== 'node_modules' && !n.startsWith('.'))
  } catch {
    return []
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
