/**
 * openai-provider.ts — OpenAI (GPT-4o / GPT-4o-mini) プロバイダ
 *
 * OpenAI Chat Completions API を LLMProvider interface に適合させる。
 * recall など generateText() 用途のみ（SSEストリームは route.ts で直接実装）。
 */

import type { LLMProvider, GenerateTextParams } from './types.js'

interface OpenAIResponseChoice {
  message?: {
    content?: string | null
  }
}

interface OpenAIResponse {
  choices?: OpenAIResponseChoice[]
}

export function createOpenAIProvider(apiKey: string): LLMProvider {
  return {
    async generateText(params: GenerateTextParams): Promise<string> {
      const { model, system, messages, maxTokens, timeoutMs } = params

      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined

      // OpenAI は system を messages 配列の先頭に含める形式
      const openAIMessages = [
        { role: 'system', content: system },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ]

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: openAIMessages,
        }),
        ...(signal ? { signal } : {}),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => 'unknown')
        throw new Error(`OpenAI API error: ${res.status} ${body}`)
      }

      const json = await res.json() as OpenAIResponse
      const text = json.choices?.[0]?.message?.content
      if (!text) {
        throw new Error('OpenAI API error: empty response')
      }
      return text
    },
  }
}
