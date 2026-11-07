/**
 * 关卡几何的积木工具集。
 *
 * "这块掩体为什么在这儿"的判断留在每张地图里（它们不可复用）；
 * 但"怎么把一个盒子放到 0.4m 网格上""怎么在墙中间切一个门洞"是可以复用的：
 * 让每张图各写一遍墙段切口逻辑，必然有一张把门洞算错 0.05m，
 * 而 0.05m 的错位在玩家侧的表现就是"明明能过去却被拦住"。
 *
 * 0.4m 网格是硬约束，不是审美：角色控制器的自动台阶高度是 0.4m。
 * 所以"立在地面上的方块"的顶面与底面都必须落在 0.4 的整数倍上：
 * 台地之间自然形成可通行的台阶，而不是"看起来像台阶、走上去卡住"。
 * 0.5m 的落差就是一堵爬不上的墙。悬空薄片（栅栏横杆、吊臂、屋脊）
 * 不受这条约束 —— 它们不在脚下。
 *
 * 生成要显式给数量：墓碑、碎石、枕木这类重复元素用 mulberry32 摆，
 * 但每一处的数量都是 builder 的入参。客户端已按材质合批，盒子数不再等于
 * draw call 数；上限 1600 主要约束 Rapier 碰撞体与关卡生成时间。数量写死在
 * builder 里，调密度就得改代码、看不出代价。
 */

import type { BoxBrush } from '../level.ts'

export type Mat = NonNullable<BoxBrush['material']>

/** 角色控制器的自动台阶高度。全场唯一的"落差"单位。 */
export const STEP = 0.4

/** 把高度吸附到 0.4 的网格上（手滑写出的 1.85 会被这里救回来）。 */
export function snap(v: number): number {
  return Math.round(v / STEP) * STEP
}

/** v 是否落在 0.4 的网格上。测试用它守门。 */
export function onGrid(v: number): boolean {
  return Math.abs(v / STEP - Math.round(v / STEP)) < 1e-6
}

/**
 * mulberry32：确定性 32 位随机数。
 *
 * 客户端按 seed 生成网格、服务端按同一个 seed 生成碰撞体。任何一次
 * Math.random() 都会让两边错开（玩家看得见墓碑，子弹从墓碑中间穿过去）。
 * 同一串数在 Node 与浏览器里完全相同：只用 imul / 位运算 / 除法，
 * 不碰 Math.sin 之类实现相关的函数。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 沿墙轴切门洞用的区间。 */
export type Gap = readonly [number, number]

/** 窗洞：只挖掉 sill..top 之间，下面留窗台、上面留过梁。 */
export interface WindowOpening {
  gap: Gap
  /** 窗台顶面高度（世界 y）。需要落在 0.4m 网格上。 */
  sill: number
  /** 窗洞顶面高度（世界 y）。需要落在 0.4m 网格上。 */
  top: number
}

export interface WallOpts {
  /** 墙厚（米）。石头 0.6~0.8、木墙 0.3、铁栅栏 0.12。 */
  t?: number
  material?: Mat
  /** 门洞（沿墙轴的世界坐标区间）。宽 2.4m 以上：窄门只会变成"谁先卡门口谁死"。 */
  gaps?: readonly Gap[]
  /**
   * 窗洞。碰撞上是真的洞（子弹能穿、视线能过），但窗台高度挡住人。
   * 用盒子拼出来而不是"整面墙 + 洞"：Rapier 只认凸体，带洞的盒子就是实心墙。
   */
  windows?: readonly WindowOpening[]
}

export interface FenceOpts {
  /** 立柱间距。 */
  step?: number
  material?: Mat
}

/**
 * 一个区域/一张地图的盒子收集器。
 *
 * 为什么不直接 push：地图里的 y 和 hy 是"中心 + 半高"，而设计时脑子里
 * 想的是"这块台子从 0 到 1.2m"。让 builder 做一次换算，就不会出现
 * "顶面 1.2 写成中心 1.2"这种一眼看不出、但整块台面矮了 0.8m 的错。
 */
export class BrushSet {
  readonly list: BoxBrush[] = []

