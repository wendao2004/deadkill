import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MODIFIERS,
  TIME_BANDS,
  TIME_BAND_LABEL,
  getModifier,
  isTimeBand,
  rollModifier,
} from '../shared/src/modifiers.ts'

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

/**
 * 大厅选时段（07:00 / 19:00）之后，本局只能落在对应那一半天气池里。
 *
 * 玩家选的是"几点进场"，不是"玩哪一场"：天气仍然随机，但不能跨时段 ——
 * 否则选了夜晚进去却是正午的日头，选时段这个功能就只是装饰。
 */
test('按时段抽签：只返回该时段的天气，且一天四档都会被抽到', () => {
  for (const time of ['day', 'night'] as const) {
    const seen = new Set<number>()
    for (let i = 0; i < 64; i++) {
      const id = rollModifier(() => (i + 0.5) / 64, time)
      assert.equal(getModifier(id).time, time, `抽到 ${id} 不属于 ${time}`)
      seen.add(id)
    }
    assert.equal(seen.size, 4, `${time} 的四档天气都应该被抽到`)
  }
})

test('不传时段时保持旧行为（全池随机），旧调用方不用改', () => {
  assert.equal(rollModifier(() => 0.01), 0)
  assert.equal(rollModifier(() => 0.9), 7)
  assert.equal(rollModifier(() => 0.9, null), 7)
})

test('时段表：两个整点与 UI 文案同源', () => {
  assert.deepEqual([...TIME_BANDS], ['day', 'night'])
  assert.equal(TIME_BAND_LABEL.day.hour, '07:00')
  assert.equal(TIME_BAND_LABEL.night.hour, '19:00')
  assert.equal(isTimeBand('day'), true)
  assert.equal(isTimeBand('dusk'), false)
})
