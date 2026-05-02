/**
 * types.ts — MemoryStore interface 定義
 *
 * DB層の抽象化。Supabase非依存にするためのinterface。
 * 実装: supabase-store.ts (SupabaseMemoryStore)
 *
 * userId は interface に含めない。
 * ファクトリ関数 (createSupabaseMemoryStore) で束縛する。
 */

import type { Scene } from '../chat/scene-utils.js'

// ──────────────────────────────────────────────
// 行の型定義
// ──────────────────────────────────────────────

export interface MemoryNode {
  id: string
  scene: Scene
  feeling: string | null
  importance: number | null
  cluster_id: string | null
  themes: string[] | null
  emotion?: Record<string, number> | null
  session_count?: number
  status?: string
  fresh?: boolean
  pinned?: boolean
  needs_feeling?: boolean
  reactivation_count?: number
  last_activated?: string
  created_at?: string
}

export interface NewMemoryNode {
  scene?: Scene
  feeling?: string | null
  content?: string          // graph.ts 旧形式（content + category）— TODO: scene JSONB統一後に削除
  category?: string         // TODO: scene JSONB統一後に削除
  importance: number
  date?: string
  cluster_id?: string | null
  themes?: string[]
  emotion?: Record<string, number> | null
  session_count?: number
  status?: string
  fresh?: boolean
  pinned?: boolean
  needs_feeling?: boolean
  reactivation_count?: number
  last_activated?: string
}

export interface MemoryNodeUpdate {
  fresh?: boolean
  pinned?: boolean
  needs_feeling?: boolean
  importance?: number
  emotion?: Record<string, number> | null
  session_count?: number
  status?: string
  last_activated?: string
  reactivation_count?: number
  /** 統合時にsceneを更新する（❹ consolidation用） */
  scene?: Scene
  /** 統合時にthemesを更新する（❹ consolidation用） */
  themes?: string[]
  /** 統合時にfeelingを更新する（❹ consolidation用、#937） */
  feeling?: string | null
}

export interface Cluster {
  id: string
  name: string
  level: string
  digest: string | null
  /** クラスタ内全ノードのaction平均embedding（spec-31）。DBカラム: vector FLOAT8[] */
  vector?: number[] | null
  /** 親クラスタID。サブクラスタのみ設定 */
  parent_id?: string | null
  /** 親クラスタ（Business/Privateなど）かどうか。巡回処理のスキップ判定に使用 */
  is_parent?: boolean
}

export interface DiaryEntry {
  date: string
  content: string
}

export interface Preference {
  key: string
  description: string
}

export interface KnowledgeEntry {
  id: string
  title: string
  description: string
}

export interface RelationshipEntry {
  id: string
  person_name: string
  description: string
}

export interface NoteEntry {
  id: string
  content: string
  read: boolean
  created_at: string
  type: string
}

export interface Soul {
  name: string
  personality: string
  voice: string | null
  values: string | null
  backstory: string | null
  inner_world: string | null
  examples: string | null
  /** パートナーがユーザーを呼ぶ時の呼び方（例: ひろきくん、あなた） */
  user_call_name: string | null
  /** 巡回が生成するThink.mdの内容。注入対象（空なら注入スキップ） */
  think_md: string | null
  /** パートナー固有のモデル指定。nullの場合はプロバイダのデフォルトモデルを使用 */
  model: string | null
  /** #375: ユーザーが直接編集するPreference（会話コンテキストに注入） */
  preference: string | null
}

export interface PartnerTool {
  id: string
  user_id: string
  partner_type: string
  title: string
  description: string
  is_encrypted?: boolean
  encrypted_description?: string | null
  created_at: string
  updated_at: string
}

export interface PartnerMapEntry {
  id: string
  user_id: string
  partner_type: string
  title: string
  description: string
  location: string | null
  created_at: string
  updated_at: string
}

export interface PartnerRule {
  id: string
  partner_type: string
  category: string
  title: string
  content: string
  sort_order: number
  enabled: boolean
}

export interface Profile {
  display_name: string | null
  partner_type: string
  plan: string
  locale: string
  github_repo_url: string | null
  note_frequency: 'off' | 'moderate' | 'aggressive'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
  /** '2b' = current session, 'archive' = previous session */
  block?: string
  session_id?: string | null
}

export interface PinnedContext {
  id: string
  summary: string
  created_at: string
}

export interface SessionSnapshot {
  id: string
  content: string
  created_at: string
}

// ──────────────────────────────────────────────
// フィルタ型
// ──────────────────────────────────────────────

