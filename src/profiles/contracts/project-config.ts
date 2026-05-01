import { z } from 'zod'

export const PhorgeProjectConfigSchema = z.object({
  profileOverride: z.string().optional(),
  synonyms: z.array(z.array(z.string().min(1)).min(2)).optional(),
  pathStopwords: z.array(z.string().min(1)).optional(),
  pathRoles: z.array(z.object({
    glob: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
  })).optional(),
  edgeWeights: z.array(z.object({
    edgeKind: z.string().min(1),
    whenPromptContains: z.array(z.string().min(1)).min(1),
    multiplier: z.number().positive(),
  })).optional(),
  alwaysInclude: z.array(z.string().min(1)).optional(),
  alwaysExclude: z.array(z.string().min(1)).optional(),
  confidenceBoosts: z.array(z.object({
    source: z.string().min(1),
    from: z.enum(['low', 'medium', 'high']),
    to: z.enum(['low', 'medium', 'high']),
  })).optional(),
}).strict()

export type PhorgeProjectConfig = z.infer<typeof PhorgeProjectConfigSchema>

// Minimal repo-root-relative glob: supports `**`, `*`, `?`. No brace expansion.
// Kept inline to avoid a runtime dep — phorge ships zero glob libs.
export function matchGlob(glob: string, path: string): boolean {
  const re = globToRegex(glob)
  return re.test(path)
}

function globToRegex(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches any number of path segments (including zero)
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  re += '$'
  return new RegExp(re)
}
