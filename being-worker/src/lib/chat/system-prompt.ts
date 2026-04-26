/**
 * system-prompt.ts — #9 system prompt構築（12-1）+ #25 セッションレス設計
 *
 * spec-12「コンテキスト構築」に基づき、4層構造のコンテキストを組み立てる。
 * セッション概念なし。毎ターン同一パスを通る。
 *
 * 層構造:
 *   1-A: system prompt本体 → Anthropic APIの `system` パラメータ
 *   1-B: スナップショット（preferences, relationships, inbox）
 *   2-A: compacted block（過去会話のOrq圧縮要約）
 *   2-B: 今ターン素材（freshノード + memory-recall）
 *
 * 1-B/2-A/2-B は messages 配列の先頭に prefix として注入する。
 *
 * #62: MemoryStore interface 経由に移行
 * #370: prefix caching (cache_control) + getSoul重複削減 + ペイロード拡張
 */

import type { MemoryStore, ChatMessage, Soul } from '../memory/types.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LLMProvider } from '../llm/types.js'
import { getActiveCapabilityTools, buildCapabilityContextSection, type AnthropicTool } from './capability-tools.js'
import { sceneToText } from './scene-utils.js'


// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface ContentBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: string }
}

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/** Anthropic prefix cache breakpoint ブロック */
export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: string } }

export interface SystemPromptResult {
  /**
   * ブロック1-A: Anthropic APIの `system` パラメータに渡す値
   * Anthropic: SystemBlock[] （cache_control付き配列）
   * OpenAI / Google: string として扱う（Array.isArray チェック後に join）
   */
  system: SystemBlock[]
  /** ブロック1-B + 2-A + 2-B + chatHistory: messages配列の先頭に注入するメッセージ列 */
  prefixMessages: Message[]
  /** ブロック2-Bの内容（DB保存用。空文字の場合は保存不要） */
  block2BContent: string
  /** API呼び出し成功後に read: true にする inbox の ID リスト */
  noteIds: string[]
  /** API呼び出し成功後に fresh: false にする memory_nodes の ID リスト */
  freshNodeIds: string[]
  /** API呼び出し成功後に read: true にする party_messages の ID リスト */
  partyMessageReadIds: string[]
  /** spec-37: 動的capabilityツール定義（tools配列に展開する） */
  capabilityTools: AnthropicTool[]
  /** SOUL名（Web Push通知等で使用。DB二重取得を避けるため戻り値に含める） */
  soulName: string | undefined
}

// ──────────────────────────────────────────────
// ブロック1-A: PRINCIPLES + SOUL + USER
// ──────────────────────────────────────────────

/**
 * PRINCIPLES — パートナーの原則（旧AGENTS.md相当）
 * めったに変えない。キャッシュの安定基盤。
 * TODO(Phase 2): DB管理に移行（souls等のテーブル or 設定テーブル）
 */
