/**
 * 沼泽栈桥与沉船区。
 *
 * 这一区是整张图最"低"的地方：除了甲板之外没有 1.2m 以上的东西，全靠水平
 * 方向的木板和竖直的芦苇切割视线。玩家在这里的移动是"跳格子" —— 木栈道
 * 是唯一不减速的硬地面，水洼和芦苇荡里跑不快（客户端按 surfaceAt 判材质）。
 *
 * 设计要点：
 * - 栈道做成之字形，每段之间靠直角拐弯断开：顺着一条栈道平推的人，拐角处
 *   必然把自己露在侧面。这是全图唯一"沿着地形走反而更危险"的地方。
 * - 半沉的船体是这一区唯一的高地（甲板 0.8~1.2m）。船身斜放 25°，所以它挡住
 *   的不是一块掩体而是一条 19m 的斜线，从任何方向过去都得绕。
 * - 芦苇荡只到 1.2m：能藏人不挡弹道，逼人蹲走而不是在芦苇里跑直线。
 */

import { BrushSet, translate, mulberry32 } from './kit.ts'
import type { WaterRect } from '../level.ts'

export interface SwampOpts {
  /** 芦苇丛数量。每丛 1 个盒子。默认 44。 */
  reeds?: number
  /** 随机种子。同一张图必须同一个种子，否则两端摆出来的芦苇不重合。 */
  seed?: number
  /** 是否画水洼。默认 true。 */
  water?: boolean
}

export function buildSwamp(set: BrushSet, ox: number, oz: number, water: WaterRect[], opts: SwampOpts = {}): void {
  const s = new BrushSet()
  const rnd = mulberry32(opts.seed ?? 0x5a17e)
  const reeds = opts.reeds ?? 44

  // ---- 木栈道：之字形五段，甲板一律抬到 0.4m ----
  // 0.4m 是有意的：低于它玩家会"踩在水里"，高于它每一段都成了小梯田。
  s.slab(-21, -14, 9.0, 1.6, 0, 0.4, 'wood') // 入口段（东西向，x -30~-12）
  s.slab(-12, -7, 1.6, 7.0, 0, 0.4, 'wood') // 北拐（南北向，z -14~0）
  s.slab(-5, 0, 7.0, 1.6, 0, 0.4, 'wood') // 中段（东西向，x -12~2）
  s.slab(2, 7, 1.6, 7.0, 0, 0.4, 'wood') // 南拐（南北向，z 0~14）
  s.slab(6, 14, 4.0, 1.6, 0, 0.4, 'wood') // 上岸段（东西向，x 2~10）
  // 桩：露出甲板 1.2m，既是支撑也是"能挡半身"的柱子，顺便在栈道上切出节奏
  const postX = [-28, -20, -12, -4, 4, 10]
  for (const x of postX) s.slab(x, -14, 0.25, 0.25, 0, 1.6, 'wood')
  for (const z of [-14, -7, 0]) s.slab(2, z, 0.25, 0.25, 0, 1.6, 'wood')
  for (const z of [-10, -2]) s.slab(-12, z, 0.25, 0.25, 0, 1.6, 'wood')
  // 栏杆只装单侧：另一侧留空，才有"贴栏走 / 翻栏跑"的选择
  s.fenceX(-15.7, -30, -12, 1.2, { material: 'wood', step: 6 })
  s.fenceX(15.7, -4, 10, 1.2, { material: 'wood', step: 6 })

  // ---- 半沉的船：船体 20 × 7，绕 Y 轴 25° ----
  const hullRot = 0.44
  s.slabR(14, -16, 10.0, 3.4, 0, 1.2, hullRot, 'wood') // 船身（左舷）
  s.slabR(14, -16, 9.2, 2.2, 0.8, 1.2, hullRot + 0.02, 'wood') // 甲板：0.8~1.2m
  s.slabR(5, -19, 2.6, 2.6, 0, 1.6, hullRot, 'wood') // 船艏抬高段
  s.span(20, 6.2, -12.2, 0.35, 4.2, 0.35, 'wood', hullRot) // 断桅：8m 竖柱
  s.slabR(24, -12, 2.2, 2.2, 0, 1.2, hullRot, 'wood') // 船艉残骸
  s.slabR(14, -16, 6.0, 0.6, 1.2, 2.4, hullRot, 'wood') // 破损舱壁：甲板上唯一的半身掩体
  s.slab(20, -8, 1.2, 1.2, 0, 0.8, 'metal') // 冲上泥滩的铁箱
  s.slabR(8, -12, 1.6, 1.6, 0, 0.8, 0.3, 'metal') // 第二只，和木质残骸拉开色块

  // ---- 码头：栈道尽头的小栈台，比栈道再抬一级（0.8m）----
  s.slab(11, 18, 4.0, 3.0, 0, 0.8, 'wood')
  s.slab(15.4, 18, 1.6, 2.0, 0, 0.4, 'wood') // 上岸台阶：0.4m 一级，正好迈得上去
  s.slab(11, 21.4, 4.0, 0.6, 0.8, 1.6, 'wood') // 栈台边沿矮挡板
  s.slab(7.2, 18, 0.3, 0.3, 0, 2.4, 'wood') // 系缆桩

  // ---- 芦苇荡：最高 1.2m 的 foliage 丛，数量显式可调 ----
  // 栈道、船体、码头附近留空：玩家复位/跑动时不会一出生就卡在芦苇里。
  for (let i = 0; i < reeds; i++) {
    const x = -30 + rnd() * 60
    const z = -28 + rnd() * 56
    if (Math.abs(z + 14) < 3 && x < -11) continue // 入口段
    if (Math.abs(x + 12) < 2.6 && z < 0.5) continue // 北拐
    if (Math.abs(z) < 2.6 && x < 2.6) continue // 中段
    if (Math.abs(x - 2) < 2.6 && z > -0.5) continue // 南拐
    if (Math.abs(z - 14) < 2.6 && x > 1) continue // 上岸段
    if (Math.abs(x - 11) < 5 && Math.abs(z - 18) < 4) continue // 码头
    if (Math.abs(x - 14) < 12 && Math.abs(z + 16) < 7) continue // 船体
    s.slab(x, z, 0.8 + rnd() * 1.2, 0.8 + rnd() * 1.2, 0, rnd() < 0.5 ? 0.8 : 1.2, 'foliage')
  }

  // ---- 泥堤：把这一区和外面的走廊隔开，只留两个"涉水口" ----
  s.wallZ(-31, -26, 6, 0, 1.2, { t: 1.2, material: 'mud', gaps: [[-14, -9]] })
  s.wallX(-31, -22, 14, 0, 1.2, { t: 1.2, material: 'mud', gaps: [[-4, 1]] })
  s.wallX(31, -12, 20, 0, 1.6, { t: 1.2, material: 'mud' })

  // ---- 水洼：只做地形（渲染 + 脚步材质），不生成碰撞 ----
  if (opts.water !== false) {
    water.push({ x: -22 + ox, z: 6 + oz, hx: 8, hz: 6 })
    water.push({ x: 2 + ox, z: -24 + oz, hx: 7, hz: 5, rotY: 0.2 })
    water.push({ x: 22 + ox, z: 4 + oz, hx: 6, hz: 8 })
  }

  set.list.push(...translate(s.list, ox, oz))
}
