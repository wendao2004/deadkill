/**
 * 快照投影的回归测试。
 *
 * 这里的失败模式都是"线上一起发生、本地很难复现"的那类：
 * - ackSeq 没清零 → 全场收到别人的输入序号，客户端会拿它校正自己的预测；
 * - projectPlayer 忘了填某个字段 → 快照里该字段恒为 undefined，客户端画不出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { attachAck, clearAck, projectPlayer, type PlayerViewSource } from '../shared/src/snapshotView.ts'

function source(id: number): PlayerViewSource {
  return {
    id,
    x: id,
    y: 0,
    z: -id,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0.5,
    pitch: -0.1,
    health: 100,
    flags: 1,
    weaponId: 2,
    ammo: 7,
    reserve: 30,
    slot: 0,
  }
}

test('快照投影：字段一对一映射，ackSeq 默认 0', () => {
  const view = projectPlayer(source(7))
  assert.equal(view.id, 7)
  assert.equal(view.x, 7)
  assert.equal(view.z, -7)
  assert.equal(view.weaponId, 2)
  assert.equal(view.ammo, 7)
  assert.equal(view.ackSeq, 0)
})

test('快照投影：ackSeq 只贴给收件人，编完立刻复位', () => {
  const view = [projectPlayer(source(11)), projectPlayer(source(22))]

  const index = attachAck(view, 22, 777)
  assert.equal(index, 1)
  assert.equal(view[1]!.ackSeq, 777)
  assert.equal(view[0]!.ackSeq, 0, '别人的 ackSeq 必须保持 0')

  clearAck(view, index)
  assert.equal(view[1]!.ackSeq, 0, '复位后才能发给下一个接收者')

  // 收件人不在这一份视图里（刚掉线）时不能抛，也不能贴错人。
  assert.equal(attachAck(view, 999, 5), -1)
})

test('快照投影：clearAck 容忍越界下标', () => {
  const view = [projectPlayer(source(1))]
  assert.doesNotThrow(() => clearAck(view, -1))
  assert.doesNotThrow(() => clearAck(view, 10))
})
