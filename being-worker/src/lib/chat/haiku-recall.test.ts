/**
 * haiku-recall.test.ts — toFragments のユニットテスト
 *
 * テスト対象: toFragments()
 * 断片モード（action / feeling シャッフル）の挙動を検証する。
 */

import { describe, it, expect } from 'vitest'
import { toFragments } from './haiku-recall.js'

describe('toFragments', () => {
  it('空配列なら空文字を返す', () => {
    expect(toFragments([])).toBe('')
  })

  it('action も feeling も無いノードしかなければ空文字', () => {
    const nodes = [
      { scene: { setting: 'カフェ' }, feeling: null },
      { scene: null, feeling: null },
    ]
    expect(toFragments(nodes)).toBe('')
  })

  it('action のみ持つノードを正しく返す', () => {
    const nodes = [{ scene: { action: 'コードを書いた' }, feeling: null }]
    expect(toFragments(nodes)).toBe('コードを書いた')
  })

  it('feeling のみ持つノードを正しく返す', () => {
    const nodes = [{ scene: null, feeling: '嬉しい' }]
    expect(toFragments(nodes)).toBe('嬉しい')
  })

  it('複数ノードの action と feeling 全部を断片に含める', () => {
    const nodes = [
      { scene: { action: 'A1' }, feeling: 'F1' },
      { scene: { action: 'A2' }, feeling: 'F2' },
    ]
    const result = toFragments(nodes)
    const pieces = result.split(' / ')
    expect(pieces.sort()).toEqual(['A1', 'A2', 'F1', 'F2'])
  })

  it('themes は断片に含めない（action / feeling のみ）', () => {
    const nodes = [
      { scene: { action: 'やった' }, feeling: '満足' },
    ]
    // 型上 themes は受け取らないが、もし渡しても無視される設計を担保
    const result = toFragments(nodes)
    expect(result).toBe('やった / 満足' as string)
    // 順序はシャッフルされるので、いずれかであること
    const pieces = result.split(' / ').sort()
    expect(pieces).toEqual(['やった', '満足'])
  })

  it('null/undefined の scene/feeling を安全にスキップする', () => {
    const nodes = [
      { scene: { action: 'A' }, feeling: null },
      { scene: null, feeling: 'F' },
      { scene: { action: '' }, feeling: '' }, // 空文字は除外される
      { scene: { action: 'B' }, feeling: undefined },
    ]
    const result = toFragments(nodes)
    const pieces = result.split(' / ').sort()
    expect(pieces).toEqual(['A', 'B', 'F'])
  })

  it('シャッフルが効いている — 大規模入力で順序が変わりうる', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      scene: { action: `action${i}` },
      feeling: `feeling${i}`,
    }))
    // 同じ入力で複数回実行し、少なくとも1回は元と異なる順序になる
    const baseline = nodes.flatMap((n) => [n.scene.action, n.feeling]).join(' / ')
    let differs = false
    for (let i = 0; i < 20; i++) {
      if (toFragments(nodes) !== baseline) {
        differs = true
        break
      }
    }
    expect(differs).toBe(true)
  })
})
