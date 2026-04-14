/**
 * sandbox-tool.ts — spec-30 exec ツール定義
 *
 * sandbox_enabled = true のユーザーのみ Anthropic API に渡す。
 * sandbox_enabled = false の場合はツール定義を渡さない（AIがexecを提案しない）。
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { truncateOutput } from './tool-result-utils.js'

// ──────────────────────────────────────────────
// exec ツール定義
// ──────────────────────────────────────────────

export const EXEC_TOOL = {
  name: 'exec',
  description:
    'ワークスペースでシェルコマンドを実行する。コマンド実行・ビルド・テスト専用。' +
    '変更はGitHubリポジトリに自動コミットされる。' +
    '【アクセス権限】ユーザーのGitHubリポジトリにアクセスしコマンドを実行する。実行内容はユーザーが確認・管理できる。' +
    '【ブランチ】コード変更時はbranchを指定してfeatureブランチで作業すること。PRを出す場合はbranchが必須。' +
    '【注意】ファイルの作成・上書きにはexecではなくwrite_fileを使うこと。execはコマンド実行・ビルド・テスト専用。' +
    '【使い分け】ファイル一覧確認にはlist_files、ファイル内容確認にはread_fileを使う。execはコマンド実行専用。',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: '実行するシェルコマンド。例: "python3 script.py"、"ls -la"、"npm install"',
      },
      timeout: {
        type: 'number',
        description: 'タイムアウト秒数（デフォルト: 60、最大: 300）。長時間かかる処理は大きく設定する。',
      },
      branch: {
        type: 'string',
        description: 'コード変更時に使用するGitブランチ名。指定するとfeatureブランチで作業しmainへの直pushを防ぐ。例: "feat/fix-button-color"',
      },
    },
    required: ['command'],
  },
}

// ──────────────────────────────────────────────
// write_file ツール定義
// ──────────────────────────────────────────────

export const WRITE_TOOL = {
  name: 'write_file',
  description:
    'ワークスペースのファイルに内容を書き込む。新規作成・上書きに使う。' +
    '変更はGitHubリポジトリに自動コミットされる。' +
    '【必須】ファイルの作成・上書きには必ずこのツールを使う。execでcat/echo/ヒアドキュメントによるファイル書き込みは禁止。' +
    '【使い分け】タイポ修正や一部変更にはedit_fileを使う。write_fileはファイル全体を書き直す時だけ使う。',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: '/workspace からの相対パス。例: "src/index.ts"、"README.md"',
      },
      content: {
        type: 'string',
        description: '書き込むファイルの内容（全文）',
      },
      branch: {
        type: 'string',
        description: 'コード変更時に使用するGitブランチ名。例: "feat/update-readme"',
      },
    },
    required: ['path', 'content'],
  },
}

// ──────────────────────────────────────────────
// read_file ツール定義
// ──────────────────────────────────────────────

export const READ_TOOL = {
  name: 'read_file',
  description:
    'ワークスペースのファイル内容を読み取る。100KB上限。' +
    '【用途】ファイルの現状確認・レビューに使う。' +
    '【推奨】ファイル内容の確認にはexecのcatではなくread_fileを使う。' +
    '大きなファイルはoffset/limitで部分読みが可能。',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: '/workspace からの相対パス。例: "src/index.ts"',
      },
      offset: {
        type: 'number',
        description: '読み取り開始行（1-indexed）。指定しない場合はファイル先頭から。',
      },
      limit: {
        type: 'number',
        description: '読み取り行数。指定しない場合はファイル末尾まで。',
      },
    },
    required: ['path'],
  },
}

// ──────────────────────────────────────────────
// edit_file ツール定義
// ──────────────────────────────────────────────

export const EDIT_TOOL = {
  name: 'edit_file',
  description:
    'ファイルの一部を差分編集する。全体を書き直すのではなく、変更箇所だけを指定して修正する。' +
    'タイポ修正や小さな変更に最適。write_fileで全体を書き直す前にedit_fileを検討すること。' +
    '変更はGitHubリポジトリに自動コミットされる。' +
    '【重要】oldTextはファイル内でユニーク（1箇所のみ）である必要がある。',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: '/workspace からの相対パス。例: "src/index.ts"',
      },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: '置換対象のテキスト（ファイル内でユニークであること）' },
            newText: { type: 'string', description: '置換後のテキスト' },
          },
          required: ['oldText', 'newText'],
        },
        description: '差分編集の配列',
      },
      branch: {
        type: 'string',
        description: 'Gitブランチ名。例: "feat/fix-typo"',
      },
    },
    required: ['path', 'edits'],
  },
}

// ──────────────────────────────────────────────
// list_files ツール定義
// ──────────────────────────────────────────────

export const LIST_TOOL = {
  name: 'list_files',
  description:
    'ディレクトリ構造をツリー形式で表示する。' +
    'ファイルを探す時や、プロジェクト構造を把握する時に使う。' +
    'node_modules, .git, __pycache__, .next は自動除外。',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: '/workspace からの相対パス（デフォルト: "."）',
      },
      depth: {
        type: 'number',
        description: '最大深さ（デフォルト: 3）',
      },
    },
    required: [],
  },
}

// ──────────────────────────────────────────────
// sandbox_enabled チェック
// ──────────────────────────────────────────────

/**
 * getSandboxEnabled — ユーザーの sandbox_enabled を取得する
 *
 * @param supabase service role クライアント
 * @param userId ユーザーID
 * @returns sandbox_enabled の値（取得失敗時は false）
 */
