/**
 * scene-utils.ts — scene JSONB のユーティリティ
 *
 * spec-01 v3 の scene JSONB 形式を扱う共通ヘルパー。
 * haiku-recall.ts / recall-tools.ts / system-prompt.ts で共有する。
 */

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface Scene {
  setting?: string
  actors?: string[]
  action?: string
  dialogue?: string[]
  sensory?: string[]
  when?: string[]
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
  if (scene.when?.length) parts.push(scene.when.join('、'))
  if (scene.setting) parts.push(scene.setting)
  if (scene.action) parts.push(scene.action)
  if (scene.dialogue?.length) parts.push(`「${scene.dialogue[0]}」`)
  if (feeling) parts.push(`（${feeling}）`)
  return parts.join(' — ') || '（内容なし）'
}
