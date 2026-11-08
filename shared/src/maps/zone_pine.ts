/**
 * 松林营地：主区几何。
 *
 * 这张图的"好看"不靠盒子，靠两件事：
 * 1. **盒子只做骨架**：木屋、锯木厂、原木堆的外观由程序化 GLB 负责，
 *    碰撞盒用 `noRender` 藏起来（见 shared/src/level.ts 的 BoxBrush.noRender）。
 *    于是玩家看到的是圆木墙和双坡屋顶，撞到的是精确的墙面。
 * 2. **视线必须有节奏**：营地中央是唯一 40m 级的开阔地，其余每个方向的
 *    长视线都被原木堆、货架、树带切成 15~25m 的段落。
 *
 * 坐标约定与其它 zone 一致：局部坐标，最后整体平移到世界坐标。
 */

import { BrushSet, mulberry32, snap } from './kit.ts'
import type { BoxBrush } from '../level.ts'

/**
 * 只碰撞、不渲染的盒子。
 *
 * 单独写一个 helper 而不是给 BrushSet 加方法：noRender 是这张图的资产管线
 * 约定，别的图仍然用"盒子即外观"的老办法，不该让所有人看见这个开关。
 */
function ghost(s: BrushSet, x: number, z: number, hx: number, hz: number, bottom: number, top: number, rotY = 0): void {
  const b: BoxBrush = {
    x,
    y: (bottom + top) / 2,
    z,
    hx,
    hy: (top - bottom) / 2,
    hz,
    material: 'wood',
    noRender: true,
  }
  if (rotY) b.rotY = rotY
  s.list.push(b)
}

/** 可进入的木屋：四面墙 + 正面门洞。外观由 log_cabin_a 负责。 */
function enterableCabin(s: BrushSet, x: number, z: number, rotY: number): void {
  const HX = 3.0
  const HZ = 2.25
  const T = 0.22
  // 墙顶必须在 0.4m 网格上：它虽然不渲染，但仍然是可站立的碰撞体。
  const H = 2.8
  const door = 0.7 // 门洞半宽
  // 旋转后的墙用 rotY 表达；墙段局部坐标绕 (x,z) 旋转。
  const c = Math.cos(rotY)
  const sn = Math.sin(rotY)
  const put = (lx: number, lz: number, hx: number, hz: number): void => {
    ghost(s, x + lx * c - lz * sn, z + lx * sn + lz * c, hx, hz, 0, H, rotY)
  }
  // 前后墙（沿局部 X），前墙 -Z 侧留门
  put(0, -HZ, HX, T)
  put(-(HX + door) / 2, HZ, (HX - door) / 2, T)
  put((HX + door) / 2, HZ, (HX - door) / 2, T)
  // 左右墙（沿局部 Z）
  put(-HX, 0, T, HZ)
  put(HX, 0, T, HZ)
}

/** 实心木屋：不开放内部，美观上更省盒子。 */
function solidCabin(s: BrushSet, x: number, z: number, hx: number, hz: number, top: number, rotY = 0): void {
  ghost(s, x, z, hx, hz, 0, snap(top), rotY)
}

/** 木栈桥：桥面 + 两侧栏杆。 */
function bridge(s: BrushSet, x: number, z: number, hx: number, hz: number, rotY = 0): void {
  s.slabR(x, z, hx, hz, 0, 0.8, rotY, 'wood')
  const c = Math.cos(rotY)
  const sn = Math.sin(rotY)
  for (const side of [-1, 1]) {
    const lx = side * (hx - 0.1)
    s.span(x + lx * c, 1.4, z + lx * sn, 0.06, 0.6, hz, 'wood', rotY)
  }
}

