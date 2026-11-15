import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LEVER_RELOAD,
  REVOLVER_RELOAD,
  SHOTGUN_RELOAD,
  sampleReloadTimeline,
  type ReloadPose,
} from '../client/src/reload-timeline.ts'

/**
 * 时间轴是"换弹时零件在第几成进度到哪"的唯一来源。采样错了不会报错，
 * 只会让杠杆卡在半空、转轮倒着转 —— 所以这里把边界、关键帧、缓动都钉住。
 */

function pose(): ReloadPose {
  return { lever: 0, hammer: 0, cylinder: 0 }
}

test('时间轴：未配置时输出全 0，调用方可以直接叠加', () => {
  const out = pose()
  sampleReloadTimeline(undefined, 0.5, out)
  assert.deepEqual(out, { lever: 0, hammer: 0, cylinder: 0 })
})

test('时间轴：关键帧精确命中，越界夹在首尾', () => {
  const out = pose()
  sampleReloadTimeline(LEVER_RELOAD, 0.2, out)
  assert.ok(Math.abs(out.lever - -0.55) < 1e-9)
  sampleReloadTimeline(LEVER_RELOAD, 0.1, out)
  assert.equal(out.lever, 0)
  sampleReloadTimeline(LEVER_RELOAD, 0.95, out)
  assert.equal(out.lever, 0)
  // 越界也不能外推。
  sampleReloadTimeline(LEVER_RELOAD, -1, out)
  assert.equal(out.lever, 0)
  sampleReloadTimeline(LEVER_RELOAD, 2, out)
  assert.equal(out.lever, 0)
})

test('时间轴：段内是 smoothstep，中点正好是两端均值', () => {
  const out = pose()
  // 0.2 → 0.3 之间：-0.55 → 0，t=0.25 时 x=0.5，smoothstep(0.5)=0.5。
  sampleReloadTimeline(LEVER_RELOAD, 0.25, out)
  assert.ok(Math.abs(out.lever - -0.275) < 1e-9)
  // 缓动两端导数为 0：靠近起点时变化明显小于线性（值更接近起点的 -0.55）。
  const nearStart = pose()
  sampleReloadTimeline(LEVER_RELOAD, 0.21, nearStart)
  assert.ok(nearStart.lever < -0.5225)
})

test('时间轴：杠杆枪在装填段给两次压杆，击锤保持半 cock', () => {
  const out = pose()
  sampleReloadTimeline(LEVER_RELOAD, 0.2, out)
  const first = out.lever
  const hammerMid = out.hammer
  sampleReloadTimeline(LEVER_RELOAD, 0.78, out)
  const second = out.lever
  assert.ok(first < -0.4)
  assert.ok(second < -0.5)
  assert.ok(hammerMid < -0.4)
  // 装填中段（0.5）杠杆已经回位，击锤保持。
  sampleReloadTimeline(LEVER_RELOAD, 0.5, out)
  assert.equal(out.lever, 0)
  assert.ok(out.hammer < -0.4)
})

test('时间轴：转轮分三段转，终点回到一整圈', () => {
  const out = pose()
  sampleReloadTimeline(REVOLVER_RELOAD, 0.3, out)
  const a = out.cylinder
  sampleReloadTimeline(REVOLVER_RELOAD, 0.62, out)
  const b = out.cylinder
  sampleReloadTimeline(REVOLVER_RELOAD, 1, out)
  const end = out.cylinder
  assert.ok(a > 0)
  assert.ok(b > a)
  assert.ok(Math.abs(end - Math.PI * 2) < 1e-9)
})

test('时间轴：双管只有击锤轨道，杠杆/转轮保持 0', () => {
  const out = pose()
  sampleReloadTimeline(SHOTGUN_RELOAD, 0.4, out)
  assert.equal(out.lever, 0)
  assert.equal(out.cylinder, 0)
  assert.ok(out.hammer < -0.4)
})

test('时间轴：复用同一个输出对象，不分配新对象', () => {
  const out = pose()
  const returned = sampleReloadTimeline(LEVER_RELOAD, 0.2, out)
  assert.equal(returned, out)
})
