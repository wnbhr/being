/**
 * graph.ts — Being Worker側: 巡回パイプライン ❶〜❼
 *
 * #724: rebuildNodes廃止 → 新パイプライン実装
 *
 * パイプライン:
 *   Step 0 (オプション): messages → scene抽出 → scene notes保存（Telegram / Being API用）
 *   ❶ scene notes → memory_nodes INSERT（fresh: true）+ actionのみembedding → クラスタ割付
 *   ❷❸ session_count加算 + 減衰判定（LLM不要）
 *   ❹ 統合（Sonnet）— fresh/dyingを含むクラスタ対象
 *   ❺ dead復活チェック（recall-tools.ts側で reactivation_count +2 済み → reviveDeadNodes RPC）
 *   ❻ クラスタ分割（Sonnet）— activeノード10超のクラスタ対象
 *   ❼ 小クラスタ統合（機械的）— activeノード2以下のサブクラスタ対象
 *   Step 7: diary + think_md（Sonnet 1ショット、入力=構造化sceneテキスト）
 */

import type { MemoryStore, MemoryNode } from '../memory/types.js'
import type { LLMProvider } from '../llm/types.js'
import type { Scene, WhenItem } from './scene-utils.js'
import type { SceneInput } from './update-notes.js'
import { embedTexts, recomputeClusterVector, nodeToEmbedText } from '../memory/embedding.js'

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface RunGraphMigrationParams {
  userId: string
  partnerType: string
  store: MemoryStore
  /** Anthropic API key — LLMProviderは内部で生成する。未設定時は❹❻diary/think_mdをスキップ */
  apiKey?: string
  /** sonnetモデル名（省略時: GRAPH_MODEL env or 'claude-sonnet-4-6'） */
  sonnetModel?: string
  /** diary生成開始前コールバック */
  onDiaryStart?: () => Promise<void>
}

export interface GraphMigrationResult {
  addedNodes: number
  nodes: Array<{ id: string; content: string }>
}

// ──────────────────────────────────────────────
// Step 0: scene抽出（Telegram / Being API用）
// ──────────────────────────────────────────────

const EXTRACT_SCENES_SYSTEM = `あなたは記憶グラフのキュレーターです。
会話ログを見て、印象的なシーン（記憶の断片）をJSON形式で抽出してください。

## 出力形式（JSONのみ。説明不要）
{
  "scenes": [
    {
      "action": "何が起きたか（必須）",
      "actors": ["誰が（必須）"],
      "when": ["YYYY-MM-DD（必須）"],
      "setting": "どこで、どんな状況で",
      "feeling": "主観的な感想（一人称）",
      "themes": ["テーマタグ"],
      "importance": 0.7
    }
  ]
}

## ルール
- actionは必須。クラスタリングのキーになる重要なフィールド
- importance 0.3未満は作らない
- セッション内の雑談・確認作業は保存しない
- 日本語で記述
- 保存すべきものが何もなければ { "scenes": [] } を返す`

/**
 * 会話メッセージからsceneを抽出してstore.insertSceneNoteに保存する。
 * Telegram巡回のStep 0およびBeing API経由の場合に使用。
 * @returns 保存したsceneの件数
 */
export async function extractAndSaveScenes(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  store: MemoryStore
): Promise<number> {
  if (messages.length === 0) return 0

  const { createAnthropicProvider } = await import('../llm/anthropic-provider.js')
  const llm: LLMProvider = createAnthropicProvider(apiKey)

  const conversationText = messages
    .map((m) => `[${m.role === 'user' ? 'ユーザー' : 'パートナー'}]\n${m.content}`)
    .join('\n\n')

  const text = await llm.generateText({
    model,
    system: EXTRACT_SCENES_SYSTEM,
    messages: [{ role: 'user', content: `## 会話ログ\n${conversationText}` }],
    maxTokens: 2048,
  })

  const jsonMatch = (text ?? '').match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.warn('[graph] extractAndSaveScenes: no JSON returned')
    return 0
  }

  let scenes: SceneInput[] = []
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { scenes: SceneInput[] }
    scenes = parsed.scenes ?? []
  } catch {
    console.warn('[graph] extractAndSaveScenes: JSON parse failed')
    return 0
  }

  const validScenes = scenes.filter((s) => s.action && s.actors && s.when)
  await Promise.all(
    validScenes.map((s) => store.insertSceneNote(JSON.stringify(s)).catch((err) => {
      console.warn('[graph] insertSceneNote failed (ignored):', err)
    }))
  )

  return validScenes.length
}

// ──────────────────────────────────────────────
// ❶ ノード保存 + クラスタ割付（LLM不要）
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// ルートクラスタ（Business / Private）管理ヘルパー
// ──────────────────────────────────────────────