  /** 立在地面上的方块：给底面与顶面高度。 */
  slab(x: number, z: number, hx: number, hz: number, bottom: number, top: number, material: Mat = 'wood'): this {
    this.list.push({ x, y: (bottom + top) / 2, z, hx, hy: (top - bottom) / 2, hz, material })
    return this
  }

  /** 同上，绕 Y 轴转过 rotY（斜放的木箱、船体、斜墙）。 */
  slabR(x: number, z: number, hx: number, hz: number, bottom: number, top: number, rotY: number, material: Mat = 'wood'): this {
    this.list.push({ x, y: (bottom + top) / 2, z, hx, hy: (top - bottom) / 2, hz, material, rotY })
    return this
  }

  /** 悬空方块：直接给中心与三轴半长。屋顶、屋脊、铁轨、横杆、吊臂走这里。 */
  span(x: number, y: number, z: number, hx: number, hy: number, hz: number, material: Mat = 'wood', rotY?: number): this {
    const b: BoxBrush = { x, y, z, hx, hy, hz, material }
    if (rotY !== undefined) b.rotY = rotY
    this.list.push(b)
    return this
  }

  /** 纯装饰片：不参与碰撞，高度压在 0.12m 以下，只做地面上的一道线。 */
  decal(x: number, z: number, hx: number, hz: number, material: Mat = 'mud', top = 0.08): this {
    this.list.push({ x, y: top / 2, z, hx, hy: top / 2, hz, material, noCollide: true })
    return this
  }

  /**
   * 沿 X 方向的墙（墙轴 = x，法线 = z）。gaps 是门洞区间。
   *
   * 墙被切成若干段而不是"整面墙 + 一个洞"：碰撞体只能是凸形状 ——
   * 一个带洞的盒子在 Rapier 里就是一块实心墙。
   */
  wallX(z: number, from: number, to: number, bottom: number, top: number, opts: WallOpts = {}): this {
    return this.wall('x', z, from, to, bottom, top, opts)
  }

  /** 沿 Z 方向的墙（墙轴 = z，法线 = x）。参数语义同 wallX。 */
  wallZ(x: number, from: number, to: number, bottom: number, top: number, opts: WallOpts = {}): this {
    return this.wall('z', x, from, to, bottom, top, opts)
  }

  /**
   * 墙的共用实现：先按门洞/窗洞的并集切成整高墙段，再给窗洞补窗台与过梁。
   *
   * 为什么要求窗台/过梁落在 0.4m 网格：窗台本身是"能站上去的台面"。
   * 1.2m 的窗台跨不上去（超过 0.4 台阶），但 0.8m 的可以 —— 设计时如果
   * 写 0.75，玩家会看到一条"应该能踩、实际卡住"的边。
   */
  private wall(
    axis: 'x' | 'z',
    fixed: number,
    from: number,
    to: number,
    bottom: number,
    top: number,
    opts: WallOpts,
  ): this {
    const t = opts.t ?? 0.6
    const material = opts.material ?? 'stone'
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    const doors = [...(opts.gaps ?? [])]
    const windows = [...(opts.windows ?? [])]

    // 所有切口（门 + 窗）的并集，按起点排序后合并重叠区间。
    const cuts: [number, number][] = []
    for (const [g0, g1] of [...doors, ...windows.map((w) => w.gap)]) {
      const a = Math.max(lo, Math.min(hi, Math.min(g0, g1)))
      const b = Math.max(lo, Math.min(hi, Math.max(g0, g1)))
      if (b - a > 1e-6) cuts.push([a, b])
    }
    cuts.sort((p, q) => p[0] - q[0])
    const merged: [number, number][] = []
    for (const [a, b] of cuts) {
      const last = merged[merged.length - 1]
      if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b)
      else merged.push([a, b])
    }

    const seg = (a: number, b: number, y0: number, y1: number): void => {
      if (b - a <= 1e-6 || y1 - y0 <= 1e-6) return
      if (axis === 'x') this.slab((a + b) / 2, fixed, (b - a) / 2, t / 2, y0, y1, material)
      else this.slab(fixed, (a + b) / 2, t / 2, (b - a) / 2, y0, y1, material)
    }

    let cursor = lo
    for (const [a, b] of merged) {
      seg(cursor, a, bottom, top)
      cursor = Math.max(cursor, b)
    }
    seg(cursor, hi, bottom, top)

