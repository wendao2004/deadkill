import test from 'node:test'
import assert from 'node:assert/strict'

// 相对路径导入：仓库根 node_modules 下没有 @dk/* 的 workspace 链接。
import {
  Buttons,
  computeMoveVelocity,
  GROUND_FRICTION,
  SPEED_SPRINT,
  SPEED_WALK,
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

test('斜向移动不比直向快：同一输入模长下速度大小一致', () => {
  // computeMoveVelocity 把 (forward, right) 归一化后再乘 wishSpeed，
  // 所以 45 度斜走和直走必须收敛到同一个速率。差一点点就意味着角色斜着
  // 走能跑赢直着走。
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
      const label = 'magnitude=' + magnitude + ' yaw=' + yaw
      assert.ok(
        Math.abs(straightSpeed - diagonalSpeed) <= 1e-6,
        label + ': 直走 ' + straightSpeed + ' vs 斜走 ' + diagonalSpeed,
      )
      // 两者都必须命中 wishSpeed = SPEED_WALK * magnitude，而不是只有"彼此相等"。
      assert.ok(Math.abs(straightSpeed - SPEED_WALK * magnitude) <= 1e-6, label + ': 直走速率偏离 wishSpeed')
      assert.ok(Math.abs(diagonalSpeed - SPEED_WALK * magnitude) <= 1e-6, label + ': 斜走速率偏离 wishSpeed')
    }
  }
})

test('斜向移动的朝向是 45 度：右+前在水平面上各占一半', () => {
  const yaw = 0.35
  const velocity = steadyState({ vx: 0, vz: 0 }, () => input({ forward: 1, right: 1, yaw }), 240)
  // wishDir 是 (forward + right) 归一化的结果，与 forward 夹角必须是 45 度。
  const forwardX = -Math.sin(yaw)
  const forwardZ = -Math.cos(yaw)
  const speed = Math.hypot(velocity.vx, velocity.vz)
  const cosine = (velocity.vx * forwardX + velocity.vz * forwardZ) / speed
  assert.ok(Math.abs(cosine - Math.SQRT1_2) <= 1e-9, 'cos(angle) = ' + cosine)
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

  // 第一帧按 GROUND_FRICTION * dt 线性削减，验证衰减是不是真的在按摩擦力走。
  const initialSpeed = Math.hypot(start.vx, start.vz)
  assert.ok(Math.abs(speeds[0]! - (initialSpeed - GROUND_FRICTION * TICK_DT)) <= 1e-9, '首帧衰减 = ' + speeds[0])

  for (let i = 1; i < speeds.length; i++) {
    assert.ok(speeds[i]! <= speeds[i - 1]! + 1e-12, '第 ' + i + ' 帧速度回升了')
  }
  // 摩擦力是线性的，首速 5 m/s 大约 0.5s 停住；120 帧（2s）后必须精确为 0。
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