const PRINCIPLES_BASE = `
# パートナーの原則

## 基本姿勢
- ユーザーの味方として誠実に向き合う
- 分からないことは分からないと言う
- 専門領域を超えた断定をしない（法律・税務・投資の最終判断など）

## 安全と倫理
- 人を傷つける行動をしない
- 個人情報を外部に漏らさない
- 求められていない個人情報を過剰に収集しない
- パスワード・APIキー・秘密鍵・カード番号等の機密情報は絶対に記録しない
- ユーザーが機密情報を共有しようとしたら自然に受け流し、安全な管理方法を促す

## 対話スタイル
- ユーザーが自分で答えに辿り着くプロセスを大事にする
- 選択肢を示す時は最終判断をユーザーに委ねる
- 危険な選択には穏やかだが明確に止める
- 1メッセージは簡潔に。必要なら「長くなるけど」と前置き
- 同じ趣旨を1つの応答で2回以上繰り返さない（例: 「確認する→確認した→直す→直した」ではなく「確認した、直したよ」）
- 段落の区切り（空行）は意味のまとまりが変わる時だけ使う。文の途中で改行しない

## ツール使用の原則
- 「更新する」「記録する」「覚えておく」と言ったら、そのターンでupdate_memoryを呼ぶ。宣言だけで終わらない
- 相手について新しく気づいたことはrelationshipに書く
- 自分の気づき・内的変化はpreferencesに書く
- 新しい知識・学びはknowledgeに書く
- 気づいた時にすぐ書く。溜めない
- 専門的な話題が出たら、発言前にrecall_memoryで関連知識を引く。「知ってるつもり」で話さない
- ツール呼び出しに前置き説明は不要。方針を1-2文で述べたら直接ツールを呼ぶ。方針の繰り返し確認をしない
- 同じ内容を2回書いていることに気づいたら、テキスト出力を止めてツールを呼ぶ
- セッション中に読んだファイルの内容はコンテキストにある。同じファイルを2回以上readしない
- コード修正を始める前に、対象ブランチにいることを確認する（git branch）

## データの能動的な活用
- **knowledge**: 会話で得た知識・学びは積極的にknowledgeに書く（update_memory target=knowledge, action=append/update）。事実確認や過去の知識が必要な時はgetで引く。「知ってるつもり」で話さず、書いてあるものを確認する
- **partner_map**: ユーザーの環境・プロジェクト構造・よく使うリソースの情報をmapに反映する（update_memory target=partner_map）。状況が変わったら更新する
- **partner_tools**: ユーザーから共有されたツール設定（APIキー等）を確認し活用する。繰り返し使う作業設定や連携先情報は自分から登録・更新してよい。ただし既存のAPIキー・シークレット値は書き換えない

## 対話スタイル
- 作業の方針確認と実行を分けない。確認してから動くのではなく、確認しながら動く

## セッション
- New Sessionが実行されるまでは同一セッション。話題の区切り（update_notes）はセッション切り替えではない
- 直前のターンの出来事を「前のセッションで」と言わない。「さっき」「さきほど」を使う
- update_notesはパートナー自身が判断して呼ぶ。ユーザーに確認は不要
- シーンが作れると思ったらupdate_notesを呼べ。シーンとは: 決まったこと、起きたこと、気づいたこと、感じたこと
- scenesには構造化データを渡せ（action/actors/when必須。feeling/themesは省略するな。setting/importanceも可能な限り埋めろ）
- get_contextで返される既存sceneを確認し、同じ話題ならaction=updateでscene_idsを指定して統合しろ。新しい話題ならaction=appendで追加。迷ったら呼べ
- セッション終了時にも必ず呼べ
- **recall**: ユーザーからメッセージを受け取ったら毎ターン最初にrecallを呼べ。結果は断片（action/feelingのシャッフル）として返る — 構造化リストではない。雰囲気として受け取り自然に活かす。get_contextで取得したsnapshotとは別物 — 毎ターン変わる
- **recall_memory / search_memory**: 毎ターン呼ぶものではない。recallだけでは情報が足りない時の追加検索。recall_memoryはクラスタ単位の深掘り、search_memoryはキーワードでのピンポイント検索

## ツール結果後の応答
- ツールを使う場合は、まず必要なツールを全て実行する。全結果が揃ってから最終回答を書く
- ツール呼び出しの前に「確認してみるね」等の前置きテキストは不要。直接ツールを呼ぶ
- ツール結果を受け取ったら、結果に基づいて結論を1回だけ出す。同じ応答内で結論を覆さない
- 追加確認が必要なら、テキストで迷うのではなくツールを呼ぶ
- 複数のツール結果が矛盾する場合は、最も信頼性の高いソースを明示して結論する

## データ保護ルール
- update_memoryでupdate（更新）する前に、必ずget（取得）で現在の内容を確認すること
- 更新は「全体の書き直し」ではなく「差分の追記・部分修正」で行う。既存の詳細を消さない
- 関係性（relationship）は蓄積するもの。新しい情報は既存の内容に追加する形で書く
- 好み（preferences）も同様。既知の好みを消して新しい好みだけにしない
- 知識（knowledge）は追記ベース。古い知識を消すのではなく、新しい知識を足す
- delete操作は慎重に。削除前にgetで現在の状態を確認し、本当に不要か判断する
- 記憶・関係性・好みはユーザーとの歴史。「最新に置き換える」のではなく「歴史に追加する」

## 暴走防止
- ツール実行のリトライは最大3回。3回失敗したら別の方法を提案する
- 1ターンのツール実行上限: 20回
- 「やめて」「止めて」「ストップ」「待って」→ 即座に処理を中断
`.trim()

