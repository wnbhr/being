/**
 * being-extensions.ts — Being Extensions API
 *
 * GET    /v1/beings/:being_id/extensions            インストール済み拡張一覧
 * POST   /v1/beings/:being_id/extensions/:slug/install   拡張インストール
 * DELETE /v1/beings/:being_id/extensions/:slug/uninstall アンインストール
 * PUT    /v1/beings/:being_id/extensions/:slug/toggle    アクティブ切替
 * PUT    /v1/beings/:being_id/extensions/:slug/config    設定更新（Telegram Bot Token等は暗号化）
 * GET    /v1/extensions          拡張ストア一覧（is_active=true）
 * GET    /v1/extensions/:slug    拡張詳細
 *
 * 認証: index.ts の onRequest フックで自動適用
 *
 * #651
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { config } from '../config.js'
import { encrypt } from '../lib/utils/encryption.js'

/** サブスクリプション課金が必要な拡張スラッグ */
const SUBSCRIPTION_SLUGS = new Set(['tool-loop', 'sandbox'])

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

async function verifyBeing(beingId: string, userId: string) {
  const { data } = await supabase
    .from('beings')
    .select('id')
    .eq('id', beingId)
    .eq('owner_id', userId)
    .single()
  return data
}

async function getExtensionBySlug(slug: string) {
  const { data } = await supabase
    .from('extensions')
    .select('id, slug, name, description, is_active')
    .eq('slug', slug)
    .single()
  return data
}

