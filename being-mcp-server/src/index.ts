#!/usr/bin/env node
/**
 * index.ts — Being MCP Server エントリポイント
 *
 * トランスポート選択:
 *   --http [--port <n>]  Streamable HTTP（express + handleRequest パターン。デフォルトポート: 3200）
 *   (デフォルト)          stdio
 *
 * 環境変数:
 *   BEING_API_URL    — Being Worker のベースURL（デフォルト: http://localhost:3100）
 *   BEING_API_TOKEN  — 認証トークン（brt_...）必須
 *   BEING_ID         — 対象 Being ID 必須
 *   LLM_API_KEY      — LLMキー（trigger_patrol 用。任意）
 *
 * 使用例:
 *   # stdio（OpenClaw / Claude Desktop / MCP Inspector 等）
 *   BEING_API_TOKEN=brt_xxx BEING_ID=xxx node dist/index.js
 *
 *   # Streamable HTTP（Cowork / Managed Agents 等）
 *   BEING_API_TOKEN=brt_xxx BEING_ID=xxx node dist/index.js --http --port 3200
 *
 * #567
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createBeingMcpServer } from './server.js'
import { BeingApiClient } from './api-client.js'

// 起動時バリデーション
const client = new BeingApiClient()
try {
  client.validate()
} catch (err) {
  console.error(`[being-mcp] Config error: ${String(err)}`)
  process.exit(1)
}

const server = createBeingMcpServer()
const args = process.argv.slice(2)

if (args.includes('--http')) {
  // Streamable HTTP モード
  // MCP SDK v1.29.0: express + transport.handleRequest パターン
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1] ?? '3200') : 3200

  const { default: express } = await import('express')
  const app = express()
  app.use(express.json())

  // stateless: sessionIdGenerator = undefined
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  app.all('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body)
  })

  await server.connect(transport)

  app.listen(port, () => {
    console.error(`[being-mcp] Streamable HTTP listening on port ${port} (endpoint: /mcp)`)
    console.error(`[being-mcp] Being ID: ${client.beingId}`)
  })
} else {
  // stdio モード（デフォルト）
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stdio モードでは console.error のみ使用（stdout は MCP プロトコルが占有）
  console.error(`[being-mcp] stdio transport connected. Being ID: ${client.beingId}`)
}
