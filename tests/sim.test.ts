import test from 'node:test'
import assert from 'node:assert/strict'

// 相对路径导入：仓库根 node_modules 下没有 @dk/* 的 workspace 链接。
import {
  BACK_SCALE,
  Buttons,
  computeMoveVelocity,
  SPEED_SPRINT,
  SPEED_WALK,
  STOP_DECEL,
  STRAFE_SCALE,
  TICK_DT,
  type MoveState,
  type PlayerInput,
} from '../shared/src/index.ts'

function input(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return { seq: 0, dtMs: 16, forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0, ...overrides }
}

interface Velocity {
  vx: number
  vz: number
}

/** 从零速起步，把同一个输入跑满 steps 帧，返回末速度。 */
function steadyState(start: Velocity, make: (frame: number) => PlayerInput, steps: number, grounded = true): Velocity {
  let velocity = { ...start }
  for (let frame = 0; frame < steps; frame++) {
    const result = computeMoveVelocity(make(frame), { vx: velocity.vx, vy: 0, vz: velocity.vz, grounded }, TICK_DT, false)
    velocity = { vx: result.vx, vz: result.vz }
  }
  return velocity
}

test('斜向移动不比直向快：横移权重让斜走略慢，且永不超速', () => {
  // 源码的 wish 方向先按 strafeScale=0.92 / backScale=0.8 缩放本地轴，再
  // 归一化。因此"前 + 横"的斜走比直走略慢；但任何方向都不能超过直走速度。
  for (const magnitude of [0.25, 0.6, 1]) {
    for (const yaw of [0, 0.7, Math.PI / 2, -2.4]) {
      const straight = steadyState({ vx: 0, vz: 0 }, () => input({ forward: magnitude, right: 0, yaw }), 240)
      const diagonal = steadyState(
        { vx: 0, vz: 0 },
        () => input({ forward: magnitude / Math.SQRT2, right: magnitude / Math.SQRT2, yaw }),
        240,
      )
      const straightSpeed = Math.hypot(straight.vx, straight.vz)
      const diagonalSpeed = Math.hypot(diagonal.vx, diagonal.vz)
      const weightedLen = Math.hypot((magnitude / Math.SQRT2) * STRAFE_SCALE, magnitude / Math.SQRT2)
      const label = 'magnitude=' + magnitude + ' yaw=' + yaw
      assert.ok(straightSpeed <= SPEED_WALK * magnitude + 1e-6, label + ': 直走超速')
      assert.ok(diagonalSpeed <= straightSpeed + 1e-9, label + ': 斜走比直走快')
      assert.ok(
        Math.abs(straightSpeed - SPEED_WALK * magnitude) <= 1e-6,
        label + ': 直走速率偏离 wishSpeed',
      )
      assert.ok(
        Math.abs(diagonalSpeed - SPEED_WALK * weightedLen) <= 1e-6,
        label + ': 斜走速率偏离加权 wishSpeed',
      )
    }
  }
})

test('倒退比前进慢：backScale 直接作用在纵轴', () => {
  const forward = steadyState({ vx: 0, vz: 0 }, () => input({ forward: 1 }), 240)
  const backward = steadyState({ vx: 0, vz: 0 }, () => input({ forward: -1 }), 240)
  const f = Math.hypot(forward.vx, forward.vz)
  const b = Math.hypot(backward.vx, backward.vz)
  assert.ok(Math.abs(b - f * BACK_SCALE) <= 1e-6, '倒退 ' + b + ' vs 前进 ' + f)
})

test('斜向移动的朝向由 strafeScale 决定，不是几何 45 度', () => {
  const yaw = 0.35
  const velocity = steadyState({ vx: 0, vz: 0 }, () => input({ forward: 1, right: 1, yaw }), 240)
  // 本地轴先缩放 (right*0.92, forward*1) 再归一化；横移权重让小角度更偏前。
  const forwardX = -Math.sin(yaw)
  const forwardZ = -Math.cos(yaw)
  const speed = Math.hypot(velocity.vx, velocity.vz)
  const cosine = (velocity.vx * forwardX + velocity.vz * forwardZ) / speed
  const expected = 1 / Math.hypot(1, STRAFE_SCALE)
  assert.ok(Math.abs(cosine - expected) <= 1e-9, 'cos(angle) = ' + cosine + '，期望 ' + expected)
})

