import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_KEYMAP, DEFAULT_SETTINGS, normalizeSettings } from '../client/src/settings.ts'

test('键位：旧存档没有 keymap 时落默认，非法值不会带出隐形键', () => {
  assert.deepEqual(normalizeSettings({}).keymap, DEFAULT_KEYMAP)
  assert.deepEqual(normalizeSettings(null).keymap, DEFAULT_KEYMAP)

  const s = normalizeSettings({
    keymap: {
      forward: 'KeyZ',
      back: 42,
      left: '',
      right: 'KeyD',
      heal: 'KeyH',
      // 表外动作不进入结果
      hack: 'KeyX',
    },
  })
  assert.equal(s.keymap.forward, 'KeyZ')
  assert.equal(s.keymap.back, DEFAULT_KEYMAP.back, '非字符串必须回落默认')
  assert.equal(s.keymap.left, DEFAULT_KEYMAP.left, '空键名必须回落默认')
  assert.equal(s.keymap.heal, 'KeyH')
  assert.equal('hack' in s.keymap, false)
  assert.equal(s.keymap, s.keymap, '对象本身可序列化')
  assert.deepEqual(Object.keys(s.keymap).sort(), Object.keys(DEFAULT_KEYMAP).sort())
})

test('默认设置能直接序列化并被 normalize 原样读回', () => {
  const round = normalizeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))
  assert.deepEqual(round.keymap, DEFAULT_KEYMAP)
  assert.equal(round.brightness, DEFAULT_SETTINGS.brightness)
})
