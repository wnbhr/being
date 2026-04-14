/**
 * patrol.ts — /patrol/trigger エンドポイント
 *
 * Being API の巡回トリガ。
 * 認証は index.ts の onRequest フックで自動適用（Bearer token）。
 * fire-and-forget: 202 Accepted を即返し、処理はバックグラウンドで実行。
 *
 * #547: Being Worker — 会話処理とPatrolの分離
 */

import type { FastifyPluginAsync } from 'fastify'
import { runPatrol } from '../worker/patrol.js'

interface PatrolTriggerBody {
  user_id: string
  partner_type: string
}

export const patrolRoute: FastifyPluginAsync = async (app) => {
  app.post<{ Body: PatrolTriggerBody }>('/patrol/trigger', async (request, reply) => {
    const { user_id, partner_type } = request.body

    if (!user_id || !partner_type) {
      return reply.code(400).send({ error: 'user_id and partner_type are required' })
    }

    // fire-and-forget: 処理をバックグラウンドで実行し、即 202 を返す
    // Vercel側がブロックしないのと対称的にWorker側も即レスポンス
    runPatrol(user_id, partner_type).catch((err: unknown) => {
      console.error('[/patrol/trigger] runPatrol error:', err)
    })

    return reply.code(202).send({ status: 'accepted' })
  })
}
