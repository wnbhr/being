/**
 * api-client.ts — Being API REST クライアント
 *
 * 環境変数:
 *   BEING_API_URL    — Being Worker のベースURL（例: http://localhost:3100）
 *   BEING_API_TOKEN  — 認証トークン（brt_...）
 *   BEING_ID         — 対象 Being ID
 *   LLM_API_KEY      — LLMキー（trigger_patrol用。任意）
 */

export class BeingApiClient {
  private baseUrl: string
  private token: string
  public beingId: string
  private llmApiKey?: string

  constructor() {
    this.baseUrl = process.env.BEING_API_URL ?? 'http://localhost:3100'
    this.token = process.env.BEING_API_TOKEN ?? ''
    this.beingId = process.env.BEING_ID ?? ''
    this.llmApiKey = process.env.LLM_API_KEY
  }

  validate() {
    if (!this.token) throw new Error('BEING_API_TOKEN environment variable is required')
    if (!this.beingId) throw new Error('BEING_ID environment variable is required')
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    requireLlmKey = false
  ): Promise<unknown> {
    const url = `${this.baseUrl}/v1/beings/${this.beingId}${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    }

    if (requireLlmKey) {
      if (!this.llmApiKey) {
        throw new Error('LLM_API_KEY environment variable is required for this operation')
      }
      headers['X-LLM-API-Key'] = this.llmApiKey
    }

    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    if (!res.ok) {
      // タイムアウト付き res.text()（ボディ読み取りハング対策）
      const errText = await Promise.race([
        res.text(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000)
        ),
      ]).catch(() => `HTTP ${res.status}`)
      throw new Error(`Being API ${method} ${path} → ${res.status}: ${errText}`)
    }

    return res.json()
  }
}
