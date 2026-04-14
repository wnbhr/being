/**
 * tool-loop-detection.ts
 *
 * OpenClaw の tool-loop-detection 実装を Being Worker 向けに移植。
 * OpenClaw 固有の依存（createSubsystemLogger, isPlainObject, logToolLoopAction,
 * getDiagnosticSessionState）を除去し、console.warn/error に簡素化。
 *
 * 3つの検出器:
 *   1. generic_repeat       — 同じツール+引数の繰り返し
 *   2. known_poll_no_progress — ポーリング系ツールの進捗なし繰り返し
 *   3. ping_pong            — 2ツールの交互呼び出し + no-progress 判定
 *
 * 段階的対応:
 *   warning (10回)  → ツール結果に警告メッセージを注入。実行は止めない
 *   critical (20回) → ツール呼び出しをブロック
 *   breaker (30回)  → グローバルブレーカー発動
 */

import { createHash } from 'node:crypto'

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface ToolCallHistoryEntry {
  toolName: string
  argsHash: string
  toolCallId?: string
  resultHash?: string
  timestamp: number
}

export type ToolCallHistory = ToolCallHistoryEntry[]

export interface ToolLoopDetectionState {
  toolCallHistory: ToolCallHistory
}

export interface ToolLoopDetectionConfig {
  enabled?: boolean
  historySize?: number
  warningThreshold?: number
  criticalThreshold?: number
  globalCircuitBreakerThreshold?: number
  detectors?: {
    genericRepeat?: boolean
    knownPollNoProgress?: boolean
    pingPong?: boolean
  }
}

export type ToolLoopLevel = 'warning' | 'critical'

export type ToolLoopDetectResult =
  | { stuck: false }
  | {
      stuck: true
      level: ToolLoopLevel
      detector: 'generic_repeat' | 'known_poll_no_progress' | 'ping_pong' | 'global_circuit_breaker'
      count: number
      message: string
      pairedToolName?: string
      warningKey?: string
    }

// ──────────────────────────────────────────────
// デフォルト設定（Cove 用: enabled: true）
// ──────────────────────────────────────────────

const DEFAULT_LOOP_DETECTION_CONFIG: Required<ToolLoopDetectionConfig> = {
  enabled: true,
  historySize: 30,
  warningThreshold: 10,
  criticalThreshold: 20,
  globalCircuitBreakerThreshold: 30,
  detectors: {
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
  },
}

// ──────────────────────────────────────────────
// 内部ユーティリティ
// ──────────────────────────────────────────────

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return fallback
  return value
}

