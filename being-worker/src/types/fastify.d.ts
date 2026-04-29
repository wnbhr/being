/**
 * Fastify request 拡張型定義
 *
 * index.ts の onRequest フックで認証後に注入されるカスタムプロパティ。
 * これにより (request as any).beingUserId の any cast が不要になる。
 *
 * #933
 */
import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    beingUserId: string
    beingScope: string
    beingId?: string // OAuth トークン経由のみ
  }
}
