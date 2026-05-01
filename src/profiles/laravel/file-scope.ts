import type { FileScopeProvider } from '../contracts'

const EXTENSIONS = ['.php'] as const
const SCAN_ROOTS = ['app', 'routes', 'tests', 'database/migrations', 'config'] as const
const IGNORE_DIRS = ['vendor', 'node_modules', '.git', '.phorge', 'storage', 'bootstrap'] as const

export const laravelFileScope: FileScopeProvider = {
  extensions: EXTENSIONS,
  scanRoots: SCAN_ROOTS,
  ignoreDirs: IGNORE_DIRS,
  matches(path: string): boolean {
    return path.endsWith('.php')
  },
}
