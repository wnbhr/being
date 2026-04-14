import type { FastifyPluginAsync } from 'fastify'
import { processJob, activeJobMap, cancelJob, getActiveJobId } from '../worker/process-job.js'
import { config } from '../config.js'
import { KeyedAsyncQueue } from '../lib/keyed-async-queue.js'

const userJobQueue = new KeyedAsyncQueue()

interface JobBody {
  user_id: string
  message_id: string
  content: string
  partner_type: string
  provider: 'anthropic' | 'openai' | 'google'
  sandbox_enabled: boolean
  github_repo_url?: string
  github_token_encrypted?: string
  // #370: ペイロードに含めてDB呼び出しを削減
  plan?: string
  llm_provider?: string | null
  current_session_id?: string | null
  /** converse mode: Being ID */
  being_id?: string
  /** #505: ウォーミングジョブフラグ */
  is_warm?: boolean
}

// ──────────────────────────────────────────────
// キュー待機ユーティリティ
// 空きが出るまで exponential backoff でポーリング
// 最大3回リトライ（1s → 2s → 4s）
// ──────────────────────────────────────────────
const QUEUE_MAX_RETRIES = 3
const QUEUE_INITIAL_DELAY_MS = 1000

/**
 * Wait for a free job slot with exponential backoff.
 * Returns true if a slot became available, false if still full after retries.
 */
async function waitForSlot(): Promise<boolean> {
  let delay = QUEUE_INITIAL_DELAY_MS
  for (let attempt = 0; attempt < QUEUE_MAX_RETRIES; attempt++) {
    if (activeJobMap.size < config.maxConcurrentJobs) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay *= 2 // exponential backoff: 1s -> 2s -> 4s
  }
  // final check after last wait
  return activeJobMap.size < config.maxConcurrentJobs
}

export const jobsRoute: FastifyPluginAsync = async (app) => {
  app.post<{ Body: JobBody }>('/jobs', async (request, reply) => {
    // スロットが空くまで最大3回リトライ（exponential backoff: 1s, 2s, 4s）
    const slotAvailable = await waitForSlot()

    if (!slotAvailable) {
      return reply.code(429).send({ error: 'Too many concurrent jobs' })
    }

    const job = request.body
    const jobId = crypto.randomUUID()

    // ユーザー単位で直列化（同一ユーザーの並行実行を防止）
    // waitForSlot はキューに入ってから processJob 内で呼ばれる
    userJobQueue.enqueue(job.user_id, () =>
      processJob(jobId, job)
    ).catch((err) => {
      console.error(`[job ${jobId}] unhandled error:`, err)
    })

    return reply.code(202).send({ job_id: jobId, status: 'accepted' })
  })

  // #396: DELETE /jobs/:id/cancel — ジョブキャンセル
  app.delete<{ Params: { id: string }; Body: { user_id: string } }>('/jobs/:id/cancel', async (request, reply) => {
    const { id } = request.params
    const { user_id } = request.body ?? {}
    if (!user_id) return reply.code(400).send({ error: 'user_id required' })
    const cancelled = cancelJob(id, user_id)
    if (!cancelled) return reply.code(404).send({ error: 'Job not found or not owned by user' })
    return reply.code(200).send({ ok: true })
  })

  // #396: DELETE /jobs/cancel-active — ユーザーの実行中ジョブをキャンセル
  app.delete<{ Body: { user_id: string } }>('/jobs/cancel-active', async (request, reply) => {
    const { user_id } = request.body ?? {}
    if (!user_id) return reply.code(400).send({ error: 'user_id required' })
    const jobId = getActiveJobId(user_id)
    if (!jobId) return reply.code(404).send({ error: 'No active job found' })
    cancelJob(jobId, user_id)
    return reply.code(200).send({ ok: true, cancelled_job_id: jobId })
  })
}
