/**
 * keyed-async-queue.ts — spec-38 ユーザー単位ジョブ直列化
 *
 * OpenClaw の KeyedAsyncQueue を移植。
 * 同じキー（user_id）のタスクは Promise チェーンで直列化され、
 * 異なるキーは並行実行される。
 *
 * - エラーが起きても次のタスクは実行される（.catch(() => void 0) でチェーン切断を防止）
 * - 完了後にキーを Map から自動削除（メモリリーク防止）
 */

export class KeyedAsyncQueue {
  private tails = new Map<string, Promise<void>>()

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const current = (this.tails.get(key) ?? Promise.resolve())
      .catch(() => void 0)
      .then(task)
    const tail = current.then(() => void 0, () => void 0)
    this.tails.set(key, tail)
    tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return current
  }

  /** キューに溜まっているキーの数（監視用） */
  get size(): number {
    return this.tails.size
  }
}
