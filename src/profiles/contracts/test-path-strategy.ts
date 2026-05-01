export type TestPathStrategy = {
  candidates(sourcePath: string): readonly string[]
  isTestPath(path: string): boolean
}
