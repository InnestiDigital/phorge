import { describe, it, expect } from 'vitest'
import { parsePhpFile, type ParseResult } from '../src/graphs/php-parser'

const SIMPLE_CLASS = `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Order extends Model
{
    public function updateStatus(string $status): void
    {
        $this->status = $status;
    }
}
`

const INTERFACE_FILE = `<?php
namespace Services\\Shop\\Checkout\\Steps;

interface StepInterface
{
    public function handle($orderRef, \\Closure $next);
}
`

const TRAIT_FILE = `<?php
namespace App\\Traits;

trait Auditable
{
    public function getAuditLog(): array
    {
        return [];
    }
}
`

const SYNTAX_ERROR = `<?php
class Broken {
    public function foo(
}
`

const EMPTY_FILE = `<?php
`

const MULTIPLE_CLASSES = `<?php
namespace App\\Support;

class Helper
{
    public static function format(): string { return ''; }
}

class Formatter
{
    public function run(): void {}
}
`

describe('parsePhpFile — basic parsing', () => {
  it('parses a simple class with method', () => {
    const result = parsePhpFile(SIMPLE_CLASS)
    expect(result.ast).toBeDefined()
    expect(result.errors).toHaveLength(0)
  })

  it('parses an interface', () => {
    const result = parsePhpFile(INTERFACE_FILE)
    expect(result.ast).toBeDefined()
    expect(result.errors).toHaveLength(0)
  })

  it('parses a trait', () => {
    const result = parsePhpFile(TRAIT_FILE)
    expect(result.ast).toBeDefined()
    expect(result.errors).toHaveLength(0)
  })

  it('parses empty PHP file without error', () => {
    const result = parsePhpFile(EMPTY_FILE)
    expect(result.ast).toBeDefined()
    expect(result.errors).toHaveLength(0)
  })

  it('parses file with multiple classes', () => {
    const result = parsePhpFile(MULTIPLE_CLASSES)
    expect(result.ast).toBeDefined()
    expect(result.errors).toHaveLength(0)
  })
})

describe('parsePhpFile — error handling', () => {
  it('returns AST with errors for syntax errors (suppressErrors)', () => {
    const result = parsePhpFile(SYNTAX_ERROR)
    expect(result.ast).toBeDefined()
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('parsePhpFile — AST structure', () => {
  it('AST root is a program node', () => {
    const result = parsePhpFile(SIMPLE_CLASS)
    expect(result.ast.kind).toBe('program')
  })

  it('AST contains namespace node', () => {
    const result = parsePhpFile(SIMPLE_CLASS)
    const ns = findNode(result.ast, 'namespace')
    expect(ns).toBeDefined()
  })

  it('AST contains class node', () => {
    const result = parsePhpFile(SIMPLE_CLASS)
    const cls = findNode(result.ast, 'class')
    expect(cls).toBeDefined()
  })

  it('AST contains method node', () => {
    const result = parsePhpFile(SIMPLE_CLASS)
    const method = findNode(result.ast, 'method')
    expect(method).toBeDefined()
  })
})

function findNode(node: any, kind: string): any {
  if (!node || typeof node !== 'object') return undefined
  if (node.kind === kind) return node
  for (const key of Object.keys(node)) {
    const val = node[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        const found = findNode(child, kind)
        if (found) return found
      }
    } else if (val && typeof val === 'object' && val.kind) {
      const found = findNode(val, kind)
      if (found) return found
    }
  }
  return undefined
}
