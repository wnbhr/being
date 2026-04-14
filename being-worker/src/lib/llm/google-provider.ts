/**
 * google-provider.ts — Google Gemini (2.5 Pro / Flash) プロバイダ
 *
 * Google Generative Language API (v1beta) を LLMProvider interface に適合させる。
 * recall など generateText() 用途のみ（SSEストリームは route.ts で直接実装）。
 */

import type { LLMProvider, GenerateTextParams } from './types.js'

interface GeminiCandidate {
  content?: {
    parts?: Array<{ text?: string }>
  }
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
}

export function createGoogleProvider(apiKey: string): LLMProvider {
  return {
    async generateText(params: GenerateTextParams): Promise<string> {
      const { model, system, messages, maxTokens, timeoutMs } = params

      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined

      // Gemini は system_instruction を別フィールドに持つ
      // messages は { role: 'user'|'model', parts: [{ text }] } 形式
      const geminiContents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: system }],
          },
          contents: geminiContents,
          generationConfig: {
            maxOutputTokens: maxTokens,
          },
        }),
        ...(signal ? { signal } : {}),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => 'unknown')
        throw new Error(`Google API error: ${res.status} ${body}`)
      }

      const json = await res.json() as GeminiResponse
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) {
        throw new Error('Google API error: empty response')
      }
      return text
    },
  }
}
