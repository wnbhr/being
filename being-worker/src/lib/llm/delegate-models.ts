/**
 * delegate-models.ts — being_delegate ツール用のモデル定数（#964）
 *
 * spec-40 人格特化SLMパイプラインで、人格SLMが重いタスクをLLMに委任する際の
 * モデル選択を complexity 軸で抽象化する。
 *
 * - light: 軽い知識質問・要約・簡単な計算など。Haiku相当。
 * - medium: 通常の作業・推論・コード生成。Sonnet相当。
 * - heavy: 複雑な推論・長大な分析・難しい設計判断。Opus相当。
 *
 * 各レベルのモデル名は環境変数で上書き可能（運用中の切替やコスト調整のため）。
 * 環境変数は呼び出し時に毎回読む（プロセス起動後に env を変えても反映されるよう）。
 */

export type DelegateComplexity = 'light' | 'medium' | 'heavy'

export const DELEGATE_DEFAULTS: Record<DelegateComplexity, string> = {
  light: 'claude-haiku-4-5-20251001',
  medium: 'claude-sonnet-4-6',
  heavy: 'claude-opus-4-7',
}

const ENV_KEY: Record<DelegateComplexity, string> = {
  light: 'DELEGATE_MODEL_LIGHT',
  medium: 'DELEGATE_MODEL_MEDIUM',
  heavy: 'DELEGATE_MODEL_HEAVY',
}

/**
 * complexity に対応するモデル名を返す。
 * 環境変数 DELEGATE_MODEL_LIGHT / _MEDIUM / _HEAVY で上書き可能。
 * 呼び出し時に毎回 env を読むため、プロセス再起動なしで切替できる。
 */
export function resolveDelegateModel(complexity: DelegateComplexity): string {
  const override = process.env[ENV_KEY[complexity]]
  if (override && override.trim()) return override
  return DELEGATE_DEFAULTS[complexity]
}

export function isValidComplexity(value: unknown): value is DelegateComplexity {
  return value === 'light' || value === 'medium' || value === 'heavy'
}

/**
 * complexity ごとの max_tokens 上限。
 * heavy (Opus) は長い分析を許容するため大きめ。
 * リクエストで指定されない場合は runDelegate の default (2048) が使われる。
 */
export const DELEGATE_MAX_TOKENS_LIMIT: Record<DelegateComplexity, number> = {
  light: 8192,
  medium: 8192,
  heavy: 16384,
}
