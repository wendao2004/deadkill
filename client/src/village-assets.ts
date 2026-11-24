/**
 * CC0 中世纪村庄模块化建筑的"视觉外壳"。
 *
 * 来源：Quaternius Medieval Village MegaKit（CC0），glTF 版本镜像：
 * https://github.com/J-Ponzo/gltf-medieval-village-megakit
 *
 * 只取屋顶/门框/阳台/烟囱/马车/木箱，叠在现有的盒刷建筑上：
 * - 判定仍然由 level.boxes 负责（平屋顶碰撞不动）；
 * - 视觉外壳不参与碰撞，玩家不会被看不见的坡屋顶卡住；
 * - 屋顶坡度只改剪影，不改"能不能站"。
 */

import { Box3, BoxGeometry, Group, LoadingManager, Mesh, type BufferGeometry, type Material } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { LevelDef } from '@dk/shared'

interface VillageModel {
  scene: Group
  box: Box3
}

export type VillageAssets = Record<string, VillageModel>

/**
 * 建筑外壳用的四种材质。由渲染器注入（墨线/toon 或写实 PBR），
 * 本模块只管"哪块模型用哪一种"，不自己造材质。
 */
export interface VillageMaterials {
  roof: Material
  wood: Material
  stone: Material
  metal: Material
  /** 檐板/角柱/腰线的深色木构件。比墙体暗一档，用来把盒子拆成"有骨架"的房子。 */
  trim: Material
}

/**
 * 外壳四色。当前默认画风走 toon/墨线，颜色按手绘色块挑：
 * 屋瓦偏冷灰褐，木头深棕，石头冷灰，金属蓝灰。
 */
export const VILLAGE_COLORS = {
  roof: 0x3d4249,
  wood: 0x4c3928,
  stone: 0x6a675f,
  metal: 0x4a4d50,
  trim: 0x2a1f15,
} as const

const PIECES = [
  'Roof_RoundTiles_4x6',
  'Roof_RoundTiles_6x8',
  'DoorFrame_Flat_WoodDark',
  'Window_Wide_Flat1',
  'Balcony_Simple_Straight',
  'Prop_Chimney',
  'Prop_Wagon',
  'Prop_Crate',
  'Roof_Support2',
] as const

/** 1x1 白图：glTF 引用的贴图我们不用，避免每块 assets 都去 404。 */
const WHITE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII='

export async function loadVillageAssets(): Promise<VillageAssets> {
  const manager = new LoadingManager()
  // glTF 自带贴图全部用白图替代：当前画风是程序化手绘，不加载 authored 贴图。
  manager.setURLModifier((url) => (/\.(png|jpg|jpeg)$/i.test(url) ? WHITE_PNG : url))
  const loader = new GLTFLoader(manager)
  const entries = await Promise.all(
    PIECES.map(async (name) => {
      try {
        const url = new URL(`./models/village/${name}.gltf`, document.baseURI).href
        const gltf = await loader.loadAsync(url)
        gltf.scene.updateMatrixWorld(true)
        const box = new Box3().setFromObject(gltf.scene)
        return [name, { scene: gltf.scene, box }] as const
      } catch (error) {
        console.warn(`[village] ${name}.gltf 加载失败`, error)
        return [name, null] as const
      }
    }),
  )
  const assets: VillageAssets = {}
  for (const [name, model] of entries) if (model) assets[name] = model
  return assets
}

function materialFor(name: string, materials: VillageMaterials): Material {
  if (/Roof/i.test(name)) return materials.roof
  if (/Chimney|Support/i.test(name)) return materials.stone
  if (/Balcony|Door|Window|Wagon|Crate/i.test(name)) return materials.wood
  return materials.stone
}

interface Placement {
  x: number
  y: number
  z: number
  /** 目标宽/深/高（米）。模型按包围盒等比/非等比缩放。 */
  w: number
  d: number
  h: number
  rotY?: number
}

