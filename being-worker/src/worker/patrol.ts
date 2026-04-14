/**
 * patrol.ts — Patrol（巡回パイプライン）エントリポイント
 *
 * #547: Being Worker — 会話処理とPatrolの分離
 * #724: Step 0追加（Telegram経由: chat_messages → update_notes → scene保存 → archive）
 *
 * フロー:
 *   runPatrol（Telegram経由）:
 *     Step 0: chat_messages(block=2b)があれば update_notes 呼び出し → scene notes保存 → archive
 *     ❶〜❼: runGraphMigration（graph.ts）に委譲
 *
 *   runPatrolWithMessages（Being API経由）:
 *     messages[]をrunGraphMigrationに渡す（Step 0はgraph.ts内で処理）
 */

import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { createSupabaseMemoryStore } from '../lib/memory/supabase-store.js'
import { runGraphMigration, type GraphMigrationResult } from '../lib/chat/graph.js'
import { getApiKeyFromTable, getApiKey } from '../lib/chat/api-key.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

export async function runPatrol(userId: string, partnerType: string, beingId?: string): Promise<GraphMigrationResult> {
  console.log(JSON.stringify({ event: 'patrol_start', userId, partnerType, beingId }))

  try {
    const store = createSupabaseMemoryStore(supabase, userId, partnerType, beingId)

    // APIキー取得（ユーザーのBYOKキー → Anthropic provider）。未設定時は機械的ステップのみ実行
    const apiKey = await getApiKeyFromTable(supabase, userId, 'anthropic').catch(() => undefined as string | undefined) ?? undefined

    const sonnetModel = process.env.GRAPH_MODEL ?? 'claude-sonnet-4-6'

    // Supabase Realtime broadcast: patrol開始
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patrolChannel = (supabase as any).channel(`patrol:${userId}`)
    await patrolChannel.send({
      type: 'broadcast', event: 'patrol_status', payload: { step: 'extracting' },
    }).catch(() => {})

    // Step 0 (extractAndSaveScenes) は廃止。パートナーが update_notes でシーンを保存する正規フローに統一。

    // ❶〜❼ パイプライン実行（graph.ts に委譲）
    const result = await runGraphMigration({
      userId,
      partnerType,
      store,
      apiKey,
      sonnetModel,
      onDiaryStart: async () => {
        await patrolChannel.send({
          type: 'broadcast', event: 'patrol_status', payload: { step: 'diary' },
        }).catch(() => {})
      },
      // messagesは渡さない（Step 0で既にscene notesに保存済み）
    })

    // 巡回完了後: 処理済みsceneを削除（non-fatal）
    await store.deleteNotesByType('scene').catch((err: unknown) => {
      console.warn('[patrol] deleteNotesByType(scene) failed (ignored):', err)
    })

    // patrol_complete broadcast（UIのノードバブル表示トリガー）
    await patrolChannel.send({
      type: 'broadcast',
      event: 'patrol_complete',
      payload: { addedNodes: result.addedNodes, nodes: result.nodes },
    }).catch(() => {})

    supabase.removeChannel(patrolChannel)

    // chat_messagesに巡回完了メッセージを保存（UIへの表示用）
    await supabase.from('chat_messages').insert({
      user_id: userId,
      role: 'system',
      content: `✨ 記憶を整理しました（追加ノード: ${result.addedNodes}件）`,
    }).then(undefined, (err: unknown) => {
      console.warn('[patrol] chat_messages insert failed (ignored):', err)
    })

    console.log(JSON.stringify({ event: 'patrol_done', userId, partnerType, addedNodes: result.addedNodes }))
    return result
  } catch (err) {
    console.error(JSON.stringify({ event: 'patrol_error', userId, partnerType, error: String(err) }))
    throw err
  }
}


/**
 * runPatrolWithMessages — Being API patrol/trigger 用（messages[]入力モード）
 *
 * 接続先が marker 以降の会話を messages[] で渡す。
 * DB から chat_messages を読まず、渡された messages をそのまま使う。
 * messages=[]の場合（MCP経由）はStep 0をスキップ、既存のscene notesのみ処理。
 * marker_id は beings テーブルの patrol_marker カラムに保存する。
 *
 * #557
 */