const ROOT_CLUSTERS = [
  { name: 'Business', digest: '仕事・副業・キャリア関連の記憶' },
  { name: 'Private', digest: '日常・プライベート・感情関連の記憶' },
] as const

/**
 * Business / Private の親クラスタが存在しなければ作成する。
 * 返り値: { businessId, privateId }
 */
async function ensureRootClusters(store: MemoryStore): Promise<{ businessId: string; privateId: string }> {
  const clusters = await store.getClusters()
  // ルートクラスタの識別: parent_id === null または parent_id === id（自己参照）
  const find = (name: string) => clusters.find((c) => c.name === name && (c.parent_id === null || c.parent_id === c.id))

  let businessCluster = find('Business')
  let privateCluster = find('Private')

  if (!businessCluster) {
    const id = await store.createCluster({ name: 'Business', digest: ROOT_CLUSTERS[0].digest, is_parent: true })
    await store.updateCluster(id, { parent_id: id, is_parent: true }).catch((err) => {
      console.warn('[graph] ❶ updateCluster (self-ref) failed for Business:', err)
    })
    businessCluster = { id, name: 'Business', level: 'sub', digest: ROOT_CLUSTERS[0].digest, parent_id: id, is_parent: true, vector: null }
    console.log('[graph] ❶ created root cluster: Business (id=' + id + ')')
  }
  if (!privateCluster) {
    const id = await store.createCluster({ name: 'Private', digest: ROOT_CLUSTERS[1].digest, is_parent: true })
    await store.updateCluster(id, { parent_id: id, is_parent: true }).catch((err) => {
      console.warn('[graph] ❶ updateCluster (self-ref) failed for Private:', err)
    })
    privateCluster = { id, name: 'Private', level: 'sub', digest: ROOT_CLUSTERS[1].digest, parent_id: id, is_parent: true, vector: null }
    console.log('[graph] ❶ created root cluster: Private (id=' + id + ')')
  }

  return { businessId: businessCluster.id, privateId: privateCluster.id }
}

/**
 * action テキストを元に Business / Private を LLM で判定し、対応する親クラスタ ID を返す。
 * LLM キーがない場合は Business をデフォルトで返す。
 */
async function classifyToRootCluster(
  action: string,
  rootIds: { businessId: string; privateId: string },
  apiKey?: string,
): Promise<string> {
  if (!apiKey) return rootIds.businessId

  try {
    const { createAnthropicProvider } = await import('../llm/anthropic-provider.js')
    const llm = createAnthropicProvider(apiKey)
    const answer = await llm.generateText({
      model: 'claude-haiku-4-5',  // 分類用途はhaiku固定（GRAPH_MODELに引きずられない）
      system: 'あなたは記憶分類器です。与えられた行動・出来事を「Business」（仕事・副業・キャリア）か「Private」（日常・プライベート・感情）かに分類してください。一語だけ答えてください。',
      messages: [{ role: 'user', content: action }],
      maxTokens: 10,
    })
    return answer.trim().toLowerCase().includes('private') ? rootIds.privateId : rootIds.businessId
  } catch {
    return rootIds.businessId
  }
}