export interface NodeFilter {
  fresh?: boolean
  pinned?: boolean
  status?: string
  clusterId?: string
  orderBy?: 'importance' | 'last_activated' | 'created_at'
  orderDirection?: 'asc' | 'desc'
  secondaryOrderBy?: 'importance' | 'last_activated' | 'created_at'
  secondaryOrderDirection?: 'asc' | 'desc'
  limit?: number
  actionQuery?: string  // scene->>action に ilike（後方互換）
  searchQuery?: string  // action / feeling / themes を横断検索
  searchMode?: 'or' | 'and'  // デフォルト 'or'
}

// ──────────────────────────────────────────────
// MemoryStore interface
// ──────────────────────────────────────────────

export interface MemoryStore {
  // --- memory_nodes ---
  getNodes(filter: NodeFilter): Promise<MemoryNode[]>
  getNodesByIds(nodeIds: string[]): Promise<MemoryNode[]>
  saveNodes(nodes: NewMemoryNode[]): Promise<string[]>
  deleteNodes(nodeIds: string[]): Promise<void>
  updateNodes(nodeIds: string[], updates: MemoryNodeUpdate): Promise<void>

  // --- clusters ---
  getClusters(): Promise<Cluster[]>
  getCluster(clusterId: string): Promise<Cluster | null>
  /** クラスタのvectorを更新（クラスタ割付後に再計算） */
  updateClusterVector(clusterId: string, vector: number[]): Promise<void>
  /** クラスタのlabel/digest/parent_id/is_parentを更新 */
  updateCluster(clusterId: string, updates: Partial<Pick<Cluster, 'name' | 'digest' | 'parent_id' | 'vector' | 'is_parent'>>): Promise<void>
  /** クラスタを新規作成（分割時） */
  createCluster(cluster: { name: string; digest?: string; parent_id?: string; is_parent?: boolean; vector?: number[] }): Promise<string>
  /** クラスタを削除（空クラスタ掃除） */
  deleteCluster(clusterId: string): Promise<void>
  /** ノードのcluster_idを更新 */
  updateNodeCluster(nodeId: string, clusterId: string | null): Promise<void>
  /** ノードのreactivation_countを一括+1（recall時） */
  incrementReactivationCounts(nodeIds: string[]): Promise<void>
  /** reactivation_count を delta だけ加算（デフォルト1）*/
  incrementReactivationCountsBy(nodeIds: string[], delta: number): Promise<void>
  /** ノードのstatusを更新 */
  updateNodeStatus(nodeId: string, status: 'active' | 'dying' | 'dead'): Promise<void>
  /** ノードをstatusで一括更新 */
  bulkUpdateNodeStatus(nodeIds: string[], status: 'active' | 'dying' | 'dead'): Promise<void>
  /** session_countを加算（effective_t < 100 のノードのみ） */
  incrementSessionCounts(): Promise<number>
  /** 減衰判定: eff_imp ≤ 0.05 → status = 'dying' */
  flagDyingNodes(): Promise<number>
  /** dead復活チェック: eff_imp > 0.05 になったdeadノード → active + reactivation_count += 2 */
  reviveDeadNodes(): Promise<number>
  /** cosine類似度でクラスタを検索（spec-31）。OPENAI_API_KEYがない場合は空配列を返す */
  findSimilarClusters(queryVector: number[], topK?: number, threshold?: number): Promise<Array<{ id: string; name: string; similarity: number }>>



  // --- chat_messages ---
  markMessagesCompacted(messageIds: string[]): Promise<void>
  deleteAllChatMessages(): Promise<void>
  archiveAllChatMessages(): Promise<void>
  /** block='2b' の全メッセージを block='archive' に更新（update_notes用） */
  archiveCurrentMessages(): Promise<void>
  getMessages(limit?: number): Promise<ChatMessage[]>
  getAllMessages(limit?: number): Promise<ChatMessage[]>
  /** block IN ('archive','2b') のメッセージをcreated_at順で返す（巡回入力用） */
  getAllSessionMessages(limit?: number): Promise<ChatMessage[]>
  getCurrentSessionMessages(): Promise<ChatMessage[]>
  /** block='1b' のスナップショットメッセージを取得（セッション中固定） */
  getMessage1B(): Promise<string | null>
  /** block='1b' としてスナップショットを保存 */
  saveMessage1B(content: string): Promise<void>
  /** block='1b' のスナップショットを削除（New Session時） */
  delete1BSnapshot(): Promise<void>
  /** block='archive' にメッセージを追加（ツール要約等） */
  insertArchivedMessage(content: string): Promise<void>

