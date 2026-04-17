/**
 * being-context.ts — GET /v1/beings/:being_id/context
 *
 * 接続先（OpenClaw, Cowork等）がLLM呼び出し前にコンテキスト一式を取得する。
 * spec-39 §4-1 形式のJSONを返す。
 *
 * レスポンス:
 *   system_prompt   — 1-A: PRINCIPLES + SOUL + ユーザー情報
 *   snapshot        — 1-B: preferences / relationships / rules / think_md 等
 *   pinned_context  — 2-A: 廃止（後方互換のため []を返す）
 *   tools           — Being側ツール定義一覧
 *   metadata        — being_id / soul_name / model_recommendation / cache_hint
 *
 * #596: haiku-recall は /memory/auto-recall エンドポイントに移行。
 *
 * 認証: index.ts の onRequest フックで自動適用（Bearer BEING_API_TOKEN）
 * #546: (request as any).beingUserId でユーザー特定
 *
 * #556
 */

import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { buildSystemPrompt } from '../lib/chat/system-prompt.js'
import { buildBlock1B } from '../lib/chat/system-prompt.js'
import { createSupabaseMemoryStore } from '../lib/memory/supabase-store.js'
import { RECALL_MEMORY_TOOL, MERGE_NODES_TOOL } from '../lib/chat/recall-tools.js'
import { UPDATE_MEMORY_TOOL } from '../lib/chat/update-memory.js'
import { SEARCH_HISTORY_TOOL } from '../lib/chat/search-history.js'
import { GET_CURRENT_TIME_TOOL } from '../lib/chat/time-tool.js'
import { UPDATE_NOTES_TOOL } from '../lib/chat/update-notes.js'
import { UPDATE_RELATION_TOOL } from '../lib/chat/update-relation.js'
import { getBridgesByUser } from '../bridge/bridge-manager.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

// Being 側ツール一覧（exec 等の接続先ツールは含まない）
const BEING_TOOLS = [
  RECALL_MEMORY_TOOL,
  MERGE_NODES_TOOL,
  UPDATE_MEMORY_TOOL,
  SEARCH_HISTORY_TOOL,
  GET_CURRENT_TIME_TOOL,
  UPDATE_NOTES_TOOL,
  UPDATE_RELATION_TOOL,
]

export const beingContextRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { being_id: string } }>(
    '/v1/beings/:being_id/context',
    async (request, reply) => {
      const { being_id } = request.params
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId: string = (request as any).beingUserId

      // 1. Being 取得 + 所有権チェック
      const { data: being } = await supabase
        .from('beings')
        .select('id, name, owner_id')
        .eq('id', being_id)
        .eq('owner_id', userId)
        .single()
      if (!being) return reply.code(404).send({ error: 'Not found' })

      // 2. SOUL 取得
      const { data: soul } = await supabase
        .from('souls')
        .select('name, partner_type')
        .eq('being_id', being_id)
        .maybeSingle()
      const partnerType = soul?.partner_type ?? 'default'

      // 3. MemoryStore (#786: being_id を渡して書き込み時に付与)
      const store = createSupabaseMemoryStore(supabase, userId, partnerType, being_id)

      // 4. buildSystemPrompt 呼び出し（#596: haiku-recall はauto-recall APIに移行）
      const result = await buildSystemPrompt({
        store,
        partnerType,
        supabase,
        userId,
        beingId: being_id,
      })

      // 5. spec-39 形式に変換

      // system_prompt: 1-A SystemBlock[] → 連結文字列
      const systemPrompt = result.system
        .map((b: { text: string }) => b.text)
        .join('\n\n')

      // snapshot: 1-B（buildBlock1B を別途呼ぶ or prefixMessages から抽出）
      // buildSystemPrompt は 1-B を prefixMessages[0].content に入れているので抽出
      const snapshotMsg = result.prefixMessages.find(
        (m) => m.role === 'user' && typeof m.content !== 'string' &&
          Array.isArray(m.content) &&
          (m.content as Array<{ text?: string }>)[0]?.text?.includes('<snapshot>')
      )
      const snapshot = snapshotMsg
        ? (Array.isArray(snapshotMsg.content)
            ? (snapshotMsg.content as Array<{ text: string }>).map((b) => b.text).join('\n')
            : snapshotMsg.content as string)
        : ''

      // Step 3: 接続中Bridgeのcapabilityを動的ツールとして追加 (#239)
      const connectedBridges = getBridgesByUser(userId)
      const capabilityTools: Array<Record<string, unknown>> = []

      if (connectedBridges.length > 0) {
        const bridgeIds = connectedBridges.map((b) => b.bridgeId)
        const { data: caps } = await supabase
          .from('capabilities')
          .select('*')
          .eq('user_id', userId)
          .in('bridge_id', bridgeIds)

        for (const cap of caps ?? []) {
          if (cap.type === 'act') {
            capabilityTools.push({
              name: `act_${(cap.name as string).toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
              description: cap.description ?? `${cap.name} を実行する`,
              input_schema: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    description: '実行するアクション',
                    enum: (cap.config as Record<string, unknown>)?.actions ?? [],
                  },
                  parameters: { type: 'object', description: 'アクションのパラメータ（省略可）' },
                },
                required: ['action'],
              },
              // メタデータ（接続先が act ツールを被 Being API に転送する際に使用）
              _capability_id: cap.id,
              _bridge_id: cap.bridge_id,
            })
          }
        }
      }

      // notes: scene / note を構造化して返す（spec-39 §4-1, #730）
      const [sceneNotes, textNotes] = await Promise.all([
        store.getNotesByType('scene'),
        store.getNotesByType('note'),
      ])
      const notes = [...sceneNotes, ...textNotes]
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .map((n) => {
          // #799 Bug 4: [PARSE_FAILED] マーカー付きのノートはLLM修復指示を付与
          const isParseFailure = n.content.startsWith('[PARSE_FAILED]')
          return {
            id: n.id,
            type: n.type,
            content: isParseFailure
              ? n.content.replace('[PARSE_FAILED]', '').trimStart()
              : n.content,
            created_at: n.created_at,
            ...(isParseFailure ? {
              repair_required: true,
              repair_instruction: 'このsceneはJSONパースに失敗した非構造化データです。内容を読み取り、update_notesで正しい構造に変換してください。',
            } : {}),
          }
        })

      // #790: preferences から user_name / user_call_name / language を取得してmetadataに追加
      // パートナーがユーザーを認識するためのヒント
      const userPrefs = await store.getPreferences()
      const userInfo: Record<string, string> = {}
      for (const p of userPrefs) {
        if (p.key === 'user_name') userInfo.name = p.description
        if (p.key === 'user_call_name') userInfo.call_name = p.description
        if (p.key === 'language') userInfo.language = p.description
      }

      return reply.send({
        system_prompt: systemPrompt,
        snapshot,
        pinned_context: [],
        notes,
        tools: [...BEING_TOOLS, ...capabilityTools],
        metadata: {
          being_id,
          soul_name: result.soulName ?? being.name,
          model_recommendation: 'claude-sonnet-4-6',
          cache_hint: {
            stable_prefix_tokens: 12000,
            note: 'system_prompt + snapshot は安定。notesはupdate_notesで変化',
          },
          ...(Object.keys(userInfo).length > 0 ? { user_info: userInfo } : {}),
        },
      })
    }
  )
}
