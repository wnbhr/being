export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface GenerateTextParams {
  model: string
  system: string
  messages: LLMMessage[]
  maxTokens: number
  timeoutMs?: number
}

export interface LLMProvider {
  generateText(params: GenerateTextParams): Promise<string>
}

/** BYOKで選択可能なLLMプロバイダ種別 */
export type ProviderType = 'anthropic' | 'openai' | 'google'

/** プロバイダごとのモデル一覧（チャット表示用） */
export const PROVIDER_MODELS: Record<ProviderType, string[]> = {
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
}

/**
 * 内部処理用モデル定数
 *
 * haiku-recall / recall キーワード抽出など、
 * パートナー会話以外の内部LLM呼び出しに使うモデル。
 *
 * - anthropic: 重い処理=Sonnet / 軽い処理=Haiku（コスト最適化）
 * - openai: GPT-4o-mini 統一（全処理これでOK）
 * - google: Gemini Flash 統一（全処理これでOK）
 *
 * NOTE: Anthropic = recommended / OpenAI, Google = experimental
 */
export const INTERNAL_MODELS: Record<ProviderType, { heavy: string; light: string }> = {
  anthropic: {
    heavy: process.env.COMPACTION_MODEL ?? 'claude-haiku-4-5-20251001',
    light: process.env.HAIKU_RECALL_MODEL ?? process.env.COMPACTION_MODEL ?? 'claude-haiku-4-5-20251001',
  },
  openai: {
    heavy: 'gpt-4o-mini',
    light: 'gpt-4o-mini',
  },
  google: {
    heavy: 'gemini-2.0-flash',
    light: 'gemini-2.0-flash',
  },
}

/** プロバイダの表示名 */
export const PROVIDER_LABELS: Record<ProviderType, { name: string; nameEn: string; keyPrefix: string; keyFormat: string }> = {
  anthropic: {
    name: 'Anthropic (Claude)',
    nameEn: 'Anthropic (Claude)',
    keyPrefix: 'sk-ant-',
    keyFormat: 'sk-ant-api03-...',
  },
  openai: {
    name: 'OpenAI (GPT-4o)',
    nameEn: 'OpenAI (GPT-4o)',
    keyPrefix: 'sk-',
    keyFormat: 'sk-proj-...',
  },
  google: {
    name: 'Google (Gemini)',
    nameEn: 'Google (Gemini)',
    keyPrefix: 'AIza',
    keyFormat: 'AIzaSy...',
  },
}

/** #474: 添付画像メタデータ */
export interface ImageAttachment {
  storage_path: string
  mime_type: string
  size: number
}