  // --- pinned_context ---
  addPinnedContext(summary: string): Promise<void>
  getPinnedContext(): Promise<PinnedContext[]>
  deleteAllPinnedContext(): Promise<void>
  /** alias for deleteAllPinnedContext（#172） */
  clearPinnedContext(): Promise<void>

  // --- session_snapshot ---
  /** session_snapshotテーブルから最新1件を取得 */
  getSessionSnapshot(): Promise<SessionSnapshot | null>
  /** session_snapshotテーブルの既存レコードを全件削除（createの前に呼ぶ） */
  deleteSessionSnapshot(): Promise<void>
  /** session_snapshotテーブルに新しいsnapshotをINSERT */
  createSessionSnapshot(content: string): Promise<void>
  /** UUID生成（新session_id発行用） */
  generateSessionId(): string

  // --- diary ---
  upsertDiary(entry: DiaryEntry): Promise<void>

  // --- preferences ---
  getPreferences(): Promise<Preference[]>
  upsertPreference(key: string, description: string): Promise<void>
  deletePreference(key: string): Promise<void>

  // --- knowledge ---
  getKnowledge(title: string): Promise<KnowledgeEntry | null>
  getAllKnowledge(): Promise<KnowledgeEntry[]>
  upsertKnowledge(title: string, description: string): Promise<void>
  deleteKnowledge(title: string): Promise<void>

  // --- relationships ---
  // #471: partnerType 対応 — パートナーごとのプロフィールに紐づけ
  getRelationships(partnerType?: string): Promise<RelationshipEntry[]>
  getRelationship(personName: string, partnerType?: string): Promise<RelationshipEntry | null>
  upsertRelationship(personName: string, description: string, partnerType?: string): Promise<void>
  deleteRelationship(personName: string, partnerType?: string): Promise<void>

  // --- notes ---
  getUnreadNotes(): Promise<NoteEntry[]>
  markNotesRead(noteIds: string[]): Promise<void>
  /** 全notes取得（type='note'のみ、最新50件、created_at降順） */
  getAllNotes(): Promise<NoteEntry[]>
  /** notesテーブルに新規エントリをINSERT */
  insertNote(content: string): Promise<NoteEntry>
  /** 特定エントリのcontentを更新 */
  updateNoteContent(id: string, content: string): Promise<void>
  /** 特定エントリを削除 */
  deleteNoteEntry(id: string): Promise<void>
  /** scenes取得（type='scene'） */
  getSceneNotes(): Promise<NoteEntry[]>
  /** sceneをnotesテーブルにINSERT（type='scene'） */
  insertSceneNote(content: string): Promise<NoteEntry>
  /** 全sceneを削除（type='scene'） */
  deleteSceneNotes(): Promise<void>
  /** type指定でnotesを取得 */
  getNotesByType(type: 'scene' | 'note'): Promise<NoteEntry[]>
  /** type指定でnotesを一括削除 */
  deleteNotesByType(type: 'scene' | 'note'): Promise<void>
  /** 指定IDのnotesを一括削除（action=update 用） */
  deleteNotesByIds(ids: string[]): Promise<void>

  // --- partner_tools ---
  getPartnerTools(partnerType: string): Promise<PartnerTool[]>
  upsertPartnerTool(partnerType: string, title: string, description: string, isEncrypted?: boolean): Promise<void>
  deletePartnerTool(partnerType: string, title: string): Promise<void>

  // --- partner_map ---
  getPartnerMap(partnerType: string): Promise<PartnerMapEntry[]>
  upsertPartnerMap(partnerType: string, title: string, description: string, location?: string | null): Promise<void>
  deletePartnerMap(partnerType: string, title: string): Promise<void>

  // --- diary (read) ---
  getDiary(date: string): Promise<DiaryEntry | null>
  getRecentDiaries(limit?: number): Promise<DiaryEntry[]>

  // --- souls ---
  getSoul(partnerType: string): Promise<Soul | null>
  updateSoulThinkMd(partnerType: string, thinkMd: string): Promise<void>
  updateSoulModel(partnerType: string, model: string | null): Promise<void>
  // #468: personality, voice, values, backstory, inner_world, examples の部分更新
  updateSoulFields(partnerType: string, patch: Partial<Pick<Soul, 'personality' | 'voice' | 'values' | 'backstory' | 'inner_world' | 'examples'>>): Promise<void>

  // --- partner_rules ---
  getRules(partnerType: string): Promise<PartnerRule[]>
  getAllRules(partnerType: string): Promise<PartnerRule[]>
  updateRule(id: string, patch: { content?: string; enabled?: boolean }): Promise<void>

  // --- profiles ---
  getProfile(): Promise<Profile | null>
}

