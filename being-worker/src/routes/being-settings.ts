/**
 * being-settings.ts — 設定CRUD APIエンドポイント
 *
 * GET/PUT /v1/beings/:being_id/soul
 * GET/PUT /v1/beings/:being_id/preferences
 * GET/PUT /v1/beings/:being_id/relationships
 * PUT     /v1/beings/:being_id/relationships/:id
 * GET/PUT /v1/beings/:being_id/rules
 * GET     /v1/beings/:being_id/notes
 * POST    /v1/beings/:being_id/notes
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 * #546: (request as any).beingUserId でユーザー特定（DB認証後に注入）
 *
 * #553
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

// ─── 所有権チェックヘルパー ─────────────────────────────────
async function verifyAndGetBeing(beingId: string, userId: string) {
  const { data } = await supabase
    .from('beings')
    .select('id')
    .eq('id', beingId)
    .eq('owner_id', userId)
    .single()
  return data
}

async function getPartnerType(beingId: string): Promise<string> {
  const { data } = await supabase
    .from('souls')
    .select('partner_type')
    .eq('being_id', beingId)
    .maybeSingle()
  return data?.partner_type ?? 'default'
}

export const beingSettingsRoute: FastifyPluginAsync = async (app) => {

  // ─── SOUL ─────────────────────────────────────────────────

  app.get<{ Params: { being_id: string } }>('/v1/beings/:being_id/soul', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { data, error } = await supabase.from('souls').select('*').eq('being_id', being_id).single()
    if (error || !data) return reply.code(404).send({ error: 'Soul not found' })
    return reply.send(data)
  })

  app.put<{ Params: { being_id: string }; Body: Record<string, unknown> }>('/v1/beings/:being_id/soul', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { data, error } = await supabase
      .from('souls')
      .upsert({ being_id, ...request.body })
      .select()
      .single()
    if (error) return reply.code(500).send({ error: error.message })
    return reply.send(data)
  })

  // ─── PREFERENCES ──────────────────────────────────────────
  // TODO: being_id紐づけに変更予定。現在は user_id で管理。

  app.get<{ Params: { being_id: string } }>('/v1/beings/:being_id/preferences', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { data, error } = await supabase.from('preferences').select('*').eq('user_id', userId).single()
    if (error || !data) return reply.send({})
    return reply.send(data)
  })

  app.put<{ Params: { being_id: string }; Body: Record<string, unknown> }>('/v1/beings/:being_id/preferences', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { data, error } = await supabase
      .from('preferences')
      .upsert({ user_id: userId, ...request.body })
      .select()
      .single()
    if (error) return reply.code(500).send({ error: error.message })
    return reply.send(data)
  })

  // ─── RELATIONSHIPS ─────────────────────────────────────────

  app.get<{ Params: { being_id: string } }>('/v1/beings/:being_id/relationships', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { data, error } = await supabase.from('relationships').select('*').eq('user_id', userId)
    if (error) return reply.code(500).send({ error: error.message })
    return reply.send(data ?? [])
  })

  app.put<{ Params: { being_id: string; id: string }; Body: Record<string, unknown> }>('/v1/beings/:being_id/relationships/:id', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id, id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { data, error } = await supabase
      .from('relationships')
      .update(request.body)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()
    if (error || !data) return reply.code(404).send({ error: 'Relationship not found' })
    return reply.send(data)
  })

  // ─── PARTNER RULES ────────────────────────────────────────

  app.get<{ Params: { being_id: string } }>('/v1/beings/:being_id/rules', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const partnerType = await getPartnerType(being_id)
    const { data, error } = await supabase
      .from('partner_rules')
      .select('*')
      .eq('user_id', userId)
      .eq('partner_type', partnerType)
    if (error) return reply.code(500).send({ error: error.message })
    return reply.send(data ?? [])
  })

  app.put<{ Params: { being_id: string }; Body: Record<string, unknown> }>('/v1/beings/:being_id/rules', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const partnerType = await getPartnerType(being_id)
    const { data, error } = await supabase
      .from('partner_rules')
      .upsert({ user_id: userId, partner_type: partnerType, ...request.body })
      .select()
      .single()
    if (error) return reply.code(500).send({ error: error.message })
    return reply.send(data)
  })

  // ─── NOTES ────────────────────────────────────────────────

  app.get<{ Params: { being_id: string } }>('/v1/beings/:being_id/notes', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const partnerType = await getPartnerType(being_id)
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('user_id', userId)
      .eq('partner_type', partnerType)
    if (error) return reply.code(500).send({ error: error.message })
    return reply.send(data ?? [])
  })

  app.post<{ Params: { being_id: string }; Body: { content: string } }>('/v1/beings/:being_id/notes', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params
    const { content } = request.body

    if (!content) return reply.code(400).send({ error: 'content is required' })
    if (!await verifyAndGetBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const partnerType = await getPartnerType(being_id)
    const { data, error } = await supabase
      .from('notes')
      .insert({ user_id: userId, partner_type: partnerType, content })
      .select()
      .single()
    if (error) return reply.code(500).send({ error: error.message })
    return reply.code(201).send(data)
  })
}
