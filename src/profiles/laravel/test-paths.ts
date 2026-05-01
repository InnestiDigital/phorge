import type { TestPathStrategy } from '../contracts'

export const laravelTestPaths: TestPathStrategy = {
  candidates(sourcePath: string): readonly string[] {
    let relative = sourcePath
    if (relative.startsWith('src/')) relative = relative.slice(4)
    else if (relative.startsWith('app/')) relative = relative.slice(4)
    const testBase = relative.replace(/\.php$/, 'Test.php')
    return [`tests/Unit/${testBase}`, `tests/Feature/${testBase}`]
  },
  isTestPath(path: string): boolean {
    return /^tests\//.test(path) || /Test\.php$/.test(path)
  },
}
