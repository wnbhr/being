/**
 * being-crud.ts — Being CRUD エンドポイント
 *
 * GET    /v1/beings            Being一覧
 * POST   /v1/beings            Being作成（SOUL同時生成）
 * GET    /v1/beings/:being_id  Being詳細
 * DELETE /v1/beings/:being_id  Being削除
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 * #546: (request as any).beingUserId でユーザー特定（DB認証後に注入）
 *
 * #552
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import * as ed from '@noble/ed25519'
import { encrypt } from '../lib/utils/encryption.js'

function generateBeingKeyPair(): { publicKey: string; privateKeyHex: string } {
  const privBytes = ed.utils.randomSecretKey()
  const pubBytes = ed.getPublicKey(privBytes)
  return {
    privateKeyHex: ed.etc.bytesToHex(privBytes),
    publicKey: `ed25519:${ed.etc.bytesToHex(pubBytes)}`,
  }
}

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

export const beingCrudRoute: FastifyPluginAsync = async (app) => {
  // GET /v1/beings — Being一覧
  app.get('/v1/beings', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { data, error } = await supabase
      .from('beings')
      .select('*')
      .eq('owner_id', userId)
    if (error) return reply.code(500).send({ error: error.message })
    return reply.send(data)
  })

  // POST /v1/beings — Being作成（デフォルトSOUL同時生成）
  app.post<{ Body: { name: string } }>('/v1/beings', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { name } = request.body

    if (!name) return reply.code(400).send({ error: 'name is required' })

    const { data: being, error: beingError } = await supabase
      .from('beings')
      .insert({ owner_id: userId, name })
      .select()
      .single()
    if (beingError) return reply.code(500).send({ error: beingError.message })

    // デフォルトSOUL自動生成（失敗してもBeing作成自体は成功扱い）
    const { error: soulError } = await supabase
      .from('souls')
      .insert({ being_id: being.id, name, partner_type: name.toLowerCase() })
    if (soulError) {
      console.warn(`[being-crud] soul insert failed for being ${being.id}:`, soulError.message)
    }

    // #823: キーペア自動生成（失敗してもBeing作成自体は成功扱い）
    // genesis 署名は soul テキスト未取得のためスキップ。Next.js側で initializeBeing() が担当。
    // app/lib/identity/server-signing.ts はNext.js専用なので @noble/ed25519 で直接実装
    try {
      const keyPair = generateBeingKeyPair()
      const encryptedPrivKey = encrypt(keyPair.privateKeyHex)
      const { error: keyErr } = await supabase
        .from('beings')
        .update({ public_key: keyPair.publicKey, encrypted_private_key: encryptedPrivKey })
        .eq('id', being.id)
        .is('public_key', null)
      if (keyErr) {
        console.warn(`[being-crud] keypair update failed for being ${being.id}:`, keyErr.message)
      }
    } catch (e) {
      console.warn(`[being-crud] keypair failed for being ${being.id}:`, e)
    }

    return reply.code(201).send(being)
  })

  // GET /v1/beings/:being_id — Being詳細
  app.get<{ Params: { being_id: string } }>('/v1/beings/:being_id', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    const { data } = await supabase
      .from('beings')
      .select('*')
      .eq('id', being_id)
      .eq('owner_id', userId)
      .single()

    if (!data) return reply.code(404).send({ error: 'Not found' })
    return reply.send(data)
  })

  // DELETE /v1/beings/:being_id — Being削除（FK ON DELETE CASCADE 前提）
  app.delete<{ Params: { being_id: string } }>('/v1/beings/:being_id', async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string = (request as any).beingUserId
    const { being_id } = request.params

    // 所有権チェック（存在を隠す → 不一致でも404）
    const { data: existing } = await supabase
      .from('beings')
      .select('id')
      .eq('id', being_id)
      .eq('owner_id', userId)
      .single()

    if (!existing) return reply.code(404).send({ error: 'Not found' })

    // FK ON DELETE CASCADE で souls 等も自動削除される想定
    const { error } = await supabase.from('beings').delete().eq('id', being_id)
    if (error) return reply.code(500).send({ error: error.message })

    return reply.code(204).send()
  })
}
