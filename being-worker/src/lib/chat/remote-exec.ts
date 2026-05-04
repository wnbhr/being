/**
 * remote-exec.ts — remote_exec ツールハンドラ
 *
 * spec 09 (wnbhr/being docs/specs/09-being-remote-exec.md) の Being-side 実装。
 *
 * partner_tools に `title="remote_hosts"`, `is_encrypted=true` で保存された
 * JSON 配列 `[{ host_id, label?, endpoint, token, default_timeout_ms?, notes? }]`
 * から host_id でエントリを引き、対応する受信機 (e.g. being-exec) の
 * `POST <endpoint>/exec` に転送する。
 *
 * セキュリティ要件:
 * - token は復号後メモリ上のみ。ログ・エラー・レスポンスに乗せない。
 * - endpoint は HTTPS 限定。
 * - 不正 JSON / 不明 host_id はネットワーク呼び出し前に弾く。
 *
 * #929
 */

import type { MemoryStore } from '../memory/types.js'

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface RemoteExecInput {
  host: string
  command: string
  timeout_ms?: number
  stdin?: string
}

/** spec 09 の partner_tools.remote_hosts エントリ形 */
export interface RemoteHostEntry {
  host_id: string
  label?: string
  endpoint: string
  token: string
  default_timeout_ms?: number
  notes?: string
}

/** spec 09 の `/exec` 成功レスポンス */
interface ExecSuccess {
  exit_code: number
  stdout: string
  stderr: string
  duration_ms: number
  truncated: boolean
}

/** spec 09 の `/exec` エラーレスポンス */
interface ExecError {
  error: string
  message?: string
}

/** LLM に返す形（成功時は ExecSuccess + host、エラー時は ExecError + host） */
export type RemoteExecResult =
  | (ExecSuccess & { host: string })
  | (ExecError & { host: string })

// ──────────────────────────────────────────────
// remote_hosts の読み出し（インメモリキャッシュ付き）
// ──────────────────────────────────────────────

/**
 * being_id ごとの remote_hosts を短い TTL でメモリキャッシュする。
 *
 * なぜ無効化フックを入れていないか:
 *   partner_tools の更新パスは複数あり（update_memory ツール、Being dashboard、
 *   将来追加されるかもしれない管理パス）、すべてにキャッシュ破棄フックを生やすのは
 *   触る面が広すぎてバグを呼ぶ。一方で remote_hosts の更新頻度はホスト追加・削除・
 *   トークン回転程度で、月に数回行けばいい方。30 秒待ちが発生するのもユーザーが
 *   自分でトークンを回した直後だけで、自分の作業の直後なので「キャッシュ切れ待ちかな」
 *   と気づける範囲に収まる。
 *
 * テスト用に export してある（直接触らない）。
 */
const REMOTE_HOSTS_CACHE_TTL_MS = 30_000

interface CacheEntry {
  hosts: RemoteHostEntry[]
  expiresAt: number
}

export const _remoteHostsCache: Map<string, CacheEntry> = new Map()

/** テスト用: キャッシュを全クリア */
export function _clearRemoteHostsCache(): void {
  _remoteHostsCache.clear()
}

/**
 * partner_tools から remote_hosts 配列を取り出す。
 * 行が無い、空配列、JSON 不正のいずれも `null` ではなく空配列扱いにせず、
 * 「設定されていない」と「壊れている」を区別する。
 *
 * cacheKey が渡されたら being_id 単位で 30 秒キャッシュする。エラーケース
 * （JSON 不正など）はキャッシュしない —— 修正されたら次の呼び出しで反映される。
 */