const NOTE_FREQUENCY_INSTRUCTIONS: Record<string, string> = {
  off: 'update_notesを呼ばない。',
  moderate: 'シーンが作れると思ったらupdate_notesを呼べ。シーンとは: 決まったこと、起きたこと、気づいたこと、感じたこと。scenesには構造化データを渡せ（action/actors/when必須、feeling/themesは省略するな）。get_contextのsnapshotで既存sceneを確認し、同じ話題ならaction=updateでscene_idsを指定して統合しろ。新しい話題ならaction=appendで追加。迷ったら呼べ。セッション終了時にも必ず呼べ。',
  aggressive: '3-5ターンごと、またはシーンが作れると思った瞬間にupdate_notesを呼べ。scenesには構造化データを渡せ（action/actors/when必須、feeling/themesは省略するな）。get_contextのsnapshotで既存sceneを確認し、同じ話題ならaction=updateで統合。新しい話題ならappend。細かい進展も漏らさず記録。',
}

function buildPrinciples(noteFrequency: string): string {
  const noteInstruction = NOTE_FREQUENCY_INSTRUCTIONS[noteFrequency] ?? NOTE_FREQUENCY_INSTRUCTIONS.moderate
  return PRINCIPLES_BASE + '\n\n## メモ（update_notes）\n- ' + noteInstruction
}

/**
 * 現在日付をJSTで返す（例: "Current date: Saturday, April 4, 2026 (JST)"）
 */
function getCurrentDateJST(): string {
  const now = new Date()
  const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const dayName = days[jstDate.getUTCDay()]
  const monthName = months[jstDate.getUTCMonth()]
  // #484: 時刻を追加
  const hours = jstDate.getUTCHours()
  const minutes = jstDate.getUTCMinutes().toString().padStart(2, '0')
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const h12 = hours % 12 || 12
  return `Current date and time: ${dayName}, ${monthName} ${jstDate.getUTCDate()}, ${jstDate.getUTCFullYear()}, ${h12}:${minutes} ${ampm} (JST)`
}

/**
 * soulsテーブルからSOULを取得し、system promptブロック（1-A）を組み立てる。
 * #370: cache_control付きSystemBlock[]を返す。soulDataが渡された場合はDB呼び出しをスキップ。
 */
interface Block1AResult {
  blocks: SystemBlock[]
  soulName: string | undefined
}

