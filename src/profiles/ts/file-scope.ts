import type { FileScopeProvider } from '../contracts'

const EXTENSIONS = ['.ts', '.tsx', '.vue', '.mjs', '.cjs', '.js', '.jsx'] as const
// Empty scanRoots = walk the repo (or each workspace package) recursively,
// pruning ignoreDirs. TS codebases vary too widely for an explicit whitelist
// (admin/, shared/, themes/, modules/, frontend/, web/, etc all show up).
const SCAN_ROOTS: readonly string[] = []
const IGNORE_DIRS = [
  'node_modules', 'dist', 'build', 'coverage', 'out',
  '.nuxt', '.output', '.next', '.svelte-kit', '.turbo', '.vercel',
  '.cache', '.parcel-cache', '.serverless',
  'tmp', 'vendor', 'target',
] as const

export const tsFileScope: FileScopeProvider = {
  extensions: EXTENSIONS,
  scanRoots: SCAN_ROOTS,
  ignoreDirs: IGNORE_DIRS,
  matches(path: string): boolean {
    const lower = path.toLowerCase()
    for (const ext of EXTENSIONS) {
      if (lower.endsWith(ext)) return true
    }
    return false
  },
}
