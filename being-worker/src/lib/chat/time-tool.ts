/**
 * time-tool.ts — get_current_time ツール定義
 *
 * JSTの現在日時をツール経由でエージェントに提供する。
 * 日付は毎回変わるためシステムプロンプト(1-A)には注入せず、
 * ツール呼び出し時に動的に返す。
 */

// ──────────────────────────────────────────────
// ツール定義（Anthropic tools配列に渡す）
// ──────────────────────────────────────────────

export const GET_CURRENT_TIME_TOOL = {
  name: 'get_current_time',
  description: '現在の日付と時刻をJSTで返す。例: "2026-04-04 12:30:00 JST (Saturday)"',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
} as const

// ──────────────────────────────────────────────
// ハンドラ
// ──────────────────────────────────────────────

/**
 * JSTの現在日時を文字列で返す。
 * 例: "2026-04-04 12:30:00 JST (Saturday)"
 */
export function handleGetCurrentTime(): string {
  const now = new Date()
  const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const dayName = days[jstDate.getUTCDay()]

  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyy = jstDate.getUTCFullYear()
  const mm = pad(jstDate.getUTCMonth() + 1)
  const dd = pad(jstDate.getUTCDate())
  const hh = pad(jstDate.getUTCHours())
  const min = pad(jstDate.getUTCMinutes())
  const ss = pad(jstDate.getUTCSeconds())

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} JST (${dayName})`
}
