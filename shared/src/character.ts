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
import { Capsule, ColliderDesc, Ray, RigidBodyDesc } from '@dimforge/rapier3d-compat'

import {
  Buttons,
  CHARACTER_OFFSET,
  COYOTE_TIME,
  GRAVITY,
  JUMP_BUFFER,
  JUMP_COOLDOWN,
  JUMP_SPEED,
  MAX_HEALTH,
  PLAYER_CROUCH_HALF_HEIGHT,
  PLAYER_CROUCH_EYE_HEIGHT,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_HEIGHT,
  PLAYER_RADIUS,
  SLIDE_BOOST_TIME,
  SLIDE_BRAKE,
  SLIDE_CANCEL_BOOST,
  SLIDE_COOLDOWN,
  SLIDE_DRAG,
  SLIDE_DRAG_LOW,
  SLIDE_DURATION,
  SLIDE_ENTRY_SPEED,
  SLIDE_EXIT_SPEED,
  SLIDE_MIN_ENTRY,
  SLIDE_MIN_SPEED_TO_START,
  SLIDE_STEER,
  SPEED_SPRINT,
  SPRINT_FORWARD_DOT,
  SPRINT_START_DELAY,
  StateFlags,
  TERMINAL_SPEED,
  VAULT_MAX_HEIGHT,
  VAULT_MIN_HEIGHT,
  VAULT_REACH,
  VAULT_SPEED,
  VAULT_TIME,
} from './constants.ts'
import { yawToForward, yawToRight, type Vec3 } from './math.ts'
import type { PlayerInput } from './protocol.ts'
import { computeMoveVelocity, type MoveState } from './sim.ts'

/** 站在地上时向下施加的贴地速度，避免角色控制器每帧"落地→离地→落地"抖动。 */
const GROUND_STICK_VY = 0

