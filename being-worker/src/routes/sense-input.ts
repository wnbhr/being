/**
 * sense-input.ts — REST sense入力ルート（Being Worker側） (#886-②)
 *
 * POST /v1/beings/:being_id/sense — sense入力をsense_logに保存
 *
 * ゲームエンジン等のHTTPクライアント向け。WebSocket不要。
 * capability_idはcapabilitiesテーブルに存在するものだけ許可（FK制約）。
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { saveSenseLog } from '../bridge/bridge-manager.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

async function verifyOwnership(beingId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('beings').select('id').eq('id', beingId).eq('owner_id', userId).single()
  return !!data
}

async function verifyCapability(capabilityId: string, userId: string): Promise<{ bridge_id: string } | null> {
  const { data } = await supabase
    .from('capabilities')
    .select('id, bridge_id')
    .eq('id', capabilityId)
    .eq('user_id', userId)
    .eq('type', 'sense')
    .single()
  return data ? { bridge_id: data.bridge_id as string } : null
}

export const senseInputRoute: FastifyPluginAsync = async (app) => {

  // POST /v1/beings/:being_id/sense
  app.post<{
    Params: { being_id: string }
    Body: { capability_id: string; data: unknown }
  }>(
    '/v1/beings/:being_id/sense',
    async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId: string = (request as any).beingUserId
      const { being_id } = request.params
      const body = request.body as { capability_id?: unknown; data?: unknown }

      if (!await verifyOwnership(being_id, userId)) {
        return reply.code(404).send({ error: 'Being not found.' })
      }

      if (typeof body.capability_id !== 'string' || !body.capability_id.trim()) {
        return reply.code(400).send({ error: 'capability_id is required.' })
      }

      if (body.data === undefined || body.data === null) {
        return reply.code(400).send({ error: 'data is required.' })
      }

      // capability_idがcapabilitiesテーブルに存在するか確認（FK制約相当）
      const cap = await verifyCapability(body.capability_id, userId)
      if (!cap) {
        return reply.code(400).send({ error: 'capability_id not found or not a sense capability.' })
      }

      try {
        const result = await saveSenseLog({
          userId,
          bridgeId: cap.bridge_id,
          capabilityId: body.capability_id,
          data: body.data,
        })
        return reply.code(201).send({
          sense_id: result.sense_id,
          capability_id: body.capability_id,
          processed: result.processed,
        })
      } catch (err) {
        return reply.code(500).send({ error: String(err) })
      }
    }
  )
}
