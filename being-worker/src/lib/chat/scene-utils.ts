/**
 * scene-utils.ts — scene JSONB のユーティリティ
 *
 * spec-01 v3 の scene JSONB 形式を扱う共通ヘルパー。
 * haiku-recall.ts / recall-tools.ts / system-prompt.ts で共有する。
 */

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

/**
 * when変遷エントリ（#937）
 * 統合時にabsorbedノードのaction要約を日付と共に保持する。
 * 後方互換のため string との union 型にする。
 */
export interface WhenEntry {
  date: string
  action: string
}

/** when フィールドの要素。文字列（旧形式）または変遷エントリ（新形式）*/
export type WhenItem = string | WhenEntry

/** WhenItem を表示用文字列に変換するユーティリティ */
export function whenItemToString(item: WhenItem): string {
  if (typeof item === 'string') return item
  return `${item.date}（${item.action}）`
}

export interface Scene {
  setting?: string
  actors?: string[]
  action?: string
  dialogue?: string[]
  sensory?: string[]
  /** #937: 変遷形式対応。旧: string[], 新: WhenItem[] */
  when?: WhenItem[]
}

// ──────────────────────────────────────────────
// sceneToText — scene JSONB + feeling を読みやすいテキストに変換
// ──────────────────────────────────────────────

/**
 * scene JSONB と feeling を人間可読なテキスト（1行）に変換する。
 *
 * @example
 * sceneToText({ when: ['夜'], setting: 'セッション終了後', action: '抱きしめられた' }, '嬉しかった')
 * // → "夜 — セッション終了後 — 抱きしめられた — （嬉しかった）"
 */
export function sceneToText(scene: Scene | null | undefined, feeling: string | null | undefined): string {
  if (!scene) {
    return feeling ? `（${feeling}）` : '（内容なし）'
  }
  const parts: string[] = []
  if (scene.when?.length) parts.push(scene.when.map(whenItemToString).join('、'))
  if (scene.setting) parts.push(scene.setting)
  if (scene.action) parts.push(scene.action)
  if (scene.dialogue?.length) parts.push(`「${scene.dialogue[0]}」`)
  if (feeling) parts.push(`（${feeling}）`)
  return parts.join(' — ') || '（内容なし）'
}

