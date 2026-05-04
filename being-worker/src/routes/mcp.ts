/**
 * routes/mcp.ts — Being MCP Server (Streamable HTTP) (#612)
 *
 * POST /mcp  — MCP メッセージ送受信
 * GET  /mcp  — SSE ストリーム
 * DELETE /mcp — セッション終了
 *
 * 認証:
 * - Bearer brt_... → SHA-256 → being_api_tokens テーブル照合（+ being_id クエリ/パス必須）
 * - Bearer bto_... → SHA-256 → oauth_access_tokens テーブル照合（being_id はトークンに紐づき）
 *
 * being-mcp-server の stateless 設計に合わせ sessionIdGenerator: undefined を使用。
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { config } from '../config.js'
import { createMcpServer } from '../mcp/server.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

// ── Being API トークン認証 ───────────────────────────────────────────────────

interface AuthResult {
  userId: string
  beingId: string
  scope: string
}

/**
 * MCP リクエストの認証。トークンプレフィックスで分岐:
 * - bto_: OAuth access token → being_id はトークンに紐づき
 * - brt_: Being API token → being_id はリクエストから（クエリ/パス）
 * - その他: 環境変数フォールバック
 */
async function authenticateMcpRequest(
  token: string,
  requestBeingId?: string
): Promise<AuthResult | null> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  // ── OAuth access token (bto_) ──
  if (token.startsWith('bto_')) {
    const { data: oauthToken } = await supabase
      .from('oauth_access_tokens')
      .select('user_id, being_id, scope, revoked, expires_at')
      .eq('token', tokenHash)
      .single()

    if (!oauthToken || oauthToken.revoked) return null
    if (new Date(oauthToken.expires_at) < new Date()) return null

    return {
      userId: oauthToken.user_id,
      beingId: oauthToken.being_id,
      scope: oauthToken.scope ?? 'full',
    }
  }

  // ── Being API token (brt_) ──
  if (!requestBeingId) return null  // brt_ の場合 being_id 必須

  const { data: tokenRow } = await supabase
    .from('being_api_tokens')
    .select('user_id, scope, revoked_at')
    .eq('token_hash', tokenHash)
    .single()

  if (tokenRow && !tokenRow.revoked_at) {
    const { data: being } = await supabase
      .from('beings')
      .select('id')
      .eq('id', requestBeingId)
      .eq('owner_id', tokenRow.user_id)
      .single()
    if (!being) return null
    return { userId: tokenRow.user_id, beingId: requestBeingId, scope: tokenRow.scope ?? 'full' }
  }

  // フォールバック: 環境変数 BEING_API_TOKEN
  if (config.beingApiToken && token === config.beingApiToken) {
    const userId = config.beingApiUserId
    if (!userId) return null
    const { data: being } = await supabase
      .from('beings')
      .select('id')
      .eq('id', requestBeingId)
      .eq('owner_id', userId)
      .single()
    if (!being) return null
    return { userId, beingId: requestBeingId, scope: 'full' }
  }

  return null
}

// ── ルートハンドラ ───────────────────────────────────────────────────────────

export const mcpRoute: FastifyPluginAsync = async (app) => {
  const handleMcpRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    // being_id: パスパラメータ → クエリパラメータ → トークンから解決
    const params = request.params as Record<string, string>
    const query = request.query as Record<string, string>
    const requestBeingId = params.beingId || query.being_id || undefined

    // Bearer トークン認証
    const authHeader = request.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!token) {
      return reply.code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'Unauthorized' })
    }

    const auth = await authenticateMcpRequest(token, requestBeingId)
    if (!auth) {
      return reply.code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'Unauthorized' })
    }

    const beingId = auth.beingId

    // read-only スコープ: GET は常に許可。POST はJSON-RPCメソッドを確認し書き込み系を拒否
    if (auth.scope === 'read-only' && request.method === 'POST') {
      const READONLY_METHODS = new Set([
        'initialize', 'notifications/initialized',
        'tools/list', 'tools/call',
        'resources/list', 'resources/read',
        'prompts/list', 'prompts/get',
        'ping',
      ])
      const READONLY_TOOLS = new Set(['recall_memory', 'search_history', 'get_context', 'get_current_time', 'recall'])
      const body = request.body as Record<string, unknown> | null
      const method = body?.method as string | undefined
      if (method && !READONLY_METHODS.has(method)) {
        return reply.code(403).send({ error: 'Read-only token cannot perform this action' })
      }
      if (method === 'tools/call') {
        const toolName = (body?.params as Record<string, unknown>)?.name as string | undefined
        if (toolName && !READONLY_TOOLS.has(toolName)) {
          return reply.code(403).send({ error: 'Read-only token cannot call write tools' })
        }
      }
    }

    const llmApiKey = request.headers['x-llm-api-key'] as string | undefined

    // MCP サーバー + トランスポートをリクエストごとに生成（stateless）
    const mcpServer = await createMcpServer(auth.userId, beingId, supabase, { llmApiKey })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await mcpServer.connect(transport)

    // Fastify のレスポンス管理を無効化して MCP SDK に委譲
    reply.hijack()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await transport.handleRequest(request.raw, reply.raw, request.body as any)
    } catch (err) {
      console.error(JSON.stringify({ event: 'mcp_transport_error', error: String(err) }))
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' })
        reply.raw.end(JSON.stringify({ error: 'Internal MCP error' }))
      }
    } finally {
      await mcpServer.close().catch(() => {})
    }
  }

  // OAuth (bto_): /mcp のみ — being_id はトークンに紐づき
  // Bearer (brt_): /mcp/:beingId or /mcp?being_id= — being_id はリクエストから
  app.post('/mcp', handleMcpRequest)
  app.get('/mcp', handleMcpRequest)
  app.delete('/mcp', handleMcpRequest)
  app.post('/mcp/:beingId', handleMcpRequest)
  app.get('/mcp/:beingId', handleMcpRequest)
  app.delete('/mcp/:beingId', handleMcpRequest)
}
