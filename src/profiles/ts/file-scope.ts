import type { FileScopeProvider } from '../contracts'

const EXTENSIONS = ['.ts', '.tsx', '.vue', '.mjs', '.cjs', '.js', '.jsx'] as const
const SCAN_ROOTS = [
  'app', 'src', 'pages', 'composables', 'components', 'stores',
  'server', 'layouts', 'middleware', 'plugins', 'lib', 'packages',
] as const
const IGNORE_DIRS = [
  'node_modules', 'dist', '.nuxt', '.output', 'build', 'coverage', '.next', '.svelte-kit',
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
