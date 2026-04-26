/**
 * supabase-store.ts — SupabaseMemoryStore 実装
 *
 * MemoryStore interface の Supabase 実装。
 * createSupabaseMemoryStore(supabase, userId) で生成。
 * userId はファクトリで束縛され、各メソッドは userId を意識しない。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { PLAN_LIMITS } from '../constants.js'
import { encrypt, decrypt } from '../utils/encryption.js'
import type {
  MemoryStore,
  MemoryNode,
  NewMemoryNode,
  MemoryNodeUpdate,
  NodeFilter,
  Cluster,
  DiaryEntry,
  Preference,
  KnowledgeEntry,
  RelationshipEntry,
  NoteEntry,
  Soul,
  PartnerTool,
  PartnerMapEntry,
  PartnerRule,
  Profile,
  ChatMessage,
  PinnedContext,
  SessionSnapshot,
} from './types.js'

// ──────────────────────────────────────────────
// 検索クエリ構築ヘルパー（ユニットテスト可能なよう export）
// ──────────────────────────────────────────────

/**
 * PostgREST の or() フィルタ用に検索語をサニタイズする。
 *
 * - or() の構文記号: `,` `(` `)` `{` `}` `"` を除去
 * - ilike のワイルドカード: `%` `_` をバックスラッシュでエスケープ
 *
 * @internal Exported for unit testing.
 */
export function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,(){}"]/g, '').replace(/[%_]/g, '\\$&')
}

/**
 * 1検索語を action/feeling/themes 横断の or() clause 文字列に変換する。
 * サニタイズ後に空になった場合は空文字を返す。
 *
 * 例: "記憶" → "scene->>action.ilike.%記憶%,feeling.ilike.%記憶%,themes.cs.{\"記憶\"}"
 *
 * @internal Exported for unit testing.
 */
export function buildSearchOrClause(term: string): string {
  const safe = sanitizeSearchTerm(term)
  if (!safe) return ''
  // themes は string[] のため contains (cs) 構文を使い、配列値はダブルクォートで括る
  return [
    `scene->>action.ilike.%${safe}%`,
    `feeling.ilike.%${safe}%`,
    `themes.cs.{"${safe}"}`,
  ].join(',')
}

// ──────────────────────────────────────────────
// ファクトリ関数
// ──────────────────────────────────────────────

