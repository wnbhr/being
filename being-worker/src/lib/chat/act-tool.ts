/**
 * Act ツールハンドラ
 *
 * パートナーがcapabilityベースのツールを呼び出したとき、
 * act_log に記録してBridgeにWebSocket経由で転送し、結果を返す。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendActToBridge } from '../../bridge/bridge-manager.js'

export interface ActToolInput {
  capability_id: string
  bridge_id: string
  action: string
  parameters?: Record<string, unknown>
  timeout_ms?: number
}

export async function handleActTool(
  supabase: SupabaseClient,
  userId: string,
  toolInput: ActToolInput,
): Promise<string> {
  const {
    capability_id,
    bridge_id,
    action,
    parameters = {},
    timeout_ms = 5000,
  } = toolInput

  const actId = crypto.randomUUID()

  // act_log に pending で記録
  await supabase.from('act_log').insert({
    id: actId,
    user_id: userId,
    capability_id,
    bridge_id,
    action,
    parameters,
    status: 'pending',
  })

  // Bridge に送信
  let result
  try {
    result = await sendActToBridge({
      bridgeId: bridge_id,
      actId,
      capabilityId: capability_id,
      action,
      parameters,
      timeoutMs: timeout_ms,
    })
  } catch (err) {
    await supabase.from('act_log').update({
      status: 'failed',
      result: { error: String(err) },
      completed_at: new Date().toISOString(),
    }).eq('id', actId)
    return JSON.stringify({ act_id: actId, status: 'failed', error: String(err) })
  }

  // Bridge送信成功後にsentへ更新し、最終ステータスも更新
  await supabase.from('act_log').update({ status: 'sent' }).eq('id', actId)

  // act_log 更新
  await supabase.from('act_log').update({
    status: result.status,
    result: result.result ?? null,
    completed_at: new Date().toISOString(),
  }).eq('id', actId)

  return JSON.stringify({
    act_id: actId,
    status: result.status,
    result: result.result,
  })
}