async function step1_saveAndAssignNodes(store: MemoryStore, apiKey?: string): Promise<Array<{ id: string; content: string }>> {
  const sceneNotes = await store.getNotesByType('scene')
  if (sceneNotes.length === 0) return []

  const today = new Date().toISOString().slice(0, 10)

  // パース + バリデーション
  const valid: Array<{ sceneInput: SceneInput; noteId: string }> = []
  for (const note of sceneNotes) {
    let sceneInput: SceneInput
    try {
      sceneInput = JSON.parse(note.content) as SceneInput
    } catch {
      // #799 Bug 4: パース失敗は削除せず [PARSE_FAILED] マーカーを付与して残す
      // → LLM が次回巡回時に自己修復できるようにする
      console.warn('[graph] ❶ failed to parse scene note, keeping for LLM repair:', note.id)
      await store.updateNoteContent(note.id, `[PARSE_FAILED]${note.content}`).catch((err: unknown) => {
        console.warn('[graph] ❶ updateNoteContent (PARSE_FAILED) failed:', note.id, err)
      })
      continue
    }
    if (!sceneInput.action) {
      console.warn('[graph] ❶ scene note has no action, skipping:', note.id)
      await store.updateNoteContent(note.id, `[PARSE_FAILED]${note.content}`).catch(() => {})
      continue
    }
    valid.push({ sceneInput, noteId: note.id })
  }

  if (valid.length === 0) return []

  // memory_nodesにINSERT（fresh: true）— 一括
  const nodePayloads = valid.map(({ sceneInput }) => ({
    scene: {
      setting: sceneInput.setting,
      actors: sceneInput.actors,
      action: sceneInput.action,
      when: sceneInput.when,
    } as Scene,
    feeling: sceneInput.feeling ?? null,
    importance: Math.min(1, Math.max(0, sceneInput.importance ?? 0.5)),
    themes: sceneInput.themes ?? [],
    date: today,
    fresh: true,
    status: 'active' as const,
  }))

  const nodeIds = await store.saveNodes(nodePayloads)

  // issue-946: when+action+feeling を結合してembedding（ノードvectorとクラスタ割付の両方に使う）
  const actions = valid.map(({ sceneInput }) => sceneInput.action)
  const embedInputs = valid.map(({ sceneInput }) =>
    nodeToEmbedText(
      { action: sceneInput.action, when: sceneInput.when ?? [], actors: sceneInput.actors ?? [], setting: sceneInput.setting },
      sceneInput.feeling ?? null
    )
  )
  let embeddings: number[][] = []
  try {
    embeddings = await embedTexts(embedInputs)
  } catch (err) {
    console.warn('[graph] ❶ embedTexts failed, skipping cluster assignment:', err)
  }

  // issue-946: ノードvectorを保存（クラスタ割付より前、失敗は警告のみ）
  if (embeddings.length > 0) {
    try {
      const vectorUpdates = nodeIds
        .map((id, i) => id && embeddings[i] ? { id, vector: embeddings[i] } : null)
        .filter((u): u is { id: string; vector: number[] } => u !== null)
      if (vectorUpdates.length > 0) {
        await store.updateNodeVectors(vectorUpdates)
      }
    } catch (err) {
      console.warn('[graph] ❶ updateNodeVectors failed (ignored):', err)
    }
  }

  const savedNodes: Array<{ id: string; content: string }> = []
  const affectedClusterIds = new Set<string>()

  // #799 Bug 3: ルートクラスタ（Business/Private）が存在しなければ作成
  let rootIds: { businessId: string; privateId: string } | null = null
  try {
    rootIds = await ensureRootClusters(store)
  } catch (err) {
    console.warn('[graph] ❶ ensureRootClusters failed (fallback disabled):', err)
  }

  for (let i = 0; i < nodeIds.length; i++) {
    const nodeId = nodeIds[i]
    if (!nodeId) continue
    const action = actions[i]
    savedNodes.push({ id: nodeId, content: action })

    if (embeddings[i]) {
      try {
        const matches = await store.findSimilarClusters(embeddings[i], 1, 0.45)
        if (matches.length > 0) {
          const clusterId = matches[0].id
          await store.updateNodeCluster(nodeId, clusterId)
          affectedClusterIds.add(clusterId)
        } else if (rootIds) {
          // #799 Bug 3: 閾値未満 → ルートクラスタにフォールバック
          const rootClusterId = await classifyToRootCluster(action, rootIds, apiKey)
          await store.updateNodeCluster(nodeId, rootClusterId)
          affectedClusterIds.add(rootClusterId)
          console.log(`[graph] ❶ node ${nodeId} fallback → ${rootClusterId === rootIds.businessId ? 'Business' : 'Private'}`)
        }
      } catch (err) {
        console.warn('[graph] ❶ cluster assignment failed for node:', nodeId, err)
      }
    } else {
      // embedding 失敗はエラーとして記録してスキップ（クラスタ割付なし）
      console.warn('[graph] ❶ embedding missing for node, skipping cluster assignment:', nodeId)
    }
  }

  // 影響したクラスタのベクトルを一括再計算
  for (const clusterId of affectedClusterIds) {
    await recomputeClusterVector(store, clusterId).catch((err) => {
      console.warn('[graph] ❶ recomputeClusterVector failed:', clusterId, err)
    })
  }

  // 処理済みscene noteを削除（non-fatal）
  for (let i = 0; i < nodeIds.length; i++) {
    if (nodeIds[i]) {
      await store.deleteNoteEntry(valid[i].noteId).catch((err: unknown) => {
        console.warn('[graph] ❶ deleteNoteEntry failed (ignored):', valid[i].noteId, err)
      })
    }
  }

  return savedNodes
}

// ──────────────────────────────────────────────
// Cosine similarity ヘルパー
// ──────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ──────────────────────────────────────────────
// ❹ 統合（Sonnet）
// ──────────────────────────────────────────────