/**
 * 站在地上时不要每帧把重力积进 vy。
 *
 * Rapier 的角色控制器允许毫米级的向下穿透；如果 grounded 时仍然
 * `vy += GRAVITY*dt`，角色每帧会往下走 g*dt²（约 5mm），几十帧后陷进地面，
 * 控制器不再报告 grounded，角色突然自由落体。lagcomp 回归里表现为
 * "瞄历史位姿 4/4 → 1/4"，因为 A 掉到地面以下后射线被地面挡住。
 *
 * 站在地上就清零垂直速度，走下台阶/斜坡交给 enableSnapToGround。
 */

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
  /** 冲刺状态（含 0.05s 起步延迟）。速度选择在 sim.ts 里读它。 */
  sprinting = false
  private sprintHold = 0
  /** 滑铲状态：冲刺中按下蹲触发，胶囊立刻变蹲姿。 */
  sliding = false
  private slideTime = 0
  private slideCooldown = 0
  private slideDirX = 0
  private slideDirZ = 0
  private prevCrouchHeld = false
  /** 翻越状态：一段短促的脚本位移，期间不接受普通移动输入。 */
  vaulting = false
  private vaultTime = 0
  private vaultDirX = 0
  private vaultDirZ = 0
  private vaultFromY = 0
  private vaultToY = 0
  private vaultProgressY = 0
  /** 空中攀沿的冷却：避免贴着一面墙每帧重试。 */
  private mantleCooldown = 0
  /**
   * 硬着陆缓冲：从高处砸下来后的 0.16s 内不能起跑。
   *
   * 不是"惩罚玩家"，而是让落地有重量：没有这一步，从屋顶跳下来和从台阶
   * 走下来在体感上完全一样，Apex 那种"落地要有个缓冲再起跑"的节奏就没了。
   */
  private landingLag = 0
  /** 本次离地期间的最大下落速度（米/秒，正数）。 */
  private fallSpeed = 0
  /** 跳跃容错窗口：预输入、coyote、冷却。三者都是"隐藏输入误差"的。 */
  private jumpBuffer = 0
  private jumpCooldown = 0
  private coyote = 0
  private prevJumpHeld = false
  /**
   * 一次按键只跳一次。即使输入层/重放因为丢包把 Jump 位重复送来，
   * 也必须先松开再按才能再跳 —— 这是"按住空格一直卡跳"的保险丝。
   */
  private jumpLatch = false

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

  /**
   * 传送到某个位置。
   *
   * `keepInputState` 给**预测回滚**用：回滚会把角色拨回服务端确认的位置，
   * 再重放尚未确认的输入。如果这里把跳跃的边沿状态（prevJumpHeld / jumpLatch）
   * 清零，重放的第一帧就会把"正按住的空格"当成一次新的按下 —— 长按空格时
   * 每次网络修正都多跳一次，表现就是人物/镜头持续抖动。
   *
   * 复活/出生仍然用默认值，它们本来就该把输入状态全部重置。
   */
  teleport(feet: Vec3, keepInputState = false): void {
    this.vx = 0
    this.vy = 0
    this.vz = 0
    this.sprinting = false
    this.sprintHold = 0
    this.sliding = false
    this.slideTime = 0
    this.slideCooldown = 0
    this.vaulting = false
    this.vaultTime = 0
    this.mantleCooldown = 0
    this.landingLag = 0
    this.fallSpeed = 0
    if (!keepInputState) {
      this.prevCrouchHeld = false
      this.jumpBuffer = 0
      this.jumpCooldown = 0
      this.coyote = 0
      this.prevJumpHeld = false
      this.jumpLatch = false
    }
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
    const wasGrounded = this.grounded
    this.landingLag = Math.max(0, this.landingLag - dt)
    const wantsCrouch = (input.buttons & Buttons.Crouch) !== 0
    const ads = (input.buttons & Buttons.Ads) !== 0
    const crouchPressed = wantsCrouch && !this.prevCrouchHeld
    this.prevCrouchHeld = wantsCrouch
    this.slideCooldown = Math.max(0, this.slideCooldown - dt)

    // 翻越是一段脚本位移：期间不接受普通移动/跳跃输入，结束后自动落地。
    if (this.vaulting) {
      this.stepVault(dt)
      return
    }

    if (this.grounded && this.vy < 0) this.vy = GROUND_STICK_VY

    // ---- 跳跃窗口：只要一次按下，按住不会连跳 ----
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt)
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt)
    if (this.grounded) this.coyote = COYOTE_TIME
    else this.coyote = Math.max(0, this.coyote - dt)

    const jumpHeld = (input.buttons & Buttons.Jump) !== 0
    if (!jumpHeld) this.jumpLatch = false
    if (jumpHeld && !this.prevJumpHeld && !this.jumpLatch) this.jumpBuffer = JUMP_BUFFER
    this.prevJumpHeld = jumpHeld

    // ---- 滑铲：冲刺中按下蹲触发；胶囊立刻降到蹲姿 ----
    const speedNow = Math.hypot(this.vx, this.vz)
    if (
      !this.sliding &&
      crouchPressed &&
      this.sprinting &&
      this.grounded &&
      speedNow >= SLIDE_MIN_SPEED_TO_START &&
      this.slideCooldown <= 0
    ) {
      this.beginSlide(input, speedNow)
    }
    if (this.sliding) {
      // 松开蹲、超时、或速度掉到退出阈值以下，都结束滑铲。
      // 只有"主动早松蹲"算取消，给一小口速度奖励；超时/掉速是自然结束。
      const cancelled =
        !wantsCrouch && this.slideTime < SLIDE_DURATION && speedNow > SLIDE_EXIT_SPEED
      if (!wantsCrouch || this.slideTime > SLIDE_DURATION || speedNow < SLIDE_EXIT_SPEED) {
        this.endSlide(cancelled)
      }
    }

    // 冲刺是状态而不是一次性判定：必须有 0.05s 按住延迟与"前向意图"。
    // 这样倒退/横移不会意外冲刺，抬枪或蹲下会立刻退出。
    const rawInput = Math.hypot(input.forward, input.right)
    const forwardIntent = rawInput > 1e-4 ? input.forward / rawInput : 0
    const wantSprint =
      !this.sliding &&
      (input.buttons & Buttons.Sprint) !== 0 &&
      rawInput > 0.45 &&
      forwardIntent > SPRINT_FORWARD_DOT &&
      !wantsCrouch &&
      !ads &&
      this.landingLag <= 0 &&
      (this.grounded || this.sprinting)
    if (wantSprint) {
      this.sprintHold += dt
      if (this.sprintHold >= SPRINT_START_DELAY) this.sprinting = true
    } else {
      this.sprintHold = 0
      this.sprinting = false
    }

    if (this.sliding) {
      this.stepSlide(input, dt)
    } else {
      const state: MoveState = {
        vx: this.vx,
        vy: this.vy,
        vz: this.vz,
        grounded: this.grounded,
        sprinting: this.sprinting,
      }
      const move = computeMoveVelocity(input, state, dt, ads)
      this.vx = move.vx
      this.vz = move.vz
    }

    // 滑铲期间强制蹲姿胶囊；其余时间按蹲键正常升降。
    if (this.sliding) {
      if (!this.crouching) {
        this.setCapsuleHalfHeight(this.crouchHalfHeight)
        this.crouching = true
      }
    } else {
      this.applyCrouch(world, wantsCrouch)
    }

    // ---- 空中攀沿：贴着一个 0.5~1.3m 的台面下落时自动抓上去 ----
    // 这是 Apex 里"跳一下扒住矮墙"的动作；不触发跳跃，所以玩家不需要
    // 在落地前一帧再按一次空格。0.6s 冷却防止贴着墙每帧重试。
    this.mantleCooldown = Math.max(0, this.mantleCooldown - dt)
    if (
      !this.vaulting &&
      !this.grounded &&
      this.mantleCooldown <= 0 &&
      this.vy < 1.5 &&
      input.forward > 0.5
    ) {
      if (this.tryVault(world, input)) this.mantleCooldown = 0.6
    }

    // ---- 起跳：蹲着/滑铲先站起，头顶被挡就不跳 ----
    let jumpedThisTick = false
    if (!this.vaulting && !this.jumpLatch && this.jumpBuffer > 0 && this.jumpCooldown <= 0 && (this.grounded || this.coyote > 0)) {
      let canJump = true
      if (this.crouching) {
        if (this.canStandUp(world)) {
          this.setCapsuleHalfHeight(this.standHalfHeight)
          this.crouching = false
        } else {
          canJump = false
        }
      }
      // 跳向 0.5~1.3m 的台面时优先翻越：不再"撞墙再原地起跳"，而是撑上去。
      if (canJump && !this.sliding && !wantsCrouch && this.tryVault(world, input)) {
        this.jumpBuffer = 0
        this.jumpCooldown = JUMP_COOLDOWN
        this.coyote = 0
        this.jumpLatch = true
        jumpedThisTick = true
        canJump = false
      }
      if (canJump) {
        if (this.sliding) {
          // 滑铲跳：保留入场爆发。空中只能补充、不能放大动量（见 sim.ts），
          // 所以这里给到 SLIDE_ENTRY_SPEED 不会变成速度叠加漏洞。
          const sp = Math.hypot(this.vx, this.vz)
          const cap = SLIDE_ENTRY_SPEED
          if (sp > cap) {
            this.vx *= cap / sp
            this.vz *= cap / sp
          }
          this.sliding = false
          this.slideCooldown = SLIDE_COOLDOWN
          this.slideTime = 0
        }
        this.vy = JUMP_SPEED
        this.jumpBuffer = 0
        this.jumpCooldown = JUMP_COOLDOWN
        this.coyote = 0
        this.grounded = false
        this.jumpLatch = true
        jumpedThisTick = true
      }
    }

    if (!jumpedThisTick) {
      if (this.grounded && this.vy <= 0) {
        // 站定/滑铲：不再累积重力，避免毫米级穿透逐帧累积（见 GROUND_STICK_VY）。
        this.vy = 0
      } else {
        // 垂直速度单独推：跳跃是瞬时赋值，之后交给重力。
        this.vy += GRAVITY * dt
        if (this.vy < -TERMINAL_SPEED) this.vy = -TERMINAL_SPEED
      }
    }

    const desired = {
      x: this.vx * dt,
      y: this.vy * dt,
      z: this.vz * dt,
    }

    this.controller.computeColliderMovement(this.collider, desired)
    const moved = this.controller.computedMovement()
    this.grounded = this.controller.computedGrounded()

    // 硬着陆：记下离地期间的最大下落速度，落地那一下决定要不要缓冲。
    if (!wasGrounded && this.grounded) {
      if (this.fallSpeed > 8) this.landingLag = 0.16
      this.fallSpeed = 0
    } else if (!this.grounded) {
      this.fallSpeed = Math.max(this.fallSpeed, -this.vy)
    }

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

  /** 进入滑铲：方向取当前速度（速度太低时取输入方向），速度给一次爆发。 */
  private beginSlide(input: PlayerInput, currentSpeed: number): void {
    let dx = this.vx
    let dz = this.vz
    let length = Math.hypot(dx, dz)
    if (length < 0.4) {
      const fwd = yawToForward(input.yaw)
      const right = yawToRight(input.yaw)
      dx = fwd.x * input.forward + right.x * input.right
      dz = fwd.z * input.forward + right.z * input.right
      length = Math.hypot(dx, dz)
    }
    if (length < 1e-4) return

    dx /= length
    dz /= length
    const target = Math.max(SLIDE_MIN_ENTRY, Math.min(SLIDE_ENTRY_SPEED, currentSpeed * 1.3))
    this.vx = dx * target
    this.vz = dz * target
    this.sliding = true
    this.slideTime = 0
    this.slideDirX = dx
    this.slideDirZ = dz
    this.sprinting = false
    this.sprintHold = 0
    if (!this.crouching) {
      this.setCapsuleHalfHeight(this.crouchHalfHeight)
      this.crouching = true
    }
  }

  /**
   * 滑铲积分：只保留横向转向权限，速度指数衰减 + 线性制动。
   * 转向按"输入在滑行方向右侧的分量"施加，所以能拐弯但不能原地掉头。
   */
  private stepSlide(input: PlayerInput, dt: number): void {
    this.slideTime += dt
    let speed = Math.hypot(this.vx, this.vz)
    if (speed < 1e-5) return

    let dx = this.vx / speed
    let dz = this.vz / speed
    const fwd = yawToForward(input.yaw)
    const right = yawToRight(input.yaw)
    let wx = fwd.x * input.forward + right.x * input.right
    let wz = fwd.z * input.forward + right.z * input.right
    const wishLen = Math.hypot(wx, wz)
    if (wishLen > 0.05) {
      wx /= wishLen
      wz /= wishLen
      const lateral = wx * -dz + wz * dx
      const steer = lateral * SLIDE_STEER * dt
      const nx = dx - dz * steer
      const nz = dz + dx * steer
      const len = Math.hypot(nx, nz) || 1
      dx = nx / len
      dz = nz / len
    }

    // 两段阻力：前 0.22s 保住入场爆发，之后才开始刹车。
    const boosting = this.slideTime < SLIDE_BOOST_TIME
    speed = speed * Math.exp(-(boosting ? SLIDE_DRAG_LOW : SLIDE_DRAG) * dt)
    if (!boosting) speed -= SLIDE_BRAKE * dt
    if (speed < 0) speed = 0
    this.vx = dx * speed
    this.vz = dz * speed
    this.slideDirX = dx
    this.slideDirZ = dz

    if (speed < SLIDE_EXIT_SPEED || this.slideTime > SLIDE_DURATION) this.endSlide()
  }

  /**
   * 结束滑铲。
   *
   * `cancelled` = 玩家主动松开蹲键（而不是超时/掉速自然结束）。取消时补
   * 一口速度：早松蹲的回报是"站起来还能跑"，而不是白白浪费一次滑铲。
   * 上限仍是入场速度，不能靠反复滑铲叠加速度。
   */
  private endSlide(cancelled = false): void {
    if (cancelled) {
      const speed = Math.hypot(this.vx, this.vz)
      if (speed > 1e-4) {
        const target = Math.min(SLIDE_ENTRY_SPEED, speed + SLIDE_CANCEL_BOOST)
        const k = target / speed
        this.vx *= k
        this.vz *= k
      }
    }
    this.sliding = false
    this.slideTime = 0
    this.slideCooldown = SLIDE_COOLDOWN
  }

  /**
   * 跳向 0.5~1.3m 的台面时，把它变成一次翻越。
   *
   * 判定用两条射线：胸口朝前一条找障碍，障碍上方朝下一条找台面高度。
   * 台面之上再打一条向上的射线确认胶囊放得下 —— 只高 0.2m 的檐口不是
   * "能翻过去的台子"，钻进去只会卡在半空。
   */
  private tryVault(world: World, input: PlayerInput): boolean {
    if (input.forward < 0.35) return false
    const feet = this.feet
    const fwd = yawToForward(input.yaw)
    const origin = { x: feet.x, y: feet.y + 0.55, z: feet.z }
    const dir = { x: fwd.x, y: 0, z: fwd.z }
    const hit = world.castRay(
      new Ray(origin, dir),
      VAULT_REACH + this.radius,
      true,
      undefined,
      undefined,
      this.collider,
    )
    if (!hit) return false

    const hx = feet.x + fwd.x * hit.timeOfImpact + fwd.x * 0.28
    const hz = feet.z + fwd.z * hit.timeOfImpact + fwd.z * 0.28
    const probeTop = feet.y + VAULT_MAX_HEIGHT + 1.3
    const down = world.castRay(
      new Ray({ x: hx, y: probeTop, z: hz }, { x: 0, y: -1, z: 0 }),
      VAULT_MAX_HEIGHT + 1.5,
      true,
      undefined,
      undefined,
      this.collider,
    )
    if (!down) return false
    const topY = probeTop - down.timeOfImpact
    const height = topY - feet.y
    if (height < VAULT_MIN_HEIGHT || height > VAULT_MAX_HEIGHT) return false

    // 台面之上必须有容纳胶囊的空间（顶部横梁、屋檐会在这里被挡下）。
    const up = world.castRay(
      new Ray({ x: hx, y: topY + 0.06, z: hz }, { x: 0, y: 1, z: 0 }),
      this.standHalfHeight * 2 + this.radius * 2 + 0.35,
      true,
      undefined,
      undefined,
      this.collider,
    )
    if (up) return false

    this.vaulting = true
    this.vaultTime = 0
    this.vaultDirX = fwd.x
    this.vaultDirZ = fwd.z
    this.vaultFromY = feet.y
    this.vaultToY = topY + 0.02
    this.vaultProgressY = 0
    this.sliding = false
    this.slideTime = 0
    this.vy = 0
    this.vx = fwd.x * VAULT_SPEED
    this.vz = fwd.z * VAULT_SPEED
    if (this.crouching) {
      this.setCapsuleHalfHeight(this.standHalfHeight)
      this.crouching = false
    }
    return true
  }

  /**
   * 翻越积分：先抬后推。
   *
   * 竖直方向用 1.35 倍的缓动提前到位，再让水平速度把身体带过去 —— 如果
   * 两者同步，胶囊会在台面边缘被挡住，表现为"贴着台子原地耸动"。
   */
  private stepVault(dt: number): void {
    this.vaultTime += dt
    const t = Math.min(1, this.vaultTime / VAULT_TIME)
    const ease = Math.min(1, t * t * (3 - 2 * t) * 1.35)
    const targetY = this.vaultFromY + (this.vaultToY - this.vaultFromY) * ease
    const feet = this.feet
    const stepY = targetY - feet.y

    this.controller.computeColliderMovement(this.collider, {
      x: this.vaultDirX * VAULT_SPEED * dt,
      y: stepY,
      z: this.vaultDirZ * VAULT_SPEED * dt,
    })
    const moved = this.controller.computedMovement()
    this.grounded = this.controller.computedGrounded()
    const tr = this.body.translation()
    this.body.setNextKinematicTranslation({
      x: tr.x + moved.x,
      y: tr.y + moved.y,
      z: tr.z + moved.z,
    })
    this.vx = dt > 0 ? moved.x / dt : 0
    this.vz = dt > 0 ? moved.z / dt : 0
    this.vy = 0

    if (t >= 1) {
      this.vaulting = false
      this.vaultTime = 0
      this.vy = 0
    }
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
  /** 滑铲中。可选：旧调用方不传时保持原行为。 */
  sliding?: boolean
  /** 翻越中。可选：旧调用方不传时保持原行为。 */
  vaulting?: boolean
}): number {
  let f = 0
  if (c.grounded) f |= StateFlags.Grounded
  if (c.crouching) f |= StateFlags.Crouching
  if (c.ads) f |= StateFlags.Ads
  if (c.alive) f |= StateFlags.Alive
  if (c.reloading) f |= StateFlags.Reloading
  if (c.switching) f |= StateFlags.Switching
  if (c.sliding) f |= StateFlags.Sliding
  if (c.vaulting) f |= StateFlags.Vaulting
  return f
}

export const INITIAL_HEALTH = MAX_HEALTH
