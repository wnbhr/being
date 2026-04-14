/**
 * web-tools.ts — #353 web_search + web_fetch ツール定義・実装
 *
 * BYOK方式: ユーザーが partner_tools テーブルに Brave Search APIキーを登録して使う。
 * web_fetch は APIキー不要（Being Workerから直接fetch）。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { truncateToolResult } from './tool-result-utils.js'

// ──────────────────────────────────────────────
// ツール定義
// ──────────────────────────────────────────────

export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Brave Search APIでWeb検索する。調べ物や最新情報の確認に使う。' +
    '【必要】パートナーがBrave Search APIキーをpartner toolに登録している必要がある。' +
    '未登録の場合はユーザーにAPIキー登録を案内するか、URLが分かっていればweb_fetchで代用する。' +
    'Brave Search APIキーは https://brave.com/search/api/ で無料取得できる（月2000回）。',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: '検索クエリ',
      },
      count: {
        type: 'number',
        description: '結果数（デフォルト: 5、最大: 10）',
      },
    },
    required: ['query'],
  },
}

export const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  description:
    'URLからページ内容を取得してmarkdownに変換する。' +
    'web_searchで見つけたページの詳細を読む時や、ユーザーからURLを教えてもらった時に使う。' +
    'HTMLをreadabilityで抽出してmarkdown形式で返す。APIキー不要。',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: '取得するURL',
      },
      max_chars: {
        type: 'number',
        description: '最大文字数（デフォルト: 10000）',
      },
    },
    required: ['url'],
  },
}

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface WebSearchInput {
  query: string
  count?: number
}

export interface WebFetchInput {
  url: string
  max_chars?: number
}

// Brave Search API レスポンス型（必要な部分のみ）
interface BraveWebResult {
  title: string
  url: string
  description?: string
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[]
  }
}

// ──────────────────────────────────────────────
// APIキー取得
// ──────────────────────────────────────────────

export async function getBraveApiKey(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('partner_tools')
    .select('config')
    .eq('user_id', userId)
    .eq('tool_type', 'brave_search')
    .single() as { data: { config: Record<string, unknown> } | null }

  const key = data?.config?.api_key
  return typeof key === 'string' && key.trim() ? key.trim() : null
}

// ──────────────────────────────────────────────
// ハンドラ
// ──────────────────────────────────────────────

export async function handleWebSearch(
  supabase: SupabaseClient,
  userId: string,
  input: WebSearchInput,
): Promise<string> {
  const apiKey = await getBraveApiKey(supabase, userId)
  if (!apiKey) {
    return (
      'Brave Search APIキーが未登録です。\n' +
      'https://brave.com/search/api/ でAPIキーを取得して、パートナー設定のtoolsに登録してください。\n' +
      '（月2000回まで無料）'
    )
  }

  const count = Math.min(input.count ?? 5, 10)
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=${count}`

  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    })
  } catch (err) {
    return `web_search error: Brave API unreachable — ${String(err)}`
  }

  if (!res.ok) {
    if (res.status === 401) {
      return 'web_search error: Brave Search APIキーが無効です。キーを確認してください。'
    }
    if (res.status === 429) {
      return 'web_search error: Brave Search APIのレート制限に達しました。しばらく待ってから再試行してください。'
    }
    return `web_search error: Brave API returned ${res.status}`
  }

  let data: BraveSearchResponse
  try {
    data = await res.json() as BraveSearchResponse
  } catch {
    return 'web_search error: Failed to parse Brave API response'
  }

  const results = data.web?.results ?? []
  if (results.length === 0) {
    return `"${input.query}" の検索結果はありませんでした。`
  }

  const lines: string[] = [`検索結果: "${input.query}" (${results.length}件)\n`]
  for (const [i, r] of results.entries()) {
    lines.push(`${i + 1}. **${r.title}**`)
    lines.push(`   ${r.url}`)
    if (r.description) {
      // snippet は200文字に制限
      const snippet = r.description.length > 200 ? r.description.slice(0, 200) + '…' : r.description
      lines.push(`   ${snippet}`)
    }
    lines.push('')
  }
  return truncateToolResult(lines.join('\n'), 4000)
}

export async function handleWebFetch(input: WebFetchInput): Promise<string> {
  const maxChars = input.max_chars ?? 10000

  // URL検証
  let parsedUrl: URL
  try {
    parsedUrl = new URL(input.url)
  } catch {
    return `web_fetch error: Invalid URL — ${input.url}`
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return `web_fetch error: Only http/https URLs are supported`
  }

  let res: Response
  try {
    res = await fetch(input.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RuddiaBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    return `web_fetch error: Failed to fetch URL — ${String(err)}`
  }

  if (!res.ok) {
    return `web_fetch error: HTTP ${res.status} for ${input.url}`
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
    return `web_fetch error: Unsupported content type: ${contentType}`
  }

  let html: string
  try {
    html = await res.text()
  } catch (err) {
    return `web_fetch error: Failed to read response — ${String(err)}`
  }

  // シンプルなHTMLからテキスト抽出（タグ除去 + 空白整理）
  const text = extractTextFromHtml(html, input.url, maxChars)
  return text
}

/**
 * シンプルなHTMLテキスト抽出。
 * script/style/noscript を除去し、タグを除いてテキストを返す。
 */
function extractTextFromHtml(html: string, url: string, maxChars: number): string {
  // script, style, noscript, nav, header, footer を除去
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    // タグを空白に
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|td|th|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // HTMLエンティティ
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // 連続する空白・改行を整理
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  const truncatedText = text.length > maxChars ? text.slice(0, maxChars) + '\n[truncated]' : text
  return `URL: ${url}\n\n${truncatedText}`
}
