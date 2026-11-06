/**
 * 程序化硬表面几何工具箱（从 Claude-of-Duty 的 weapons/geometry.js 移植）。
 *
 * ## 三条铁律
 *
 * 1. **真实枪械上没有 90° 棱边。** 每个盒子都是 RoundedBoxGeometry，倒角
 *    0.3~1.5mm；每个挤出件都带 bevel；每根管子的端面都做成车削出来的圆冠。
 *    倒角本身会接住一条高光线，这是"建模"和"白模"之间唯一的区别 —— 没有
 *    倒角的方块在卡通描边下会变成一块死板，所有零件糊成一整片。
 * 2. **所有尺寸都以米为单位、按真枪量级书写。** 武器局部空间：+X 向右，
 *    +Y 向上，-Z 指向枪口。原点在持枪手虎口（握把后上沿）。所有构件在
 *    Assembly 里统一变换到武器空间，不需要每个调用点自己换算。
 * 3. **静态零件按材质合并。** 一整把步枪落到 6~10 个 draw call，而不是
 *    上百个 Mesh。动画件（击锤、转轮、刀光）保持独立，由 viewmodel 驱动。
 *
 * 这个文件只依赖 three（含 addons），不引用项目里任何其它模块。
 */

import {
  BoxGeometry,
  BufferAttribute,
  Euler,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  OctahedronGeometry,
  Path,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import type { BufferGeometry } from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

/** 模块级复用对象：每次 add() 不再 new 矩阵/四元数，构建期零抖动。 */
const _m4 = new Matrix4()
const _q = new Quaternion()
const _e = new Euler()
const _v = new Vector3()
const _s = new Vector3(1, 1, 1)
/** 镜像件的复用变换对象，避免 addMirrored 每次都展开一个新对象。 */
const _mirrorT: Transform = {}

/** merge 只认这三样；其它属性（color/tangent 等）在两个几何不一致时会合并失败。 */
const KEEP_ATTRS: readonly string[] = ['position', 'normal', 'uv']

/**
 * 统一属性集：删掉多余属性、补 UV、补法线、清空 group/morph。
 * mergeGeometries 在属性集不完全一致时会直接返回 null，所以入口必须先归一化。
 */
function normalizeAttributes(geo: BufferGeometry): BufferGeometry {
  for (const name of Object.keys(geo.attributes)) {
    if (!KEEP_ATTRS.includes(name)) geo.deleteAttribute(name)
  }
  const position = geo.getAttribute('position')
  if (!position) return geo
  if (!geo.getAttribute('uv')) {
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(position.count * 2), 2))
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals()
  geo.morphAttributes = {}
  geo.clearGroups()
  return geo
}

/** 负缩放会把三角形朝向翻过来；这里同时反转索引与法线，别让零件变成"内翻"。 */
function flipWinding(geo: BufferGeometry): BufferGeometry {
  const idx = geo.getIndex()
  if (idx) {
    const a = idx.array
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i]
      a[i] = a[i + 2]
      a[i + 2] = t
    }
    idx.needsUpdate = true
    // 法线**不要**再取反：applyMatrix4 已经用逆转置矩阵变换过法线，
    // 负缩放时它给出的就是朝外的正确镜像法线，再翻一次会把零件变成内翻。
    return geo
  }

  // 非索引几何（RoundedBoxGeometry / ExtrudeGeometry）没有索引可换，
  // 必须逐三角形交换第 1 与第 3 个顶点。只翻 normal 是不够的：绕序不变，
  // 背面剔除仍然会把零件剔掉。
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.getAttribute(name) as BufferAttribute
    const array = attr.array
    const item = attr.itemSize
    const count = attr.count
    for (let v = 0; v + 2 < count; v += 3) {
      const a0 = v * item
      const a2 = (v + 2) * item
      for (let k = 0; k < item; k++) {
        const t = array[a0 + k]
        array[a0 + k] = array[a2 + k]
        array[a2 + k] = t
      }
    }
    attr.needsUpdate = true
  }
  return geo
}

/* ==========================================================================
 * 基本体
 * ========================================================================== */

