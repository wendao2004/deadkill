/**
 * CC0 低模自然资产：枯树、草、岩石、枯枝、灌木、植物、树桩。
 *
 * 来源：Quaternius Ultimate Stylized Nature Pack（CC0），FBX 单文件只有
 * 20–180KB；每棵几十到几百个三角形。之前用 Poly Haven 的高模贴图模型，
 * 900 丛草就让一帧涨到 2860 万三角形 —— 高模不能实例化。
 *
 * 只做三件事：
 * 1. 启动时并行加载 FBX 与少量小贴图；
 * 2. 按关卡盒子的树冠位置 / 群系撒实例（InstancedMesh，按模型子网格分批）；
 * 3. 纯视觉 —— 不生成碰撞体。树干/树冠的判定仍然来自 level.boxes。
 */

import {
  Box3,
  BufferAttribute,
  DoubleSide,
  Euler,
  FrontSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  StaticDrawUsage,
  TextureLoader,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { terrainHeightAt, type LevelDef } from '@dk/shared'
import { tintInstances } from './procedural-tint.ts'

export type NatureKind = 'deadTree' | 'grass' | 'rock' | 'branch' | 'stump' | 'bush' | 'plant'

interface ModelPart {
  geometry: BufferGeometry
  material: Material
  /** 子网格在模型世界空间里的变换。 */
  matrix: Matrix4
}

export interface NatureModel {
  parts: ModelPart[]
  /** 模型原始包围盒（归一化到目标高度用）。 */
  box: Box3
}

export type NatureAssets = Partial<Record<NatureKind, NatureModel>>

const FILES: Record<NatureKind, string> = {
  deadTree: 'DeadTree_1',
  grass: 'Grass_Large',
  rock: 'Rock_3',
  branch: 'Petals_1',
  stump: 'DeadTree_5',
  bush: 'Bush_Large',
  plant: 'Plant_1',
}

const TAU = Math.PI * 2

/** 与 shared/maps/kit.ts 同一个 mulberry32；客户端不能直接 import 内部路径。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

interface AssetTextures {
  grass: Texture
  leaves: Texture
  bush: Texture
  flowers: Texture
  rock: Texture
}

export async function loadNatureAssets(): Promise<NatureAssets> {
  const textureBase = new URL('./models/quaternius/textures/', document.baseURI)
  const textureLoader = new TextureLoader()
  const loadTexture = async (name: string): Promise<Texture> => {
    const texture = await textureLoader.loadAsync(new URL(name, textureBase).href)
    texture.colorSpace = SRGBColorSpace
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.anisotropy = 4
    return texture
  }

  let textures: AssetTextures | null = null
  try {
    const [grass, leaves, bush, flowers, rock] = await Promise.all([
      loadTexture('Grass.png'),
      loadTexture('Leaves_BW.png'),
      loadTexture('Bush_Leaves.png'),
      loadTexture('Flowers.png'),
      loadTexture('Rocks.png'),
    ])
    textures = { grass, leaves, bush, flowers, rock }
  } catch (error) {
    console.warn('[nature] 低模贴图加载失败，改用纯色材质', error)
  }

  const loader = new FBXLoader()
  const entries = await Promise.all(
    (Object.entries(FILES) as [NatureKind, string][]).map(async ([kind, file]) => {
      try {
        const url = new URL(`./models/quaternius/${file}.fbx`, document.baseURI).href
        const object = await loader.loadAsync(url)
        return [kind, prepare(object, kind, textures)] as const
      } catch (error) {
        console.warn(`[nature] ${file}.fbx 加载失败，保留程序化植被`, error)
        return [kind, null] as const
      }
    }),
  )
  const out: NatureAssets = {}
  for (const [kind, model] of entries) if (model) out[kind] = model
  return out
}

function materialFor(kind: NatureKind, textures: AssetTextures | null): MeshStandardMaterial {
  const common = { metalness: 0, roughness: 0.95, fog: true }
  if (kind === 'rock') {
    return new MeshStandardMaterial({
      ...common,
      color: 0xffffff,
      map: textures?.rock ?? null,
      roughness: 0.9,
      side: FrontSide,
    })
  }
  if (kind === 'grass') {
    return new MeshStandardMaterial({
      ...common,
      color: 0xffffff,
      map: textures?.grass ?? null,
      alphaTest: textures ? 0.42 : 0,
      side: DoubleSide,
    })
  }
  if (kind === 'bush') {
    return new MeshStandardMaterial({
      ...common,
      color: 0xffffff,
      map: textures?.bush ?? null,
      alphaTest: textures ? 0.42 : 0,
      side: DoubleSide,
    })
  }
  if (kind === 'branch' || kind === 'plant') {
    return new MeshStandardMaterial({
      ...common,
      color: 0xffffff,
      map: (kind === 'branch' ? textures?.flowers : textures?.leaves) ?? null,
      alphaTest: textures ? 0.42 : 0,
      side: DoubleSide,
    })
  }
  // 枯树/树桩：树皮贴图是 20MB 级，直接用低饱和树皮色更划算。
  return new MeshStandardMaterial({ ...common, color: 0x4a3a2c, roughness: 0.88 })
}

function prepare(object: Group, kind: NatureKind, textures: AssetTextures | null): NatureModel {
  object.updateMatrixWorld(true)
  const box = new Box3().setFromObject(object)
  const material = materialFor(kind, textures)
  const parts: ModelPart[] = []
  object.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    mesh.material = material
    ensureUv(mesh.geometry)
    parts.push({ geometry: mesh.geometry, material, matrix: mesh.matrixWorld.clone() })
  })
  return { parts, box }
}

interface Placement {
  x: number
  z: number
  y?: number
  /** 目标高度（米）。模型会按包围盒高度等比缩放到它。 */
  height: number
  rotY: number
  tiltX?: number
  tiltZ?: number
  /** 水平尺度额外倍率（岩石/草可以更扁）。 */
  width?: number
}

