/**
 * server.ts — Being MCP Server definition + tool registration
 *
 * Registers tools with McpServer using zod schemas.
 * Transport is determined by index.ts (stdio / Streamable HTTP).
 *
 * #567
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { tools } from "./tools.js"

export function createBeingMcpServer(): McpServer {
  const server = new McpServer({
    name: "being",
    version: "1.0.0",
  })

  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
      try {
        const result = await tool.handler(args as Record<string, unknown>)
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        }
      }
    })
  }

  return server
}
