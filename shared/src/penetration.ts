/**
 * 子弹穿透：哪些掩体能穿、能穿多厚、穿过去还剩多少伤害。
 *
 * 之前 `tryFire` 的射线在第一个静态碰撞体上就停住 —— 木箱、木板墙和石头
 * 一样是"绝对墙"。猎杀类射击的乐趣之一就是"我知道这块木板能打穿"，所以
 * 这里把"遮挡"拆成两层：
 *
 * 1. 先由引擎给出第一层碰撞体；
 * 2. 如果它属于木/土/铁皮/植被且厚度在预算内，就把起点推到背面继续判，
 *    伤害按每层衰减；石头/混凝土仍然一枪挡住。
 *
 * 本模块只做纯几何/规则，不依赖 Rapier，因此可以在 Node 里直接测。
 */
import type { BoxBrush, LevelDef, SurfaceMaterial } from './level.ts'
import type { Vec3 } from './math.ts'

export interface PenetrationRule {
  /** 单层最大穿透厚度（米）。0 = 不可穿。 */
  maxThickness: number
  /** 穿过这一层后的伤害倍率（累乘）。 */
  damageScale: number
}

const RULES: Record<string, PenetrationRule> = {
  // 木板/木箱：可以穿，但伤害明显下降。
  wood: { maxThickness: 0.5, damageScale: 0.62 },
  // 厚土墙/沙袋：比木头更吃动能。
  mud: { maxThickness: 0.35, damageScale: 0.48 },
  // 铁皮/薄金属：能穿，但只剩一小部分动能。
  metal: { maxThickness: 0.06, damageScale: 0.3 },
  // 植被：几乎不减速。
  foliage: { maxThickness: 0.75, damageScale: 0.82 },
  // 石头/混凝土：不穿。留 0 而不是 0.05，让掩体有明确的"硬/软"之分。
  stone: { maxThickness: 0, damageScale: 0 },
}

/** 未知/地面/边界：一律当硬掩体。 */
const BLOCKED: PenetrationRule = { maxThickness: 0, damageScale: 0 }

export function penetrationRule(material: string | undefined): PenetrationRule {
  if (material === undefined) return BLOCKED
  return RULES[material] ?? BLOCKED
}

/**
 * 不同枪的穿透能力。
 *
 * 数值不是物理单位，只是"同一块木头，谁能穿得更厚"的相对量：
 * 神射手 > 步枪 > 转轮 > 霰弹。霰弹单颗弹丸的动能本来就低。
 */
export function penetrationPower(kind: string): number {
  switch (kind) {
    case 'sniper':
      return 1.25
    case 'rifle':
      return 1
    case 'revolver':
      return 0.8
    case 'shotgun':
      return 0.65
    default:
      return 0
  }
}

/**
 * 命中点贴着的关卡盒刷。
 *
 * 射线命中点正好落在盒刷表面；这里用"点到盒子的最近距离"找它，容差必须
 * 很小（默认 9cm），否则地面命中的点可能误认成旁边贴地的木箱。
 */
export function brushAt(level: LevelDef, point: Vec3, tolerance = 0.09): BoxBrush | null {
  let best: BoxBrush | null = null
  let bestDistance = tolerance
  for (const brush of level.boxes) {
    if (brush.noCollide) continue
    const dx = point.x - brush.x
    const dz = point.z - brush.z
    let lx = dx
    let lz = dz
    if (brush.rotY) {
      const c = Math.cos(-brush.rotY)
      const s = Math.sin(-brush.rotY)
      lx = dx * c - dz * s
      lz = dx * s + dz * c
    }
    const ox = Math.max(Math.abs(lx) - brush.hx, 0)
    const oy = Math.max(Math.abs(point.y - brush.y) - brush.hy, 0)
    const oz = Math.max(Math.abs(lz) - brush.hz, 0)
    const distance = Math.hypot(ox, oy, oz)
    if (distance < bestDistance) {
      bestDistance = distance
      best = brush
    }
  }
  return best
}

/**
 * 射线穿过一个盒刷的 [进入, 离开] 距离（相对 origin，单位米）。
 *
 * 用 slab 法在盒子的局部空间求交；rotY 只绕 Y 轴，所以只旋转 xz。
 * origin/dir 必须是世界空间、dir 归一化。
 */
export function boxSpan(
  brush: BoxBrush,
  origin: Vec3,
  dir: Vec3,
): { enter: number; exit: number } | null {
  let ox = origin.x - brush.x
  let oy = origin.y - brush.y
  let oz = origin.z - brush.z
  let dx = dir.x
  let dy = dir.y
  let dz = dir.z
  if (brush.rotY) {
    const c = Math.cos(-brush.rotY)
    const s = Math.sin(-brush.rotY)
    const rx = ox * c - oz * s
    const rz = ox * s + oz * c
    ox = rx
    oz = rz
    const rdx = dx * c - dz * s
    const rdz = dx * s + dz * c
    dx = rdx
    dz = rdz
  }

  let enter = -Infinity
  let exit = Infinity
  const axes: Array<[number, number, number]> = [
    [ox, dx, brush.hx],
    [oy, dy, brush.hy],
    [oz, dz, brush.hz],
  ]
  for (const [o, d, half] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < -half || o > half) return null
      continue
    }
    let t1 = (-half - o) / d
    let t2 = (half - o) / d
    if (t1 > t2) {
      const temp = t1
      t1 = t2
      t2 = temp
    }
    if (t1 > enter) enter = t1
    if (t2 < exit) exit = t2
    if (enter > exit) return null
  }
  if (exit < 0) return null
  return { enter: Math.max(enter, 0), exit }
}

/** 规则 × 枪械能力，返回这一层实际能穿的最大厚度与伤害倍率。 */
export function penetrationFor(
  material: SurfaceMaterial | string | undefined,
  kind: string,
): { maxThickness: number; damageScale: number } {
  const rule = penetrationRule(material)
  const power = penetrationPower(kind)
  if (rule.maxThickness <= 0 || power <= 0) return { maxThickness: 0, damageScale: 0 }
  return {
    maxThickness: rule.maxThickness * power,
    // 穿透能力越强，损失越少；霰弹穿木板后只剩约四成。
    damageScale: Math.max(0.12, Math.min(1, rule.damageScale * (0.7 + 0.3 * power))),
  }
}
