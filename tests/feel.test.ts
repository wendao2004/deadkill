import test from 'node:test'
import assert from 'node:assert/strict'

import { Spring, impulseForPeak } from '../client/src/feel.ts'

/**
 * 后坐弹簧的"峰值反解"是这次调参的地基：如果它不准，所有毫米/角度
 * 都会变成另一组拍脑袋的数字。用真实 Spring 积分回放来验证。
 */

test('impulseForPeak：反解出的冲量让弹簧实际峰值命中目标（误差 < 5%）', () => {
  const cases: Array<[number, number, number]> = [
    [9, 0.42, 0.0055], // 后移 5.5mm
    [9, 0.42, 0.012], // 抬头 0.7°
    [5.4, 0.62, 0.02], // 更软的通道
  ]
  for (const [freq, damping, peak] of cases) {
    const spring = new Spring(freq, damping)
    spring.impulse(impulseForPeak(peak, freq, damping))
    let max = 0
    for (let i = 0; i < 2400; i++) {
      spring.step(1 / 240)
      max = Math.max(max, Math.abs(spring.value))
    }
    // 5% 而不是 2%：Spring 按帧 dt 再切子步，最后一段不足 1/360 的余量
    // 会带来几个百分点的差异；这条测试防的是数量级错误（旧代码差 30 倍）。
    assert.ok(
      Math.abs(max - peak) / peak < 0.05,
      `freq=${freq} damping=${damping}: expected ${peak}, got ${max}`,
    )
  }
})

test('Spring：dt<=0 不推进，长时间后回到目标位', () => {
  const spring = new Spring(9, 0.42)
  spring.impulse(0.5)
  const before = spring.value
  spring.step(0)
  assert.equal(spring.value, before)
  for (let i = 0; i < 4000; i++) spring.step(1 / 120)
  assert.equal(spring.value, 0)
  assert.equal(spring.velocity, 0)
})

test('Spring：掉帧时子步仍稳定，不发散', () => {
  const spring = new Spring(9, 0.42)
  spring.impulse(impulseForPeak(0.01, 9, 0.42))
  for (let i = 0; i < 30; i++) spring.step(0.1)
  assert.ok(Number.isFinite(spring.value))
  assert.ok(Math.abs(spring.value) < 0.02)
})
