/**
 * stream-adapters.ts — マルチプロバイダ SSEストリーミングアダプター
 *
 * OpenAI / Google の SSEストリームを Anthropic互換のイベント形式に変換する。
 * フロントエンドは Anthropic SSE形式（content_block_delta / message_stop）を期待するため、
 * 非Anthropicプロバイダはこのアダプター経由で変換する。
 *
 * ツール呼び出し検出（update_memory / recall_memory 等）に対応。
 * getToolCalls() / getStopReason() でループ継続判定を行う。
 */

export interface StreamAdapterParams {
  provider: 'openai' | 'google'
  apiKey: string
  model: string
  system: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: Array<any>
  maxTokens?: number
  tools?: unknown[]
}

/** ストリームから検出されたツール呼び出し */
export interface DetectedToolCall {
  id: string        // OpenAI: tool_call.id / Google: crypto.randomUUID()
  name: string
  arguments: string // JSON文字列（handleToolBlockのinputJsonに渡す）
}

export interface StreamAdapterResult {
  /** ReadableStream<Uint8Array> — Anthropic互換SSEイベントを流す */
  stream: ReadableStream<Uint8Array>
  /** ストリーム完了後にセットされる: 生成されたテキスト全体 */
  getText: () => string
  /** ストリーム完了後にセットされる: 検出されたツール呼び出し一覧 */
  getToolCalls: () => DetectedToolCall[]
  /** ストリーム完了後にセットされる: 停止理由 */
  getStopReason: () => 'end_turn' | 'tool_use'
}

// ──────────────────────────────────────────────
// OpenAI
// ──────────────────────────────────────────────

/**
 * OpenAI Chat Completions SSE → Anthropic互換 SSE
 */
export async function createOpenAIStream(params: StreamAdapterParams): Promise<Response> {
  const { apiKey, model, system, messages, maxTokens = 4096, tools } = params

  const openAIMessages = [
    { role: 'system', content: system },
    ...messages,
  ]

  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: openAIMessages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    }),
  })
}

