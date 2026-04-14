/**
 * oauth-authorize.ts — OAuth 2.1 認可エンドポイント + 同意画面 + Being選択
 *
 * GET  /oauth/authorize            — 認可リクエスト受付・同意画面表示
 * POST /oauth/authorize            — 同意フォーム送信（approve / deny）
 * POST /oauth/authorize/login      — ログイン処理
 *
 * spec-39 §11-1 / §11-4
 * #755
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { config } from '../config.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

// Supabaseプロジェクト参照をURLから取得（例: "evjrmdfcjedyjvkiiula"）
function getSupabaseProjectRef(): string {
  const match = config.supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)
  return match?.[1] ?? ''
}

function getAccessTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  const projectRef = getSupabaseProjectRef()
  const cookieName = projectRef ? `sb-${projectRef}-auth-token` : 'sb-auth-token'

  // Try project-specific cookie first, then fallback
  for (const name of [cookieName, 'sb-auth-token']) {
    const match = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))
    if (match) {
      const value = match.slice(name.length + 1)
      try {
        // Supabase stores session as JSON in cookie
        const decoded = decodeURIComponent(value)
        const parsed = JSON.parse(decoded)
        return parsed?.access_token ?? parsed ?? null
      } catch {
        return decodeURIComponent(value) || null
      }
    }
  }
  return null
}

function buildRedirectWithError(redirectUri: string, error: string, state?: string): string {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  if (state) url.searchParams.set('state', state)
  return url.toString()
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>エラー — Ruddia</title>
<style>
  body { font-family: sans-serif; background: #0f0f1a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1a2e; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; text-align: center; }
  h1 { color: #f87171; margin: 0 0 16px; font-size: 1.5rem; }
  p { color: #94a3b8; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>エラー</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

function loginPage(redirectTo: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>ログイン — Ruddia</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: sans-serif; background: #0f0f1a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1a2e; border-radius: 12px; padding: 40px; max-width: 420px; width: 100%; }
  h1 { margin: 0 0 8px; font-size: 1.5rem; color: #e2e8f0; }
  p { margin: 0 0 24px; color: #94a3b8; font-size: 0.9rem; }
  label { display: block; margin-bottom: 4px; font-size: 0.85rem; color: #94a3b8; }
  input { width: 100%; padding: 10px 14px; background: #0f0f1a; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 0.95rem; margin-bottom: 16px; }
  input:focus { outline: none; border-color: #7c3aed; }
  button { width: 100%; padding: 12px; background: #7c3aed; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #6d28d9; }
  .error { background: #450a0a; border: 1px solid #f87171; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; color: #f87171; font-size: 0.9rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Ruddia にログイン</h1>
    <p>アクセスを許可するにはログインが必要です。</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/oauth/authorize/login">
      <input type="hidden" name="redirect_to" value="${escapeHtml(redirectTo)}">
      <label for="email">メールアドレス</label>
      <input type="email" id="email" name="email" required autocomplete="email">
      <label for="password">パスワード</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">ログイン</button>
    </form>
  </div>
</body>
</html>`
}

function beingSelectPage(params: {
  beings: Array<{ id: string; name: string }>
  clientName: string
  clientId: string
  redirectUri: string
  scope: string
  codeChallenge: string
  codeChallengeMethod: string
  responseType: string
  state?: string
  resource?: string
}): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`

  const beingButtons = params.beings.map((b) => `
    <button type="submit" name="being_id" value="${escapeHtml(b.id)}" class="being-btn">
      <span class="being-name">${escapeHtml(b.name)}</span>
      <span class="being-id">${escapeHtml(b.id.slice(0, 8))}…</span>
    </button>`).join('\n')

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>Being を選択 — Ruddia</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: sans-serif; background: #0f0f1a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1a2e; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; }
  h1 { margin: 0 0 8px; font-size: 1.4rem; color: #e2e8f0; }
  .app-name { color: #7c3aed; font-weight: 700; }
  .desc { margin: 0 0 24px; color: #94a3b8; font-size: 0.9rem; }
  .being-list { display: flex; flex-direction: column; gap: 12px; }
  .being-btn { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 14px 18px; background: #0f0f1a; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 1rem; cursor: pointer; transition: border-color 0.15s; }
  .being-btn:hover { border-color: #7c3aed; background: #1e1e3a; }
  .being-name { font-weight: 600; }
  .being-id { color: #64748b; font-size: 0.8rem; font-family: monospace; }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="app-name">${escapeHtml(params.clientName)}</span> が<br>接続する Being を選択</h1>
    <p class="desc">アクセスを許可する Being を選んでください。</p>
    <form method="GET" action="/oauth/authorize" class="being-list">
      ${hidden('response_type', params.responseType)}
      ${hidden('client_id', params.clientId)}
      ${hidden('redirect_uri', params.redirectUri)}
      ${hidden('scope', params.scope)}
      ${hidden('code_challenge', params.codeChallenge)}
      ${hidden('code_challenge_method', params.codeChallengeMethod)}
      ${params.state ? hidden('state', params.state) : ''}
      ${params.resource ? hidden('resource', params.resource) : ''}
      ${beingButtons}
    </form>
  </div>
</body>
</html>`
}

function consentPage(params: {
  clientName: string
  beingName: string
  clientId: string
  redirectUri: string
  scope: string
  codeChallenge: string
  codeChallengeMethod: string
  responseType: string
  beingId: string
  state?: string
  resource?: string
}): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>アクセス許可 — Ruddia</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: sans-serif; background: #0f0f1a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1a2e; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; }
  h1 { margin: 0 0 8px; font-size: 1.4rem; color: #e2e8f0; }
  .app-name { color: #7c3aed; font-weight: 700; }
  .being-name { color: #a78bfa; font-weight: 600; }
  .scope-box { background: #0f0f1a; border-radius: 8px; padding: 16px; margin: 20px 0; }
  .scope-box p { margin: 0; color: #94a3b8; font-size: 0.9rem; }
  .scope-box .scope-label { color: #e2e8f0; font-weight: 600; margin-bottom: 4px; }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  .btn-approve { flex: 1; padding: 12px; background: #7c3aed; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  .btn-approve:hover { background: #6d28d9; }
  .btn-deny { flex: 1; padding: 12px; background: transparent; color: #94a3b8; border: 1px solid #334155; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  .btn-deny:hover { background: #1e293b; }
  .meta { margin: 0 0 20px; color: #64748b; font-size: 0.85rem; }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="app-name">${escapeHtml(params.clientName)}</span> が<br>アクセスを要求しています</h1>
    <p class="meta">Being: <span class="being-name">${escapeHtml(params.beingName)}</span></p>
    <div class="scope-box">
      <p class="scope-label">要求されるアクセス権限</p>
      <p>being:full — Beingへのフルアクセス</p>
    </div>
    <form method="POST" action="/oauth/authorize">
      ${hidden('response_type', params.responseType)}
      ${hidden('client_id', params.clientId)}
      ${hidden('redirect_uri', params.redirectUri)}
      ${hidden('scope', params.scope)}
      ${hidden('code_challenge', params.codeChallenge)}
      ${hidden('code_challenge_method', params.codeChallengeMethod)}
      ${hidden('being_id', params.beingId)}
      ${params.state ? hidden('state', params.state) : ''}
      ${params.resource ? hidden('resource', params.resource) : ''}
      <div class="actions">
        <button type="submit" name="action" value="deny" class="btn-deny">拒否</button>
        <button type="submit" name="action" value="approve" class="btn-approve">許可</button>
      </div>
    </form>
  </div>
</body>
</html>`
}

export const oauthAuthorizeRoute: FastifyPluginAsync = async (app) => {
  // application/x-www-form-urlencoded のパース（同意フォーム・ログインフォーム）

  // ── GET /oauth/authorize ────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>('/oauth/authorize', async (request, reply) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      scope,
      code_challenge,
      code_challenge_method,
      state,
      resource,
      being_id: being_id_param,
    } = request.query

    // being_id: クエリパラメータ優先、なければ resource URL のパスから抽出
    let being_id = being_id_param
    if (!being_id && resource) {
      const match = resource.match(/\/mcp\/([0-9a-f-]{36})/)
      if (match) being_id = match[1]
    }

    // ステップ1: 必須パラメータチェック（being_id はログイン後に自動解決するため任意）
    if (!client_id || !redirect_uri || !response_type || !scope || !code_challenge || !code_challenge_method) {
      return reply.code(400).type('text/html').send(errorPage('必須パラメータが不足しています。'))
    }

    // クライアント検証
    const { data: client } = await supabase
      .from('oauth_clients')
      .select('client_id, client_name, redirect_uris, is_active')
      .eq('client_id', client_id)
      .single()

    if (!client || !client.is_active) {
      console.error(JSON.stringify({ event: 'oauth_client_not_found', client_id, client_result: client }))
      return reply.code(400).type('text/html').send(errorPage('クライアントIDが無効です。'))
    }

    // redirect_uri 検証（一致しない場合はリダイレクトしない）
    if (!(client.redirect_uris as string[]).includes(redirect_uri)) {
      return reply.code(400).type('text/html').send(errorPage('redirect_uri が登録されていません。'))
    }

    // response_type 検証
    if (response_type !== 'code') {
      return reply.redirect(buildRedirectWithError(redirect_uri, 'unsupported_response_type', state))
    }

    // scope 検証
    if (!scope.split(' ').includes('being:full')) {
      return reply.redirect(buildRedirectWithError(redirect_uri, 'invalid_scope', state))
    }

    // code_challenge_method 検証
    if (code_challenge_method !== 'S256') {
      return reply.redirect(buildRedirectWithError(redirect_uri, 'invalid_request', state))
    }

    // ステップ2: ユーザー認証確認
    const accessToken = getAccessTokenFromCookie(request.headers.cookie)
    if (!accessToken) {
      return reply.type('text/html').send(loginPage(request.url))
    }

    const { data: { user } } = await supabase.auth.getUser(accessToken)
    if (!user) {
      return reply.type('text/html').send(loginPage(request.url))
    }

    // ステップ3: being_id 解決
    if (being_id) {
      // being_id が指定されている場合: 所有者検証
      const { data: being } = await supabase
        .from('beings')
        .select('id, name')
        .eq('id', being_id)
        .eq('owner_id', user.id)
        .single()

      if (!being) {
        return reply.redirect(buildRedirectWithError(redirect_uri, 'access_denied', state))
      }

      // ステップ4: 同意画面表示
      return reply.type('text/html').send(consentPage({
        clientName: client.client_name,
        beingName: being.name,
        clientId: client_id,
        redirectUri: redirect_uri,
        scope,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        responseType: response_type,
        beingId: being_id,
        state,
        resource,
      }))
    }

    // being_id がない場合（Cowork等）: ユーザーのBeing一覧で解決
    const { data: beings } = await supabase
      .from('beings')
      .select('id, name')
      .eq('owner_id', user.id)

    if (!beings || beings.length === 0) {
      return reply.redirect(buildRedirectWithError(redirect_uri, 'access_denied', state))
    }

    if (beings.length === 1) {
      // Being が1つなら自動選択 → 同意画面へ
      return reply.type('text/html').send(consentPage({
        clientName: client.client_name,
        beingName: beings[0].name,
        clientId: client_id,
        redirectUri: redirect_uri,
        scope,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        responseType: response_type,
        beingId: beings[0].id,
        state,
        resource,
      }))
    }

    // 複数Beingの場合: 選択画面を表示
    return reply.type('text/html').send(beingSelectPage({
      beings,
      clientName: client.client_name,
      clientId: client_id,
      redirectUri: redirect_uri,
      scope,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      responseType: response_type,
      state,
      resource,
    }))
  })

  // ── POST /oauth/authorize（同意フォーム送信）───────────────────────────────
  app.post<{ Body: Record<string, string> }>('/oauth/authorize', async (request, reply) => {
    const {
      action,
      response_type,
      client_id,
      redirect_uri,
      scope,
      code_challenge,
      code_challenge_method,
      state,
      resource,
      being_id,
    } = request.body ?? {}

    // 基本バリデーション
    if (!redirect_uri || !client_id) {
      return reply.code(400).type('text/html').send(errorPage('無効なリクエストです。'))
    }

    // deny
    if (action === 'deny') {
      return reply.redirect(buildRedirectWithError(redirect_uri, 'access_denied', state))
    }

    if (action !== 'approve') {
      return reply.code(400).type('text/html').send(errorPage('無効なアクションです。'))
    }

    // approve: ユーザー認証再確認
    const accessToken = getAccessTokenFromCookie(request.headers.cookie)
    if (!accessToken) {
      return reply.redirect(buildRedirectWithError(redirect_uri, 'access_denied', state))
    }

    const { data: { user } } = await supabase.auth.getUser(accessToken)
    if (!user) {
      return reply.redirect(buildRedirectWithError(redirect_uri, 'access_denied', state))
    }

    // redirect_uri をDBで再検証（hidden field は改ざん可能なため必須）
    const { data: clientCheck } = await supabase
      .from('oauth_clients')
      .select('redirect_uris, is_active')
      .eq('client_id', client_id)
      .single()

    if (!clientCheck || !clientCheck.is_active || !(clientCheck.redirect_uris as string[]).includes(redirect_uri)) {
      return reply.code(400).type('text/html').send(errorPage('redirect_uri が無効です。'))
    }

    // being_id の所有者再検証（hidden field は改ざん可能なため必須）
    const { data: beingCheck } = await supabase
      .from('beings')
      .select('id')
      .eq('id', being_id)
      .eq('owner_id', user.id)
      .single()

    if (!beingCheck) {
      return reply.redirect(buildRedirectWithError(redirect_uri, 'access_denied', state))
    }

    // 認可コード生成
    const code = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const insertData: Record<string, unknown> = {
      code,
      client_id,
      user_id: user.id,
      being_id,
      redirect_uri,
      scope,
      code_challenge,
      code_challenge_method,
      used: false,
      expires_at: expiresAt,
    }
    if (resource) insertData.resource = resource

    const { error } = await supabase.from('oauth_authorization_codes').insert(insertData)
    if (error) {
      return reply.code(500).type('text/html').send(errorPage('認可コードの生成に失敗しました。'))
    }

    // redirect_uri?code=xxx&state=xxx
    const url = new URL(redirect_uri)
    url.searchParams.set('code', code)
    if (state) url.searchParams.set('state', state)
    return reply.redirect(url.toString())
  })

  // ── POST /oauth/authorize/login ─────────────────────────────────────────────
  app.post<{ Body: Record<string, string> }>('/oauth/authorize/login', async (request, reply) => {
    const { email, password, redirect_to } = request.body ?? {}

    if (!email || !password) {
      return reply.type('text/html').send(loginPage(redirect_to ?? '/', 'メールアドレスとパスワードを入力してください。'))
    }

    // ログイン専用クライアント（モジュールスコープのsupabaseのauth stateを汚さないため分離）
    const authClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
    const { data, error } = await authClient.auth.signInWithPassword({ email, password })

    if (error || !data.session) {
      return reply.type('text/html').send(loginPage(redirect_to ?? '/', 'メールアドレスまたはパスワードが正しくありません。'))
    }

    // Cookieにセッションをセット（JSON形式で保存 — getAccessTokenFromCookieのパース形式と統一）
    const sessionJson = JSON.stringify({ access_token: data.session.access_token })
    reply.header('Set-Cookie', [
      `sb-auth-token=${encodeURIComponent(sessionJson)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`,
    ])

    return reply.redirect(redirect_to ?? '/')
  })
}
