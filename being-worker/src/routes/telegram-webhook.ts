/**
 * telegram-webhook.ts — POST /v1/extensions/telegram/webhook/:being_id
 *
 * Telegram Webhook エンドポイント（認証不要）。
 * X-Telegram-Bot-Api-Secret-Token ヘッダーで署名検証。
 *
 * BotCommand:
 *   /new     → update_notes + runPatrolWithMessages + chat_messages DELETE
 *   /compact → update_notes + chat_messages DELETE（巡回なし）
 *   /stop    → telegram_sessions.is_active = false
 *   /reset   → chat_messages DELETE（巡回なし）
 *
 * 通常メッセージ:
 *   - telegram_sessions.is_active チェック / 自動作成
 *   - being_extensions から設定取得（BYOK LLM APIキー + model）
 *   - profiles からマルチモデル用APIキー取得（anthropic/openai/google）
 *   - buildSystemPrompt でコンテキスト構築
 *   - モデルに応じたAPI（Anthropic/OpenAI/Gemini）で返信生成
 *   - Telegram sendMessage で送信
 *   - chat_messages 保存（being_id スコープ）
 *
 * #651 #682: マルチモデル対応（Gemini/OpenAI + /new /compact コマンド修正）
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { decrypt } from '../lib/utils/encryption.js'
import { buildSystemPrompt } from '../lib/chat/system-prompt.js'
import { createSupabaseMemoryStore } from '../lib/memory/supabase-store.js'
import { runPatrolWithMessages } from '../worker/patrol.js'
import { handleUpdateNotes } from '../lib/chat/update-notes.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

interface TelegramMessage {
  message_id: number
  from?: { id: number; username?: string; first_name?: string }
  chat: { id: number; type: string }
  text?: string
  date: number
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

function tryDecrypt(encrypted: string): string | null {
  try {
    return decrypt(encrypted)
  } catch {
    return null
  }
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch (e) {
    console.warn('[telegram-webhook] sendMessage failed:', e)
  }
}

/**
 * モデル名からプロバイダーを判定 (#682)
 */
function detectProvider(model: string): 'anthropic' | 'openai' | 'google' {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai'
  if (model.startsWith('gemini')) return 'google'
  return 'anthropic'
}

/**
 * モデルに応じたAPIキーを取得 (#682)
 * 優先順: extConfig.llm_api_key_encrypted > profiles.{provider}_api_key_encrypted
 */
async function resolveApiKey(
  userId: string,
  model: string,
  extLlmApiKey: string | null,
): Promise<string | null> {
  if (extLlmApiKey) return extLlmApiKey

  const provider = detectProvider(model)
  const colMap: Record<string, string> = {
    anthropic: 'anthropic_api_key_encrypted',
    openai: 'openai_api_key_encrypted',
    google: 'google_api_key_encrypted',
  }
  const col = colMap[provider]
  if (!col) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select(col)
    .eq('id', userId)
    .single()

  const encrypted = (profile as Record<string, string> | null)?.[col]
  if (!encrypted) return null
  return tryDecrypt(encrypted)
}

/**
 * LLM API呼び出し（Anthropic/OpenAI/Gemini対応）(#682)
 */