function resolveLoopDetectionConfig(config?: ToolLoopDetectionConfig): Required<ToolLoopDetectionConfig> {
  let warningThreshold = asPositiveInt(config?.warningThreshold, DEFAULT_LOOP_DETECTION_CONFIG.warningThreshold)
  let criticalThreshold = asPositiveInt(config?.criticalThreshold, DEFAULT_LOOP_DETECTION_CONFIG.criticalThreshold)
  let globalCircuitBreakerThreshold = asPositiveInt(
    config?.globalCircuitBreakerThreshold,
    DEFAULT_LOOP_DETECTION_CONFIG.globalCircuitBreakerThreshold,
  )
  if (criticalThreshold <= warningThreshold) criticalThreshold = warningThreshold + 1
  if (globalCircuitBreakerThreshold <= criticalThreshold) globalCircuitBreakerThreshold = criticalThreshold + 1
  return {
    enabled: config?.enabled ?? DEFAULT_LOOP_DETECTION_CONFIG.enabled,
    historySize: asPositiveInt(config?.historySize, DEFAULT_LOOP_DETECTION_CONFIG.historySize),
    warningThreshold,
    criticalThreshold,
    globalCircuitBreakerThreshold,
    detectors: {
      genericRepeat: config?.detectors?.genericRepeat ?? DEFAULT_LOOP_DETECTION_CONFIG.detectors.genericRepeat,
      knownPollNoProgress: config?.detectors?.knownPollNoProgress ?? DEFAULT_LOOP_DETECTION_CONFIG.detectors.knownPollNoProgress,
      pingPong: config?.detectors?.pingPong ?? DEFAULT_LOOP_DETECTION_CONFIG.detectors.pingPong,
    },
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}

function stableStringifyFallback(value: unknown): string {
  try {
    return stableStringify(value)
  } catch {
    if (value === null || value === undefined) return `${value}`
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return `${value}`
    if (value instanceof Error) return `${value.name}:${value.message}`
    return Object.prototype.toString.call(value)
  }
}

function digestStable(value: unknown): string {
  return createHash('sha256').update(stableStringifyFallback(value)).digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

// ──────────────────────────────────────────────
// ポーリング系ツール判定
// Cove では exec（同じコマンドの繰り返し）をポーリング扱い
// ──────────────────────────────────────────────

function isKnownPollToolCall(toolName: string, params: unknown): boolean {
  if (toolName === 'exec' && isPlainObject(params)) {
    const cmd = params.command
    if (typeof cmd === 'string') {
      // sleep / wait / status チェック系のコマンドはポーリング扱い
      return /\bsleep\b|\bwait\b|\bstatus\b|\bpoll\b/.test(cmd)
    }
  }
  return false
}

// ──────────────────────────────────────────────
// ハッシュ計算
// ──────────────────────────────────────────────

export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(params)}`
}

function formatErrorForHash(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return `${error}`
  return stableStringify(error)
}

function extractTextContent(result: unknown): string {
  if (!isPlainObject(result) || !Array.isArray(result.content)) return ''
  return (result.content as unknown[])
    .filter(
      (entry): entry is { type: string; text: string } =>
        isPlainObject(entry) && typeof entry.type === 'string' && typeof entry.text === 'string',
    )
    .map((entry) => entry.text)
    .join('\n')
    .trim()
}

function hashToolOutcome(toolName: string, params: unknown, result: unknown, error: unknown): string | undefined {
  if (error !== undefined) return `error:${digestStable(formatErrorForHash(error))}`
  if (!isPlainObject(result)) return result === undefined ? undefined : digestStable(result)
  const details = isPlainObject(result.details) ? result.details : {}
  const text = extractTextContent(result)
  return digestStable({ details, text })
}

// ──────────────────────────────────────────────
// ループ検出ロジック
// ──────────────────────────────────────────────

function getNoProgressStreak(
  history: ToolCallHistory,
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0
  let latestResultHash: string | undefined
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i]
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) continue
    if (typeof record.resultHash !== 'string' || !record.resultHash) continue
    if (!latestResultHash) {
      latestResultHash = record.resultHash
      streak = 1
      continue
    }
    if (record.resultHash !== latestResultHash) break
    streak++
  }
  return { count: streak, latestResultHash }
}

function getPingPongStreak(
  history: ToolCallHistory,
  currentSignature: string,
): {
  count: number
  noProgressEvidence: boolean
  pairedToolName?: string
  pairedSignature?: string
} {
  const last = history[history.length - 1]
  if (!last) return { count: 0, noProgressEvidence: false }

  let otherSignature: string | undefined
  let otherToolName: string | undefined
  for (let i = history.length - 2; i >= 0; i--) {
    const call = history[i]
    if (!call) continue
    if (call.argsHash !== last.argsHash) {
      otherSignature = call.argsHash
      otherToolName = call.toolName
      break
    }
  }

  if (!otherSignature || !otherToolName) return { count: 0, noProgressEvidence: false }

  let alternatingTailCount = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const call = history[i]
    if (!call) continue
    const expected = alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature
    if (call.argsHash !== expected) break
    alternatingTailCount++
  }

  if (alternatingTailCount < 2) return { count: 0, noProgressEvidence: false }
  if (currentSignature !== otherSignature) return { count: 0, noProgressEvidence: false }

  const tailStart = Math.max(0, history.length - alternatingTailCount)
  let firstHashA: string | undefined
  let firstHashB: string | undefined
  let noProgressEvidence = true

  for (let i = tailStart; i < history.length; i++) {
    const call = history[i]
    if (!call) continue
    if (!call.resultHash) { noProgressEvidence = false; break }
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) firstHashA = call.resultHash
      else if (firstHashA !== call.resultHash) { noProgressEvidence = false; break }
      continue
    }
    if (call.argsHash === otherSignature) {
      if (!firstHashB) firstHashB = call.resultHash
      else if (firstHashB !== call.resultHash) { noProgressEvidence = false; break }
      continue
    }
    noProgressEvidence = false
    break
  }

  if (!firstHashA || !firstHashB) noProgressEvidence = false

  return {
    count: alternatingTailCount + 1,
    pairedToolName: last.toolName,
    pairedSignature: last.argsHash,
    noProgressEvidence,
  }
}

function canonicalPairKey(signatureA: string, signatureB: string): string {
  return [signatureA, signatureB].sort().join('|')
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * ツールループを検出する。
 * ツール呼び出し前に実行し、結果に応じてブロック・警告を行う。
 */
export function detectToolCallLoop(
  state: ToolLoopDetectionState,
  toolName: string,
  params: unknown,
  config?: ToolLoopDetectionConfig,
): ToolLoopDetectResult {
  const resolvedConfig = resolveLoopDetectionConfig(config)
  if (!resolvedConfig.enabled) return { stuck: false }

  const history = state.toolCallHistory ?? []
  const currentHash = hashToolCall(toolName, params)
  const noProgress = getNoProgressStreak(history, toolName, currentHash)
  const noProgressStreak = noProgress.count
  const knownPollTool = isKnownPollToolCall(toolName, params)
  const pingPong = getPingPongStreak(history, currentHash)

  // グローバルサーキットブレーカー
  if (noProgressStreak >= resolvedConfig.globalCircuitBreakerThreshold) {
    console.error(`[tool-loop] Global circuit breaker: ${toolName} repeated ${noProgressStreak} times with no progress`)
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker to prevent runaway loops.`,
      warningKey: `global:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
    }
  }

  // known_poll_no_progress — critical
  if (knownPollTool && resolvedConfig.detectors.knownPollNoProgress && noProgressStreak >= resolvedConfig.criticalThreshold) {
    console.error(`[tool-loop] Critical polling loop: ${toolName} repeated ${noProgressStreak} times`)
    return {
      stuck: true,
      level: 'critical',
      detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. This appears to be a stuck polling loop. Session execution blocked to prevent resource waste.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
    }
  }

  // known_poll_no_progress — warning
  if (knownPollTool && resolvedConfig.detectors.knownPollNoProgress && noProgressStreak >= resolvedConfig.warningThreshold) {
    console.warn(`[tool-loop] Polling loop warning: ${toolName} repeated ${noProgressStreak} times`)
    return {
      stuck: true,
      level: 'warning',
      detector: 'known_poll_no_progress',
      count: noProgressStreak,
      message: `WARNING: You have called ${toolName} ${noProgressStreak} times with identical arguments and no progress. Stop polling and either (1) increase wait time between checks, or (2) report the task as failed if the process is stuck.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? 'none'}`,
    }
  }

  const pingPongWarningKey = pingPong.pairedSignature
    ? `pingpong:${canonicalPairKey(currentHash, pingPong.pairedSignature)}`
    : `pingpong:${toolName}:${currentHash}`

  // ping_pong — critical
  if (resolvedConfig.detectors.pingPong && pingPong.count >= resolvedConfig.criticalThreshold && pingPong.noProgressEvidence) {
    console.error(`[tool-loop] Critical ping-pong loop: count=${pingPong.count} currentTool=${toolName}`)
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong.count,
      message: `CRITICAL: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls) with no progress. This appears to be a stuck ping-pong loop. Session execution blocked to prevent resource waste.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    }
  }

  // ping_pong — warning
  if (resolvedConfig.detectors.pingPong && pingPong.count >= resolvedConfig.warningThreshold) {
    console.warn(`[tool-loop] Ping-pong loop warning: count=${pingPong.count} currentTool=${toolName}`)
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong.count,
      message: `WARNING: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls). This looks like a ping-pong loop; stop retrying and report the task as failed.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    }
  }

  // generic_repeat — warning のみ（critical は global_circuit_breaker がカバー）
  const recentCount = history.filter((h) => h.toolName === toolName && h.argsHash === currentHash).length
  if (!knownPollTool && resolvedConfig.detectors.genericRepeat && recentCount >= resolvedConfig.warningThreshold) {
    console.warn(`[tool-loop] Loop warning: ${toolName} called ${recentCount} times with identical arguments`)
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments. If this is not making progress, stop retrying and report the task as failed.`,
      warningKey: `generic:${toolName}:${currentHash}`,
    }
  }

  return { stuck: false }
}

