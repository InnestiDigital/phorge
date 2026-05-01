import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileDetector } from '../contracts'

export const laravelDetector: ProfileDetector = {
  async detect(repoPath: string): Promise<boolean> {
    const composerPath = join(repoPath, 'composer.json')
    if (!existsSync(composerPath)) return false
    try {
      const raw = readFileSync(composerPath, 'utf-8')
      const json = JSON.parse(raw) as {
        require?: Record<string, string>
        ['require-dev']?: Record<string, string>
      }
      const deps = { ...(json.require ?? {}), ...(json['require-dev'] ?? {}) }
      return 'laravel/framework' in deps || 'illuminate/support' in deps
    } catch {
      return false
    }
  },
}
