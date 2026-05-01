import { describe, it, expect } from 'vitest'
import { createMcpServer, PHORGE_MCP_TOOL_NAMES } from '../src/mcp/server'

describe('mcp server', () => {
  it('registers all expected phorge tools', () => {
    const { tools } = createMcpServer()
    const names = tools.map((t) => t.tool.name).sort()
    expect(names).toEqual([...PHORGE_MCP_TOOL_NAMES].sort())
  })

  it('every tool has a non-empty description and inputSchema with required repoPath (where applicable)', () => {
    const { tools } = createMcpServer()
    for (const t of tools) {
      expect(t.tool.description).toBeTruthy()
      expect(t.tool.inputSchema).toBeDefined()
      expect((t.tool.inputSchema as { type: string }).type).toBe('object')
    }
  })

  it('tool handler returns a structured error result on missing required args', async () => {
    const { tools } = createMcpServer()
    const cochange = tools.find((t) => t.tool.name === 'phorge_cochange')
    expect(cochange).toBeDefined()
    await expect(cochange!.handler({})).rejects.toThrow(/missing required string argument/)
  })
})
