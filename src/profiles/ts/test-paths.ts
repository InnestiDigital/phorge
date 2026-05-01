import { extname, dirname, basename, join } from 'node:path'
import type { TestPathStrategy } from '../contracts'

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.cjs'])

export const tsTestPaths: TestPathStrategy = {
  candidates(sourcePath: string): readonly string[] {
    const ext = extname(sourcePath)
    if (!SOURCE_EXTS.has(ext)) return []

    const dir = dirname(sourcePath)
    const base = basename(sourcePath, ext)

    // .vue files use .test.ts / .spec.ts; everything else preserves original ext.
    const testExt = ext === '.vue' ? '.ts' : ext

    const out = new Set<string>()

    // Sibling .test / .spec
    out.add(joinPosix(dir, `${base}.test${testExt}`))
    out.add(joinPosix(dir, `${base}.spec${testExt}`))
    // .tsx alternative for .ts inputs
    if (ext === '.ts') out.add(joinPosix(dir, `${base}.test.tsx`))

    // Sibling __tests__/
    out.add(joinPosix(dir, '__tests__', `${base}.test${testExt}`))
    out.add(joinPosix(dir, '__tests__', `${base}.spec${testExt}`))

    // Mirrored under top-level tests/ and __tests__/, stripping the leading
    // scan-root segment (app/, src/, etc).
    const mirrored = stripScanRoot(sourcePath)
    const mirroredDir = dirname(mirrored)
    const mirroredBase = basename(mirrored, ext)
    out.add(joinPosix('tests', mirroredDir, `${mirroredBase}.test${testExt}`))
    out.add(joinPosix('tests', mirroredDir, `${mirroredBase}.spec${testExt}`))
    out.add(joinPosix('__tests__', mirroredDir, `${mirroredBase}.test${testExt}`))
    out.add(joinPosix('__tests__', mirroredDir, `${mirroredBase}.spec${testExt}`))

    return [...out]
  },
  isTestPath(path: string): boolean {
    return /(?:^|\/)__tests__\//.test(path)
      || /(?:^|\/)tests?\//.test(path)
      || /\.(test|spec)\.[a-z0-9]+$/i.test(path)
  },
}

function joinPosix(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'))
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
}

function stripScanRoot(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const ROOTS = ['app/', 'src/', 'pages/', 'composables/', 'components/', 'stores/',
    'server/', 'layouts/', 'middleware/', 'plugins/', 'lib/', 'packages/']
  for (const r of ROOTS) {
    if (norm.startsWith(r)) return norm.slice(r.length)
  }
  return norm
}

// keep `join` available for test/typecheck symmetry with other profiles
void join
