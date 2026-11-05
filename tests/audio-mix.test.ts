import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OCCLUDED_CUTOFF_HZ,
  OCCLUDED_GAIN,
  airDelay,
  attenuationCutoff,
  attenuationGain,
  reverbWet,
} from '../client/src/audio-mix.ts'

// 这套曲线的意义只有一个：**远处的枪声必须听起来远**。压缩器曾经把它抹平过
// （-16dB/6:1 把 40m 的枪声抬回贴脸电平），所以把数值钉在测试里。

test('距离增益：4m 内平着走，之后按 1/d 掉', () => {
  assert.equal(attenuationGain(0), 1)
  assert.equal(attenuationGain(2), 1)
  assert.equal(attenuationGain(4), 1)
  assert.equal(attenuationGain(8), 0.5)
  assert.ok(Math.abs(attenuationGain(40) - 0.1) < 1e-9)
  // 100m 之外仍然听得见（信息），但只有贴脸的 4%。
  assert.ok(Math.abs(attenuationGain(100) - 0.04) < 1e-9)
  assert.equal(attenuationGain(400), 0.01) // GAIN_FLOOR
  // 单调，且永不静音。
  let previous = attenuationGain(0)
  for (let d = 1; d <= 400; d += 1) {
    const gain = attenuationGain(d)
    assert.ok(gain <= previous + 1e-12, `增益在 ${d}m 处反跳`)
    assert.ok(gain >= 0.01)
    previous = gain
  }
})

test('距离低通：越远越闷，地板 1.2k', () => {
  assert.equal(attenuationCutoff(0), 18000)
  assert.equal(attenuationCutoff(25), 9000)
  assert.ok(Math.abs(attenuationCutoff(200) - 2000) < 1e-9)
  assert.equal(attenuationCutoff(400), 1200) // 350m 之后压到地板
  let previous = attenuationCutoff(0)
  for (let d = 1; d <= 400; d += 1) {
    const cutoff = attenuationCutoff(d)
    assert.ok(cutoff <= previous + 1e-12, `截止频率在 ${d}m 处反跳`)
    previous = cutoff
  }
})

test('空气延迟：按声速累积，封顶 0.45s', () => {
  assert.ok(Math.abs(airDelay(34.3) - 0.1) < 1e-9)
  assert.ok(Math.abs(airDelay(150) - 150 / 343) < 1e-9)
  assert.equal(airDelay(1000), 0.45)
})

test('距离混响：贴脸是干的，80m 到顶', () => {
  assert.ok(Math.abs(reverbWet(0) - 0.06) < 1e-9)
  assert.ok(Math.abs(reverbWet(40) - (0.06 + 0.3 * 0.5)) < 1e-9)
  assert.ok(Math.abs(reverbWet(80) - 0.36) < 1e-9)
  assert.equal(reverbWet(800), 0.36)
})

test('遮挡参数：隔墙只剩两成音量且闷掉高频', () => {
  assert.ok(OCCLUDED_GAIN > 0.2 && OCCLUDED_GAIN < 0.5)
  assert.ok(OCCLUDED_CUTOFF_HZ <= 1000)
})