export const beingExtensionsRoute: FastifyPluginAsync = async (app) => {

  // ─── Being-scoped エンドポイント ──────────────────────────────────────────

  // GET /v1/beings/:being_id/extensions — インストール済み拡張一覧
  app.get<{ Params: { being_id: string } }>(
    '/v1/beings/:being_id/extensions',
    async (request, reply) => {
      const userId: string = request.beingUserId
      const { being_id } = request.params

      if (!await verifyBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

      const { data, error } = await supabase
        .from('being_extensions')
        .select('id, being_id, is_active, config, created_at, updated_at, extensions(id, slug, name, description)')
        .eq('being_id', being_id)

      if (error) return reply.code(500).send({ error: error.message })
      return reply.send(data ?? [])
    }
  )

  // POST /v1/beings/:being_id/extensions/:slug/install — インストール
  app.post<{ Params: { being_id: string; slug: string } }>(
    '/v1/beings/:being_id/extensions/:slug/install',
    async (request, reply) => {
      const userId: string = request.beingUserId
      const { being_id, slug } = request.params

      if (!await verifyBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

      const ext = await getExtensionBySlug(slug)
      if (!ext) return reply.code(404).send({ error: 'Extension not found' })

      // サブスクリプション型拡張: stripe_subscription_id の存在を確認
      if (SUBSCRIPTION_SLUGS.has(slug)) {
        const { data: subCheck } = await supabase
          .from('being_extensions')
          .select('config')
          .eq('being_id', being_id)
          .eq('extension_id', ext.id)
          .maybeSingle() as { data: { config: Record<string, unknown> } | null }

        // 既存レコードがなく、stripe_subscription_id も未設定なら拒否
        const hasSubscription = subCheck?.config?.stripe_subscription_id
        if (!hasSubscription) {
          // プロファイルの subscriptions テーブルでも確認
          const { data: stripeSub } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('being_id', being_id)
            .eq('extension_slug', slug)
            .eq('status', 'active')
            .maybeSingle() as { data: { id: string } | null }

          if (!stripeSub) {
            return reply.code(403).send({
              error: `${slug} 拡張はサブスクリプションが必要です。購読を開始してからインストールしてください。`,
            })
          }
        }
      }

      const { data, error } = await supabase
        .from('being_extensions')
        .upsert(
          { being_id, extension_id: ext.id, is_active: true },
          { onConflict: 'being_id,extension_id' }
        )
        .select('id, being_id, is_active, config, created_at, updated_at, extensions(id, slug, name, description)')
        .single()

      if (error) return reply.code(500).send({ error: error.message })
      return reply.code(201).send(data)
    }
  )

  // DELETE /v1/beings/:being_id/extensions/:slug/uninstall — アンインストール
  app.delete<{ Params: { being_id: string; slug: string } }>(
    '/v1/beings/:being_id/extensions/:slug/uninstall',
    async (request, reply) => {
      const userId: string = request.beingUserId
      const { being_id, slug } = request.params

      if (!await verifyBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

      const ext = await getExtensionBySlug(slug)
      if (!ext) return reply.code(404).send({ error: 'Extension not found' })

      const { error } = await supabase
        .from('being_extensions')
        .delete()
        .eq('being_id', being_id)
        .eq('extension_id', ext.id)

      if (error) return reply.code(500).send({ error: error.message })
      return reply.code(204).send()
    }
  )

  // PUT /v1/beings/:being_id/extensions/:slug/toggle — アクティブ/インアクティブ切替
  app.put<{ Params: { being_id: string; slug: string } }>(
    '/v1/beings/:being_id/extensions/:slug/toggle',
    async (request, reply) => {
      const userId: string = request.beingUserId
      const { being_id, slug } = request.params

      if (!await verifyBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

      const ext = await getExtensionBySlug(slug)
      if (!ext) return reply.code(404).send({ error: 'Extension not found' })

      const { data: current } = await supabase
        .from('being_extensions')
        .select('is_active')
        .eq('being_id', being_id)
        .eq('extension_id', ext.id)
        .single()

      if (!current) return reply.code(404).send({ error: 'Not installed' })

      const { data, error } = await supabase
        .from('being_extensions')
        .update({ is_active: !current.is_active, updated_at: new Date().toISOString() })
        .eq('being_id', being_id)
        .eq('extension_id', ext.id)
        .select('id, being_id, is_active, config, created_at, updated_at, extensions(id, slug, name, description)')
        .single()

      if (error) return reply.code(500).send({ error: error.message })
      return reply.send(data)
    }
  )

  // PUT /v1/beings/:being_id/extensions/:slug/config — 設定更新
  app.put<{
    Params: { being_id: string; slug: string }
    Body: Record<string, string>
  }>(
    '/v1/beings/:being_id/extensions/:slug/config',
    async (request, reply) => {
      const userId: string = request.beingUserId
      const { being_id, slug } = request.params

      if (!await verifyBeing(being_id, userId)) return reply.code(404).send({ error: 'Not found' })

      const ext = await getExtensionBySlug(slug)
      if (!ext) return reply.code(404).send({ error: 'Extension not found' })

      const { data: current } = await supabase
        .from('being_extensions')
        .select('config')
        .eq('being_id', being_id)
        .eq('extension_id', ext.id)
        .single()

      if (!current) return reply.code(404).send({ error: 'Not installed' })

      const body = request.body
      const mergedConfig: Record<string, unknown> = { ...(current.config as object) }

      if (slug === 'telegram') {
        // Bot Token: 暗号化して保存 + Webhook 自動設定
        if (body.bot_token) {
          mergedConfig.bot_token_encrypted = encrypt(body.bot_token)

          // Webhook secret を生成（16バイト hex）
          const webhookSecret = crypto.randomBytes(16).toString('hex')
          mergedConfig.webhook_secret = webhookSecret

          const webhookUrl = `${config.publicUrl}/v1/extensions/telegram/webhook/${being_id}`
          try {
            const res = await fetch(
              `https://api.telegram.org/bot${body.bot_token}/setWebhook`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
              }
            )
            const json = await res.json() as { ok: boolean; description?: string }
            if (!json.ok) {
              console.warn(`[being-extensions] setWebhook failed: ${json.description}`)
            }
          } catch (e) {
            console.warn('[being-extensions] setWebhook error:', e)
          }
        }

        // BYOK LLM APIキー: 暗号化して保存
        if (body.llm_api_key) {
          mergedConfig.llm_api_key_encrypted = encrypt(body.llm_api_key)
        }
      } else {
        // 汎用: そのまま保存（センシティブフィールドの扱いはフロントエンドで制御）
        Object.assign(mergedConfig, body)
      }

      const { data, error } = await supabase
        .from('being_extensions')
        .update({ config: mergedConfig, updated_at: new Date().toISOString() })
        .eq('being_id', being_id)
        .eq('extension_id', ext.id)
        .select('id, being_id, is_active, config, created_at, updated_at, extensions(id, slug, name, description)')
        .single()

      if (error) return reply.code(500).send({ error: error.message })
      return reply.send(data)
    }
  )

  // ─── 拡張ストア エンドポイント（認証あり）─────────────────────────────────

  // GET /v1/extensions — 拡張ストア一覧（is_active=true）
  app.get('/v1/extensions', async (_request, reply) => {
    const { data, error } = await supabase
      .from('extensions')
      .select('id, slug, name, description, created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: true })

    if (error) return reply.code(500).send({ error: error.message })
    return reply.send(data ?? [])
  })

  // GET /v1/extensions/:slug — 拡張詳細
  app.get<{ Params: { slug: string } }>(
    '/v1/extensions/:slug',
    async (request, reply) => {
      const { slug } = request.params
      const { data, error } = await supabase
        .from('extensions')
        .select('id, slug, name, description, config_schema, created_at')
        .eq('slug', slug)
        .single()

      if (error || !data) return reply.code(404).send({ error: 'Not found' })
      return reply.send(data)
    }
  )
}