    // 窗台与过梁。与门洞重叠的窗直接跳过（门已经全高挖掉了）。
    for (const w of windows) {
      const wa = Math.max(lo, Math.min(hi, Math.min(w.gap[0], w.gap[1])))
      const wb = Math.max(lo, Math.min(hi, Math.max(w.gap[0], w.gap[1])))
      if (wb - wa <= 1e-6) continue
      if (doors.some(([d0, d1]) => Math.max(d0, d1) > wa + 1e-6 && Math.min(d0, d1) < wb - 1e-6)) continue
      const sill = Math.max(bottom, Math.min(top, w.sill))
      const head = Math.max(bottom, Math.min(top, w.top))
      seg(wa, wb, bottom, sill)
      seg(wa, wb, head, top)
    }
    return this
  }

  /** 台阶：count 级，每级 0.4m 高、depth 深，沿 x 轴抬升。 */
  stairX(z: number, x0: number, dir: 1 | -1, count: number, width: number, material: Mat = 'stone', depth = 1.2): this {
    for (let i = 0; i < count; i++) {
      this.slab(x0 + dir * depth * (i + 0.5), z, depth / 2, width / 2, 0, STEP * (i + 1), material)
    }
    return this
  }

  /** 台阶的 z 轴版本。 */
  stairZ(x: number, z0: number, dir: 1 | -1, count: number, width: number, material: Mat = 'stone', depth = 1.2): this {
    for (let i = 0; i < count; i++) {
      this.slab(x, z0 + dir * depth * (i + 0.5), width / 2, depth / 2, 0, STEP * (i + 1), material)
    }
    return this
  }

  /**
   * 铁栅栏（沿 X）：立柱落地，两道横杆悬空。
   *
   * 横杆做成实体：这张图里栅栏就是"看得见、过不去、能挡子弹"的矮墙，
   * 而不是膝盖高的装饰 —— 墓园需要一条能贴身的边界，隔着栏杆对枪，
   * 才谈得上"翻不翻"。
   */
  fenceX(z: number, from: number, to: number, height: number, opts: FenceOpts = {}): this {
    const th = 0.12
    const material = opts.material ?? 'metal'
    const step = opts.step ?? 3.2
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    const n = Math.max(1, Math.round((hi - lo) / step))
    for (let i = 0; i <= n; i++) {
      this.slab(lo + ((hi - lo) * i) / n, z, th / 2, th / 2, 0, height, material)
    }
    this.span((lo + hi) / 2, height - 0.2, z, (hi - lo) / 2, 0.06, th / 2, material)
    this.span((lo + hi) / 2, height * 0.5, z, (hi - lo) / 2, 0.06, th / 2, material)
    return this
  }

  /** 铁栅栏（沿 Z）。 */
  fenceZ(x: number, from: number, to: number, height: number, opts: FenceOpts = {}): this {
    const th = 0.12
    const material = opts.material ?? 'metal'
    const step = opts.step ?? 3.2
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    const n = Math.max(1, Math.round((hi - lo) / step))
    for (let i = 0; i <= n; i++) {
      this.slab(x, lo + ((hi - lo) * i) / n, th / 2, th / 2, 0, height, material)
    }
    this.span(x, height - 0.2, (lo + hi) / 2, th / 2, 0.06, (hi - lo) / 2, material)
    this.span(x, height * 0.5, (lo + hi) / 2, th / 2, 0.06, (hi - lo) / 2, material)
    return this
  }

  /**
   * 树：树干 + 一块树冠。
   *
   * 树干 0.8m 见方，树冠是一整块叶子方块（漫画描边风格里叶子就该是
   * 硬体块，而不是几百个面片）。树干够粗才断得住视线：0.4m 的柱子摆成
   * 一排也挡不住一条 200m 的枪线，那等于没种。
   */
  tree(x: number, z: number, trunkTop = 4.8, crownTop = 8.0, material: Mat = 'wood'): this {
    this.slab(x, z, 0.4, 0.4, 0, trunkTop, material)
    this.span(x, (trunkTop + crownTop) / 2, z, 1.6, (crownTop - trunkTop) / 2, 1.6, 'foliage')
    return this
  }

  /** 干草捆：foliage 的矮方墩，蹲下全藏、站直能露头。 */
  hay(x: number, z: number, hx: number, hz: number, top = 1.6): this {
    return this.slab(x, z, hx, hz, 0, top, 'foliage')
  }
}

