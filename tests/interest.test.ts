/**
 * 兴趣管理纯函数：决定快照里是精确位姿、量化音频层，还是完全不下发。
 *
 * 这是“墙后不给人看精确坐标”的第一道护栏；真正的视线射线在服务端。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  INTEREST_AUDIO_RANGE,
  INTEREST_FULL_RANGE,
  interestPairKey,
  interestTier,
  quantizePosition,
} from '../shared/src/index.ts'

test('兴趣层级：同队永远精确，哪怕墙后', () => {
  assert.equal(interestTier(5, false, true), 'full')
  assert.equal(interestTier(200, false, true), 'full')
})

test('兴趣层级：可见且在 280m 内精确，否则 45m 内音频层，再远不下发', () => {
  assert.equal(interestTier(30, true, false), 'full')
  assert.equal(interestTier(INTEREST_FULL_RANGE, true, false), 'full')
  // 墙后但超出听觉半径：不下发。可见但超出 90m：也不下发。
  assert.equal(interestTier(80, false, false), 'none')
  assert.equal(interestTier(30, false, false), 'audio')
  assert.equal(interestTier(INTEREST_AUDIO_RANGE + 0.1, false, false), 'none')
  // 100m 通视仍在武器命中射程内，必须给精确位姿。
  assert.equal(interestTier(100, true, false), 'full')
  assert.equal(interestTier(INTEREST_FULL_RANGE, true, false), 'full')
  assert.equal(interestTier(INTEREST_FULL_RANGE + 1, true, false), 'none')
})

test('兴趣层级：可覆盖距离，用于怪物/Boss 的单独预算', () => {
  assert.equal(interestTier(60, true, false, { full: 50, audio: 40 }), 'none')
  assert.equal(interestTier(45, true, false, { full: 50, audio: 40 }), 'full')
})

test('音频层位置量化到 2m 网格，非法值回落到 0', () => {
  assert.equal(quantizePosition(7.3), 8)
  assert.equal(quantizePosition(-7.3), -8)
  assert.equal(quantizePosition(0.9), 0)
  assert.equal(quantizePosition(Number.NaN), 0)
  assert.equal(quantizePosition(5, 0), 0)
})

test('可见性缓存键在接收者/目标之间唯一', () => {
  assert.equal(interestPairKey(1, 2), '1:2')
  assert.notEqual(interestPairKey(1, 2), interestPairKey(2, 1))
})
