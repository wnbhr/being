/**
 * verify.test.ts — Ed25519 署名検証ユニットテスト
 *
 * テスト対象: verifyChainEntry()
 * spec-40 §Layer 2 の検証ロジックを網羅する
 *
 * テストケース:
 *   1. genesis (seq=0): sha256(soulText) の署名が検証できる
 *   2. seq > 0: sha256(diffJson + previousSig) の署名が検証できる
 *   3. 不正な署名は検証失敗する
 *   4. チェーンの途中を改ざんした場合に検証失敗する
 *   5. 無効な公開鍵フォーマットは検証失敗する
 */

import { describe, it, expect } from 'vitest'
import { verifyChainEntry, hexToBytes } from './verify.js'

// ── テスト用ヘルパー ────────────────────────────────────────────────────────

/** テキストを SHA-256 ハッシュ化して hex 文字列で返す */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Ed25519 鍵ペアを生成してテスト用に返す */
async function generateKeyPair(): Promise<{
  publicKeyStr: string
  sign: (payloadHash: string) => Promise<string>
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  )

  const pubKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  const pubKeyHex = bytesToHex(new Uint8Array(pubKeyRaw))
  const publicKeyStr = `ed25519:${pubKeyHex}`

  const sign = async (payloadHash: string): Promise<string> => {
    const messageBytes = hexToBytes(payloadHash)
    const sigBuffer = await crypto.subtle.sign(
      { name: 'Ed25519' },
      keyPair.privateKey,
      messageBytes.buffer as ArrayBuffer
    )
    return bytesToHex(new Uint8Array(sigBuffer))
  }

  return { publicKeyStr, sign }
}

// ── テスト ──────────────────────────────────────────────────────────────────

describe('verifyChainEntry', () => {
  it('genesis (seq=0): sha256(soulText) の署名を正しく検証できる', async () => {
    const { publicKeyStr, sign } = await generateKeyPair()

    // genesis: payload_hash = sha256(SOUL初期状態)
    const soulText = JSON.stringify({ name: 'テストパートナー', personality: '穏やか' })
    const payloadHash = await sha256Hex(soulText)
    const signature = await sign(payloadHash)

    const result = await verifyChainEntry(publicKeyStr, payloadHash, signature)
    expect(result).toBe(true)
  })

  it('seq > 0: sha256(diffJson + previousSig) の署名を正しく検証できる', async () => {
    const { publicKeyStr, sign } = await generateKeyPair()

    // genesis の署名を生成
    const soulText = JSON.stringify({ name: 'テストパートナー', personality: '穏やか' })
    const genesisPayloadHash = await sha256Hex(soulText)
    const genesisSig = await sign(genesisPayloadHash)

    // seq=1: payload_hash = sha256(diffJson + previousSig)
    const diffJson = JSON.stringify({ souls: [{ name: 'テストパートナー v2', updated_at: '2026-04-13' }] })
    const payloadHash = await sha256Hex(diffJson + genesisSig)
    const signature = await sign(payloadHash)

    const result = await verifyChainEntry(publicKeyStr, payloadHash, signature)
    expect(result).toBe(true)
  })

  it('不正な署名（改ざん）は検証失敗する', async () => {
    const { publicKeyStr, sign } = await generateKeyPair()

    const soulText = JSON.stringify({ name: 'テストパートナー' })
    const payloadHash = await sha256Hex(soulText)
    await sign(payloadHash)

    // 別のペイロードに対する署名（改ざん）
    const tampered = await sha256Hex('別のデータ')
    const wrongSig = await sign(tampered)

    const result = await verifyChainEntry(publicKeyStr, payloadHash, wrongSig)
    expect(result).toBe(false)
  })

  it('チェーンの途中を改ざんした場合に検証失敗する', async () => {
    const { publicKeyStr, sign } = await generateKeyPair()

    // genesis 署名
    const soulText = JSON.stringify({ name: 'テストパートナー' })
    const genesisPayloadHash = await sha256Hex(soulText)
    const genesisSig = await sign(genesisPayloadHash)

    // 正規の seq=1
    const diffJson = JSON.stringify({ souls: [{ name: 'v2' }] })
    const realPayloadHash = await sha256Hex(diffJson + genesisSig)
    const realSig = await sign(realPayloadHash)

    // 改ざん: 別の previousSig を使ってハッシュを計算（チェーン切断）
    const tamperedPrevSig = '0'.repeat(128)
    const tamperedPayloadHash = await sha256Hex(diffJson + tamperedPrevSig)

    // 改ざんされた payload_hash に対して正規の署名を検証 → 失敗するはず
    const result = await verifyChainEntry(publicKeyStr, tamperedPayloadHash, realSig)
    expect(result).toBe(false)
  })

  it('無効な公開鍵フォーマット（ed25519: プレフィックスなし）は false を返す', async () => {
    const { sign } = await generateKeyPair()
    const payloadHash = await sha256Hex('test')
    const signature = await sign(payloadHash)

    // プレフィックスなし
    const result = await verifyChainEntry('invalidpublickey', payloadHash, signature)
    expect(result).toBe(false)
  })

  it('署名が空文字列の場合は false を返す（クラッシュしない）', async () => {
    const { publicKeyStr } = await generateKeyPair()
    const payloadHash = await sha256Hex('test')

    const result = await verifyChainEntry(publicKeyStr, payloadHash, '')
    expect(result).toBe(false)
  })
})
