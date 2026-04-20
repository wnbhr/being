/**
 * oauth-token.ts — OAuth 2.1 Token Endpoint
 *
 * POST /oauth/token
 *
 * Supported grant types:
 *   - authorization_code (with PKCE)
 *   - refresh_token (with replay attack protection)
 *
 * spec-39 §11-1
 * #756
 *
 * TODO: add rate limit (10 req/min/IP) to prevent brute-force attacks
 * TODO: hash tokens before storing (SHA-256), compare by hash on lookup (defense-in-depth against DB leak)
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { config } from '../config.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest()
  const computed = hash.toString('base64url')
  return computed === codeChallenge
}

function generateAccessToken(): string {
  return 'bto_' + crypto.randomBytes(32).toString('base64url')
}

function generateRefreshToken(): string {
  return 'btr_' + crypto.randomBytes(32).toString('base64url')
}

interface TokenRequestBody {
  grant_type?: string
  code?: string
  redirect_uri?: string
  client_id?: string
  code_verifier?: string
  refresh_token?: string
}

type ClientAuthResult =
  | { clientId: string }
  | { error: string; error_description: string; status: number }

/**
 * Authenticate client from request.
 * Supports:
 *   - Basic auth header: Authorization: Basic base64(client_id:client_secret)
 *   - Body client_id (public clients)
 *
 * For confidential clients (client_secret_basic), validates secret against SHA-256 hash in DB.
 */
async function authenticateClient(
  request: import('fastify').FastifyRequest<{ Body: TokenRequestBody }>,
): Promise<ClientAuthResult> {
  const authHeader = request.headers.authorization

  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString()
    const colonIdx = decoded.indexOf(':')
    if (colonIdx === -1) {
      return { error: 'invalid_client', error_description: 'Invalid Basic auth header', status: 401 }
    }
    const clientId = decoded.slice(0, colonIdx)
    const clientSecret = decoded.slice(colonIdx + 1)

    if (!clientId) {
      return { error: 'invalid_client', error_description: 'client_id missing in Basic auth', status: 401 }
    }

    // Look up client and verify secret
    const { data: clientRow, error: fetchError } = await supabase
      .from('oauth_clients')
      .select('client_id, token_endpoint_auth_method, client_secret')
      .eq('client_id', clientId)
      .single()

    if (fetchError || !clientRow) {
      return { error: 'invalid_client', error_description: 'Client not found', status: 401 }
    }

    if (clientRow.token_endpoint_auth_method === 'client_secret_basic') {
      if (!clientSecret) {
        return { error: 'invalid_client', error_description: 'client_secret required', status: 401 }
      }
      const secretHash = crypto.createHash('sha256').update(clientSecret).digest('hex')
      if (secretHash !== clientRow.client_secret) {
        return { error: 'invalid_client', error_description: 'Invalid client_secret', status: 401 }
      }
    }

    return { clientId }
  }

  // Fallback: body client_id (public client)
  const bodyClientId = (request.body as TokenRequestBody)?.client_id
  if (bodyClientId) {
    return { clientId: bodyClientId }
  }

  return { error: 'invalid_client', error_description: 'client_id is required', status: 400 }
}

