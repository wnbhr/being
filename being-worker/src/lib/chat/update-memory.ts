/**
 * update-memory.ts — #17 update_memory ツール（Function Calling）
 *
 * spec-12「パートナーDB書き込みツール（Function Calling）」に基づく。
 * spec-35: partner_tools / partner_map / diary / notes へのアクセスを追加。
 *
 * #62: MemoryStore interface 経由に移行
 * #317: Vercel版 (lib/chat/update-memory.ts) と同期
 * #470: update/delete 時の key 必須化 + update 時に更新前の内容を返す
 */

import type { MemoryStore } from '../memory/types.js'

// ──────────────────────────────────────────────
// ツール定義（Anthropic tools配列に渡す）
// ──────────────────────────────────────────────

export const UPDATE_MEMORY_TOOL = {
  name: 'update_memory',
  description:
    'パートナーの記憶（preferences, knowledge, relationship, partner_tools, partner_map, diary, notes）を読み書きする。また、party_message targetでパーティメッセージを送信できる。\n\n' +
    'notes: ユーザーへのメモ・ノートを管理する。get=全件取得, append=新規追加, update=内容更新(key=id), delete=削除(key=id)\n\n' +
    '⚠️ souls / partner_rules の書き込みは、ユーザーが明示的に指示した場合のみ使用すること。\n\n' +
    '⚠️ update/delete 操作には必ず key を指定すること。key なしの update/delete は実行拒否されます。\n\n' +
    '【アクセス権限】このツールはユーザーの個人データにアクセスする。データはサービス提供目的のみに使用し、第三者提供はしない。ユーザーはデータの確認・修正・削除をいつでもリクエストできる。',
  input_schema: {
    type: 'object' as const,
    properties: {
      target: {
        type: 'string',
        enum: [
          'preferences',
          'knowledge',
          'relationship',
          'partner_tools',
          'partner_map',
          'diary',
          'notes',
          'party_message',
          'partner_rules',
          'souls',
        ],
        description: '更新対象',
      },
      action: {
        type: 'string',
        enum: ['get', 'append', 'update', 'delete'],
        description: '操作種別。get: 全件取得またはkey指定取得',
      },
      content: {
        type: 'string',
        description: '追記・更新する内容（get/delete時は省略可）',
      },
      key: {
        type: 'string',
        description:
          'update/delete/getで対象を絞る場合のキー（update/deleteでは必須）。preferences=key, knowledge/partner_tools/partner_map=title, relationship=person_name, diary=date(YYYY-MM-DD), partner_rules=id, souls=フィールド名(personality/voice/values/backstory/inner_world/examples)',
      },
      location: {
        type: 'string',
        description: 'partner_map upsert時のlocation（省略可）',
      },
      to: {
        type: 'string',
        description: '送信先パートナー名（party_message時のみ）',
      },
    },
    required: ['target', 'action'],
  },
} as const

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface UpdateMemoryInput {
  target:
    | 'preferences'
    | 'knowledge'
    | 'relationship'
    | 'partner_tools'
    | 'partner_map'
    | 'diary'
    | 'notes'
    | 'party_message'
    | 'partner_rules'
    | 'souls'
  action: 'get' | 'append' | 'update' | 'delete'
  content?: string
  key?: string
  location?: string
  to?: string
}

export interface UpdateMemoryResult {
  success: boolean
  message: string
}

// ──────────────────────────────────────────────
// requireKey — update/delete 時の key 必須チェック (#470)
// ──────────────────────────────────────────────

function requireKey(action: string, key: string | undefined, target: string): UpdateMemoryResult | null {
  if ((action === 'update' || action === 'delete') && !key) {
    return {
      success: false,
      message: `${target} の ${action} には key が必要です。keyを指定してから再実行してください。`,
    }
  }
  return null
}

// ──────────────────────────────────────────────
// handleUpdateMemory — DB読み書きハンドラ
// ──────────────────────────────────────────────

