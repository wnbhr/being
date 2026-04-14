/**
 * warm.ts — /warm エンドポイント (#505: 廃止済み → /jobs へのリダイレクト)
 *
 * #492で追加されたが、#505でprocess-job統合に移行。
 * 後方互換のためエンドポイントは残し、/jobsにプロキシする。
 */

import type { FastifyPluginAsync } from 'fastify'

export const warmRoute: FastifyPluginAsync = async (app) => {
  app.post('/warm', async (request, reply) => {
    // 後方互換: /jobs へのプロキシ（#505移行完了後に削除可）
    return reply.code(301).send({ message: 'Use /jobs with is_warm: true instead' })
  })
}