/**
 * 给没有 UV 的资产补平面投影 UV。
 *
 * `Grass_Large.fbx` 是唯一一份没有 uv 属性的资产。属性缺失时 three 仍然会
 * 编一张采样器进去 —— 每个片元都按 (0,0) 取色，于是整丛草被烘成一个**纯色**。
 * 近景那根"荧光绿小棍"就是这么来的：不是模型坏了，是它一直在取贴图左上角
 * 的那一个像素。
 *
 * 投影方式按面朝向选轴（叶片是竖直薄片，水平法线朝外），u 取叶片宽度方向、
 * v 取高度方向，草叶就能从根部到梢部读出明暗与色差。
 */
function ensureUv(geometry: BufferGeometry): void {
  if (geometry.attributes.uv) return
  const pos = geometry.attributes.position
  const nor = geometry.attributes.normal
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) return
  const sx = Math.max(0.001, box.max.x - box.min.x)
  const sy = Math.max(0.001, box.max.y - box.min.y)
  const sz = Math.max(0.001, box.max.z - box.min.z)
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const x = (pos.getX(i) - box.min.x) / sx
    const z = (pos.getZ(i) - box.min.z) / sz
    const y = (pos.getY(i) - box.min.y) / sy
    // 法线朝 X 的薄片沿 Z 展开，朝 Z 的沿 X 展开。
    const nx = nor ? Math.abs(nor.getX(i)) : 0
    const nz = nor ? Math.abs(nor.getZ(i)) : 1
    uv[i * 2] = nx > nz ? z : x
    uv[i * 2 + 1] = y
  }
  geometry.setAttribute('uv', new BufferAttribute(uv, 2))
}

function addInstances(
  parent: Group,
  model: NatureModel | undefined,
  placements: readonly Placement[],
  kind: NatureKind,
): void {
  if (!model || placements.length === 0) return
  const modelHeight = Math.max(0.001, model.box.max.y - model.box.min.y)
  const minY = model.box.min.y
  const position = new Vector3()
  const scale = new Vector3()
  const quat = new Quaternion()
  const euler = new Euler()
  const placement = new Matrix4()
  const normalize = new Matrix4()
  const scratch = new Matrix4()

  for (const part of model.parts) {
    const mesh = new InstancedMesh(part.geometry, part.material, placements.length)
    mesh.instanceMatrix.setUsage(StaticDrawUsage)
    mesh.castShadow = kind !== 'grass' && kind !== 'plant'
    mesh.receiveShadow = true
    mesh.frustumCulled = false

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!
      const s = p.height / modelHeight
      const w = s * (p.width ?? 1)
      position.set(p.x, p.y ?? 0, p.z)
      euler.set(p.tiltX ?? 0, p.rotY, p.tiltZ ?? 0, 'YXZ')
      quat.setFromEuler(euler)
      scale.set(w, s, w)
      placement.compose(position, quat, scale)
      // 先平移到模型包围盒底部（让脚贴地），再套子网格自己的变换。
      normalize.makeTranslation(0, -minY, 0)
      scratch.multiplyMatrices(placement, normalize)
      scratch.multiply(part.matrix)
      mesh.setMatrixAt(i, scratch)
    }
    mesh.instanceMatrix.needsUpdate = true
    // 同一批 GLB 树/石头也各有新旧色差；用实例序号哈希，不消耗布局 rng。
    tintInstances(
      mesh,
      placements.length,
      kind === 'grass' || kind === 'plant' ? 0.14 : 0.10,
      kind === 'grass' || kind === 'plant' ? 0.06 : 0.04,
    )
    parent.add(mesh)
  }
}

