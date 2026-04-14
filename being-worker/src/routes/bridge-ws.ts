/**
 * Bridge WebSocket Route — /v1/beings/:being_id/bridge/ws
 *
 * Bridge App（スマホアプリ）がここに接続する。
 * - 接続時: Being APIトークン認証 + capabilities登録メッセージで初期化
 * - sense入力受信 → sense_logに保存
 * - act指示送信 → Bridgeが実行 → act_result返却
 * - heartbeat: ping/pong
 *
 * #239: パスを /api/engine/bridge/ws → /v1/beings/:being_id/bridge/ws に変更
 *       認証を JWT → Being APIトークン（Authorization: Bearer <brt_...>）に変更
 */

import type { FastifyPluginAsync } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config.js'
import {
  registerBridge,
  unregisterBridge,
  registerCapabilities,
  markBridgeOffline,
  saveSenseLog,
  resolveActResult,
  type Capability,
} from '../bridge/bridge-manager.js'

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey)

// ------------------------------------------------------------------
// メッセージ型定義
// ------------------------------------------------------------------

interface WsMessageBase {
  type: string
}

interface WsRegisterMessage extends WsMessageBase {
  type: 'register'
  bridge_id: string
  bridge_name: string
  capabilities: Capability[]
}

interface WsSenseMessage extends WsMessageBase {
  type: 'sense'
  capability_id: string
  data: unknown
}

interface WsActResultMessage extends WsMessageBase {
  type: 'act_result'
  act_id: string
  status: 'completed' | 'failed'
  result?: unknown
}

interface WsDisconnectMessage extends WsMessageBase {
  type: 'disconnect'
  bridge_id?: string
}

interface WsPongMessage extends WsMessageBase {
  type: 'pong'
}

type WsMessage = WsRegisterMessage | WsSenseMessage | WsActResultMessage | WsDisconnectMessage | WsPongMessage

// ------------------------------------------------------------------
// Being API トークン検証（#239: JWT → Being API token）
// ------------------------------------------------------------------

interface AuthResult {
  userId: string
}

async function verifyBeingApiToken(token: string, beingId: string): Promise<AuthResult | null> {
  const { createHash } = await import('crypto')
  const tokenHash = createHash('sha256').update(token).digest('hex')

  const { data: tokenRow } = await supabase
    .from('being_api_tokens')
    .select('user_id, revoked_at')
    .eq('token_hash', tokenHash)
    .single()

  if (!tokenRow || tokenRow.revoked_at) return null

  // being が token の user に属するか確認
  const { data: being } = await supabase
    .from('beings')
    .select('id')
    .eq('id', beingId)
    .eq('owner_id', tokenRow.user_id)
    .single()

  if (!being) return null

  return { userId: tokenRow.user_id }
}

// ------------------------------------------------------------------
// WebSocketルート
// ------------------------------------------------------------------

export const bridgeWsRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { being_id: string } }>(
    '/v1/beings/:being_id/bridge/ws',
    { websocket: true },
    async (socket: WebSocket, request) => {
      const { being_id } = request.params as { being_id: string }

      // 認証: Authorization headerまたはquery param ?token=
      const authHeader = request.headers.authorization
      const queryToken = (request.query as Record<string, string>)?.token

      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : queryToken

      if (!token) {
        socket.send(JSON.stringify({ type: 'error', message: 'Authorization required' }))
        socket.close(1008, 'Unauthorized')
        return
      }

      const auth = await verifyBeingApiToken(token, being_id)
      if (!auth) {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid token' }))
        socket.close(1008, 'Unauthorized')
        return
      }

      const { userId } = auth
      let bridgeId: string | null = null
      let pingInterval: ReturnType<typeof setInterval> | null = null

      socket.send(JSON.stringify({ type: 'connected', message: 'Authenticated. Send register message.' }))

      pingInterval = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30_000)

      socket.on('message', async (raw: Buffer | string) => {
        let msg: WsMessage
        try {
          msg = JSON.parse(raw.toString()) as WsMessage
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
          return
        }

        switch (msg.type) {
          case 'register': {
            const regMsg = msg as WsRegisterMessage
            if (!regMsg.bridge_id || !regMsg.bridge_name) {
              socket.send(JSON.stringify({ type: 'error', message: 'bridge_id and bridge_name are required' }))
              return
            }
            bridgeId = regMsg.bridge_id
            registerBridge({ bridgeId, userId, bridgeName: regMsg.bridge_name, ws: socket })
            try {
              await registerCapabilities({
                userId,
                bridgeId,
                bridgeName: regMsg.bridge_name,
                capabilities: regMsg.capabilities ?? [],
              })
            } catch (err) {
              console.error('[bridge-ws] registerCapabilities error:', err)
            }
            socket.send(JSON.stringify({
              type: 'registered',
              bridge_id: bridgeId,
              capabilities_count: (regMsg.capabilities ?? []).length,
            }))
            console.log(`[bridge-ws] registered: ${bridgeId} user=${userId} caps=${(regMsg.capabilities ?? []).length}`)
            break
          }

          case 'sense': {
            const senseMsg = msg as WsSenseMessage
            if (!bridgeId) {
              socket.send(JSON.stringify({ type: 'error', message: 'Not registered. Send register first.' }))
              return
            }
            if (!senseMsg.capability_id) {
              socket.send(JSON.stringify({ type: 'error', message: 'capability_id is required' }))
              return
            }
            try {
              const saved = await saveSenseLog({ userId, bridgeId, capabilityId: senseMsg.capability_id, data: senseMsg.data })
              socket.send(JSON.stringify({ type: 'sense_ack', sense_id: saved.sense_id }))
            } catch (err) {
              console.error('[bridge-ws] saveSenseLog error:', err)
              socket.send(JSON.stringify({ type: 'error', message: 'Failed to save sense input' }))
            }
            break
          }

          case 'act_result': {
            const resultMsg = msg as WsActResultMessage
            if (!bridgeId) { socket.send(JSON.stringify({ type: 'error', message: 'Not registered.' })); return }
            if (!resultMsg.act_id) { socket.send(JSON.stringify({ type: 'error', message: 'act_id is required' })); return }
            resolveActResult(bridgeId, resultMsg.act_id, resultMsg.status, resultMsg.result)
            break
          }

          case 'disconnect': {
            if (bridgeId) {
              unregisterBridge(bridgeId)
              try { await markBridgeOffline(bridgeId) } catch (err) { console.error('[bridge-ws] markBridgeOffline error:', err) }
            }
            socket.close(1000, 'Goodbye')
            break
          }

          case 'pong': break

          default:
            socket.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${(msg as WsMessageBase).type}` }))
        }
      })

      socket.on('close', async () => {
        if (pingInterval) clearInterval(pingInterval)
        if (bridgeId) {
          unregisterBridge(bridgeId)
          try { await markBridgeOffline(bridgeId) } catch (err) { console.error('[bridge-ws] markBridgeOffline error:', err) }
          console.log(`[bridge-ws] closed: ${bridgeId}`)
        }
      })

      socket.on('error', (err: Error) => { console.error('[bridge-ws] socket error:', err) })
    }
  )
}
