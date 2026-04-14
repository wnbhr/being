/**
 * search-history.ts — #142 日付検索ツール
 *
 * パートナーが過去の会話を日付・キーワードで検索できるツール。
 * chat_messages の created_at でフィルタリング。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClientAny = ReturnType<typeof import('@supabase/supabase-js').createClient<any>>

import { truncateToolResult } from './tool-result-utils.js'

// ──────────────────────────────────────────────
// ツール定義
// ──────────────────────────────────────────────

export const SEARCH_HISTORY_TOOL = {
  name: 'search_history',
  description:
    '過去の会話履歴をキーワードや日付で検索する。「あの時〜って話したよね」「先週話した件」などの検索に使う。',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '検索キーワード（部分一致）。省略可',
      },
      date_from: {
        type: 'string',
        description: '検索開始日（YYYY-MM-DD形式）。省略可',
      },
      date_to: {
        type: 'string',
        description: '検索終了日（YYYY-MM-DD形式）。省略可',
      },
      limit: {
        type: 'number',
        description: '返す件数（デフォルト10、最大50）',
      },
    },
    required: [],
  },
} as const

// ──────────────────────────────────────────────
// ハンドラ
// ──────────────────────────────────────────────

export interface SearchHistoryInput {
  query?: string
  date_from?: string
  date_to?: string
  limit?: number
}

export async function handleSearchHistory(
  supabase: SupabaseClientAny,
  userId: string,
  input: SearchHistoryInput,
  sessionId?: string | null,
): Promise<string> {
  const limit = Math.min(input.limit ?? 10, 50)

  let q = supabase
    .from('chat_messages')
    .select('id, role, content, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  // #410: 現セッション限定フィルタ（sessionIdが指定された場合）
  if (sessionId) {
    q = q.eq('session_id', sessionId)
  }

  // キーワード検索（contentにilike）
  if (input.query && input.query.trim().length > 0) {
    q = q.ilike('content', `%${input.query.trim()}%`)
  }

  // 日付フィルタ（date_from: その日の0:00以降）
  if (input.date_from) {
    q = q.gte('created_at', `${input.date_from}T00:00:00.000Z`)
  }

  // 日付フィルタ（date_to: その日の23:59:59まで）
  if (input.date_to) {
    q = q.lte('created_at', `${input.date_to}T23:59:59.999Z`)
  }

  const { data, error } = await q

  if (error) {
    return `検索に失敗しました: ${error.message}`
  }

  const rows = data ?? []

  if (rows.length === 0) {
    return '条件に一致するメッセージが見つかりませんでした。'
  }

  const results = rows.map((row) => {
    const date = new Date(row.created_at).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    const roleLabel = row.role === 'user' ? 'ユーザー' : 'パートナー'
    const snippet = (row.content as string).length > 100
      ? (row.content as string).slice(0, 100) + '…'
      : row.content
    return `[${date}] ${roleLabel}: ${snippet}`
  })

  const full = `検索結果（${rows.length}件）:\n\n${results.join('\n\n')}`
  return truncateToolResult(full, 4000)
}
