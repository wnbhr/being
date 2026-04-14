/**
 * web-push.ts — #267: Web Push通知
 *
 * broadcastDone 後にタブが非表示の場合にPush通知を送信する。
 * Visibility API をクライアント側で管理するため、
 * Worker側では「DB上のサブスクリプション」が存在すれば送信する（二重通知はService Workerのtagで制御）。
 */

import webpush from 'web-push'
import { config } from '../config.js'

// VAPID鍵の設定
let vapidConfigured = false
function ensureVapid() {
  if (vapidConfigured) return
  // Being WorkerはNext.jsではないのでNEXT_PUBLIC_プレフィックスなし。
  // ただしVercel側と同じ鍵を共有する場合のフォールバックとしてNEXT_PUBLIC_も参照する
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com'
  if (!publicKey || !privateKey) return
  webpush.setVapidDetails(subject, publicKey, privateKey)
  vapidConfigured = true
}

// ユーザーごとの最終Push送信時刻（30秒スロットル）
const lastPushMap = new Map<string, number>()
const PUSH_THROTTLE_MS = 30_000

interface PushSubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * ユーザーのPush購読一覧を取得し、全デバイスに通知を送信する
 */
export async function sendWebPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string }
): Promise<void> {
  ensureVapid()
  if (!vapidConfigured) return // VAPID未設定はスキップ

  // スロットル: 30秒以内に同じユーザーへ送信済みならスキップ（連続メッセージの通知音連打を防ぐ）
  const now = Date.now()
  const last = lastPushMap.get(userId) ?? 0
  if (now - last < PUSH_THROTTLE_MS) return
  lastPushMap.set(userId, now)

  const supabaseUrl = config.supabaseUrl
  const serviceRoleKey = config.supabaseServiceRoleKey
  if (!supabaseUrl || !serviceRoleKey) return

  // push_subscriptions取得
  let subscriptions: PushSubscriptionRow[] = []
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/push_subscriptions?user_id=eq.${userId}&select=endpoint,p256dh,auth`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        signal: AbortSignal.timeout(5000),
      }
    )
    if (!res.ok) return
    subscriptions = await res.json()
  } catch {
    return
  }

  if (subscriptions.length === 0) return

  const payloadStr = JSON.stringify(payload)
  const expiredEndpoints: string[] = []

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadStr,
          { TTL: 60 * 60 } // 1時間TTL
        )
      } catch (err: unknown) {
        // 410 Gone = サブスクリプション失効 → 削除対象
        const code = err && typeof err === 'object' && 'statusCode' in err ? (err as { statusCode: number }).statusCode : 0
        if (code === 410 || code === 404) { // 410 Gone / 404 = サブスクリプション失効
          expiredEndpoints.push(sub.endpoint)
        } else if (code !== 0) {
          console.warn('[web-push] send failed:', err)
        }
      }
    })
  )

  // 失効したサブスクリプションを削除（non-fatal）
  if (expiredEndpoints.length > 0) {
    try {
      for (const endpoint of expiredEndpoints) {
        await fetch(
          `${supabaseUrl}/rest/v1/push_subscriptions?user_id=eq.${userId}&endpoint=eq.${encodeURIComponent(endpoint)}`,
          {
            method: 'DELETE',
            headers: {
              apikey: serviceRoleKey,
              Authorization: `Bearer ${serviceRoleKey}`,
            },
            signal: AbortSignal.timeout(5000),
          }
        )
      }
    } catch {
      // 削除失敗は無視
    }
  }
}
