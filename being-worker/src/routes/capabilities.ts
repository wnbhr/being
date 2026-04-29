/**
 * capabilities.ts — capability 管理 REST API
 *
 * GET    /v1/beings/:being_id/capabilities          — 現在利用可能なcapability一覧
 * POST   /v1/beings/:being_id/capabilities/register — Bridgeがcapabilityを登録
 * DELETE /v1/beings/:being_id/capabilities/:id      — capability登録解除
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 * #239
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { getBridgesByUser, registerCapabilities, type Capability } from '../bridge/bridge-manager.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

async function verifyOwnership(beingId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('beings').select('id').eq('id', beingId).eq('owner_id', userId).single()
  return !!data
}

export const capabilitiesRoute: FastifyPluginAsync = async (app) => {

  // GET /v1/beings/:being_id/capabilities — 接続中Bridgeのcapability一覧
  app.get<{ Params: { being_id: string } }>(
    '/v1/beings/:being_id/capabilities',
    async (request, reply) => {
      const userId: string = request.beingUserId
      const { being_id } = request.params

      if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

      // メモリ上の接続中Bridgeのcapabilityを返す
      const bridges = getBridgesByUser(userId)
      const { data: caps } = await supabase
        .from('capabilities')
        .select('*')
        .eq('user_id', userId)
        .in('bridge_id', bridges.map((b) => b.bridgeId))

      return reply.send({
        capabilities: caps ?? [],
        connected_bridges: bridges.map((b) => ({
          bridge_id: b.bridgeId,
          bridge_name: b.bridgeName,
          connected_at: b.connectedAt,
        })),
      })
    }
  )

  // POST /v1/beings/:being_id/capabilities/register — REST経由でcapability登録
  app.post<{
    Params: { being_id: string }
    Body: { bridge_id: string; bridge_name: string; capabilities: Capability[] }
  }>(
    '/v1/beings/:being_id/capabilities/register',
    async (request, reply) => {
      const userId: string = request.beingUserId
      const { being_id } = request.params
      const { bridge_id, bridge_name, capabilities } = request.body

      if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })
      if (!bridge_id || !bridge_name) return reply.code(400).send({ error: 'bridge_id and bridge_name are required' })

      await registerCapabilities({ userId, bridgeId: bridge_id, bridgeName: bridge_name, capabilities: capabilities ?? [] })

      return reply.code(201).send({ ok: true, registered: (capabilities ?? []).length })
    }
  )

  // DELETE /v1/beings/:being_id/capabilities/:id — capability登録解除
  app.delete<{ Params: { being_id: string; id: string } }>(
    '/v1/beings/:being_id/capabilities/:id',
    async (request, reply) => {
      const userId: string = request.beingUserId
      const { being_id, id } = request.params

      if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

      const { error } = await supabase
        .from('capabilities')
        .delete()
        .eq('id', id)
        .eq('user_id', userId)

      if (error) return reply.code(500).send({ error: error.message })

      return reply.code(204).send()
    }
  )
}
