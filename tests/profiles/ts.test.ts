import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tsProfile, expandSynonyms } from '../../src/profiles/ts'

function fixtureRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `phorge-ts-${prefix}-`))
}

describe('tsProfile basics', () => {
  it('has the ts id and a populated lexical profile', () => {
    expect(tsProfile.id).toBe('ts')
    expect(tsProfile.lexical.synonymGroups.length).toBeGreaterThanOrEqual(12)
    expect(tsProfile.lexical.pathStopwords.has('composables')).toBe(true)
  })

  it('fileScope matches TS / Vue / JS files', () => {
    expect(tsProfile.fileScope.matches('app/foo.ts')).toBe(true)
    expect(tsProfile.fileScope.matches('app/Foo.vue')).toBe(true)
    expect(tsProfile.fileScope.matches('app/foo.tsx')).toBe(true)
    expect(tsProfile.fileScope.matches('foo.mjs')).toBe(true)
    expect(tsProfile.fileScope.matches('foo.php')).toBe(false)
  })
})

describe('tsProfile.lexical synonyms', () => {
  it('expands auth and store groups', () => {
    const out = expandSynonyms(['auth'])
    expect(out).toContain('login')
    expect(out).toContain('jwt')
    const out2 = expandSynonyms(['store'])
    expect(out2).toContain('pinia')
  })
})