export const oauthTokenRoute: FastifyPluginAsync = async (app) => {
  // @fastify/formbody は index.ts でグローバルに登録済みのため、ここでは登録しない

  app.post<{ Body: TokenRequestBody }>('/oauth/token', async (request, reply) => {
    const { grant_type, code, redirect_uri, code_verifier, refresh_token } = request.body ?? {}

    if (!grant_type) {
      return reply.code(400).send({ error: 'unsupported_grant_type', error_description: 'grant_type is required' })
    }

    // Authenticate client (supports both Basic header and body client_id)
    const authResult = await authenticateClient(request)
    if ('error' in authResult) {
      return reply.code(authResult.status).send({ error: authResult.error, error_description: authResult.error_description })
    }
    const client_id = authResult.clientId

    // ── authorization_code ──────────────────────────────────────────────────
    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri || !code_verifier) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'Missing required parameters' })
      }

      // PKCE: code_verifier は 43〜128文字
      if (code_verifier.length < 43 || code_verifier.length > 128) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'code_verifier must be 43-128 characters' })
      }

      // 1. 認可コードを検索
      const { data: authCode, error: fetchError } = await supabase
        .from('oauth_authorization_codes')
        .select('id, client_id, redirect_uri, code_challenge, expires_at, used, user_id, being_id, scope')
        .eq('code', code)
        .single()

      // 2. 存在しない
      if (fetchError || !authCode) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Authorization code not found' })
      }

      // 3. 期限切れ
      if (new Date(authCode.expires_at) < new Date()) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Authorization code has expired' })
      }

      // 4. 使い捨て済み
      if (authCode.used) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Authorization code has already been used' })
      }

      // 5. client_id 不一致
      if (authCode.client_id !== client_id) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'client_id mismatch' })
      }

      // 6. redirect_uri 不一致
      if (authCode.redirect_uri !== redirect_uri) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
      }

      // 7. PKCE検証
      if (!verifyPkce(code_verifier, authCode.code_challenge)) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
      }

      // 8. code を used=true に更新（失敗時はトークン発行を中断）
      const { error: usedUpdateError } = await supabase
        .from('oauth_authorization_codes')
        .update({ used: true })
        .eq('id', authCode.id)

      if (usedUpdateError) {
        return reply.code(500).send({ error: 'server_error', error_description: 'Failed to invalidate authorization code' })
      }

      const now = new Date()
      const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000)       // +1時間
      const refreshTokenExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // +30日

      const scope = authCode.scope ?? 'being:full'

      // 9 & 11. access token 生成 + INSERT（ハッシュ保存、クライアントには生トークンを返す）
      const accessToken = generateAccessToken()
      const accessTokenHash = crypto.createHash('sha256').update(accessToken).digest('hex')

      const { data: insertedToken, error: atError } = await supabase
        .from('oauth_access_tokens')
        .insert({
          token: accessTokenHash,
          client_id,
          user_id: authCode.user_id,
          being_id: authCode.being_id,
          scope,
          expires_at: accessTokenExpiry.toISOString(),
          revoked: false,
        })
        .select('id')
        .single()

      if (atError || !insertedToken) {
        return reply.code(500).send({ error: 'server_error', error_description: 'Failed to create access token' })
      }

      // 10 & 12. refresh token 生成 + INSERT（ハッシュ保存、access_token_id FK）
      const refreshTokenValue = generateRefreshToken()
      const refreshTokenHash = crypto.createHash('sha256').update(refreshTokenValue).digest('hex')

      const { error: rtError } = await supabase
        .from('oauth_refresh_tokens')
        .insert({
          token: refreshTokenHash,
          client_id,
          user_id: authCode.user_id,
          being_id: authCode.being_id,
          access_token_id: insertedToken.id,
          scope,
          expires_at: refreshTokenExpiry.toISOString(),
          revoked: false,
        })

      if (rtError) {
        return reply.code(500).send({ error: 'server_error', error_description: 'Failed to create refresh token' })
      }

      // 13. レスポンス
      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshTokenValue,
        scope,
      })
    }

    // ── refresh_token ────────────────────────────────────────────────────────
    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'Missing required parameters' })
      }

      // リフレッシュトークンを検索（ハッシュで照合）
      const refreshTokenHashLookup = crypto.createHash('sha256').update(refresh_token).digest('hex')
      const { data: rtRow, error: rtFetchError } = await supabase
        .from('oauth_refresh_tokens')
        .select('id, client_id, user_id, being_id, scope, access_token_id, expires_at, revoked')
        .eq('token', refreshTokenHashLookup)
        .single()

      // リプレイ攻撃対策: revoked=true なのにリクエスト → 該当クライアントの全トークン無効化
      if (rtRow && rtRow.revoked) {
        await supabase
          .from('oauth_access_tokens')
          .update({ revoked: true })
          .eq('user_id', rtRow.user_id)
          .eq('client_id', rtRow.client_id)

        await supabase
          .from('oauth_refresh_tokens')
          .update({ revoked: true })
          .eq('user_id', rtRow.user_id)
          .eq('client_id', rtRow.client_id)

        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Refresh token reuse detected. All tokens revoked.' })
      }

      // 存在しない
      if (rtFetchError || !rtRow) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Refresh token not found' })
      }

      // 期限切れ
      if (new Date(rtRow.expires_at) < new Date()) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Refresh token has expired' })
      }

      // client_id 不一致
      if (rtRow.client_id !== client_id) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'client_id mismatch' })
      }

      // 旧 refresh_token + access_token を revoked=true に更新
      await supabase
        .from('oauth_refresh_tokens')
        .update({ revoked: true })
        .eq('id', rtRow.id)

      await supabase
        .from('oauth_access_tokens')
        .update({ revoked: true })
        .eq('id', rtRow.access_token_id)

      // 新しい access token + refresh token ペアを生成
      const now = new Date()
      const accessTokenExpiry = new Date(now.getTime() + 60 * 60 * 1000)
      const refreshTokenExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

      const scope = rtRow.scope ?? 'being:full'
      const newAccessToken = generateAccessToken()
      const newAccessTokenHash = crypto.createHash('sha256').update(newAccessToken).digest('hex')
      const newRefreshToken = generateRefreshToken()
      const newRefreshTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex')

      const { data: newAtRow, error: newAtError } = await supabase
        .from('oauth_access_tokens')
        .insert({
          token: newAccessTokenHash,
          client_id,
          user_id: rtRow.user_id,
          being_id: rtRow.being_id,
          scope,
          expires_at: accessTokenExpiry.toISOString(),
          revoked: false,
        })
        .select('id')
        .single()

      if (newAtError || !newAtRow) {
        return reply.code(500).send({ error: 'server_error', error_description: 'Failed to create access token' })
      }

      const { error: newRtError } = await supabase
        .from('oauth_refresh_tokens')
        .insert({
          token: newRefreshTokenHash,
          client_id,
          user_id: rtRow.user_id,
          being_id: rtRow.being_id,
          access_token_id: newAtRow.id,
          scope,
          expires_at: refreshTokenExpiry.toISOString(),
          revoked: false,
        })

      if (newRtError) {
        return reply.code(500).send({ error: 'server_error', error_description: 'Failed to create refresh token' })
      }

      return reply.send({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: newRefreshToken,
        scope,
      })
    }

    return reply.code(400).send({ error: 'unsupported_grant_type', error_description: `grant_type "${grant_type}" is not supported` })
  })
}