/** 把一个模型按"目标包围盒"摆到世界里。 */
function place(
  parent: Group,
  model: VillageModel | undefined,
  material: Material,
  p: Placement,
): void {
  if (!model) return
  const sizeX = Math.max(0.001, model.box.max.x - model.box.min.x)
  const sizeY = Math.max(0.001, model.box.max.y - model.box.min.y)
  const sizeZ = Math.max(0.001, model.box.max.z - model.box.min.z)
  const clone = model.scene.clone(true)
  clone.position.set(
    -(model.box.min.x + model.box.max.x) / 2,
    -model.box.min.y,
    -(model.box.min.z + model.box.max.z) / 2,
  )
  clone.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    mesh.material = material
    mesh.castShadow = true
    mesh.receiveShadow = true
  })
  const inner = new Group()
  inner.add(clone)
  const outer = new Group()
  outer.add(inner)
  outer.scale.set(p.w / sizeX, p.h / sizeY, p.d / sizeZ)
  outer.position.set(p.x, p.y, p.z)
  outer.rotation.y = p.rotY ?? 0
  parent.add(outer)
}

interface BuildingShell {
  roof: string
  x: number
  z: number
  w: number
  d: number
  top: number
  roofH: number
  rotY?: number
  door?: { x: number; z: number; w: number; h: number; rotY: number }
  props?: { name: string; x: number; z: number; w: number; d: number; h: number; rotY?: number }[]
}

/**
 * 从关卡盒刷里量出这栋房子的**真实墙顶**和墙体轮廓。
 *
 * 为什么不能直接用 `shell.top`：那张表是人手写的，跟地图实际墙高一直在漂移
 * （实测七栋全部偏高 0.4–1.6m）。屋顶按表摆放就浮在墙上方，缝隙里能直接看到
 * 天空 —— 这是截图里最先被看到的东西。
 *
 * 判定方式：墙体是**长条**盒子，屋顶坡板/家具/檐口都是短盒子，所以按"每个
 * 高度上累计的墙面长度"投票，得票最多的那个高度就是墙顶。同时把这些盒子的
 * x/z 范围取出来，就是墙体的真实外轮廓 —— 角柱和檐板贴着它放才不会悬空。
 */
