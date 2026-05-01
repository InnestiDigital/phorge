export type FileScopeProvider = {
  readonly extensions: readonly string[]
  readonly scanRoots: readonly string[]
  readonly ignoreDirs: readonly string[]
  matches(path: string): boolean
}
