/**
 * being-memory.ts — 記憶操作RESTエンドポイント
 *
 * POST /v1/beings/:being_id/memory/recall
 * POST /v1/beings/:being_id/memory/merge
 * POST /v1/beings/:being_id/memory/update
 * POST /v1/beings/:being_id/memory/conclude
 * POST /v1/beings/:being_id/memory/search-history
 * POST /v1/beings/:being_id/relationships/update
 *
 * 既存ツールハンドラの薄いラッパー。LLMキー不要。
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 * #546: request.beingUserId でユーザー特定（DB認証後に注入）
 *
 * #555
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { createSupabaseMemoryStore } from '../lib/memory/supabase-store.js'
import { handleRecallMemory, handleMergeNodes } from '../lib/chat/recall-tools.js'
import { handleUpdateMemory, type UpdateMemoryInput } from '../lib/chat/update-memory.js'
import { handleUpdateNotes, type UpdateNotesInput } from '../lib/chat/update-notes.js'
import { handleSearchHistory, type SearchHistoryInput } from '../lib/chat/search-history.js'
import { handleUpdateRelation, type UpdateRelationInput } from '../lib/chat/update-relation.js'
import { haikuFrontRecall } from '../lib/chat/haiku-recall.js'
import { createAnthropicProvider } from '../lib/llm/anthropic-provider.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

async function verifyOwnership(beingId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('beings')
    .select('id')
    .eq('id', beingId)
    .eq('owner_id', userId)
    .single()
  return !!data
}

async function getPartnerType(beingId: string): Promise<string> {
  const { data } = await supabase
    .from('souls')
    .select('partner_type')
    .eq('being_id', beingId)
    .maybeSingle()
  return data?.partner_type ?? 'default'
}

export const beingMemoryRoute: FastifyPluginAsync = async (app) => {

  // POST /memory/recall
  app.post<{
    Params: { being_id: string }
    Body: { cluster_id: string; limit?: number; query?: string; no_nodes?: boolean }
  }>('/v1/beings/:being_id/memory/recall', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId

    if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { cluster_id, limit, query, no_nodes } = request.body
    if (!cluster_id) return reply.code(400).send({ error: 'cluster_id is required' })

    const store = createSupabaseMemoryStore(supabase, userId, undefined, being_id)
    const result = await handleRecallMemory(store, { cluster_id, limit, query, no_nodes })
    return reply.send({ result })
  })

  // POST /memory/merge
  app.post<{
    Params: { being_id: string }
    Body: { node_ids: string; summary: string; feeling?: string }
  }>('/v1/beings/:being_id/memory/merge', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId

    if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { node_ids, summary, feeling } = request.body
    if (!node_ids || !summary) return reply.code(400).send({ error: 'node_ids and summary are required' })

    const store = createSupabaseMemoryStore(supabase, userId, undefined, being_id)
    const result = await handleMergeNodes(store, { node_ids, summary, feeling })
    return reply.send({ result })
  })

  // POST /memory/update
  app.post<{
    Params: { being_id: string }
    Body: UpdateMemoryInput
  }>('/v1/beings/:being_id/memory/update', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId

    if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const partnerType = await getPartnerType(being_id)
    const store = createSupabaseMemoryStore(supabase, userId, partnerType, being_id)
    const result = await handleUpdateMemory(store, request.body, partnerType)
    return reply.send(result)
  })

  // POST /memory/conclude
  app.post<{
    Params: { being_id: string }
    Body: UpdateNotesInput
  }>('/v1/beings/:being_id/memory/conclude', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId

    if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const llmApiKey = request.headers['x-llm-api-key'] as string | undefined
    const partnerType = await getPartnerType(being_id)
    const store = createSupabaseMemoryStore(supabase, userId, partnerType, being_id)
    const result = await handleUpdateNotes(store, request.body, {
      llmApiKey,
      beingId: being_id,
      userId,
      partnerType,
    })
    return reply.send({ result })
  })

  // POST /memory/search-history
  app.post<{
    Params: { being_id: string }
    Body: SearchHistoryInput & { session_id?: string }
  }>('/v1/beings/:being_id/memory/search-history', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId

    if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { query, session_id, ...rest } = request.body
    if (!query) return reply.code(400).send({ error: 'query is required' })

    const result = await handleSearchHistory(supabase, userId, { query, ...rest }, session_id ?? null)
    return reply.send({ result })
  })

  // POST /relationships/update
  app.post<{
    Params: { being_id: string }
    Body: UpdateRelationInput
  }>('/v1/beings/:being_id/relationships/update', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId

    if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const result = await handleUpdateRelation(being_id, request.body)
    return reply.send(result)
  })

  // POST /memory/auto-recall (#596)
  // ユーザーメッセージからHaikuでキーワード抽出→graph検索→関連ノード返却
  app.post<{
    Params: { being_id: string }
    Body: { user_message: string }
  }>('/v1/beings/:being_id/memory/auto-recall', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId

    const llmApiKey = request.headers['x-llm-api-key'] as string | undefined
    if (!llmApiKey) return reply.code(400).send({ error: 'X-LLM-API-Key header is required' })

    if (!await verifyOwnership(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

    const { user_message } = request.body
    if (!user_message) return reply.code(400).send({ error: 'user_message is required' })

    const store = createSupabaseMemoryStore(supabase, userId, undefined, being_id)
    const llm = createAnthropicProvider(llmApiKey)
    const recallResult = await haikuFrontRecall(store, user_message, llm)

    // クラスタ・常駐ノードを取得してキーワード（クラスタ名）と共に返す
    const [clusters, residentNodes] = await Promise.all([
      store.getClusters(),
      store.getNodes({
        pinned: false,
        orderBy: 'importance',
        orderDirection: 'desc',
        secondaryOrderBy: 'last_activated',
        secondaryOrderDirection: 'desc',
        limit: 3,
      }),
    ])

    return reply.send({
      nodes: residentNodes,
      keywords: clusters.map((c) => c.name),
      recall_content: recallResult.content,
    })
  })
}