export async function runPatrolWithMessages(params: {
  userId: string
  beingId: string
  partnerType: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  markerIdFrom: string | null
  /** LLM APIキー。未設定時は❹❻diary/think_mdをスキップ（機械的処理のみ） */
  llmApiKey?: string
}): Promise<{ scenesCreated: number; nodesCreated: number; markerId: string }> {
  const { createClient } = await import('@supabase/supabase-js')
  const { config } = await import('../config.js')
  const crypto = await import('crypto')

  const supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
  // #799 Bug 1: beingId を渡して巡回で作成されたノードに being_id を付与
  const store = createSupabaseMemoryStore(supabaseClient, params.userId, params.partnerType, params.beingId)

  // #799 Bug 2: llmApiKey が未設定の場合、DBから取得（MCP経由の巡回でもLLMステップが実行されるように）
  let llmApiKey = params.llmApiKey
  if (!llmApiKey) {
    try {
      // user_api_keys テーブルから優先取得
      llmApiKey = await getApiKeyFromTable(supabaseClient, params.userId, 'anthropic').catch(() => undefined as string | undefined) ?? undefined
      if (!llmApiKey) {
        // フォールバック: profiles の暗号化カラムから取得
        const { data: profile } = await supabaseClient
          .from('profiles')
          .select('llm_provider, anthropic_api_key_encrypted, openai_api_key_encrypted, google_api_key_encrypted, plan')
          .eq('id', params.userId)
          .single() as { data: { llm_provider: string | null; anthropic_api_key_encrypted: string | null; openai_api_key_encrypted: string | null; google_api_key_encrypted: string | null; plan: string } | null }
        if (profile) {
          llmApiKey = await getApiKey({
            plan: profile.plan ?? 'free',
            llm_provider: profile.llm_provider ?? null,
            anthropic_api_key_encrypted: profile.anthropic_api_key_encrypted ?? null,
            openai_api_key_encrypted: profile.openai_api_key_encrypted ?? null,
            google_api_key_encrypted: profile.google_api_key_encrypted ?? null,
          }, 'anthropic').catch(() => undefined as string | undefined) ?? undefined
        }
      }
      if (llmApiKey) {
        console.log(JSON.stringify({ event: 'patrol_llm_key_fetched', userId: params.userId }))
      }
    } catch (err) {
      console.warn('[patrol] runPatrolWithMessages: failed to fetch llm api key, LLM steps will be skipped:', err)
    }
  }

  console.log(JSON.stringify({ event: 'patrol_with_messages_start', userId: params.userId, beingId: params.beingId, messageCount: params.messages.length }))

  try {
    // Step 0 (extractAndSaveScenes) は廃止。パートナーが update_notes でシーンを保存する正規フローに統一。
    // messages パラメータは marker_id 計算にのみ使用（将来）。

    const result = await runGraphMigration({
      userId: params.userId,
      partnerType: params.partnerType,
      store,
      apiKey: llmApiKey,  // undefined時は内部でLLM依存ステップをスキップ
      // messages は渡さない（Step 0は上で完了済み）
    })

    // 処理済みsceneを削除
    await store.deleteNotesByType('scene').catch((err: unknown) => {
      console.warn('[patrol] deleteNotesByType(scene) failed (ignored):', err)
    })

    // marker_id 生成・保存（beings.patrol_marker）
    const markerId = crypto.randomUUID()
    await supabaseClient
      .from('beings')
      .update({ patrol_marker: markerId })
      .eq('id', params.beingId)

    console.log(JSON.stringify({ event: 'patrol_with_messages_done', userId: params.userId, beingId: params.beingId, addedNodes: result.addedNodes, markerId }))

    return {
      scenesCreated: result.nodes.length,
      nodesCreated: result.addedNodes,
      markerId,
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'patrol_with_messages_error', userId: params.userId, beingId: params.beingId, error: String(err) }))
    throw err
  }
}
