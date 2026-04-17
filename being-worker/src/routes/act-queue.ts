/**
 * act-queue.ts — act pending/approve/reject RESTルート（Being Worker側） (#886-④)
 *
 * GET  /v1/beings/:being_id/act/pending         — pending状態のアクション一覧
 * POST /v1/beings/:being_id/act/pending/approve — アクションを承認（status → "approved"）
 * POST /v1/beings/:being_id/act/pending/reject  — アクションを拒否（status → "rejected"）
 *
 * Cove側の docs/app/api/beings/[id]/act/ を参考に移植。
 * act_queueテーブルを操作。being_idフィルタを全パスで徹底。
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

async function verifyOwnership(beingId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('beings').select('id').eq('id', beingId).eq('owner_id', userId).single()
  return !!data
}

export const actQueueRoute: FastifyPluginAsync = async (app) => {

  // GET /v1/beings/:being_id/act/pending — pending一覧
  app.get<{
    Params: { being_id: string }
  }>(
    '/v1/beings/:being_id/act/pending',
    async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId: string = (request as any).beingUserId
      const { being_id } = request.params

      if (!await verifyOwnership(being_id, userId)) {
        return reply.code(404).send({ error: 'Being not found.' })
      }

      const { data, error } = await supabase
        .from('act_queue')
        .select('id, capability_id, bridge_id, action_type, action_payload, status, created_at')
        .eq('being_id', being_id)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })

      if (error) {
        return reply.code(500).send({ error: 'Failed to fetch pending actions.' })
      }

      return reply.send({ actions: data ?? [] })
    }
  )

  // POST /v1/beings/:being_id/act/pending/approve — アクションを承認
  app.post<{
    Params: { being_id: string }
    Body: { action_id?: unknown }
  }>(
    '/v1/beings/:being_id/act/pending/approve',
    async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId: string = (request as any).beingUserId
      const { being_id } = request.params
      const body = request.body as { action_id?: unknown }

      if (!await verifyOwnership(being_id, userId)) {
        return reply.code(404).send({ error: 'Being not found.' })
      }

      if (typeof body.action_id !== 'string' || !body.action_id.trim()) {
        return reply.code(400).send({ error: 'action_id is required.' })
      }

      const { data, error } = await supabase
        .from('act_queue')
        .update({ status: 'approved', resolved_at: new Date().toISOString() })
        .eq('id', body.action_id)
        .eq('being_id', being_id)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .select()
        .single()

      if (error || !data) {
        return reply.code(404).send({ error: 'Action not found or already resolved.' })
      }

      return reply.send({ ok: true, action: data })
    }
  )

  // POST /v1/beings/:being_id/act/pending/reject — アクションを拒否
  app.post<{
    Params: { being_id: string }
    Body: { action_id?: unknown }
  }>(
    '/v1/beings/:being_id/act/pending/reject',
    async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId: string = (request as any).beingUserId
      const { being_id } = request.params
      const body = request.body as { action_id?: unknown }

      if (!await verifyOwnership(being_id, userId)) {
        return reply.code(404).send({ error: 'Being not found.' })
      }

      if (typeof body.action_id !== 'string' || !body.action_id.trim()) {
        return reply.code(400).send({ error: 'action_id is required.' })
      }

      const { data, error } = await supabase
        .from('act_queue')
        .update({ status: 'rejected', resolved_at: new Date().toISOString() })
        .eq('id', body.action_id)
        .eq('being_id', being_id)
        .eq('user_id', userId)
        .eq('status', 'pending')
        .select()
        .single()

      if (error || !data) {
        return reply.code(404).send({ error: 'Action not found or already resolved.' })
      }

      return reply.send({ ok: true, action: data })
    }
  )
}
