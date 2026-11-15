import test from 'node:test'
import assert from 'node:assert/strict'

import { parseQa, summarizeFrames } from '../client/src/qa.ts'

/**
 * QA 参数是"截图的合同"：解析错了不会报错，只会让同一 URL 拍出不同的图。
 * 所以这里逐条钉住边界，尤其是 `0`（冻结/关闭）与"没传"的区别。
 */

test('QA 参数：空 query 全部走默认，且不自动进场', () => {
  const qa = parseQa('')
  assert.equal(qa.quality, null)
  assert.equal(qa.renderScale, null)
  assert.equal(qa.noaudio, false)
  assert.equal(qa.post, true)
  assert.equal(qa.autostart, false)
  assert.equal(qa.fixedDt, null)
  assert.equal(qa.cam, null)
  assert.equal(qa.hud, true)
  assert.equal(qa.viewmodel, true)
})

test('QA 参数：dt=0 是冻结模拟，不是"没设"', () => {
  assert.equal(parseQa('?dt=0').fixedDt, 0)
  assert.equal(parseQa('?dt=16.67').fixedDt, 0.01667)
  assert.equal(parseQa('?dt=').fixedDt, null)
  assert.equal(parseQa('?dt=abc').fixedDt, null)
})

test('QA 参数：post/hud/vm 用 0 关闭，缺省为开', () => {
  assert.equal(parseQa('?post=0').post, false)
  assert.equal(parseQa('?hud=0').hud, false)
  assert.equal(parseQa('?vm=0').viewmodel, false)
  // 不带值的裸标志按"开"处理。
  assert.equal(parseQa('?noaudio').noaudio, true)
  assert.equal(parseQa('?noaudio=0').noaudio, false)
})

test('QA 参数：postfail 强制绕过整条后处理链', () => {
  assert.equal(parseQa('?postfail=1').postFail, true)
  assert.equal(parseQa('?postfail').postFail, true)
  assert.equal(parseQa('?postfail=0').postFail, false)
  assert.equal(parseQa('').postFail, false)
})

test('QA 参数：shot/bench/show 隐含自动进场', () => {
  assert.equal(parseQa('?shot=1').autostart, true)
  assert.equal(parseQa('?bench=1').autostart, true)
  assert.equal(parseQa('?show=lair').autostart, true)
  assert.equal(parseQa('?autostart=0').autostart, false)
})

test('QA 参数：show 默认清场（HUD/枪都不出），显式 1 可覆盖', () => {
  const show = parseQa('?show=lair')
  assert.equal(show.hud, false)
  assert.equal(show.viewmodel, false)

  const kept = parseQa('?show=lair&hud=1&vm=1')
  assert.equal(kept.hud, true)
  assert.equal(kept.viewmodel, true)
})

test('QA 参数：show=weapon 保留武器层（要展示的就是枪）', () => {
  const weapon = parseQa('?show=weapon')
  assert.equal(weapon.hud, false)
  assert.equal(weapon.viewmodel, true)
  // 显式 vm=0 仍然能关掉。
  assert.equal(parseQa('?show=weapon&vm=0').viewmodel, false)
})

test('QA 参数：画质别名映射到三档，未知值不猜', () => {
  assert.equal(parseQa('?q=low').quality, 'performance')
  assert.equal(parseQa('?q=ultra').quality, 'quality')
  assert.equal(parseQa('?q=balanced').quality, 'balanced')
  assert.equal(parseQa('?q=auto').quality, 'auto')
  assert.equal(parseQa('?q=nonsense').quality, null)
})

test('QA 参数：机位必须正好 6 个有限数，否则当作没设', () => {
  assert.deepEqual(parseQa('?cam=1,2,3,4,5,6').cam, { x: 1, y: 2, z: 3, tx: 4, ty: 5, tz: 6 })
  assert.equal(parseQa('?cam=1,2,3').cam, null)
  assert.equal(parseQa('?cam=1,2,3,4,5,NaN').cam, null)
})

test('QA 参数：分辨率倍率夹在 0.5..1，种子只认非负整数', () => {
  assert.equal(parseQa('?scale=0.2').renderScale, 0.5)
  assert.equal(parseQa('?scale=3').renderScale, 1)
  assert.equal(parseQa('?seed=4207').seed, 4207)
  assert.equal(parseQa('?seed=-1').seed, null)
})

test('QA 参数：wet 夹在 0..1，缺省跟随天气修饰', () => {
  assert.equal(parseQa('?wet=0').wet, 0)
  assert.equal(parseQa('?wet=1').wet, 1)
  assert.equal(parseQa('?wet=2').wet, 1)
  assert.equal(parseQa('?wet=-1').wet, 0)
  assert.equal(parseQa('').wet, null)
})

test('QA 参数：reload 夹在 0..1，缺省跟随玩家状态', () => {
  assert.equal(parseQa('?reload=0').reload, 0)
  assert.equal(parseQa('?reload=0.5').reload, 0.5)
  assert.equal(parseQa('?reload=2').reload, 1)
  assert.equal(parseQa('').reload, null)
})

test('基准统计：p99 取排序后的 99% 位置，且不改原数组', () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100 ms
  const result = summarizeFrames(samples, 'test-gpu')
  assert.ok(result)
  assert.equal(result.frames, 100)
  assert.equal(result.min, 1)
  assert.equal(result.max, 100)
  assert.equal(result.median, 51)
  assert.equal(result.p99, 100)
  assert.equal(result.gpu, 'test-gpu')
  // 调用方拿到的仍是原始顺序。
  assert.equal(samples[0], 1)
  assert.equal(samples[99], 100)
})

test('基准统计：空样本返回 null，不产生 NaN', () => {
  assert.equal(summarizeFrames([], 'x'), null)
})
