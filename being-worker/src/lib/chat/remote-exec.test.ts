/**
 * remote-exec.test.ts — remote_exec ハンドラのユニットテスト
 *
 * テスト対象:
 *   - normalizeEndpoint
 *   - loadRemoteHosts (partner_tools パース、キャッシュ)
 *   - handleRemoteExec (mock fetch で 200/401/403/408/network error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  handleRemoteExec,
  loadRemoteHosts,
  normalizeEndpoint,
  _clearRemoteHostsCache,
  type RemoteHostEntry,
} from './remote-exec.js'
import type { MemoryStore, PartnerTool } from '../memory/types.js'

// 各テスト前にキャッシュをクリアして他テストの影響を受けないようにする
beforeEach(() => {
  _clearRemoteHostsCache()
})

// ──────────────────────────────────────────────
// MemoryStore モック
// ──────────────────────────────────────────────

function makeStore(remoteHostsJson: string | null): MemoryStore {
  const tools: PartnerTool[] =
    remoteHostsJson === null
      ? []
      : [
          {
            id: 'pt1',
            user_id: 'u1',
            partner_type: 'shared',
            title: 'remote_hosts',
            description: remoteHostsJson,
            is_encrypted: true,
            encrypted_description: null,
            created_at: '2026-04-28T00:00:00Z',
            updated_at: '2026-04-28T00:00:00Z',
          },
        ]
  // 必要なメソッドだけ実装。他は throw でいい（テスト中に呼ばれないことを保証）。
  return {
    getPartnerTools: async () => tools,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const VALID_HOSTS: RemoteHostEntry[] = [
  {
    host_id: 'my-vps',
    label: 'My VPS',
    endpoint: 'https://vps.example.com',
    token: 'secret-token-123',
    default_timeout_ms: 10_000,
  },
]

// ──────────────────────────────────────────────
// normalizeEndpoint
// ──────────────────────────────────────────────

describe('normalizeEndpoint', () => {
  it('https URL をそのまま返す', () => {
    expect(normalizeEndpoint('https://vps.example.com')).toBe('https://vps.example.com')
  })

  it('trailing slash を 1 つ落とす', () => {
    expect(normalizeEndpoint('https://vps.example.com/')).toBe('https://vps.example.com')
  })

  it('http:// は拒否', () => {
    expect(normalizeEndpoint('http://vps.example.com')).toBeNull()
  })

  it('スキーム無しは拒否', () => {
    expect(normalizeEndpoint('vps.example.com')).toBeNull()
  })
})

// ──────────────────────────────────────────────
// loadRemoteHosts
// ──────────────────────────────────────────────

describe('loadRemoteHosts', () => {
  it('partner_tools.remote_hosts が無ければ空配列', async () => {
    const store = makeStore(null)
    const result = await loadRemoteHosts(store)
    expect(result).toEqual({ hosts: [] })
  })

  it('正しい JSON 配列をパース', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const result = await loadRemoteHosts(store)
    expect('hosts' in result && result.hosts).toHaveLength(1)
    if ('hosts' in result) {
      expect(result.hosts[0].host_id).toBe('my-vps')
      expect(result.hosts[0].endpoint).toBe('https://vps.example.com')
    }
  })

  it('不正な JSON は invalid_request', async () => {
    const store = makeStore('{ this is not json')
    const result = await loadRemoteHosts(store)
    expect('error' in result && result.error).toBe('invalid_request')
  })

  it('配列でない JSON は invalid_request', async () => {
    const store = makeStore(JSON.stringify({ host_id: 'x' }))
    const result = await loadRemoteHosts(store)
    expect('error' in result && result.error).toBe('invalid_request')
  })

  it('host_id が無いエントリは invalid_request', async () => {
    const store = makeStore(
      JSON.stringify([{ endpoint: 'https://x.example.com', token: 't' }])
    )
    const result = await loadRemoteHosts(store)
    expect('error' in result && result.error).toBe('invalid_request')
  })

  it('endpoint が無いエントリは invalid_request', async () => {
    const store = makeStore(
      JSON.stringify([{ host_id: 'x', token: 't' }])
    )
    const result = await loadRemoteHosts(store)
    expect('error' in result && result.error).toBe('invalid_request')
  })

  it('token が無いエントリは invalid_request', async () => {
    const store = makeStore(
      JSON.stringify([{ host_id: 'x', endpoint: 'https://x.example.com' }])
    )
    const result = await loadRemoteHosts(store)
    expect('error' in result && result.error).toBe('invalid_request')
  })

  // ── キャッシュ ──
  it('cacheKey 渡しなら 2 回目は DB を叩かずキャッシュから返す', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const spy = vi.spyOn(store, 'getPartnerTools')
    const cacheKey = 'being-cache-1'
    const r1 = await loadRemoteHosts(store, cacheKey)
    const r2 = await loadRemoteHosts(store, cacheKey)
    expect('hosts' in r1 && r1.hosts).toHaveLength(1)
    expect('hosts' in r2 && r2.hosts).toHaveLength(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('cacheKey が無ければキャッシュしない', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const spy = vi.spyOn(store, 'getPartnerTools')
    await loadRemoteHosts(store)
    await loadRemoteHosts(store)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('別の cacheKey は別エントリとしてキャッシュ', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const spy = vi.spyOn(store, 'getPartnerTools')
    await loadRemoteHosts(store, 'being-A')
    await loadRemoteHosts(store, 'being-B')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('「未設定」もキャッシュ対象', async () => {
    const store = makeStore(null)
    const spy = vi.spyOn(store, 'getPartnerTools')
    const r1 = await loadRemoteHosts(store, 'being-empty')
    const r2 = await loadRemoteHosts(store, 'being-empty')
    expect('hosts' in r1 && r1.hosts).toHaveLength(0)
    expect('hosts' in r2 && r2.hosts).toHaveLength(0)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('JSON 不正エラーはキャッシュしない（修正されたら次回反映される）', async () => {
    const cacheKey = 'being-broken'
    const brokenStore = makeStore('{ broken')
    const brokenSpy = vi.spyOn(brokenStore, 'getPartnerTools')
    const e1 = await loadRemoteHosts(brokenStore, cacheKey)
    expect('error' in e1 && e1.error).toBe('invalid_request')

    // 修正されたストアで同じキャッシュキーで呼ぶ
    const fixedStore = makeStore(JSON.stringify(VALID_HOSTS))
    const fixedSpy = vi.spyOn(fixedStore, 'getPartnerTools')
    const r2 = await loadRemoteHosts(fixedStore, cacheKey)
    expect('hosts' in r2 && r2.hosts).toHaveLength(1)
    expect(brokenSpy).toHaveBeenCalledTimes(1)
    expect(fixedSpy).toHaveBeenCalledTimes(1) // エラーをキャッシュしてないので新ストアにも問い合わせが行く
  })

  it('TTL 経過でキャッシュが期限切れになり再ロードする', async () => {
    vi.useFakeTimers()
    try {
      const store = makeStore(JSON.stringify(VALID_HOSTS))
      const spy = vi.spyOn(store, 'getPartnerTools')
      const cacheKey = 'being-ttl'
      await loadRemoteHosts(store, cacheKey)
      // 30s + 1ms 経過
      vi.advanceTimersByTime(30_001)
      await loadRemoteHosts(store, cacheKey)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ──────────────────────────────────────────────
// handleRemoteExec
// ──────────────────────────────────────────────

describe('handleRemoteExec', () => {
  it('成功時はホストの応答を host 付きで返す', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          exit_code: 0,
          stdout: 'ok',
          stderr: '',
          duration_ms: 42,
          truncated: false,
        }),
        { status: 200 }
      )
    )
    const result = await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'echo ok' },
      fetchMock as unknown as typeof fetch
    )
    expect(result.host).toBe('my-vps')
    expect('exit_code' in result && result.exit_code).toBe(0)
    expect('stdout' in result && result.stdout).toBe('ok')
  })

  it('Authorization: Bearer ヘッダーが送られる', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    let capturedAuth: string | null = null
    const fetchMock = vi.fn(async (_url: string, opts: RequestInit) => {
      const headers = opts.headers as Record<string, string>
      capturedAuth = headers.Authorization
      return new Response(
        JSON.stringify({
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 1,
          truncated: false,
        }),
        { status: 200 }
      )
    })
    await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'ls' },
      fetchMock as unknown as typeof fetch
    )
    expect(capturedAuth).toBe('Bearer secret-token-123')
  })

  it('endpoint に /exec が付く', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    let capturedUrl: string | null = null
    const fetchMock = vi.fn(async (url: string) => {
      capturedUrl = url
      return new Response(
        JSON.stringify({
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 1,
          truncated: false,
        }),
        { status: 200 }
      )
    })
    await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'ls' },
      fetchMock as unknown as typeof fetch
    )
    expect(capturedUrl).toBe('https://vps.example.com/exec')
  })

  it('401 は spec 09 形式のエラーを返す（host 付き）', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'unauthorized', message: 'bad token' }),
        { status: 401 }
      )
    )
    const result = await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'ls' },
      fetchMock as unknown as typeof fetch
    )
    expect(result.host).toBe('my-vps')
    expect('error' in result && result.error).toBe('unauthorized')
  })

  it('403 は forbidden を返す', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'forbidden', message: 'not on allowlist' }),
        { status: 403 }
      )
    )
    const result = await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'rm -rf /' },
      fetchMock as unknown as typeof fetch
    )
    expect('error' in result && result.error).toBe('forbidden')
  })

  it('408 は timeout を返す', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'timeout' }), { status: 408 })
    )
    const result = await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'sleep 100' },
      fetchMock as unknown as typeof fetch
    )
    expect('error' in result && result.error).toBe('timeout')
  })

  it('host_id が remote_hosts に無ければ invalid_request', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn()
    const result = await handleRemoteExec(
      store,
      { host: 'unknown-host', command: 'ls' },
      fetchMock as unknown as typeof fetch
    )
    expect('error' in result && result.error).toBe('invalid_request')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('http:// な endpoint は invalid_request', async () => {
    const store = makeStore(
      JSON.stringify([
        { host_id: 'plain', endpoint: 'http://x.example.com', token: 't' },
      ])
    )
    const fetchMock = vi.fn()
    const result = await handleRemoteExec(
      store,
      { host: 'plain', command: 'ls' },
      fetchMock as unknown as typeof fetch
    )
    expect('error' in result && result.error).toBe('invalid_request')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('command が空なら invalid_request', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn()
    const result = await handleRemoteExec(
      store,
      { host: 'my-vps', command: '' },
      fetchMock as unknown as typeof fetch
    )
    expect('error' in result && result.error).toBe('invalid_request')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ネットワークエラーは internal_error', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network failure')
    })
    const result = await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'ls' },
      fetchMock as unknown as typeof fetch
    )
    expect('error' in result && result.error).toBe('internal_error')
  })

  it('AbortError は timeout を返す', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn(async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    const result = await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'ls' },
      fetchMock as unknown as typeof fetch
    )
    expect('error' in result && result.error).toBe('timeout')
  })

  it('レスポンスのトークン値はメッセージに含まれない', async () => {
    const store = makeStore(JSON.stringify(VALID_HOSTS))
    const fetchMock = vi.fn(async () => {
      throw new TypeError('boom')
    })
    const result = await handleRemoteExec(
      store,
      { host: 'my-vps', command: 'ls' },
      fetchMock as unknown as typeof fetch
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret-token-123')
  })
})
