/**
 * tools.ts — Being MCP Server ツール定義（8ツール）
 *
 * 各ツールは Being API REST エンドポイントの薄いラッパー。
 * inputSchema は Being Worker 側の Anthropic ツール定義と一致させる。
 *
 * #567
 */

import { BeingApiClient } from './api-client.js'

const client = new BeingApiClient()

export type ToolDef = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export const tools: ToolDef[] = [
  // ── recall_memory ───────────────────────────────────────────
  {
    name: 'recall_memory',
    description: '指定したクラスタの記憶ダイジェストとノードを取得する。特定のクラスタを深掘りしたい時に使う。',
    inputSchema: {
      type: 'object',
      properties: {
        cluster_id: { type: 'string', description: 'クラスタID（UUID）' },
        limit: { type: 'number', description: '返すノード数（デフォルト5）' },
        query: { type: 'string', description: 'ノード絞り込み用キーワード（省略可）' },
        no_nodes: { type: 'boolean', description: 'trueでdigestのみ返す' },
      },
      required: ['cluster_id'],
    },
    handler: async (args) => client.request('POST', '/memory/recall', args),
  },

  // ── merge_nodes ─────────────────────────────────────────────
  {
    name: 'merge_nodes',
    description: '複数の類似した記憶ノードを1つに統合する。重複・類似ノードを整理する時に使う。',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: { type: 'string', description: '統合するノードID（カンマ区切り）' },
        summary: { type: 'string', description: '統合後のaction文字列' },
        feeling: { type: 'string', description: '統合後のfeeling（省略可）' },
      },
      required: ['node_ids', 'summary'],
    },
    handler: async (args) => client.request('POST', '/memory/merge', args),
  },

  // ── update_memory ───────────────────────────────────────────
  {
    name: 'update_memory',
    description: 'パートナーの記憶（preferences, knowledge, relationship, diary, notes等）を読み書きする。',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '更新対象（preferences / knowledge / relationship / partner_tools / partner_map / diary / notes / partner_rules / souls）',
        },
        action: {
          type: 'string',
          description: '操作種別（get / append / update / delete）',
        },
        content: { type: 'string', description: '追記・更新する内容（get/delete時は省略可）' },
        key: { type: 'string', description: 'update/delete/getで対象を絞る場合のキー' },
      },
      required: ['target', 'action'],
    },
    handler: async (args) => client.request('POST', '/memory/update', args),
  },

  // ── conclude_topic ──────────────────────────────────────────
  {
    name: 'conclude_topic',
    description: '現在のトピックが一段落した際に呼び出す。会話をアーカイブし、要約をピン留めコンテキストとして保存する。',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'トピックの要約（1〜3文）' },
        scenes: {
          type: 'array',
          // Worker側（conclude-tool.ts）の定義に合わせて string[] のまま維持
          // ConcludeTopicInput.scenes: string[] — 各要素は短い文字列
          description: 'このトピックで生まれた印象的なシーン・記憶の断片（任意）。各要素は短い文字列。',
          items: { type: 'string' },
        },
      },
      required: ['summary'],
    },
    handler: async (args) => client.request('POST', '/memory/conclude', args),
  },

  // ── search_history ──────────────────────────────────────────
  {
    name: 'search_history',
    description: '過去の会話履歴をキーワードや日付で検索する。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索キーワード（部分一致）' },
        date_from: { type: 'string', description: '検索開始日（YYYY-MM-DD）' },
        date_to: { type: 'string', description: '検索終了日（YYYY-MM-DD）' },
        limit: { type: 'number', description: '返す件数（デフォルト10、最大50）' },
        session_id: { type: 'string', description: 'セッションID絞り込み（省略可）' },
      },
      required: ['query'],
    },
    handler: async (args) => client.request('POST', '/memory/search-history', args),
  },

  // ── update_relation ─────────────────────────────────────────
  {
    name: 'update_relation',
    description: 'Being の関係性（relations テーブル）を更新する。人・デバイス・AIなど外部エンティティとの関係を記録・削除できる。',
    inputSchema: {
      type: 'object',
      properties: {
        entity_name: { type: 'string', description: '関係先エンティティの名前または識別子' },
        relation_type: { type: 'string', description: 'エンティティの種別（person / device / ai / organization）' },
        content: { type: 'string', description: '関係性の説明・詳細（upsert時必須）' },
        action: { type: 'string', description: '操作種別（upsert / delete）' },
      },
      required: ['entity_name', 'relation_type', 'action'],
    },
    handler: async (args) => client.request('POST', '/relationships/update', args),
  },

  // ── get_current_time ────────────────────────────────────────
  {
    name: 'get_current_time',
    description: '現在時刻を取得する（JST）。Being API 呼び出し不要のローカル実装。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => ({
      time: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      iso: new Date().toISOString(),
      timezone: 'Asia/Tokyo',
    }),
  },

  // ── trigger_patrol ──────────────────────────────────────────
  {
    name: 'trigger_patrol',
    description: '巡回を実行する。marker 以降の会話から scene を抽出し、記憶ノードを生成する。LLM_API_KEY 環境変数が必要。',
    inputSchema: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          description: 'marker 以降の会話メッセージ配列（{role, content}[]）',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' },
            },
          },
        },
        marker_id: { type: 'string', description: '前回の巡回マーカーID（初回は省略）' },
      },
      required: ['messages'],
    },
    handler: async (args) => client.request('POST', '/patrol/trigger', args, true),
  },
]
