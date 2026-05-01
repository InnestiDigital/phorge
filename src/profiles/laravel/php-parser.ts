import { Engine } from 'php-parser'

export type ParseError = {
  message: string
  line?: number
}

export type ParseResult = {
  ast: any
  errors: ParseError[]
}

const engine = new Engine({
  parser: {
    extractDoc: false,
    php7: true,
    suppressErrors: true,
  },
  ast: {
    withPositions: true,
    withSource: false,
  },
})

export function parsePhpFile(source: string): ParseResult {
  const errors: ParseError[] = []

  let ast: any
  try {
    ast = engine.parseCode(source, 'input.php')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ast: { kind: 'program', children: [] },
      errors: [{ message: msg }],
    }
  }

  if (ast.errors && Array.isArray(ast.errors)) {
    for (const e of ast.errors) {
      errors.push({
        message: e.message ?? String(e),
        line: e.line,
      })
    }
  }

  return { ast, errors }
}
