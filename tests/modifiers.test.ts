import test from 'node:test'
import assert from 'node:assert/strict'

import { MODIFIERS, getModifier, rollModifier } from '../shared/src/modifiers.ts'

/**
 * 天气 = 时间带（07:00 昼 / 19:00 夜）× 四种天气。
 * 这两组必须同时存在，否则地图只会在一个时间带里循环。
 */
test('天气表：8 种组合，昼夜各 4 种，id 与下标一致', () => {
  assert.equal(MODIFIERS.length, 8)
  for (let i = 0; i < MODIFIERS.length; i++) assert.equal(MODIFIERS[i]!.id, i)
  assert.equal(MODIFIERS.filter((m) => m.time === 'night').length, 4)
  assert.equal(MODIFIERS.filter((m) => m.time === 'day').length, 4)
  assert.equal(getModifier(4).time, 'day')
  assert.equal(getModifier(4).hour, '07:00')
  assert.equal(getModifier(0).time, 'night')
  assert.equal(getModifier(0).hour, '19:00')
})

test('天气表：非法 id 回落到死寂，不会抛错', () => {
  assert.equal(getModifier(255).id, 0)
})

test('天气表：同一个种子抽到同一个时间带/天气', () => {
  const a = rollModifier(() => 0.01)
  const b = rollModifier(() => 0.01)
  assert.equal(a, b)
  // 0.9 落在最后一档（日间虫潮），0.01 落在第一档（死寂）。
  assert.equal(a, 0)
  assert.equal(rollModifier(() => 0.9), 7)
})