/**
 * 带倒角的盒子。chamfer 是倒角半径（米），seg=1 是 45° 硬倒角，
 * seg=2~3 是圆角。半径自动夹到最小边的 49%，否则 RoundedBoxGeometry 会自交。
 */
export function box(w: number, h: number, d: number, chamfer = 0.0012, seg = 1): BufferGeometry {
  const r = Math.min(chamfer, Math.min(w, Math.min(h, d)) * 0.49)
  if (r <= 1e-5) return normalizeAttributes(new BoxGeometry(w, h, d))
  return normalizeAttributes(new RoundedBoxGeometry(w, h, d, seg, r))
}

/** 柔和圆角块 —— 握把、掌丘、托底板。参数是硬表面里"手感件"的默认倒角。 */
export function blob(w: number, h: number, d: number, radius = 0.006, seg = 3): BufferGeometry {
  return box(w, h, d, radius, seg)
}

/**
 * 绕 Z 轴车削。profile 是 [轴向 Z, 半径] 的扁平数组，顺序任意（只要连续）。
 * 半径写 0 表示闭合端面。LatheGeometry 默认绕 +Y 转，绕 X 转 90° 后轴变成 +Z，
 * 轴向坐标原样保留 —— 这样所有管件天然沿枪管方向。
 */
export function latheZ(
  profile: ReadonlyArray<readonly [number, number]>,
  seg = 24,
  phiStart = 0,
  phiLength = Math.PI * 2,
): BufferGeometry {
  const pts: Vector2[] = []
  for (let i = 0; i < profile.length; i++) {
    pts.push(new Vector2(Math.max(1e-5, profile[i][1]), profile[i][0]))
  }
  const g = new LatheGeometry(pts, seg, phiStart, phiLength)
  g.rotateX(Math.PI / 2)
  return normalizeAttributes(g)
}

/**
 * 真正的管：外壁 + 内壁 + 两端车削圆冠。枪管、镜筒、消音器都用它。
 *
 * "能看见膛口"不是靠贴一张黑图：管子有真实内径，枪口端面有一圈圆冠，
 * 深色 bore 材质的内壁自然退进阴影里。没有内壁的实心圆柱在近景里就是一根
 * 涂了黑点的棍子，玩家一眼就能看出是假的。
 */
export function tubeZ(
  rOuter: number,
  rInner: number,
  len: number,
  seg = 24,
  crown = 0.0006,
): BufferGeometry {
  const z0 = -len / 2
  const z1 = len / 2
  const c = Math.max(0, Math.min(crown, (rOuter - rInner) * 0.4))
  return latheZ(
    [
      [z0 + c, rInner],
      [z0, rInner + c],
      [z0, rOuter - c],
      [z0 + c, rOuter],
      [z1 - c, rOuter],
      [z1, rOuter - c],
      [z1, rInner + c],
      [z1 - c, rInner],
      // 回到起点，把内壁真正连起来。LatheGeometry 只在相邻剖面点之间
      // 生成表面：如果停在 [z1 - c, rInner]，内壁那一段就完全不存在，
      // 从枪口看进去是一个「只有两个端面环、没有管壁」的空壳。
      [z0 + c, rInner],
    ],
    seg,
  )
}

/** 实心圆柱，两端倒角。抽壳杆、销轴、铆钉、转轮中心轴。 */
export function rodZ(
  r0: number,
  r1: number,
  len: number,
  seg = 20,
  chamfer = 0.0008,
): BufferGeometry {
  const z0 = -len / 2
  const z1 = len / 2
  const c = Math.max(0, Math.min(chamfer, len * 0.4, Math.min(r0, r1) * 0.5))
  return latheZ(
    [
      [z0, 0],
      [z0, Math.max(1e-5, r0 - c)],
      [z0 + c, r0],
      [z1 - c, r1],
      [z1, Math.max(1e-5, r1 - c)],
      [z1, 0],
    ],
    seg,
  )
}

/** 半球/球冠 —— 铆钉帽、前准星珠、指节鼓包。 */
export function dome(r: number, seg = 16, cut = 0.6): BufferGeometry {
  const g = new SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.5)), 0, Math.PI * 2, 0, Math.PI * cut)
  g.rotateX(Math.PI / 2)
  return normalizeAttributes(g)
}

