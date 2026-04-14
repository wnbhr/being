/**
 * sense.ts — Sense入力履歴 REST API
 *
 * GET /v1/beings/:being_id/sense/history — sense_log の履歴参照
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 * #239
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

export const senseRoute: FastifyPluginAsync = async (app) => {

  // GET /v1/beings/:being_id/sense/history
  app.get<{
    Params: { being_id: string }
    Querystring: { limit?: string; capability_id?: string }
  }>(
    '/v1/beings/:being_id/sense/history',
    async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId: string = (request as any).beingUserId
      const { being_id } = request.params
      const { limit: limitStr, capability_id } = request.query

      if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

      const limit = Math.min(parseInt(limitStr ?? '20'), 100)

      let q = supabase
        .from('sense_log')
        .select('id, capability_id, bridge_id, data, processed, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (capability_id) {
        q = q.eq('capability_id', capability_id)
      }

      const { data, error } = await q

      if (error) return reply.code(500).send({ error: error.message })

      return reply.send({ history: data ?? [], total: (data ?? []).length })
    }
  )
}
