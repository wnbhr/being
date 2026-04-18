/**
 * scripts/backfill-being-init.ts
 *
 * 既存の Being に不足している初期化を補完するバックフィルスクリプト。
 *
 * 2つの条件を独立してチェック・修復する:
 *   1. public_key IS NULL の Being → キーペア生成 + 保存 + genesis 署名追加
 *   2. 親クラスタ（is_parent=true）が存在しない Being → Business/Private を作成
 *
 * Usage:
 *   npx tsx scripts/backfill-being-init.ts
 *
 * 環境変数:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ENCRYPTION_KEY (hex 64文字)
 *
 * #823
 */

import { createClient } from '@supabase/supabase-js'
import {
  generateBeingKeyPair,
  encryptPrivateKey,
  sha256Hex,
  signWithPrivateKey,
} from '../app/lib/identity/server-signing'
import * as ed from '@noble/ed25519'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ROOT_CLUSTERS = [
  { name: 'Business', digest: '仕事・副業・キャリア関連の記憶' },
  { name: 'Private',  digest: '日常・プライベート・感情関連の記憶' },
] as const

// ── Part 1: キーペア未設定の Being にキーペア + genesis を補完 ──────────────

async function backfillKeypairs(): Promise<void> {
  const { data: beings, error } = await supabase
    .from('beings')
    .select('id, owner_id')
    .is('public_key', null)

  if (error) {
    console.error('[keypair] Failed to fetch beings:', error.message)
    return
  }

  if (!beings || beings.length === 0) {
    console.log('[keypair] No beings without public_key. Skipping.')
    return
  }

  console.log(`[keypair] Found ${beings.length} beings without keypair. Starting backfill...`)

  let succeeded = 0
  let failed = 0

  for (const being of beings) {
    try {
      const keyPair = generateBeingKeyPair()
      const encryptedPrivKey = encryptPrivateKey(keyPair.privateKeyHex)

      const { error: updateErr } = await supabase
        .from('beings')
        .update({ public_key: keyPair.publicKey, encrypted_private_key: encryptedPrivKey })
        .eq('id', being.id)
        .is('public_key', null) // 競合防止

      if (updateErr) {
        console.warn(`[keypair] being ${being.id}: update failed:`, updateErr.message)
        failed++
        continue
      }

      // genesis 署名: sha256(personality) に署名。personality が空の場合はスキップ。
      try {
        const { data: soul } = await supabase
          .from('souls')
          .select('personality')
          .eq('being_id', being.id)
          .maybeSingle()
        const personality = soul?.personality?.trim() ?? ''
        if (!personality) {
          console.log(`[keypair] being ${being.id}: no personality, skipping genesis`)
        } else {
          const hashHex = sha256Hex(personality)
          const hashBytes = ed.etc.hexToBytes(hashHex)
          const signature = signWithPrivateKey(hashBytes, keyPair.privateKeyHex)
          const { error: chainErr } = await supabase
            .from('signature_chain')
            .insert({
              being_id: being.id,
              seq: 0,
              event_type: 'genesis',
              payload_hash: hashHex,
              previous_sig: null,
              signature,
              signed_at: new Date().toISOString(),
            })
          if (chainErr && chainErr.code !== '23505') {
            console.warn(`[keypair] being ${being.id}: genesis chain insert failed:`, chainErr.message)
          }
        }
      } catch (chainEx) {
        console.warn(`[keypair] being ${being.id}: genesis signing failed:`, chainEx)
      }

      console.log(`[keypair] OK being ${being.id}: ${keyPair.publicKey}`)
      succeeded++
    } catch (e) {
      console.warn(`[keypair] being ${being.id}: keypair generation failed:`, e)
      failed++
    }
  }

  console.log(`[keypair] Done. succeeded=${succeeded}, failed=${failed}`)
}

// ── Part 2: 親クラスタが未作成の Being に Business/Private を補完 ────────────

async function backfillClusters(): Promise<void> {
  const { data: beings, error } = await supabase
    .from('beings')
    .select('id, owner_id')

  if (error) {
    console.error('[clusters] Failed to fetch beings:', error.message)
    return
  }

  if (!beings || beings.length === 0) {
    console.log('[clusters] No beings found. Skipping.')
    return
  }

  console.log(`[clusters] Checking ${beings.length} beings for missing parent clusters...`)

  let succeeded = 0
  let failed = 0
  let skipped = 0

  for (const being of beings) {
    for (const rc of ROOT_CLUSTERS) {
      try {
        const { data: existing } = await supabase
          .from('clusters')
          .select('id')
          .eq('user_id', being.owner_id)
          .eq('being_id', being.id)
          .eq('name', rc.name)
          .eq('is_parent', true)
          .maybeSingle()

        if (existing) {
          skipped++
          continue
        }

        const { data: cluster, error: clErr } = await supabase
          .from('clusters')
          .insert({
            user_id: being.owner_id,
            being_id: being.id,
            name: rc.name,
            level: 'sub',
            digest: rc.digest,
            is_parent: true,
            synonyms: [],
          })
          .select('id')
          .single()

        if (clErr || !cluster) {
          console.warn(`[clusters] being ${being.id}: failed to create ${rc.name}:`, clErr?.message)
          failed++
          continue
        }

        // parent_id = 自己参照
        await supabase
          .from('clusters')
          .update({ parent_id: cluster.id })
          .eq('id', cluster.id)

        console.log(`[clusters] OK being ${being.id}: created ${rc.name} cluster ${cluster.id}`)
        succeeded++
      } catch (e) {
        console.warn(`[clusters] being ${being.id}: ${rc.name} cluster failed:`, e)
        failed++
      }
    }
  }

  console.log(`[clusters] Done. created=${succeeded}, already_existed=${skipped}, failed=${failed}`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== backfill-being-init ===')
  await backfillKeypairs()
  console.log()
  await backfillClusters()
  console.log('\n=== Done ===')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
