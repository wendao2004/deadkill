/**
 * 命中判定：**服务端是唯一裁判**，客户端只用来做即时反馈（血迹、命中音）。
 *
 * P0 用 hitscan（瞬时射线）而不是弹道模拟。理由：
 *  - 弹道需要服务端对每颗子弹单独 tick 推进，一期做不对反而更难调；
 *  - 温菲尔德 M1873 的初速是 350m/s 级别，60m 内飞行时间 ~0.17s，
 *    在 P0 的近距离交战里 hitscan 的偏差小于玩家的感知；
 *  - 先把"射线打在哪、算不算头、伤害多少"跑通，P2 再加弹速和下坠时
 *    只需要把这里换成"沿射线分步 shape cast"，周边代码不动。
 *
 * 延迟补偿（lag compensation）：服务端用玩家开火时刻的**历史位姿**重新判定，
 * 而不是用当下位姿。不做这一步，玩家在 300ms 延迟下打移动目标必然空枪 ——
 * 因为他屏幕上看到的敌人位置是 300ms 前的。P0 先把 `MAX_REWIND_MS`
 * 常量留住，历史环形缓冲在 World 里实现。
 */

import type {
  Collider,
  RayColliderHit,
  World,
} from '@dimforge/rapier3d-compat'
import { ColliderDesc, Ray } from '@dimforge/rapier3d-compat'

import { HEAD_MIN_HEIGHT, WEAPONS, type WeaponSpec } from './constants.ts'
import {
  clamp,
  lookDirection,
  type Vec3,
  vecAdd,
  vecDot,
  vecLength,
  vecNormalize,
  vecScale,
  vecSub,
} from './math.ts'

/** 一次射击的判定结果。 */
export interface ShotResult {
  /** 射线是否打到任何东西（墙也算）。 */
  hit: boolean
  /** 打到的碰撞体；`null` 表示打空。 */
  collider: Collider | null
  /** 命中点。打空时是射线的末端。 */
  point: Vec3
  /** 命中距离。 */
  distance: number
  /** 是否爆头（只有打到玩家才有意义）。 */
  headshot: boolean
  /** 是否打到了玩家。 */
  hitPlayer: boolean
}

export interface TraceOptions {
  /** 射线起点（眼睛）。 */
  origin: Vec3
  /** 方向（会被归一化）。 */
  dir: Vec3
  /** 最大射程。 */
  maxDistance: number
  /** 排除的碰撞体（通常是射手自己）。 */
  exclude?: Collider
  /** 判断某个碰撞体是不是玩家，用来决定是否算爆头。 */
  classify: (collider: Collider) => PlayerHitTarget | null
  /**
   * 额外过滤：返回 false 的碰撞体不参与判定。
   *
   * 现在只有一处用它：玩家的延迟补偿改走解析求交（见 `rayCapsule`），
   * 所以射线要先只判静态几何与怪，拿到真正的遮挡距离。
   */
  filter?: (collider: Collider) => boolean
}

export interface PlayerHitTarget {
  playerId: number
  /** 该玩家脚底高度 —— 用来判断命中点是否在头部带。 */
  feetY: number
  /**
   * 头部判定带的下沿（相对世界坐标）。缺省用 HEAD_MIN_HEIGHT。
   *
   * 蹲姿胶囊顶只有 feet+1.4，而站立头部带是 1.45；不给蹲姿单独一个值，
   * 蹲下就等于免疫爆头。由调用方按目标当前姿态传入。
   */
  headMinHeight?: number
}

/**
 * 用圆柱近似玩家躯干，让射线/命中判定不依赖引擎的 mesh 精度。
 *
 * 实际上我们直接 castRay 打玩家自己的胶囊碰撞体即可 —— 玩家在物理世界里
 * 本来就有 capsule collider。这里保留 `classify` 回调是为了让"射线打到了
 * 什么"和"那算什么"分开：物理层只管几何，游戏层管语义。
 */
export function traceShot(world: World, options: TraceOptions): ShotResult {
  const dir = lookDirectionFrom(options.dir)
  const ray = new Ray(
    { x: options.origin.x, y: options.origin.y, z: options.origin.z },
    { x: dir.x, y: dir.y, z: dir.z },
  )
  const hit: RayColliderHit | null = world.castRay(
    ray,
    options.maxDistance,
    true,
    undefined,
    undefined,
    options.exclude,
    undefined,
    options.filter,
  )
  if (!hit) {
    return {
      hit: false,
      collider: null,
      point: vecAdd(options.origin, vecScale(dir, options.maxDistance)),
      distance: options.maxDistance,
      headshot: false,
      hitPlayer: false,
    }
  }

  const distance = hit.timeOfImpact
  const point = vecAdd(options.origin, vecScale(dir, distance))
  const target = options.classify(hit.collider)
  const headshot = target
    ? point.y - target.feetY >= (target.headMinHeight ?? HEAD_MIN_HEIGHT)
    : false
  return {
    hit: true,
    collider: hit.collider,
    point,
    distance,
    headshot,
    hitPlayer: target !== null,
  }
}

