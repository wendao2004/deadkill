/**
 * 移动模拟：**客户端与服务端逐字共用这一段代码**。
 *
 * 这是 client-side prediction 能成立的前提。客户端预测自己往前走了 1 米，
 * 服务端算出来是 0.97 米，玩家看到的就是"每次都被往回拽一点点"。要消除这种
 * 漂移，唯一可靠的办法是让两边跑同一个函数、同一份常量、同一个物理引擎。
 *
 * 因此这个文件里**不许出现任何渲染、DOM、网络相关的东西**：只接受
 * `PlayerInput` 和当前速度，产出下一速度，是纯函数，可以单独测。
 */

import type { Vec3 } from './math.ts'
import { yawToForward, yawToRight } from './math.ts'
import {
  AIR_ACCEL_SCALE,
  AIR_SPEED_CAP,
  BACK_SCALE,
  Buttons,
  GROUND_ACCEL,
  GROUND_DECEL,
  SPEED_ADS,
  SPEED_CROUCH,
  SPEED_SPRINT,
  SPEED_WALK,
  SPRINT_FORWARD_DOT,
  STOP_DECEL,
  STRAFE_SCALE,
} from './constants.ts'
import type { PlayerInput } from './protocol.ts'

/** 参与加速计算的状态。 */
export interface MoveState {
  /** 当前速度（米/秒）。 */
  vx: number
  vy: number
  vz: number
  /** 上一帧是否站在地上，决定用地面加速还是空中加速。 */
  grounded: boolean
  /**
   * 是否处于冲刺。由 Character 维护（含 0.05s 起步延迟与抬枪/蹲伏取消）；
   * 缺省时按本帧输入即时判定，方便纯函数测试与回放。
   */
  sprinting?: boolean
}

export interface MoveResult {
  vx: number
  vz: number
  /** 本帧目标速度的大小，服务端用它判断输入是否超速。 */
  wishSpeed: number
}

/**
 * 根据输入算这一帧的水平速度。
 *
 * 加速模型是 Quake 风格的**逼近目标速度**，而不是直接赋值。直接赋值
 * （v = wishDir * speed）会让角色手感像在冰面上瞬移、松手瞬间刹停；
 * 逼近式保留了起步的迟滞和松手的滑行，这是射击游戏"重量感"的来源。
 *
 * 垂直方向不在这里处理：跳跃是瞬时赋值 + 重力积分，与水平加速无关。
 */
export function computeMoveVelocity(
  input: PlayerInput,
  state: MoveState,
  dt: number,
  ads: boolean,
): MoveResult {
  const crouch = (input.buttons & Buttons.Crouch) !== 0
  const rawInput = Math.hypot(input.forward, input.right)
  const forwardIntent = rawInput > 1e-4 ? input.forward / rawInput : 0
  const sprintButton = (input.buttons & Buttons.Sprint) !== 0
  // 冲刺是一个"状态"（起步延迟/取消条件都在 Character 里维护）；纯函数调用
  // 时退化成按本帧输入即时判定，测试与回放不需要额外的状态机。
  const sprinting =
    state.sprinting ??
    (sprintButton && rawInput > 0.45 && forwardIntent > SPRINT_FORWARD_DOT && !crouch && !ads)

  let speed = SPEED_WALK
  if (crouch) speed = SPEED_CROUCH
  else if (ads) speed = SPEED_ADS
  else if (sprinting) speed = SPEED_SPRINT

  // 方向权重：横移 0.92、倒退 0.8。先缩放本地轴，再合成世界方向并归一化，
  // 这样斜着走不会比直着走快（源码的 strafe/back scale 也是这个顺序）。
  const fwd = yawToForward(input.yaw)
  const right = yawToRight(input.yaw)
  const sx = input.right * STRAFE_SCALE
  const sz = input.forward >= 0 ? input.forward : input.forward * BACK_SCALE
  let wishLen = Math.hypot(sx, sz)
  let wishX = 0
  let wishZ = 0
  if (wishLen > 1e-5) {
    wishX = fwd.x * sz + right.x * sx
    wishZ = fwd.z * sz + right.z * sx
    const length = Math.hypot(wishX, wishZ)
    wishX /= length
    wishZ /= length
    if (wishLen > 1) wishLen = 1
  } else {
    wishLen = 0
  }

  const targetSpeed = speed * wishLen
  let vx = state.vx
  let vz = state.vz

  if (state.grounded) {
    // 三档响应：完全松手 30、减速 52、加速 92。不是固定摩擦 —— 松手和
    // 反向输入要用不同的减速度，否则要么刹不住、要么急停得像撞墙。
    const cur = Math.hypot(vx, vz)
    const rate = rawInput < 0.02 ? STOP_DECEL : targetSpeed < cur * 0.92 ? GROUND_DECEL : GROUND_ACCEL
    const step = rate * dt
    const dx = wishX * targetSpeed - vx
    const dz = wishZ * targetSpeed - vz
    const distance = Math.hypot(dx, dz)
    if (distance <= step) {
      vx = wishX * targetSpeed
      vz = wishZ * targetSpeed
    } else if (distance > 1e-9) {
      vx += (dx / distance) * step
      vz += (dz / distance) * step
    }
  } else if (wishLen > 1e-4) {
    // 空中只能"补"到 3.4 m/s，不能放大既有动量。滑铲/坠落带出去的速度
    // 可以转向，但不会因为按方向键越飞越快。
    const cap = AIR_SPEED_CAP * wishLen
    const along = vx * wishX + vz * wishZ
    const add = cap - along
    if (add > 0) {
      const accel = GROUND_ACCEL * AIR_ACCEL_SCALE * wishLen * dt
      const gain = Math.min(accel, add)
      vx += wishX * gain
      vz += wishZ * gain
    }
  }

  return { vx, vz, wishSpeed: targetSpeed }
}

/** 眼睛位置 = 脚底 + 眼高。 */
export function eyePosition(feet: Vec3, eyeHeight: number): Vec3 {
  return { x: feet.x, y: feet.y + eyeHeight, z: feet.z }
}
