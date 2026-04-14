import type { FastifyPluginAsync } from 'fastify'
import { activeJobMap } from '../worker/process-job.js'

// #390: 3分以上実行中のジョブは「滞留」と見なす
const STALE_THRESHOLD_MS = 3 * 60 * 1000

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    const now = Date.now()
    let oldestJobAgeSec = 0
    for (const entry of activeJobMap.values()) {
      const age = (now - entry.startTime) / 1000
      if (age > oldestJobAgeSec) oldestJobAgeSec = age
    }
    const stale = oldestJobAgeSec > STALE_THRESHOLD_MS / 1000

    return {
      status: stale ? 'warning' : 'ok',
      active_jobs: activeJobMap.size,
      oldest_job_age_sec: Math.round(oldestJobAgeSec),
      stale,
      uptime: process.uptime(),
    }
  })
}
