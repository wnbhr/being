/**
 * delegate.test.ts — runDelegate / resolveDelegateModel / isValidComplexity のテスト
 *
 * #964
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { runDelegate } from './delegate.js'
import {
  resolveDelegateModel,
  isValidComplexity,
  DELEGATE_DEFAULTS,
  DELEGATE_MAX_TOKENS_LIMIT,
} from '../llm/delegate-models.js'

describe('resolveDelegateModel', () => {
  afterEach(() => {
    delete process.env.DELEGATE_MODEL_LIGHT
    delete process.env.DELEGATE_MODEL_MEDIUM
    delete process.env.DELEGATE_MODEL_HEAVY
  })

  it('light は Haiku を返す', () => {
    expect(resolveDelegateModel('light')).toBe(DELEGATE_DEFAULTS.light)
    expect(DELEGATE_DEFAULTS.light).toContain('haiku')
  })

  it('medium は Sonnet を返す', () => {
    expect(resolveDelegateModel('medium')).toBe(DELEGATE_DEFAULTS.medium)
    expect(DELEGATE_DEFAULTS.medium).toContain('sonnet')
  })

  it('heavy は Opus を返す', () => {
    expect(resolveDelegateModel('heavy')).toBe(DELEGATE_DEFAULTS.heavy)
    expect(DELEGATE_DEFAULTS.heavy).toContain('opus')
  })

  it('env 上書きが効く（呼び出し時に読み直す）', () => {
    expect(resolveDelegateModel('light')).toBe(DELEGATE_DEFAULTS.light)
    process.env.DELEGATE_MODEL_LIGHT = 'custom-haiku'
    expect(resolveDelegateModel('light')).toBe('custom-haiku')
    delete process.env.DELEGATE_MODEL_LIGHT
    expect(resolveDelegateModel('light')).toBe(DELEGATE_DEFAULTS.light)
  })

  it('env が空白のみの場合はデフォルトにフォールバック', () => {
    process.env.DELEGATE_MODEL_MEDIUM = '   '
    expect(resolveDelegateModel('medium')).toBe(DELEGATE_DEFAULTS.medium)
  })
})

describe('isValidComplexity', () => {
  it('light / medium / heavy は true', () => {
    expect(isValidComplexity('light')).toBe(true)
    expect(isValidComplexity('medium')).toBe(true)
    expect(isValidComplexity('heavy')).toBe(true)
  })

  it('それ以外は false', () => {
    expect(isValidComplexity('low')).toBe(false)
    expect(isValidComplexity('')).toBe(false)
    expect(isValidComplexity(undefined)).toBe(false)
    expect(isValidComplexity(null)).toBe(false)
    expect(isValidComplexity(123)).toBe(false)
    expect(isValidComplexity({})).toBe(false)
  })
})

describe('DELEGATE_MAX_TOKENS_LIMIT', () => {
  it('heavy は light/medium より大きい上限を持つ', () => {
    expect(DELEGATE_MAX_TOKENS_LIMIT.heavy).toBeGreaterThan(DELEGATE_MAX_TOKENS_LIMIT.light)
    expect(DELEGATE_MAX_TOKENS_LIMIT.heavy).toBeGreaterThan(DELEGATE_MAX_TOKENS_LIMIT.medium)
  })

  it('全 complexity が正の整数', () => {
    for (const c of ['light', 'medium', 'heavy'] as const) {
      expect(DELEGATE_MAX_TOKENS_LIMIT[c]).toBeGreaterThan(0)
      expect(Number.isInteger(DELEGATE_MAX_TOKENS_LIMIT[c])).toBe(true)
    }
  })
})

describe('runDelegate', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetchOk(text: string, usage = { input_tokens: 100, output_tokens: 50 }) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
          usage,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
  }

  it('正常系: text / model / complexity / usage を返す', async () => {
    mockFetchOk('委任結果のテキスト')
    const result = await runDelegate({
      task: '東京の天気は？',
      complexity: 'light',
      apiKey: 'sk-ant-test',
    })
    expect(result.text).toBe('委任結果のテキスト')
    expect(result.complexity).toBe('light')
    expect(result.model).toBe(DELEGATE_DEFAULTS.light)
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 })
  })

  it('context があれば user メッセージに前段として含める', async () => {
    let capturedBody: unknown = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}')
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
        { status: 200 },
      )
    })

    await runDelegate({
      task: 'まとめて',
      context: '昨日の会議で...',
      complexity: 'medium',
      apiKey: 'sk-ant-test',
    })

    const body = capturedBody as { messages: Array<{ content: string }>; model: string }
    expect(body.messages[0].content).toContain('# 文脈')
    expect(body.messages[0].content).toContain('昨日の会議で...')
    expect(body.messages[0].content).toContain('# タスク')
    expect(body.messages[0].content).toContain('まとめて')
    expect(body.model).toBe(DELEGATE_DEFAULTS.medium)
  })

  it('system 上書きがあればそれを使う', async () => {
    let capturedBody: { system: string } | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}') as { system: string }
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
        { status: 200 },
      )
    })

    await runDelegate({
      task: 't',
      complexity: 'light',
      apiKey: 'sk-ant-test',
      system: 'カスタムシステム',
    })

    expect(capturedBody!.system).toBe('カスタムシステム')
  })

  it('usage が欠けていても 0 で埋める', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      )
    })

    const result = await runDelegate({
      task: 't',
      complexity: 'light',
      apiKey: 'sk-ant-test',
    })
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('Anthropic 4xx エラーは例外を投げる', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })
    })

    await expect(
      runDelegate({ task: 't', complexity: 'light', apiKey: 'sk-ant-bad' }),
    ).rejects.toThrow(/Anthropic API error: 401/)
  })

  it('レスポンスに text 型ブロックが無ければ例外を投げる', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({ content: [{ type: 'tool_use' }] }),
        { status: 200 },
      )
    })

    await expect(
      runDelegate({ task: 't', complexity: 'light', apiKey: 'sk-ant-test' }),
    ).rejects.toThrow(/empty response/)
  })

  it('complexity ごとに正しいモデルが選択される', async () => {
    const capturedModels: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as { model: string }
      capturedModels.push(body.model)
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
        { status: 200 },
      )
    })

    for (const c of ['light', 'medium', 'heavy'] as const) {
      await runDelegate({ task: 't', complexity: c, apiKey: 'sk-ant-test' })
    }
    expect(capturedModels).toEqual([
      DELEGATE_DEFAULTS.light,
      DELEGATE_DEFAULTS.medium,
      DELEGATE_DEFAULTS.heavy,
    ])
  })

  it('env で上書きしたモデルが API リクエストに反映される（再起動不要）', async () => {
    let capturedModel: string | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as { model: string }
      capturedModel = body.model
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
        { status: 200 },
      )
    })

    process.env.DELEGATE_MODEL_HEAVY = 'my-custom-opus'
    try {
      await runDelegate({ task: 't', complexity: 'heavy', apiKey: 'sk-ant-test' })
      expect(capturedModel).toBe('my-custom-opus')
    } finally {
      delete process.env.DELEGATE_MODEL_HEAVY
    }
  })
})
