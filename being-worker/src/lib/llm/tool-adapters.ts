/**
 * tool-adapters.ts — マルチプロバイダ ツール変換アダプター
 *
 * Anthropicフォーマットのツール定義をOpenAI/Google形式に変換する。
 * ツール実行ロジック（handleToolBlock）は共通のまま維持する。
 */

// Anthropicフォーマット（single source of truth）
export interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  [key: string]: unknown
}

// OpenAI用変換
export function toOpenAITools(tools: AnthropicTool[]): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
}

// Google用変換（functionDeclarationsを1要素配列にまとめる）
export function toGoogleTools(tools: AnthropicTool[]): Array<{
  functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}> {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
  }]
}

// OpenAI: ツール結果メッセージ
export function toOpenAIToolResultMessage(
  toolCallId: string,
  content: string,
): { role: 'tool'; tool_call_id: string; content: string } {
  return { role: 'tool', tool_call_id: toolCallId, content }
}

// Google: ツール結果パーツ
export function toGoogleToolResultPart(
  name: string,
  result: string,
): { functionResponse: { name: string; response: { result: string } } } {
  return { functionResponse: { name, response: { result } } }
}
