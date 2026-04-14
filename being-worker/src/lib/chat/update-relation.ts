/**
 * update-relation.ts — #149 update_relation ツール（Function Calling）
 *
 * relations テーブルに直接書き込む専用ツール。
 * being_id は converse ルートで確定済みのため input に含めない。
 *
 * relations テーブルスキーマ:
 *   id          UUID PK
 *   being_id    UUID NOT NULL (FK → beings)
 *   target_type TEXT NOT NULL  （person / device / ai など）
 *   target_id   TEXT NOT NULL  （エンティティ名 or ID）
 *   context     TEXT           （関係性の説明・詳細）
 *   created_at  TIMESTAMPTZ
 *   updated_at  TIMESTAMPTZ
 *   UNIQUE(being_id, target_type, target_id)
 */

import { createClient } from '@supabase/supabase-js'

// ──────────────────────────────────────────────
// ツール定義（Anthropic tools配列に渡す）
// ──────────────────────────────────────────────

export const UPDATE_RELATION_TOOL = {
  name: 'update_relation',
  description:
    'Being の関係性（relations テーブル）を更新する。人・デバイス・AIなど外部エンティティとの関係を記録・削除できる。',
  input_schema: {
    type: 'object' as const,
    properties: {
      entity_name: {
        type: 'string',
        description:
          '関係先エンティティの名前または識別子。例: "田中さん", "Alexa", "GPT-4"',
      },
      relation_type: {
        type: 'string',
        description:
          'エンティティの種別。例: "person", "device", "ai", "organization"',
      },
      content: {
        type: 'string',
        description: '関係性の説明・詳細。upsert 時は必須。delete 時は無視される。',
      },
      action: {
        type: 'string',
        enum: ['upsert', 'delete'],
        description:
          'upsert: 存在しなければ作成、あれば context を上書き。delete: 該当レコードを削除。',
      },
    },
    required: ['entity_name', 'relation_type', 'action'],
  },
} as const

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface UpdateRelationInput {
  entity_name: string
  relation_type: string
  content?: string
  action: 'upsert' | 'delete'
}

export interface UpdateRelationResult {
  success: boolean
  message: string
}

// ──────────────────────────────────────────────
// handleUpdateRelation — DB書き込みハンドラ
// ──────────────────────────────────────────────

export async function handleUpdateRelation(
  beingId: string,
  input: UpdateRelationInput
): Promise<UpdateRelationResult> {
  const { entity_name, relation_type, content, action } = input

  // service_role クライアントで直接書き込む
  const serviceSupabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // being_id ガード: beings テーブルで存在確認（自分の being のみ操作可）
  const { data: being, error: beingError } = await serviceSupabase
    .from('beings')
    .select('id')
    .eq('id', beingId)
    .single()

  if (beingError || !being) {
    console.error('[update_relation] being not found or access denied:', beingId, beingError)
    return { success: false, message: `Being が見つかりません: ${beingId}` }
  }

  try {
    if (action === 'delete') {
      const { error } = await serviceSupabase
        .from('relations')
        .delete()
        .eq('being_id', beingId)
        .eq('target_type', relation_type)
        .eq('target_id', entity_name)

      if (error) throw error
      return {
        success: true,
        message: `relations[${relation_type}:${entity_name}] を削除しました`,
      }
    }

    // upsert
    if (!content) {
      return { success: false, message: 'upsert には content が必要です' }
    }

    const { error } = await serviceSupabase
      .from('relations')
      .upsert(
        {
          being_id: beingId,
          target_type: relation_type,
          target_id: entity_name,
          context: content,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'being_id,target_type,target_id' }
      )

    if (error) throw error
    return {
      success: true,
      message: `relations[${relation_type}:${entity_name}] を更新しました`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[update_relation] failed:', message)
    return { success: false, message: `エラーが発生しました: ${message}` }
  }
}
