/**
 * tool-result-utils.ts — #521 tool_result レスポンス最小化ユーティリティ
 *
 * LLMに返すtool_resultを高シグナル化するためのヘルパー関数。
 * Anthropicのベストプラクティス: "tool_resultはhigh-signal情報のみ返す"
 */

/**
 * tool_result 全体を最大文字数にtruncateする。
 * 超えた場合は末尾に truncation マーカーを追加。
 */
export function truncateToolResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const totalChars = text.length
  return text.slice(0, maxChars) + `\n[truncated: showing first ${maxChars} chars of ${totalChars} total]`
}

/**
 * exec の stdout/stderr 向け: 末尾N文字を残してtruncateする。
 * 長い出力は末尾の方が重要なことが多いため、先頭を切り捨てる。
 */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const totalChars = text.length
  const kept = text.slice(-maxChars)
  return `[truncated: showing last ${maxChars} chars of ${totalChars} total]\n...\n${kept}`
}