/** 挤出参数。bevel 是两面真实倒角，缺省 0.8mm（远看就是一条高光边）。 */
export interface ExtrudeOptions {
  bevel?: number
  bevelSegments?: number
  curveSegments?: number
  steps?: number
  holes?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>
}

/**
 * 把二维侧剖面（XY 平面）沿 Z 挤出，两面带真实倒角。
 * 枪械的辨识度几乎全在侧影上：机匣的斜肩、枪托的上翘托腮、扳机护圈的空腔，
 * 都是先画侧剖面再给厚度，而不是拿几个盒子摞出来。
 */
export function extrude(
  pts: ReadonlyArray<readonly [number, number]>,
  depth: number,
  opts: ExtrudeOptions = {},
): BufferGeometry {
  const bevel = opts.bevel ?? 0.0008
  const shape = new Shape()
  shape.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
  shape.closePath()
  if (opts.holes) {
    for (const hole of opts.holes) {
      const p = new Path()
      p.moveTo(hole[0][0], hole[0][1])
      for (let i = 1; i < hole.length; i++) p.lineTo(hole[i][0], hole[i][1])
      p.closePath()
      shape.holes.push(p)
    }
  }
  const g = new ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, depth - bevel * 2),
    bevelEnabled: bevel > 1e-6,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: opts.bevelSegments ?? 1,
    curveSegments: opts.curveSegments ?? 6,
    steps: opts.steps ?? 1,
  })
  g.translate(0, 0, -depth / 2 + bevel)
  // 挤出几何是非索引的，平面法线是对的；只焊接完全重合的点（比较法线），
  // 保留硬边，不重新计算法线。
  const merged = mergeVertices(normalizeAttributes(g), 1e-6)
  if (merged !== g) g.dispose()
  return normalizeAttributes(merged)
}

/** 圆角矩形轮廓，给需要软角的挤出板件用。 */
export function roundRect(w: number, h: number, r: number, seg = 3): [number, number][] {
  const pts: [number, number][] = []
  const hw = w / 2 - r
  const hh = h / 2 - r
  const corners: Array<[number, number, number]> = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, -Math.PI / 2],
  ]
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2)
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
  }
  return pts
}

/** 圆环（环平面 XY，孔轴 Z）。背带环、扳机护圈弧、QD 环。 */
export function ring(radius: number, thickness: number, seg = 20, rings = 8, arc = Math.PI * 2): BufferGeometry {
  const g = new TorusGeometry(radius, thickness, rings, seg, arc)
  return normalizeAttributes(g)
}

/**
 * 内六角螺钉：轴线 +Z，头在 z=0 朝 -Z。沉孔是真的（环形头 + 底部塞子），
 * 所以它读作"一个孔"，而不是画上去的深色圆点。
 */
export function screw(rHead: number, rShank: number, headH: number, shankL: number, seg = 12): BufferGeometry {
  const rSocket = rHead * 0.52
  const parts: BufferGeometry[] = []
  parts.push(
    latheZ(
      [
        [0, rSocket],
        [0, rHead - 0.0002],
        [0.0002, rHead],
        [headH, rHead],
        [headH, rShank],
        [headH + shankL, rShank],
        [headH + shankL, 0],
      ],
      seg,
    ),
  )
  // 沉孔壁 + 孔底
  parts.push(
    latheZ(
      [
        [headH * 0.62, 0],
        [headH * 0.62, rSocket],
        [0, rSocket],
      ],
      6,
    ),
  )
  return mergeAll(parts)!
}

/** 滚花带：一圈小棱锥。消音器、镜筒塔轮、弹巢释放钮都用它打碎镜面高光。 */
export function knurlBand(radius: number, len: number, count = 28, depth = 0.0004, rows = 3): BufferGeometry {
  const parts: BufferGeometry[] = []
  const cell = new OctahedronGeometry(depth * 2.2, 0)
  cell.scale(1, 1, 0.55)
  for (let r = 0; r < rows; r++) {
    const z = -len / 2 + ((r + 0.5) / rows) * len
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (r % 2) * (Math.PI / count)
      const g = cell.clone()
      g.rotateZ(a)
      g.translate(Math.cos(a) * radius, Math.sin(a) * radius, z)
      parts.push(normalizeAttributes(g))
    }
  }
  cell.dispose()
  return mergeAll(parts)!
}