export async function getSandboxEnabled(
  supabase: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('profiles')
    .select('sandbox_enabled')
    .eq('id', userId)
    .single() as { data: { sandbox_enabled: boolean } | null }

  return data?.sandbox_enabled ?? false
}

// ──────────────────────────────────────────────
// exec ツール実行ハンドラ
// ──────────────────────────────────────────────

export interface ExecInput {
  command: string
  timeout?: number
  branch?: string
}

export interface ExecResult {
  exit_code: number
  stdout: string
  stderr: string
  files_changed: string[]
  git_pushed: boolean
  duration_ms: number
}


export interface WriteInput {
  path: string
  content: string
  branch?: string
}

export interface WriteResult {
  success: boolean
  files_changed: string[]
  git_pushed: boolean
}

export interface ReadInput {
  path: string
  offset?: number
  limit?: number
}

export interface ReadResult {
  content: string
  size: number
  total_lines?: number
  from_line?: number
  to_line?: number
}

export interface EditInput {
  path: string
  edits: Array<{ oldText: string; newText: string }>
  branch?: string
}

export interface EditResult {
  success: boolean
  files_changed: string[]
  git_pushed: boolean
}

export interface ListInput {
  path?: string
  depth?: number
}

export interface ListResult {
  tree: string
  truncated: boolean
}

/**
 * formatWriteResult — write_file 結果を AI が読みやすい文字列に変換
 */
export function formatWriteResult(result: WriteResult): string {
  const lines: string[] = []
  lines.push(`success: ${result.success}`)
  if (result.files_changed.length > 0) {
    lines.push(`files_changed: ${result.files_changed.join(', ')}`)
  }
  if (result.git_pushed) {
    lines.push('git: committed and pushed')
  }
  return lines.join('\n')
}

/**
 * formatReadResult — read_file 結果を AI が読みやすい文字列に変換
 */
export function formatReadResult(result: ReadResult): string {
  const meta: string[] = [`size: ${result.size} bytes`]
  if (result.total_lines !== undefined) meta.push(`total_lines: ${result.total_lines}`)
  if (result.from_line !== undefined && result.to_line !== undefined) {
    meta.push(`lines: ${result.from_line}-${result.to_line}`)
  }
  return `${meta.join(', ')}\n\n${result.content}`
}

/**
 * formatEditResult — edit_file 結果を AI が読みやすい文字列に変換
 */
export function formatEditResult(result: EditResult): string {
  const lines: string[] = []
  lines.push(`success: ${result.success}`)
  if (result.files_changed.length > 0) {
    lines.push(`files_changed: ${result.files_changed.join(', ')}`)
  }
  if (result.git_pushed) {
    lines.push('git: committed and pushed')
  }
  return lines.join('\n')
}

/**
 * formatListResult — list_files 結果を AI が読みやすい文字列に変換
 */
export function formatListResult(result: ListResult): string {
  const suffix = result.truncated ? '\n... (truncated at 1000 entries)' : ''
  return result.tree + suffix
}

/**
 * formatExecResult — exec 結果を AI が読みやすい文字列に変換
 */
export function formatExecResult(result: ExecResult): string {
  const lines: string[] = []

  lines.push(`exit_code: ${result.exit_code}`)
  lines.push(`duration: ${result.duration_ms}ms`)

  if (result.stdout) {
    lines.push(`\nstdout:\n${truncateOutput(result.stdout, 3000)}`)
  }
  if (result.stderr) {
    lines.push(`\nstderr:\n${truncateOutput(result.stderr, 1000)}`)
  }
  if (result.files_changed.length > 0) {
    lines.push(`\nfiles_changed: ${result.files_changed.join(', ')}`)
  }
  if (result.git_pushed) {
    lines.push('git: committed and pushed')
  }

  return lines.join('\n')
}