export async function loadRemoteHosts(
  store: MemoryStore,
  cacheKey?: string
): Promise<{ hosts: RemoteHostEntry[] } | { error: string; message: string }> {
  // キャッシュヒットを確認
  if (cacheKey) {
    const cached = _remoteHostsCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return { hosts: cached.hosts }
    }
  }

  // partner_tools は spec 上 'shared' 固定（#788）。
  // store 側の実装が partnerType を無視するため、ここで何を渡しても結果は同じだが、
  // 慣例に合わせて 'shared' を渡す。
  const tools = await store.getPartnerTools('shared')
  const row = tools.find((t) => t.title === 'remote_hosts')
  if (!row) {
    if (cacheKey) {
      _remoteHostsCache.set(cacheKey, {
        hosts: [],
        expiresAt: Date.now() + REMOTE_HOSTS_CACHE_TTL_MS,
      })
    }
    return { hosts: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(row.description)
  } catch {
    return {
      error: 'invalid_request',
      message: 'partner_tools.remote_hosts is not valid JSON',
    }
  }

  if (!Array.isArray(parsed)) {
    return {
      error: 'invalid_request',
      message: 'partner_tools.remote_hosts must be a JSON array',
    }
  }

  const hosts: RemoteHostEntry[] = []
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object') {
      return {
        error: 'invalid_request',
        message: `remote_hosts[${i}] is not an object`,
      }
    }
    const e = entry as Record<string, unknown>
    if (typeof e.host_id !== 'string' || !e.host_id) {
      return { error: 'invalid_request', message: `remote_hosts[${i}].host_id missing or invalid` }
    }
    if (typeof e.endpoint !== 'string' || !e.endpoint) {
      return { error: 'invalid_request', message: `remote_hosts[${i}].endpoint missing or invalid` }
    }
    if (typeof e.token !== 'string' || !e.token) {
      return { error: 'invalid_request', message: `remote_hosts[${i}].token missing or invalid` }
    }
    hosts.push({
      host_id: e.host_id,
      label: typeof e.label === 'string' ? e.label : undefined,
      endpoint: e.endpoint,
      token: e.token,
      default_timeout_ms:
        typeof e.default_timeout_ms === 'number' ? e.default_timeout_ms : undefined,
      notes: typeof e.notes === 'string' ? e.notes : undefined,
    })
  }
  if (cacheKey) {
    _remoteHostsCache.set(cacheKey, {
      hosts,
      expiresAt: Date.now() + REMOTE_HOSTS_CACHE_TTL_MS,
    })
  }
  return { hosts }
}

// ──────────────────────────────────────────────
// endpoint 正規化 / 検証
// ──────────────────────────────────────────────

export function normalizeEndpoint(raw: string): string | null {
  if (!raw.startsWith('https://')) return null
  // trailing slash を 1 つだけ落とす
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

// ──────────────────────────────────────────────
// remote_exec 本体
// ──────────────────────────────────────────────

export async function handleRemoteExec(
  store: MemoryStore,
  input: RemoteExecInput,
  fetchImpl: typeof fetch = fetch,
  cacheKey?: string
): Promise<RemoteExecResult> {
  const { host, command, timeout_ms, stdin } = input

  if (!host) {
    return { host: '', error: 'invalid_request', message: 'host is required' }
  }
  if (!command) {
    return { host, error: 'invalid_request', message: 'command is required' }
  }

  // remote_hosts ロード（cacheKey 渡しでキャッシュを利用）
  const loaded = await loadRemoteHosts(store, cacheKey)
  if ('error' in loaded) {
    return { host, error: loaded.error, message: loaded.message }
  }
  const entry = loaded.hosts.find((h) => h.host_id === host)
  if (!entry) {
    return {
      host,
      error: 'invalid_request',
      message: `host_id "${host}" not found in partner_tools.remote_hosts`,
    }
  }

  const normalized = normalizeEndpoint(entry.endpoint)
  if (!normalized) {
    return {
      host,
      error: 'invalid_request',
      message: `endpoint must be HTTPS for host_id "${host}"`,
    }
  }

  // 実効 timeout: 引数 > entry.default_timeout_ms > undefined（受信機の判断）
  const effectiveTimeout = timeout_ms ?? entry.default_timeout_ms

  const body: Record<string, unknown> = { command }
  if (effectiveTimeout !== undefined) body.timeout_ms = effectiveTimeout
  if (stdin !== undefined) body.stdin = stdin

  // ローカル fetch には独自 timeout を設けて、受信機が応答しないケースに備える。
  // 受信機が応答した場合は受信機の timeout 結果（408）をそのまま返す。
  const controller = new AbortController()
  const localTimeoutMs = (effectiveTimeout ?? 30_000) + 5_000 // 5s の余裕
  const localTimer = setTimeout(() => controller.abort(), localTimeoutMs)

  let res: Response
  try {
    res = await fetchImpl(`${normalized}/exec`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${entry.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(localTimer)
    const isAbort = err instanceof Error && err.name === 'AbortError'
    return {
      host,
      error: isAbort ? 'timeout' : 'internal_error',
      message: isAbort
        ? `request to host "${host}" exceeded local timeout`
        : `failed to reach host "${host}"`,
    }
  }
  clearTimeout(localTimer)

  // ボディ読み取り
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return {
      host,
      error: 'internal_error',
      message: `host "${host}" returned non-JSON response (status ${res.status})`,
    }
  }

  if (res.ok) {
    const ok = json as ExecSuccess
    return {
      host,
      exit_code: ok.exit_code ?? 0,
      stdout: ok.stdout ?? '',
      stderr: ok.stderr ?? '',
      duration_ms: ok.duration_ms ?? 0,
      truncated: ok.truncated ?? false,
    }
  }

  // エラー: 受信機が spec 09 形式で返してくることを期待
  const errBody = json as ExecError
  return {
    host,
    error: errBody.error ?? `http_${res.status}`,
    message: errBody.message,
  }
}
