/**
 * being-patrol.ts — POST /v1/beings/:being_id/patrol/trigger
 *
 * Being API 用巡回エンドポイント（marker方式）。
 * 既存の内部用 POST /patrol/trigger（WORKER_SECRET認証、fire-and-forget）とは別パス。
 *
 * 接続先が marker 以降の会話を messages[] で渡す。
 * Being 側が scene 化 → memory_nodes 保存 → 新 marker_id を返す。
 * 同期レスポンス（200）: marker_id を含む JSON を返す。
 *
 * X-LLM-API-Key ヘッダーは任意。未設定時はDBからBYOKキーを取得し、なければLLM依存ステップをスキップ。
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 * #546: request.beingUserId でユーザー特定
 *
 * #557
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { runPatrolWithMessages } from '../worker/patrol.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

export const beingPatrolRoute: FastifyPluginAsync = async (app) => {
  app.post<{
    Params: { being_id: string }
    Body: {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
      marker_id?: string | null
    }
  }>(
    '/v1/beings/:being_id/patrol/trigger',
    async (request, reply) => {
      const { being_id } = request.params
      const { messages, marker_id } = request.body
      const userId: string = request.beingUserId

      // X-LLM-API-Key is optional (mechanical patrol steps run without it)
      const llmApiKey = (request.headers['x-llm-api-key'] as string | undefined) || undefined

      if (!messages || !Array.isArray(messages)) {
        return reply.code(400).send({ error: 'messages[] is required' })
      }

      // 所有権チェック
      const { data: being } = await supabase
        .from('beings')
        .select('id, owner_id')
        .eq('id', being_id)
        .eq('owner_id', userId)
        .single()
      if (!being) return reply.code(404).send({ error: 'Not found' })

      const { data: soul } = await supabase
        .from('souls')
        .select('partner_type')
        .eq('being_id', being_id)
        .maybeSingle()

      // 同期実行（marker_id を含むレスポンスを返すため fire-and-forget にしない）
      try {
        const result = await runPatrolWithMessages({
          userId,
          beingId: being_id,
          partnerType: soul?.partner_type ?? 'default',
          messages,
          markerIdFrom: marker_id ?? null,
          llmApiKey,
        })
        return reply.send({
          status: 'ok',
          scenes_created: result.scenesCreated,
          nodes_created: result.nodesCreated,
          marker_id: result.markerId,
        })
      } catch (err) {
        console.error('[being-patrol] runPatrolWithMessages failed:', err)
        return reply.code(500).send({ error: 'Patrol failed' })
      }
    }
  )
}