/**
 * 解析射线-胶囊求交，返回最近的正向命中距离；打空返回 null。
 *
 * 为什么要自己算而不是让 Rapier 去 castRay：Rapier 0.21 的查询先过 broad-phase
 * 的 AABB 剪枝，而那些 AABB 只在 `step()` 里刷新。把角色刚体挪到历史位置
 * （延迟补偿）之后，碰撞体的变换是新的、剪枝用的是旧的 —— 射线在旧 AABB 处就
 * 被剪掉了，回滚后的位置根本打不到（实测 0/5，连瞄旧位置也打不到）。
 * 所以延迟补偿改成：静态几何仍交给引擎判遮挡，玩家胶囊用这条解析式按历史位姿求交。
 *
 * `dir` 必须是单位向量；`a`/`b` 是胶囊轴线的两个端点（球的圆心），
 * `radius` 是半径。胶囊 = 圆柱侧面 + 两端半球。
 */
export function rayCapsule(
  origin: Vec3,
  dir: Vec3,
  a: Vec3,
  b: Vec3,
  radius: number,
): number | null {
  const ba = vecSub(b, a)
  const oa = vecSub(origin, a)
  const baba = vecDot(ba, ba)
  const bard = vecDot(ba, dir)
  const baoa = vecDot(ba, oa)
  const rdoa = vecDot(dir, oa)
  const oaoa = vecDot(oa, oa)

  let best: number | null = null

  // 圆柱侧面：把射线投到垂直于轴线的平面上解二次方程，再验证落点在轴线区间内。
  if (baba > 1e-9) {
    const k2 = baba - bard * bard
    const k1 = baba * rdoa - baoa * bard
    const k0 = baba * oaoa - baoa * baoa - radius * radius * baba
    if (Math.abs(k2) > 1e-9) {
      const disc = k1 * k1 - k2 * k0
      if (disc > 0) {
        const t = (-k1 - Math.sqrt(disc)) / k2
        const along = baoa + t * bard
        if (t > 0 && along > 0 && along < baba) best = t
      }
    }
  }

  // 两端球冠：胶囊的"圆头"完全落在侧面之外，必须单独判。
  for (const cap of [a, b]) {
    const oc = vecSub(origin, cap)
    const bq = vecDot(oc, dir)
    const cq = vecDot(oc, oc) - radius * radius
    const disc = bq * bq - cq
    if (disc > 0) {
      const t = -bq - Math.sqrt(disc)
      if (t > 0 && (best === null || t < best)) best = t
    }
  }

  return best
}

/** 把任意方向归一到单位长度（castRay 的 maxToi 以 dir 长度为单位尺度）。 */
function lookDirectionFrom(dir: Vec3): Vec3 {
  const len = Math.hypot(dir.x, dir.y, dir.z)
  if (len < 1e-6) return { x: 0, y: 0, z: -1 }
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len }
}

/**
 * 根据视线角生成射击方向（含散布）。
 *
 * spreadScale 是天赋倍率（铁腕 0.75）：乘在半径上而不是乘角度，因为散布
 * 本来就是"锥体半径"，按角度缩放会让远近两处的偏差比不一致。
 */