export async function handleUpdateMemory(
  store: MemoryStore,
  input: UpdateMemoryInput,
  partnerType?: string
): Promise<UpdateMemoryResult> {
  const { target, action, content = '', key, location } = input
  const pType = partnerType ?? 'default'

  try {
    switch (target) {
      // ─── preferences ───────────────────────────────
      case 'preferences': {
        if (action === 'get') {
          const prefs = await store.getPreferences()
          if (key) {
            const found = prefs.find((p) => p.key === key)
            return found
              ? { success: true, message: `preferences[${key}]: ${found.description}` }
              : { success: false, message: `preferences[${key}] が見つかりません` }
          }
          return { success: true, message: JSON.stringify(prefs) }
        }

        // #470: update/delete には key 必須
        const keyCheck = requireKey(action, key, target)
        if (keyCheck) return keyCheck

        const prefKey = key ?? content.slice(0, 50)

        if (action === 'delete') {
          await store.deletePreference(prefKey)
          return { success: true, message: `preferences[${prefKey}] を削除しました` }
        }

        // #470: update 前に既存データを取得して返す
        if (action === 'update') {
          const prefs = await store.getPreferences()
          const existing = prefs.find((p) => p.key === prefKey)
          await store.upsertPreference(prefKey, content)
          return {
            success: true,
            message: existing
              ? `preferences[${prefKey}] を更新しました。\n\n📋 更新前:\n${existing.description}\n\n📝 更新後:\n${content}`
              : `preferences[${prefKey}] を新規作成しました`,
          }
        }

        // append（preferencesはkeyを使ってupsert）
        await store.upsertPreference(prefKey, content)
        return { success: true, message: `preferences[${prefKey}] を追加しました` }
      }

      // ─── knowledge ─────────────────────────────────
      case 'knowledge': {
        if (action === 'get') {
          if (key) {
            const found = await store.getKnowledge(key)
            return found
              ? { success: true, message: `knowledge[${key}]: ${found.description}` }
              : { success: false, message: `knowledge[${key}] が見つかりません` }
          }
          const all = await store.getAllKnowledge()
          return { success: true, message: JSON.stringify(all) }
        }

        // #470: update/delete には key 必須
        const keyCheck = requireKey(action, key, target)
        if (keyCheck) return keyCheck

        const title = key ?? content.slice(0, 80)

        if (action === 'delete') {
          await store.deleteKnowledge(title)
          return { success: true, message: `knowledge[${title}] を削除しました` }
        }

        if (action === 'append') {
          const existing = await store.getKnowledge(title)
          if (existing) {
            const newContent = `${existing.description}\n\n${content}`
            await store.upsertKnowledge(title, newContent)
            return { success: true, message: `knowledge[${title}] に追記しました` }
          }
        }

        // #470: update 前に既存データを取得して返す
        if (action === 'update') {
          const existing = await store.getKnowledge(title)
          await store.upsertKnowledge(title, content)
          return {
            success: true,
            message: existing
              ? `knowledge[${title}] を更新しました。\n\n📋 更新前:\n${existing.description}\n\n📝 更新後:\n${content}`
              : `knowledge[${title}] を新規作成しました`,
          }
        }

        // append（existingなし）のfall-through
        await store.upsertKnowledge(title, content)
        return { success: true, message: `knowledge[${title}] を更新しました` }
      }

      // ─── relationship ───────────────────────────────
      case 'relationship': {
        if (action === 'get') {
          if (key) {
            // #471: pType でフィルタしてパートナー自身のプロフィールを参照
            const found = await store.getRelationship(key, pType)
            return found
              ? { success: true, message: `relationship[${key}]: ${found.description}` }
              : { success: false, message: `relationship[${key}] が見つかりません` }
          }
          const all = await store.getRelationships(pType)
          return { success: true, message: JSON.stringify(all) }
        }

        // #470: update/delete には key 必須
        const keyCheck = requireKey(action, key, target)
        if (keyCheck) return keyCheck

        const personName = key ?? 'unknown'

        if (action === 'delete') {
          await store.deleteRelationship(personName, pType)
          return { success: true, message: `relationship[${personName}] を削除しました` }
        }

        if (action === 'append') {
          const existing = await store.getRelationship(personName, pType)
          if (existing) {
            const newContent = `${existing.description}\n\n${content}`
            await store.upsertRelationship(personName, newContent, pType)
            return { success: true, message: `relationship[${personName}] に追記しました` }
          }
        }

        // #470: update 前に既存データを取得して返す
        if (action === 'update') {
          const existing = await store.getRelationship(personName, pType)
          await store.upsertRelationship(personName, content, pType)
          return {
            success: true,
            message: existing
              ? `relationship[${personName}] を更新しました。\n\n📋 更新前:\n${existing.description}\n\n📝 更新後:\n${content}`
              : `relationship[${personName}] を新規作成しました`,
          }
        }

        await store.upsertRelationship(personName, content, pType)
        return { success: true, message: `relationship[${personName}] を更新しました` }
      }

      // ─── partner_tools ──────────────────────────────
      case 'partner_tools': {
        if (action === 'get') {
          const tools = await store.getPartnerTools(pType)
          if (key) {
            const found = tools.find((t) => t.title === key)
            return found
              ? { success: true, message: `partner_tools[${key}]: ${found.description}` }
              : { success: false, message: `partner_tools[${key}] が見つかりません` }
          }
          return { success: true, message: JSON.stringify(tools) }
        }

        // #470: update/delete には key 必須
        const keyCheck = requireKey(action, key, target)
        if (keyCheck) return keyCheck

        const title = key ?? content.slice(0, 80)

        if (action === 'delete') {
          await store.deletePartnerTool(pType, title)
          return { success: true, message: `partner_tools[${title}] を削除しました` }
        }

        // #470: update 前に既存データを取得して返す（append も同じupsertで処理）
        const existingTools = await store.getPartnerTools(pType)
        const existingTool = existingTools.find((t) => t.title === title)
        await store.upsertPartnerTool(pType, title, content)
        return {
          success: true,
          message: action === 'update' && existingTool
            ? `partner_tools[${title}] を更新しました。\n\n📋 更新前:\n${existingTool.description}\n\n📝 更新後:\n${content}`
            : `partner_tools[${title}] を${existingTool ? '更新' : '新規作成'}しました`,
        }
      }

      // ─── partner_map ────────────────────────────────
      case 'partner_map': {
        if (action === 'get') {
          const map = await store.getPartnerMap(pType)
          if (key) {
            const found = map.find((m) => m.title === key)
            return found
              ? { success: true, message: `partner_map[${key}]: ${found.description}${found.location ? ` (location: ${found.location})` : ''}` }
              : { success: false, message: `partner_map[${key}] が見つかりません` }
          }
          return { success: true, message: JSON.stringify(map) }
        }

        // #470: update/delete には key 必須
        const keyCheck = requireKey(action, key, target)
        if (keyCheck) return keyCheck

        const title = key ?? content.slice(0, 80)

        if (action === 'delete') {
          await store.deletePartnerMap(pType, title)
          return { success: true, message: `partner_map[${title}] を削除しました` }
        }

        // #470: update 前に既存データを取得して返す（append も同じupsertで処理）
        const existingMap = await store.getPartnerMap(pType)
        const existingMapItem = existingMap.find((m) => m.title === title)
        await store.upsertPartnerMap(pType, title, content, location ?? null)
        return {
          success: true,
          message: action === 'update' && existingMapItem
            ? `partner_map[${title}] を更新しました。\n\n📋 更新前:\n${existingMapItem.description}\n\n📝 更新後:\n${content}`
            : `partner_map[${title}] を${existingMapItem ? '更新' : '新規作成'}しました`,
        }
      }

      // ─── diary ──────────────────────────────────────
      case 'diary': {
        if (action === 'get') {
          if (key) {
            const entry = await store.getDiary(key)
            return entry
              ? { success: true, message: `diary[${key}]:\n${entry.content}` }
              : { success: false, message: `diary[${key}] が見つかりません` }
          }
          const entries = await store.getRecentDiaries(7)
          if (entries.length === 0) return { success: true, message: '日記はまだありません' }
          const formatted = entries.map((e) => `## ${e.date}\n${e.content}`).join('\n\n')
          return { success: true, message: formatted }
        }

        if (action === 'delete') {
          return { success: false, message: 'diary の delete は未対応です' }
        }

        // #470: update には key 必須
        const keyCheck = requireKey(action, key, target)
        if (keyCheck) return keyCheck

        const date = key ?? new Date().toISOString().slice(0, 10)

        if (action === 'append') {
          const existing = await store.getDiary(date)
          const newContent = existing ? `${existing.content}\n\n${content}` : content
          await store.upsertDiary({ date, content: newContent })
          return { success: true, message: `diary[${date}] に追記しました` }
        }

        // #470: update 前に既存データを取得して返す
        const existingDiary = await store.getDiary(date)
        await store.upsertDiary({ date, content })
        return {
          success: true,
          message: action === 'update' && existingDiary
            ? `diary[${date}] を更新しました。\n\n📋 更新前:\n${existingDiary.content}\n\n📝 更新後:\n${content}`
            : `diary[${date}] を${existingDiary ? '更新' : '新規作成'}しました`,
        }
      }

      // ─── notes ─────────────────────────────────────
      case 'notes': {
        if (action === 'get') {
          const notes = await store.getAllNotes()
          if (notes.length === 0) return { success: true, message: 'ノートはまだありません' }
          return { success: true, message: JSON.stringify(notes) }
        }

        if (action === 'append') {
          const note = await store.insertNote(content)
          return { success: true, message: `notes[${note.id}] を追加しました` }
        }

        if (action === 'update') {
          if (!key) return { success: false, message: 'notes update には key（id）が必要です' }
          await store.updateNoteContent(key, content)
          return { success: true, message: `notes[${key}] を更新しました` }
        }

        if (action === 'delete') {
          if (!key) return { success: false, message: 'notes delete には key（id）が必要です' }
          await store.deleteNoteEntry(key)
          return { success: true, message: `notes[${key}] を削除しました` }
        }

        return { success: false, message: `notes の action ${action} は未対応です` }
      }

      // party_message は呼び出し元（process-job.ts）が処理するため no-op
      case 'party_message':
        return { success: true, message: 'party_message はルートハンドラで処理されます' }

      // ─── partner_rules ──────────────────────────────
      // #468: ユーザーが明示的に指示した場合のみ使用すること
      case 'partner_rules': {
        if (action === 'get') {
          const rules = await store.getAllRules(pType)
          if (key) {
            const found = rules.find((r) => r.id === key)
            return found
              ? { success: true, message: JSON.stringify(found) }
              : { success: false, message: `partner_rules[${key}] が見つかりません` }
          }
          return { success: true, message: JSON.stringify(rules) }
        }

        if (action === 'update') {
          if (!key) return { success: false, message: 'partner_rules update には key（id）が必要です' }
          await store.updateRule(key, { content })
          return { success: true, message: `partner_rules[${key}] を更新しました` }
        }

        return { success: false, message: `partner_rules の action ${action} は未対応です（追加・削除はUI経由）` }
      }

      // ─── souls ──────────────────────────────────────
      // #468: ユーザーが明示的に指示した場合のみ使用すること
      case 'souls': {
        if (action === 'get') {
          const soul = await store.getSoul(pType)
          if (!soul) return { success: false, message: 'SOULが見つかりません' }
          if (key) {
            const val = (soul as unknown as Record<string, unknown>)[key]
            return val !== undefined
              ? { success: true, message: `souls[${key}]: ${val}` }
              : { success: false, message: `souls[${key}] は存在しないフィールドです` }
          }
          return { success: true, message: JSON.stringify(soul) }
        }

        if (action === 'update') {
          if (!key) return { success: false, message: 'souls update には key（フィールド名）が必要です' }
          const ALLOWED_FIELDS = ['personality', 'voice', 'values', 'backstory', 'inner_world', 'examples'] as const
          type SoulField = typeof ALLOWED_FIELDS[number]
          if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) {
            return { success: false, message: `souls[${key}] は更新できません。対象フィールド: ${ALLOWED_FIELDS.join(', ')}` }
          }
          await store.updateSoulFields(pType, { [key as SoulField]: content })
          return { success: true, message: `souls[${key}] を更新しました` }
        }

        return { success: false, message: `souls の action ${action} は未対応です` }
      }

      default:
        return { success: false, message: `未対応のtarget: ${target}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[update_memory] failed:', message)
    return { success: false, message: `エラーが発生しました: ${message}` }
  }
}
