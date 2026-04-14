/**
 * update-notes.ts — update_notes ツール定義とハンドラ
 *
 * #614: conclude_topic → update_notes リネーム + 巡回自動トリガー
 * #722: scenes 構造化オブジェクト配列 + action=update 追加 + archiveCurrentMessages 削除
 * #778: 巡回トリガー条件からllmApiKey除外 + BYOKキーDBから取得
 *
 * 会話で進展があった時にnotesを更新する。
 * シーンとメモを保存し、蓄積量に応じて巡回を自動発火する。
 */

import type { MemoryStore } from '../memory/types.js'
import type { SupabaseClient } from '@supabase/supabase-js'

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface SceneInput {
  action: string          // 必須: 何が起きたか
  actors: string[]        // 必須: 誰が
  when: string[]          // 必須: 日付（YYYY-MM-DD）
  setting?: string        // どこで、どんな状況で
  feeling?: string        // 主観的な感想（一人称）
  themes?: string[]       // テーマタグ
  importance?: number     // 0.0-1.0
}

export interface UpdateNotesInput {
  summary?: string  // deprecated: 後方互換のため残す
  action?: 'append' | 'update'  // デフォルト: 'append'
  scenes?: SceneInput[]
  notes?: string[]
  scene_ids?: string[]  // action=update 時に削除する既存 scene の ID
}

// ──────────────────────────────────────────────
// ツール定義（Anthropic tool_use形式）
// ──────────────────────────────────────────────

export const UPDATE_NOTES_TOOL = {
  name: 'update_notes',
  description:
    '会話で進展があった時にnotesを更新する。scenesは巡回で記憶ノードに変換される印象的な記憶の断片（type=scene）。notesはそのまま残す走り書きメモ（type=note）。scenes or notes のどちらか1つ以上を渡すこと。scene蓄積量に応じて巡回を自動発火する。',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['append', 'update'],
        description: 'append=追加（デフォルト）, update=既存sceneを統合置換',
      },
      scenes: {
        type: 'array',
        description: 'この会話で生まれた印象的なシーン・記憶の断片（任意）。巡回時に記憶ノードへ変換される。',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', description: '何が起きたか（必須）' },
            setting: { type: 'string', description: 'どこで、どんな状況で' },
            actors: { type: 'array', items: { type: 'string' }, description: '誰が' },
            feeling: { type: 'string', description: '主観的な感想（一人称）' },
            themes: { type: 'array', items: { type: 'string' }, description: 'テーマタグ' },
            importance: { type: 'number', description: '重要度 0.0-1.0' },
            when: { type: 'array', items: { type: 'string' }, description: '日付（YYYY-MM-DD）' },
          },
          required: ['action', 'actors', 'when'],
        },
      },
      notes: {
        type: 'array',
        description: '走り書きメモ（任意）。巡回では消費されず、そのまま残る。タスク・メモ・未解決事項など。各要素は短い文字列。',
        items: { type: 'string' },
      },
      scene_ids: {
        type: 'array',
        description: 'action=update時に削除する既存sceneのID',
        items: { type: 'string' },
      },
    },
    required: [],
  },
}

// ──────────────────────────────────────────────
// オプション型
// ──────────────────────────────────────────────

export interface UpdateNotesOptions {
  llmApiKey?: string
  beingId?: string
  userId?: string
  partnerType?: string
  /** Supabase client — BYOKキーのDB取得に使用（#778） */
  supabase?: SupabaseClient
}

// ──────────────────────────────────────────────
// ハンドラ
// ──────────────────────────────────────────────

export async function handleUpdateNotes(
  store: MemoryStore,
  input: UpdateNotesInput,
  options: UpdateNotesOptions = {}
): Promise<string> {
  const { action = 'append', scenes, notes, scene_ids } = input
  const { llmApiKey, beingId, userId, partnerType, supabase } = options

  if ((!scenes || scenes.length === 0) && (!notes || notes.length === 0)) {
    return 'error: scenes or notes のどちらか1つ以上を渡してください'
  }

  try {
    // 1. action=update: 指定 scene_ids を削除してから新 scenes を insert
    if (action === 'update' && scene_ids && scene_ids.length > 0) {
      try {
        await store.deleteNotesByIds(scene_ids)
      } catch (deleteErr) {
        console.warn('[update_notes] deleteNotesByIds failed (ignored):', deleteErr)
      }
    }

    // 2. scenes を notes(type='scene') に保存（non-fatal）
    if (scenes && scenes.length > 0) {
      try {
        await Promise.all(scenes.map((s) => store.insertSceneNote(JSON.stringify(s))))
      } catch (scenesErr) {
        console.warn('[update_notes] insertSceneNote failed (ignored):', scenesErr)
      }
    }

    // 3. notes を type='note' で保存（non-fatal）
    if (notes && notes.length > 0) {
      try {
        await Promise.all(notes.map((n) => store.insertNote(n)))
      } catch (notesErr) {
        console.warn('[update_notes] insertNote failed (ignored):', notesErr)
      }
    }

    // 4. 巡回自動トリガー（fire-and-forget）
    // condition: scene数 >= 10（noteは対象外）
    // #778: llmApiKey非依存化 — beingId/userIdのみ必要。BYOKキーはDB取得
    if (beingId && userId) {
      try {
        const sceneNotes = await store.getNotesByType('scene')
        const shouldTrigger = sceneNotes.length >= 10

        if (shouldTrigger) {
          // BYOKキー取得: ヘッダー渡し → DB取得 → undefined の優先順
          let resolvedApiKey: string | undefined = llmApiKey
          if (!resolvedApiKey && supabase) {
            try {
              const { getApiKeyFromTable } = await import('../chat/api-key.js')
              resolvedApiKey = await getApiKeyFromTable(supabase, userId, 'anthropic')
            } catch {
              // BYOKキー未設定 → 機械的処理のみで巡回（resolvedApiKey = undefined）
            }
          }

          const { runPatrolWithMessages } = await import('../../worker/patrol.js')
          runPatrolWithMessages({
            userId,
            beingId,
            partnerType: partnerType ?? 'default',
            messages: [],
            markerIdFrom: null,
            llmApiKey: resolvedApiKey || undefined,
          }).catch((err: unknown) => {
            console.warn('[update_notes] patrol auto-trigger failed (ignored):', err)
          })
        }
      } catch (patrolErr) {
        console.warn('[update_notes] patrol trigger check failed (ignored):', patrolErr)
      }
    }

    // 5. notes棚卸し: 未処理のnotesを一覧で返す（失敗しても update_notes 自体は成功扱い）
    let notesSection = ''
    try {
      const allNotes = await store.getAllNotes()
      if (allNotes.length > 0) {
        const notesList = allNotes.map((n) => `- [${n.id}] ${n.content}`).join('\n')
        notesSection = `\n\n📝 未処理のノート(${allNotes.length}件):\n${notesList}\n→ 完了済みのものはupdate_memory(target=notes, action=delete, key=<id>)で削除し、持ち越したい情報があればupdate_memory(target=notes, action=append)で追加してください。`
      }
    } catch (notesErr) {
      console.warn('[update_notes] getAllNotes failed (ignored):', notesErr)
    }

    return `ok: notes updated.${notesSection}`
  } catch (err) {
    console.error('[update_notes] failed:', err)
    return `error: ${String(err)}`
  }
}