/** 点是否落在一个实心盒的脚印里（旋转盒用外接圆保守估计）。 */
function insideSolid(level: LevelDef, x: number, z: number, margin: number): boolean {
  for (const b of level.boxes) {
    if (b.noCollide) continue
    const ex = b.rotY ? Math.hypot(b.hx, b.hz) : b.hx
    const ez = b.rotY ? Math.hypot(b.hx, b.hz) : b.hz
    if (
      x > b.x - ex - margin &&
      x < b.x + ex + margin &&
      z > b.z - ez - margin &&
      z < b.z + ez + margin
    ) {
      return true
    }
  }
  return false
}

function insideWater(level: LevelDef, x: number, z: number): boolean {
  for (const w of level.water ?? []) {
    if (x > w.x - w.hx && x < w.x + w.hx && z > w.z - w.hz && z < w.z + w.hz) return true
  }
  return false
}

function scatter(
  count: number,
  boundsHalf: number,
  rng: () => number,
  accept: (x: number, z: number) => boolean,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []
  const limit = boundsHalf - 3
  for (let attempt = 0; attempt < count * 6 && out.length < count; attempt++) {
    const x = (rng() * 2 - 1) * limit
    const z = (rng() * 2 - 1) * limit
    if (accept(x, z)) out.push({ x, z })
  }
  return out
}

