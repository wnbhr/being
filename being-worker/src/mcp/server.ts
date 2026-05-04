/**
 * mcp/server.ts — Being embedded MCP Server (#612)
 *
 * createMcpServer(userId, beingId, supabase, options?) で McpServer を返す。
 * 各ツールは既存ハンドラ関数を直接呼び出す（HTTP ラウンドトリップなし）。
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createSupabaseMemoryStore } from '../lib/memory/supabase-store.js'
import { handleRecallMemory, handleMergeNodes } from '../lib/chat/recall-tools.js'
import { handleUpdateMemory, type UpdateMemoryInput } from '../lib/chat/update-memory.js'
import { handleUpdateNotes, type UpdateNotesInput } from '../lib/chat/update-notes.js'
import { handleSearchHistory } from '../lib/chat/search-history.js'
import { handleUpdateRelation, type UpdateRelationInput } from '../lib/chat/update-relation.js'
import { runPatrolWithMessages } from '../worker/patrol.js'
import { buildSystemPrompt, buildBlock1B, type SystemBlock } from '../lib/chat/system-prompt.js'
import { getBridgesByUser } from '../bridge/bridge-manager.js'
import { haikuFrontRecall } from '../lib/chat/haiku-recall.js'
import { sceneToText } from '../lib/chat/scene-utils.js'

export interface McpServerOptions {
  llmApiKey?: string
}

export function createMcpServer(
  userId: string,
  beingId: string,
  supabase: SupabaseClient,
  options: McpServerOptions = {}
): McpServer {
  // #786: beingId を渡して notes/memory_nodes/clusters の書き込み時に being_id を付与
  const store = createSupabaseMemoryStore(supabase, userId, undefined, beingId)
  const server = new McpServer({ name: 'being', version: '1.0.0' })

  async function getPartnerType(): Promise<string> {
    const { data } = await supabase
      .from('souls')
      .select('partner_type')
      .eq('being_id', beingId)
      .maybeSingle()
    return data?.partner_type ?? 'default'
  }

  // ── recall_memory ──────────────────────────────────────────────────────────
  server.tool(
    'recall_memory',
    '記憶クラスタを探索する。cluster_id省略でクラスタ一覧を取得、cluster_id指定でそのクラスタのダイジェストとノードを取得する。',
    {
      cluster_id: z.string().optional().describe('クラスタID（UUID）。省略するとクラスタ一覧を返す'),
      limit: z.number().optional().describe('返すノード数（デフォルト5）'),
      query: z.string().optional().describe('ノード絞り込み用キーワード（省略可）'),
      no_nodes: z.boolean().optional().describe('trueでdigestのみ返す'),
    },
    async (args) => {
      if (!args.cluster_id) {
        // cluster_id省略: クラスタ一覧を返す
        try {
          const clusters = await store.getClusters()
          if (clusters.length === 0) {
            return { content: [{ type: 'text' as const, text: 'クラスタがまだ作られていません。会話を重ねると巡回（patrol）で自動的に記憶が整理されます。' }] }
          }
          const lines = clusters.map(c =>
            `- [${c.id}] ${c.name}${c.digest ? ` — ${c.digest}` : ''}`
          )
          return { content: [{ type: 'text' as const, text: `クラスタ一覧 (${clusters.length}件):\n${lines.join('\n')}` }] }
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `error: ${String(err)}` }], isError: true }
        }
      }
      const result = await handleRecallMemory(store, args as Parameters<typeof handleRecallMemory>[1])
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  // ── search_memory ──────────────────────────────────────────────────────────
  server.tool(
    'search_memory',
    '記憶ノード（memory_nodes）をベクトル検索する。過去の体験・感情・出来事を思い出したい時に使う。recall_memoryと違いcluster_idは不要。OPENAI_API_KEY未設定時はキーワード検索にフォールバック。',
    {
      query: z.string().describe('検索クエリ（ベクトル検索またはキーワード部分一致）'),
      limit: z.number().optional().describe('返す件数（デフォルト10、最大30）'),
    },
    async (args) => {
      try {
        const limit = Math.min(args.limit ?? 10, 30)

        // ベクトル検索（OPENAI_API_KEY必須）— spec-946
        if (process.env.OPENAI_API_KEY) {
          const { embedText } = await import('../lib/memory/embedding.js')
          const queryVector = await embedText(args.query)
          const nodeMatches = await store.findSimilarNodes(queryVector, limit, 0.35)
          if (nodeMatches.length > 0) {
            const nodeIds = nodeMatches.map((m) => m.id)
            const nodes = await store.getNodesByIds(nodeIds)
            const lines = nodeMatches.map((m) => {
              const node = nodes.find((n) => n.id === m.id)
              if (!node) return null
              return `- [node_id: ${node.id}${node.cluster_id ? `, cluster_id: ${node.cluster_id}` : ''}] ${sceneToText(node.scene as import('../lib/chat/scene-utils.js').Scene | null, node.feeling)}${node.themes ? ` (themes: ${(node.themes as string[]).join(', ')})` : ''}`
            }).filter(Boolean)
            return { content: [{ type: 'text' as const, text: `記憶 ${lines.length}件（ベクトル検索）:\n${lines.join('\n')}` }] }
          }
          return { content: [{ type: 'text' as const, text: `「${args.query}」に関する記憶は見つかりませんでした。` }] }
        }

        // フォールバック: ilike検索（OPENAI_API_KEY未設定時）
        const nodes = await store.getNodes({
          actionQuery: args.query,
          limit,
          orderBy: 'importance',
          orderDirection: 'desc',
        })
        if (nodes.length === 0) {
          return { content: [{ type: 'text' as const, text: `「${args.query}」に関する記憶は見つかりませんでした。` }] }
        }
        const lines = nodes.map(n =>
          `- [${n.id}] ${sceneToText(n.scene as import('../lib/chat/scene-utils.js').Scene | null, n.feeling)}${n.themes ? ` (themes: ${(n.themes as string[]).join(', ')})` : ''}`
        )
        return { content: [{ type: 'text' as const, text: `記憶 ${nodes.length}件（キーワード検索）:\n${lines.join('\n')}` }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `error: ${String(err)}` }], isError: true }
      }
    }
  )

  // ── merge_nodes ────────────────────────────────────────────────────────────
  server.tool(
    'merge_nodes',
    '複数の類似した記憶ノードを1つに統合する。重複・類似ノードを整理する時に使う。',
    {
      node_ids: z.string().describe('統合するノードID（カンマ区切り）'),
      summary: z.string().describe('統合後のaction文字列'),
      feeling: z.string().optional().describe('統合後のfeeling（省略可）'),
    },
    async (args) => {
      const result = await handleMergeNodes(store, args)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  // ── update_memory ──────────────────────────────────────────────────────────
  server.tool(
    'update_memory',
    'パートナーの記憶（preferences, knowledge, relationship 等）を読み書きする。',
    {
      target: z.enum(['preferences', 'knowledge', 'relationship', 'partner_tools', 'partner_map', 'diary', 'notes', 'party_message', 'partner_rules', 'souls']).describe('更新対象'),
      action: z.enum(['get', 'append', 'update', 'delete']).describe('操作種別'),
      content: z.string().optional().describe('追記・更新する内容'),
      key: z.string().optional().describe('update/delete/getで対象を絞るキー'),
      location: z.string().optional().describe('partner_map upsert時のlocation'),
      to: z.string().optional().describe('送信先パートナー名（party_message時のみ）'),
    },
    async (args) => {
      const partnerType = await getPartnerType()
      const result = await handleUpdateMemory(store, args as unknown as UpdateMemoryInput, partnerType)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    }
  )

  // ── update_notes ───────────────────────────────────────────────────────────
  const sceneSchema = z.object({
    action: z.string().describe('何が起きたか（必須）'),
    actors: z.array(z.string()).describe('誰が（必須）'),
    when: z.array(z.string()).describe('日付（YYYY-MM-DD）（必須）'),
    feeling: z.string().optional().describe('主観的な感想（一人称）— 省略するな'),
    themes: z.array(z.string()).optional().describe('テーマタグ — 省略するな'),
    setting: z.string().optional().describe('どこで、どんな状況で'),
    importance: z.number().min(0).max(1).optional().describe('重要度 0.0-1.0（デフォルト0.5）'),
  })

  server.tool(
    'update_notes',
    '会話のシーンを記録する。シーンとは決定・出来事・気づき・感情など、記憶に残すべき断片。scenesは巡回で記憶ノードに変換される構造化データ。notesはメモ帳としても使える（TODO・リマインダー等）。scenes or notes のどちらか1つ以上を渡すこと。action=appendで新規追加、action=updateでscene_idsの既存sceneを統合・置換。',
    {
      action: z.enum(['append', 'update']).optional().describe('append=追加（デフォルト）, update=既存sceneを統合置換'),
      scenes: z.array(sceneSchema).optional().describe('会話で生まれた記憶の断片（構造化）'),
      notes: z.array(z.string()).optional().describe('走り書きメモ（巡回では消費されず残る。タスク・メモ・未解決事項など）'),
      scene_ids: z.array(z.string()).optional().describe('action=update時に削除する既存sceneのID'),
    },
    async (args) => {
      const partnerType = await getPartnerType()
      const result = await handleUpdateNotes(store, args as unknown as UpdateNotesInput, {
        llmApiKey: options.llmApiKey,
        beingId,
        userId,
        partnerType,
        supabase,
      })
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  // ── search_history ─────────────────────────────────────────────────────────
  server.tool(
    'search_history',
    '過去の会話履歴をキーワードや日付で検索する。',
    {
      query: z.string().optional().describe('検索キーワード（部分一致）'),
      date_from: z.string().optional().describe('検索開始日（YYYY-MM-DD）'),
      date_to: z.string().optional().describe('検索終了日（YYYY-MM-DD）'),
      limit: z.number().optional().describe('返す件数（デフォルト10、最大50）'),
    },
    async (args) => {
      const result = await handleSearchHistory(supabase, userId, args)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  // ── update_relation ────────────────────────────────────────────────────────
  server.tool(
    'update_relation',
    'Being の関係性（relations テーブル）を更新する。人・デバイス・AI等との関係を記録・削除できる。',
    {
      entity_name: z.string().describe('関係先エンティティの名前または識別子'),
      relation_type: z.string().describe('エンティティの種別（person/device/ai/organization等）'),
      content: z.string().optional().describe('関係性の説明・詳細（upsert時必須）'),
      action: z.enum(['upsert', 'delete']).describe('upsert: 作成/上書き、delete: 削除'),
    },
    async (args) => {
      const result = await handleUpdateRelation(beingId, args as unknown as UpdateRelationInput)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    }
  )

  // ── trigger_patrol ─────────────────────────────────────────────────────────
  server.tool(
    'trigger_patrol',
    'メッセージ履歴からシーンを抽出して memory_nodes に保存する。X-LLM-API-Key は任意（未設定時はDBからBYOKキーを取得、なければ機械的ステップのみ実行）。',
    {
      messages: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })).describe('処理対象のメッセージ一覧'),
      marker_id: z.string().optional().describe('前回の marker_id（省略可）'),
    },
    async (args) => {
      const llmApiKey = options.llmApiKey || undefined  // optional: DB fallback in runPatrolWithMessages
      const partnerType = await getPartnerType()
      const result = await runPatrolWithMessages({
        userId,
        beingId,
        partnerType,
        messages: args.messages,
        markerIdFrom: args.marker_id ?? null,
        llmApiKey,
      })
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'ok',
            scenes_created: result.scenesCreated,
            nodes_created: result.nodesCreated,
            marker_id: result.markerId,
          }),
        }],
      }
    }
  )

  // ── get_current_time ──────────────────────────────────────────────────────
  server.tool(
    'get_current_time',
    'パートナーのタイムゾーン付き現在日時を返す。日付・曜日・時刻の確認に使う。',
    {
      timezone: z.string().optional().describe('タイムゾーン識別子（例: Asia/Tokyo）。省略時はUTC。'),
    },
    async (args) => {
      const tz = args.timezone ?? 'UTC'
      const now = new Date()
      let formatted: string
      try {
        formatted = new Intl.DateTimeFormat('ja-JP', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          weekday: 'short',
          hour12: false,
        }).format(now)
      } catch {
        formatted = now.toISOString()
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ datetime: formatted, iso: now.toISOString(), timezone: tz }),
        }],
      }
    }
  )


  // ── recall ─────────────────────────────────────────────────────────────────
  server.tool(
    'recall',
    '**毎ターン、ユーザーメッセージを受け取ったら最初にこのツールを呼べ。** 今の話題に関連する過去の記憶をベクトル検索で取得する。結果はメッセージごとに変わる — 前回と同じとは限らない。呼ばないと、関連する記憶が欠落したまま応答することになる。',
    {
      user_message: z.string().describe('今回のユーザーメッセージ'),
    },
    async (args) => {
      try {
        const recallResult = await haikuFrontRecall(store, args.user_message)
        if (!recallResult.content) {
          return { content: [{ type: 'text' as const, text: '関連する記憶はありませんでした。' }] }
        }
        return { content: [{ type: 'text' as const, text: recallResult.content }] }
      } catch (err) {
        console.warn('[recall] haikuFrontRecall failed:', err)
        return { content: [{ type: 'text' as const, text: '記憶の検索に失敗しました（会話は続行してください）' }] }
      }
    }
  )

  // ── get_context ────────────────────────────────────────────────────────────
  server.tool(
    'get_context',
    'セッション開始時に1回呼ぶ。Beingの人格定義(system_prompt)と記憶スナップショット(snapshot)を返す。毎ターン呼ぶ必要はない — 記憶の取得には recall ツールを使え。',
    {},
    async (args) => {
      const { data: soul } = await supabase
        .from('souls')
        .select('name, partner_type')
        .eq('being_id', beingId)
        .maybeSingle()
      const partnerType = soul?.partner_type ?? 'default'

      // 1-A と 1-B を並列で取得（buildSystemPrompt は結合するので個別に呼ぶ）
      const [block1AResult, block1BResult, recentNodesRaw] = await Promise.all([
        (async () => {
          const result = await buildSystemPrompt({
            store,
            partnerType,
            supabase,
            userId,
          })
          return {
            systemPrompt: result.system.map((b: SystemBlock) => b.text).join('\n\n'),
            soulName: result.soulName,
          }
        })(),
        buildBlock1B(store, partnerType),
        store.getNodes({
          status: 'active',
          orderBy: 'last_activated',
          orderDirection: 'desc',
          limit: 10,
        }),
      ])

      // 直近ノード: sceneがnullのゴミを除外して上位5件
      const recentNodes = recentNodesRaw
        .filter((n) => n.scene && n.scene.action)
        .slice(0, 5)
      const recentNodesText = recentNodes.length > 0
        ? recentNodes.map((n) =>
            `- ${sceneToText(n.scene, n.feeling)}`
          ).join('\n')
        : ''



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
            })
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            system_prompt: block1AResult.systemPrompt,
            snapshot: block1BResult.content,
            metadata: {
              being_id: beingId,
              soul_name: block1AResult.soulName ?? '',
              model_recommendation: 'claude-sonnet-4-6',
              cache_guidance: {
                system_prompt: 'stable — cache as prefix. Changes only when SOUL is edited.',
                snapshot: 'semi-stable — inject as messages prefix (user+assistant pair). Changes on note/preference/relationship updates.',
              },
            },
            capability_tools: capabilityTools,
            recent_nodes: recentNodesText || undefined,
          }),
        }],
      }
    }
  )

  return server
}