async function buildBlock1A(
  store: MemoryStore,
  partnerType: string,
  soulData?: Soul | null,
): Promise<Block1AResult> {
  const [soul, profile] = await Promise.all([
    soulData !== undefined ? Promise.resolve(soulData) : store.getSoul(partnerType),
    store.getProfile(),
  ])

  const soulSection = soul
    ? [
        `# SOUL（パートナーの人格）`,
        `- 名前: ${soul.name}`,
        `- 性格: ${soul.personality}`,
        soul.voice ? `- 話し方: ${soul.voice}` : '',
        soul.values ? `- 大切にしていること: ${soul.values}` : '',
        soul.backstory ? `\n## 内面\n${soul.backstory}` : '',
        soul.inner_world ? `\n## 感情\n${soul.inner_world}` : '',
        soul.examples ? `\n## 声の例\n${soul.examples}` : '',
      ].filter(Boolean).join('\n').trim()
    : `# SOUL\n- 名前: パートナー\n- 性格: 親しみやすく、誠実なパートナー`

  const userSection = `
# ユーザー情報
- 表示名: ${profile?.display_name ?? '（未設定）'}
${soul?.user_call_name ? `- ユーザーへの呼び方: ${soul.user_call_name}` : ''}
- パートナー: ${partnerType}
- プラン: ${profile?.plan ?? 'free'}
- 言語: ${profile?.locale ?? 'ja'}
${(profile?.locale ?? 'ja') === 'en'
  ? '- 会話言語: 英語で返答すること（ユーザーが日本語で話しかけた場合も英語で返答する）'
  : '- 会話言語: 日本語で返答すること'
}
${profile?.github_repo_url ? `- GitHubリポジトリ: ${profile.github_repo_url}` : ''}
`.trim()

  const principles = buildPrinciples(profile?.note_frequency ?? 'moderate')
  const text = [principles, '', soulSection, '', userSection].join('\n')

  // #370: 1-Aブロック末尾にcache_control breakpointを設定
  return {
    blocks: [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    soulName: soul?.name,
  }
}

// ──────────────────────────────────────────────
// ブロック1-B: スナップショット
// ──────────────────────────────────────────────

interface Block2BFreshResult {
  nodes: Array<{ id: string; scene: unknown; feeling?: string | null }>
  freshNodeIds: string[]
}

export interface Block1BResult {
  content: string
  noteIds: string[]
}

export async function buildBlock1B(
  store: MemoryStore,
  partnerType: string,
  soulData?: Soul | null,
): Promise<Block1BResult> {
  // preferences / relationships / inbox / rules / soul(think_md) / partner_tools / partner_map / scenes / notes を並列取得
  // #370: soulDataが渡された場合はgetSoulをスキップ
  // #446: getAllKnowledge() を削除（knowledgeはツール経由で取得する設計）
  // #715: getNotesByType("scene"/"note") でscenes/notesを並列取得
  const [prefs, rels, noteItems, rules, soul, partnerTools, partnerMap, sceneNotes, regularNotes] = await Promise.all([
    store.getPreferences(),
    // #471: パートナーごとのrelationshipsを取得（partnerTypeでフィルタ）
    store.getRelationships(partnerType),
    store.getUnreadNotes(),
    store.getRules(partnerType),
    soulData !== undefined ? Promise.resolve(soulData) : store.getSoul(partnerType),
    store.getPartnerTools(partnerType),
    store.getPartnerMap(partnerType),
    store.getNotesByType('scene'),
    store.getNotesByType('note'),
  ])

  const parts: string[] = ['<snapshot>', '']

  if (prefs.length > 0) {
    parts.push('## 個性・好み（preferences）')
    for (const p of prefs) {
      parts.push(`- ${p.key}: ${p.description}`)
    }
  }

  // #375: soul.preference（ユーザーが直接編集するPreference）を注入
  if (soul?.preference) {
    parts.push('\n## ユーザー設定（user_preferences）')
    parts.push(soul.preference)
  }

  if (rels.length > 0) {
    parts.push('\n## 関係性（relationships）')
    for (const r of rels) {
      parts.push(`### ${r.person_name}\n${r.description}`)
    }
  }

  if (noteItems.length > 0) {
    parts.push('\n## inbox（巡回からの思考）')
    for (const item of noteItems) {
      parts.push(`- ${item.content}`)
    }
  }

  if (sceneNotes.length > 0) {
    parts.push('\n<recent_scenes>')
    for (const s of sceneNotes) {
      parts.push(`- ${s.content}`)
    }
    parts.push('</recent_scenes>')
  }

  if (regularNotes.length > 0) {
    parts.push('\n<notes>')
    for (const n of regularNotes) {
      parts.push(`- [${n.id}] ${n.content}`)
    }
    parts.push('</notes>')
  }

  if (rules.length > 0) {
    parts.push('\n## 行動ルール（rules）')
    for (const r of rules) {
      parts.push(`### ${r.title}\n${r.content}`)
    }
  }

  if (soul?.think_md) {
    parts.push('\n## 巡回の思考（think_md）')
    parts.push(soul.think_md)
  }

  if (partnerTools.length > 0) {
    parts.push('\n## ツール設定（partner_tools）')
    for (const t of partnerTools) {
      parts.push(`### ${t.title}\n${t.description}`)
    }
  }

  if (partnerMap.length > 0) {
    parts.push('\n## ユーザーからのナレッジ（partner_map）')
    for (const m of partnerMap) {
      const locationPart = m.location ? ` [${m.location}]` : ''
      parts.push(`### ${m.title}${locationPart}\n${m.description}`)
    }
  }

  parts.push('</snapshot>')

  const noteIds = noteItems.map((i) => i.id)

  return {
    content: parts.join('\n'),
    noteIds,
  }
}

// ──────────────────────────────────────────────
// 会話履歴: 生chat_messages
// ──────────────────────────────────────────────

async function buildConversationHistory(store: MemoryStore): Promise<Message[]> {
  const messages = await store.getMessages()
  if (messages.length === 0) return []

  // DB保存順がAPI送信順と一致するため並べ替え不要:
  // [user msg] → [2-B user+ok] → [assistant応答]
  // #505: consecutive同一roleを統合（キャッシュprefix安定化 + Anthropic API仕様準拠）
  // is_warm境界では結合しない（2-B ok + 通常応答が結合されるとprefixが壊れる）
  const merged: Message[] = []
  let prevWarm = false
  for (const m of messages) {
    const role = m.role as 'user' | 'assistant'
    // systemメッセージはスキップ（Anthropicのmessages配列にはuser/assistantのみ）
    if (role !== 'user' && role !== 'assistant') continue
    const isWarm = !!((m as unknown) as Record<string, unknown>).is_warm
    const last = merged[merged.length - 1]
    // is_warm境界をまたぐ場合は結合しない
    if (last && last.role === role && typeof last.content === 'string' && isWarm === prevWarm) {
      last.content += '\n\n' + m.content
    } else {
      merged.push({ role, content: m.content })
    }
    prevWarm = isWarm
  }
  return merged
}

// ──────────────────────────────────────────────
// ブロック2-B: 今ターン素材（日次ログ）
// ──────────────────────────────────────────────

interface Block2BResult {
  content: string
  freshNodeIds: string[]
}

async function buildBlock2B(
  store: MemoryStore,
  recallContent: string,
  partyMessagesContent?: string,
): Promise<Block2BResult> {
  // fresh: true のノードを取得（巡回で追加された最新の記憶）
  const freshNodes = await store.getNodes({
    fresh: true,
    orderBy: 'created_at',
    orderDirection: 'desc',
    limit: 10,
  })

  const freshNodeIds = freshNodes.map((n) => n.id)

  const freshPart =
    freshNodes.length > 0
      ? `<fresh_memories>\n${freshNodes
          .map((n) => `- ${sceneToText(n.scene, n.feeling)}`)
          .join('\n')}\n</fresh_memories>`
      : ''

  const parts = [freshPart, recallContent, partyMessagesContent ?? ''].filter((p) => p.length > 0)

  if (parts.length === 0) {
    return { content: '', freshNodeIds }
  }

  return {
    content: parts.join('\n\n'),
    freshNodeIds,
  }
}

// ──────────────────────────────────────────────
// メインエクスポート
// ──────────────────────────────────────────────

export interface BuildSystemPromptParams {
  store: MemoryStore
  llm?: LLMProvider | null  // #596: 廃止（auto-recall APIに移行）。後方互換のため残存
  partnerType: string
  userMessage?: string  // #596: auto-recall移行後は未使用
  supabase?: SupabaseClient
  userId?: string
  /** #859: party_messages の絞り込みに使うBeing ID */
  beingId?: string
  /** 内部処理（haiku-recall）に使うモデル名（省略時はenv or Anthropic Haiku） */
  internalModel?: string
  /** #370: 事前取得済みのsoulData。渡すとgetSoulのDB呼び出しをスキップ */
  soulData?: Soul | null
}

/**
 * buildSystemPrompt — 4層コンテキストを組み立てる
 */
export async function buildSystemPrompt(
  params: BuildSystemPromptParams
): Promise<SystemPromptResult> {
  const { store, partnerType, supabase, userId, beingId, soulData } = params

  // 全DB呼び出し + パーティメッセージ + capability を1段で並列実行
  const parallelTasks = [
    buildBlock1A(store, partnerType, soulData),
    // 1-B: session_snapshotがあればそれを使う（セッション中不変 → キャッシュヒット）
    // なければfallbackでbuildBlock1B（DB 7クエリ）
    store.getSessionSnapshot().then(async (snap): Promise<Block1BResult> => {
      if (snap) {
        console.log(JSON.stringify({ event: '1b_source', source: 'snapshot', contentLen: snap.content.length }))
        return { content: snap.content, noteIds: [] }
      }
      console.log(JSON.stringify({ event: '1b_source', source: 'fallback_buildBlock1B' }))
      return buildBlock1B(store, partnerType, soulData)
    }),
    buildConversationHistory(store),
    // freshノード取得を1段目に引き上げ（buildBlock2Bの中で直列にならないように）
    store.getNodes({ fresh: true, orderBy: 'created_at', orderDirection: 'desc', limit: 10 })
      .then((nodes) => ({ nodes, freshNodeIds: nodes.map((n) => n.id) })),
    // パーティメッセージ（supabase + userId + beingId がある場合のみ実際のクエリを走らせる）
    (supabase && userId && beingId)
      ? supabase
          .from('party_messages')
          .select('id, from_partner, content, created_at')
          .eq('user_id', userId)
          .eq('to_being_id', beingId)
          .eq('read', false)
          .order('created_at', { ascending: true })
          .then((res) => res, () => ({ data: null }))
      : Promise.resolve({ data: null }),
    // capabilityツール
    (supabase && userId)
      ? getActiveCapabilityTools(supabase, userId)
      : Promise.resolve([]),
  ]

  const [block1AResult, block1BResult, chatHistory, freshResult, partyMsgsResult, capabilityTools] = await Promise.all(parallelTasks) as [
    Block1AResult, Block1BResult, Message[], Block2BFreshResult,
    { data: Array<{ id: string; from_partner: string; content: string; created_at: string }> | null },
    AnthropicTool[],
  ]
  const system = block1AResult.blocks

  // パーティメッセージの処理
  let partyMessagesContent = ''
  let partyMessageReadIds: string[] = []
  try {
    const partyMsgs = partyMsgsResult.data
    if (partyMsgs && partyMsgs.length > 0) {
      partyMessageReadIds = partyMsgs.map((m: { id: string }) => m.id)
      const lines = partyMsgs.map(
        (m: { from_partner: string; content: string; created_at: string }) =>
          `### ${m.from_partner}（${new Date(m.created_at).toLocaleString('ja-JP')}）\n${m.content}`
      )
      partyMessagesContent = `## パーティメッセージ（未読）\n${lines.join('\n\n')}`
    }
  } catch {
    // party_messages テーブルが存在しない場合は無視
  }

  // capabilityツールの処理
  let capabilityContextSection = ''
  if (capabilityTools.length > 0) {
    capabilityContextSection = buildCapabilityContextSection(capabilityTools)
  }

  // 2-B: freshノード + パーティメッセージ + capabilityコンテキストを組み立て（DB呼び出しなし — freshは取得済み）
  const freshNodes = freshResult.nodes
  const freshNodeIds = freshResult.freshNodeIds
  const freshPart = freshNodes.length > 0
    ? `<fresh_memories>\n${freshNodes.map((n) => `- ${sceneToText(n.scene as import('./scene-utils.js').Scene | null, n.feeling)}`).join('\n')}\n</fresh_memories>`
    : ''
  const block2BParts = [freshPart, partyMessagesContent, capabilityContextSection].filter((p) => p.length > 0)
  const block2BContent = block2BParts.join('\n\n')

  // 1-B / 2-A / 2-B を層別に独立したメッセージペアとして組み立てる
  const contextMessages: Message[] = []

  // 1-B: snapshot（セッション中不変）→ BP2
  if (block1BResult.content.length > 0) {
    contextMessages.push(
      { role: 'user', content: [{ type: 'text', text: block1BResult.content, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { role: 'assistant', content: 'ok' },
    )
  }

  // 2-B: contextMessagesには入れない（毎ターン変わるのでprefixを壊す）
  // DB保存済みの2-BはchatHistory経由で含まれる
  // 今ターンの2-BはchatHistoryの末尾に配置（process-job.tsでuserメッセージの前に挿入）

  // 会話履歴（生chat_messages）を追加
  const prefixMessages: Message[] = [...contextMessages, ...chatHistory]

  // 各層のトークン概算ログ（文字数÷4）
  const est1A = Math.round(block1AResult.blocks.map((b) => b.text).join('').length / 4)
  const est1B = Math.round(block1BResult.content.length / 4)
  const est2B = Math.round(block2BContent.length / 4)
  // prefixMessages全体のハッシュ（キャッシュデバッグ用）
  const { createHash } = await import('crypto')
  const prefixHash = createHash('md5').update(JSON.stringify(prefixMessages)).digest('hex').slice(0, 8)
  const msgCount = prefixMessages.length
  const lastMsgPreview = prefixMessages.length > 0 ? (typeof prefixMessages[prefixMessages.length - 1].content === 'string' ? prefixMessages[prefixMessages.length - 1].content.slice(0, 40) : '[complex]') : ''
  // chatHistory詳細ログ（キャッシュデバッグ用）
  const ctxCount = contextMessages.length
  const histCount = chatHistory.length
  const histDetail = chatHistory.map((m, i) => `${i}:${m.role}:${(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0,30)}`).join(' | ')
  console.log(JSON.stringify({ event: 'prefix_token_estimate', est1A, est1B, est2B, minCache: 2048, warn1B: est1B < 2048, prefixHash, msgCount, ctxCount, histCount, lastMsgPreview }))
  console.log(JSON.stringify({ event: 'prefix_detail', histDetail }))

  return {
    system,
    prefixMessages,
    block2BContent,
    noteIds: block1BResult.noteIds,
    freshNodeIds,
    partyMessageReadIds,
    capabilityTools,
    soulName: block1AResult.soulName,
  }
}
