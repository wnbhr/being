/**
 * being-delegate.ts — POST /v1/beings/:being_id/delegate
 *
 * 人格SLM（または既存LLMパートナー）が重いタスクを LLM に委任する Being API エンドポイント。
 * spec-40 で定義された being_delegate ツールのサーバー実装。
 *
 * Body:
 *   - task: string — 委任するタスクの説明（必須）
 *   - context: string? — タスクに必要な文脈情報（任意）
 *   - complexity: 'light' | 'medium' | 'heavy' — モデル選択（必須）
 *   - system: string? — 委任先LLMの system プロンプト上書き（任意）
 *   - max_tokens: number? — 委任先の max_tokens（任意、デフォルト2048。
 *     上限は complexity 別: light/medium=8192, heavy=16384）
 *
 * Response (200):
 *   { result: { text, model, complexity, usage: { input_tokens, output_tokens } } }
 *
 * X-LLM-API-Key ヘッダーは任意。未設定時はDBからBYOKキーを取得。
 * 認証: index.ts の onRequest フックで Bearer BEING_API_TOKEN を検証済み。
 *
 * #964
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { getApiKeyFromTable } from '../lib/chat/api-key.js'
import { runDelegate } from '../lib/chat/delegate.js'
import { isValidComplexity, DELEGATE_MAX_TOKENS_LIMIT, type DelegateComplexity } from '../lib/llm/delegate-models.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

interface DelegateRequestBody {
  task?: string
  context?: string
  complexity?: string
  system?: string
  max_tokens?: number
}

export const beingDelegateRoute: FastifyPluginAsync = async (app) => {
  app.post<{
    Params: { being_id: string }
    Body: DelegateRequestBody
  }>('/v1/beings/:being_id/delegate', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId
    const body = request.body || {}

    // ---- バリデーション ----
    const task = typeof body.task === 'string' ? body.task.trim() : ''
    if (!task) {
      return reply.code(400).send({ error: 'task is required' })
    }
    if (task.length > 8000) {
      return reply.code(400).send({ error: 'task too long (max 8000 chars)' })
    }

    if (!isValidComplexity(body.complexity)) {
      return reply.code(400).send({
        error: 'complexity must be one of: light, medium, heavy',
      })
    }
    const complexity: DelegateComplexity = body.complexity

    const context =
      typeof body.context === 'string' && body.context.trim() ? body.context : undefined
    if (context && context.length > 32000) {
      return reply.code(400).send({ error: 'context too long (max 32000 chars)' })
    }

    const system =
      typeof body.system === 'string' && body.system.trim() ? body.system : undefined
    if (system && system.length > 8000) {
      return reply.code(400).send({ error: 'system too long (max 8000 chars)' })
    }

    // max_tokens: 任意。指定された場合は complexity 別の上限内であること。
    const maxTokensLimit = DELEGATE_MAX_TOKENS_LIMIT[complexity]
    let maxTokens: number | undefined
    if (body.max_tokens !== undefined) {
      if (
        typeof body.max_tokens !== 'number' ||
        !Number.isFinite(body.max_tokens) ||
        !Number.isInteger(body.max_tokens) ||
        body.max_tokens <= 0 ||
        body.max_tokens > maxTokensLimit
      ) {
        return reply.code(400).send({
          error: `max_tokens must be an integer between 1 and ${maxTokensLimit} for complexity=${complexity}`,
        })
      }
      maxTokens = body.max_tokens
    }

    // ---- 所有権チェック ----
    const { data: being } = await supabase
      .from('beings')
      .select('id, owner_id')
      .eq('id', being_id)
      .eq('owner_id', userId)
      .single()
    if (!being) return reply.code(404).send({ error: 'Not found' })

    // ---- APIキー解決（ヘッダー優先 → DB） ----
    let apiKey = (request.headers['x-llm-api-key'] as string | undefined) || undefined
    if (!apiKey) {
      try {
        apiKey = await getApiKeyFromTable(supabase, userId, 'anthropic')
      } catch {
        return reply.code(400).send({
          error: 'Anthropic API key not configured. Provide X-LLM-API-Key header or register a key in settings.',
        })
      }
    }

    // ---- 委任実行 ----
    try {
      const result = await runDelegate({
        task,
        context,
        complexity,
        apiKey,
        system,
        maxTokens,
      })
      return reply.send({ result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[being-delegate] failed:', message)
      // Anthropic 側のエラーは 502（上流障害）として返す
      if (message.startsWith('Anthropic API error')) {
        return reply.code(502).send({ error: 'Upstream LLM error', detail: message })
      }
      return reply.code(500).send({ error: 'Delegate failed' })
    }
  })
}
