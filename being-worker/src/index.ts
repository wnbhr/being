import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyFormbody from '@fastify/formbody'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { config } from './config.js'
import { jobsRoute } from './routes/jobs.js'
import { healthRoute } from './routes/health.js'
import { warmRoute } from './routes/warm.js'
import { patrolRoute } from './routes/patrol.js'
import { bridgeWsRoute } from './routes/bridge-ws.js'
import { beingCrudRoute } from './routes/being-crud.js'
import { beingSettingsRoute } from './routes/being-settings.js'
import { beingMemoryRoute } from './routes/being-memory.js'
import { beingContextRoute } from './routes/being-context.js'
import { beingPatrolRoute } from './routes/being-patrol.js'
import { capabilitiesRoute } from './routes/capabilities.js'
import { senseRoute } from './routes/sense.js'
import { beingIdentityRoute } from './routes/being-identity.js'
import { mcpRoute } from './routes/mcp.js'
import { beingExtensionsRoute } from './routes/being-extensions.js'
import { beingToolLoopRoute } from './routes/being-tool-loop.js'
import { telegramWebhookRoute } from './routes/telegram-webhook.js'
import { oauthMetadataRoute } from './routes/oauth-metadata.js'
import { oauthDcrRoute } from './routes/oauth-dcr.js'
import { oauthAuthorizeRoute } from './routes/oauth-authorize.js'
import { oauthTokenRoute } from './routes/oauth-token.js'

const app = Fastify({ logger: true })
const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

// ── CORS (#239) ──────────────────────────────────────────────────────────────
// Bridge App オリジン許可（開発中は全許可。本番前に絞る）
// application/x-www-form-urlencoded パース（OAuth フォーム送信用）
await app.register(fastifyFormbody)

await app.register(fastifyCors, {
  origin: [
    'https://ruddia.com',
    'https://www.ruddia.com',
    'https://being.ruddia.com',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-LLM-API-Key'],
})

// ── Rate limit: グローバル 60 req/min/IP ───────────────────
await app.register(fastifyRateLimit, {
  max: 60,
  timeWindow: '1 minute',
  // グローバルデフォルト: 60 req/min/IP。個別ルートで上書き可能

  global: true,
  errorResponseBuilder: (request, context) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    'Retry-After': Math.ceil(context.ttl / 1000),
  }),
})

/**
 * 認証ミドルウェア
 * - /health はスキップ
 * - /v1/ 配下は being_api_tokens テーブルのDBトークン検索で認証 (#546)
 *   - フォールバック: 環境変数 BEING_API_TOKEN
 *   - user_id と scope を request に注入
 *   - read-only スコープは GET のみ許可
 *   - last_used_at を fire-and-forget で更新
 * - その他は WORKER_SECRET で認証（既存ルート）
 */
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return
  if (request.url.startsWith('/.well-known/')) return
  if (request.url === '/oauth/register' || request.url.startsWith('/oauth/clients/')) return
  if (request.url.startsWith('/oauth/authorize')) return
  if (request.url === '/oauth/token') return

  // Being Identity エンドポイントは認証不要（公開情報）
  if (/^\/v1\/beings\/[^/]+\/identity/.test(request.url)) return

  // Telegram Webhook は認証不要（X-Telegram-Bot-Api-Secret-Token で内部検証）
  if (/^\/v1\/extensions\/telegram\/webhook\//.test(request.url)) return

  // /mcp は routes/mcp.ts 内で Being API トークン認証を行う
  if (request.url.startsWith('/mcp')) return

  if (request.url.startsWith('/v1/')) {
    const auth = request.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) {
      return reply.code(401).header(
        'WWW-Authenticate',
        'Bearer realm="being-api", resource_metadata="https://being.ruddia.com/.well-known/oauth-protected-resource"'
      ).send({ error: 'Unauthorized' })
    }

    // bto_ プレフィックス → OAuth access token 検証 (#757)
    if (token.startsWith('bto_')) {
      const oauthTokenHash = crypto.createHash('sha256').update(token).digest('hex')
      const { data: oauthToken } = await supabase
        .from('oauth_access_tokens')
        .select('user_id, being_id, scope, expires_at, revoked')
        .eq('token', oauthTokenHash)
        .single()

      if (oauthToken && !oauthToken.revoked && new Date(oauthToken.expires_at) > new Date()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(request as any).beingUserId = oauthToken.user_id
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(request as any).beingScope = oauthToken.scope
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(request as any).beingId = oauthToken.being_id
        return
      }

      return reply.code(401).header(
        'WWW-Authenticate',
        'Bearer realm="being-api", resource_metadata="https://being.ruddia.com/.well-known/oauth-protected-resource"'
      ).send({ error: 'Unauthorized' })
    }

    // brt_ / その他 → 既存 Bearer token（being_api_tokens テーブル）
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    const { data: tokenRow } = await supabase
      .from('being_api_tokens')
      .select('user_id, scope, revoked_at')
      .eq('token_hash', tokenHash)
      .single()

    if (tokenRow && !tokenRow.revoked_at) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(request as any).beingUserId = tokenRow.user_id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(request as any).beingScope = tokenRow.scope

      if (tokenRow.scope === 'read-only' && request.method !== 'GET') {
        return reply.code(403).send({ error: 'Read-only token cannot perform this action' })
      }

      supabase
        .from('being_api_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('token_hash', tokenHash)
        .then(undefined, () => {})

      return
    }

    // フォールバック: 環境変数 BEING_API_TOKEN（過渡期）
    if (config.beingApiToken && auth === `Bearer ${config.beingApiToken}`) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(request as any).beingUserId = config.beingApiUserId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(request as any).beingScope = 'full'
      return
    }

    return reply.code(401).header(
      'WWW-Authenticate',
      'Bearer realm="being-api", resource_metadata="https://being.ruddia.com/.well-known/oauth-protected-resource"'
    ).send({ error: 'Unauthorized' })
  } else {
    const auth = request.headers.authorization
    if (!config.workerSecret || auth !== `Bearer ${config.workerSecret}`) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
  }
})

app.register(jobsRoute)
app.register(healthRoute)
app.register(warmRoute)
app.register(patrolRoute)
app.register(bridgeWsRoute)
app.register(beingCrudRoute)
app.register(beingSettingsRoute)
app.register(beingMemoryRoute)
app.register(beingContextRoute)
app.register(beingPatrolRoute)
app.register(capabilitiesRoute)
app.register(senseRoute)
app.register(beingIdentityRoute)
app.register(mcpRoute)
app.register(beingExtensionsRoute)
app.register(beingToolLoopRoute)
app.register(telegramWebhookRoute)
app.register(oauthMetadataRoute)
app.register(oauthDcrRoute)
app.register(oauthAuthorizeRoute)
app.register(oauthTokenRoute)

app.listen({ port: config.port, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`Being worker listening on :${config.port}`)
})