/**
 * 林带：沿一条直线种一排树，带确定性抖动。
 *
 * 为什么不是"手工摆 20 棵树"：树带的作用是**断视线**，它必须连续、均匀，
 * 而手写 20 组坐标最容易出现"这里多出一个 6m 的口子"—— 那个口子就是
 * 200m 狙击长廊的诞生地。数量由 spacing 决定，gaps 明确写出"哪里本来该有洞"
 * （战术通道），其余位置一律不许有缝。
 */
export function treelineX(
  s: BrushSet,
  z: number,
  from: number,
  to: number,
  opts: { spacing?: number; jitter?: number; gaps?: readonly Gap[]; seed?: number; trunkTop?: number; crownTop?: number } = {},
): void {
  const spacing = opts.spacing ?? 6
  const jitter = opts.jitter ?? 1.6
  const rnd = mulberry32(opts.seed ?? 0x77aa11)
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const n = Math.max(1, Math.round((hi - lo) / spacing))
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n
    if (opts.gaps?.some(([g0, g1]) => x > g0 - 1.2 && x < g1 + 1.2)) continue
    s.tree(x + (rnd() - 0.5) * jitter, z + (rnd() - 0.5) * jitter, opts.trunkTop ?? 4.8, opts.crownTop ?? 8.0, 'wood')
  }
}

/** 林带的 Z 轴版本。 */
export function treelineZ(
  s: BrushSet,
  x: number,
  from: number,
  to: number,
  opts: { spacing?: number; jitter?: number; gaps?: readonly Gap[]; seed?: number; trunkTop?: number; crownTop?: number } = {},
): void {
  const spacing = opts.spacing ?? 6
  const jitter = opts.jitter ?? 1.6
  const rnd = mulberry32(opts.seed ?? 0x33bb22)
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const n = Math.max(1, Math.round((hi - lo) / spacing))
  for (let i = 0; i <= n; i++) {
    const z = lo + ((hi - lo) * i) / n
    if (opts.gaps?.some(([g0, g1]) => z > g0 - 1.2 && z < g1 + 1.2)) continue
    s.tree(x + (rnd() - 0.5) * jitter, z + (rnd() - 0.5) * jitter, opts.trunkTop ?? 4.8, opts.crownTop ?? 8.0, 'wood')
  }
}

/**
 * 地图外缘土堤：沿边界压一圈 3.2m 的连续土堤（4 面 + 4 个角墩）。
 *
 * 为什么必须要有：区域与区域之间靠林带断视线，但"地图边缘到最近的区域"那
 * 一圈永远是空的 —— 那是最省力的狙击位：背贴隐形墙、顺着边界看 200m、
 * 一枪不开就走。土堤把外缘变成实体边界（也是视觉上的"世界尽头"），
 * 成本只有 8 个盒子，比在边缘种 200 棵树划算得多。
 */
export function perimeterBerm(
  s: BrushSet,
  half: number,
  opts: { material?: Mat; top?: number; inset?: number; halfWidth?: number; amp?: number; seg?: number } = {},
): void {
  const inset = opts.inset ?? 2.0
  const amp = opts.amp ?? 2.0 // 锯齿内外偏移量
  const seg = opts.seg ?? 12 // 每段长度
  const hw = opts.halfWidth ?? 2.4 // 半宽必须 > amp，否则两层锯齿之间会漏出一条 250m 的缝
  const top = opts.top ?? 3.2
  const mat = opts.material ?? 'stone'
  const r = half - inset - amp
  // 每条边切成一串交错的内外段：正对着土堤看是墙，贴着土堤斜着看每隔 12m 就撞一次
  const edge = (axis: 'x' | 'z', sign: number): void => {
    const len = r * 2
    const n = Math.max(2, Math.round(len / seg))
    for (let i = 0; i < n; i++) {
      const t0 = -r + (len * i) / n
      const t1 = -r + (len * (i + 1)) / n
      const mid = (t0 + t1) / 2
      const halfLen = (t1 - t0) / 2 + hw // 相邻段互相压住 2.4m，接缝处不能有口子
      const off = sign * (r + (i % 2 === 0 ? -amp : amp))
      if (axis === 'x') s.span(mid, top / 2, off, halfLen, top / 2, hw, mat)
      else s.span(off, top / 2, mid, hw, top / 2, halfLen, mat)
    }
  }
  edge('x', -1) // 北
  edge('x', 1) // 南
  edge('z', -1) // 西
  edge('z', 1) // 东
  // 角墩：锯齿两端的内外偏移不一定对齐，四个角必须用实心块补死，否则对角线能从角缝钻出去
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      s.span(sx * (r + amp), (top + 0.4) / 2, sz * (r + amp), hw + amp, (top + 0.4) / 2, hw + amp, mat)
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      s.span(sx * r, (top + 0.8) / 2, sz * r, hw + 0.6, (top + 0.8) / 2, hw + 0.6, mat) // 角墩：四个死角不能留缝
    }
  }
}

