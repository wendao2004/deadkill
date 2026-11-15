import test from 'node:test'
import assert from 'node:assert/strict'

import { SceneHasher, combineHashes } from '../client/src/scene-hash.ts'

/**
 * 场景指纹是"同 seed 两次启动一致"的判据。它必须是确定性的、对内容变化敏感、
 * 且与遍历/异步加载顺序无关。这里把这三条钉住。
 */

test('场景哈希：同一串输入得到同一个 16 位摘要', () => {
  const a = new SceneHasher()
  const b = new SceneHasher()
  for (const h of [a, b]) {
    h.addString('Mesh:wall')
    h.addQuantized(1.234567)
    h.addBytes(new Uint8Array([1, 2, 3, 4]))
  }
  assert.equal(a.digest(), b.digest())
  assert.match(a.digest(), /^[0-9a-f]{16}$/)
})

test('场景哈希：一个数字/字符串不同就会分叉', () => {
  const base = new SceneHasher()
  base.addString('Mesh:wall')
  base.addQuantized(1.2345)
  const tweaked = new SceneHasher()
  tweaked.addString('Mesh:wall')
  tweaked.addQuantized(1.2346)
  assert.notEqual(base.digest(), tweaked.digest())

  const renamed = new SceneHasher()
  renamed.addString('Mesh:floor')
  renamed.addQuantized(1.2345)
  assert.notEqual(base.digest(), renamed.digest())
})

test('场景哈希：1e-4 以下的浮点噪声被量化吃掉', () => {
  const a = new SceneHasher()
  const b = new SceneHasher()
  a.addQuantized(3.00001)
  b.addQuantized(3.00002)
  assert.equal(a.digest(), b.digest())
})

test('合并哈希：与对象遍历顺序无关', () => {
  const parts = ['aaaa0000bbbb1111', 'cccc2222dddd3333', 'eeee4444ffff5555']
  const reversed = [...parts].reverse()
  assert.equal(combineHashes(parts), combineHashes(reversed))
  assert.equal(combineHashes(parts), combineHashes(parts))
  assert.notEqual(combineHashes(parts), combineHashes(parts.slice(1)))
})

test('场景哈希：字节流按位敏感', () => {
  const a = new SceneHasher()
  const b = new SceneHasher()
  a.addBytes(new Uint8Array([0, 1, 2, 255]))
  b.addBytes(new Uint8Array([0, 1, 3, 255]))
  assert.notEqual(a.digest(), b.digest())
})
