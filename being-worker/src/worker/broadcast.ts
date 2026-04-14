import { config } from '../config.js'

// #298: Supabase Realtime Broadcast を WebSocket ではなく REST API で送信
// channel.send() は Worker 環境での WebSocket 接続が不安定なため、
// REST エンドポイント（/realtime/v1/api/broadcast）を直接呼ぶ

const broadcastUrl = `${config.supabaseUrl}/realtime/v1/api/broadcast`
const broadcastHeaders = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${config.supabaseServiceRoleKey}`,
  'apikey': config.supabaseServiceRoleKey,
}

// Hotfix 2026-04-07: 10秒タイムアウト追加
// Supabase REST API無応答時にジョブがハングするのを防止。
// 正常時は100-500msで完了するため10秒は十分な余裕。
// タイムアウト時はログして続行（ジョブ全体をブロックしない）。
// done時のfull_textで最終テキストを補完するため、チャンク欠損の影響は軽微。
const BROADCAST_TIMEOUT_MS = 10_000

async function httpBroadcast(userId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BROADCAST_TIMEOUT_MS)
  try {
    const res = await fetch(broadcastUrl, {
      method: 'POST',
      headers: broadcastHeaders,
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          {
            topic: `chat:${userId}`,
            event: 'message',
            payload: { type: event, ...payload },
          },
        ],
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[broadcast] REST API error: ${res.status} ${text}`)
    }
  } catch (err: unknown) {
    // タイムアウトまたはネットワークエラー — ログして続行（ジョブをハングさせない）
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[broadcast] ${event} failed for ${userId.slice(0, 8)}:`, message)
  } finally {
    clearTimeout(timer)
  }
}

// チャンクバッファ（ユーザーごと）
const chunkBuffers = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>()
const BUFFER_INTERVAL_MS = 100

export async function broadcastChunk(userId: string, text: string): Promise<void> {
  let buf = chunkBuffers.get(userId)
  if (!buf) {
    buf = { text: '', timer: null }
    chunkBuffers.set(userId, buf)
  }
  buf.text += text

  if (!buf.timer) {
    buf.timer = setTimeout(async () => {
      const flushed = buf!.text
      buf!.text = ''
      buf!.timer = null
      if (!flushed) return
      await httpBroadcast(userId, 'chunk', { text: flushed })
    }, BUFFER_INTERVAL_MS)
  }
}

export async function flushChunkBuffer(userId: string): Promise<void> {
  const buf = chunkBuffers.get(userId)
  if (buf) {
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null }
    if (buf.text) {
      const flushed = buf.text
      buf.text = ''
      await httpBroadcast(userId, 'chunk', { text: flushed })
    }
    chunkBuffers.delete(userId)
  }
}

export async function broadcastDone(userId: string, fullText?: string): Promise<void> {
  await flushChunkBuffer(userId)
  await httpBroadcast(userId, 'done', fullText ? { full_text: fullText } : {})
}

export async function broadcastError(userId: string, message: string): Promise<void> {
  await flushChunkBuffer(userId)
  await httpBroadcast(userId, 'error', { error: message })
}

export async function broadcastToolUse(userId: string, toolName: string): Promise<void> {
  await httpBroadcast(userId, 'tool_use', { tool_name: toolName })
}
