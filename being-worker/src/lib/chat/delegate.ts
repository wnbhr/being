/**
 * delegate.ts — being_delegate ツールのコアロジック（#964）
 *
 * 人格SLMが LLM（Anthropic Claude）にタスクを委任する。
 * spec-40 のアーキテクチャ図にあるとおり、接続先（OpenClaw / オンデバイス）に
 * 依存せず Being API 経由で委任できるようにする。
 *
 * 設計方針:
 * - Being API は「タスク投げる → 結果返す」のみ。respond_to_user 等の判断は SLM 側
 * - complexity（light/medium/heavy）でモデル選択
 * - usage（input_tokens/output_tokens）も返却 → #966 コストガードの準備
 *
 * 注意: 既存の anthropic-provider.generateText() は usage を返さないため、
 * ここでは Anthropic API を直接呼び出して raw response を解釈する。
 */

import {
  resolveDelegateModel,
  type DelegateComplexity,
} from '../llm/delegate-models.js'

export interface DelegateParams {
  task: string
  context?: string
  complexity: DelegateComplexity
  apiKey: string
  /** 任意。指定時は SLM 側の system prompt を委任先にも引き継げる */
  system?: string
  /** デフォルト 2048 */
  maxTokens?: number
  /** デフォルト 90秒（Opus を見越して長め） */
  timeoutMs?: number
}

export interface DelegateUsage {
  input_tokens: number
  output_tokens: number
}

export interface DelegateResult {
  text: string
  model: string
  complexity: DelegateComplexity
  usage: DelegateUsage
}

interface AnthropicContentBlock {
  type: string
  text?: string
}

interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

const DEFAULT_SYSTEM =
  'あなたはパートナーAIから委任を受けて作業を行うアシスタントです。' +
  '与えられたタスクを正確に実行し、結果を簡潔に返してください。' +
  '余計な前置きや謝辞は不要です。'

/**
 * LLM に委任タスクを送信し、結果テキストとトークン使用量を返す。
 *
 * 失敗時はエラーを throw する（呼び出し側で 502/500 にマッピング）。
 */
export async function runDelegate(params: DelegateParams): Promise<DelegateResult> {
  const {
    task,
    context,
    complexity,
    apiKey,
    system,
    maxTokens = 2048,
    timeoutMs = 90_000,
  } = params

  const model = resolveDelegateModel(complexity)

  // ユーザーメッセージを組み立てる
  // context があれば前段に置く（タスクの前提条件として読ませる）
  const userContent = context
    ? `# 文脈\n${context}\n\n# タスク\n${task}`
    : task

  const signal = AbortSignal.timeout(timeoutMs)
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: system ?? DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    }),
    signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => 'unknown')
    throw new Error(`Anthropic API error: ${res.status} ${body}`)
  }

  const json = (await res.json()) as AnthropicMessagesResponse
  const text = json.content.find((c) => c.type === 'text')?.text
  if (!text) {
    throw new Error('Anthropic API error: empty response')
  }

  return {
    text,
    model,
    complexity,
    usage: {
      input_tokens: json.usage?.input_tokens ?? 0,
      output_tokens: json.usage?.output_tokens ?? 0,
    },
  }
}
