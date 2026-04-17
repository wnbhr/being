import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import { createSupabaseMemoryStore } from '../lib/memory/supabase-store.js'
import { buildSystemPrompt, buildBlock1B, type ContentBlock } from '../lib/chat/system-prompt.js'
// #434: compaction削除済み (spec-33: update_notesで2-B→2-A移行、毎ターンcompactionは廃止)
interface ToolCallRecord { toolName: string; toolInput: string; toolResult: string }
import { UPDATE_MEMORY_TOOL, handleUpdateMemory, type UpdateMemoryInput } from '../lib/chat/update-memory.js'
import { RECALL_MEMORY_TOOL, MERGE_NODES_TOOL, handleRecallMemory, handleMergeNodes } from '../lib/chat/recall-tools.js'
import { EXEC_TOOL, WRITE_TOOL, READ_TOOL, EDIT_TOOL, LIST_TOOL, formatExecResult, formatWriteResult, formatReadResult, formatEditResult, formatListResult, type ExecResult, type WriteResult, type ReadResult, type EditResult, type ListResult } from '../lib/chat/sandbox-tool.js'
import { WEB_SEARCH_TOOL, WEB_FETCH_TOOL, handleWebSearch, handleWebFetch, type WebSearchInput, type WebFetchInput } from '../lib/chat/web-tools.js'
import { SEARCH_HISTORY_TOOL, handleSearchHistory, type SearchHistoryInput } from '../lib/chat/search-history.js'
import { GET_CURRENT_TIME_TOOL, handleGetCurrentTime } from '../lib/chat/time-tool.js'
import { UPDATE_NOTES_TOOL, handleUpdateNotes, type UpdateNotesInput } from '../lib/chat/update-notes.js'
import { handleActTool, type ActToolInput } from '../lib/chat/act-tool.js'
import { UPDATE_RELATION_TOOL, handleUpdateRelation, type UpdateRelationInput } from '../lib/chat/update-relation.js'
import { getApiKey, getApiKeyFromTable } from '../lib/chat/api-key.js'
import { createAnthropicProvider } from '../lib/llm/anthropic-provider.js'
import { createOpenAIProvider } from '../lib/llm/openai-provider.js'
import { createGoogleProvider } from '../lib/llm/google-provider.js'
import { createOpenAIStream, adaptOpenAIStream, createGoogleStream, adaptGoogleStream } from '../lib/llm/stream-adapters.js'
import { toOpenAITools, toGoogleTools } from '../lib/llm/tool-adapters.js'
import { PROVIDER_MODELS, INTERNAL_MODELS, type ProviderType, type ImageAttachment } from '../lib/llm/types.js'
import { broadcastChunk, broadcastDone, broadcastError, broadcastToolUse } from './broadcast.js'
import { sendWebPushToUser } from './web-push.js'

// #267: Web Push通知ヘルパー（重複コード抽出）
function notifyUser(userId: string, soulName: string | undefined, text: string) {
  sendWebPushToUser(userId, {
    title: soulName ?? 'Cove',
    body: text ? text.slice(0, 80) + (text.length > 80 ? '…' : '') : '新しいメッセージがあります',
    url: '/chat',
  }).catch(() => {})
}
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
  type ToolCallHistory,
} from '../lib/chat/tool-loop-detection.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

// #390: ジョブ管理マップ（jobId → {userId, abort, startTime}）
// activeJobs/jobStartTime を廃止し、activeJobMap に統合
export const activeJobMap = new Map<string, { userId: string; abort: AbortController; startTime: number }>()

export function cancelJob(jobId: string, requestingUserId: string): boolean {
  const entry = activeJobMap.get(jobId)
  if (!entry) return false
  if (entry.userId !== requestingUserId) return false
  entry.abort.abort()
  return true
}

export function getActiveJobId(userId: string): string | null {
  for (const [jobId, entry] of activeJobMap) {
    if (entry.userId === userId) return jobId
  }
  return null
}

export interface JobRequest {
  user_id: string
  message_id: string
  content: string
  partner_type: string
  provider: ProviderType
  sandbox_enabled: boolean
  github_repo_url?: string
  github_token_encrypted?: string
  /** converse mode: Being ID */
  being_id?: string
  /** #418: ジョブ発行元が指定するsession_id（Being APIの場合はBeing専用セッション） */
  current_session_id?: string | null
  /** #474: 添付画像リスト */
  images?: ImageAttachment[]
  /** #492: New Session 挨拶ジョブフラグ。trueの場合はLLM呼び出し前にsnapshot再構築を行う */
  is_greeting?: boolean
  /** #505: ウォーミングジョブフラグ。trueの場合はmax_tokens:1、Web Push通知なし、chat_messagesにis_warm=trueで保存 */
  is_warm?: boolean
}

interface AnthropicSseEvent {
  eventName: string
  data: string
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
}

interface ToolUseBlock {
  id: string
  name: string
  inputJson: string
}

interface ToolUseResult {
  toolUseId: string
  result: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildActiveTools(sandboxEnabled: boolean, capabilityTools: unknown[], beingId?: string): any[] {
  return [
    UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL, MERGE_NODES_TOOL,
    SEARCH_HISTORY_TOOL, GET_CURRENT_TIME_TOOL, UPDATE_NOTES_TOOL,
    WEB_SEARCH_TOOL, WEB_FETCH_TOOL,
    ...(sandboxEnabled ? [EXEC_TOOL, WRITE_TOOL, READ_TOOL, EDIT_TOOL, LIST_TOOL] : []),
    ...capabilityTools,
    ...(beingId ? [UPDATE_RELATION_TOOL] : []),
  ]
}

function calculateCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * 3 + outputTokens * 15) / 1_000_000
}

function getDefaultModel(provider: ProviderType): string {
  switch (provider) {
    case 'anthropic': return process.env.ANTHROPIC_MODEL ?? PROVIDER_MODELS.anthropic[0]
    case 'openai': return process.env.OPENAI_MODEL ?? PROVIDER_MODELS.openai[0]
    case 'google': return process.env.GOOGLE_MODEL ?? PROVIDER_MODELS.google[0]
  }
}

function* parseSseLines(lines: string[]): Generator<AnthropicSseEvent> {
  let eventName = ''
  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      const data = line.slice(5).trim()
      if (eventName) {
        yield { eventName, data }
        eventName = ''
      }
    }
  }
}

const JOB_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes (failsafe; per-step timeouts handle hangs)


// #474: Supabase StorageからBase64取得
async function fetchImageAsBase64(storagePath: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const { data, error } = await supabase.storage
      .from('chat-attachments')
      .download(storagePath)
    if (error || !data) return null
    const arrayBuffer = await data.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    return { base64, mimeType: data.type || 'image/jpeg' }
  } catch { return null }
}

