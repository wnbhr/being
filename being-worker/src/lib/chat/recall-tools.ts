/**
 * recall-tools.ts — #33 recall_memory / merge_nodes パートナーツール
 *
 * spec-01 v3変更点:
 *   - memory_clusters → clusters
 *   - memory_nodes.content → scene JSONB + feeling TEXT
 *   - memory_nodes.cluster_ids[] → cluster_id UUID（単一FK）
 *
 * #62: MemoryStore interface 経由に移行
 */

import type { MemoryStore } from '../memory/types.js'
import { sceneToText, type Scene } from './scene-utils.js'
import { truncateToolResult } from './tool-result-utils.js'
import { recomputeClusterVector } from '../memory/embedding.js'

// ──────────────────────────────────────────────
// ツール定義（Anthropic Function Calling形式）
// ──────────────────────────────────────────────

export const RECALL_MEMORY_TOOL = {
  name: 'recall_memory',
  description:
    '指定したクラスタの記憶ダイジェストとノードを取得する。通常の会話ではHaikuフロントで自動注入されるが、特定のクラスタまたはノードを深掘りしたい時に使う。',
  input_schema: {
    type: 'object',
    properties: {
      cluster_id: { type: 'string', description: 'クラスタID（UUID）' },
      node_id: { type: 'string', description: 'ノードID（UUID）。指定するとそのノードの詳細を返す（cluster_id不要）' },
      limit: { type: 'number', description: '返すノード数（デフォルト5）' },
      query: { type: 'string', description: 'ノード絞り込み用キーワード（action/dialogueにilike検索、省略可）' },
      no_nodes: { type: 'boolean', description: 'trueでdigestのみ返す' },
    },
    required: [],
  },
} as const

export const MERGE_NODES_TOOL = {
  name: 'merge_nodes',
  description:
    '複数の類似した記憶ノードを1つに統合する。パートナーが文脈を見て重複・類似ノードを整理する時に使う。',
  input_schema: {
    type: 'object',
    properties: {
      node_ids: { type: 'string', description: '統合するノードID（カンマ区切り）' },
      summary: { type: 'string', description: '統合後のaction文字列（scene.actionに設定）' },
      feeling: { type: 'string', description: '統合後のfeeling（省略可）' },
    },
    required: ['node_ids', 'summary'],
  },
} as const


// ──────────────────────────────────────────────
// recall_memory ハンドラ
// ──────────────────────────────────────────────

