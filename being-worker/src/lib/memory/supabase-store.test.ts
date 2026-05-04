/**
 * supabase-store.test.ts — 検索クエリ構築ヘルパーのユニットテスト
 *
 * テスト対象:
 *   - sanitizeSearchTerm()
 *   - buildSearchOrClause()
 *
 * search_memory の OR/AND 検索で PostgREST の or() フィルタに渡される
 * クエリ文字列が、構文記号で破損しないことを担保する。
 */

import { describe, it, expect } from 'vitest'
import { sanitizeSearchTerm, buildSearchOrClause } from './supabase-store.js'

describe('sanitizeSearchTerm', () => {
  it('普通の単語は変化なし', () => {
    expect(sanitizeSearchTerm('記憶')).toBe('記憶')
    expect(sanitizeSearchTerm('hello')).toBe('hello')
  })

  it('カンマを除去する（or() のセパレータ）', () => {
    expect(sanitizeSearchTerm('a,b')).toBe('ab')
  })

  it('丸括弧を除去する（in 構文）', () => {
    expect(sanitizeSearchTerm('a(b)c')).toBe('abc')
  })

  it('波括弧を除去する（配列リテラル）', () => {
    expect(sanitizeSearchTerm('{a}')).toBe('a')
  })

  it('ダブルクォートを除去する（配列値の引用）', () => {
    expect(sanitizeSearchTerm('"foo"')).toBe('foo')
  })

  it('ilike のワイルドカード % をエスケープする', () => {
    expect(sanitizeSearchTerm('50%')).toBe('50\\%')
  })

  it('ilike のワイルドカード _ をエスケープする', () => {
    expect(sanitizeSearchTerm('foo_bar')).toBe('foo\\_bar')
  })

  it('全部混ざったケース', () => {
    expect(sanitizeSearchTerm('a,b(c){d}"e"%f_g')).toBe('abcde\\%f\\_g')
  })

  it('空文字はそのまま空文字', () => {
    expect(sanitizeSearchTerm('')).toBe('')
  })
})

describe('buildSearchOrClause', () => {
  it('普通の単語は4フィールド分の or 句を生成する', () => {
    const result = buildSearchOrClause('記憶')
    expect(result).toBe(
      'scene->>action.ilike.%記憶%,feeling.ilike.%記憶%,themes.cs.{"記憶"},scene->>when.ilike.%記憶%'
    )
  })

  it('themes は配列値としてダブルクォートで括られる', () => {
    const result = buildSearchOrClause('感情')
    expect(result).toContain('themes.cs.{"感情"}')
  })

  it('action / feeling / when は ilike 部分一致になる', () => {
    const result = buildSearchOrClause('test')
    expect(result).toContain('scene->>action.ilike.%test%')
    expect(result).toContain('feeling.ilike.%test%')
    expect(result).toContain('scene->>when.ilike.%test%')
  })

  it('サニタイズで空になる入力は空文字を返す', () => {
    // カンマと括弧だけなら全部除去されて空に
    expect(buildSearchOrClause(',()')).toBe('')
    expect(buildSearchOrClause('{}')).toBe('')
    expect(buildSearchOrClause('""')).toBe('')
  })

  it('ワイルドカードを含む入力もエスケープされた状態で組み込まれる', () => {
    const result = buildSearchOrClause('50%')
    expect(result).toContain('scene->>action.ilike.%50\\%%')
  })

  it('構文記号入りでも or() 構文が壊れない', () => {
    // 入力に , ( ) { } " が混じってても、サニタイズ後の clause は
    // or() のパースを壊さない形になっている
    const result = buildSearchOrClause('a,b(c)')
    expect(result.includes(',(')).toBe(false)
    expect(result.includes(')')).toBe(false)
    // clause 内で意図的に使われる , とフィールド区切り記号は残る
    expect(result.split(',').length).toBe(4) // 4フィールド分（#942: when追加）
  })
})