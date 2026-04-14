import type { LLMProvider, GenerateTextParams } from './types.js'

interface AnthropicResponseContent {
  type: string
  text?: string
}

interface AnthropicResponse {
  content: AnthropicResponseContent[]
}

export function createAnthropicProvider(apiKey: string): LLMProvider {
  return {
    async generateText(params: GenerateTextParams): Promise<string> {
      const { model, system, messages, maxTokens, timeoutMs } = params

      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
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
          system,
          messages,
        }),
        ...(signal ? { signal } : {}),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => 'unknown')
        throw new Error(`Anthropic API error: ${res.status} ${body}`)
      }

      const json = await res.json() as AnthropicResponse
      const text = json.content.find((c) => c.type === 'text')?.text
      if (!text) {
        throw new Error('Anthropic API error: empty response')
      }
      return text
    },
  }
}