export function adaptOpenAIStream(openAIRes: Response): StreamAdapterResult {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let assistantText = ''
  // tool_callsをindexで蓄積（OpenAIはdeltaで分割送信する）
  const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map()
  let stopReason: 'end_turn' | 'tool_use' = 'end_turn'

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!openAIRes.body) {
        controller.close()
        return
      }

      const reader = openAIRes.body.getReader()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const raw = line.slice(5).trim()
            if (raw === '[DONE]') {
              controller.enqueue(encoder.encode(`event: message_stop\ndata: {}\n\n`))
              continue
            }

            try {
              const parsed = JSON.parse(raw) as {
                choices?: Array<{
                  delta?: {
                    content?: string | null
                    tool_calls?: Array<{
                      index: number
                      id?: string
                      function?: { name?: string; arguments?: string }
                    }>
                  }
                  finish_reason?: string | null
                }>
              }
              const choice = parsed.choices?.[0]
              if (!choice) continue

              // テキストdelta
              const text = choice.delta?.content
              if (typeof text === 'string' && text.length > 0) {
                assistantText += text
                const deltaData = JSON.stringify({ delta: { type: 'text_delta', text } })
                controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${deltaData}\n\n`))
              }

              // tool_callsのdeltaを蓄積
              if (choice.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const existing = toolCallAccumulator.get(tc.index) ?? { id: '', name: '', arguments: '' }
                  if (tc.id) existing.id = tc.id
                  if (tc.function?.name) existing.name += tc.function.name
                  if (tc.function?.arguments) existing.arguments += tc.function.arguments
                  toolCallAccumulator.set(tc.index, existing)
                }
              }

              // finish_reason
              if (choice.finish_reason === 'tool_calls') {
                stopReason = 'tool_use'
              } else if (choice.finish_reason === 'stop') {
                stopReason = 'end_turn'
              }
            } catch { /* ignore parse errors */ }
          }
        }
      } catch (err) {
        controller.error(err)
        return
      } finally {
        reader.releaseLock()
      }

      controller.close()
    },
  })

  return {
    stream,
    getText: () => assistantText,
    getToolCalls: () => {
      const calls: DetectedToolCall[] = []
      // indexの昇順でソート
      const sorted = [...toolCallAccumulator.entries()].sort(([a], [b]) => a - b)
      for (const [, tc] of sorted) {
        if (tc.name) {
          calls.push({ id: tc.id || crypto.randomUUID(), name: tc.name, arguments: tc.arguments || '{}' })
        }
      }
      return calls
    },
    getStopReason: () => stopReason,
  }
}

// ──────────────────────────────────────────────
// Google Gemini
// ──────────────────────────────────────────────

/**
 * Google Generative Language API (streamGenerateContent) → Anthropic互換 SSE
 */
export async function createGoogleStream(params: StreamAdapterParams): Promise<Response> {
  const { apiKey, model, system, messages, maxTokens = 4096, tools } = params

  // messagesはすでにGoogle形式（{ role: 'user'|'model', parts: [...] }）で渡されることを想定
  // 文字列の場合はpartsに変換する（後方互換）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const geminiContents = messages.map((m: any) => {
    if (m.parts !== undefined) {
      // すでにGoogle形式
      return { role: m.role === 'assistant' ? 'model' : m.role, parts: m.parts }
    }
    // 後方互換: content文字列 or contentBlock[]
    const content = m.content
    let parts: unknown[]
    if (Array.isArray(content)) {
      parts = content
    } else {
      parts = [{ text: content as string }]
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts,
    }
  })

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: geminiContents,
      generationConfig: { maxOutputTokens: maxTokens },
      ...(tools && tools.length > 0 ? { tools } : {}),
    }),
  })
}

export function adaptGoogleStream(googleRes: Response): StreamAdapterResult {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let assistantText = ''
  let streamEnded = false
  const detectedToolCalls: DetectedToolCall[] = []
  let stopReason: 'end_turn' | 'tool_use' = 'end_turn'

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!googleRes.body) {
        controller.close()
        return
      }

      const reader = googleRes.body.getReader()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const raw = line.slice(5).trim()

            try {
              const parsed = JSON.parse(raw) as {
                candidates?: Array<{
                  content?: {
                    parts?: Array<{
                      text?: string
                      functionCall?: { name: string; args: Record<string, unknown> }
                    }>
                  }
                  finishReason?: string
                }>
              }
              const candidate = parsed.candidates?.[0]
              if (!candidate) continue

              const parts = candidate.content?.parts ?? []
              for (const part of parts) {
                if (typeof part.text === 'string' && part.text.length > 0) {
                  assistantText += part.text
                  const deltaData = JSON.stringify({ delta: { type: 'text_delta', text: part.text } })
                  controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${deltaData}\n\n`))
                }
                if (part.functionCall) {
                  detectedToolCalls.push({
                    id: crypto.randomUUID(),
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args ?? {}),
                  })
                }
              }

              if (candidate.finishReason) {
                if (candidate.finishReason === 'TOOL_CALL' || candidate.finishReason === 'FUNCTION_CALL') {
                  stopReason = 'tool_use'
                }
                if (!streamEnded) {
                  streamEnded = true
                  controller.enqueue(encoder.encode(`event: message_stop\ndata: {}\n\n`))
                }
              }
            } catch { /* ignore parse errors */ }
          }
        }
      } catch (err) {
        controller.error(err)
        return
      } finally {
        reader.releaseLock()
      }

      // finishReason が来なかった場合の保険
      if (!streamEnded) {
        controller.enqueue(encoder.encode(`event: message_stop\ndata: {}\n\n`))
      }

      controller.close()
    },
  })

  return {
    stream,
    getText: () => assistantText,
    getToolCalls: () => detectedToolCalls,
    getStopReason: () => stopReason,
  }
}
