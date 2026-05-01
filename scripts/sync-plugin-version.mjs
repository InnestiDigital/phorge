#!/usr/bin/env node
// Sync .claude-plugin/{plugin,marketplace}.json version with package.json.
// Wired as `npm version` lifecycle script so semver bumps stay coherent
// across the three sources of truth.

import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
const v = pkg.version

const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf-8'))
plugin.version = v
writeFileSync('.claude-plugin/plugin.json', JSON.stringify(plugin, null, 2) + '\n')

const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf-8'))
if (Array.isArray(market.plugins)) {
  for (const p of market.plugins) {
    if (p.name === 'phorge') p.version = v
  }
}
writeFileSync('.claude-plugin/marketplace.json', JSON.stringify(market, null, 2) + '\n')

console.log(`[sync-plugin-version] synced to ${v}`)