export async function processJob(jobId: string, job: JobRequest): Promise<void> {
  const cancelController = new AbortController()
  const jobStart = Date.now()
  activeJobMap.set(jobId, { userId: job.user_id, abort: cancelController, startTime: jobStart })
  console.log(JSON.stringify({ event: 'job_start', jobId, userId: job.user_id, provider: job.provider, partner: job.partner_type }))
  try {
    await Promise.race([
      _processJob(jobId, job, cancelController.signal),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`[job ${jobId}] timed out after ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS)
      }),
    ])
  } catch (err) {
    const durationMs = Date.now() - jobStart
    const isCancelled = cancelController.signal.aborted
      && err instanceof DOMException && err.name === 'AbortError'
    const isTimeout = err instanceof Error && err.message.includes('timed out after')

    if (isCancelled) {
      console.log(JSON.stringify({ event: 'job_cancelled', jobId, durationMs }))
      await broadcastDone(job.user_id)
      await supabase.from('chat_messages').insert({
        user_id: job.user_id, role: 'assistant',
        content: 'Response stopped.',
        session_id: null,
        partner_type: job.partner_type, // #428
      }).then(undefined, () => {})
    } else {
      console.error(`[job ${jobId}] fatal:`, err)
      console.log(JSON.stringify({ event: 'job_error', jobId, error: String(err), durationMs }))
      const userMessage = isTimeout
        ? 'Response timed out. Please try again.'
        : 'An error occurred. Please try again.'
      await broadcastError(job.user_id, userMessage).catch(() => {})
      await supabase.from('chat_messages').insert({
        user_id: job.user_id,
        role: 'assistant',
        content: userMessage,
        session_id: null, // #410: fatal catchはcurrentSessionIdにアクセス不可
        partner_type: job.partner_type, // #428
      }).then(undefined, () => {})
    }
  } finally {
    const durationMs = Date.now() - jobStart
    activeJobMap.delete(jobId)
    console.log(JSON.stringify({ event: 'job_end', jobId, durationMs, activeJobs: activeJobMap.size }))
  }
}

async function _processJob(jobId: string, job: JobRequest, cancelSignal: AbortSignal): Promise<void> {
  const _jobStart = Date.now()
  const _ts = (label: string) => console.log(JSON.stringify({ event: 'timing', jobId, label, ms: Date.now() - _jobStart }))
  const decoder = new TextDecoder()

  // デフォルトブランチ名（LLMがbranch未指定時に使用）
  const defaultBranch = `sandbox/auto-${jobId.slice(0, 8)}`

  // 1. プロフィール取得 + APIキー取得を並列化
  const activeProvider = job.provider
  const [profileResult, apiKeyFromTable] = await Promise.all([
    supabase
      .from('profiles')
      .select('partner_type, plan, llm_provider, anthropic_api_key_encrypted, openai_api_key_encrypted, google_api_key_encrypted, sandbox_enabled, github_token_encrypted, github_repo_url, current_session_id, active_being_id')
      .eq('id', job.user_id)
      .single().then((res) => res as {
        data: {
          partner_type: string; plan: string; llm_provider: string | null
          anthropic_api_key_encrypted: string | null; openai_api_key_encrypted: string | null; google_api_key_encrypted: string | null
          sandbox_enabled: boolean | null; github_token_encrypted: string | null; github_repo_url: string | null; current_session_id: string | null
          active_being_id: string | null
        } | null
      }),
    getApiKeyFromTable(supabase, job.user_id, activeProvider).catch(() => null as string | null),
  ])
  const profile = profileResult.data

  // being_id: ジョブペイロード優先、未設定時はprofiles.active_being_idにフォールバック
  // （通常チャットUI経由のジョブはbeing_idを持たないため、update_notesの巡回トリガーが機能しない問題を修正）
  const resolvedBeingId: string | undefined = job.being_id ?? profile?.active_being_id ?? undefined

  // #418: Being API（converse）ではBeing専用session_idをペイロードから受け取る。
  const currentSessionId = job.being_id
    ? (job.current_session_id ?? null)
    : (profile?.current_session_id ?? null)
  const sandboxEnabled = job.sandbox_enabled
  _ts('profile_fetched')

  // 2. APIキー取得
  // #789: user_api_keys が正。profiles は既存ユーザーのフォールバック（移行完了後に削除予定）
  let apiKey: string
  if (apiKeyFromTable) {
    // 優先: user_api_keys テーブルから取得
    apiKey = apiKeyFromTable
  } else {
    // フォールバック: profiles の暗号化カラムから取得（旧方式 / 移行期間対応）
    apiKey = await getApiKey(
      {
        plan: profile?.plan ?? 'free',
        llm_provider: profile?.llm_provider ?? null,
        anthropic_api_key_encrypted: profile?.anthropic_api_key_encrypted ?? null,
        openai_api_key_encrypted: profile?.openai_api_key_encrypted ?? null,
        google_api_key_encrypted: profile?.google_api_key_encrypted ?? null,
      },
      activeProvider,
    )
  }

  // 3. LLMProvider生成
  const internalModels = INTERNAL_MODELS[activeProvider]
  let llm
  if (activeProvider === 'openai') {
    llm = createOpenAIProvider(apiKey)
  } else if (activeProvider === 'google') {
    llm = createGoogleProvider(apiKey)
  } else {
    llm = createAnthropicProvider(apiKey)
  }

  const model = getDefaultModel(activeProvider)

  // 4. MemoryStore生成
  // #786: beingId を渡して notes/memory_nodes/clusters の書き込み時に being_id を付与
  const store = createSupabaseMemoryStore(supabase, job.user_id, job.partner_type ?? undefined, resolvedBeingId)

  // 4-b. 挨拶ジョブの場合: LLM呼び出し前に1-B snapshot再構築（#492）
  if (job.is_greeting) {
    const block1BResult = await buildBlock1B(store, job.partner_type)
    await store.deleteSessionSnapshot()
    await store.createSessionSnapshot(block1BResult.content)
  }

  // 5. system prompt構築
  const promptResult = await buildSystemPrompt({
    store,
    llm,
    partnerType: job.partner_type,
    userMessage: job.content,
    supabase,
    userId: job.user_id,
    beingId: resolvedBeingId,
    internalModel: internalModels.light,
  })
  _ts('system_prompt_built')

  // Being SOUL取得（converse mode: being_idが指定された場合）
  // send mode: soulNameはbuildSystemPromptの戻り値から取得（DB二重取得を避ける）
  let soulName: string | undefined = promptResult.soulName
  if (job.being_id) {
    // Being + SOUL を取得してsystem promptのSOULセクションを上書き
    const [{ data: being }, { data: soulRow }] = await Promise.all([
      supabase.from('beings').select('id, name').eq('id', job.being_id).eq('owner_id', job.user_id).single(),
      supabase.from('souls').select('name, personality, voice, values, backstory, inner_world, examples, partner_type').eq('being_id', job.being_id).maybeSingle(),
    ]) as [
      { data: { id: string; name: string } | null },
      { data: { name: string; personality: string; voice: string | null; values: string | null; backstory: string | null; inner_world: string | null; examples: string | null; partner_type: string } | null },
    ]
    if (soulRow) {
      soulName = being?.name ?? soulRow.name
      // systemのSOULセクションを上書き
      const soulSection = [
        `# SOUL（Being: ${soulName}）`,
        `- 名前: ${soulRow.name}`,
        `- 性格: ${soulRow.personality}`,
        soulRow.voice ? `- 話し方: ${soulRow.voice}` : '',
        soulRow.values ? `- 大切にしていること: ${soulRow.values}` : '',
        soulRow.backstory ? `- バックストーリー: ${soulRow.backstory}` : '',
        soulRow.inner_world ? `- 内的世界: ${soulRow.inner_world}` : '',
        soulRow.examples ? `- 口調例:\n${soulRow.examples}` : '',
      ].filter(Boolean).join('\n')
      // SystemBlock[]のSOULセクションを差し替え
      for (const block of promptResult.system) {
        const idx = block.text.indexOf('# SOUL')
        if (idx !== -1) {
          const after = block.text.indexOf('\n#', idx + 1)
          const tail = after !== -1 ? block.text.slice(after) : ''
          block.text = block.text.slice(0, idx) + soulSection + tail
          break
        }
      }
    }
  }

  // GitHub token復号
  async function decryptGithubToken(): Promise<string | null> {
    const encryptedToken = job.github_token_encrypted ?? profile?.github_token_encrypted
    if (!encryptedToken) return null
    try {
      const { decrypt } = await import('../lib/utils/encryption.js')
      return decrypt(encryptedToken)
    } catch (err) {
      console.error('[decryptGithubToken] failed:', err)
      return null
    }
  }

  // ── #474: 添付画像をbase64変換（全プロバイダ共通・1回だけ） ──
  const imageAttachments: ImageAttachment[] = job.images ?? []
  const imagePayloads = await Promise.all(
    imageAttachments.map((img) => fetchImageAsBase64(img.storage_path))
  )
  const hasImages = imagePayloads.some(Boolean)
  // P2-5: 全画像DL失敗時のログ
  if (imageAttachments.length > 0 && !hasImages) {
    console.warn(`[processJob] all image downloads failed: ${imageAttachments.length} attachments, job=${jobId}`)
  }

  // ── ToolBlockContext: ツール実行の共有ミュータブル状態 ──
  interface ToolBlockContext {
    pendingRecallResults: ToolUseResult[]
    pendingExecResults: ToolUseResult[]
    assistantToolUseBlocks: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }>
    loopState: { toolCallHistory: ToolCallHistory }
    loopConfig: { enabled: boolean }
  }

  /**
   * handleToolBlockCommon — Anthropic/OpenAI/Google 共通のツール実行ロジック
   *
   * LLMプロバイダに関わらず同一のツールハンドラを使用する。
   * プロバイダ固有のフォーマット変換は呼び出し元で行う。
   * repairJson — LLMが生成する不正なJSONエスケープを修復する
   *   - \' (single quote) → '
   *   - \( \) \| \- \. など正規表現メタ文字のエスケープ → リテラル文字に
   *   - JSON標準エスケープ（\" \\ \/ \b \f \n \r \t \uXXXX）以外の \X → X
   */
  function repairJson(raw: string): string {
    let repaired = raw.replace(/\\u(?![0-9a-fA-F]{4})/g, 'u')
    repaired = repaired.replace(/\\([^"\\\/bfnrtu])/g, (_match, ch: string) => ch)
    return repaired
  }

  async function handleToolBlockCommon(toolBlock: ToolUseBlock, ctx: ToolBlockContext): Promise<void> {
    let toolParams: unknown = {}
    let jsonParseError = false
    try {
      toolParams = JSON.parse(toolBlock.inputJson)
    } catch {
      try {
        const repaired = repairJson(toolBlock.inputJson)
        toolParams = JSON.parse(repaired)
        console.warn(`[job ${jobId}] tool ${toolBlock.name} JSON repaired successfully`)
        toolBlock.inputJson = repaired
      } catch (repairErr) {
        const preview = toolBlock.inputJson.length > 200
          ? `...${toolBlock.inputJson.slice(-200)}`
          : toolBlock.inputJson
        console.warn(`[job ${jobId}] tool ${toolBlock.name} JSON parse error (repair failed): ${repairErr instanceof Error ? repairErr.message : repairErr}`)
        console.warn(`[job ${jobId}] inputJson length=${toolBlock.inputJson.length}, tail: ${preview}`)
        jsonParseError = true
      }
    }

    if (jsonParseError) {
      const errorMsg = `error: ツールのパラメータJSONが不正です（エスケープ文字の問題）。内容を確認して、JSONのエスケープを修正してから再送してください。問題のツール: ${toolBlock.name}`
      console.warn(`[job ${jobId}] returning JSON parse error to LLM for tool ${toolBlock.name}`)
      ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: errorMsg })
      return
    }

    try {
      const loopResult = detectToolCallLoop(ctx.loopState, toolBlock.name, toolParams, ctx.loopConfig)
      if (loopResult.stuck && loopResult.level === 'critical') {
        console.warn(`[job ${jobId}] tool loop CRITICAL blocked: ${toolBlock.name}`)
        ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: loopResult.message })
        return
      }

      recordToolCall(ctx.loopState, toolBlock.name, toolParams, toolBlock.id, ctx.loopConfig)

      console.log(JSON.stringify({ event: 'tool_call', jobId, tool: toolBlock.name }))
      if (!job.is_warm) broadcastToolUse(job.user_id, toolBlock.name).catch(() => { /* ignore broadcast errors */ })

      if (toolBlock.name === 'update_memory') {
        const toolInput = toolParams as UpdateMemoryInput
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = toolInput
        if (toolInput.target === 'party_message' && toolInput.to) {
          await supabase.from('party_messages').insert({
            user_id: job.user_id, from_partner: job.partner_type, to_partner: toolInput.to, content: toolInput.content,
          })
          ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: '記憶を更新しました' })
        } else {
          const r = await handleUpdateMemory(store, toolInput, job.partner_type)
          ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: r.message })
        }
      } else if (toolBlock.name === 'recall_memory') {
        const recallInput = toolParams as { cluster_id: string; limit?: number; query?: string; no_nodes?: boolean }
        const result = await handleRecallMemory(store, recallInput)
        ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result })
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = toolParams
      } else if (toolBlock.name === 'merge_nodes') {
        const toolInput = toolParams as { node_ids: string; summary: string; feeling?: string }
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = toolInput
        await handleMergeNodes(store, toolInput)
        ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: 'ノードを統合しました' })
      } else if (toolBlock.name === 'get_current_time') {
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = {}
        ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: handleGetCurrentTime() })
      } else if (toolBlock.name === 'exec' && sandboxEnabled) {
        const execInput = toolParams as { command: string; timeout?: number }
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = execInput
        if (config.sandboxApiUrl && config.sandboxApiSecret && job.github_repo_url) {
          const githubToken = await decryptGithubToken()
          if (githubToken) {
            try {
              const cmdTimeout = Math.min(execInput.timeout ?? 60, 300)
              const sandboxRes = await fetch(`${config.sandboxApiUrl}/exec`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                body: JSON.stringify({
                  user_id: job.user_id, command: execInput.command,
                  timeout: cmdTimeout,
                  github_repo: job.github_repo_url, github_token: githubToken,
                  branch: defaultBranch,
                }),
                signal: AbortSignal.timeout((cmdTimeout + 30) * 1000),
              })
              if (sandboxRes.ok) {
                const execResult = await sandboxRes.json() as ExecResult
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: formatExecResult(execResult) })
              } else {
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox API returned ${sandboxRes.status}` })
              }
            } catch (err) {
              ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox unreachable — ${String(err)}` })
            }
          } else {
            ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: GitHubトークンの取得に失敗しました。' })
          }
        } else {
          ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: Sandbox not configured' })
        }
      } else if (toolBlock.name === 'write_file' && sandboxEnabled) {
        const writeInput = toolParams as { path: string; content: string; branch?: string }
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = writeInput
        if (config.sandboxApiUrl && config.sandboxApiSecret && job.github_repo_url) {
          const githubToken = await decryptGithubToken()
          if (githubToken) {
            try {
              const sandboxRes = await fetch(`${config.sandboxApiUrl}/write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                body: JSON.stringify({
                  user_id: job.user_id, path: writeInput.path, content: writeInput.content,
                  github_repo: job.github_repo_url, github_token: githubToken,
                  branch: writeInput.branch || defaultBranch,
                }),
              })
              if (sandboxRes.ok) {
                const writeResult = await sandboxRes.json() as WriteResult
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: formatWriteResult(writeResult) })
              } else {
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox API returned ${sandboxRes.status}` })
              }
            } catch (err) {
              ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox unreachable — ${String(err)}` })
            }
          } else {
            ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: GitHubトークンの取得に失敗しました。' })
          }
        } else {
          ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: Sandbox not configured' })
        }
      } else if (toolBlock.name === 'read_file' && sandboxEnabled) {
        const readInput = toolParams as { path: string; offset?: number; limit?: number }
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = readInput
        if (config.sandboxApiUrl && config.sandboxApiSecret && job.github_repo_url) {
          const githubToken = await decryptGithubToken()
          if (githubToken) {
            try {
              const sandboxRes = await fetch(`${config.sandboxApiUrl}/read`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                body: JSON.stringify({
                  user_id: job.user_id, path: readInput.path,
                  github_repo: job.github_repo_url, github_token: githubToken,
                  ...(readInput.offset !== undefined ? { offset: readInput.offset } : {}),
                  ...(readInput.limit !== undefined ? { limit: readInput.limit } : {}),
                }),
              })
              if (sandboxRes.ok) {
                const readResult = await sandboxRes.json() as ReadResult
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: formatReadResult(readResult) })
              } else {
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox API returned ${sandboxRes.status}` })
              }
            } catch (err) {
              ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox unreachable — ${String(err)}` })
            }
          } else {
            ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: GitHubトークンの取得に失敗しました。' })
          }
        } else {
          ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: Sandbox not configured' })
        }
      } else if (toolBlock.name === 'edit_file' && sandboxEnabled) {
        const editInput = toolParams as { path: string; edits: Array<{ oldText: string; newText: string }>; branch?: string }
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = editInput
        if (config.sandboxApiUrl && config.sandboxApiSecret && job.github_repo_url) {
          const githubToken = await decryptGithubToken()
          if (githubToken) {
            try {
              const sandboxRes = await fetch(`${config.sandboxApiUrl}/edit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                body: JSON.stringify({
                  user_id: job.user_id, path: editInput.path, edits: editInput.edits,
                  github_repo: job.github_repo_url, github_token: githubToken,
                  branch: editInput.branch || defaultBranch,
                }),
              })
              if (sandboxRes.ok) {
                const editResult = await sandboxRes.json() as EditResult
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: formatEditResult(editResult) })
              } else {
                const errBody = await sandboxRes.text().catch(() => '')
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: ${errBody || `Sandbox API returned ${sandboxRes.status}`}` })
              }
            } catch (err) {
              ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox unreachable — ${String(err)}` })
            }
          } else {
            ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: GitHubトークンの取得に失敗しました。' })
          }
        } else {
          ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: Sandbox not configured' })
        }
      } else if (toolBlock.name === 'list_files' && sandboxEnabled) {
        const listInput = toolParams as { path?: string; depth?: number }
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = listInput
        if (config.sandboxApiUrl && config.sandboxApiSecret && job.github_repo_url) {
          const githubToken = await decryptGithubToken()
          if (githubToken) {
            try {
              const sandboxRes = await fetch(`${config.sandboxApiUrl}/list`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sandboxApiSecret}` },
                body: JSON.stringify({
                  user_id: job.user_id,
                  path: listInput.path ?? '.',
                  depth: listInput.depth ?? 3,
                  github_repo: job.github_repo_url, github_token: githubToken,
                }),
              })
              if (sandboxRes.ok) {
                const listResult = await sandboxRes.json() as ListResult
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: formatListResult(listResult) })
              } else {
                ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox API returned ${sandboxRes.status}` })
              }
            } catch (err) {
              ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: `error: Sandbox unreachable — ${String(err)}` })
            }
          } else {
            ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: GitHubトークンの取得に失敗しました。' })
          }
        } else {
          ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result: 'error: Sandbox not configured' })
        }
      } else if (toolBlock.name === 'web_search') {
        const webSearchInput = toolParams as WebSearchInput
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = webSearchInput
        const result = await handleWebSearch(supabase, job.user_id, webSearchInput)
        ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result })
      } else if (toolBlock.name === 'web_fetch') {
        const webFetchInput = toolParams as WebFetchInput
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = webFetchInput
        const result = await handleWebFetch(webFetchInput)
        ctx.pendingExecResults.push({ toolUseId: toolBlock.id, result })
      } else if (toolBlock.name === 'search_history') {
        const searchInput = toolParams as SearchHistoryInput
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = searchInput
        const result = await handleSearchHistory(supabase, job.user_id, searchInput, currentSessionId)
        ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result })
      } else if (toolBlock.name === 'update_notes') {
        const notesInput = toolParams as UpdateNotesInput
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = notesInput
        // supabase: BYOKキーDB取得用（UpdateNotesOptions型に定義済み #778）
        const result = await handleUpdateNotes(store, notesInput, { llmApiKey: apiKey, userId: job.user_id, beingId: resolvedBeingId, partnerType: job.partner_type ?? 'default', supabase })
        ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result })
      } else if (toolBlock.name === 'update_relation' && resolvedBeingId) {
        const relInput = toolParams as UpdateRelationInput
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = relInput
        const r = await handleUpdateRelation(resolvedBeingId, relInput)
        ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: r.message })
      } else if (toolBlock.name.startsWith('cap_')) {
        // spec-37: capabilityツール（Bridge連携）→ handleActTool に委譲
        const capInput = toolParams as { action?: string; parameters?: Record<string, unknown> }
        const blockEntry = ctx.assistantToolUseBlocks.find((b) => b.id === toolBlock.id)
        if (blockEntry) blockEntry.input = capInput
        const matchedCapTool = promptResult.capabilityTools.find((t: { name: string }) => t.name === toolBlock.name)
        if (matchedCapTool?._bridge_id && matchedCapTool?._capability_id) {
          const actInput: ActToolInput = {
            capability_id: matchedCapTool._capability_id,
            bridge_id: matchedCapTool._bridge_id,
            action: capInput.action ?? 'default',
            parameters: capInput.parameters,
          }
          const result = await handleActTool(supabase, job.user_id, actInput)
          ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result })
        } else {
          ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: 'error: capability が見つかりません（Bridge が切断された可能性があります）' })
        }
      } else {
        console.warn(`[job ${jobId}] unhandled tool: ${toolBlock.name}`)
        ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: `Tool ${toolBlock.name} is not currently supported` })
      }

      // ── ツール結果を履歴に記録（no-progress 判定用）──
      const allPending = [...ctx.pendingRecallResults, ...ctx.pendingExecResults]
      const toolResultEntry = allPending.find((r) => r.toolUseId === toolBlock.id)
      recordToolCallOutcome(ctx.loopState, {
        toolName: toolBlock.name,
        toolParams,
        toolCallId: toolBlock.id,
        result: toolResultEntry ? { content: [{ type: 'text', text: toolResultEntry.result }] } : undefined,
        config: ctx.loopConfig,
      })

      // warning 時はツール結果に警告メッセージを追加注入（ブロックはしない）
      if (loopResult.stuck && loopResult.level === 'warning' && toolResultEntry) {
        toolResultEntry.result = `${toolResultEntry.result}\n\n${loopResult.message}`
      }
    } catch (err) {
      console.error(`[job ${jobId}] tool ${toolBlock.name} error:`, err)
      recordToolCallOutcome(ctx.loopState, {
        toolName: toolBlock.name,
        toolParams: toolParams ?? {},
        toolCallId: toolBlock.id,
        error: err,
        config: ctx.loopConfig,
      })
      ctx.pendingRecallResults.push({ toolUseId: toolBlock.id, result: `Tool execution error: ${String(err)}` })
    }
  }

  // ── OpenAI / Google ──
  if (activeProvider === 'openai' || activeProvider === 'google') {
    // ── 共有ミュータブル状態 ──
    let oaAssistantText = ''
    let oaPendingRecallResults: ToolUseResult[] = []
    let oaPendingExecResults: ToolUseResult[] = []
    let oaAssistantToolUseBlocks: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }> = []
    const oaToolCallHistory: ToolCallHistory = []
    const oaLoopState = { toolCallHistory: oaToolCallHistory }
    const oaLoopConfig = { enabled: true }
    const oaAllToolCallRecords: ToolCallRecord[] = []

    // ── 画像コンテンツ構築 ──
    type OAContentBlock = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    const userContentOA: string | OAContentBlock[] = hasImages
      ? [
          ...(job.content ? [{ type: 'text' as const, text: job.content }] : []),
          ...imagePayloads
            .filter((p): p is { base64: string; mimeType: string } => p !== null)
            .map((p) => ({ type: 'image_url' as const, image_url: { url: `data:${p.mimeType};base64,${p.base64}` } })),
        ]
      : job.content

    type GooglePart2 = { text?: string; inlineData?: { mimeType: string; data: string } }
    const userContentGoogle: GooglePart2[] | string = hasImages
      ? [
          ...(job.content ? [{ text: job.content }] : []),
          ...imagePayloads
            .filter((p): p is { base64: string; mimeType: string } => p !== null)
            .map((p) => ({ inlineData: { mimeType: p.mimeType, data: p.base64 } })),
        ]
      : job.content

    // SystemBlock[]→string変換（OpenAI/Googleはstring期待）
    const systemTextForProvider = Array.isArray(promptResult.system)
      ? promptResult.system.map((b: { text: string }) => b.text).join('\n')
      : promptResult.system as string

    // ── ツール定義構築 ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oaActiveTools = buildActiveTools(sandboxEnabled, promptResult.capabilityTools, job.being_id)
    const oaProviderTools = activeProvider === 'openai'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? toOpenAITools(oaActiveTools as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : toGoogleTools(oaActiveTools as any)

    // ── メッセージ構築（初回） ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildOAInitialMessages = (): any[] => {
      if (activeProvider === 'openai') {
        return [
          ...promptResult.prefixMessages.map((m: { role: string; content: unknown }) => ({
            role: m.role,
            content: Array.isArray(m.content)
              ? (m.content as { text: string }[]).map((b) => b.text).join('\n')
              : m.content,
          })),
          { role: 'user', content: userContentOA },
        ]
      } else {
        return [
          ...promptResult.prefixMessages.map((m: { role: string; content: unknown }) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: Array.isArray(m.content)
              ? (m.content as { text: string }[]).map((b) => ({ text: b.text }))
              : [{ text: m.content as string }],
          })),
          {
            role: 'user',
            parts: Array.isArray(userContentGoogle) ? userContentGoogle : [{ text: userContentGoogle }],
          },
        ]
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let oaLoopMessages: any[] = buildOAInitialMessages()
    const OA_MAX_TOOL_LOOPS = 30
    let oaLoopCount = 0

    // ── ツールループ ──
    while (true) {
      if (cancelSignal.aborted) break

      let providerRes: Response
      try {
        providerRes = activeProvider === 'openai'
          ? await createOpenAIStream({ provider: 'openai', apiKey, model, system: systemTextForProvider, messages: oaLoopMessages, tools: oaProviderTools })
          : await createGoogleStream({ provider: 'google', apiKey, model, system: systemTextForProvider, messages: oaLoopMessages, tools: oaProviderTools })
      } catch {
        await broadcastError(job.user_id, `${activeProvider} API unreachable`)
        return
      }

      if (!providerRes.ok || !providerRes.body) {
        await broadcastError(job.user_id, `${activeProvider} API error`)
        return
      }

      const oaAdapter = activeProvider === 'openai'
        ? adaptOpenAIStream(providerRes)
        : adaptGoogleStream(providerRes)

      // iteration単位のテキスト（continuationに含める + 最後にoaAssistantTextへ結合）
      let oaIterText = ''
      const oaStreamReader = oaAdapter.stream.getReader()
      try {
        while (true) {
          const { done, value } = await oaStreamReader.read()
          if (done) break
          const chunk = new TextDecoder().decode(value)
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const parsed = JSON.parse(line.slice(5).trim()) as {
                  delta?: { type?: string; text?: string }
                }
                if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                  oaIterText += parsed.delta.text
                  if (!job.is_warm) await broadcastChunk(job.user_id, parsed.delta.text)
                }
              } catch { /* ignore */ }
            }
          }
        }
      } finally {
        oaStreamReader.releaseLock()
      }
      // iterationのテキストを全体テキストに蓄積
      oaAssistantText += oaIterText

      const oaStopReason = oaAdapter.getStopReason()
      const oaToolCalls = oaAdapter.getToolCalls()

      // ツール呼び出しなし → ループ終了
      if (oaStopReason !== 'tool_use' || oaToolCalls.length === 0) break

      // ループ上限チェック
      oaLoopCount++
      if (oaLoopCount > OA_MAX_TOOL_LOOPS) {
        console.warn(`[job ${jobId}] OA hit max tool loop limit`)
        break
      }

      // ── ツール実行 ──
      oaPendingRecallResults = []
      oaPendingExecResults = []
      oaAssistantToolUseBlocks = []

      const oaCtx: ToolBlockContext = {
        pendingRecallResults: oaPendingRecallResults,
        pendingExecResults: oaPendingExecResults,
        assistantToolUseBlocks: oaAssistantToolUseBlocks,
        loopState: oaLoopState,
        loopConfig: oaLoopConfig,
      }

      for (const tc of oaToolCalls) {
        oaAssistantToolUseBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: {} })
        await handleToolBlockCommon({ id: tc.id, name: tc.name, inputJson: tc.arguments }, oaCtx)
      }

      const oaLoopPendingResults = [...oaPendingRecallResults, ...oaPendingExecResults]
      if (oaLoopPendingResults.length === 0) break

      for (const r of oaLoopPendingResults) {
        const block = oaAssistantToolUseBlocks.find((b) => b.id === r.toolUseId)
        oaAllToolCallRecords.push({
          toolName: block?.name ?? 'unknown',
          toolInput: JSON.stringify(block?.input ?? {}),
          toolResult: r.result,
        })
      }

      // ── continuation messages構築 ──
      if (activeProvider === 'openai') {
        oaLoopMessages.push({
          role: 'assistant',
          content: oaIterText || null, // ツール呼び出し前のテキストが存在すれば含める
          tool_calls: oaToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        })
        for (const r of oaLoopPendingResults) {
          const tc = oaToolCalls.find((t) => t.id === r.toolUseId)
          oaLoopMessages.push({
            role: 'tool',
            tool_call_id: r.toolUseId,
            content: r.result,
            ...(tc ? { name: tc.name } : {}),
          })
        }
      } else {
        // Google: model functionCall + user functionResponse
        oaLoopMessages.push({
          role: 'model',
          parts: oaToolCalls.map((tc) => ({
            functionCall: { name: tc.name, args: JSON.parse(tc.arguments || '{}') },
          })),
        })
        oaLoopMessages.push({
          role: 'user',
          parts: oaLoopPendingResults.map((r) => {
            const tc = oaToolCalls.find((t) => t.id === r.toolUseId)
            return {
              functionResponse: {
                name: tc?.name ?? 'unknown',
                response: { result: r.result },
              },
            }
          }),
        })
      }
    } // end while

    // ── DB保存 ──
    if (oaAssistantText && !job.is_warm) {
      await supabase.from('chat_messages').insert({
        user_id: job.user_id, role: 'assistant', content: oaAssistantText, session_id: currentSessionId,
        partner_type: job.partner_type,
        ...(resolvedBeingId ? { being_id: resolvedBeingId } : {}),
      })
    }
    if (oaAllToolCallRecords.length > 0) {
      const toolSummaryLines = oaAllToolCallRecords
        .map((t) => `[${t.toolName}] ${t.toolInput} → ${t.toolResult}`)
        .join('\n')
      await supabase.from('chat_messages').insert({
        user_id: job.user_id,
        role: 'assistant',
        content: `[tool_summary]\n${toolSummaryLines}`,
        session_id: currentSessionId,
        block: '2b',
        partner_type: job.partner_type,
        ...(job.is_warm ? { is_warm: true } : {}),
        ...(resolvedBeingId ? { being_id: resolvedBeingId } : {}),
      })
    }

    console.log(JSON.stringify({ event: 'job_done', jobId, provider: activeProvider, durationMs: Date.now() - _jobStart }))
    if (!job.is_warm) await broadcastDone(job.user_id)
    // #267: Web Push通知（non-fatal）— is_warmの場合はスキップ
    if (!job.is_warm) notifyUser(job.user_id, soulName, oaAssistantText)
    return
  }

  // 2-BのDB保存（次ターンのchatHistoryに含めてprefix一致を保証）
  // is_warm: trueでUI表示は🔥マーカー。block='2b'でgetMessages()に含まれる
  // created_atをuserメッセージの直前にして、chatHistory時系列順でAPI送信順と一致させる
  if (promptResult.block2BContent) {
    await supabase.from('chat_messages').insert([
      { user_id: job.user_id, role: 'user', content: promptResult.block2BContent, session_id: currentSessionId, partner_type: job.partner_type, is_warm: true, block: '2b', ...(resolvedBeingId ? { being_id: resolvedBeingId } : {}) },
      { user_id: job.user_id, role: 'assistant', content: 'ok', session_id: currentSessionId, partner_type: job.partner_type, is_warm: true, block: '2b', ...(resolvedBeingId ? { being_id: resolvedBeingId } : {}) },
    ])
  }

  // #505: warm時もuserメッセージを保存（次のwarm/chatのchatHistoryに含めてprefix一致を保証）
  if (job.is_warm) {
    await supabase.from('chat_messages').insert({
      user_id: job.user_id, role: 'user', content: job.content,
      session_id: currentSessionId, partner_type: job.partner_type,
      is_warm: true,
      ...(resolvedBeingId ? { being_id: resolvedBeingId } : {}),
    })
  }

  // ── Anthropic ──
  // ストリームタイムアウト: 最後のイベント受信から120秒でabort
  const STREAM_TIMEOUT_MS = 120_000
  let anthropicRes: Response
  const initialAbort = new AbortController()
  // Hotfix 2026-04-07: fetch接続確立にもタイムアウトを設定
  // fetchが返ってくるまでstreamTimerが設定されないため、
  // 接続確立段階でハングするとジョブが永久に停止する
  const fetchTimer = setTimeout(() => { initialAbort.abort() }, STREAM_TIMEOUT_MS)
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.any([initialAbort.signal, cancelSignal]),
      body: JSON.stringify({
        model,
        max_tokens: job.is_warm ? 1 : 64000,
        stream: true,
        cache_control: { type: 'ephemeral' },
        system: promptResult.system,
        tools: [
          UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL, MERGE_NODES_TOOL,
          SEARCH_HISTORY_TOOL, GET_CURRENT_TIME_TOOL, UPDATE_NOTES_TOOL,
          WEB_SEARCH_TOOL, WEB_FETCH_TOOL,
          ...(sandboxEnabled ? [EXEC_TOOL, WRITE_TOOL, READ_TOOL, EDIT_TOOL, LIST_TOOL] : []),
          ...promptResult.capabilityTools,
          ...(resolvedBeingId ? [UPDATE_RELATION_TOOL] : []),
        ],
        messages: [
          ...promptResult.prefixMessages,
          { role: 'user', content: hasImages
            ? [
                ...(job.content ? [{ type: 'text' as const, text: job.content }] : []),
                ...imagePayloads
                  .filter((p): p is { base64: string; mimeType: string } => p !== null)
                  .map((p) => ({
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: p.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                      data: p.base64,
                    },
                  }))
              ]
            : job.content
          },
          // 今ターンの2-B（fresh+recall）をuserメッセージの後に配置
          // DB保存順と一致させてprefixキャッシュを安定化
          ...(promptResult.block2BContent ? [
            { role: 'user' as const, content: promptResult.block2BContent },
            { role: 'assistant' as const, content: 'ok' },
          ] : []),
        ],
      }),
    })
  } catch {
    clearTimeout(fetchTimer)
    await broadcastError(job.user_id, 'Anthropic API unreachable')
    return
  }
  clearTimeout(fetchTimer)
  _ts('llm_response_started')

  if (!anthropicRes.ok || !anthropicRes.body) {
    await broadcastError(job.user_id, 'Anthropic API error')
    return
  }

  let assistantText = ''
  let inputTokens = 0
  let outputTokens = 0
  let currentToolBlock: ToolUseBlock | null = null
  let stopReason = 'end_turn'
  let pendingRecallResults: ToolUseResult[] = []
  let pendingExecResults: ToolUseResult[] = []
  let assistantToolUseBlocks: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }> = []

  // ツールループ検出状態
  const toolCallHistory: ToolCallHistory = []
  const loopState = { toolCallHistory }
  const loopConfig = { enabled: true }

  // Anthropicパス用ToolBlockContext（handleToolBlockCommonに渡す）
  const anthropicCtx: ToolBlockContext = {
    pendingRecallResults,
    pendingExecResults,
    assistantToolUseBlocks,
    loopState,
    loopConfig,
  }

  // Anthropicパスのツール実行は共通関数に委譲
  async function handleToolBlock(toolBlock: ToolUseBlock): Promise<void> {
    return handleToolBlockCommon(toolBlock, anthropicCtx)
  }

  const reader = anthropicRes.body.getReader()
  let buffer = ''

  // ストリームハング検出タイマー
  let streamTimer = setTimeout(() => { initialAbort.abort() }, STREAM_TIMEOUT_MS)
  const resetStreamTimer = (abort: AbortController) => {
    clearTimeout(streamTimer)
    streamTimer = setTimeout(() => { abort.abort() }, STREAM_TIMEOUT_MS)
  }

  try {
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>
      try {
        readResult = await reader.read()
      } catch (err) {
        if (initialAbort.signal.aborted) {
          console.warn(`[job ${jobId}] Anthropic stream timed out after ${STREAM_TIMEOUT_MS}ms`)
          await broadcastError(job.user_id, 'Stream timed out. Please try again.')
        }
        break
      }
      const { done, value } = readResult
      if (done) break
      resetStreamTimer(initialAbort)

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const event of parseSseLines(lines)) {
        const { eventName, data } = event

        if (eventName === 'message_start') {
          try {
            const parsed = JSON.parse(data) as { message?: { usage?: AnthropicUsage & { cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } }
            if (parsed.message?.usage) {
              inputTokens = parsed.message.usage.input_tokens
              console.log(JSON.stringify({ event: 'anthropic_usage', jobId, cache_creation: parsed.message.usage.cache_creation_input_tokens ?? 0, cache_read: parsed.message.usage.cache_read_input_tokens ?? 0, input_tokens: inputTokens }))
            }
          } catch { /* ignore */ }

        } else if (eventName === 'content_block_start') {
          try {
            const parsed = JSON.parse(data) as { content_block?: { type?: string; id?: string; name?: string } }
            if (parsed.content_block?.type === 'tool_use') {
              currentToolBlock = { id: parsed.content_block.id ?? '', name: parsed.content_block.name ?? '', inputJson: '' }
              assistantToolUseBlocks.push({ type: 'tool_use', id: currentToolBlock.id, name: currentToolBlock.name, input: {} })
            }
          } catch { /* ignore */ }

        } else if (eventName === 'content_block_delta') {
          try {
            const parsed = JSON.parse(data) as { delta?: { type?: string; text?: string; partial_json?: string } }
            if (parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
              assistantText += parsed.delta.text
              if (!job.is_warm) await broadcastChunk(job.user_id, parsed.delta.text)
            } else if (parsed.delta?.type === 'input_json_delta' && currentToolBlock) {
              currentToolBlock.inputJson += parsed.delta.partial_json ?? ''
            }
          } catch { /* ignore */ }

        } else if (eventName === 'content_block_stop') {
          if (currentToolBlock) {
            const toolBlock = currentToolBlock
            currentToolBlock = null
            await handleToolBlock(toolBlock)
          }

        } else if (eventName === 'message_delta') {
          try {
            const parsed = JSON.parse(data) as { delta?: { stop_reason?: string }; usage?: { output_tokens?: number } }
            if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason
            if (parsed.usage?.output_tokens != null) outputTokens = parsed.usage.output_tokens
          } catch { /* ignore */ }

        } else if (eventName === 'message_stop') {
          const MAX_TOOL_LOOPS = 30  // globalCircuitBreakerThreshold に合わせる
          let loopCount = 0
          const allToolCallRecords: ToolCallRecord[] = []

          // #519: フルコンテキスト再構築方式 — 前ターンのintermediate textをLLMに送り返さない
          const toolHistory: Array<{ role: string; content: unknown }> = []

          while (stopReason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
            if (cancelSignal.aborted) break
            loopCount++
            const loopPendingResults = [...pendingRecallResults, ...pendingExecResults]
            if (loopPendingResults.length === 0) break

            for (const r of loopPendingResults) {
              const block = assistantToolUseBlocks.find((b) => b.id === r.toolUseId)
              allToolCallRecords.push({
                toolName: block?.name ?? 'unknown',
                toolInput: JSON.stringify(block?.input ?? {}),
                toolResult: r.result,
              })
            }

            // tool_useブロックのみ積む（intermediate textを除外して自家中毒を防止）
            const toolUseOnly = assistantToolUseBlocks.filter(
              (b: { type: string }) => b.type === 'tool_use'
            )
            toolHistory.push({ role: 'assistant', content: toolUseOnly })
            toolHistory.push({
              role: 'user',
              content: loopPendingResults.map((r) => ({
                type: 'tool_result', tool_use_id: r.toolUseId, content: r.result,
              })),
            })

            pendingRecallResults.splice(0)
            pendingExecResults.splice(0)
            assistantToolUseBlocks.splice(0)
            currentToolBlock = null
            stopReason = 'end_turn'

            let continuationRes: Response
            const contAbort = new AbortController()
            // Hotfix: continuation fetchにもタイムアウト（initialと同じパターン）
            const contFetchTimer = setTimeout(() => { contAbort.abort() }, STREAM_TIMEOUT_MS)
            try {
              continuationRes = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                signal: AbortSignal.any([contAbort.signal, cancelSignal]),
                body: JSON.stringify({
                  model, max_tokens: job.is_warm ? 1 : 64000, stream: true,
                  cache_control: { type: 'ephemeral' },
                  system: promptResult.system,
                  tools: [
                    UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL, MERGE_NODES_TOOL,
                    SEARCH_HISTORY_TOOL, GET_CURRENT_TIME_TOOL, UPDATE_NOTES_TOOL,
                    WEB_SEARCH_TOOL, WEB_FETCH_TOOL,
                    ...(sandboxEnabled ? [EXEC_TOOL, WRITE_TOOL, READ_TOOL, EDIT_TOOL, LIST_TOOL] : []),
                    ...promptResult.capabilityTools,
                    ...(resolvedBeingId ? [UPDATE_RELATION_TOOL] : []),
                  ],
                  // #519: 毎回フルmessages配列を再構築
                  messages: [
                    ...promptResult.prefixMessages,
                    { role: 'user', content: job.content },
                    ...toolHistory,
                  ],
                }),
              })
            } catch (err) {
              clearTimeout(contFetchTimer)
              console.error(`[job ${jobId}] continuation loop ${loopCount} unreachable:`, err)
              break
            }
            clearTimeout(contFetchTimer)

            if (!continuationRes.ok || !continuationRes.body) break

            const contReader = continuationRes.body.getReader()
            let contBuffer = ''
            let contStreamTimer = setTimeout(() => { contAbort.abort() }, STREAM_TIMEOUT_MS)
            const resetContTimer = () => {
              clearTimeout(contStreamTimer)
              contStreamTimer = setTimeout(() => { contAbort.abort() }, STREAM_TIMEOUT_MS)
            }
            try {
              while (true) {
                let contReadResult: ReadableStreamReadResult<Uint8Array>
                try {
                  contReadResult = await contReader.read()
                } catch {
                  if (contAbort.signal.aborted) {
                    console.warn(`[job ${jobId}] continuation stream timed out (loop ${loopCount})`)
                    await broadcastError(job.user_id, 'Stream timed out. Please try again.')
                  }
                  break
                }
                const { done, value } = contReadResult
                if (done) break
                resetContTimer()
                contBuffer += decoder.decode(value, { stream: true })
                const contLines = contBuffer.split('\n')
                contBuffer = contLines.pop() ?? ''
                for (const contEvent of parseSseLines(contLines)) {
                  if (contEvent.eventName === 'message_start') {
                    try {
                      const parsed = JSON.parse(contEvent.data) as { message?: { usage?: AnthropicUsage } }
                      if (parsed.message?.usage) inputTokens += parsed.message.usage.input_tokens
                    } catch { /* ignore */ }
                  } else if (contEvent.eventName === 'content_block_start') {
                    try {
                      const parsed = JSON.parse(contEvent.data) as { content_block?: { type?: string; id?: string; name?: string } }
                      if (parsed.content_block?.type === 'tool_use') {
                        currentToolBlock = { id: parsed.content_block.id ?? '', name: parsed.content_block.name ?? '', inputJson: '' }
                        assistantToolUseBlocks.push({ type: 'tool_use', id: currentToolBlock.id, name: currentToolBlock.name, input: {} })
                      }
                    } catch { /* ignore */ }
                  } else if (contEvent.eventName === 'content_block_delta') {
                    try {
                      const parsed = JSON.parse(contEvent.data) as { delta?: { type?: string; text?: string; partial_json?: string } }
                      if (parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
                        assistantText += parsed.delta.text
                        // ユーザーにはリアルタイムストリーミング（UX向上）
                        // LLMへの送り返しはtoolHistory経由で制御（自家中毒防止はそちらで担保）
                        if (!job.is_warm) await broadcastChunk(job.user_id, parsed.delta.text)
                      } else if (parsed.delta?.type === 'input_json_delta' && currentToolBlock) {
                        currentToolBlock.inputJson += parsed.delta.partial_json ?? ''
                      }
                    } catch { /* ignore */ }
                  } else if (contEvent.eventName === 'content_block_stop') {
                    if (currentToolBlock) {
                      const toolBlock = currentToolBlock
                      currentToolBlock = null
                      await handleToolBlock(toolBlock)
                    }
                  } else if (contEvent.eventName === 'message_delta') {
                    try {
                      const parsed = JSON.parse(contEvent.data) as { delta?: { stop_reason?: string }; usage?: { output_tokens?: number } }
                      if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason
                      if (parsed.usage?.output_tokens != null) outputTokens += parsed.usage.output_tokens
                    } catch { /* ignore */ }
                  }
                }
              }
            } finally {
              clearTimeout(contStreamTimer)
              contReader.releaseLock()
            }
            // continuation中のtext_deltaは都度broadcastChunk済み（まとめ送信は不要）
          } // end tool loop

          if (loopCount >= MAX_TOOL_LOOPS) {
            console.warn(`[job ${jobId}] hit max tool loop limit`)
          }

          // DB保存（#505: warm時はassistant応答を保存しない — user🔥のみでキャッシュ維持）
          if (assistantText && !job.is_warm) {
            await supabase.from('chat_messages').insert({
              user_id: job.user_id, role: 'assistant', content: assistantText, session_id: currentSessionId,
              partner_type: job.partner_type,
              ...(resolvedBeingId ? { being_id: resolvedBeingId } : {}),
            })
          }

          // #409: tool結果をchat_messagesに保存（SSEパスと統一。パートナーが前ターンのツール操作を記憶できるようにする）
          if (allToolCallRecords.length > 0) {
            const toolSummaryLines = allToolCallRecords
              .map((t) => `[${t.toolName}] ${t.toolInput} → ${t.toolResult}`)
              .join('\n')
            await supabase.from('chat_messages').insert({
              user_id: job.user_id,
              role: 'assistant',
              content: `[tool_summary]\n${toolSummaryLines}`,
              session_id: currentSessionId,
              block: '2b',
              partner_type: job.partner_type, // #428
              ...(job.is_warm ? { is_warm: true } : {}),
              ...(resolvedBeingId ? { being_id: resolvedBeingId } : {}),
            })
          }

          if (promptResult.noteIds.length > 0) await store.markNotesRead(promptResult.noteIds)
          if (promptResult.freshNodeIds.length > 0) await store.updateNodes(promptResult.freshNodeIds, { fresh: false })

          if (promptResult.partyMessageReadIds && promptResult.partyMessageReadIds.length > 0) {
            await supabase.from('party_messages').update({ read: true }).in('id', promptResult.partyMessageReadIds)
          }

          const costUsd = calculateCostUsd(inputTokens, outputTokens)
          await supabase.from('api_usage').insert({
            user_id: job.user_id, input_tokens: inputTokens, output_tokens: outputTokens,
            cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: costUsd, model,
          })

          console.log(JSON.stringify({ event: 'job_done', jobId, provider: activeProvider, durationMs: Date.now() - _jobStart }))
          if (!job.is_warm) await broadcastDone(job.user_id)
          // #267: Web Push通知（non-fatal）— is_warmの場合はスキップ
          if (!job.is_warm) notifyUser(job.user_id, soulName, assistantText)
        }
      }
    }
  } finally {
    clearTimeout(streamTimer)
    reader.releaseLock()
  }
}
