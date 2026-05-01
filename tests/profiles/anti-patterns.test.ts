import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', 'src')

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) walk(full, acc)
    else if (s.isFile() && full.endsWith('.ts')) acc.push(full)
  }
  return acc
}

const ALL_TS = walk(ROOT)

const NON_PROFILE_TS = ALL_TS.filter((p) => !relative(ROOT, p).startsWith('profiles' + sep))

describe('anti-patterns: production code does not branch on profile id or import private profile modules', () => {
  it('no `profile.id === ...` style branching outside src/profiles/', () => {
    const offenders: string[] = []
    for (const file of NON_PROFILE_TS) {
      const text = readFileSync(file, 'utf-8')
      if (/profile\.id\s*[=!]==/.test(text)) offenders.push(relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })

  it('no direct imports from src/profiles/laravel/* outside src/profiles/', () => {
    const offenders: string[] = []
    for (const file of NON_PROFILE_TS) {
      const text = readFileSync(file, 'utf-8')
      if (/import[^\n]*from\s+['"][^'"]*\/profiles\/laravel/.test(text)) {
        offenders.push(relative(ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('no direct imports from src/profiles/ts/* outside src/profiles/', () => {
    const offenders: string[] = []
    for (const file of NON_PROFILE_TS) {
      const text = readFileSync(file, 'utf-8')
      if (/import[^\n]*from\s+['"][^'"]*\/profiles\/ts/.test(text)) {
        offenders.push(relative(ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('anti-patterns: meta-process keywords forbidden in src/ comments', () => {
  const FORBIDDEN = ['SOLID', 'ISP', 'DIP', 'SRP', 'OCP', 'LSP', 'phase 1', 'phase 2']

  it.each(FORBIDDEN)('does not mention %s', (keyword) => {
    const offenders: string[] = []
    const re = new RegExp(`\\b${keyword.replace(/ /g, '\\s+')}\\b`, 'i')
    for (const file of ALL_TS) {
      const text = readFileSync(file, 'utf-8')
      if (re.test(text)) offenders.push(relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })
})