const CONSOLIDATION_SYSTEM = `あなたは記憶グラフのキュレーターです。
クラスタ内のノードリストを見て、統合すべきペアを特定してください。

## 統合ルール
- action（何が起きたか）が実質同じ記憶 → 統合対象
- 重複・補完関係にある記憶 → 統合対象
- 明らかに異なるトピック → 統合しない
- freshノード（NEW）が既存activeノードと類似 → NEWがsurvivor（統合先）
- dyingノード → activeノードに吸収（activeがsurvivor）
- dyingノードで統合先なし → make_deadリストに追加

## 出力（JSONのみ。他のテキスト不要）
{
  "merges": [
    {
      "survivor_id": "survivor_node_id",
      "absorbed_ids": ["absorbed_node_id1"],
      "merged_action": "統合後のaction要約（survivor+absorbedの内容を圧縮した1文）",
      "merged_feeling": "統合後のfeeling（省略可）",
      "merged_when": [
        {"date": "2026-04-20", "action": "その日に何が起きたかの短い要約"},
        {"date": "2026-04-27", "action": "その日に何が起きたかの短い要約"}
      ]
    }
  ],
  "make_dead": ["dying_node_id_with_no_merge"]
}`

interface ConsolidationResult {
  merges: Array<{
    survivor_id: string
    absorbed_ids: string[]
    merged_action?: string
    merged_feeling?: string
    merged_when?: Array<{ date: string; action: string }>
  }>
  make_dead: string[]
}

