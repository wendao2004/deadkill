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
): void {
  const biome = level.biome ?? 'swamp'
  const rng = mulberry32(0xb17e5eed ^ hashString(level.id))
  const groundY = level.groundY
  const heightAt = (x: number, z: number): number => terrainHeightAt(level, x, z)

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

  const base =
    biome === 'swamp' ? { grass: 1100, rock: 70, branch: 140, stump: 50, bush: 260, plant: 180 }
    : biome === 'farm' ? { grass: 760, rock: 50, branch: 70, stump: 36, bush: 160, plant: 100 }
    : biome === 'church' ? { grass: 360, rock: 90, branch: 40, stump: 24, bush: 80, plant: 60 }
    : biome === 'quarry' ? { grass: 160, rock: 220, branch: 26, stump: 18, bush: 30, plant: 30 }
    // 松林营地用自己那套程序化 GLB（generated-assets.ts），这张表只是兜底：
    // 万一 GLB 全部加载失败，仍然有一层能看的植被，不会剩下一张光秃秃的地面。
    : biome === 'forest' ? { grass: 900, rock: 40, branch: 60, stump: 30, bush: 60, plant: 40 }
    : { grass: 260, rock: 80, branch: 30, stump: 20, bush: 50, plant: 50 }
  const area = Math.min(2.2, Math.max(0.7, ((level.boundsHalf * 2) / 260) ** 2))
  const factor = density * area

  const grassSpots = scatter(Math.round(base.grass * factor), level.boundsHalf, rng, (x, z) =>
    !insideSolid(level, x, z, 0.12),
  )
  addInstances(
    parent,
    assets.grass,
    grassSpots.map((p) => ({
      x: p.x,
      y: heightAt(p.x, p.z),
      z: p.z,
      height: 0.35 + rng() * 0.45,
      rotY: rng() * TAU,
      width: 0.8 + rng() * 0.55,
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
