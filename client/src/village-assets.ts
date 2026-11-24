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

/**
 * 立面构件：檐板一圈、四根角柱、石砌踢脚。
 *
 * 这三样是"这是一栋房子"最便宜的信息量 —— 纯色盒子缺少的是**交接线**：
 * 墙和屋顶怎么接、墙角和墙面怎么分、墙和地怎么站住。它们都不跨门窗洞口，
 * 所以不需要知道洞口位置，也就不会出现"钉在窗户上的横梁"。
 */
function buildFacade(
  parent: Group,
  walls: WallFootprint,
  groundY: number,
  materials: VillageMaterials,
): void {
  const woodParts: BufferGeometry[] = []
  const stoneParts: BufferGeometry[] = []
  const cx = (walls.minX + walls.maxX) / 2
  const cz = (walls.minZ + walls.maxZ) / 2
  const spanX = walls.maxX - walls.minX
  const spanZ = walls.maxZ - walls.minZ
  if (spanX < 1 || spanZ < 1) return
  const top = walls.top
  const height = Math.max(0.5, top - groundY)

  // ---- 檐板：贴着墙顶一圈，略外凸 0.06m，替屋顶"坐在墙上"造一条硬阴影线 ----
  const eaveY = top - 0.13
  const eaveT = 0.22
  pushBox(woodParts, cx, eaveY, walls.maxZ + 0.05, spanX + 0.44, eaveT, eaveT)
  pushBox(woodParts, cx, eaveY, walls.minZ - 0.05, spanX + 0.44, eaveT, eaveT)
  pushBox(woodParts, walls.maxX + 0.05, eaveY, cz, eaveT, eaveT, spanZ + 0.44)
  pushBox(woodParts, walls.minX - 0.05, eaveY, cz, eaveT, eaveT, spanZ + 0.44)

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

  for (const [parts, material] of [
    [woodParts, materials.trim],
    [stoneParts, materials.stone],
  ] as const) {
    const merged = mergeGeometries(parts, false)
    for (const geo of parts) geo.dispose()
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
        { name: 'Balcony_Simple_Straight', x: -12.8, z: -1.4, w: 3.4, d: 1.2, h: 1.2 },
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
    if (walls) buildFacade(parent, walls, level.groundY, materials)
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
