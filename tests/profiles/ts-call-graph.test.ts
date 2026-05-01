import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tsProfile } from '../../src/profiles/ts'

function fixtureRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `phorge-ts-calls-${prefix}-`))
}

describe('tsProfile call-graph extraction', () => {
  it('emits a calls edge for a cross-file named-import call', () => {
    const dir = fixtureRepo('named')
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'a.ts'), `export function foo() { return 1 }\n`)
      writeFileSync(join(dir, 'src', 'b.ts'), `
        import { foo } from './a'
        export function bar() { return foo() }
      `)

      const r = tsProfile.graph.scan({ repoRoot: dir })
      const edge = r.edges.find(
        e => e.kind === 'calls' && e.to === 'function:foo' && e.from === 'function:bar',
      )
      expect(edge).toBeDefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolves a property-access call through a named import', () => {
    const dir = fixtureRepo('prop')
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'client.ts'), `
        export class Client { send(msg: string) { return msg } }
      `)
      writeFileSync(join(dir, 'src', 'caller.ts'), `
        import { Client } from './client'
        export function go(c: Client) { return c.send('x') }
      `)

      const r = tsProfile.graph.scan({ repoRoot: dir })
      // The leftmost ident `c` doesn't resolve, but `Client` is imported —
      // namespace-style resolution doesn't apply to a parameter binding,
      // so this asserts no false-positive edge to `class:Client`.
      const propEdge = r.edges.find(
        e => e.kind === 'calls' && e.from === 'function:go' && e.to === 'class:Client',
      )
      // The `Client` class node must exist (defines verified).
      const classNode = r.nodes.find(n => n.kind === 'class' && n.name === 'Client')
      expect(classNode).toBeDefined()
      // No spurious calls edge for the parameter dispatch case.
      expect(propEdge).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolves namespace-import property calls (ns.foo())', () => {
    const dir = fixtureRepo('ns')
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'auth.ts'), `export function refresh() { return 1 }\n`)
      writeFileSync(join(dir, 'src', 'caller.ts'), `
        import * as OAuth from './auth'
        export function run() { return OAuth.refresh() }
      `)

      const r = tsProfile.graph.scan({ repoRoot: dir })
      const edge = r.edges.find(
        e => e.kind === 'calls' && e.from === 'function:run' && e.to === 'function:refresh',
      )
      expect(edge).toBeDefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('emits no edge for bare-specifier (third-party) calls', () => {
    const dir = fixtureRepo('bare')
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'a.ts'), `
        import * as React from 'react'
        export function f() { return React.useState(0) }
      `)

      const r = tsProfile.graph.scan({ repoRoot: dir })
      const callsEdges = r.edges.filter(e => e.kind === 'calls')
      // Only intra-project calls qualify; React.useState resolves to nothing.
      expect(callsEdges.length).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('emits a calls edge from a Vue component to an imported composable', () => {
    const dir = fixtureRepo('vue')
    try {
      mkdirSync(join(dir, 'composables'), { recursive: true })
      mkdirSync(join(dir, 'components'), { recursive: true })
      writeFileSync(join(dir, 'composables', 'useAuth.ts'), `
        export function useAuth() { return { login() {} } }
      `)
      writeFileSync(join(dir, 'components', 'LoginForm.vue'), `
        <template><div /></template>
        <script setup lang="ts">
        import { useAuth } from '../composables/useAuth'
        const { login } = useAuth()
        </script>
      `)

      const r = tsProfile.graph.scan({ repoRoot: dir })
      const edge = r.edges.find(
        e => e.kind === 'calls'
          && e.from === 'component:LoginForm'
          && e.to === 'composable:useAuth',
      )
      expect(edge).toBeDefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('drops unresolved calls silently (callee not defined in project)', () => {
    const dir = fixtureRepo('unresolved')
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'a.ts'), `
        export function f() { return mystery() }
      `)
      const r = tsProfile.graph.scan({ repoRoot: dir })
      const callsEdges = r.edges.filter(e => e.kind === 'calls')
      expect(callsEdges.length).toBe(0)
      // And no error, no extra nodes for `mystery`.
      expect(r.nodes.find(n => n.name === 'mystery')).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
