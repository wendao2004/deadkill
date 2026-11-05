/**
 * 角色物理体：**客户端与服务端共用的那一个实现**。
 *
 * 为什么必须共用：命中判定与移动判定都在服务端跑，但客户端要立刻看到自己的
 * 移动（预测）。只要两边的胶囊尺寸、控制器参数、重力、加速有任何一处不同，
 * 预测位置就会与权威位置持续偏移，表现为"贴着墙走会抖""跳起来落点不准"。
 * 这类 bug 的排查成本极高，所以宁可让 shared 依赖 Rapier，也不接受两份实现。
 *
 * Rapier 的 `@dimforge/rapier3d-compat` 把 WASM 内联成 base64，所以服务端
 * `node src/index.ts` 直接跑、客户端 Vite 也不用 wasm 插件。代价是使用任何
 * 构造函数之前必须 `await RAPIER.init()` 一次。
 */

import type {
  Collider,
  KinematicCharacterController,
  RigidBody,
  World,
} from '@dimforge/rapier3d-compat'
import { Capsule, ColliderDesc, RigidBodyDesc } from '@dimforge/rapier3d-compat'

import {
  Buttons,
  CHARACTER_OFFSET,
  MAX_HEALTH,
  PLAYER_CROUCH_HALF_HEIGHT,
  PLAYER_CROUCH_EYE_HEIGHT,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_HEIGHT,
  PLAYER_RADIUS,
  GRAVITY,
  JUMP_SPEED,
  StateFlags,
} from './constants.ts'
import type { Vec3 } from './math.ts'
import type { PlayerInput } from './protocol.ts'
import { computeMoveVelocity, type MoveState } from './sim.ts'

/** 站在地上时向下施加的贴地速度，避免角色控制器每帧"落地→离地→落地"抖动。 */
const GROUND_STICK_VY = -2

export interface CharacterOptions {
  halfHeight?: number
  radius?: number
  crouchHalfHeight?: number
  eyeHeight?: number
  crouchEyeHeight?: number
}

export class Character {
  readonly body: RigidBody
  readonly collider: Collider
  readonly controller: KinematicCharacterController

  vx = 0
  vy = 0
  vz = 0
  grounded = false
  crouching = false

  /** 当前胶囊半高（蹲下与站立不同）。 */
  private halfHeight: number
  private readonly radius: number
  private readonly standHalfHeight: number
  private readonly crouchHalfHeight: number
  private readonly eyeHeight: number
  private readonly crouchEyeHeight: number

  constructor(world: World, spawn: Vec3, options: CharacterOptions = {}) {
    this.standHalfHeight = options.halfHeight ?? PLAYER_HALF_HEIGHT
    this.radius = options.radius ?? PLAYER_RADIUS
    this.crouchHalfHeight = options.crouchHalfHeight ?? PLAYER_CROUCH_HALF_HEIGHT
    this.eyeHeight = options.eyeHeight ?? PLAYER_EYE_HEIGHT
    this.crouchEyeHeight = options.crouchEyeHeight ?? PLAYER_CROUCH_EYE_HEIGHT
    this.halfHeight = this.standHalfHeight

    // 运动学刚体：位置由我们（角色控制器）决定，物理引擎不施加冲量。
    // 用 dynamic 会被重力和其它刚体推动，角色就站不稳了。
    this.body = world.createRigidBody(
      RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawn.x,
        spawn.y + this.halfHeight + this.radius,
        spawn.z,
      ),
    )
    this.collider = world.createCollider(
      ColliderDesc.capsule(this.halfHeight, this.radius).setFriction(0),
      this.body,
    )

