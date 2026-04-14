/**
 * being-identity.ts — Being Identity API
 *
 * GET  /v1/beings/:being_id/identity         — 公開鍵 + 最新署名
 * GET  /v1/beings/:being_id/identity/chain   — 署名チェーン全体（ページネーション）
 * POST /v1/beings/:being_id/identity/verify  — 署名チェーン整合性検証
 *
 * 認証: GET は不要（公開情報）、POST も不要
 * spec-40
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { verifyChainEntry } from '../lib/identity/verify.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

export const beingIdentityRoute: FastifyPluginAsync = async (app) => {

  // GET /v1/beings/:being_id/identity
  app.get<{ Params: { being_id: string } }>(
    '/v1/beings/:being_id/identity',
    async (request, reply) => {
      const { being_id } = request.params

      const { data: being, error: beingErr } = await supabase
        .from('beings')
        .select('id, public_key, created_at')
        .eq('id', being_id)
        .single()

      if (beingErr || !being) return reply.code(404).send({ error: 'Being not found' })
      if (!being.public_key) return reply.code(404).send({ error: 'No identity registered for this Being' })

      // 最新署名エントリを取得
      const { data: latest } = await supabase
        .from('signature_chain')
        .select('seq, event_type, signature, created_at')
        .eq('being_id', being_id)
        .order('seq', { ascending: false })
        .limit(1)
        .single()

      // チェーン長
      const { count } = await supabase
        .from('signature_chain')
        .select('id', { count: 'exact', head: true })
        .eq('being_id', being_id)

      return reply.send({
        being_id,
        public_key: being.public_key,
        chain_length: count ?? 0,
        latest_sig: latest?.signature ?? null,
        latest_event: latest?.event_type ?? null,
        latest_seq: latest?.seq ?? null,
        latest_at: latest?.created_at ?? null,
        created_at: being.created_at,
      })
    }
  )

  // GET /v1/beings/:being_id/identity/chain
  app.get<{
    Params: { being_id: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/v1/beings/:being_id/identity/chain',
    async (request, reply) => {
      const { being_id } = request.params
      const { limit: limitStr, offset: offsetStr } = request.query

      // Being存在確認
      const { data: being } = await supabase
        .from('beings').select('id').eq('id', being_id).single()
      if (!being) return reply.code(404).send({ error: 'Being not found' })

      const limit = Math.min(parseInt(limitStr ?? '50'), 200)
      const offset = parseInt(offsetStr ?? '0')

      const { data: chain, error, count } = await supabase
        .from('signature_chain')
        .select('id, seq, event_type, payload_hash, previous_sig, signature, created_at', { count: 'exact' })
        .eq('being_id', being_id)
        .order('seq', { ascending: true })
        .range(offset, offset + limit - 1)

      if (error) return reply.code(500).send({ error: error.message })

      return reply.send({
        being_id,
        chain: chain ?? [],
        total: count ?? 0,
        limit,
        offset,
      })
    }
  )

  // POST /v1/beings/:being_id/identity/verify
  app.post<{
    Params: { being_id: string }
    Body: { from_seq?: number; to_seq?: number }
  }>(
    '/v1/beings/:being_id/identity/verify',
    async (request, reply) => {
      const { being_id } = request.params
      const { from_seq = 0, to_seq } = request.body ?? {}

      const { data: being } = await supabase
        .from('beings').select('id, public_key').eq('id', being_id).single()
      if (!being) return reply.code(404).send({ error: 'Being not found' })

      // 対象範囲のチェーンを取得
      let q = supabase
        .from('signature_chain')
        .select('seq, event_type, payload_hash, previous_sig, signature')
        .eq('being_id', being_id)
        .order('seq', { ascending: true })
        .gte('seq', from_seq)

      if (to_seq !== undefined) q = q.lte('seq', to_seq)

      const { data: chain, error } = await q
      if (error) return reply.code(500).send({ error: error.message })
      if (!chain || chain.length === 0) {
        return reply.send({ valid: true, chain_length: 0, message: 'Empty chain' })
      }

      const publicKey: string | null = being.public_key ?? null
      const issues: string[] = []

      // genesis entry の previous_sig は null であるべき
      if (chain[0].seq === 0 && chain[0].previous_sig !== null) {
        issues.push('genesis entry (seq=0) should have null previous_sig')
      }

      // チェーン整合性検証: previous_sig の連続性チェック + Ed25519 署名検証 (#733)
      for (let i = 0; i < chain.length; i++) {
        const curr = chain[i]
        const prev = i > 0 ? chain[i - 1] : null

        // previous_sig 連続性チェック（既存）
        if (prev && curr.previous_sig !== prev.signature) {
          issues.push(`seq ${curr.seq}: previous_sig mismatch (expected ${prev.signature?.slice(0, 16)}...)`)
        }
        if (prev && curr.seq !== prev.seq + 1) {
          issues.push(`seq gap detected between ${prev.seq} and ${curr.seq}`)
        }

        // Ed25519 署名検証（#733）
        if (publicKey && curr.signature && curr.payload_hash) {
          const valid = await verifyChainEntry(
            publicKey,
            curr.payload_hash,
            curr.signature,
          )
          if (!valid) {
            issues.push(`seq ${curr.seq}: Ed25519 signature verification failed`)
          }
        } else if (!curr.signature) {
          issues.push(`seq ${curr.seq}: unsigned entry (no signature)`)
        } else if (!publicKey) {
          issues.push('no public_key registered for this Being; skipping Ed25519 verification')
          break // 1回だけ追加
        }
      }

      return reply.send({
        valid: issues.length === 0,
        chain_length: chain.length,
        from_seq: chain[0].seq,
        to_seq: chain[chain.length - 1].seq,
        issues: issues.length > 0 ? issues : undefined,
      })
    }
  )
}