/** 细长防滑纹（套筒、护木、弹匣筋）。沿着 Z 走，按 axis 在 X 或 Y 上排开。 */
export function serrations(
  w: number,
  h: number,
  len: number,
  count: number,
  depth = 0.0006,
  axis: 'x' | 'y' = 'x',
): BufferGeometry {
  const parts: BufferGeometry[] = []
  const step = (axis === 'x' ? w : h) / count
  const rib = box(axis === 'x' ? step * 0.55 : w, axis === 'x' ? h : step * 0.55, len, depth * 0.9, 1)
  for (let i = 0; i < count; i++) {
    const t = -0.5 + (i + 0.5) / count
    const g = rib.clone()
    if (axis === 'x') g.translate(t * w, 0, 0)
    else g.translate(0, t * h, 0)
    parts.push(g)
  }
  rib.dispose()
  return mergeAll(parts)!
}

/** 皮卡汀尼导轨参数。缺省值就是 MIL-STD-1913 的公开尺寸。 */
export interface PicatinnyOptions {
  width?: number
  waist?: number
  baseH?: number
  topH?: number
  pitch?: number
  slot?: number
  crownChamfer?: number
}

/**
 * MIL-STD-1913 皮卡汀尼导轨，沿 Z 延伸。
 *
 * 真实尺寸：顶宽 21.2mm，45° 斜面收到底宽 15.7mm，5.35mm 后坐槽、10.55mm
 * 节距（冠部 5.2mm），槽底比冠面低 3mm。这里把槽做成**真实的缺口**而不是
 * 贴图，所以侧影里导轨是一排齿。
 *
 * 顶面倒角是整根导轨的关键：如果顶面是一整块 21mm 宽的平面，它正对主光，
 * 在玩家眼前会糊成一条 1.35 档的亮带，看起来像塑料玩具。真实的机加工导轨
 * 两侧各有一道 1.5mm 的 45° 倒角，把死平面拆成两个斜面和一道硬边 —— 高光
 * 落在倒角上，而不是铺满整个冠面。
 */
export function picatinny(len: number, opts: PicatinnyOptions = {}): BufferGeometry {
  const width = opts.width ?? 0.0212
  const waist = opts.waist ?? 0.0157
  const baseH = opts.baseH ?? 0.0042
  const topH = opts.topH ?? 0.0032
  const pitch = opts.pitch ?? 0.01055
  const slot = opts.slot ?? 0.00535
  const chamfer = 0.00035
  const ch = opts.crownChamfer ?? 0.0015

  const teeth = Math.max(1, Math.floor((len + slot) / pitch))
  const toothLen = pitch - slot
  const parts: BufferGeometry[] = []

  const base = box(width, baseH, len, chamfer, 1)
  base.translate(0, baseH / 2, 0)
  parts.push(base)

  const profile: Array<[number, number]> = [
    [-waist / 2, 0],
    [-width / 2, topH - ch],
    [-width / 2 + ch, topH],
    [width / 2 - ch, topH],
    [width / 2, topH - ch],
    [waist / 2, 0],
  ]
  const tooth = extrude(profile, toothLen, { bevel: 0.00025, bevelSegments: 1 })
  for (let i = 0; i < teeth; i++) {
    const z = len / 2 - toothLen / 2 - i * pitch
    if (z - toothLen / 2 < -len / 2) break
    const g = tooth.clone()
    g.translate(0, baseH, z)
    parts.push(g)
  }
  tooth.dispose()
  return mergeAll(parts)!
}

/** M-LOK 槽：带凸唇的沉孔。护木侧面用它打碎大片木头/聚合物。 */
export function mlokSlot(len = 0.032, wide = 0.0075, depth = 0.0022): BufferGeometry {
  const parts: BufferGeometry[] = []
  const outer = extrude(roundRect(len, wide + 0.0028, 0.0014, 3), 0.0016, { bevel: 0.0004 })
  const inner = extrude(roundRect(len - 0.0016, wide, 0.0012, 3), depth, { bevel: 0.0003 })
  inner.translate(0, 0, -depth * 0.35)
  parts.push(outer, inner)
  return mergeAll(parts)!
}