/** 按群系撒植被。返回根节点；调用方负责它和程序化植被的互斥。 */
export function scatterNature(
  parent: Group,
  level: LevelDef,
  assets: NatureAssets,
  density = 1,
  /** 是否用 CC0 枯树。程序化松树接管后传 false，避免两套树叠在一起。 */
  withTrees = true,
): void {
  const biome = level.biome ?? 'swamp'
  const rng = mulberry32(0xb17e5eed ^ hashString(level.id))
  const groundY = level.groundY
  const heightAt = (x: number, z: number): number => terrainHeightAt(level, x, z)

  if (withTrees) {
    // ---- 树：直接用关卡里的树冠盒子定位，保证视觉树和碰撞树干对得上 ----
    const trees: Placement[] = []
    for (const b of level.boxes) {
      if (b.material !== 'foliage' || b.hy < 1.2 || b.y < groundY + 2) continue
      const crownTop = b.y + b.hy
      trees.push({
        x: b.x,
        y: heightAt(b.x, b.z),
        z: b.z,
        height: Math.min(18, Math.max(3, crownTop - heightAt(b.x, b.z))),
        rotY: rng() * TAU,
        width: 0.9 + rng() * 0.3,
      })
    }
    // 枯树为主：这张图的方向是"沼泽里剩下的死树"，不是明亮森林。
    addInstances(parent, assets.deadTree, trees, 'deadTree')
  }

  const base =
    biome === 'swamp' ? { grass: 2600, rock: 520, branch: 340, stump: 90, bush: 380, plant: 260 }
    : biome === 'farm' ? { grass: 1500, rock: 240, branch: 140, stump: 50, bush: 200, plant: 140 }
    : biome === 'church' ? { grass: 620, rock: 220, branch: 70, stump: 32, bush: 100, plant: 80 }
    : biome === 'quarry' ? { grass: 240, rock: 420, branch: 34, stump: 22, bush: 36, plant: 36 }
    // 松林营地用自己那套程序化 GLB（generated-assets.ts），这张表只是兜底：
    // 万一 GLB 全部加载失败，仍然有一层能看的植被，不会剩下一张光秃秃的地面。
    : biome === 'forest' ? { grass: 1400, rock: 150, branch: 80, stump: 36, bush: 80, plant: 56 }
    : { grass: 380, rock: 180, branch: 40, stump: 24, bush: 60, plant: 60 }
  const area = Math.min(2.2, Math.max(0.7, ((level.boundsHalf * 2) / 260) ** 2))
  const factor = density * area

  // 草**成片长**，不撒胡椒面。
  //
  // 均匀撒 1100 簇在 260×260m 上等于每 10m 半径只有 5 簇 —— 玩家站在空地上
  // 往脚下看，一米之内一根草都没有，地面就只剩一张贴图。真正能读出来的草是
  // "一片一片"的：先找草窝，每个草窝 8~20 簇，占总量七成，剩下三成均匀撒在
  // 空地之间。总数不变，近处可见的草多了三倍。
  const total = Math.round(base.grass * factor)
  const patchCount = Math.max(1, Math.round(total / 16))
  const patchCenters = scatter(patchCount, level.boundsHalf, rng, (x, z) =>
    !insideSolid(level, x, z, 0.5) && !insideWater(level, x, z),
  )
  const grassSpots = scatter(Math.round(total * 0.3), level.boundsHalf, rng, (x, z) =>
    !insideSolid(level, x, z, 0.12) && !insideWater(level, x, z),
  )
  for (const center of patchCenters) {
    const n = 8 + Math.floor(rng() * 12)
    for (let i = 0; i < n; i++) {
      const radius = 1.2 + rng() * 3.4
      const angle = rng() * TAU
      const x = center.x + Math.cos(angle) * radius
      const z = center.z + Math.sin(angle) * radius
      if (insideSolid(level, x, z, 0.12) || insideWater(level, x, z)) continue
      grassSpots.push({ x, z })
    }
  }
  addInstances(
    parent,
    assets.grass,
    grassSpots.map((p) => ({
      x: p.x,
      y: heightAt(p.x, p.z),
      z: p.z,
      height: 0.4 + rng() * 0.5,
      rotY: rng() * TAU,
      width: 0.85 + rng() * 0.6,
    })),
    'grass',
  )

  const rockSpots = scatter(Math.round(base.rock * factor), level.boundsHalf, rng, (x, z) =>
    !insideSolid(level, x, z, 0.5) && !insideWater(level, x, z),
  )
  addInstances(
    parent,
    assets.rock,
    rockSpots.map((p) => ({
      x: p.x,
      y: heightAt(p.x, p.z),
      z: p.z,
      height: 0.18 + rng() * 0.42,
      rotY: rng() * TAU,
      width: 0.8 + rng() * 0.6,
    })),
    'rock',
  )

  const branchSpots = scatter(Math.round(base.branch * factor), level.boundsHalf, rng, (x, z) =>
    !insideSolid(level, x, z, 0.3),
  )
  addInstances(
    parent,
    assets.branch,
    branchSpots.map((p) => ({
      x: p.x,
      y: heightAt(p.x, p.z),
      z: p.z,
      height: 0.35 + rng() * 0.65,
      rotY: rng() * TAU,
      tiltX: (rng() - 0.5) * 0.35,
      tiltZ: (rng() - 0.5) * 0.35,
    })),
    'branch',
  )

  const stumpSpots = scatter(Math.round(base.stump * factor), level.boundsHalf, rng, (x, z) =>
    !insideSolid(level, x, z, 0.4),
  )
  addInstances(
    parent,
    assets.stump,
    stumpSpots.map((p) => ({
      x: p.x,
      y: heightAt(p.x, p.z),
      z: p.z,
      height: 0.45 + rng() * 0.7,
      rotY: rng() * TAU,
    })),
    'stump',
  )

  const bushSpots = scatter(Math.round(base.bush * factor), level.boundsHalf, rng, (x, z) =>
    !insideSolid(level, x, z, 0.35),
  )
  addInstances(
    parent,
    assets.bush,
    bushSpots.map((p) => ({
      x: p.x,
      y: heightAt(p.x, p.z),
      z: p.z,
      height: 0.5 + rng() * 0.8,
      rotY: rng() * TAU,
      width: 0.85 + rng() * 0.35,
    })),
    'bush',
  )

  const plantSpots = scatter(Math.round(base.plant * factor), level.boundsHalf, rng, (x, z) =>
    !insideSolid(level, x, z, 0.2),
  )
  addInstances(
    parent,
    assets.plant,
    plantSpots.map((p) => ({
      x: p.x,
      y: heightAt(p.x, p.z),
      z: p.z,
      height: 0.3 + rng() * 0.5,
      rotY: rng() * TAU,
    })),
    'plant',
  )
}
