/**
 * being-remote-exec.ts — remote_exec REST エンドポイント
 *
 * POST /v1/beings/:being_id/remote-exec
 * GET  /v1/beings/:being_id/remote-exec/has-hosts
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 *
 * has-hosts は MCP ツール露出条件の判定用。tools.ts は remote_hosts が
 * 1件以上あるときだけ remote_exec ツールを返したいので、軽量な確認 API を提供する。
 *
 * #929
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { createSupabaseMemoryStore } from '../lib/memory/supabase-store.js'
import {
  handleRemoteExec,
  loadRemoteHosts,
  type RemoteExecInput,
} from '../lib/chat/remote-exec.js'

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

export const beingRemoteExecRoute: FastifyPluginAsync = async (app) => {
  // POST /v1/beings/:being_id/remote-exec
  app.post<{
    Params: { being_id: string }
    Body: RemoteExecInput
  }>('/v1/beings/:being_id/remote-exec', async (request, reply) => {
    const { being_id } = request.params
    const userId: string = request.beingUserId

    if (!(await verifyOwnership(being_id, userId)))
      return reply.code(404).send({ error: 'Not found' })

    const store = createSupabaseMemoryStore(supabase, userId, undefined, being_id)
    const result = await handleRemoteExec(store, request.body, undefined, being_id)
    return reply.send({ result })
  })

  // GET /v1/beings/:being_id/remote-exec/has-hosts
  // tools.ts で remote_exec ツールを露出するか判定するためのヘルパー。
  // 認証済みなのでホスト一覧そのものは返さず、件数だけ返す。
  app.get<{ Params: { being_id: string } }>(
    '/v1/beings/:being_id/remote-exec/has-hosts',
    async (request, reply) => {
      const { being_id } = request.params
      const userId: string = request.beingUserId

      if (!(await verifyOwnership(being_id, userId)))
        return reply.code(404).send({ error: 'Not found' })

      const store = createSupabaseMemoryStore(supabase, userId, undefined, being_id)
      const loaded = await loadRemoteHosts(store, being_id)
      if ('error' in loaded) {
        return reply.send({ result: { count: 0, valid: false, error: loaded.error } })
      }
      return reply.send({ result: { count: loaded.hosts.length, valid: true } })
    }
  )
}
