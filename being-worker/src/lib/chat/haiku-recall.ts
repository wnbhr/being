/**
 * haiku-recall.ts — #32 Haikuフロント連想パイプライン
 *
 * spec-31 (#598): Haikuキーワードマッチ → cosine類似度ベクトル検索に置き換え。
 * 1. ユーザーメッセージを OpenAI text-embedding-3-small でembedding
 * 2. findSimilarClusters() で類似クラスタを取得
 * 3. ヒットクラスタのノードを取得し reactivation_count をインクリメント
 * 4. <memory-recall> タグで返す（常駐ノードはget_context snapshotに移動）
 *
 * #62: MemoryStore interface 経由に移行
 */

import type { MemoryStore } from '../memory/types.js'
import type { LLMProvider } from '../llm/types.js'
import { embedText } from '../memory/embedding.js'
import { sceneToText } from './scene-utils.js'

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface HaikuRecallResult {
  /** <memory-recall>...</memory-recall> タグで包まれた文字列。ヒットなしなら空文字 */
  content: string
}

// ──────────────────────────────────────────────
// ベクトル検索によるrecall
// ──────────────────────────────────────────────

async function runVectorRecall(store: MemoryStore, userMessage: string): Promise<string> {
  // 1. ユーザーメッセージを embed
  const queryVector = await embedText(userMessage)

  // 2. 類似クラスタを検索
  const matches = await store.findSimilarClusters(queryVector)
  if (matches.length === 0) return ''

  // 3. 各クラスタのノードを取得し、reactivation_count をインクリメント
  const parts: string[] = []

  for (const match of matches) {
    const cluster = await store.getCluster(match.id)
    if (!cluster) continue

    const nodes = await store.getNodes({
      clusterId: match.id,
      status: 'active',
      orderBy: 'importance',
      orderDirection: 'desc',
      limit: 3,
    })

    if (nodes.length > 0) {
      await store.incrementReactivationCounts(nodes.map((n) => n.id)).catch((err) => {
        console.warn('[haiku-recall] incrementReactivationCounts failed (ignored):', err)
      })
    }

    const digestLine = cluster.digest ? `${cluster.digest}` : ''
    const nodeLines = nodes
      .map((n) => `- ${sceneToText(n.scene, n.feeling)}`)
      .join('\n')

    const section = [
      `[${cluster.name}]${digestLine ? ` ${digestLine}` : ''}`,
      nodeLines,
    ]
      .filter(Boolean)
      .join('\n')

    if (section) parts.push(section)
  }

  return parts.join('\n\n')
}

// ──────────────────────────────────────────────
// メインエクスポート
// ──────────────────────────────────────────────

/**
 * haikuFrontRecall — ベクトル検索で記憶を検索し、2-Bブロック用コンテンツを返す
 *
 * @param store  MemoryStore インスタンス
 * @param userMessage  今ターンのユーザーメッセージ
 * @param _llm  未使用（後方互換のため残す）
 * @param _model  未使用（後方互換のため残す）
 */
export async function haikuFrontRecall(
  store: MemoryStore,
  userMessage: string,
  _llm?: LLMProvider,
  _model?: string,
): Promise<HaikuRecallResult> {
  try {
    const vectorRecallText = await runVectorRecall(store, userMessage).catch((err) => {
      console.warn('[haiku-recall] vector recall failed (ignored):', err)
      return ''
    })

    if (!vectorRecallText) {
      return { content: '' }
    }

    return {
      content: `<memory-recall>\n${vectorRecallText}\n</memory-recall>`,
    }
  } catch {
    return { content: '' }
  }
}
