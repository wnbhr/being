/**
 * being-worker/src/lib/identity/verify.ts
 *
 * Being Identity — Ed25519 署名検証ユーティリティ
 *
 * spec-40 §Layer 2 の署名仕様:
 *   genesis (seq=0): payload_hash = sha256(SOUL初期状態)
 *   seq > 0:         payload_hash = sha256(diffJson + previousSig)
 *
 * どちらも署名対象は hexToBytes(payload_hash)（32バイト生バイト列）で統一。
 * 生成側（app/api/beings/[id]/identity/sign/route.ts）との対応:
 *   sign(secret_key, hexToBytes(payload_hash)) → 検証側も同じバイト列で verify
 *
 * ⚠️ 秘密鍵はサーバーに置かない。検証のみ。
 */

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

/**
 * Ed25519 公開鍵（"ed25519:<hex>" 形式）でチェーンエントリの署名を検証する
 *
 * @param publicKeyStr  "ed25519:<hex>" 形式の公開鍵
 * @param payloadHash   sha256 ハッシュの hex 文字列
 * @param signatureHex  署名の hex 文字列
 * @returns 検証成功なら true
 */
export async function verifyChainEntry(
  publicKeyStr: string,
  payloadHash: string,
  signatureHex: string,
): Promise<boolean> {
  if (!publicKeyStr.startsWith('ed25519:')) return false
  const pubKeyHex = publicKeyStr.slice('ed25519:'.length)
  try {
    const pubKeyBytes = hexToBytes(pubKeyHex)
    const sigBytes = hexToBytes(signatureHex)
    const messageBytes = hexToBytes(payloadHash)  // 32バイト生バイト列（生成側と一致）
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      pubKeyBytes.buffer as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify']
    )
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      cryptoKey,
      sigBytes.buffer as ArrayBuffer,
      messageBytes.buffer as ArrayBuffer
    )
  } catch {
    return false
  }
}