/**
 * ツール呼び出しをスライディングウィンドウ履歴に記録する。
 * ツール呼び出し前に detectToolCallLoop と一緒に呼ぶ。
 */
export function recordToolCall(
  state: ToolLoopDetectionState,
  toolName: string,
  params: unknown,
  toolCallId: string | undefined,
  config?: ToolLoopDetectionConfig,
): void {
  const resolvedConfig = resolveLoopDetectionConfig(config)
  if (!state.toolCallHistory) state.toolCallHistory = []
  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    toolCallId,
    timestamp: Date.now(),
  })
  if (state.toolCallHistory.length > resolvedConfig.historySize) {
    state.toolCallHistory.shift()
  }
}

/**
 * ツール実行結果を履歴に記録する（no-progress 判定用）。
 * ツール呼び出し後に実行する。
 */
export function recordToolCallOutcome(
  state: ToolLoopDetectionState,
  params: {
    toolName: string
    toolParams: unknown
    toolCallId?: string
    result?: unknown
    error?: unknown
    config?: ToolLoopDetectionConfig
  },
): void {
  const resolvedConfig = resolveLoopDetectionConfig(params.config)
  const resultHash = hashToolOutcome(params.toolName, params.toolParams, params.result, params.error)
  if (!resultHash) return
  if (!state.toolCallHistory) state.toolCallHistory = []
  const argsHash = hashToolCall(params.toolName, params.toolParams)
  let matched = false

  for (let i = state.toolCallHistory.length - 1; i >= 0; i--) {
    const call = state.toolCallHistory[i]
    if (!call) continue
    if (params.toolCallId && call.toolCallId !== params.toolCallId) continue
    if (call.toolName !== params.toolName || call.argsHash !== argsHash) continue
    if (call.resultHash !== undefined) continue
    call.resultHash = resultHash
    matched = true
    break
  }

  if (!matched) {
    state.toolCallHistory.push({
      toolName: params.toolName,
      argsHash,
      toolCallId: params.toolCallId,
      resultHash,
      timestamp: Date.now(),
    })
  }

  if (state.toolCallHistory.length > resolvedConfig.historySize) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - resolvedConfig.historySize)
  }
}