test('无输入时速度单调衰减到 0，且永不为负', () => {
  const start = { vx: 4, vz: -3 }
  let velocity = { ...start }
  const speeds: number[] = []
  for (let frame = 0; frame < 120; frame++) {
    const result = computeMoveVelocity(input(), { vx: velocity.vx, vy: 0, vz: velocity.vz, grounded: true }, TICK_DT, false)
    // wishSpeed 为 0 时不该产生加速。
    assert.equal(result.wishSpeed, 0)
    velocity = { vx: result.vx, vz: result.vz }
    speeds.push(Math.hypot(velocity.vx, velocity.vz))
  }

  // 第一帧按 STOP_DECEL * dt 线性削减，验证松手时走的是"停止减速度"而不是加速档。
  const initialSpeed = Math.hypot(start.vx, start.vz)
  assert.ok(Math.abs(speeds[0]! - (initialSpeed - STOP_DECEL * TICK_DT)) <= 1e-9, '首帧衰减 = ' + speeds[0])

  for (let i = 1; i < speeds.length; i++) {
    assert.ok(speeds[i]! <= speeds[i - 1]! + 1e-12, '第 ' + i + ' 帧速度回升了')
  }
  // 5 m/s 在 30 m/s² 下约 0.167s 停住；120 帧（2s）后必须精确为 0。
  assert.equal(speeds[speeds.length - 1], 0)
  assert.ok(speeds.every((speed) => speed >= 0), '出现了负速度')
  assert.ok(speeds.every((speed) => Number.isFinite(speed)), '出现了 NaN / Infinity')
})

test('没有速度时松手不会把速度推成负数', () => {
  // 静止 + 无输入：既不能靠摩擦力反向加速，也不能出现 -0 之外的负数。
  const result = computeMoveVelocity(input(), { vx: 0, vy: 0, vz: 0, grounded: true }, TICK_DT, false)
  assert.equal(result.vx, 0)
  assert.equal(result.vz, 0)
})

test('同一段输入序列跑两遍得到逐位相同的结果', () => {
  // 客户端预测依赖这条性质：任何一次"同样的输入算出不同速度"都会让
  // reconciliation 每帧把玩家往回拽。
  const sequence: PlayerInput[] = [
    input({ forward: 1, buttons: Buttons.Sprint }),
    input({ forward: 1, right: 0.4, buttons: Buttons.Sprint }),
    input({ forward: 0.5, right: -1, buttons: Buttons.Jump }),
    input({ forward: 0, right: 0, buttons: Buttons.Crouch }),
    input({ right: 1, yaw: 1.2 }),
    input({ forward: -1, yaw: -0.9, buttons: Buttons.Ads }),
    input({ buttons: Buttons.Jump }),
    input(),
  ]

  const runOnce = (): { vx: number; vz: number; wishSpeed: number }[] => {
    let state: MoveState = { vx: 0, vy: 0, vz: 0, grounded: true }
    const out: { vx: number; vz: number; wishSpeed: number }[] = []
    for (const step of sequence) {
      const result = computeMoveVelocity(step, state, TICK_DT, (step.buttons & Buttons.Ads) !== 0)
      out.push(result)
      state = { vx: result.vx, vy: 0, vz: result.vz, grounded: true }
    }
    return out
  }

  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(second, first)
  // 逐位相等而不只是"近似相等"：数组里不能有 NaN（NaN !== NaN 会让
  // deepEqual 静默失败或永远不等）。
  for (const step of first) {
    assert.ok(Number.isFinite(step.vx) && Number.isFinite(step.vz), '出现了非有限速度')
  }
})

test('速度不随帧率变化：同样的总时长用不同 dt 切分，结果接近', () => {
  // 客户端 144Hz、服务端 60Hz 时，只要加速度模型对 dt 一致，速率就必须
  // 收敛到同一个 wishSpeed（这里是 60 = 6.4 * ... 的倍数关系，用长跑收敛）。
  const walk = (dt: number, steps: number): number => {
    let velocity = { vx: 0, vz: 0 }
    for (let i = 0; i < steps; i++) {
      const result = computeMoveVelocity(input({ forward: 1, buttons: Buttons.Sprint }), { vx: velocity.vx, vy: 0, vz: velocity.vz, grounded: true }, dt, false)
      velocity = { vx: result.vx, vz: result.vz }
    }
    return Math.hypot(velocity.vx, velocity.vz)
  }
  assert.ok(Math.abs(walk(1 / 144, 1440) - SPEED_SPRINT) <= 1e-9)
  assert.ok(Math.abs(walk(TICK_DT, 600) - SPEED_SPRINT) <= 1e-9)
})
