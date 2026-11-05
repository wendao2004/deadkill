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
import { vecNormalizeXZ, yawToForward, yawToRight } from './math.ts'
import {
  AIR_ACCEL,
  Buttons,
  GROUND_ACCEL,
  GROUND_FRICTION,
  SPEED_ADS,
  SPEED_CROUCH,
  SPEED_SPRINT,
  SPEED_WALK,
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
  const sprint = (input.buttons & Buttons.Sprint) !== 0 && !crouch && !ads

  let speed = SPEED_WALK
  if (crouch) speed = SPEED_CROUCH
  else if (ads) speed = SPEED_ADS
  else if (sprint) speed = SPEED_SPRINT

  // 前 + 右合成后归一化：斜着走不能比直着走快。
  const fwd = yawToForward(input.yaw)
  const right = yawToRight(input.yaw)
  const wish = vecNormalizeXZ({
    x: fwd.x * input.forward + right.x * input.right,
    y: 0,
    z: fwd.z * input.forward + right.z * input.right,
  })
  const magnitude = Math.min(1, Math.hypot(input.forward, input.right))
  const wishSpeed = speed * magnitude

  let vx = state.vx
  let vz = state.vz

  // 地面摩擦只在没有移动意图时施加，否则会和加速互相拉扯。
  if (state.grounded && wishSpeed < 1e-3) {
    const cur = Math.hypot(vx, vz)
    if (cur > 1e-4) {
      const scale = Math.max(0, cur - GROUND_FRICTION * dt) / cur
      vx *= scale
      vz *= scale
    }
  }

  if (wishSpeed > 1e-3) {
    const maxDelta = (state.grounded ? GROUND_ACCEL : AIR_ACCEL) * dt
    vx = approach(vx, wish.x * wishSpeed, maxDelta)
    vz = approach(vz, wish.z * wishSpeed, maxDelta)
  }

  return { vx, vz, wishSpeed }
}

/** 把 v 朝 target 推进一步，步长不超过 maxDelta。 */
function approach(v: number, target: number, maxDelta: number): number {
  const d = target - v
  if (Math.abs(d) <= maxDelta) return target
  return v + Math.sign(d) * maxDelta
}

/** 眼睛位置 = 脚底 + 眼高。 */
export function eyePosition(feet: Vec3, eyeHeight: number): Vec3 {
  return { x: feet.x, y: feet.y + eyeHeight, z: feet.z }
}