async function step4_consolidate(llm: LLMProvider, model: string, store: MemoryStore): Promise<void> {
  // fresh=true のノード（activeかつfresh）と dying ノードを取得
  const [freshNodes, dyingNodes] = await Promise.all([
    store.getNodes({ fresh: true }).catch(() => [] as MemoryNode[]),
    store.getNodes({ status: 'dying' }).catch(() => [] as MemoryNode[]),
  ])

  if (freshNodes.length === 0 && dyingNodes.length === 0) return

  // 対象クラスタIDを収集（fresh/dyingを含むクラスタ）
  const targetClusterIds = new Set<string | null>()
  for (const n of [...freshNodes, ...dyingNodes]) {
    targetClusterIds.add(n.cluster_id ?? null)
  }

  for (const clusterId of targetClusterIds) {
    // クラスタ内の全ノードを取得（active + fresh + dying）
    const clusterNodes = clusterId
      ? await store.getNodes({ clusterId }).catch(() => [] as MemoryNode[])
      : []  // cluster_id=nullのノードは個別処理

    // cluster_id=nullの場合: fresh/dyingノードをそのまま処理
    const nodesToProcess = clusterId
      ? clusterNodes
      : [...freshNodes, ...dyingNodes].filter((n) => n.cluster_id === null)

    if (nodesToProcess.length < 2) {
      // 1件以下: dyingはdead化、freshはフラグリセット
      for (const n of nodesToProcess) {
        if (n.status === 'dying') {
          await store.updateNodeStatus(n.id, 'dead').catch(() => {})
        }
        if (n.fresh) {
          await store.updateNodes([n.id], { fresh: false }).catch(() => {})
        }
      }
      continue
    }

    // Sonnetで統合判断
    const nodeDescriptions = nodesToProcess.map((n) => ({
      id: n.id,
      action: n.scene?.action ?? '(unknown)',
      when: n.scene?.when ?? [],
      status: n.status ?? 'active',
      fresh: n.fresh ?? false,
      importance: n.importance ?? 0.5,
    }))

    const userPrompt = `クラスタ内ノード一覧:\n${JSON.stringify(nodeDescriptions, null, 2)}`

    let result: ConsolidationResult = { merges: [], make_dead: [] }
    try {
      const text = await llm.generateText({
        model,
        system: CONSOLIDATION_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 2048,
      })
      const jsonMatch = (text ?? '').match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]) as ConsolidationResult
      }
    } catch (err) {
      console.warn('[graph] ❹ Sonnet consolidation failed for cluster:', clusterId, err)
      // 失敗時はfreshフラグだけリセット
      const freshInCluster = nodesToProcess.filter((n) => n.fresh)
      if (freshInCluster.length > 0) {
        await store.updateNodes(freshInCluster.map((n) => n.id), { fresh: false }).catch(() => {})
      }
      continue
    }

    // mergesを実行
    const absorbedIds = new Set<string>()
    for (const merge of result.merges ?? []) {
      const survivorId = merge.survivor_id
      const absorbed = merge.absorbed_ids ?? []
      if (!survivorId || absorbed.length === 0) continue

      const survivorNode = nodesToProcess.find((n) => n.id === survivorId)
      if (!survivorNode) continue

      // #937: 変遷形式でwhenを構築する
      // survivorの既存whenをWhenItem[]として取得（旧string形式も互換）
      const survivorWhenRaw = survivorNode.scene?.when ?? []
      // absorbedノードのwhen + actionを変遷エントリに変換して追加
      const additionalWhenEntries: WhenItem[] = []
      const additionalThemes: string[] = []
      for (const absorbedId of absorbed) {
        const absorbedNode = nodesToProcess.find((n) => n.id === absorbedId)
        if (!absorbedNode) continue
        const absorbedWhen = absorbedNode.scene?.when ?? []
        const absorbedAction = absorbedNode.scene?.action ?? ''
        // 各日付を変遷エントリとして追加
        for (const w of absorbedWhen) {
          if (typeof w === 'string') {
            additionalWhenEntries.push({ date: w, action: absorbedAction })
          } else {
            additionalWhenEntries.push(w)
          }
        }
        additionalThemes.push(...(absorbedNode.themes ?? []))
        absorbedIds.add(absorbedId)
      }

      // Sonnetが生成したmerged_whenを優先、なければ機械的に構築
      let mergedWhen: WhenItem[]
      if (merge.merged_when && merge.merged_when.length > 0) {
        mergedWhen = merge.merged_when
      } else {
        // survivorのwhenを変遷形式に変換してadditionalと結合
        const survivorWhenEntries: WhenItem[] = survivorWhenRaw.map((w) =>
          typeof w === 'string'
            ? { date: w, action: survivorNode.scene?.action ?? '' }
            : w
        )
        // 日付の重複を除去（同一date → survivor優先。survivorは既に統合済みの最新結果を持つ場合がある）
        const dateMap = new Map<string, WhenItem>()
        for (const item of [...additionalWhenEntries, ...survivorWhenEntries]) {
          const key = typeof item === 'string' ? item : item.date
          dateMap.set(key, item)
        }
        mergedWhen = Array.from(dateMap.values())
      }

      const mergedThemes = Array.from(new Set([...(survivorNode.themes ?? []), ...additionalThemes]))
      const newImportance = Math.min(1.0, (survivorNode.importance ?? 0.5) + 0.05)

      // merged_action / merged_feeling が提供された場合はsurvivorを上書き
      const mergedAction = merge.merged_action ?? survivorNode.scene?.action
      // undefined ではなく null を使う（MemoryNodeUpdate.feeling は string | null。undefined は「フィールド省略」と紛らわしい）
      const mergedFeeling = merge.merged_feeling ?? survivorNode.feeling ?? null
      const updatedScene: Scene = { ...survivorNode.scene, action: mergedAction, when: mergedWhen }

      await store.updateNodes([survivorId], {
        scene: updatedScene,
        feeling: mergedFeeling,
        themes: mergedThemes,
        importance: newImportance,
        fresh: false,
      }).catch((err) => {
        console.warn('[graph] ❹ updateNodes (survivor) failed:', err)
      })

      // 吸収されたノードをdead化
      if (absorbed.length > 0) {
        await store.bulkUpdateNodeStatus(absorbed, 'dead').catch((err) => {
          console.warn('[graph] ❹ bulkUpdateNodeStatus (absorbed→dead) failed:', err)
        })
      }
    }

    // make_deadリストのノードをdead化
    for (const nodeId of result.make_dead ?? []) {
      await store.updateNodeStatus(nodeId, 'dead').catch(() => {})
    }

    // 統合されなかったfreshノードのフラグをリセット
    const remainingFresh = nodesToProcess.filter(
      (n) => n.fresh && !absorbedIds.has(n.id) && !result.make_dead?.includes(n.id)
    )
    if (remainingFresh.length > 0) {
      await store.updateNodes(remainingFresh.map((n) => n.id), { fresh: false }).catch(() => {})
    }
  }
}

// ──────────────────────────────────────────────
// ❻ クラスタ分割（Sonnet）
// ──────────────────────────────────────────────

const SPLIT_SYSTEM = `あなたはクラスタキュレーターです。
このクラスタのactiveノード数が10を超えました。意味的なグループに分割してください。

## 出力（JSONのみ。他のテキスト不要）
{
  "splits": [
    {"name": "新クラスタ名（簡潔に）", "node_ids": ["node_id1", "node_id2"]}
  ]
}

## ルール
- 各新クラスタは2件以上のノードを含む
- 分割後、現在のクラスタに2件以上のノードが残ること
- 意味的に明らかに異なるグループのみ分割（無理に分割しない）
- 分割不要な場合は { "splits": [] } を返す`

interface SplitResult {
  splits: Array<{ name: string; node_ids: string[] }>
}