export function aimDirection(
  yaw: number,
  pitch: number,
  weapon: WeaponSpec,
  ads: boolean,
  seed: number,
  spreadScale = 1,
): Vec3 {
  const base = lookDirection(yaw, pitch)
  const spread = (ads ? weapon.adsSpread : weapon.spread) * spreadScale
  if (spread <= 0) return base
  // 用确定性伪随机：服务端可复现，将来做录像/回放时同一颗种子重放同一发弹。
  const r = mulberry32(seed)
  const angle = r() * Math.PI * 2
  const radius = Math.sqrt(r()) * spread

  // 在视线的正交基上偏一点。构造基向量：任取一个不与 dir 平行的向量做叉积。
  const up = Math.abs(base.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const right = normalize(cross(base, up))
  const realUp = cross(right, base)
  return normalize({
    x: base.x + (right.x * Math.cos(angle) + realUp.x * Math.sin(angle)) * radius,
    y: base.y + (right.y * Math.cos(angle) + realUp.y * Math.sin(angle)) * radius,
    z: base.z + (right.z * Math.cos(angle) + realUp.z * Math.sin(angle)) * radius,
  })
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function normalize(a: Vec3): Vec3 {
  const len = Math.hypot(a.x, a.y, a.z)
  return len > 1e-6 ? { x: a.x / len, y: a.y / len, z: a.z / len } : { x: 0, y: 0, z: -1 }
}

/** 确定性随机数：同一颗种子永远产出同一串数，服务端与回放据此保持一致。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 按距离衰减后的伤害。超出有效射程后线性衰减到 40%。 */
export function damageAt(weapon: WeaponSpec, distance: number, headshot: boolean): number {
  let dmg = weapon.damage
  if (distance > weapon.effectiveRange) {
    const over = distance - weapon.effectiveRange
    const falloff = Math.max(0, 1 - over / (weapon.effectiveRange * 2))
    dmg *= 0.4 + 0.6 * falloff
  }
  if (headshot) dmg *= weapon.headMultiplier
  return dmg
}

/** 一次射击命中所有弹丸后的总伤害（霰弹枪需要逐颗判定）。 */
export function totalDamage(
  weapon: WeaponSpec,
  hits: { distance: number; headshot: boolean }[],
): number {
  let sum = 0
  for (const h of hits) sum += damageAt(weapon, h.distance, h.headshot)
  return sum
}

/** 近战判定的候选目标：竖直胶囊 + 用来套爆头规则的脚底高度。 */
export interface MeleeCandidate {
  /** 玩家 id 或怪物 id（两者共用事件里的编号空间，不共用取值范围）。 */
  id: number
  /** 胶囊轴线的下端点。 */
  lower: Vec3
  /** 胶囊轴线的上端点。 */
  upper: Vec3
  /** 胶囊半径（米）。 */
  radius: number
  /** 脚底高度：命中点高出它 HEAD_MIN_HEIGHT 就算爆头，与射线是同一套规则。 */
  feetY: number
  /**
   * 头部带下沿（世界坐标）。蹲姿由调用方按胶囊顶传，缺省用 HEAD_MIN_HEIGHT。
   * 不传时保持旧的"矮目标只能打躯干"行为。
   */
  headMinHeight?: number
}

export interface MeleeHit {
  id: number
  /** 眼睛到命中点的距离（米）。 */
  distance: number
  point: Vec3
  headshot: boolean
}

/**
 * 近战挥砍判定：在 `meleeRange` 内、偏离视线不超过 `meleeArc` 的目标里取最近的一个。
 *
 * 为什么不用射线：刀的作用范围是一个锥体，玩家的预期是"准星擦过他肩膀也该
 * 划到"；用细射线会出现对着人砍却完全不掉血的手感事故。锥体判定还顺带解决
 * 了隔墙砍人 —— 墙后目标的皮肤距离必然远大于 2.4m，够不着就是够不着。
 *
 * 命中点取胶囊表面离眼睛最近的那一点，爆头仍按 HEAD_MIN_HEIGHT 判：挥刀时
 * 眼睛(1.62m)视角基本落在对手头肩线，所以近战天生偏向爆头，想砍躯体得压低
 * 视角或砍矮目标。
 */
export function meleeStrike(
  eye: Vec3,
  dir: Vec3,
  spec: WeaponSpec,
  candidates: Iterable<MeleeCandidate>,
): MeleeHit | null {
  const range = spec.meleeRange ?? spec.effectiveRange
  const cosArc = Math.cos(spec.meleeArc ?? 0)
  const aim = vecNormalize(dir)
  let best: MeleeHit | null = null

  for (const c of candidates) {
    // 竖直方向：命中点跟着视线俯仰走，而不是永远取眼睛高度。水平挥刀
    // 落在头肩线（爆头）；压低视角才能砍到躯干。
    const dx = c.lower.x - eye.x
    const dz = c.lower.z - eye.z
    const flat = Math.hypot(dx, dz)
    const skin = Math.max(0, flat - c.radius)
    const slope = Math.hypot(aim.x, aim.z) > 1e-6 ? aim.y / Math.hypot(aim.x, aim.z) : 0
    const pointY = clamp(eye.y + slope * skin, c.lower.y, c.upper.y)
    const point =
      flat > 1e-6
        ? { x: eye.x + (dx / flat) * skin, y: pointY, z: eye.z + (dz / flat) * skin }
        : { x: c.lower.x, y: pointY, z: c.lower.z }

    const toTarget = vecSub(point, eye)
    const distance = vecLength(toTarget)
    if (distance <= 1e-6 || distance > range) continue
    if (vecDot(aim, vecScale(toTarget, 1 / distance)) < cosArc) continue
    if (best && distance >= best.distance) continue
    best = {
      id: c.id,
      distance,
      point,
      headshot: point.y - c.feetY >= (c.headMinHeight ?? HEAD_MIN_HEIGHT),
    }
  }
  return best
}

export { WEAPONS }
export type { WeaponSpec }
export { ColliderDesc }
