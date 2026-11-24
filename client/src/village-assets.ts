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
  /** 四道墙的**内皮**：房间真正的净空。由贴边的墙段自己算出来，不假设墙厚。 */
  innerMinX: number
  innerMaxX: number
  innerMinZ: number
  innerMaxZ: number
}

function measureWalls(level: LevelDef, shell: BuildingShell): WallFootprint | null {
  const hw = shell.w / 2
  const hd = shell.d / 2
  type Brush = (typeof level.boxes)[number]
  const groups = new Map<
    number,
    { len: number; minX: number; maxX: number; minZ: number; maxZ: number; boxes: Brush[] }
  >()
  for (const b of level.boxes) {
    if (b.noCollide || b.noRender) continue
    // 墙段至少一人多高；矮盒子是箱子和台阶。
    if (b.hy < 1.0) continue
    if (Math.abs(b.x - shell.x) > hw || Math.abs(b.z - shell.z) > hd) continue
    const top = b.y + b.hy
    if (top < level.groundY + 1.8) continue
    // 5cm 量化：地图里同一面墙的分段高度一致，不会被浮点误差拆成两组。
    const key = Math.round(top * 20) / 20
    const entry = groups.get(key) ?? { len: 0, minX: b.x, maxX: b.x, minZ: b.z, maxZ: b.z, boxes: [] }
    entry.boxes.push(b)
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
  // 内皮：只认**顺着这一面墙躺着**的墙段，取它的内侧表面。
  //
  // 判据必须是"这条墙段的薄轴在哪"，不能是"它离轮廓边多远"：转角处的横墙
  // 从 x=minX 起步，用距离判定会把它也算成左墙，于是左墙内皮被拉到 3m 里侧
  // （第一版就是这样，量出来的房间只有 6×5.6m，而且七栋里只识别出一栋）。
  // 薄轴在 x 的才是左右墙，薄轴在 z 的才是前后墙。
  const tol = 0.06
  let innerMinX = -Infinity
  let innerMaxX = Infinity
  let innerMinZ = -Infinity
  let innerMaxZ = Infinity
  for (const b of g.boxes) {
    if (b.hx < b.hz) {
      if (Math.abs(b.x - b.hx - g.minX) <= tol) innerMinX = Math.max(innerMinX, b.x + b.hx)
      else if (Math.abs(b.x + b.hx - g.maxX) <= tol) innerMaxX = Math.min(innerMaxX, b.x - b.hx)
    } else {
      if (Math.abs(b.z - b.hz - g.minZ) <= tol) innerMinZ = Math.max(innerMinZ, b.z + b.hz)
      else if (Math.abs(b.z + b.hz - g.maxZ) <= tol) innerMaxZ = Math.min(innerMaxZ, b.z - b.hz)
    }
  }
  // 量不出来（屋里没有一条贴边的墙段）就退回外轮廓往里收 0.4。
  if (!Number.isFinite(innerMinX)) innerMinX = g.minX + 0.4
  if (!Number.isFinite(innerMaxX)) innerMaxX = g.maxX - 0.4
  if (!Number.isFinite(innerMinZ)) innerMinZ = g.minZ + 0.4
  if (!Number.isFinite(innerMaxZ)) innerMaxZ = g.maxZ - 0.4
  return {
    top: best.top,
    minX: g.minX,
    maxX: g.maxX,
    minZ: g.minZ,
    maxZ: g.maxZ,
    innerMinX,
    innerMaxX,
    innerMinZ,
    innerMaxZ,
  }
}

/** 一个可以被"室内变暗"识别的空腔（轴对齐盒子，世界坐标）。 */
export interface InteriorVolume {
  x: number
  z: number
  halfX: number
  halfZ: number
  y0: number
  y1: number
}

/**
 * 每栋房子的房间净空。
 *
 * `ink.ts` 拿它把"盒子内部"的片元压暗：toon 材质没有遮挡，任何进了屋的光
 * 都还是满强度的天空色，于是从门口/窗口望进去是一间被天光照满的空房 —— 这是
 * 全景截图里最贵的一处穿帮（一扇开着的门，里面亮得像走廊）。
 */
export function interiorVolumes(level: LevelDef): InteriorVolume[] {
  const shells = SHELLS[level.id]
  if (!shells) return []
  const out: InteriorVolume[] = []
  for (const shell of shells) {
    const walls = measureWalls(level, shell)
    if (!walls) continue
    const halfX = (walls.innerMaxX - walls.innerMinX) / 2
    const halfZ = (walls.innerMaxZ - walls.innerMinZ) / 2
    // 净空小于 2m 就当没量准（对角墙段互相咬掉了），宁可这栋不变暗。
    if (halfX < 1 || halfZ < 1) continue
    out.push({
      x: (walls.innerMinX + walls.innerMaxX) / 2,
      z: (walls.innerMinZ + walls.innerMaxZ) / 2,
      // 净空要往外**胀**一点，这一点是这套判据的关键：
      //
      // 房间的墙内表面正好落在净空边界上，而 shader 里的判据是"严格在盒子里"
      // （`m < 0`）。边界上的片元 m 恰好等于 0，于是每一面墙、连地板一起，
      // 全部被判成"在盒子外面"——量出来的体积一点用都没有。第一版就是这样：
      // 七栋房子一个都没变暗，而我还以为是片元太暗看不出来。
      // 胀 6cm 之后，墙内表面进到盒子里 6cm（墙厚 40cm，外表面还在外面 34cm），
      // 地板从 y0 抬到 12cm 之下。
      halfX: halfX + 0.06,
      halfZ: halfZ + 0.06,
      y0: level.groundY - 0.12,
      y1: walls.top + 0.05,
    })
  }
  return out
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
 * 绕门侧铰链摆开的构件（门扇/门带）。
 *
 * `hx/hy/hz` 是铰链在门局部坐标里的位置，`side` 说明铰链在门宽的哪一侧，
 * `reach` 是构件中心离铰链的距离（沿关闭状态的门扇方向）。整扇门所以能拆成
 * 十几个盒子还保持刚体，是因为它们共用同一个铰链点和同一个 `swing`。
 */
function pushSwung(
  list: BufferGeometry[],
  b: DoorBasis,
  sx: number,
  sy: number,
  sz: number,
  hx: number,
  hy: number,
  hz: number,
  side: number,
  swing: number,
  reach: number,
): void {
  const geo = new BoxGeometry(sx, sy, sz)
  // 几何原点挪到铰链端，构件沿 -side*X 伸出去。
  geo.translate(-side * reach, 0, 0)
  // 绕 Y 摆向屋内：局部 -X 端的自由边要转到 -Z（法线反方向）。
  geo.rotateY(-swing * side)
  geo.rotateY(b.theta)
  geo.translate(b.fx + b.tx * hx + b.nx * hz, hy, b.fz + b.tz * hx + b.nz * hz)
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

  // ---- 门扇：以一侧为铰链**摆开**的五块竖板 + 背板 + 两道铁带 ----
  //
  // 门洞在关卡碰撞里是通的（2.4m 宽、整高 3.2m，没有碰撞体），所以门扇不能
  // 关在洞口上：关着看起来像一扇卷帘门，而玩家又能直接穿过去 —— 看到的和能做
  // 的对不上，是比"没有门"更糟的一种假。整扇门绕铰链摆开 100°，门洞保持通畅，
  // 玩家的判断（"这扇门开着，能进"）和碰撞一致，顺带把屋内的暗部露出来。
  const planks = 5
  const gap = 0.014
  const plankW = (leafW - gap * (planks - 1)) / planks
  const hingeSide = 1
  // 铰链在门宽的一侧、门扇平面所在的进深处。
  const hingeU = leafW / 2 + 0.03
  const swing = 1.75
  const leaf = (list: BufferGeometry[], sx: number, sy: number, sz: number, reach: number, dz: number): void => {
    pushSwung(list, b, sx, sy, sz, hingeU, leafY, leafZ + dz, hingeSide, swing, reach)
  }
  // 背板：一整块薄板兜住板缝。少了它，板缝会直接透出被天光照亮的屋内。
  leaf(parts.trim, leafW + 0.04, leafH + 0.02, 0.05, leafW / 2, -0.03)
  for (let i = 0; i < planks; i++) {
    const ux = -leafW / 2 + plankW / 2 + i * (plankW + gap)
    leaf(parts.door, plankW, leafH, 0.06, hingeU - ux, 0.02)
  }

  // ---- 铁门带：两道横带，给门扇一条尺度和材质对比 ----
  // 它们跟着门扇一起摆 —— 门开了而铁带还留在洞口平面上，是最容易被看出假的。
  for (const ratio of [0.3, 0.72]) {
    pushSwung(
      parts.metal,
      b,
      leafW + 0.1,
      0.11,
      0.03,
      hingeU,
      groundY + 0.06 + leafH * ratio,
      leafZ + 0.07,
      hingeSide,
      swing,
      leafW / 2,
    )
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

/**
 * 关卡自带的落地门廊：两根方柱 + 一块平板顶。
 *
 * 世界坐标不变，只在门局部坐标里把柱子找出来 —— 它们是关卡盒刷，不在
 * SHELLS 表里。判据：贴地、2m 以上、两个水平方向都细（方柱）、并且落在门口
 * 正前方 0.2–4m 的范围内。
 */
function measurePorchPosts(
  level: LevelDef,
  b: DoorBasis,
  door: { w: number },
  groundY: number,
): { ux: number; uz: number; top: number }[] {
  const out: { ux: number; uz: number; top: number }[] = []
  for (const brush of level.boxes) {
    if (brush.noCollide || brush.noRender) continue
    // 方柱：两个水平尺寸都小于 0.7m。墙体总有一个方向超过 1m。
    if (brush.hx * 2 > 0.7 || brush.hz * 2 > 0.7) continue
    const bottom = brush.y - brush.hy
    const top = brush.y + brush.hy
    if (bottom > groundY + 0.35) continue
    if (top < groundY + 2.0) continue
    const dx = brush.x - b.fx
    const dz = brush.z - b.fz
    const uz = dx * b.nx + dz * b.nz
    const ux = dx * b.tx + dz * b.tz
    if (uz < 0.25 || uz > 4) continue
    if (Math.abs(ux) > door.w / 2 + 3.5) continue
    out.push({ ux, uz, top })
  }
  return out.sort((p, q) => p.ux - q.ux)
}

/**
 * 门廊的"木构关系"。
 *
 * 关卡给的是一块平板顶 + 两根 40cm 见方的柱子，远看就是一座混凝土车棚 ——
 * 玩家不会觉得那是"这栋房子的前廊"。补两样东西，它立刻变成木结构：
 *
 * - 柱顶的**过梁**（横跨两根柱子、压在柱顶上），顶板终于有了"被什么撑住"的交代；
 * - 柱脚的**石础**，把柱子和地面分开，柱子不再像直接插进土里。
 *
 * 只在真的量到两根柱子时才加：只有一根（或零根）的时候宁可什么都不做，
 * 也不要拿假定坐标造一根悬空的梁。
 */
function buildPorchFrame(
  parts: FacadeParts,
  b: DoorBasis,
  posts: { ux: number; uz: number; top: number }[],
  groundY: number,
): void {
  if (posts.length === 0) return
  for (const post of posts) {
    pushOriented(parts.stone, b, 0.52, 0.42, 0.52, post.ux, groundY + 0.21, post.uz)
  }
  if (posts.length < 2) return
  const left = posts[0]!
  const right = posts[posts.length - 1]!
  const span = Math.abs(right.ux - left.ux) + 0.52
  const midUx = (left.ux + right.ux) / 2
  const top = Math.min(left.top, right.top)
  // 过梁压在柱顶下沿：柱顶伸进梁里 4cm，看起来才是"柱撑梁"而不是"梁浮在柱上"。
  pushOriented(parts.trim, b, span, 0.26, 0.3, midUx, top - 0.09, (left.uz + right.uz) / 2)
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
  // 棚底封板。
  //
  // 出檐的底面朝下，只能吃到天空的漫反射，一块中等明度的石板会在这里被洗成
  // 一条发白的浅灰带 —— 从门廊下往上看，"棚顶"反而比墙更亮，整个披檐立刻
  // 变成一张白纸。封一层深色木板之后，底面读成背光，棚檐才立得住。主屋顶
  // 的檐下封板是同一个问题、同一个解法。
  pushOriented(parts.trim, b, door.w + 1.4, 0.06, depth, 0, centerY - 0.09, centerZ, pitch)
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
        // 关卡自带的落地门廊（方柱 + 平板顶）补上过梁与石础。
        buildPorchFrame(parts, basis, measurePorchPosts(level, basis, shell.door, level.groundY), level.groundY)
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