describe('tsProfile.detector', () => {
  it('matches a Nuxt-style package.json', async () => {
    const dir = fixtureRepo('nuxt')
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        dependencies: { nuxt: '^3.0.0', vue: '^3.0.0' },
      }))
      expect(await tsProfile.detector.detect(dir)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('matches a monorepo with TS in a sub-package', async () => {
    const dir = fixtureRepo('mono')
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root' }))
      mkdirSync(join(dir, 'packages', 'app'), { recursive: true })
      writeFileSync(
        join(dir, 'packages', 'app', 'package.json'),
        JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }),
      )
      expect(await tsProfile.detector.detect(dir)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects empty directory', async () => {
    const dir = fixtureRepo('empty')
    try {
      expect(await tsProfile.detector.detect(dir)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('tsProfile.complexity', () => {
  it('counts branches in TS', () => {
    const r = tsProfile.complexity.analyze('a.ts', `
      export function f(x: number) {
        if (x > 0 && x < 10) return 1
        for (let i = 0; i < x; i++) { if (i % 2) continue }
        return x ?? 0
      }
    `)
    expect(r).not.toBeNull()
    // if + && + for + if + ?? = 5 branches above the base 1.
    expect(r!.cyclomatic).toBeGreaterThanOrEqual(5)
    expect(r!.methodCount).toBeGreaterThanOrEqual(1)
    expect(r!.maxNesting).toBeGreaterThanOrEqual(2)
  })

  it('handles a Vue SFC by extracting the script block', () => {
    const r = tsProfile.complexity.analyze('Foo.vue', `
      <template><div /></template>
      <script setup lang="ts">
      function f(x: number) { if (x) return 1; return 0 }
      </script>
    `)
    expect(r).not.toBeNull()
    expect(r!.cyclomatic).toBeGreaterThanOrEqual(2)
  })

  it('returns null for unsupported extensions', () => {
    expect(tsProfile.complexity.analyze('foo.php', '<?php')).toBeNull()
  })
})

describe('tsProfile.testPaths', () => {
  it('emits sibling and mirrored candidates for a TS file', () => {
    const c = tsProfile.testPaths.candidates('app/services/payment.ts')
    expect(c).toContain('app/services/payment.test.ts')
    expect(c).toContain('app/services/payment.spec.ts')
    expect(c).toContain('app/services/__tests__/payment.test.ts')
    expect(c).toContain('tests/services/payment.test.ts')
  })

  it('emits .test.ts for a .vue file', () => {
    const c = tsProfile.testPaths.candidates('components/Wallet.vue')
    expect(c).toContain('components/Wallet.test.ts')
  })

  it('isTestPath flags conventional test paths', () => {
    expect(tsProfile.testPaths.isTestPath('tests/foo.test.ts')).toBe(true)
    expect(tsProfile.testPaths.isTestPath('src/foo.spec.ts')).toBe(true)
    expect(tsProfile.testPaths.isTestPath('src/foo.ts')).toBe(false)
  })
})

describe('tsProfile.graph scanner', () => {
  it('builds nodes + edges from a synthetic TS+Vue tree', () => {
    const dir = fixtureRepo('scan')
    try {
      mkdirSync(join(dir, 'composables'), { recursive: true })
      mkdirSync(join(dir, 'components'), { recursive: true })
      mkdirSync(join(dir, 'pages', 'orders'), { recursive: true })
      mkdirSync(join(dir, 'stores'), { recursive: true })

      writeFileSync(join(dir, 'composables', 'useAuth.ts'), `
        export function useAuth() { return { login() {} } }
      `)
      writeFileSync(join(dir, 'stores', 'wallet.ts'), `
        import { defineStore } from 'pinia'
        export const useWalletStore = defineStore('wallet', { state: () => ({ balance: 0 }) })
      `)
      writeFileSync(join(dir, 'components', 'WalletCard.vue'), `
        <template><div>card</div></template>
        <script setup lang="ts">
        defineProps<{ balance: number }>()
        </script>
      `)
      writeFileSync(join(dir, 'pages', 'orders', '[id].vue'), `
        <template><WalletCard :balance="0" /></template>
        <script setup lang="ts">
        import WalletCard from '../../components/WalletCard.vue'
        import { useAuth } from '../../composables/useAuth'
        const { login } = useAuth()
        </script>
      `)

      const result = tsProfile.graph.scan({ repoRoot: dir })

      const nodeKinds = new Set(result.nodes.map(n => n.kind))
      expect(nodeKinds.has('component')).toBe(true)
      expect(nodeKinds.has('composable')).toBe(true)
      expect(nodeKinds.has('store')).toBe(true)
      expect(nodeKinds.has('route')).toBe(true)

      const edgeKinds = new Set(result.edges.map(e => e.kind))
      expect(edgeKinds.has('imports')).toBe(true)
      expect(edgeKinds.has('defines')).toBe(true)
      expect(edgeKinds.has('vue_renders')).toBe(true)
      expect(edgeKinds.has('route_to_component')).toBe(true)

      const routeNode = result.nodes.find(n => n.kind === 'route' && n.name === '/orders/:id')
      expect(routeNode).toBeDefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('scans pnpm-workspace packages and emits nodes for files under them', () => {
    const dir = fixtureRepo('pnpm-mono')
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mono', private: true }))
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
      mkdirSync(join(dir, 'packages', 'strand-agent', 'src', 'auth'), { recursive: true })
      writeFileSync(
        join(dir, 'packages', 'strand-agent', 'package.json'),
        JSON.stringify({ name: 'strand-agent' }),
      )
      writeFileSync(
        join(dir, 'packages', 'strand-agent', 'src', 'auth', 'login.ts'),
        `export function login() { return 'ok' }\n`,
      )

      const result = tsProfile.graph.scan({ repoRoot: dir })
      const fileNode = result.nodes.find(
        n => n.kind === 'file' && n.filePath === 'packages/strand-agent/src/auth/login.ts',
      )
      expect(fileNode).toBeDefined()
      const pkgStat = result.stats.perScanner.packages
      expect(pkgStat).toBeDefined()
      // repoRoot + strand-agent.
      expect(pkgStat!.nodes).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('expands npm workspaces array and registers package files', () => {
    const dir = fixtureRepo('npm-mono')
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
      )
      mkdirSync(join(dir, 'packages', 'wallet-app', 'src'), { recursive: true })
      writeFileSync(
        join(dir, 'packages', 'wallet-app', 'package.json'),
        JSON.stringify({ name: 'wallet-app' }),
      )
      writeFileSync(
        join(dir, 'packages', 'wallet-app', 'src', 'index.ts'),
        `export const x = 1\n`,
      )

      const result = tsProfile.graph.scan({ repoRoot: dir })
      const fileNode = result.nodes.find(
        n => n.kind === 'file' && n.filePath === 'packages/wallet-app/src/index.ts',
      )
      expect(fileNode).toBeDefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('emits component_uses_composable so symbol nodes have outgoing edges', () => {
    const dir = fixtureRepo('symbol-edges')
    try {
      mkdirSync(join(dir, 'composables'), { recursive: true })
      mkdirSync(join(dir, 'components'), { recursive: true })

      writeFileSync(join(dir, 'composables', 'useAuth.ts'), `
        export function useAuth() { return { login() {} } }
      `)
      writeFileSync(join(dir, 'components', 'LoginForm.vue'), `
        <template><div>login</div></template>
        <script setup lang="ts">
        import { useAuth } from '../composables/useAuth'
        const { login } = useAuth()
        </script>
      `)

      const result = tsProfile.graph.scan({ repoRoot: dir })
      const cuc = result.edges.find(
        e => e.kind === 'component_uses_composable'
          && e.from === 'component:LoginForm'
          && e.to === 'composable:useAuth',
      )
      expect(cuc).toBeDefined()
      // component:LoginForm now has > 0 outgoing edges, enabling subgraph
      // promotion via `defines`.
      const outgoingFromComp = result.edges.filter(e => e.from === 'component:LoginForm')
      expect(outgoingFromComp.length).toBeGreaterThan(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