/** 木屋区：三栋木屋 + 水井 + 晾木架 + 篝火。 */
function buildCamp(s: BrushSet): void {
  // 主屋：可进入，门朝营地中心（+Z 方向 → rotY = PI 让模型的 -Z 正面转过来）
  enterableCabin(s, -10, -5, Math.PI)
  // 两栋实心屋：从外围绕行时提供剪影层次
  solidCabin(s, 9, -9, 3.0, 2.4, 2.8, -0.35)
  solidCabin(s, 12, 5, 2.7, 2.2, 2.4, 2.5)

  // 水井：井台可站（顶面 0.4m），井圈挡视线
  s.slab(-1, -2, 1.0, 1.0, 0, 0.4, 'stone')
  s.span(-1, 1.2, -2, 0.7, 0.8, 0.7, 'stone') // 井圈：0.4 → 2.0m，顶面落在网格上

  // 篝火围石：一圈矮台，蹲下能藏、站直露头
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    s.slab(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0.45, 0.45, 0, 0.4, 'stone')
  }

  // 晾木架：两排横杆，切断营地中央的直视线
  for (const z of [-6.5, -3.5, 0.5, 3.5]) {
    for (const x of [-3.2, 0, 3.2]) s.slab(x, z, 0.15, 0.15, 0, 2.0, 'wood')
    s.span(0, 1.9, z, 3.4, 0.08, 0.08, 'wood')
  }

  // 货架与木箱：营地东南角的小型仓储
  s.slab(6, 0, 1.4, 0.6, 0, 1.2, 'wood')
  s.slab(8, 1.5, 0.8, 0.8, 0, 0.8, 'wood')
  s.slab(9.2, 2.2, 0.6, 0.6, 0, 0.4, 'wood')
  s.slab(5, 3.2, 1.0, 0.5, 0, 1.6, 'wood')
}

/** 锯木厂：开敞棚架 + 沉木池 + 栈台。 */
function buildSawmill(s: BrushSet): void {
  const X = 58
  const Z = -36
  // 后墙在模型局部 -Z（北侧）、四根立柱：碰撞与 sawmill_a 的坐标系一致。
  ghost(s, X, Z - 3.2, 4.2, 0.25, 0, 3.6)
  for (const dz of [-3.2, 3.2]) {
    for (const dx of [-0.2, 4.2]) ghost(s, X + dx, Z + dz, 0.22, 0.22, 0, 3.6)
  }
  // 送料台
  s.slab(X - 2.4, Z + 1.0, 1.5, 1.0, 0, 0.8, 'wood')
  // 沉木池的水面在 LevelDef.water 里单独给（水不生成碰撞体）。

  // 池边栈台：顶面 0.8m，能站
  s.slab(X + 6, Z - 8, 2.0, 9.0, 0, 0.8, 'wood')
  s.slab(X + 15, Z - 8, 2.2, 2.2, 0, 0.8, 'wood')
  // 吊臂：横跨池面的高杆
  s.slab(X + 6, Z - 15, 0.25, 0.25, 0, 5.2, 'metal')
  s.span(X + 10, 5.0, Z - 15, 4.2, 0.15, 0.15, 'metal')
}

/** 伐木坡：三层台地 + 滑木槽 + 树桩阵。 */
function buildSlope(s: BrushSet): void {
  const X = 46
  const Z = 54
  // 三层台地，每层 0.8m，中间用 0.4m 台阶衔接
  s.slab(X + 6, Z + 4, 9.0, 8.0, 0, 0.8, 'stone')
  s.slab(X + 12, Z + 8, 5.0, 5.0, 0, 1.2, 'stone')
  s.slab(X + 16, Z + 12, 3.0, 3.0, 0, 1.6, 'stone')
  s.stairX(Z + 4, X - 2, 1, 2, 4.0, 'stone', 1.2)
  // 滑木槽：两条平行的斜向木梁
  s.span(X + 2, 0.9, Z - 2, 8.0, 0.12, 0.35, 'wood', -0.18)
  s.span(X + 2, 0.9, Z - 4, 8.0, 0.12, 0.35, 'wood', -0.18)
  // 倒木与树桩：都是 0.4m 顶面，能踩
  const rnd = mulberry32(0x7a1c)
  for (let i = 0; i < 14; i++) {
    const x = X - 6 + rnd() * 22
    const z = Z - 8 + rnd() * 18
    s.slab(x, z, 0.3 + rnd() * 0.5, 0.3 + rnd() * 0.5, 0, 0.4, 'wood')
  }
}