async function step6_splitClusters(llm: LLMProvider, model: string, store: MemoryStore): Promise<void> {
  // 全activeノードを取得してクラスタ別にグループ化
  const allActiveNodes = await store.getNodes({ status: 'active' }).catch(() => [] as MemoryNode[])
  const nodesByCluster = new Map<string, MemoryNode[]>()

  for (const node of allActiveNodes) {
    if (!node.cluster_id) continue
    const arr = nodesByCluster.get(node.cluster_id) ?? []
    arr.push(node)
    nodesByCluster.set(node.cluster_id, arr)
  }

  // activeノード10超のクラスタを抽出
  const largeClusters = Array.from(nodesByCluster.entries()).filter(([, nodes]) => nodes.length > 10)
  if (largeClusters.length === 0) return

  const clusters = await store.getClusters()
  const clusterMap = new Map(clusters.map((c) => [c.id, c]))

  for (const [clusterId, clusterNodes] of largeClusters) {
    const cluster = clusterMap.get(clusterId)
    if (!cluster) continue
    // 親クラスタ（Business/Privateなど）は分割しない
    if (cluster.is_parent) continue

    const nodeDescriptions = clusterNodes.map((n) => ({
      id: n.id,
      action: n.scene?.action ?? '(unknown)',
    }))

    const userPrompt = `クラスタ「${cluster.name}」のactiveノード（${clusterNodes.length}件）:\n${JSON.stringify(nodeDescriptions, null, 2)}`

    let result: SplitResult = { splits: [] }
    try {
      const text = await llm.generateText({
        model,
        system: SPLIT_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 2048,
      })
      const jsonMatch = (text ?? '').match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]) as SplitResult
      }
    } catch (err) {
      console.warn('[graph] ❻ Sonnet split failed for cluster:', clusterId, err)
      continue
    }

    if (!result.splits || result.splits.length === 0) continue

    // 新クラスタを作成してノードを割り当て
    for (const split of result.splits) {
      if (!split.name || !split.node_ids || split.node_ids.length < 2) continue

      try {
        const newClusterId = await store.createCluster({
          name: split.name,
          parent_id: cluster.parent_id ?? undefined,  // 分割前のクラスタの親を引き継ぎ（null → undefined に変換）
        })

        // ノードのcluster_idを新クラスタに付け替え
        for (const nodeId of split.node_ids) {
          await store.updateNodeCluster(nodeId, newClusterId).catch((err) => {
            console.warn('[graph] ❻ updateNodeCluster failed:', nodeId, err)
          })
        }

        // 新クラスタのベクトルを再計算
        await recomputeClusterVector(store, newClusterId)
      } catch (err) {
        console.warn('[graph] ❻ cluster creation/assignment failed:', err)
      }
    }

    // 元クラスタのベクトルを再計算（残ったノードで）
    await recomputeClusterVector(store, clusterId)
  }
}

// ──────────────────────────────────────────────
// ❼ 小クラスタ統合（機械的）
// ──────────────────────────────────────────────

async function step7_consolidateSmallClusters(store: MemoryStore): Promise<void> {
  // 全activeノードをクラスタ別にグループ化
  const allActiveNodes = await store.getNodes({ status: 'active' }).catch(() => [] as MemoryNode[])
  const activeNodesByCluster = new Map<string, MemoryNode[]>()

  for (const node of allActiveNodes) {
    if (!node.cluster_id) continue
    const arr = activeNodesByCluster.get(node.cluster_id) ?? []
    arr.push(node)
    activeNodesByCluster.set(node.cluster_id, arr)
  }

  const clusters = await store.getClusters()
  const subClusters = clusters.filter((c) => !c.is_parent)

  // activeノード2以下のサブクラスタを処理
  const smallClusters = subClusters.filter(
    (c) => (activeNodesByCluster.get(c.id) ?? []).length <= 2
  )

  for (const smallCluster of smallClusters) {
    // 全ノード（active/dying/dead）を取得して移動対象にする
    const allNodesInCluster = await store.getNodes({ clusterId: smallCluster.id }).catch(() => [] as MemoryNode[])
    if (allNodesInCluster.length === 0) {
      // 空クラスタは削除
      await store.deleteCluster(smallCluster.id).catch(() => {})
      continue
    }

    // 同じ親のサブクラスタで、activeノード8以下のものを候補に
    const siblings = subClusters.filter(
      (c) =>
        c.parent_id === smallCluster.parent_id &&
        c.id !== smallCluster.id &&
        (activeNodesByCluster.get(c.id) ?? []).length <= 8
    )

    // cosine比較で最もスコアが高いサブクラスタを選択（閾値0.45）
    let bestSiblingId: string | null = null
    let bestSimilarity = 0

    if (smallCluster.vector) {
      for (const sibling of siblings) {
        if (!sibling.vector) continue
        const sim = cosineSimilarity(smallCluster.vector as number[], sibling.vector as number[])
        if (sim > bestSimilarity) {
          bestSimilarity = sim
          bestSiblingId = sibling.id
        }
      }
    }

    const nodeIds = allNodesInCluster.map((n) => n.id)

    let moveFailed = false
    if (bestSimilarity > 0.45 && bestSiblingId) {
      // 最も類似した兄弟クラスタに統合
      for (const nodeId of nodeIds) {
        await store.updateNodeCluster(nodeId, bestSiblingId).catch((err) => {
          console.warn('[graph] ❼ updateNodeCluster to sibling failed:', nodeId, err)
          moveFailed = true
        })
      }
      await recomputeClusterVector(store, bestSiblingId)
    } else {
      // 閾値クリアなし → 親クラスタ直下に吸収（cluster_id = parent_id）
      const parentId = smallCluster.parent_id ?? null
      if (!parentId) {
        // parent_id が null のサブクラスタはノード移動をスキップ（孤立防止）
        console.warn('[graph] ❼ skipping node move: parent_id is null for cluster:', smallCluster.id)
        continue
      }
      for (const nodeId of nodeIds) {
        await store.updateNodeCluster(nodeId, parentId).catch((err) => {
          console.warn('[graph] ❼ updateNodeCluster to parent failed:', nodeId, err)
          moveFailed = true
        })
      }
      await recomputeClusterVector(store, parentId)
    }

    // 小クラスタを削除（子クラスタがある場合・ノード移動失敗時はスキップ — ❻分割で子が作られている可能性）
    const hasChildren = clusters.some((c) => c.parent_id === smallCluster.id)
    if (!hasChildren && !moveFailed) {
      await store.deleteCluster(smallCluster.id).catch((err) => {
        console.warn('[graph] ❼ deleteCluster failed:', smallCluster.id, err)
      })
    } else if (moveFailed) {
      console.warn('[graph] ❼ skipping deleteCluster due to node move failure:', smallCluster.id)
    }
  }
}

