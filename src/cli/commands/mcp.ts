// `phorge mcp serve` — expose phorge primitives over the Model Context Protocol.
//
// Stdio (not HTTP) because MCP clients (Claude Desktop, Claude Code, Cursor)
// spawn local servers and communicate over stdin/stdout per the MCP spec.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from '../../mcp/server.js'
import { fail, type ParsedCli } from '../args'

export async function runMcp(cli: ParsedCli): Promise<void> {
  const sub = cli.positionals[0] ?? 'serve'
  if (sub !== 'serve') fail(`mcp: unknown subcommand "${sub}" (expected: serve)`)

  const { server } = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('phorge mcp server listening on stdio\n')
}
