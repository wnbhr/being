/**
 * Bridge Manager — WebSocket接続中のBridgeを管理
 * 
 * - Bridge接続/切断の追跡
 * - act指示をWebSocketで転送し、結果をPromiseで待機
 * - sense入力を受け取りsense_logへ保存
 */

import type { WebSocket } from '@fastify/websocket'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

/** WebSocket接続中のBridgeセッション */
export interface BridgeSession {
  bridgeId: string
  userId: string
  bridgeName: string
  ws: WebSocket
  connectedAt: string
}

/** pending act: Bridgeからの応答待ちPromise */
interface PendingAct {
  resolve: (result: ActResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ActResult {
  act_id: string
  status: 'completed' | 'failed' | 'timeout'
  result?: unknown
}

// Bridge sessions: bridgeId → session
// NOTE: このモジュールはシングルインスタンス前提（プロセス内でMapを共有）。
// スケールアウトする場合はRedis等の外部ストアへの移行が必要。
const sessions = new Map<string, BridgeSession>()

// Pending acts: act_id → pending
const pendingActs = new Map<string, PendingAct>()

// ------------------------------------------------------------------
// Bridge接続管理
// ------------------------------------------------------------------

/** Bridgeを登録する（WebSocket接続時） */
export function registerBridge(session: Omit<BridgeSession, 'connectedAt'>): void {
  sessions.set(session.bridgeId, {
    ...session,
    connectedAt: new Date().toISOString(),
  })
  console.log(`[bridge] connected: ${session.bridgeId} (${session.bridgeName}) user=${session.userId}`)
}

/** Bridgeを削除する（切断時） */
export function unregisterBridge(bridgeId: string): void {
  sessions.delete(bridgeId)
  // pending actsをtimeoutに（反復中のMap削除を避けるためスナップショットを取る）
  for (const [actId, pending] of Array.from(pendingActs.entries())) {
    if (actId.startsWith(`${bridgeId}:`)) {
      clearTimeout(pending.timer)
      pending.resolve({ act_id: actId.split(':')[1], status: 'timeout' })
      pendingActs.delete(actId)
    }
  }
  console.log(`[bridge] disconnected: ${bridgeId}`)
}

/** userId配下の全Bridgeセッションを取得 */
export function getBridgesByUser(userId: string): BridgeSession[] {
  return Array.from(sessions.values()).filter((s) => s.userId === userId)
}

/** bridge_idでセッションを取得 */
export function getBridgeById(bridgeId: string): BridgeSession | undefined {
  return sessions.get(bridgeId)
}

// ------------------------------------------------------------------
// Act転送
// ------------------------------------------------------------------

/** act指示をBridgeに送信し、結果をPromiseで返す */
export async function sendActToBridge(params: {
  bridgeId: string
  actId: string
  capabilityId: string
  action: string
  parameters: Record<string, unknown>
  timeoutMs?: number
}): Promise<ActResult> {
  const { bridgeId, actId, capabilityId, action, parameters, timeoutMs = 5000 } = params

  const session = sessions.get(bridgeId)
  if (!session) {
    return { act_id: actId, status: 'failed', result: { error: 'Bridge not connected' } }
  }

  const pendingKey = `${bridgeId}:${actId}`

  return new Promise<ActResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingActs.delete(pendingKey)
      resolve({ act_id: actId, status: 'timeout' })
    }, timeoutMs)

    pendingActs.set(pendingKey, { resolve, reject, timer })

    try {
      session.ws.send(JSON.stringify({
        type: 'act',
        act_id: actId,
        capability_id: capabilityId,
        action,
        parameters,
      }))
    } catch (err) {
      clearTimeout(timer)
      pendingActs.delete(pendingKey)
      resolve({ act_id: actId, status: 'failed', result: { error: String(err) } })
    }
  })
}

/** Bridgeからのact_resultを受け取り、pending Promiseを解決する */
export function resolveActResult(bridgeId: string, actId: string, status: 'completed' | 'failed', result: unknown): void {
  const pendingKey = `${bridgeId}:${actId}`
  const pending = pendingActs.get(pendingKey)
  if (!pending) {
    console.warn(`[bridge] no pending act: ${pendingKey}`)
    return
  }
  clearTimeout(pending.timer)
  pendingActs.delete(pendingKey)
  pending.resolve({ act_id: actId, status, result })
}

// ------------------------------------------------------------------
// Sense保存
// ------------------------------------------------------------------

/** sense入力をsense_logテーブルに保存 */
export async function saveSenseLog(params: {
  userId: string
  bridgeId: string
  capabilityId: string
  data: unknown
}): Promise<{ sense_id: string; processed: boolean }> {
  const { userId, bridgeId, capabilityId, data } = params

  const { data: row, error } = await supabase
    .from('sense_log')
    .insert({
      user_id: userId,
      bridge_id: bridgeId,
      capability_id: capabilityId,
      data,
      processed: false,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[bridge] saveSenseLog error:', error)
    throw new Error(`sense_log insert failed: ${error.message}`)
  }

  return { sense_id: row.id as string, processed: false }
}

// ------------------------------------------------------------------
// Capability管理
// ------------------------------------------------------------------

export interface Capability {
  id: string
  type: 'sense' | 'act'
  name: string
  description?: string
  actions?: string[]
  data_type?: string
  target_device?: string
  config?: Record<string, unknown>
}

/** Bridgeのcapabilityを登録・更新する */
export async function registerCapabilities(params: {
  userId: string
  bridgeId: string
  bridgeName: string
  capabilities: Capability[]
}): Promise<void> {
  const { userId, bridgeId, bridgeName, capabilities } = params

  // bridgesテーブルをupsert
  const { error: bridgeErr } = await supabase
    .from('bridges')
    .upsert({
      id: bridgeId,
      user_id: userId,
      name: bridgeName,
      status: 'online',
      last_seen_at: new Date().toISOString(),
    })

  if (bridgeErr) {
    console.error('[bridge] upsert bridges error:', bridgeErr)
  }

  // capabilitiesを一括upsert
  if (capabilities.length > 0) {
    const rows = capabilities.map((cap) => ({
      id: cap.id,
      bridge_id: bridgeId,
      user_id: userId,
      type: cap.type,
      name: cap.name,
      description: cap.description ?? null,
      config: {
        actions: cap.actions,
        data_type: cap.data_type,
        target_device: cap.target_device,
        ...cap.config,
      },
    }))

    const { error: capErr } = await supabase
      .from('capabilities')
      .upsert(rows)

    if (capErr) {
      console.error('[bridge] upsert capabilities error:', capErr)
    }
  }
}

/** Bridge切断時にステータスをofflineに更新 */
export async function markBridgeOffline(bridgeId: string): Promise<void> {
  await supabase
    .from('bridges')
    .update({ status: 'offline', last_seen_at: new Date().toISOString() })
    .eq('id', bridgeId)
}
