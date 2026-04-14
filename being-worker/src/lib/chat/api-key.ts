/**
 * api-key.ts — BYOK APIキー取得（マルチプロバイダ対応）
 *
 * BYOKユーザーのAPIキー（Anthropic/OpenAI/Google）を取得・復号する。
 * 暗号化: アプリ層AES-256-GCM（lib/utils/encryption.ts）
 *
 * #154: user_api_keys テーブルから取得する getApiKeyFromTable を追加
 * #183: Ruddia共有キー(process.env.ANTHROPIC_API_KEY)フォールバックを全て除去。
 *       BYOKキー未登録の場合はエラーを投げる。
 */

import { decrypt } from '../utils/encryption.js'
import type { ProviderType } from '../llm/types.js'
import type { SupabaseClient } from '@supabase/supabase-js'

interface ProfileForApiKey {
  plan: string
  llm_provider: string | null
  anthropic_api_key_encrypted: string | null
  openai_api_key_encrypted: string | null
  google_api_key_encrypted: string | null
}

/** プロフィールからアクティブなプロバイダを取得（デフォルトは 'anthropic'） */
export function getActiveProvider(profile: Pick<ProfileForApiKey, 'llm_provider'>): ProviderType {
  const p = profile.llm_provider
  if (p === 'openai' || p === 'google' || p === 'anthropic') return p
  return 'anthropic'
}

/**
 * getApiKey — BYOKキーを返す
 *
 * - 該当プロバイダのキーが設定済み → 復号して返す
 * - 未設定 → エラー（Ruddia共有キーは存在しない）
 */
export async function getApiKey(
  profile: ProfileForApiKey,
  provider?: ProviderType,
): Promise<string> {
  const activeProvider = provider ?? getActiveProvider(profile)

  const encrypted = getEncryptedKey(profile, activeProvider)
  if (encrypted) {
    try {
      return decrypt(encrypted)
    } catch {
      // 復号失敗 → 下のエラーへ
    }
  }

  throw new Error('APIキーが設定されていません。設定画面からAPIキーを登録してください')
}

/** Anthropic専用: 旧インターフェース互換のラッパー */
export async function getAnthropicKey(
  profile: Pick<ProfileForApiKey, 'plan' | 'anthropic_api_key_encrypted'>
): Promise<string> {
  return getApiKey(
    {
      plan: profile.plan,
      llm_provider: 'anthropic',
      anthropic_api_key_encrypted: profile.anthropic_api_key_encrypted,
      openai_api_key_encrypted: null,
      google_api_key_encrypted: null,
    },
    'anthropic',
  )
}

function getEncryptedKey(profile: ProfileForApiKey, provider: ProviderType): string | null {
  switch (provider) {
    case 'anthropic': return profile.anthropic_api_key_encrypted
    case 'openai':    return profile.openai_api_key_encrypted
    case 'google':    return profile.google_api_key_encrypted
  }
}

/**
 * getApiKeyFromTable — user_api_keys テーブルから APIキーを取得・復号 (#154)
 *
 * - user_api_keys に登録あり → 復号して返す
 * - 未登録 → エラー（#183: Ruddia共有キーフォールバック除去）
 */
export async function getApiKeyFromTable(
  supabase: SupabaseClient,
  userId: string,
  provider: ProviderType,
): Promise<string> {
  const { data } = await supabase
    .from('user_api_keys')
    .select('api_key_encrypted')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('is_valid', true)
    .maybeSingle() as { data: { api_key_encrypted: string } | null }

  if (data?.api_key_encrypted) {
    try {
      return decrypt(data.api_key_encrypted)
    } catch {
      // 復号失敗 → 下のエラーへ
    }
  }

  throw new Error('APIキーが設定されていません。設定画面からAPIキーを登録してください')
}