/* ==========================================================================
 * 装配
 * ========================================================================== */

/** 单件变换。Euler 顺序固定 XYZ（three 的默认欧拉序），先 rz 再 ry 再 rx。 */
export type Transform = {
  x?: number
  y?: number
  z?: number
  rx?: number
  ry?: number
  rz?: number
  sx?: number
  sy?: number
  sz?: number
}

/**
 * 收集变换后的几何，按材质分桶，build() 时每桶合成一个几何。
 *
 * 这是整个工具箱的出口：一整把步枪的几十个零件进去，6~10 个按材质合并的
 * BufferGeometry 出来，viewmodel 每把枪只需要挂几个 Mesh。
 */
export class Assembly {
  readonly name: string
  private readonly buckets = new Map<string, BufferGeometry[]>()

  constructor(name = '') {
    this.name = name
  }

  /** 添加一个零件。几何会被克隆，调用者仍然拥有并负责释放传入的 geo。 */
  add(geo: BufferGeometry, mat: string, t: Transform | null = null): Assembly {
    const g = geo.clone()
    if (t) {
      _v.set(t.x ?? 0, t.y ?? 0, t.z ?? 0)
      _e.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, 'XYZ')
      _q.setFromEuler(_e)
      _s.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1)
      _m4.compose(_v, _q, _s)
      g.applyMatrix4(_m4)
      // 负缩放翻转朝向，必须把索引和法线一起翻回来。
      if ((t.sx ?? 1) * (t.sy ?? 1) * (t.sz ?? 1) < 0) flipWinding(g)
    }
    normalizeAttributes(g)
    let list = this.buckets.get(mat)
    if (!list) {
      list = []
      this.buckets.set(mat, list)
    }
    list.push(g)
    return this
  }

  /** 同一零件在枪身两侧各来一份（镜像 X，并翻转缩放的正负号）。 */
  addMirrored(geo: BufferGeometry, mat: string, t: Transform): Assembly {
    this.add(geo, mat, t)
    _mirrorT.x = -(t.x ?? 0)
    _mirrorT.y = t.y
    _mirrorT.z = t.z
    _mirrorT.rx = t.rx
    _mirrorT.ry = t.ry
    _mirrorT.rz = t.rz
    _mirrorT.sx = -(t.sx ?? 1)
    _mirrorT.sy = t.sy
    _mirrorT.sz = t.sz
    this.add(geo, mat, _mirrorT)
    return this
  }

  /** 每材质一个合并后的几何。调用后桶清空，不能重复 build 再合并。 */
  build(): Map<string, BufferGeometry> {
    const out = new Map<string, BufferGeometry>()
    for (const [mat, list] of this.buckets) {
      const merged = mergeAll(list)
      if (merged) out.set(mat, merged)
    }
    this.buckets.clear()
    return out
  }
}

/**
 * 合并一组几何，容忍索引/非索引混在一起。
 * 输入几何会被消费（dispose）；返回值是全新的、非索引且焊接过的几何。
 */
export function mergeAll(list: Array<BufferGeometry | null>): BufferGeometry | null {
  const clean = list.filter((g): g is BufferGeometry => g !== null)
  if (!clean.length) return null
  if (clean.length === 1) return clean[0]
  const nonIndexed = clean.map((g) => (g.getIndex() ? g.toNonIndexed() : g))
  for (const g of nonIndexed) normalizeAttributes(g)
  const merged = mergeGeometries(nonIndexed, false)
  for (let i = 0; i < clean.length; i++) {
    if (nonIndexed[i] !== clean[i]) nonIndexed[i].dispose()
    clean[i].dispose()
  }
  if (!merged) return null
  const welded = mergeVertices(merged, 1e-6)
  if (welded !== merged) merged.dispose()
  return normalizeAttributes(welded)
}

/** 释放 Assembly.build() 的产物（材质不归这里管）。 */
export function disposeBuilt(map: Map<string, BufferGeometry>): void {
  for (const g of map.values()) g.dispose()
  map.clear()
}