export function createSupabaseMemoryStore(
  supabase: SupabaseClient,
  userId: string,
  partnerType?: string,
  beingId?: string
): MemoryStore {
  return {
    // ── memory_nodes ──

    async getNodes(filter: NodeFilter): Promise<MemoryNode[]> {
      let query = supabase
        .from('memory_nodes')
        .select('id, scene, feeling, importance, cluster_id, themes, emotion, session_count, status, fresh, pinned, needs_feeling, reactivation_count, last_activated, created_at')
        .eq('user_id', userId)

      // #791: being_id フィルタ
      if (beingId) query = query.eq('being_id', beingId)

      if (filter.fresh !== undefined) query = query.eq('fresh', filter.fresh)
      if (filter.pinned !== undefined) query = query.eq('pinned', filter.pinned)
      if (filter.clusterId) query = query.eq('cluster_id', filter.clusterId)
      if (filter.status) query = query.eq('status', filter.status)
      if (filter.actionQuery) {
        query = query.filter('scene->>action', 'ilike', `%${filter.actionQuery}%`)
      }
      if (filter.searchQuery) {
        const terms = filter.searchQuery.trim().split(/\s+/).filter(Boolean)
        const mode = filter.searchMode ?? 'or'

        if (mode === 'and') {
          // AND: 全ての語が action / feeling / themes のいずれかに含まれる
          for (const term of terms) {
            const clause = buildSearchOrClause(term)
            if (clause) query = query.or(clause)
          }
        } else {
          // OR: いずれかの語が action / feeling / themes のいずれかに含まれる
          const orParts = terms.map(buildSearchOrClause).filter(Boolean)
          if (orParts.length > 0) query = query.or(orParts.join(','))
        }
      }

      const orderBy = filter.orderBy ?? 'importance'
      const orderDir = filter.orderDirection ?? 'desc'
      query = query.order(orderBy, { ascending: orderDir === 'asc' })

      if (filter.secondaryOrderBy) {
        const secondaryDir = filter.secondaryOrderDirection ?? 'desc'
        query = query.order(filter.secondaryOrderBy, { ascending: secondaryDir === 'asc' })
      }

      if (filter.limit) query = query.limit(filter.limit)

      const { data, error } = await query
      if (error) throw new Error(`getNodes failed: ${error.message}`)
      return (data as MemoryNode[] | null) ?? []
    },


    async getNodesByIds(nodeIds: string[]): Promise<MemoryNode[]> {
      if (nodeIds.length === 0) return []
      let query = supabase
        .from('memory_nodes')
        .select('id, scene, feeling, importance, cluster_id, themes, emotion, session_count, status, fresh, pinned, needs_feeling, reactivation_count, last_activated, created_at')
        .eq('user_id', userId)
        .in('id', nodeIds)
      // #791: being_id フィルタ
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query
      if (error) throw new Error(`getNodesByIds failed: ${error.message}`)
      return (data as MemoryNode[] | null) ?? []
    },

    async saveNodes(nodes: NewMemoryNode[]): Promise<string[]> {
      if (nodes.length === 0) return []

      // #599: プラン制限チェック
      const { data: profileData } = await supabase
        .from('profiles')
        .select('plan')
        .eq('id', userId)
        .single()
      const plan = (profileData as { plan?: string } | null)?.plan ?? 'free'
      const limits = PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.free
      if (limits.maxNodes !== Infinity) {
        const { count } = await supabase
          .from('memory_nodes')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .neq('status', 'dead')
        if ((count ?? 0) >= limits.maxNodes) {
          console.warn(`warn: node limit reached for user ${userId}`)
          // ノード上限通知をシステムメッセージとして注入（1セッション1回 — patrol実行ごとに1回のみ呼ばれる）
          await supabase
            .from('chat_messages')
            .insert({
              user_id: userId,
              role: 'system',
              content: '記憶ノードが上限（500）に達しました。不要な記憶を整理するか、プロプランへのアップグレードをお勧めします',
              block: '2b',
            })
          return []
        }
      }

      const inserts = nodes.map((n) => {
        const row: Record<string, unknown> = {
          user_id: userId,
          importance: Math.min(1, Math.max(0, n.importance)),
          fresh: n.fresh ?? true,
          ...(beingId ? { being_id: beingId } : {}),
        }
        if (n.scene) row.scene = n.scene
        if (n.feeling !== undefined) row.feeling = n.feeling
        if (n.content !== undefined) row.content = n.content
        if (n.category !== undefined) row.category = n.category
        if (n.date !== undefined) row.date = n.date
        if (n.cluster_id !== undefined) row.cluster_id = n.cluster_id
        if (n.themes !== undefined) row.themes = n.themes
        if (n.pinned !== undefined) row.pinned = n.pinned
        if (n.needs_feeling !== undefined) row.needs_feeling = n.needs_feeling
        if (n.reactivation_count !== undefined) row.reactivation_count = n.reactivation_count
        if (n.last_activated !== undefined) row.last_activated = n.last_activated
        if (n.emotion !== undefined) row.emotion = n.emotion
        if (n.session_count !== undefined) row.session_count = n.session_count
        if (n.status !== undefined) row.status = n.status
        return row
      })
      const { data, error } = await supabase
        .from('memory_nodes')
        .insert(inserts)
        .select('id')
      if (error) throw new Error(`saveNodes failed: ${error.message}`)
      return (data as Array<{ id: string }> | null)?.map((r) => r.id) ?? []
    },

    async deleteNodes(nodeIds: string[]): Promise<void> {
      if (nodeIds.length === 0) return
      let query = supabase
        .from('memory_nodes')
        .delete()
        .eq('user_id', userId)
        .in('id', nodeIds)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`deleteNodes failed: ${error.message}`)
    },

    async updateNodes(nodeIds: string[], updates: MemoryNodeUpdate): Promise<void> {
      if (nodeIds.length === 0) return
      let query = supabase
        .from('memory_nodes')
        .update(updates)
        .eq('user_id', userId)
        .in('id', nodeIds)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`updateNodes failed: ${error.message}`)
    },

    // ── clusters ──

    async getClusters(): Promise<Cluster[]> {
      let query = supabase
        .from('clusters')
        .select('id, name, level, digest, vector, parent_id, is_parent')
        .eq('user_id', userId)
      // #791: being_id フィルタ
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query
      if (error) throw new Error(`getClusters failed: ${error.message}`)
      return (data as Cluster[] | null) ?? []
    },

    async getCluster(clusterId: string): Promise<Cluster | null> {
      let query = supabase
        .from('clusters')
        .select('id, name, level, digest, vector, parent_id, is_parent')
        .eq('id', clusterId)
        .eq('user_id', userId)
      // #791: being_id フィルタ
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query.single()
      if (error) return null
      return data as Cluster | null
    },

    async updateClusterVector(clusterId: string, vector: number[]): Promise<void> {
      let query = supabase
        .from('clusters')
        .update({ vector })
        .eq('id', clusterId)
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`updateClusterVector failed: ${error.message}`)
    },

    async findSimilarClusters(
      queryVector: number[],
      topK = 5,
      threshold = 0.35
    ): Promise<Array<{ id: string; name: string; similarity: number }>> {
      const { data, error } = await supabase.rpc('match_clusters', {
        p_user_id: userId,
        query_embedding: queryVector,
        match_threshold: threshold,
        match_count: topK,
        // #791: being_id フィルタ
        ...(beingId ? { p_being_id: beingId } : {}),
      })
      if (error) throw new Error(`findSimilarClusters failed: ${error.message}`)
      return (data as Array<{ id: string; name: string; similarity: number }> | null) ?? []
    },

    async updateCluster(clusterId: string, updates: Partial<Pick<Cluster, 'name' | 'digest' | 'parent_id' | 'vector' | 'is_parent'>>): Promise<void> {
      const row: Record<string, unknown> = {}
      if (updates.name !== undefined) row.name = updates.name
      if (updates.digest !== undefined) row.digest = updates.digest
      if (updates.parent_id !== undefined) row.parent_id = updates.parent_id
      if (updates.vector !== undefined) row.vector = updates.vector
      if (updates.is_parent !== undefined) row.is_parent = updates.is_parent
      let query = supabase
        .from('clusters')
        .update(row)
        .eq('id', clusterId)
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`updateCluster failed: ${error.message}`)
    },

    async createCluster(cluster: { name: string; digest?: string; parent_id?: string; is_parent?: boolean; vector?: number[] }): Promise<string> {
      const { data, error } = await supabase
        .from('clusters')
        .insert({
          user_id: userId,
          name: cluster.name,
          level: 'sub',
          digest: cluster.digest ?? null,
          parent_id: cluster.parent_id ?? null,
          is_parent: cluster.is_parent ?? false,
          vector: cluster.vector ?? null,
          ...(beingId ? { being_id: beingId } : {}),
        })
        .select('id')
        .single()
      if (error) throw new Error(`createCluster failed: ${error.message}`)
      return (data as { id: string }).id
    },

    async deleteCluster(clusterId: string): Promise<void> {
      let query = supabase
        .from('clusters')
        .delete()
        .eq('id', clusterId)
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`deleteCluster failed: ${error.message}`)
    },

    async updateNodeCluster(nodeId: string, clusterId: string | null): Promise<void> {
      let query = supabase
        .from('memory_nodes')
        .update({ cluster_id: clusterId })
        .eq('id', nodeId)
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`updateNodeCluster failed: ${error.message}`)
    },

    async incrementReactivationCounts(nodeIds: string[]): Promise<void> {
      return this.incrementReactivationCountsBy(nodeIds, 1)
    },

    async incrementReactivationCountsBy(nodeIds: string[], delta: number): Promise<void> {
      if (nodeIds.length === 0) return
      if (delta <= 0) return
      // 個別UPDATEで確実に delta 加算
      for (const nodeId of nodeIds) {
        let selectQuery = supabase
          .from('memory_nodes')
          .select('reactivation_count')
          .eq('id', nodeId)
          .eq('user_id', userId)
        if (beingId) selectQuery = selectQuery.eq('being_id', beingId)
        const { data: node } = await selectQuery.single()
        if (node) {
          let updateQuery = supabase
            .from('memory_nodes')
            .update({ reactivation_count: ((node as { reactivation_count: number }).reactivation_count ?? 0) + delta })
            .eq('id', nodeId)
            .eq('user_id', userId)
          if (beingId) updateQuery = updateQuery.eq('being_id', beingId)
          await updateQuery
        }
      }
    },

    async updateNodeStatus(nodeId: string, status: 'active' | 'dying' | 'dead'): Promise<void> {
      let query = supabase
        .from('memory_nodes')
        .update({ status })
        .eq('id', nodeId)
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`updateNodeStatus failed: ${error.message}`)
    },

    async bulkUpdateNodeStatus(nodeIds: string[], status: 'active' | 'dying' | 'dead'): Promise<void> {
      if (nodeIds.length === 0) return
      const { error } = await supabase
        .from('memory_nodes')
        .update({ status })
        .eq('user_id', userId)
        .in('id', nodeIds)
      if (error) throw new Error(`bulkUpdateNodeStatus failed: ${error.message}`)
    },

    async incrementSessionCounts(): Promise<number> {
      const { data, error } = await supabase.rpc('increment_session_counts', {
        p_user_id: userId,
      }).single()
      if (error) throw new Error(`incrementSessionCounts failed: ${error.message}`)
      return (data as { count: number })?.count ?? 0
    },

    async flagDyingNodes(): Promise<number> {
      const { data, error } = await supabase.rpc('flag_dying_nodes', {
        p_user_id: userId,
      }).single()
      if (error) throw new Error(`flagDyingNodes failed: ${error.message}`)
      return (data as { count: number })?.count ?? 0
    },

    async reviveDeadNodes(): Promise<number> {
      const { data, error } = await supabase.rpc('revive_dead_nodes', {
        p_user_id: userId,
      }).single()
      if (error) throw new Error(`reviveDeadNodes failed: ${error.message}`)
      return (data as { count: number })?.count ?? 0
    },

    // ── chat_messages ──

    async markMessagesCompacted(messageIds: string[]): Promise<void> {
      if (messageIds.length === 0) return
      const { error } = await supabase
        .from('chat_messages')
        .update({ compacted: true })
        .eq('user_id', userId)
        .in('id', messageIds)
      if (error) throw new Error(`markMessagesCompacted failed: ${error.message}`)
    },

    async deleteAllChatMessages(): Promise<void> {
      const { error } = await supabase
        .from('chat_messages')
        .delete()
        .eq('user_id', userId)
      if (error) throw new Error(`deleteAllChatMessages failed: ${error.message}`)
    },

    async archiveAllChatMessages(): Promise<void> {
      const { error } = await supabase
        .from('chat_messages')
        .update({ block: 'archive' })
        .eq('user_id', userId)
        .eq('block', '2b')
      if (error) throw new Error(`archiveAllChatMessages failed: ${error.message}`)
    },

    async archiveCurrentMessages(): Promise<void> {
      const { error } = await supabase
        .from('chat_messages')
        .update({ block: 'archive' })
        .eq('user_id', userId)
        .eq('block', '2b')
      if (error) throw new Error(`archiveCurrentMessages failed: ${error.message}`)
    },

    async getMessages(limit?: number): Promise<ChatMessage[]> {
      let query = supabase
        .from('chat_messages')
        .select('id, role, content, created_at, block, session_id, is_warm')
        .eq('user_id', userId)
        .eq('block', '2b')
        .eq('is_hidden', false)
        // is_warmフィルタ廃止: 2-BのDB保存メッセージ(is_warm=true, block='2b')をchatHistoryに含める
        .order('created_at', { ascending: true })
      if (limit) query = query.limit(limit)
      const { data, error } = await query
      if (error) throw new Error(`getMessages failed: ${error.message}`)
      return (data as ChatMessage[] | null) ?? []
    },

    async getAllMessages(limit?: number): Promise<ChatMessage[]> {
      let query = supabase
        .from('chat_messages')
        .select('id, role, content, created_at, block, session_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
      if (limit) query = query.limit(limit)
      const { data, error } = await query
      if (error) throw new Error(`getAllMessages failed: ${error.message}`)
      return (data as ChatMessage[] | null) ?? []
    },

    async getAllSessionMessages(limit?: number): Promise<ChatMessage[]> {
      let query = supabase
        .from('chat_messages')
        .select('id, role, content, created_at, block, session_id')
        .eq('user_id', userId)
        .in('block', ['archive', '2b'])
        .eq('is_hidden', false)
        .order('created_at', { ascending: true })
      if (limit) query = query.limit(limit)
      const { data, error } = await query
      if (error) throw new Error(`getAllSessionMessages failed: ${error.message}`)
      return (data as ChatMessage[] | null) ?? []
    },

    // #320: block='2b'（現セッション）のみ取得 — archive再処理を避ける
    async getCurrentSessionMessages(): Promise<ChatMessage[]> {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('id, role, content, created_at, block, session_id')
        .eq('user_id', userId)
        .eq('block', '2b')
        .eq('is_hidden', false)
        .order('created_at', { ascending: true })
      if (error) throw new Error(`getCurrentSessionMessages failed: ${error.message}`)
      return (data as ChatMessage[] | null) ?? []
    },

    async getMessage1B(): Promise<string | null> {
      const { data } = await supabase
        .from('chat_messages')
        .select('content')
        .eq('user_id', userId)
        .eq('block', '1b')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      return (data as { content: string } | null)?.content ?? null
    },

    async saveMessage1B(content: string): Promise<void> {
      const { error } = await supabase
        .from('chat_messages')
        .insert({ user_id: userId, role: 'system', content, block: '1b' })
      if (error) throw new Error()
    },

    async delete1BSnapshot(): Promise<void> {
      await supabase
        .from('chat_messages')
        .delete()
        .eq('user_id', userId)
        .eq('block', '1b')
    },

    async insertArchivedMessage(content: string): Promise<void> {
      const { error } = await supabase
        .from('chat_messages')
        .insert({ user_id: userId, role: 'assistant', content, block: 'archive' })
      if (error) throw new Error()
    },

    // ── pinned_context ──

    async addPinnedContext(summary: string): Promise<void> {
      const { error } = await supabase
        .from('pinned_context')
        .insert({ user_id: userId, summary })
      if (error) throw new Error(`addPinnedContext failed: ${error.message}`)
    },

    async getPinnedContext(): Promise<PinnedContext[]> {
      const { data, error } = await supabase
        .from('pinned_context')
        .select('id, summary, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
      if (error) throw new Error(`getPinnedContext failed: ${error.message}`)
      return (data as PinnedContext[] | null) ?? []
    },

    async deleteAllPinnedContext(): Promise<void> {
      await supabase
        .from('pinned_context')
        .delete()
        .eq('user_id', userId)
    },

    async clearPinnedContext(): Promise<void> {
      await supabase
        .from('pinned_context')
        .delete()
        .eq('user_id', userId)
    },

    // ── session_snapshot ──

    async getSessionSnapshot(): Promise<SessionSnapshot | null> {
      let query = supabase
        .from('session_snapshot')
        .select('id, content, created_at')
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(`getSessionSnapshot failed: ${error.message}`)
      return data as SessionSnapshot | null
    },

    async deleteSessionSnapshot(): Promise<void> {
      let query = supabase
        .from('session_snapshot')
        .delete()
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`deleteSessionSnapshot failed: ${error.message}`)
    },

    async createSessionSnapshot(content: string): Promise<void> {
      const { error } = await supabase
        .from('session_snapshot')
        .insert({ user_id: userId, content, ...(beingId ? { being_id: beingId } : {}) })
      if (error) throw new Error(`createSessionSnapshot failed: ${error.message}`)
    },

    generateSessionId(): string {
      return crypto.randomUUID()
    },

    // ── diary ──

    async upsertDiary(entry: DiaryEntry): Promise<void> {
      // #802: being_id がある場合は being_id ベースで upsert
      if (beingId) {
        const { error } = await supabase.from('diary').upsert({
          user_id: userId,
          date: entry.date,
          content: entry.content,
          being_id: beingId,
          ...(partnerType ? { partner_type: partnerType } : {}),
        }, { onConflict: 'user_id,date,being_id' })
        if (error) throw new Error(`upsertDiary failed: ${error.message}`)
      } else {
        const { error } = await supabase.from('diary').upsert({
          user_id: userId,
          date: entry.date,
          content: entry.content,
          ...(partnerType ? { partner_type: partnerType } : {}),
        }, { onConflict: 'user_id,date,partner_type' })
        if (error) throw new Error(`upsertDiary failed: ${error.message}`)
      }
    },

    // ── preferences ──

    async getPreferences(): Promise<Preference[]> {
      let query = supabase
        .from('preferences')
        .select('key, description')
        .eq('user_id', userId)
      // #787: being_id がある場合はフィルタ（preferencesは量が少ないため混在の実害大）
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query
      if (error) throw new Error(`getPreferences failed: ${error.message}`)
      return (data as Preference[] | null) ?? []
    },

    async upsertPreference(key: string, description: string): Promise<void> {
      // #787: being_id がある場合は being_id,key でupsert
      if (beingId) {
        const { error } = await supabase
          .from('preferences')
          .upsert(
            { user_id: userId, being_id: beingId, key, description, updated_at: new Date().toISOString() },
            { onConflict: 'being_id,key' }
          )
        if (error) throw new Error(`upsertPreference failed: ${error.message}`)
      } else {
        const { error } = await supabase
          .from('preferences')
          .upsert(
            { user_id: userId, key, description, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,key' }
          )
        if (error) throw new Error(`upsertPreference failed: ${error.message}`)
      }
    },

    async deletePreference(key: string): Promise<void> {
      // #787: being_id がある場合は being_id でもフィルタ（upsertPreference と同じ分岐パターン）
      if (beingId) {
        await supabase
          .from('preferences')
          .delete()
          .eq('user_id', userId)
          .eq('key', key)
          .eq('being_id', beingId)
      } else {
        await supabase
          .from('preferences')
          .delete()
          .eq('user_id', userId)
          .eq('key', key)
      }
    },

    // ── knowledge ──
    // #788: knowledge 系メソッドは partner_map テーブル (partner_type='shared') に向け先変更
    // knowledge テーブルは DROP しない（別用途で有用。新規書き込みは partner_map に向ける）

    async getKnowledge(title: string): Promise<KnowledgeEntry | null> {
      const { data } = await supabase
        .from('partner_map')
        .select('id, title, description')
        .eq('user_id', userId)
        .eq('partner_type', 'shared')
        .eq('title', title)
        .maybeSingle()
      return data as KnowledgeEntry | null
    },

    async getAllKnowledge(): Promise<KnowledgeEntry[]> {
      const { data } = await supabase
        .from('partner_map')
        .select('id, title, description')
        .eq('user_id', userId)
        .eq('partner_type', 'shared')
        .order('title')
      return (data ?? []) as KnowledgeEntry[]
    },

    async upsertKnowledge(title: string, description: string): Promise<void> {
      const { error } = await supabase
        .from('partner_map')
        .upsert(
          { user_id: userId, partner_type: 'shared', title, description, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,partner_type,title' }
        )
      if (error) throw new Error(`upsertKnowledge failed: ${error.message}`)
    },

    async deleteKnowledge(title: string): Promise<void> {
      await supabase
        .from('partner_map')
        .delete()
        .eq('user_id', userId)
        .eq('partner_type', 'shared')
        .eq('title', title)
    },

    // ── relationships ──

    // #471: partnerType 対応 — パートナーごとのプロフィールに紐づけ
    // #844: being_id 優先（beingId がある場合は being_id でフィルタ）
    async getRelationships(partnerType?: string): Promise<RelationshipEntry[]> {
      let query = supabase
        .from('relationships')
        .select('id, person_name, description')
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query
      if (error) throw new Error(`getRelationships failed: ${error.message}`)
      return (data as RelationshipEntry[] | null) ?? []
    },

    async getRelationship(personName: string, partnerType?: string): Promise<RelationshipEntry | null> {
      let query = supabase
        .from('relationships')
        .select('id, person_name, description')
        .eq('user_id', userId)
        .eq('person_name', personName)
      if (beingId) query = query.eq('being_id', beingId)
      const { data } = await query.maybeSingle()
      return data as RelationshipEntry | null
    },

    async upsertRelationship(personName: string, description: string, partnerType?: string): Promise<void> {
      const { error } = await supabase
        .from('relationships')
        .upsert(
          {
            user_id: userId,
            partner_type: partnerType ?? 'liz',
            person_name: personName,
            description,
            updated_at: new Date().toISOString(),
            being_id: beingId,
          },
          { onConflict: 'user_id,being_id,person_name' }
        )
      if (error) throw new Error(`upsertRelationship failed: ${error.message}`)
    },

    async deleteRelationship(personName: string, partnerType?: string): Promise<void> {
      let query = supabase
        .from('relationships')
        .delete()
        .eq('user_id', userId)
        .eq('person_name', personName)
      if (beingId) query = query.eq('being_id', beingId)
      await query
    },

    // ── notes ──

    async getUnreadNotes(): Promise<NoteEntry[]> {
      let query = supabase
        .from('notes')
        .select('id, content, type')
        .eq('user_id', userId)
        .eq('read', false)
        .in('type', ['note', 'scene'])
      // #791: being_id フィルタ
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query.order('created_at', { ascending: true })
      if (error) throw new Error(`getUnreadNotes failed: ${error.message}`)
      return (data as NoteEntry[] | null) ?? []
    },

    async markNotesRead(noteIds: string[]): Promise<void> {
      if (noteIds.length === 0) return
      let query = supabase
        .from('notes')
        .update({ read: true })
        .eq('user_id', userId)
        .in('id', noteIds)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`markNotesRead failed: ${error.message}`)
    },

    async getAllNotes(): Promise<NoteEntry[]> {
      let query = supabase
        .from('notes')
        .select('id, content, read, created_at, type')
        .eq('user_id', userId)
        .in('type', ['note', 'scene'])
      // #791: being_id フィルタ
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query.order('created_at', { ascending: false }).limit(50)
      if (error) throw new Error(`getAllNotes failed: ${error.message}`)
      return (data as NoteEntry[] | null) ?? []
    },

    async updateNoteContent(id: string, content: string): Promise<void> {
      let query = supabase
        .from('notes')
        .update({ content })
        .eq('user_id', userId)
        .eq('id', id)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`updateNoteContent failed: ${error.message}`)
    },

    async insertNote(content: string): Promise<NoteEntry> {
      const { data, error } = await supabase
        .from('notes')
        .insert({ user_id: userId, content, read: false, type: 'note', ...(beingId ? { being_id: beingId } : {}) })
        .select('id, content, read, created_at, type')
        .single()
      if (error) throw new Error(`insertNote failed: ${error.message}`)
      return data as NoteEntry
    },

    async deleteNoteEntry(id: string): Promise<void> {
      let query = supabase
        .from('notes')
        .delete()
        .eq('user_id', userId)
        .eq('id', id)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`deleteNoteEntry failed: ${error.message}`)
    },

    async getSceneNotes(): Promise<NoteEntry[]> {
      let query = supabase
        .from('notes')
        .select('id, content, read, created_at, type')
        .eq('user_id', userId)
        .eq('type', 'scene')
      // #791: being_id フィルタ
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query.order('created_at', { ascending: true })
      if (error) throw new Error(`getSceneNotes failed: ${error.message}`)
      return (data as NoteEntry[] | null) ?? []
    },

    async insertSceneNote(content: string): Promise<NoteEntry> {
      const { data, error } = await supabase
        .from('notes')
        .insert({ user_id: userId, content, read: false, type: 'scene', ...(beingId ? { being_id: beingId } : {}) })
        .select('id, content, read, created_at, type')
        .single()
      if (error) throw new Error(`insertSceneNote failed: ${error.message}`)
      return data as NoteEntry
    },

    async deleteSceneNotes(): Promise<void> {
      // #799 Bug 4: [PARSE_FAILED] マーカー付きの scene は削除しない（LLM修復待ち）
      // #802: being_id がある場合は自 Being の notes のみ削除
      let query = supabase
        .from('notes')
        .delete()
        .eq('user_id', userId)
        .eq('type', 'scene')
        .not('content', 'like', '[PARSE_FAILED]%')
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`deleteSceneNotes failed: ${error.message}`)
    },

    async getNotesByType(type: 'scene' | 'note'): Promise<NoteEntry[]> {
      // #802: being_id がある場合は自 Being の notes のみ取得
      let query = supabase
        .from('notes')
        .select('id, content, read, created_at, type')
        .eq('user_id', userId)
        .eq('type', type)
        .order('created_at', { ascending: true })
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query
      if (error) throw new Error(`getNotesByType failed: ${error.message}`)
      return (data as NoteEntry[] | null) ?? []
    },

    async deleteNotesByType(type: 'scene' | 'note'): Promise<void> {
      // #799 Bug 4: type='scene' の場合は [PARSE_FAILED] マーカー付きを除外（LLM修復待ち）
      // #802: being_id がある場合は自 Being の notes のみ削除
      let query = supabase
        .from('notes')
        .delete()
        .eq('user_id', userId)
        .eq('type', type)
      if (type === 'scene') {
        query = query.not('content', 'like', '[PARSE_FAILED]%')
      }
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`deleteNotesByType failed: ${error.message}`)
    },

    async deleteNotesByIds(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      let query = supabase
        .from('notes')
        .delete()
        .eq('user_id', userId)
        .in('id', ids)
      if (beingId) query = query.eq('being_id', beingId)
      const { error } = await query
      if (error) throw new Error(`deleteNotesByIds failed: ${error.message}`)
    },

    // ── souls ──

    // #854: being_id 優先（beingId がある場合は being_id でフィルタ、ない場合は partner_type）
    async getSoul(partnerType: string): Promise<Soul | null> {
      let query = supabase
        .from('souls')
        .select('name, personality, voice, values, backstory, inner_world, examples, think_md, model, preference, user_call_name')
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      else query = query.eq('partner_type', partnerType)
      const { data } = await query.single()
      return data as Soul | null
    },

    async updateSoulThinkMd(partnerType: string, thinkMd: string): Promise<void> {
      let query = supabase
        .from('souls')
        .update({ think_md: thinkMd })
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      else query = query.eq('partner_type', partnerType)
      const { error } = await query
      if (error) throw new Error(`updateSoulThinkMd failed: ${error.message}`)
    },

    async updateSoulModel(partnerType: string, model: string | null): Promise<void> {
      let query = supabase
        .from('souls')
        .update({ model })
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      else query = query.eq('partner_type', partnerType)
      const { error } = await query
      if (error) throw new Error(`updateSoulModel failed: ${error.message}`)
    },

    // #468: personality, voice, values, backstory, inner_world, examples の部分更新
    async updateSoulFields(
      partnerType: string,
      patch: Partial<Pick<Soul, 'personality' | 'voice' | 'values' | 'backstory' | 'inner_world' | 'examples'>>
    ): Promise<void> {
      if (Object.keys(patch).length === 0) return
      let query = supabase
        .from('souls')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
      if (beingId) query = query.eq('being_id', beingId)
      else query = query.eq('partner_type', partnerType)
      const { error } = await query
      if (error) throw new Error(`updateSoulFields failed: ${error.message}`)
    },

    // ── partner_tools ──

    // ── partner_tools ──
    // #788: partner_tools は shared 化（partnerType 引数は無視して 'shared' 固定）

    async getPartnerTools(_partnerType: string): Promise<PartnerTool[]> {
      const { data, error } = await supabase
        .from('partner_tools')
        .select('id, user_id, partner_type, title, description, is_encrypted, encrypted_description, created_at, updated_at')
        .eq('user_id', userId)
        .eq('partner_type', 'shared')
        .order('created_at', { ascending: true })
      if (error) throw new Error(`getPartnerTools failed: ${error.message}`)
      const rows = (data ?? []) as (PartnerTool & { is_encrypted?: boolean; encrypted_description?: string })[]
      return rows.map(row => {
        let desc = row.description
        if (row.is_encrypted && row.encrypted_description) {
          try {
            desc = decrypt(row.encrypted_description)
          } catch (e) {
            console.error(`Failed to decrypt partner_tool "${row.title}":`, e)
            desc = '[復号失敗]'
          }
        }
        // encrypted_description のみ除外。is_encrypted はフロント表示用に残す
        // description は null の場合も '' にフォールバック
        const { encrypted_description, ...clean } = row
        return { ...clean, description: desc ?? '' } as PartnerTool
      })
    },

    async upsertPartnerTool(_partnerType: string, title: string, description: string, isEncrypted = false): Promise<void> {
      const row: Record<string, unknown> = {
        user_id: userId,
        partner_type: 'shared',
        title,
        updated_at: new Date().toISOString(),
        is_encrypted: isEncrypted,
      }
      if (isEncrypted) {
        row.encrypted_description = encrypt(description)
        row.description = null
      } else {
        row.description = description
        row.encrypted_description = null
      }
      const { error } = await supabase.from('partner_tools').upsert(row, { onConflict: 'user_id,partner_type,title' })
      if (error) throw new Error(`upsertPartnerTool failed: ${error.message}`)
    },

    async deletePartnerTool(_partnerType: string, title: string): Promise<void> {
      const { error } = await supabase
        .from('partner_tools')
        .delete()
        .eq('user_id', userId)
        .eq('partner_type', 'shared')
        .eq('title', title)
      if (error) throw new Error(`deletePartnerTool failed: ${error.message}`)
    },

    // ── partner_map ──

    async getPartnerMap(partnerType: string): Promise<PartnerMapEntry[]> {
      const { data, error } = await supabase
        .from('partner_map')
        .select('id, user_id, partner_type, title, description, location, created_at, updated_at')
        .eq('user_id', userId)
        .eq('partner_type', partnerType)
        .order('created_at', { ascending: true })
      if (error) throw new Error(`getPartnerMap failed: ${error.message}`)
      return (data as PartnerMapEntry[] | null) ?? []
    },

    async upsertPartnerMap(partnerType: string, title: string, description: string, location?: string | null): Promise<void> {
      const { error } = await supabase.from('partner_map').upsert({
        user_id: userId,
        partner_type: partnerType,
        title,
        description,
        ...(location !== undefined ? { location } : {}),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,partner_type,title' })
      if (error) throw new Error(`upsertPartnerMap failed: ${error.message}`)
    },

    async deletePartnerMap(partnerType: string, title: string): Promise<void> {
      const { error } = await supabase
        .from('partner_map')
        .delete()
        .eq('user_id', userId)
        .eq('partner_type', partnerType)
        .eq('title', title)
      if (error) throw new Error(`deletePartnerMap failed: ${error.message}`)
    },

    // ── diary ──（read）

    async getDiary(date: string): Promise<DiaryEntry | null> {
      let query = supabase
        .from('diary')
        .select('date, content')
        .eq('user_id', userId)
        .eq('date', date)
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query.single()
      if (error && error.code !== 'PGRST116') throw new Error(`getDiary failed: ${error.message}`)
      return data as DiaryEntry | null
    },

    async getRecentDiaries(limit: number = 7): Promise<DiaryEntry[]> {
      let query = supabase
        .from('diary')
        .select('date, content')
        .eq('user_id', userId)
        .order('date', { ascending: false })
        .limit(limit)
      if (beingId) query = query.eq('being_id', beingId)
      const { data, error } = await query
      if (error) throw new Error(`getRecentDiaries failed: ${error.message}`)
      return (data as DiaryEntry[] | null) ?? []
    },

    // ── partner_rules ──

    async getRules(partnerType: string): Promise<PartnerRule[]> {
      const { data, error } = await supabase
        .from('partner_rules')
        .select('id, partner_type, category, title, content, sort_order, enabled')
        .eq('user_id', userId)
        .or(beingId
          ? `being_id.is.null,being_id.eq.${beingId}`
          : `partner_type.eq.shared,partner_type.eq.${partnerType}`)
        .eq('enabled', true)
        .order('sort_order', { ascending: true })
      if (error) throw new Error(`getRules failed: ${error.message}`)
      return (data as PartnerRule[] | null) ?? []
    },

    async getAllRules(partnerType: string): Promise<PartnerRule[]> {
      const { data, error } = await supabase
        .from('partner_rules')
        .select('id, partner_type, category, title, content, sort_order, enabled')
        .eq('user_id', userId)
        .or(beingId
          ? `being_id.is.null,being_id.eq.${beingId}`
          : `partner_type.eq.shared,partner_type.eq.${partnerType}`)
        .order('sort_order', { ascending: true })
      if (error) throw new Error(`getAllRules failed: ${error.message}`)
      return (data as PartnerRule[] | null) ?? []
    },

    async updateRule(id: string, patch: { content?: string; enabled?: boolean }): Promise<void> {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (typeof patch.content === 'string') updates.content = patch.content
      if (typeof patch.enabled === 'boolean') updates.enabled = patch.enabled
      const { error } = await supabase
        .from('partner_rules')
        .update(updates)
        .eq('id', id)
      if (error) throw new Error(`updateRule failed: ${error.message}`)
    },

    // ── profiles ──

    async getProfile(): Promise<Profile | null> {
      const { data } = await supabase
        .from('profiles')
        .select('display_name, partner_type, plan, locale, github_repo_url, note_frequency')
        .eq('id', userId)
        .single()
      return data as Profile | null
    },
  }
}