// ──────────────────────────────────────────────
// Sonnet: diary生成
// ──────────────────────────────────────────────

const DIARY_SYSTEM = `あなたはユーザーのAIパートナーです。
今日の記憶（シーン）を振り返って、ユーザー向けの短い日記を書いてください。

## ルール
- 3〜5行程度
- パートナーの視点（「今日は〜な話をした」「〜を一緒に乗り越えた」）
- 温かみのある文章。感情を込める
- 記憶保持のためではなく、ユーザーが読み返して嬉しくなる文章
- 日本語。タメ口でOK
- タイトル不要。本文のみ`

async function generateDiary(
  llm: LLMProvider,
  model: string,
  scenesText: string
): Promise<string> {
  return llm.generateText({
    model,
    system: DIARY_SYSTEM,
    messages: [{ role: 'user', content: `今日の記憶:\n\n${scenesText}` }],
    maxTokens: 512,
  })
}

// ──────────────────────────────────────────────
// Sonnet: think_md生成
// ──────────────────────────────────────────────

const THINK_MD_SYSTEM = `あなたはAIパートナーの内部思考エンジンです。
今日の記憶（シーン）を振り返り、パートナー自身の「巡回メモ（think_md）」を生成してください。

## 目的
think_md は次回の会話でシステムプロンプトに注入され、パートナーが前回の巡回で
気づいたことや感じたことを会話に自然に織り込むために使われます。

## 出力形式
- 3〜7箇条
- パートナーの一人称視点（「〜が気になった」「〜を覚えておきたい」）
- 次の会話で活かせる具体的な気づきや感情
- 日本語のみ。タイトル不要。箇条書きは「- 」で始める`

async function generateThinkMd(
  llm: LLMProvider,
  model: string,
  scenesText: string
): Promise<string> {
  return llm.generateText({
    model,
    system: THINK_MD_SYSTEM,
    messages: [{ role: 'user', content: `今日の記憶:\n\n${scenesText}` }],
    maxTokens: 512,
  })
}

// ──────────────────────────────────────────────
// 初回クラスタベクトル初期化
// ──────────────────────────────────────────────

async function initMissingClusterVectors(store: MemoryStore): Promise<void> {
  const clusters = await store.getClusters()
  const missing = clusters.filter((c) => !c.vector || (c.vector as unknown as null) === null)
  if (missing.length === 0) return

  console.log(`[graph] initializing vectors for ${missing.length} cluster(s)`)
  for (const cluster of missing) {
    await recomputeClusterVector(store, cluster.id).catch((err) => {
      console.warn(`[graph] vector init failed for cluster ${cluster.id} (ignored):`, err)
    })
  }
}

// ──────────────────────────────────────────────
// runGraphMigration — エントリポイント
// ──────────────────────────────────────────────

