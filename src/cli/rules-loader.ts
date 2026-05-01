// Loads `.mdc` rule files (YAML frontmatter + markdown body) from one or more
// directories and returns validated `RuleRecord` entries. Invalid files are
// skipped with a warning rather than aborting — partial rule sets are useful.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { RuleRecord } from '../schemas/rule-schema'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

async function listMdcFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await listMdcFiles(full)))
    } else if (e.isFile() && e.name.endsWith('.mdc')) {
      out.push(full)
    }
  }
  return out
}

export async function loadRulesFromDirs(dirs: string[]): Promise<RuleRecord[]> {
  const results: RuleRecord[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    const files = await listMdcFiles(dir)
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      let raw: string
      try {
        raw = await readFile(file, 'utf-8')
      } catch (err) {
        process.stderr.write(`phorge: skipping rule ${file}: read error (${(err as Error).message})\n`)
        continue
      }
      const m = FRONTMATTER_RE.exec(raw)
      if (!m) {
        process.stderr.write(`phorge: skipping rule ${file}: no YAML frontmatter\n`)
        continue
      }
      let candidate: unknown
      try {
        candidate = parseYaml(m[1])
      } catch (err) {
        process.stderr.write(`phorge: skipping rule ${file}: invalid YAML (${(err as Error).message})\n`)
        continue
      }
      const parsed = RuleRecord.safeParse(candidate)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        process.stderr.write(`phorge: skipping rule ${file}: ${first.path.join('.')} ${first.message}\n`)
        continue
      }
      results.push(parsed.data)
    }
  }
  return results
}
