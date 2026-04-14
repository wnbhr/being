/**
 * capability-tools.ts — spec-37 動的capabilityツール定義
 *
 * capabilitiesテーブルからアクティブなcapabilityを取得し、
 * Anthropic tool形式に変換する。
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// Anthropic tool定義の型
export interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** 内部管理用: capabilityのID */
  _capability_id?: string
  /** 内部管理用: BridgeのID */
  _bridge_id?: string
}

interface CapabilityRow {
  id: string
  bridge_id: string
  type: 'sense' | 'act'
  name: string
  description: string | null
  config: {
    actions?: string[]
    data_type?: string
    input_schema?: Record<string, unknown>
    [key: string]: unknown
  }
  bridges?: {
    name: string
  } | null
}

/**
 * capabilityをAnthropicのtool定義に変換
 */
function capabilityToTool(cap: CapabilityRow): AnthropicTool {
  const bridgeName = cap.bridges?.name ?? 'Unknown Bridge'
  const actions = Array.isArray(cap.config?.actions) ? (cap.config.actions as string[]) : []

  // actタイプはactions列挙、senseタイプは引数なし（またはdata_type指定）
  let inputSchema: AnthropicTool['input_schema']

  if (cap.type === 'act' && actions.length > 0) {
    inputSchema = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: `実行するアクション。選択肢: ${actions.join(', ')}`,
        },
        parameters: {
          type: 'object',
          description: '追加パラメータ（アクションに応じて変わる）',
          additionalProperties: true,
        },
      },
      required: ['action'],
    }
  } else if (cap.config?.input_schema) {
    // 登録時にinput_schemaが指定されている場合はそれを使う
    inputSchema = cap.config.input_schema as AnthropicTool['input_schema']
  } else {
    // senseタイプ（引数なし）
    inputSchema = {
      type: 'object',
      properties: {},
    }
  }

  // ツール名はsnake_caseに変換（Anthropicはアルファベット・数字・_のみ許可）
  const toolName = `cap_${cap.id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`

  return {
    name: toolName,
    description: [
      cap.description ?? cap.name,
      `（${bridgeName} / ${cap.type === 'act' ? '行動' : '知覚'}）`,
    ].join(' '),
    input_schema: inputSchema,
    _capability_id: cap.id,
    _bridge_id: cap.bridge_id,
  }
}

/**
 * getActiveCapabilityTools — アクティブなcapabilityをツール定義として取得
 *
 * オンライン中のBridgeのcapabilityのみ返す。
 */
export async function getActiveCapabilityTools(
  supabase: SupabaseClient,
  userId: string
): Promise<AnthropicTool[]> {
  try {
    const { data: capabilities, error } = await supabase
      .from('capabilities')
      .select(
        `
        id,
        bridge_id,
        type,
        name,
        description,
        config,
        bridges!inner ( name, status )
      `
      )
      .eq('user_id', userId)
      .eq('bridges.status', 'online')

    if (error || !capabilities) {
      console.error('[capability-tools] fetch error:', error)
      return []
    }

    return (capabilities as unknown as CapabilityRow[]).map(capabilityToTool)
  } catch (err) {
    console.error('[capability-tools] unexpected error:', err)
    return []
  }
}

/**
 * buildCapabilityContextSection — system prompt用のcapability情報テキスト生成
 *
 * パートナーがどのようなcapabilityを使えるかを説明するテキストブロック。
 */
export function buildCapabilityContextSection(tools: AnthropicTool[]): string {
  if (tools.length === 0) return ''

  const actTools = tools.filter((t) => !t._capability_id?.startsWith('sense_'))
  const senseTools = tools.filter((t) => t._capability_id?.startsWith('sense_'))

  const lines = [
    '## 接続中のBridgeとcapability',
    '',
    '現在、外部デバイスと接続しています。以下のツールを使って世界と対話できます。',
    '',
  ]

  if (actTools.length > 0) {
    lines.push('### 行動（Act）')
    for (const tool of actTools) {
      lines.push(`- **${tool.name}**: ${tool.description}`)
    }
    lines.push('')
  }

  if (senseTools.length > 0) {
    lines.push('### 知覚（Sense）')
    for (const tool of senseTools) {
      lines.push(`- **${tool.name}**: ${tool.description}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