async function callLLM(
  model: string,
  apiKey: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  userText: string,
): Promise<string> {
  const provider = detectProvider(model)
  const messages = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: userText },
  ]

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    })
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`)
    const json = await res.json() as { content: Array<{ type: string; text?: string }> }
    return json.content.find(b => b.type === 'text')?.text ?? ''
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        max_tokens: 1024,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    })
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`)
    const json = await res.json() as { choices: Array<{ message: { content: string } }> }
    return json.choices[0]?.message?.content ?? ''
  }

  if (provider === 'google') {
    const geminiModel = model || 'gemini-1.5-flash'
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: { maxOutputTokens: 1024 },
        }),
      }
    )
    if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`)
    const json = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }
    return json.candidates[0]?.content?.parts[0]?.text ?? ''
  }

  throw new Error(`Unknown provider for model: ${model}`)
}

export const telegramWebhookRoute: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { being_id: string } }>(
    '/v1/extensions/telegram/webhook/:being_id',
    async (request, reply) => {
      const { being_id } = request.params

      // Being 取得（owner_id も取得）
      const { data: being } = await supabase
        .from('beings')
        .select('id, owner_id')
        .eq('id', being_id)
        .single()
      if (!being) return reply.code(404).send({ error: 'Not found' })

      // being_extensions から Telegram 設定取得（slug → extension_id 経由）
      const { data: telegramExt } = await supabase
        .from('extensions')
        .select('id')
        .eq('slug', 'telegram')
        .single()
      if (!telegramExt) return reply.code(200).send({ ok: true })

      const { data: extRow } = await supabase
        .from('being_extensions')
        .select('config, is_active')
        .eq('being_id', being_id)
        .eq('extension_id', telegramExt.id)
        .single()

      if (!extRow || !extRow.is_active) {
        return reply.code(200).send({ ok: true }) // Telegramには常に200を返す
      }

      const extConfig = extRow.config as Record<string, string>

      // 署名検証
      const secretToken = request.headers['x-telegram-bot-api-secret-token'] as string | undefined
      if (!secretToken || secretToken !== extConfig.webhook_secret) {
        return reply.code(403).send({ error: 'Invalid secret token' })
      }

      // Update パース
      const update = request.body as TelegramUpdate
      const message = update.message
      if (!message) return reply.code(200).send({ ok: true })

      const chatId = message.chat.id
      const text = (message.text ?? '').trim()
      if (!text) return reply.code(200).send({ ok: true })

      // Bot Token 復号
      let botToken: string
      try {
        botToken = decrypt(extConfig.bot_token_encrypted)
      } catch {
        console.error('[telegram-webhook] bot_token decryption failed for being:', being_id)
        return reply.code(200).send({ ok: true })
      }

      // モデル設定 + extConfigのllm_api_key（直接設定のキー）
      const model = (extConfig.model as string | undefined) ?? 'claude-sonnet-4-6'
      const extLlmApiKey = extConfig.llm_api_key_encrypted
        ? tryDecrypt(extConfig.llm_api_key_encrypted)
        : null

      // ─── BotCommand 処理 ───────────────────────────────────────────────────
      if (text.startsWith('/')) {
        const command = text.split(' ')[0].split('@')[0]

        if (command === '/new') {
          // モデルに応じたAPIキーを取得（#682修正）
          const llmApiKey = await resolveApiKey(being.owner_id, model, extLlmApiKey)

          if (llmApiKey) {
            const { data: soul } = await supabase
              .from('souls')
              .select('partner_type')
              .eq('being_id', being_id)
              .maybeSingle()

            const { data: msgs } = await supabase
              .from('chat_messages')
              .select('role, content')
              .eq('being_id', being_id)
              .order('created_at', { ascending: true })
              .limit(50)

            if (msgs && msgs.length > 0) {
              const store = createSupabaseMemoryStore(supabase, being.owner_id, soul?.partner_type, being_id)
              await handleUpdateNotes(store, { summary: '会話の区切り（/new）' }, {
                llmApiKey,
                userId: being.owner_id,
                beingId: being_id,
                partnerType: soul?.partner_type ?? 'default',
              }).catch((e) => console.warn('[telegram-webhook] /new update_notes failed:', e))
              runPatrolWithMessages({
                userId: being.owner_id,
                beingId: being_id,
                partnerType: soul?.partner_type ?? 'default',
                messages: msgs as Array<{ role: 'user' | 'assistant'; content: string }>,
                markerIdFrom: null,
                llmApiKey,
              }).catch((e) => console.warn('[telegram-webhook] /new patrol failed:', e))
            }
          }

          await supabase.from('chat_messages').delete().eq('being_id', being_id)
          await sendTelegramMessage(botToken, chatId, '新しい会話を始めます。')
          return reply.code(200).send({ ok: true })
        }

        if (command === '/compact') {
          // モデルに応じたAPIキーを取得（#682修正）
          const llmApiKey = await resolveApiKey(being.owner_id, model, extLlmApiKey)

          if (llmApiKey) {
            const { data: soul } = await supabase
              .from('souls')
              .select('partner_type')
              .eq('being_id', being_id)
              .maybeSingle()

            const store = createSupabaseMemoryStore(supabase, being.owner_id, soul?.partner_type, being_id)
            await handleUpdateNotes(store, { summary: '会話の整理（/compact）' }, {
              llmApiKey,
              userId: being.owner_id,
              beingId: being_id,
              partnerType: soul?.partner_type ?? 'default',
            }).catch((e) => console.warn('[telegram-webhook] /compact update_notes failed:', e))
          }

          await supabase.from('chat_messages').delete().eq('being_id', being_id)
          await sendTelegramMessage(botToken, chatId, '会話を整理しました。')
          return reply.code(200).send({ ok: true })
        }

        if (command === '/stop') {
          await supabase
            .from('telegram_sessions')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('being_id', being_id)
            .eq('chat_id', chatId)
          await sendTelegramMessage(botToken, chatId, 'セッションを停止しました。/new で再開できます。')
          return reply.code(200).send({ ok: true })
        }

        if (command === '/reset') {
          await supabase.from('chat_messages').delete().eq('being_id', being_id)
          await sendTelegramMessage(botToken, chatId, 'チャット履歴をリセットしました。')
          return reply.code(200).send({ ok: true })
        }

        // 未知コマンドは無視
        return reply.code(200).send({ ok: true })
      }

      // ─── 通常メッセージ処理 ────────────────────────────────────────────────

      // セッション確認
      const { data: session } = await supabase
        .from('telegram_sessions')
        .select('id, is_active')
        .eq('being_id', being_id)
        .eq('chat_id', chatId)
        .maybeSingle()

      if (session && !session.is_active) {
        await sendTelegramMessage(botToken, chatId, 'セッションが停止中です。/new で再開してください。')
        return reply.code(200).send({ ok: true })
      }

      // セッション作成（初回）
      if (!session) {
        await supabase.from('telegram_sessions').upsert({
          being_id,
          chat_id: chatId,
          username: message.from?.username,
          is_active: true,
        })
      }

      // モデルに応じたAPIキーを取得（#682: Gemini/OpenAI/Anthropic対応）
      const llmApiKey = await resolveApiKey(being.owner_id, model, extLlmApiKey)

      if (!llmApiKey) {
        await sendTelegramMessage(botToken, chatId, 'LLM APIキーが設定されていません。設定ページでAPIキーを登録してください。')
        return reply.code(200).send({ ok: true })
      }

      // Soul 取得
      const { data: soul } = await supabase
        .from('souls')
        .select('partner_type')
        .eq('being_id', being_id)
        .maybeSingle()
      const partnerType = soul?.partner_type ?? 'default'

      // コンテキスト構築
      const store = createSupabaseMemoryStore(supabase, being.owner_id, partnerType, being_id)
      const promptResult = await buildSystemPrompt({
        store,
        partnerType,
        supabase,
        userId: being.owner_id,
        beingId: being_id,
      })
      const systemPrompt = promptResult.system
        .map((b: { text: string }) => b.text)
        .join('\n\n')

      // prefixMessages（1-B snapshot + 2-B fresh_memories）をhistoryの前に注入
      // contentはstring | ContentBlock[] の場合があるので、stringに正規化する
      const prefixMessages = promptResult.prefixMessages.map(
        (m: { role: string; content: string | Array<{ type: string; text: string }> }) => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content
            : m.content.map(b => b.text).join('\n'),
        })
      )

      // 直近チャット履歴（being_id スコープ）
      const { data: history } = await supabase
        .from('chat_messages')
        .select('role, content')
        .eq('being_id', being_id)
        .order('created_at', { ascending: true })
        .limit(20)

      const historyMessages = (history ?? []) as Array<{ role: string; content: string }>

      // prefix + chat history を結合
      const allMessages = [...prefixMessages, ...historyMessages]

      // LLM API 呼び出し（マルチモデル対応）
      let replyText = ''
      try {
        replyText = await callLLM(model, llmApiKey, systemPrompt, allMessages, text)
      } catch (e) {
        console.error('[telegram-webhook] LLM API error:', e)
        await sendTelegramMessage(botToken, chatId, 'エラーが発生しました。しばらく後に再試行してください。')
        return reply.code(200).send({ ok: true })
      }

      // Telegram 返信
      await sendTelegramMessage(botToken, chatId, replyText)

      // chat_messages 保存（being_id スコープ）
      const now = new Date()
      await supabase.from('chat_messages').insert([
        {
          being_id,
          user_id: being.owner_id,
          role: 'user',
          content: text,
          created_at: now.toISOString(),
        },
        {
          being_id,
          user_id: being.owner_id,
          role: 'assistant',
          content: replyText,
          created_at: new Date(now.getTime() + 1).toISOString(),
        },
      ])

      return reply.code(200).send({ ok: true })
    }
  )
}