    this.controller = world.createCharacterController(CHARACTER_OFFSET)
    // 台阶：允许自动跨过 40cm 高的箱子边角，否则木箱堆之间会被卡住。
    this.controller.enableAutostep(0.4, 0.2, true)
    // 下坡吸附：不做的话走下斜坡会一段段腾空。
    this.controller.enableSnapToGround(0.3)
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180)
    this.controller.setMinSlopeSlideAngle((35 * Math.PI) / 180)
    this.controller.setApplyImpulsesToDynamicBodies(true)
    this.controller.setCharacterMass(80)
  }

  /** 脚底位置（胶囊中心减去半高与半径）。 */
  get feet(): Vec3 {
    const t = this.body.translation()
    const bottom = this.halfHeight + this.radius
    return { x: t.x, y: t.y - bottom, z: t.z }
  }

  /** 眼睛位置 —— 射线起点。 */
  get eye(): Vec3 {
    const f = this.feet
    return { x: f.x, y: f.y + (this.crouching ? this.crouchEyeHeight : this.eyeHeight), z: f.z }
  }

  get eyeHeightCurrent(): number {
    return this.crouching ? this.crouchEyeHeight : this.eyeHeight
  }

  teleport(feet: Vec3): void {
    this.vx = 0
    this.vy = 0
    this.vz = 0
    this.body.setTranslation(
      {
        x: feet.x,
        y: feet.y + this.halfHeight + this.radius,
        z: feet.z,
      },
      true,
    )
  }

  /** 用来让尸体不再阻挡子弹/射线。 */
  setColliderEnabled(enabled: boolean): void {
    this.collider.setEnabled(enabled)
  }

  /**
   * 推进一帧：算出能走的位移并提交给刚体，**但不 step 世界**。
   *
   * `world.step()` 由外层在每个 tick 末尾统一调用一次。如果每个角色各 step
   * 一次，物理时间就会被乘上玩家数量 —— 两个人的世界里重力变成三倍，
   * 而且这种 bug 只在多人同时在线时才显现。
   *
   * 提交用的是 `setNextKinematicTranslation`，要等下一次 `world.step()`
   * 才真正生效。所以调用顺序必须是：所有角色 step → 一次 world.step() →
   * 读取所有人的新位置。
   */
  step(world: World, input: PlayerInput, dt: number): void {
    const wantsCrouch = (input.buttons & Buttons.Crouch) !== 0
    const ads = (input.buttons & Buttons.Ads) !== 0
    this.applyCrouch(world, wantsCrouch)

    if (this.grounded && this.vy < 0) this.vy = GROUND_STICK_VY

    const state: MoveState = {
      vx: this.vx,
      vy: this.vy,
      vz: this.vz,
      grounded: this.grounded,
    }
    const move = computeMoveVelocity(input, state, dt, ads)
    this.vx = move.vx
    this.vz = move.vz

    // 垂直速度单独推：跳跃是瞬时赋值，之后交给重力。
    if (this.grounded && (input.buttons & Buttons.Jump) !== 0) {
      this.vy = JUMP_SPEED
    } else {
      this.vy += GRAVITY * dt
      if (this.vy < -60) this.vy = -60
    }

    const desired = {
      x: this.vx * dt,
      y: this.vy * dt,
      z: this.vz * dt,
    }

    this.controller.computeColliderMovement(this.collider, desired)
    const moved = this.controller.computedMovement()
    this.grounded = this.controller.computedGrounded()

    const t = this.body.translation()
    this.body.setNextKinematicTranslation({
      x: t.x + moved.x,
      y: t.y + moved.y,
      z: t.z + moved.z,
    })

    // 速度要跟实际位移对齐：撞墙后那个朝墙的速度分量必须归零，
    // 否则下一帧会继续往外顶、再被挡住，表现为贴着墙持续抖动。
    this.vx = dt > 0 ? moved.x / dt : 0
    this.vz = dt > 0 ? moved.z / dt : 0
    if (this.grounded && this.vy < 0) this.vy = GROUND_STICK_VY
  }

  private applyCrouch(world: World, wantsCrouch: boolean): void {
    if (wantsCrouch === this.crouching) return

    if (wantsCrouch) {
      // 蹲下：胶囊变短，中心要同步下移，否则脚会离地。
      this.setCapsuleHalfHeight(this.crouchHalfHeight)
      this.crouching = true
      return
    }

    // 站起来之前先检查头顶有没有东西，避免卡进天花板。
    if (this.canStandUp(world)) {
      this.setCapsuleHalfHeight(this.standHalfHeight)
      this.crouching = false
    }
  }

  private canStandUp(world: World): boolean {
    const extra = this.standHalfHeight - this.crouchHalfHeight
    const t = this.body.translation()
    // 用一颗略小的圆柱近似站立后的胶囊上部空间；只要不与任何东西重叠即可。
    const probe = new Capsule(extra, this.radius * 0.9)
    const hit = world.intersectionWithShape(
      { x: t.x, y: t.y + this.crouchHalfHeight + this.radius + extra, z: t.z },
      { x: 0, y: 0, z: 0, w: 1 },
      probe,
      undefined,
      undefined,
      this.collider,
    )
    return hit === null
  }

  private setCapsuleHalfHeight(halfHeight: number): void {
    const delta = this.halfHeight - halfHeight
    this.halfHeight = halfHeight
    this.collider.setHalfHeight(halfHeight)
    const t = this.body.translation()
    // 保持脚底不动：胶囊变短时中心下移同样的量。
    this.body.setTranslation({ x: t.x, y: t.y - delta, z: t.z }, true)
  }
}

/** 由角色状态生成快照里的状态位。 */
export function stateFlagsOf(c: {
  grounded: boolean
  crouching: boolean
  ads: boolean
  alive: boolean
  reloading: boolean
  /** 切枪动作未完成。可选：不关心切枪的调用方（HUD、回放）不必传。 */
  switching?: boolean
}): number {
  let f = 0
  if (c.grounded) f |= StateFlags.Grounded
  if (c.crouching) f |= StateFlags.Crouching
  if (c.ads) f |= StateFlags.Ads
  if (c.alive) f |= StateFlags.Alive
  if (c.reloading) f |= StateFlags.Reloading
  if (c.switching) f |= StateFlags.Switching
  return f
}

export const INITIAL_HEALTH = MAX_HEALTH