export async function handleRecallMemory(
  store: MemoryStore,
  input: { cluster_id?: string; node_id?: string; limit?: number; query?: string; no_nodes?: boolean }
): Promise<string> {
  // node_id 指定時: そのノードの詳細を返す
  if (input.node_id) {
    const nodes = await store.getNodesByIds([input.node_id])
    if (nodes.length === 0) return `ノード ${input.node_id} は見つかりませんでした`
    const n = nodes[0]
    const lines = [
      `ID: ${n.id}`,
      `クラスタID: ${n.cluster_id ?? '（なし）'}`,
      `action: ${n.scene?.action ?? '（なし）'}`,
      `feeling: ${n.feeling ?? '（なし）'}`,
      `themes: ${n.themes?.join(', ') ?? '（なし）'}`,
      `importance: ${n.importance ?? '（なし）'}`,
      `status: ${n.status ?? '（なし）'}`,
      `reactivation_count: ${n.reactivation_count ?? 0}`,
    ]
    await store.incrementReactivationCounts([n.id]).catch(() => {})
    return lines.join('\n')
  }

  if (!input.cluster_id) {
    return 'クラスタIDまたはノードIDを指定してください。'
  }

  // 1. クラスタを取得
  const cluster = await store.getCluster(input.cluster_id)

  if (!cluster) {
    return `クラスタ ${input.cluster_id} は見つかりませんでした`
  }

  const digestLine = `ダイジェスト: ${cluster.digest ?? '（なし）'}`

  // 2. no_nodes: true の場合はdigestのみ
  if (input.no_nodes) {
    return `[クラスタ: ${cluster.name}]\n${digestLine}`
  }

  // 3. memory_nodes から取得
  const limit = input.limit ?? 5

  const nodes = await store.getNodes({
    clusterId: input.cluster_id,
    orderBy: 'importance',
    orderDirection: 'desc',
    secondaryOrderBy: 'last_activated',
    secondaryOrderDirection: 'desc',
    limit,
    actionQuery: input.query,
  })

  if (nodes.length === 0) {
    return `[クラスタ: ${cluster.name}]\n${digestLine}\n\nノード: （なし）`
  }

  // ❺ reactivation: 明示的に読まれたノードは減衰を緩和する
  // dead: +2（次回patrol で reviveDeadNodes RPC が eff_imp > 0.05 なら active 復帰）
  // active: +1（「思い出した」ことでカウント。記憶モデルの一貫性のため）
  const deadNodes = nodes.filter((n) => n.status === 'dead')
  if (deadNodes.length > 0) {
    const deadIds = deadNodes.map((n) => n.id)
    await store.incrementReactivationCountsBy(deadIds, 2).catch(() => {})
  }
  const activeNodes = nodes.filter((n) => n.status === 'active')
  if (activeNodes.length > 0) {
    const activeIds = activeNodes.map((n) => n.id)
    await store.incrementReactivationCounts(activeIds).catch(() => {})
  }

  const nodeLines = nodes
    .map((n) => `- ${sceneToText(n.scene, n.feeling)}${n.importance != null ? ` [重要度: ${n.importance}]` : ""}`)
    .join('\n')

  const full = `[クラスタ: ${cluster.name}]\n${digestLine}\n\nノード:\n${nodeLines}`
  return truncateToolResult(full, 4000)
}

// ──────────────────────────────────────────────
// merge_nodes ハンドラ
// ──────────────────────────────────────────────

export async function handleMergeNodes(
  store: MemoryStore,
  input: { node_ids: string; summary: string; feeling?: string }
): Promise<string> {
  // 1. node_ids をカンマで分割してUUID配列に変換
  const ids = input.node_ids
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (ids.length === 0) {
    return 'node_ids が空です。'
  }

  // 2. 元ノードを取得
  const nodes = await store.getNodesByIds(ids)

  if (nodes.length === 0) {
    return '指定されたノードが見つかりませんでした。'
  }

  // 3. cluster_id: 最初のノードのcluster_idを引き継ぐ
  //    themes: 全ノードのthemesをマージ（重複除去）
  const mergedClusterId = nodes[0].cluster_id ?? null
  const mergedThemesSet = new Set<string>()
  for (const node of nodes) {
    for (const t of node.themes ?? []) {
      mergedThemesSet.add(t)
    }
  }
  const mergedThemes = Array.from(mergedThemesSet)

  // 4. importance の最大値を計算
  const validImportances = nodes
    .map((n) => n.importance)
    .filter((v): v is number => v !== null)
  const maxImportance =
    validImportances.length > 0
      ? Math.max(...validImportances)
      : 0.5

  // 5. 新しいノードをINSERT
  const newScene = {
    setting: '',
    actors: [] as string[],
    action: input.summary,
    dialogue: [] as string[],
    sensory: [] as string[],
    when: [] as string[],
  }

  const newIds = await store.saveNodes([{
    scene: newScene,
    feeling: input.feeling ?? null,
    importance: maxImportance,
    cluster_id: mergedClusterId,
    themes: mergedThemes,
    needs_feeling: false,
    fresh: false,
    pinned: false,
    reactivation_count: 0,
    last_activated: new Date().toISOString(),
  }])

  // 6. 元ノードをDELETE
  await store.deleteNodes(ids)

  // 7. クラスタベクトルを再計算
  if (mergedClusterId) {
    recomputeClusterVector(store, mergedClusterId).catch((err) => {
      console.warn('[merge_nodes] recomputeClusterVector failed (ignored):', err)
    })
  }

  const newId = newIds[0] ?? '(unknown)'
  return `${nodes.length}件のノードを統合しました。新ノードID: ${newId}`
}
