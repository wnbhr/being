/**
 * embedding.ts — OpenAI text-embedding-3-small ラッパー
 *
 * spec-31: クラスタベクトル計算に使用。
 * openaiパッケージは使用せず、fetch直叩き。
 * APIキー: process.env.OPENAI_API_KEY
 * エラー時: ログ出力 + throw
 */

const OPENAI_EMBEDDING_URL = 'https://api.openai.com/v1/embeddings'
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EXPECTED_DIM = 256

// ──────────────────────────────────────────────
// 単一テキスト embed
// ──────────────────────────────────────────────

/**
 * テキスト1件を256次元ベクトルにembedする。
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('[embedding] OPENAI_API_KEY is not set')

  const response = await fetch(OPENAI_EMBEDDING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EXPECTED_DIM }),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error('[embedding] OpenAI API error:', response.status, err)
    throw new Error(`[embedding] OpenAI API error: ${response.status}`)
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
  const embedding = data.data[0]?.embedding
  if (!embedding || embedding.length !== EXPECTED_DIM) {
    throw new Error(`[embedding] Unexpected dimensions: ${embedding?.length}`)
  }
  return embedding
}

// ──────────────────────────────────────────────
// 複数テキスト一括 embed
// ──────────────────────────────────────────────

/**
 * テキスト複数件を一括embeddingする。
 * OpenAI APIはinputに配列を渡せるので1リクエストで処理。
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('[embedding] OPENAI_API_KEY is not set')

  const response = await fetch(OPENAI_EMBEDDING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, dimensions: EXPECTED_DIM }),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error('[embedding] OpenAI API error:', response.status, err)
    throw new Error(`[embedding] OpenAI API error: ${response.status}`)
  }

  const data = (await response.json()) as {
    data: Array<{ index: number; embedding: number[] }>
  }
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}

// ──────────────────────────────────────────────
// ベクトル平均
// ──────────────────────────────────────────────

/**
 * 複数ベクトルの次元ごと平均を返す。
 */
export function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) throw new Error('[embedding] Cannot average empty vectors')
  const dim = vectors[0].length
  const sum = new Array<number>(dim).fill(0)
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] += vec[i]
    }
  }
  return sum.map((v) => v / vectors.length)
}

// ──────────────────────────────────────────────
// クラスタベクトル再計算ヘルパー
// ──────────────────────────────────────────────

import type { MemoryStore } from './types.js'

/**
 * クラスタ内全activeノードのaction textをembedし、平均ベクトルでクラスタを更新する。
 * OPENAI_API_KEY がない、またはノードが0件の場合はスキップ（warningのみ）。
 */
export async function recomputeClusterVector(
  store: MemoryStore,
  clusterId: string
): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[embedding] OPENAI_API_KEY not set — skipping cluster vector update')
    return
  }

  const nodes = await store.getNodes({ clusterId, status: 'active' })
  const actions = nodes
    .map((n) => n.scene?.action)
    .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)

  if (actions.length === 0) return

  const vectors = await embedTexts(actions)
  const avg = averageVectors(vectors)
  await store.updateClusterVector(clusterId, avg)
}
