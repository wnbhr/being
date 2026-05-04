/**
 * mcp/server.ts — Being embedded MCP Server (#612)
 *
 * createMcpServer(userId, beingId, supabase, options?) で McpServer を返す。
 * 各ツールは既存ハンドラ関数を直接呼び出す（HTTP ラウンドトリップなし）。
 */

import { z } from 'zod'
import crypto from 'crypto'
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
import { getBridgesByUser, getBridgeById } from '../bridge/bridge-manager.js'
import { haikuFrontRecall } from '../lib/chat/haiku-recall.js'
import { sceneToText } from '../lib/chat/scene-utils.js'
import { embedText } from '../lib/memory/embedding.js'
import { handleActTool } from '../lib/chat/act-tool.js'
import { handleRemoteExec } from '../lib/chat/remote-exec.js'

export interface McpServerOptions {
  llmApiKey?: string
}

export async function createMcpServer(
  userId: string,
  beingId: string,
  supabase: SupabaseClient,
  options: McpServerOptions = {}
): Promise<McpServer> {
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
    '記憶ノード（memory_nodes）をキーワードで検索する。action / feeling / themes / when を横断検索。スペース区切りでOR検索（デフォルト）。mode="and" で全語AND検索。',
    {
      query: z.string().describe('検索キーワード。スペース区切りで複数語指定可（デフォルトOR検索）'),
      mode: z.enum(['or', 'and']).optional().describe('検索モード: "or"（デフォルト）または "and"'),
      limit: z.number().optional().describe('返す件数（デフォルト10、最大30）'),
    },
    async (args) => {
      try {
        const limit = Math.min(args.limit ?? 10, 30)
        let nodes: Awaited<ReturnType<typeof store.getNodes>>

        // ベクトル検索（OPENAI_API_KEY がある場合）、なければキーワードフォールバック
        let useVector = false
        if (process.env.OPENAI_API_KEY) {
          try {
            const queryVector = await embedText(args.query)
            const matches = await store.findSimilarNodes(queryVector, limit)
            if (matches.length > 0) {
              const nodeIds = matches.map(m => m.id)
              nodes = await store.getNodesByIds(nodeIds)
              useVector = true
            } else {
              nodes = []
            }
          } catch (vectorErr) {
            console.warn('[search_memory] vector search failed, falling back to keyword:', vectorErr)
            // フォールバック: キーワード検索
            nodes = await store.getNodes({
              searchQuery: args.query,
              searchMode: args.mode ?? 'or',
              limit,
              orderBy: 'importance',
              orderDirection: 'desc',
            })
          }
        } else {
          // キーワード検索（フォールバック）
          nodes = await store.getNodes({
            searchQuery: args.query,
            searchMode: args.mode ?? 'or',
            limit,
            orderBy: 'importance',
            orderDirection: 'desc',
          })
        }

        if (nodes.length === 0) {
          return { content: [{ type: 'text' as const, text: `「${args.query}」に関する記憶は見つかりませんでした。` }] }
        }

        // どのフィールドにヒットしたかを判定するヘルパー（キーワード検索時のみ表示）
        const terms = args.query.trim().split(/\s+/).filter(Boolean).map(t => t.toLowerCase())
        const detectMatchedFields = (n: typeof nodes[number]): string[] => {
          const fields: string[] = []
          const action = (n.scene as { action?: string } | null)?.action?.toLowerCase() ?? ''
          const feeling = (n.feeling ?? '').toLowerCase()
          const themes = (n.themes as string[] | null) ?? []
          // #942: when も検索対象に追加。WhenItem[] を JSON 文字列化して検索
          const whenStr = JSON.stringify((n.scene as { when?: unknown } | null)?.when ?? '').toLowerCase()
          if (terms.some(t => action.includes(t))) fields.push('action')
          if (terms.some(t => feeling.includes(t))) fields.push('feeling')
          if (terms.some(t => themes.some(th => th.toLowerCase().includes(t)))) fields.push('themes')
          if (terms.some(t => whenStr.includes(t))) fields.push('when')
          return fields
        }

        // #938: search_memoryでヒットしたノードをreactivate（「思い出した」のにカウントされないのは不整合）
        // dead: +2, active: +1（recall_memoryと同じ方針）
        const deadIds = nodes.filter(n => n.status === 'dead').map(n => n.id)
        const activeIds = nodes.filter(n => n.status === 'active').map(n => n.id)
        if (deadIds.length > 0) store.incrementReactivationCountsBy(deadIds, 2).catch(() => {})
        if (activeIds.length > 0) store.incrementReactivationCounts(activeIds).catch(() => {})

        const lines = nodes.map(n => {
          const matchTag = useVector ? '' : (() => {
            const matched = detectMatchedFields(n)
            return matched.length > 0 ? ` [matched: ${matched.join(',')}]` : ''
          })()
          return `- [${n.id}]${matchTag} ${sceneToText(n.scene as import('../lib/chat/scene-utils.js').Scene | null, n.feeling)}${n.themes ? ` (themes: ${(n.themes as string[]).join(', ')})` : ''}`
        })
        const searchMethod = useVector ? 'ベクトル検索' : 'キーワード検索'
        return { content: [{ type: 'text' as const, text: `記憶 ${nodes.length}件 (${searchMethod}):\n${lines.join('\n')}` }] }
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
        const reminder = '\n\n[REMINDER] 次のターンでもrecall()を呼んでください。会話の中で気づき・転換・方針決定・感情の動きがあればupdate_notes()で記録してください。'
        return { content: [{ type: 'text' as const, text: recallResult.content + reminder }] }
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
            beingId,
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

      // pending_senses: sense_log の未処理分を注入し、processed=true に更新 (#886-③)
      let pendingSenses: unknown[] = []
      try {
        const { data: senseRows } = await supabase
          .from('sense_log')
          .select('id, capability_id, bridge_id, data, created_at')
          .eq('user_id', userId)
          .eq('processed', false)
          .order('created_at', { ascending: true })
          .limit(50)
        if (senseRows && senseRows.length > 0) {
          pendingSenses = senseRows
          // fire-and-forget で processed=true に更新
          void supabase
            .from('sense_log')
            .update({ processed: true })
            .in('id', senseRows.map((r: { id: string }) => r.id))
        }
      } catch (err) {
        console.warn('[get_context] pending_senses fetch failed:', err)
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
            pending_senses: pendingSenses.length > 0 ? pendingSenses : undefined,
          }),
        }],
      }
    }
  )

  // ── remote_exec ────────────────────────────────────────────────────────────
  server.tool(
    'remote_exec',
    'リモートサーバーでコマンドを実行する。partner_tools.remote_hosts に登録されたホストに対して、許可リスト内のコマンドを送信する。',
    {
      host: z.string().describe('実行先のhost_id（partner_tools.remote_hostsに登録済みのもの）'),
      command: z.string().describe('実行するコマンド（ホスト側の許可リストに含まれている必要がある）'),
      timeout_ms: z.number().optional().describe('タイムアウト ms（省略時はホストのdefault_timeout_msを使用）'),
      stdin: z.string().optional().describe('標準入力として渡す文字列（省略可）'),
    },
    async (args) => {
      const result = await handleRemoteExec(store, args, fetch, userId)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ result }) }] }
    }
  )

  // ── act_* dynamic tools — MCPクライアントがcapabilityを呼ぶ (#886-①) ────────
  // 接続中Bridgeのact capabilityに対してツールを動的登録する。
  // 呼ばれたらhandleActToolに繋ぐ。Bridge不在の場合はact_queueにpending記録。
  const connectedBridgesForTools = getBridgesByUser(userId)
  if (connectedBridgesForTools.length > 0) {
    const bridgeIds = connectedBridgesForTools.map((b) => b.bridgeId)
    const { data: actCaps } = await supabase
      .from('capabilities')
      .select('id, bridge_id, name, description, config')
      .eq('user_id', userId)
      .eq('type', 'act')
      .in('bridge_id', bridgeIds)
    for (const cap of actCaps ?? []) {
      const toolName = `act_${(cap.name as string).toLowerCase().replace(/[^a-z0-9]/g, '_')}`
      const actions = (cap.config as Record<string, unknown>)?.actions as string[] | undefined
      server.tool(
        toolName,
        cap.description ?? `${cap.name} を実行する`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          action: z.string().describe(
            actions ? `実行するアクション。選択肢: ${actions.join(', ')}` : '実行するアクション'
          ),
          parameters: z.record(z.string(), z.unknown()).optional().describe('アクションパラメータ（任意）'),
          timeout_ms: z.number().optional().describe('タイムアウト ms（デフォルト 5000）'),
        },
        async (args) => {
          // Bridge接続確認: 不在ならact_queueにpendingで記録
          const bridge = getBridgeById(cap.bridge_id as string)
          if (!bridge) {
            // act_queueにpending登録
            const queueId = crypto.randomUUID()
            await supabase.from('act_queue').insert({
              id: queueId,
              being_id: beingId,
              user_id: userId,
              capability_id: cap.id,
              bridge_id: cap.bridge_id,
              action_type: args.action,
              action_payload: args.parameters ?? {},
              status: 'pending',
            })
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  queue_id: queueId,
                  status: 'pending',
                  message: 'Bridge is not connected. Action queued for later execution.',
                }),
              }],
            }
          }

          // Bridge接続中 → handleActToolに委譲
          const result = await handleActTool(supabase, userId, {
            capability_id: cap.id as string,
            bridge_id: cap.bridge_id as string,
            action: args.action,
            parameters: args.parameters ?? {},
            timeout_ms: args.timeout_ms,
          })
          return { content: [{ type: 'text' as const, text: result }] }
        }
      )
    }
  }

  return server
}

