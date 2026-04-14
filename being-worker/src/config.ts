export const config = {
  port: parseInt(process.env.WORKER_PORT ?? '3100'),
  workerSecret: process.env.WORKER_SECRET ?? '',
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  sandboxApiUrl: process.env.SANDBOX_API_URL,
  sandboxApiSecret: process.env.SANDBOX_API_SECRET,
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS ?? '20'),
  beingApiToken: process.env.BEING_API_TOKEN ?? '',      // フォールバック用（#546過渡期。DBトークン移行後に削除）
  beingApiUserId: process.env.BEING_API_USER_ID ?? '',   // フォールバック用（#546過渡期。request.beingUserIdに移行済み）
  publicUrl: process.env.PUBLIC_URL ?? '',               // Telegram Webhook 等で使用する公開URL（#651）
} as const

// 起動時バリデーション（.envなし環境でもビルドは通す）
if (process.env.NODE_ENV !== 'test') {
  const required = ['workerSecret', 'supabaseUrl', 'supabaseServiceRoleKey', 'encryptionKey'] as const
  for (const key of required) {
    if (!config[key]) {
      console.warn(`[config] Warning: ${key} is not set`)
    }
  }
  // Being API: BEING_API_TOKEN / BEING_API_USER_ID は過渡期フォールバック。being_api_tokensテーブル移行後は不要。
  if (!config.beingApiToken) {
    console.warn('[config] Warning: BEING_API_TOKEN is not set. /v1/ fallback auth will fail.')
  }
}