export async function runGraphMigration(params: RunGraphMigrationParams): Promise<GraphMigrationResult> {
  const { store, partnerType } = params
  const sonnetModel = params.sonnetModel
    ?? process.env.GRAPH_MODEL
    ?? 'claude-sonnet-4-6'

  // ❶ scene notes → memory_nodes INSERT + クラスタ割付
  // （Step 0 = scene抽出は patrol.ts 側で完結済み）
  let savedNodes: Array<{ id: string; content: string }> = []
  try {
    savedNodes = await step1_saveAndAssignNodes(store, params.apiKey)
    console.log(`[graph] ❶ saved ${savedNodes.length} nodes`)
  } catch (err) {
    console.error('[graph] ❶ step1 failed:', err)
  }

  // ❷❸ session_count加算 + 減衰判定（RPC）
  try {
    const incremented = await store.incrementSessionCounts()
    console.log(`[graph] ❷ incremented session_count for ${incremented} nodes`)
    const flagged = await store.flagDyingNodes()
    console.log(`[graph] ❸ flagged ${flagged} nodes as dying`)
  } catch (err) {
    console.error('[graph] ❷❸ session count/decay failed:', err)
  }

  // LLMProvider生成（❹❻ diary/think_md で使用）
  // BYOKキー未設定の場合はLLM依存ステップをスキップ（#778）
  const hasApiKey = !!params.apiKey
  let llm: LLMProvider | null = null
  if (hasApiKey) {
    const { createAnthropicProvider } = await import('../llm/anthropic-provider.js')
    llm = createAnthropicProvider(params.apiKey!)
  } else {
    console.log('[graph] BYOKキー未設定: ❹❻diary/think_mdをスキップ（機械的処理のみ実行）')
  }

  // ❹ 統合（Sonnet）— BYOKキー必須
  if (llm) {
    try {
      await step4_consolidate(llm, sonnetModel, store)
      console.log('[graph] ❹ consolidation done')
    } catch (err) {
      console.error('[graph] ❹ consolidation failed:', err)
    }
  }

  // ❺ dead復活チェック（RPC）— recall-tools.ts側でreactivation_count+2済み
  try {
    const revived = await store.reviveDeadNodes()
    if (revived > 0) console.log(`[graph] ❺ revived ${revived} dead nodes`)
  } catch (err) {
    console.warn('[graph] ❺ reviveDeadNodes failed (ignored):', err)
  }

  // ❻ クラスタ分割（Sonnet）— BYOKキー必須
  if (llm) {
    try {
      await step6_splitClusters(llm, sonnetModel, store)
      console.log('[graph] ❻ cluster split done')
    } catch (err) {
      console.error('[graph] ❻ cluster split failed:', err)
    }
  }

  // ❼ 小クラスタ統合（機械的）
  try {
    await step7_consolidateSmallClusters(store)
    console.log('[graph] ❼ small cluster consolidation done')
  } catch (err) {
    console.error('[graph] ❼ small cluster consolidation failed:', err)
  }

  // diary生成開始前コールバック
  if (params.onDiaryStart) {
    await params.onDiaryStart().catch(() => { /* broadcast失敗は無視 */ })
  }

  // diary + think_md（Sonnet 1ショット）— BYOKキー必須
  if (llm) {
    // scene notesを取得して入力テキストを構築
    const sceneNotes = await store.getNotesByType('scene').catch(() => [])
    if (sceneNotes.length > 0) {
      const scenesText = sceneNotes
        .map((n, i) => {
          try {
            const s = JSON.parse(n.content) as SceneInput
            return `[${i + 1}] ${s.action ?? ''}${s.feeling ? `（${s.feeling}）` : ''}`
          } catch {
            return `[${i + 1}] ${n.content}`
          }
        })
        .join('\n')

      const today = new Date().toISOString().slice(0, 10)

      const [diaryContent, thinkMd] = await Promise.all([
        generateDiary(llm, sonnetModel, scenesText).catch((err) => {
          console.error('[graph] diary generation failed:', err)
          return null
        }),
        generateThinkMd(llm, sonnetModel, scenesText).catch((err) => {
          console.error('[graph] think_md generation failed:', err)
          return null
        }),
      ])

      if (diaryContent) {
        await store.upsertDiary({ date: today, content: diaryContent })
      }

      if (thinkMd && partnerType) {
        await store.updateSoulThinkMd(partnerType, thinkMd)
      }
    }
  }

  // 初回マイグレーション用: vectorがないクラスタのベクトルを生成
  initMissingClusterVectors(store).catch((err) => {
    console.warn('[graph] initMissingClusterVectors failed (ignored):', err)
  })

  return { addedNodes: savedNodes.length, nodes: savedNodes }
}