interface WallFootprint {
  /** 世界坐标下的墙顶高度。 */
  top: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

function measureWalls(level: LevelDef, shell: BuildingShell): WallFootprint | null {
  const hw = shell.w / 2
  const hd = shell.d / 2
  const groups = new Map<number, { len: number; minX: number; maxX: number; minZ: number; maxZ: number }>()
  for (const b of level.boxes) {
    if (b.noCollide || b.noRender) continue
    // 墙段至少一人多高；矮盒子是箱子和台阶。
    if (b.hy < 1.0) continue
    if (Math.abs(b.x - shell.x) > hw || Math.abs(b.z - shell.z) > hd) continue
    const top = b.y + b.hy
    if (top < level.groundY + 1.8) continue
    // 5cm 量化：地图里同一面墙的分段高度一致，不会被浮点误差拆成两组。
    const key = Math.round(top * 20) / 20
    const entry = groups.get(key) ?? { len: 0, minX: b.x, maxX: b.x, minZ: b.z, maxZ: b.z }
    // 用长边而不是面积：0.4m 厚的墙段面积很小，但长度足以说明"这是连续墙体"。
    entry.len += Math.max(b.hx, b.hz) * 2
    entry.minX = Math.min(entry.minX, b.x - b.hx)
    entry.maxX = Math.max(entry.maxX, b.x + b.hx)
    entry.minZ = Math.min(entry.minZ, b.z - b.hz)
    entry.maxZ = Math.max(entry.maxZ, b.z + b.hz)
    groups.set(key, entry)
  }
  let best: { top: number; len: number } | null = null
  for (const [top, entry] of groups) {
    if (!best || entry.len > best.len) best = { top, len: entry.len }
  }
  // 少于 6m 累计墙面就不当房子看（散落的柱子、围栏），交回原来的表值。
  if (!best || best.len < 6) return null
  const g = groups.get(best.top)!
  return { top: best.top, minX: g.minX, maxX: g.maxX, minZ: g.minZ, maxZ: g.maxZ }
}

/** 把一堆盒子烘成一个几何体：檐板/角柱/踢脚加起来是 12 个盒子，不合并就是 12 次绘制。 */
function pushBox(list: BufferGeometry[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
  const geo = new BoxGeometry(sx, sy, sz)
  geo.translate(cx, cy, cz)
  list.push(geo)
}

/** 同一材质的构件先进各自的桶，最后一栋房子只合并成 3~4 次绘制。 */
interface FacadeParts {
  trim: BufferGeometry[]
  /** 门扇/门板：比门套亮一档的木材，门凹在洞里时才不会变成一个黑洞。 */
  door: BufferGeometry[]
  stone: BufferGeometry[]
  metal: BufferGeometry[]
  roof: BufferGeometry[]
}

function emptyParts(): FacadeParts {
  return { trim: [], door: [], stone: [], metal: [], roof: [] }
}

/**
 * 门在房子的哪一侧、朝哪个方向。
 *
 * 判据是"门离哪一面墙最近"，不是读手写的 `door.rotY`：那个角度只描述门框
 * 模型自己怎么转，跟"门开在哪面墙上"是两件事。之前两者混用，所以任何需要
 * 知道朝向的构件（门柱、雨棚、招牌）都只能靠猜。
 */
interface DoorBasis {
  /** 墙面上门轴心的世界坐标。 */
  fx: number
  fz: number
  nx: number
  nz: number
  /** 沿墙方向的切向（局部 +X 在世界里的方向）。 */
  tx: number
  tz: number
  /** `rotateY(theta)` 能把局部 +Z 转到外法线。 */
  theta: number
}

function doorBasis(walls: WallFootprint, door: { x: number; z: number }): DoorBasis {
  const candidates = [
    { dist: Math.abs(door.z - walls.maxZ), nx: 0, nz: 1, fx: door.x, fz: walls.maxZ },
    { dist: Math.abs(door.z - walls.minZ), nx: 0, nz: -1, fx: door.x, fz: walls.minZ },
    { dist: Math.abs(door.x - walls.maxX), nx: 1, nz: 0, fx: walls.maxX, fz: door.z },
    { dist: Math.abs(door.x - walls.minX), nx: -1, nz: 0, fx: walls.minX, fz: door.z },
  ].sort((a, b) => a.dist - b.dist)
  const best = candidates[0]
  const theta = Math.atan2(best.nx, best.nz)
  return {
    fx: best.fx,
    fz: best.fz,
    nx: best.nx,
    nz: best.nz,
    tx: Math.cos(theta),
    tz: -Math.sin(theta),
    theta,
  }
}

/**
 * 在"门局部坐标"里放一个盒子：`ux` 沿墙、`uy` 绝对高度、`uz` 朝门外为正。
 *
 * 所有门相关构件都用这套坐标，写坐标时不需要关心这扇门朝南还是朝西。
 */
function pushOriented(
  list: BufferGeometry[],
  b: DoorBasis,
  sx: number,
  sy: number,
  sz: number,
  ux: number,
  uy: number,
  uz: number,
  pitch = 0,
): void {
  const geo = new BoxGeometry(sx, sy, sz)
  if (pitch !== 0) geo.rotateX(pitch)
  geo.rotateY(b.theta)
  geo.translate(b.fx + b.tx * ux + b.nx * uz, uy, b.fz + b.tz * ux + b.nz * uz)
  list.push(geo)
}

/**
 * 立面构件：檐板一圈、四根角柱、石砌踢脚。
 *
 * 这三样是"这是一栋房子"最便宜的信息量 —— 纯色盒子缺少的是**交接线**：
 * 墙和屋顶怎么接、墙角和墙面怎么分、墙和地怎么站住。它们都不跨门窗洞口，
 * 所以不需要知道洞口位置，也就不会出现"钉在窗户上的横梁"。
 */
function buildFacade(parts: FacadeParts, walls: WallFootprint, groundY: number): void {
  const woodParts = parts.trim
  const stoneParts = parts.stone
  const cx = (walls.minX + walls.maxX) / 2
  const cz = (walls.minZ + walls.maxZ) / 2
  const spanX = walls.maxX - walls.minX
  const spanZ = walls.maxZ - walls.minZ
  if (spanX < 1 || spanZ < 1) return
  const top = walls.top
  const height = Math.max(0.5, top - groundY)

  // ---- 檐板：贴着墙顶一圈，略外凸 0.06m，替屋顶"坐在墙上"造一条硬阴影线 ----
  //
  // 只留一条 12cm 的窄线，而且顶面必须低于屋顶底面：22cm 高的檐板从这里看过去
  // 是一整条横带，加上新加的封檐板就是两条平行横带 —— 一米外读成"刷了两道黑漆"。
  const eaveY = top - 0.06
  const eaveT = 0.12
  pushBox(woodParts, cx, eaveY, walls.maxZ + 0.04, spanX + 0.3, eaveT, 0.16)
  pushBox(woodParts, cx, eaveY, walls.minZ - 0.04, spanX + 0.3, eaveT, 0.16)
  pushBox(woodParts, walls.maxX + 0.04, eaveY, cz, 0.16, eaveT, spanZ + 0.3)
  pushBox(woodParts, walls.minX - 0.04, eaveY, cz, 0.16, eaveT, spanZ + 0.3)

  // ---- 角柱：从地面到檐板，包住盒子最硬的四条竖棱 ----
  const postW = 0.24
  const postY = (groundY + top) / 2
  for (const [px, pz] of [
    [walls.maxX, walls.maxZ],
    [walls.minX, walls.maxZ],
    [walls.maxX, walls.minZ],
    [walls.minX, walls.minZ],
  ] as const) {
    pushBox(woodParts, px, postY, pz, postW, height, postW)
  }

  // ---- 石砌踢脚：0.34m，外凸 0.05m，防止墙面直接"插"进地面 ----
  const plinthH = 0.34
  const plinthY = groundY + plinthH / 2
  pushBox(stoneParts, cx, plinthY, walls.maxZ + 0.05, spanX + 0.3, plinthH, 0.22)
  pushBox(stoneParts, cx, plinthY, walls.minZ - 0.05, spanX + 0.3, plinthH, 0.22)
  pushBox(stoneParts, walls.maxX + 0.05, plinthY, cz, 0.22, plinthH, spanZ + 0.3)
  pushBox(stoneParts, walls.minX - 0.05, plinthY, cz, 0.22, plinthH, spanZ + 0.3)
}

/**
 * 屋脊下的封檐板：沿着**屋顶自己的**轮廓走一圈。
 *
 * 为什么需要它：屋顶 GLB 是圆瓦，瓦口在檐边一高一低，缩放后变成一条锯齿
 * 状的花边（远看像屋檐上刷了一道闪电）。真实做法就是钉一条封檐板把瓦口盖住
 * ——顺带也给了屋顶和墙之间第二条硬线，屋面的坡从这里才"起坡"。
 */
function buildEaveFascia(parts: FacadeParts, shell: BuildingShell, roofBase: number): void {
  const height = 0.3
  const t = 0.12
  const y = roofBase + 0.08
  const halfW = shell.w / 2
  const halfD = shell.d / 2
  pushBox(parts.trim, shell.x, y, shell.z + halfD + 0.02, shell.w + 0.3, height, t)
  pushBox(parts.trim, shell.x, y, shell.z - halfD - 0.02, shell.w + 0.3, height, t)
  pushBox(parts.trim, shell.x + halfW + 0.02, y, shell.z, t, height, shell.d + 0.3)
  pushBox(parts.trim, shell.x - halfW - 0.02, y, shell.z, t, height, shell.d + 0.3)
  // 檐下封板：一整块木板把**出檐的底面**封住。
  //
  // 少了它，从地面往上看是一排瓦当的背面：一排石砌色块，比任何贴图错误都显眼
  // （瓦片模型是薄壳，出檐后底下就是漏的）。补一块板之后，出檐的底面是深色木头，
  // 同时给墙面压出一条干净的阴影。
  pushBox(parts.trim, shell.x, roofBase - 0.03, shell.z, shell.w - 0.06, 0.08, shell.d - 0.06)
}

/**
 * 门：门扇 + 铁门带 + 门楣 + 门柱 + 门槛石。
 *
 * 之前门洞是个**亮着的方洞**：门框 GLB 只是一圈框，洞里直接看到被灯光照亮的
 * 空盒子内部，于是每栋房子都像"还没装门"。门扇最便宜的补法就是几块木板加两条
 * 铁带 —— 它把洞封死，同时给出"这扇门能不能进"的判断依据。
 */
function buildDoor(
  parts: FacadeParts,
  walls: WallFootprint,
  door: { x: number; z: number; w: number; h: number },
  groundY: number,
): DoorBasis {
  const b = doorBasis(walls, door)
  const w = door.w
  const h = door.h
  const leafW = w * 0.9
  const leafH = h * 0.9
  // 门框 GLB 比墙面向内凹 0.15–0.25m，门扇要落在框里，不能糊在洞口平面上。
  const leafZ = -0.2
  const leafY = groundY + 0.06 + leafH / 2

  // ---- 门扇：五块竖板 + 一块背板。
  //
  // 背板是必须的：屋内被半球环境光整个照亮（toon 不遮挡），门板之间的缝会直接
  // 透出白亮的内墙，看上去像门缝里装了一圈灯。背板把缝变成暗线。
  const planks = 5
  const gap = 0.014
  const plankW = (leafW - gap * (planks - 1)) / planks
  pushOriented(parts.trim, b, leafW + 0.04, leafH, 0.04, 0, leafY, leafZ - 0.06)
  for (let i = 0; i < planks; i++) {
    const ux = -leafW / 2 + plankW / 2 + i * (plankW + gap)
    pushOriented(parts.door, b, plankW, leafH, 0.09, ux, leafY, leafZ)
  }

  // ---- 铁门带：两道横带，给门扇一条尺度和材质对比 ----
  for (const ratio of [0.3, 0.72]) {
    pushOriented(parts.metal, b, leafW + 0.1, 0.11, 0.03, 0, groundY + 0.06 + leafH * ratio, leafZ + 0.06)
  }
  // ---- 门楣：压在门洞上沿，把"洞"封成"入口" ----
  pushOriented(parts.trim, b, w + 0.7, 0.22, 0.34, 0, groundY + h + 0.12, 0.05)
  // ---- 门柱：两根竖框，与门楣咬合成一个门套 ----
  // 只外凸 4cm：再凸就从"门框"变成两根立在门前的柱子了。
  // 底部加一块石础，不然 3.4m 高的细木柱会读成"立在门口的木板"。
  for (const side of [-1, 1]) {
    pushOriented(parts.trim, b, 0.24, h + 0.34, 0.18, side * (w / 2 + 0.12), groundY + 0.34 + (h + 0.34) / 2, 0.02)
    pushOriented(parts.stone, b, 0.3, 0.36, 0.24, side * (w / 2 + 0.12), groundY + 0.18, 0.04)
  }
  // ---- 门槛石：门内外的地面高差 ----
  pushOriented(parts.stone, b, w + 0.3, 0.13, 0.5, 0, groundY + 0.065, 0.14)
  return b
}

/** 墙顶到雨棚之间少于这么高，就不要雨棚 —— 宁可没有，也不要顶着檐板。 */
const PORCH_MIN_CLEARANCE = 1.05

/**
 * 门头小披檐：只有墙够高的谷仓/磨坊才有，斜撑式、不落地。
 *
 * 小房子（墙顶 3.2m、门高 2.5m）根本没有空间放它，硬加就成了贴着檐板的
 * 一条呆板横板。
 */
function buildPorch(
  parts: FacadeParts,
  b: DoorBasis,
  door: { w: number; h: number },
  groundY: number,
): void {
  const pitch = 0.2
  const depth = 1.55
  const half = depth / 2
  const top = groundY + door.h + 0.6
  const centerZ = 0.05 + half * Math.cos(pitch)
  const centerY = top - half * Math.sin(pitch)
  // 棚顶：石板瓦，和屋顶同材质，所以从远处看是同一栋房子的一部分。
  pushOriented(parts.roof, b, door.w + 1.4, 0.12, depth, 0, centerY, centerZ, pitch)
  // 檐口封边
  pushOriented(parts.trim, b, door.w + 1.4, 0.13, 0.09, 0, top - depth * Math.sin(pitch) + 0.01, 0.05 + depth * Math.cos(pitch))
  // 斜撑：两端按"贴墙点"和"顶进棚底的点"直接反算长度与倾角。
  //
  // 第一版是手填长度 + 倾角 + 中心高度，三个量互相打架，上端离棚底差了十几厘米，
  // 截图里就是两根悬空的木棍。这里改成给两个端点，几何自己算 —— 上端故意多顶
  // 进棚底 5cm，藏在棚板里，看起来才是"撑住"。
  const wallZ = 0.02
  const wallY = top - 0.95
  const tipZ = 1.15
  const tipY = top - tipZ * Math.sin(pitch) + 0.05
  const braceDz = tipZ - wallZ
  const braceDy = tipY - wallY
  const braceLen = Math.hypot(braceDz, braceDy)
  const braceTilt = Math.atan2(braceDy, braceDz)
  for (const side of [-1, 1]) {
    pushOriented(
      parts.trim,
      b,
      0.1,
      0.1,
      braceLen,
      side * (door.w / 2 + 0.45),
      (wallY + tipY) / 2,
      (wallZ + tipZ) / 2,
      -braceTilt,
    )
  }
}

/** 把各桶里的盒子合并，各自一次绘制。 */
function flushParts(parent: Group, parts: FacadeParts, materials: VillageMaterials): void {
  for (const [list, material] of [
    [parts.trim, materials.trim],
    [parts.door, materials.wood],
    [parts.stone, materials.stone],
    [parts.metal, materials.metal],
    [parts.roof, materials.roof],
  ] as const) {
    if (list.length === 0) continue
    const merged = mergeGeometries(list, false)
    for (const geo of list) geo.dispose()
    if (!merged) continue
    const mesh = new Mesh(merged, material)
    mesh.name = 'village-facade'
    // 檐板在屋顶下面，必须**投**阴影才能把那条线压在墙上；本身也接收世界阴影。
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
  }
}

const SHELLS: Record<string, BuildingShell[]> = {
  'marsh-p0': [
    {
      roof: 'Roof_RoundTiles_4x6',
      x: -12,
      z: -10,
      w: 13.4,
      d: 17.4,
      top: 3.7,
      roofH: 2.2,
      door: { x: -12.8, z: -1.95, w: 2.7, h: 2.5, rotY: 0 },
      props: [
        { name: 'Prop_Chimney', x: -16.6, z: -5, w: 1.3, d: 1.3, h: 3.0 },
        // 这里原本挂着一个 Balcony_Simple_Straight：`place()` 的 y 是地面，
        // 于是"阳台"变成一道 1.2m 高的栏杆横插在门口，正好把门挡住。
        // 阳台是二层构件，这排房子只有一层，删掉比硬凑更对。
      ],
    },
    {
      roof: 'Roof_RoundTiles_4x6',
      x: 12,
      z: 16,
      w: 16.6,
      d: 12.6,
      top: 5.4,
      roofH: 2.8,
      door: { x: 4.05, z: 16, w: 3.3, h: 3.0, rotY: Math.PI / 2 },
      props: [
        { name: 'Prop_Wagon', x: -3.5, z: 7, w: 3.4, d: 1.7, h: 1.8, rotY: 0.45 },
        { name: 'Prop_Crate', x: 2.2, z: 8.2, w: 1.0, d: 1.0, h: 1.0, rotY: 0.2 },
        { name: 'Prop_Crate', x: 3.0, z: 9.0, w: 0.8, d: 0.8, h: 0.8, rotY: -0.3 },
      ],
    },
  ],
}

// 其余四图的 hero 建筑：坐标是各 zone 的局部坐标 + 区域偏移后的世界坐标。
SHELLS['marsh-p0'].push(...[
  // 磨坊：谷仓（世界 -78,-96，16×10，高 6）与主屋（-98,-75，8×6，高 3.2）
  {
    roof: 'Roof_RoundTiles_4x6',
    x: -78,
    z: -96,
    w: 16.6,
    d: 10.6,
    top: 7.6,
    roofH: 2.6,
    door: { x: -86.0, z: -96, w: 3.3, h: 3.0, rotY: Math.PI / 2 },
  },
  {
    roof: 'Roof_RoundTiles_4x6',
    x: -98,
    z: -75,
    w: 9.0,
    d: 7.0,
    top: 3.8,
    roofH: 1.8,
    door: { x: -98, z: -78, w: 2.7, h: 2.5, rotY: 0 },
  },
  // 教堂祠堂（104,-80，6×6，高 3.2）
  {
    roof: 'Roof_RoundTiles_4x6',
    x: 104,
    z: -80,
    w: 7.0,
    d: 7.0,
    top: 3.6,
    roofH: 1.8,
    door: { x: 104, z: -77, w: 2.7, h: 2.5, rotY: 0 },
  },
  // 采石场工具棚（70,68，8×8，高 2.8）
  {
    roof: 'Roof_RoundTiles_4x6',
    x: 70,
    z: 68,
    w: 9.0,
    d: 9.0,
    top: 3.2,
    roofH: 1.6,
    door: { x: 70, z: 72, w: 2.7, h: 2.5, rotY: 0 },
  },
  // 车站货棚（34,110，8×6，高 3.2）
  {
    roof: 'Roof_RoundTiles_4x6',
    x: 34,
    z: 110,
    w: 9.0,
    d: 7.0,
    top: 3.8,
    roofH: 1.8,
    door: { x: 30.05, z: 110, w: 2.7, h: 2.5, rotY: Math.PI / 2 },
  },
])

export function decorateVillage(
  parent: Group,
  level: LevelDef,
  assets: VillageAssets,
  materials: VillageMaterials,
): void {
  const shells = SHELLS[level.id]
  if (!shells) return
  for (const shell of shells) {
    // 屋顶压在**量出来的**墙顶上，而不是手写表里的 top。表值一旦和地图漂移，
    // 屋顶就会浮起来，墙顶和屋檐之间露出一条天空。
    const walls = measureWalls(level, shell)
    const roofBase = walls ? walls.top : level.groundY + shell.top
    place(parent, assets[shell.roof], materials.roof, {
      x: shell.x,
      y: roofBase - 0.04,
      z: shell.z,
      w: shell.w,
      d: shell.d,
      h: shell.roofH,
      rotY: shell.rotY,
    })
    const parts = emptyParts()
    if (walls) {
      buildFacade(parts, walls, level.groundY)
      if (shell.door) {
        const basis = buildDoor(parts, walls, shell.door, level.groundY)
        // 雨棚只给"墙顶比门头高出一大截"的房子（谷仓、磨坊）；小房子没有空间。
        const clearance = walls.top - 0.13 - (level.groundY + shell.door.h + 0.6)
        if (clearance >= PORCH_MIN_CLEARANCE) buildPorch(parts, basis, shell.door, level.groundY)
      }
    }
    // 封檐板跟着**屋顶**的实际轮廓，所以不依赖 measureWalls 是否成功。
    buildEaveFascia(parts, shell, roofBase - 0.04)
    flushParts(parent, parts, materials)
    if (shell.door) {
      place(parent, assets.DoorFrame_Flat_WoodDark, materials.wood, {
        x: shell.door.x,
        y: level.groundY,
        z: shell.door.z,
        w: shell.door.w,
        d: 0.35,
        h: shell.door.h,
        rotY: shell.door.rotY,
      })
    }
    for (const prop of shell.props ?? []) {
      place(parent, assets[prop.name], materialFor(prop.name, materials), {
        x: prop.x,
        y: level.groundY,
        z: prop.z,
        w: prop.w,
        d: prop.d,
        h: prop.h,
        rotY: prop.rotY,
      })
    }
  }
}