/**
 * 荒野断点：在空地带上按"错位方格"撒低矮障碍（倒木 / 石堆 / 枯树丛 / 灌木篱）。
 *
 * 为什么需要它：区域、林带、土堤把地图切成了块，但块与块之间的空地仍然可能
 * 连成一条斜穿的走廊 —— 两个区域各自被挡住，中间那段空地却没有。这条走廊
 * 不会出现在任何"区域对"的检查里，只会在实际对局里变成一发 200m 的冷枪。
 *
 * 用错位方格（而不是纯随机）：纯随机的障碍物会在某些方向留出完全空的扇区，
 * 而方格保证任何直线穿过空地时都在 ~spacing 之内撞到东西。抖动只是让它在
 * 视觉上不像棋盘。数量由 spacing 决定，并且返回值就是实际落下的盒子数。
 */
export function scatterCover(
  s: BrushSet,
  half: number,
  opts: {
    spacing?: number
    jitter?: number
    /** 这些圆内不放（区域本体、出生点、撤离点）。 */
    avoid?: readonly { x: number; z: number; r: number }[]
    /** 距中心小于这个半径的内圈不放（默认跟 avoid 一起决定）。 */
    material?: Mat
    minHalf?: number
    maxHalf?: number
    minTop?: number
    maxTop?: number
    seed?: number
  } = {},
): number {
  const spacing = opts.spacing ?? 36
  const jitter = opts.jitter ?? 6
  const rnd = mulberry32(opts.seed ?? 0x0c0ffee)
  const avoid = opts.avoid ?? []
  let placed = 0
  const start = -half + spacing / 2
  for (let gx = 0; start + gx * spacing < half; gx++) {
    for (let gz = 0; start + gz * spacing < half; gz++) {
      // 错位：奇数列整体下移半格，斜向的走廊也会被切断
      const off = gx % 2 === 0 ? 0 : spacing / 2
      const x = start + gx * spacing + (rnd() - 0.5) * jitter
      const z = start + gz * spacing + off + (rnd() - 0.5) * jitter
      if (Math.abs(x) > half - 4 || Math.abs(z) > half - 4) continue
      if (avoid.some((a) => (x - a.x) ** 2 + (z - a.z) ** 2 < (a.r + 4) ** 2)) continue
      const hx = (opts.minHalf ?? 1.6) + rnd() * ((opts.maxHalf ?? 3.4) - (opts.minHalf ?? 1.6))
      const hz = (opts.minHalf ?? 1.6) + rnd() * ((opts.maxHalf ?? 3.4) - (opts.minHalf ?? 1.6))
      const top = snap((opts.minTop ?? 1.6) + rnd() * ((opts.maxTop ?? 2.8) - (opts.minTop ?? 1.6)))
      s.slab(x, z, hx, hz, 0, top, opts.material ?? 'mud')
      // 三成概率再叠一块石头/树桩，让轮廓不是清一色的方墩
      if (rnd() < 0.3) s.slab(x + (rnd() - 0.5) * 2, z + (rnd() - 0.5) * 2, hx * 0.5, hz * 0.5, top, snap(top + 0.4), opts.material ?? 'stone')
      placed++
    }
  }
  return placed
}

/** 把一个区域（局部坐标）搬到世界坐标上。 */
export function translate(list: BoxBrush[], dx: number, dz: number): BoxBrush[] {
  for (const b of list) {
    b.x += dx
    b.z += dz
  }
  return list
}
