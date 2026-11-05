/**
 * 命中点 / 落脚点的表面材质。
 *
 * 关卡里只有盒刷（BoxBrush）和一层地面，材质信息在关卡数据里、不在快照里 ——
 * 给每发子弹、每个脚印在协议里多带一个字节，只为了换个碎屑颜色或脚步声，不值得。
 * 所以两端各自就近推断：找**包含或紧贴**该点的盒子取它的材质；水面区域盖在
 * 泥地上要优先算水；什么都不沾就是地面材质。
 *
 * 推断放在独立模块里而不是 game.ts 的内部方法：脚步声和命中特效是两条完全
 * 不同的调用链，却必须对"我现在踩在什么上"给出同一个答案，否则玩家会听到
 * 木头脚步声、看到泥屑飞溅。
 */

import type { LevelDef, Vec3 } from '@dk/shared'

/** 脚步/命中推断出的表面。`water` 只出现在水面区域，不会出现在 BoxBrush 上。 */
export type SurfaceMaterial = 'wood' | 'stone' | 'mud' | 'metal' | 'foliage' | 'water'

interface WaterRegion {
  x: number
  z: number
  hx: number
  hz: number
  /** 和 BoxBrush 同一套约定：绕 Y 轴旋转的弧度。 */
  rotY?: number
}

/** 命中特效只需要五档：树叶算木头，水面算泥。 */
export type ImpactSurface = 'wood' | 'stone' | 'mud' | 'metal' | 'flesh'

/** 探针要读的点，可能来自事件包（只有 x/y/z 字段）。 */
function toVec3(point: Vec3): Vec3 {
  return point
}

/** 关卡可选字段（老关卡没有）：用可选属性读，避免每一处都写断言。 */
interface LevelExtras {
  groundMaterial?: SurfaceMaterial
  water?: WaterRegion[]
}

function extrasOf(level: LevelDef): LevelExtras {
  return level as LevelDef & LevelExtras
}

/** 把世界坐标转到盒子的局部轴（只有带 rotY 的盒子需要）。 */
function localXZ(
  x: number,
  z: number,
  cx: number,
  cz: number,
  rotY: number | undefined,
): { dx: number; dz: number } {
  const dx = x - cx
  const dz = z - cz
  if (!rotY) return { dx, dz }
  const c = Math.cos(-rotY)
  const s = Math.sin(-rotY)
  return { dx: dx * c - dz * s, dz: dx * s + dz * c }
}

/**
 * 点是否落在水面矩形里。
 *
 * y 也一起判断：水面在关卡数据里没有高度字段，约定它贴着地面
 * （地面以上 0.6m 内算踩在水里），否则站在栈桥上也会听到水声。
 */
function inWater(level: LevelDef, point: Vec3): boolean {
  const regions = extrasOf(level).water
  if (!regions || regions.length === 0) return false
  if (point.y > level.groundY + 0.6) return false
  for (const region of regions) {
    const { dx, dz } = localXZ(point.x, point.z, region.x, region.z, region.rotY)
    if (Math.abs(dx) <= region.hx && Math.abs(dz) <= region.hz) return true
  }
  return false
}

/**
 * 点贴着的盒子材质。
 *
 * `tolerance` 是"多近算贴着"：0.45m 用于脚步（脚掌有厚度、站在箱子边缘
 * 也算踩在箱子上），0.4m 用于命中（枪口离木箱 0.4m 之外打中的是空气）。
 */
function boxSurfaceAt(level: LevelDef, point: Vec3, tolerance: number): SurfaceMaterial | null {
  let best: SurfaceMaterial | null = null
  let bestDistance = tolerance
  for (const brush of level.boxes) {
    if (brush.noCollide) continue
    const { dx, dz } = localXZ(point.x, point.z, brush.x, brush.z, brush.rotY)
    const ox = Math.max(Math.abs(dx) - brush.hx, 0)
    const oy = Math.max(Math.abs(point.y - brush.y) - brush.hy, 0)
    const oz = Math.max(Math.abs(dz) - brush.hz, 0)
    const distance = Math.hypot(ox, oy, oz)
    if (distance >= bestDistance) continue
    bestDistance = distance
    best = brush.material ?? 'wood'
  }
  return best
}

/**
 * 这一点踩在 / 打在什么材质上。
 *
 * 顺序：水面 → 贴着某个盒子 → 地面材质。水面必须第一个判，因为沼泽里的
 * 水就画在泥地上，被判成泥地的话玩家永远听不到水声。
 */
export function surfaceAt(level: LevelDef, point: Vec3, tolerance = 0.45): SurfaceMaterial {
  const at = toVec3(point)
  if (inWater(level, at)) return 'water'
  const brush = boxSurfaceAt(level, at, tolerance)
  if (brush) return brush
  const ground = extrasOf(level).groundMaterial ?? 'mud'
  // 高于地面一大截、又不贴任何盒子的点（半空中的子弹落点）按木头算：
  // 泥屑在半空里飞才更怪。
  if (at.y > level.groundY + 0.35) return 'wood'
  return ground
}

/** 命中特效的五档材质（`vfx.ts` 的 ImpactKind 只认这五种）。 */
export function impactSurfaceOf(material: SurfaceMaterial): ImpactSurface {
  // 树叶按木头算：vfx 只有五种墨，多一档苔绿会让碎屑在夜空里发荧光。
  if (material === 'foliage') return 'wood'
  // 水面按泥算：五档里没有水，泥点溅起来比木屑更像水花。
  if (material === 'water') return 'mud'
  return material
}