/** 烧焦林：焚毁的木屋残墙 + 焦木桩。 */
function buildBurned(s: BrushSet): void {
  const X = -54
  const Z = 40
  // 只剩两面墙的焚屋：L 形，能穿、能绕、不能藏
  s.wallX(Z - 3, X - 4, X + 3, 0, 2.4, { t: 0.4, material: 'wood', gaps: [[X - 1, X + 1]] })
  s.wallZ(X - 4, Z - 3, Z + 3, 0, 2.4, { t: 0.4, material: 'wood' })
  // 倒塌的梁：悬空，能从下面过
  s.span(X + 1, 1.6, Z + 1, 3.4, 0.18, 0.3, 'wood', 0.7)
  s.span(X - 2, 3.2, Z - 6, 2.6, 0.16, 0.24, 'wood', -0.4)
  // 焦木桩
  const rnd = mulberry32(0x3c9d)
  for (let i = 0; i < 12; i++) {
    const x = X - 10 + rnd() * 20
    const z = Z - 10 + rnd() * 18
    s.slab(x, z, 0.25, 0.25, 0, snap(1.2 + rnd() * 2.4), 'wood')
  }
}

/** 运输道：木桥 + 哨卡 + 路障。 */
function buildRoad(s: BrushSet): void {
  const X = -58
  const Z = -46
  // 两段道路两侧的矮堤：把长走廊压成 8m 宽
  s.slab(X - 5, Z, 1.0, 12.0, 0, 1.2, 'mud')
  s.slab(X + 5, Z, 1.0, 12.0, 0, 1.2, 'mud')
  // 木桥跨过一条泥沟
  bridge(s, X, Z + 2, 3.0, 8.0, 0)
  // 哨卡：两根立柱 + 横梁 + 吊牌
  s.slab(X - 3.2, Z - 10, 0.25, 0.25, 0, 3.2, 'wood')
  s.slab(X + 3.2, Z - 10, 0.25, 0.25, 0, 3.2, 'wood')
  s.span(X, 3.0, Z - 10, 3.4, 0.15, 0.2, 'wood')
  // 路障：一段错位原木
  s.span(X + 1.5, 0.6, Z - 4, 2.4, 0.2, 0.25, 'wood', 0.4)
  s.span(X - 1.0, 0.6, Z - 1, 2.4, 0.2, 0.25, 'wood', -0.3)
}

/** 北岭：岩脊 + 孤树 + 石堆。 */
function buildRidge(s: BrushSet): void {
  const X = 0
  const Z = -72
  s.slab(X, Z, 8.0, 6.0, 0, 0.8, 'stone')
  s.slab(X - 4, Z - 3, 4.0, 3.0, 0, 1.2, 'stone')
  s.slab(X + 4, Z - 4, 3.0, 2.0, 0, 1.6, 'stone')
  s.stairX(Z, X - 8, 1, 3, 3.0, 'stone', 1.2)
  const rnd = mulberry32(0x5e2b)
  for (let i = 0; i < 10; i++) {
    const x = X - 12 + rnd() * 24
    const z = Z - 7 + rnd() * 12
    s.slab(x, z, 0.3 + rnd() * 0.8, 0.3 + rnd() * 0.8, 0, 0.4, 'stone')
  }
}

/** 主入口。 */
export function buildPineCamp(set: BrushSet, ox: number, oz: number): void {
  const s = new BrushSet()
  buildCamp(s)
  buildSawmill(s)
  buildSlope(s)
  buildBurned(s)
  buildRoad(s)
  buildRidge(s)

  // 把局部坐标整体搬到世界坐标
  for (const b of s.list) {
    b.x += ox
    b.z += oz
  }
  set.list.push(...s.list)
}

/** 供 hdr/水面使用：沉木池。 */
export function pineWater(): { x: number; z: number; hx: number; hz: number; rotY?: number }[] {
  return [{ x: 72, z: -52, hx: 11, hz: 7, rotY: 0.3 }]
}
