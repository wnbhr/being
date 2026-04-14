/**
 * being-tool-loop.ts — ツールループエンドポイント
 *
 * POST /v1/beings/:being_id/tool-loop
 *
 * リクエスト:
 *   { prompt: string, max_turns?: number, timeout_ms?: number }
 *
 * 処理:
 *   1. being_extensions で tool-loop 拡張が有効かチェック
 *   2. 拡張の config.llm_api_key_encrypted から LLM キー取得（復号）
 *   3. サンドボックス拡張が有効なら EXEC_TOOL 等を追加
 *   4. LLM → ツール → LLM のループ実行（非ストリーミング）
 *   5. 結果を JSON で返す
 *
 * #652
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { FastifyPluginAsync } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { decrypt } from '../lib/utils/encryption.js'
import {
  EXEC_TOOL, WRITE_TOOL, READ_TOOL, EDIT_TOOL, LIST_TOOL,
  formatExecResult, formatWriteResult, formatReadResult, formatEditResult, formatListResult,
  type ExecResult, type WriteResult, type ReadResult, type EditResult, type ListResult,
} from '../lib/chat/sandbox-tool.js'
import { WEB_SEARCH_TOOL, WEB_FETCH_TOOL, handleWebSearch, handleWebFetch, type WebSearchInput, type WebFetchInput } from '../lib/chat/web-tools.js'
import { GET_CURRENT_TIME_TOOL, handleGetCurrentTime } from '../lib/chat/time-tool.js'
import { PROVIDER_MODELS } from '../lib/llm/types.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

async function verifyBeing(beingId: string, userId: string) {
  const { data } = await supabase
    .from('beings')
    .select('id, name')
    .eq('id', beingId)
    .eq('owner_id', userId)
    .single() as { data: { id: string; name: string } | null }
  return data
}

async function getInstalledExtension(beingId: string, slug: string) {
  const { data } = await supabase
    .from('being_extensions')
    .select('id, is_active, config, extensions!inner(slug)')
    .eq('being_id', beingId)
    .eq('extensions.slug', slug)
    .maybeSingle() as {
      data: { id: string; is_active: boolean; config: Record<string, unknown> } | null
    }
  return data
}

// ── Anthropic non-streaming 型定義 ──────────────────────────────────────────

interface AnthropicTextBlock {
  type: 'text'
  text: string
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock

interface AnthropicResponse {
  content: AnthropicContentBlock[]
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  messages: unknown[],
  tools: unknown[],
  signal: AbortSignal,
): Promise<AnthropicResponse> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal,
    body: JSON.stringify({ model, max_tokens: 8096, system, tools, messages }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic API error ${res.status}: ${body}`)
  }
  return await res.json() as AnthropicResponse
}

export const beingToolLoopRoute: FastifyPluginAsync = async (app) => {
  app.post<{
    Params: { being_id: string }
    Body: { prompt: string; max_turns?: number; timeout_ms?: number }
  }>(
    '/v1/beings/:being_id/tool-loop',
    async (request, reply) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId: string = (request as any).beingUserId
      const { being_id } = request.params
      const { prompt, max_turns = 20, timeout_ms = 300_000 } = request.body

      if (!prompt) return reply.code(400).send({ error: 'prompt is required' })

      // 1. Being オーナー確認
      const being = await verifyBeing(being_id, userId)
      if (!being) return reply.code(404).send({ error: 'Being not found' })

      // 2. tool-loop 拡張が有効かチェック
      const toolLoopExt = await getInstalledExtension(being_id, 'tool-loop')
      if (!toolLoopExt?.is_active) {
        return reply.code(403).send({ error: 'tool-loop extension is not enabled' })
      }

      // 3. LLM APIキー取得（拡張 config から復号）
      const extConfig = toolLoopExt.config as Record<string, string>
      const llmApiKeyEncrypted = extConfig?.llm_api_key_encrypted
      if (!llmApiKeyEncrypted) {
        return reply.code(422).send({ error: 'LLM API key not configured in tool-loop extension. Set llm_api_key via /config endpoint.' })
      }

      let apiKey: string
      try {
        apiKey = decrypt(llmApiKeyEncrypted)
      } catch {
        return reply.code(500).send({ error: 'Failed to decrypt LLM API key' })
      }

      // 4. サンドボックス拡張が有効かチェック
      const sandboxExt = await getInstalledExtension(being_id, 'sandbox')
      const sandboxEnabled = !!(sandboxExt?.is_active)

      // 5. GitHub 設定取得（サンドボックスツール用）
      let githubRepoUrl: string | null = null
      let githubToken: string | null = null
      if (sandboxEnabled) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('github_repo_url, github_token_encrypted')
          .eq('id', userId)
          .single() as {
            data: { github_repo_url: string | null; github_token_encrypted: string | null } | null
          }
        githubRepoUrl = profile?.github_repo_url ?? null
        if (profile?.github_token_encrypted) {
          try { githubToken = decrypt(profile.github_token_encrypted) } catch { githubToken = null }
        }
      }

      // 6. ツール定義構築
      const activeTools = [
        GET_CURRENT_TIME_TOOL,
        WEB_SEARCH_TOOL,
        WEB_FETCH_TOOL,
        ...(sandboxEnabled ? [EXEC_TOOL, WRITE_TOOL, READ_TOOL, EDIT_TOOL, LIST_TOOL] : []),
      ]

      // 7. シンプルなシステムプロンプト
      const systemPrompt = [
        `あなたは Being「${being.name}」として動作しています。`,
        'ユーザーの指示に従い、必要なツールを自律的に使用してタスクを完了してください。',
        '各ツールを適切に活用し、段階的に問題を解決してください。',
        '作業が完了したら最終結果をまとめて返してください。',
      ].join('\n')

      // 8. タイムアウト付き AbortController
      const abortCtrl = new AbortController()
      const timer = setTimeout(() => abortCtrl.abort(), timeout_ms)

      const model = process.env.ANTHROPIC_MODEL ?? PROVIDER_MODELS.anthropic[0]
      const defaultBranch = `tool-loop/auto-${Date.now().toString(36)}`
      const messages: unknown[] = [{ role: 'user', content: prompt }]

      let finalText = ''
      let turnCount = 0
      const toolCallLogs: Array<{ tool: string; input: unknown; result: string }> = []

      try {
        while (turnCount < max_turns) {
          if (abortCtrl.signal.aborted) break
          turnCount++

          let response: AnthropicResponse
          try {
            response = await callAnthropic(apiKey, model, systemPrompt, messages, activeTools, abortCtrl.signal)
          } catch (err) {
            return reply.code(502).send({ error: `LLM call failed: ${String(err)}` })
          }

          // テキストブロックを収集
          for (const block of response.content) {
            if (block.type === 'text') finalText += block.text
          }

          // ツール呼び出しなし → ループ終了
          if (response.stop_reason !== 'tool_use') break

          const toolUseBlocks = response.content.filter(
            (b): b is AnthropicToolUseBlock => b.type === 'tool_use'
          )
          if (toolUseBlocks.length === 0) break

          // アシスタントターンをメッセージ履歴に追加
          messages.push({ role: 'assistant', content: response.content })

          // ── ツール実行 ──────────────────────────────────────────────────
          const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = []

          for (const block of toolUseBlocks) {
            const toolName = block.name
            const toolInput = block.input
            let result = ''

            if (toolName === 'get_current_time') {
              result = handleGetCurrentTime()

            } else if (toolName === 'web_search') {
              result = await handleWebSearch(supabase, userId, toolInput as unknown as WebSearchInput)

            } else if (toolName === 'web_fetch') {
              result = await handleWebFetch(toolInput as unknown as WebFetchInput)

            } else if (toolName === 'exec' && sandboxEnabled && config.sandboxApiUrl && config.sandboxApiSecret && githubRepoUrl && githubToken) {
              try {
                const execInput = toolInput as { command: string; timeout?: number; branch?: string }
                const cmdTimeout = Math.min(execInput.timeout ?? 60, 300)
                const res = await fetch(`${config.sandboxApiUrl}/exec`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                  body: JSON.stringify({
                    user_id: userId, command: execInput.command, timeout: cmdTimeout,
                    github_repo: githubRepoUrl, github_token: githubToken,
                    branch: execInput.branch || defaultBranch,
                  }),
                  signal: AbortSignal.timeout((cmdTimeout + 30) * 1000),
                })
                result = res.ok
                  ? formatExecResult(await res.json() as ExecResult)
                  : `error: Sandbox API returned ${res.status}`
              } catch (err) { result = `error: ${String(err)}` }

            } else if (toolName === 'write_file' && sandboxEnabled && config.sandboxApiUrl && config.sandboxApiSecret && githubRepoUrl && githubToken) {
              try {
                const writeInput = toolInput as { path: string; content: string; branch?: string }
                const res = await fetch(`${config.sandboxApiUrl}/write`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                  body: JSON.stringify({
                    user_id: userId, path: writeInput.path, content: writeInput.content,
                    github_repo: githubRepoUrl, github_token: githubToken,
                    branch: writeInput.branch || defaultBranch,
                  }),
                })
                result = res.ok
                  ? formatWriteResult(await res.json() as WriteResult)
                  : `error: Sandbox API returned ${res.status}`
              } catch (err) { result = `error: ${String(err)}` }

            } else if (toolName === 'read_file' && sandboxEnabled && config.sandboxApiUrl && config.sandboxApiSecret && githubRepoUrl && githubToken) {
              try {
                const readInput = toolInput as { path: string; offset?: number; limit?: number }
                const res = await fetch(`${config.sandboxApiUrl}/read`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                  body: JSON.stringify({
                    user_id: userId, path: readInput.path,
                    github_repo: githubRepoUrl, github_token: githubToken,
                    ...(readInput.offset !== undefined ? { offset: readInput.offset } : {}),
                    ...(readInput.limit !== undefined ? { limit: readInput.limit } : {}),
                  }),
                })
                result = res.ok
                  ? formatReadResult(await res.json() as ReadResult)
                  : `error: Sandbox API returned ${res.status}`
              } catch (err) { result = `error: ${String(err)}` }

            } else if (toolName === 'edit_file' && sandboxEnabled && config.sandboxApiUrl && config.sandboxApiSecret && githubRepoUrl && githubToken) {
              try {
                const editInput = toolInput as { path: string; edits: Array<{ oldText: string; newText: string }>; branch?: string }
                const res = await fetch(`${config.sandboxApiUrl}/edit`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                  body: JSON.stringify({
                    user_id: userId, path: editInput.path, edits: editInput.edits,
                    github_repo: githubRepoUrl, github_token: githubToken,
                    branch: editInput.branch || defaultBranch,
                  }),
                })
                result = res.ok
                  ? formatEditResult(await res.json() as EditResult)
                  : `error: ${await res.text().catch(() => `Sandbox API returned ${res.status}`)}`
              } catch (err) { result = `error: ${String(err)}` }

            } else if (toolName === 'list_files' && sandboxEnabled && config.sandboxApiUrl && config.sandboxApiSecret && githubRepoUrl && githubToken) {
              try {
                const listInput = toolInput as { path?: string; depth?: number }
                const res = await fetch(`${config.sandboxApiUrl}/list`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                  body: JSON.stringify({
                    user_id: userId, path: listInput.path ?? '.', depth: listInput.depth ?? 3,
                    github_repo: githubRepoUrl, github_token: githubToken,
                  }),
                })
                result = res.ok
                  ? formatListResult(await res.json() as ListResult)
                  : `error: Sandbox API returned ${res.status}`
              } catch (err) { result = `error: ${String(err)}` }

            } else {
              result = `error: Tool "${toolName}" is not available`
            }

            console.log(JSON.stringify({ event: 'tool_loop_tool_call', being_id, tool: toolName }))
            toolCallLogs.push({ tool: toolName, input: toolInput, result })
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
          }

          // ツール結果をメッセージ履歴に追加してループ継続
          messages.push({ role: 'user', content: toolResults })
        }
      } finally {
        clearTimeout(timer)
      }

      return reply.send({
        result: finalText,
        turns: turnCount,
        tool_calls: toolCallLogs,
      })
    }
  )
}
