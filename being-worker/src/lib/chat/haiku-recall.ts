/**
 * haiku-recall.ts — #32 Haikuフロント連想パイプライン（断片モード）
 *
 * spec-31 (#598): Haikuキーワードマッチ → cosine類似度ベクトル検索に置き換え。
 * 1. ユーザーメッセージを OpenAI text-embedding-3-small でembedding
 * 2. findSimilarClusters() で類似クラスタを取得
 * 3. ヒットクラスタのノードを取得し reactivation_count をインクリメント
 * 4. 断片モード: action/feeling をシャッフルして混ぜた <memory-recall> タグで返す
 *    ノード境界をぼかすことで、人間の記憶想起に近い「ごちゃごちゃ」した形式にする
 *
 * #62: MemoryStore interface 経由に移行
 */

import type { MemoryStore } from '../memory/types.js'
import type { LLMProvider } from '../llm/types.js'
import { embedText } from '../memory/embedding.js'
import type { Scene } from './scene-utils.js'

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface HaikuRecallResult {
  /** <memory-recall>...</memory-recall> タグで包まれた文字列。ヒットなしなら空文字 */
  content: string
}

// ──────────────────────────────────────────────
// 断片シャッフル
// ──────────────────────────────────────────────

/**
 * 複数ノードの action / feeling をばらして混ぜ、
 * ノード境界を消した断片テキストを返す。
 * 人間の記憶想起に近い「ごちゃごちゃ」した形式。
 *
 * @internal Exported for unit testing.
 */
export function toFragments(nodes: Array<{ scene: Scene | null; feeling?: string | null }>): string {
  const pieces: string[] = []

  for (const n of nodes) {
    if (n.scene?.action) pieces.push(n.scene.action)
    if (n.feeling) pieces.push(n.feeling)
  }

  if (pieces.length === 0) return ''

  // Fisher-Yates シャッフル
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pieces[i], pieces[j]] = [pieces[j], pieces[i]]
  }

  return pieces.join(' / ')
}

// ──────────────────────────────────────────────
// ベクトル検索によるrecall
// ──────────────────────────────────────────────

async function runVectorRecall(store: MemoryStore, userMessage: string): Promise<string> {
  // 1. ユーザーメッセージを embed
  const queryVector = await embedText(userMessage)

  // 2. issue-946: findSimilarNodes でノードを直接取得（top-3）
  const matches = await store.findSimilarNodes(queryVector, 3)
  if (matches.length === 0) return ''

  // 3. ノードの実データを取得し、reactivation_count をインクリメント
  const nodeIds = matches.map((m) => m.id)
  const nodes = await store.getNodesByIds(nodeIds)

  if (nodes.length > 0) {
    await store.incrementReactivationCounts(nodes.map((n) => n.id)).catch((err) => {
      console.warn('[haiku-recall] incrementReactivationCounts failed (ignored):', err)
    })
  }

  if (nodes.length === 0) return ''

  // 4. 断片モード: 全ノードの action/feeling をシャッフルして混ぜる
  return toFragments(nodes)
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
