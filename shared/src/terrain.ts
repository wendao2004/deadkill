/**
 * 地面起伏：**客户端渲染与服务端 Rapier 共用同一份高度函数/网格**。
 *
 * 为什么不能只做视觉起伏：角色控制器的碰撞必须和看到的坡面一致，否则会
 * 出现"脚下悬空/陷进地面"。所以高度函数放在 shared，渲染用同一份顶点生成
 * 网格，物理用同一份顶点生成 trimesh。
 *
 * 平坦区规则：建筑、出生点、巢穴、线索、撤离点、水边一律压平。这样：
 * - 建筑不会一半悬空一半陷进土里；
 * - 标记点/出生点不会因为地形起伏导致 y 对不上；
 * - 只有真正的野地会出现缓慢的坡与洼地。
 */

import type { LevelDef } from './level.ts'

/** 地面网格分段数；渲染与物理必须用同一个值。 */
export const TERRAIN_SEGMENTS = 64

/** 起伏幅度（米）。再大就会让斜坡战斗变成"爬坡模拟"。 */
const AMPLITUDE = 1.15
/** 距离任何"必须平坦"的物体多远开始起坡 / 完全起坡。 */
const FLAT_RADIUS = 9
const FULL_RADIUS = 24

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 整数哈希：不依赖 Math.sin，客户端/服务端逐位一致。 */
function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz)
  const b = hash2(ix + 1, iz)
  const c = hash2(ix, iz + 1)
  const d = hash2(ix + 1, iz + 1)
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz
}

/** 点到盒刷脚印的距离（旋转盒用外接圆保守估计）。 */
function boxDistance(level: LevelDef, x: number, z: number): number {
  let best = Infinity
  for (const b of level.boxes) {
    if (b.noCollide) continue
    const ex = b.rotY ? Math.hypot(b.hx, b.hz) : b.hx
    const ez = b.rotY ? Math.hypot(b.hx, b.hz) : b.hz
    const dx = Math.max(Math.abs(x - b.x) - ex, 0)
    const dz = Math.max(Math.abs(z - b.z) - ez, 0)
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < best) best = d
  }
  return best
}

function markerDistance(level: LevelDef, x: number, z: number): number {
  let best = Infinity
  const points: { x: number; z: number }[] = [
    ...level.spawns,
    ...(level.nests ?? []),
    ...(level.clues ?? []),
    ...(level.extracts ?? []),
  ]
  for (const p of points) {
    const d = Math.hypot(x - p.x, z - p.z)
    if (d < best) best = d
  }
  return best
}

function waterDistance(level: LevelDef, x: number, z: number): number {
  let best = Infinity
  for (const w of level.water ?? []) {
    const dx = Math.max(Math.abs(x - w.x) - w.hx, 0)
    const dz = Math.max(Math.abs(z - w.z) - w.hz, 0)
    const d = Math.hypot(dx, dz)
    if (d < best) best = d
  }
  return best
}

interface MaskGrid {
  segments: number
  half: number
  step: number
  values: Float32Array
}

/**
 * 平坦度缓存：每张图只遍历一次盒子。
 *
 * 没有缓存时，每个地形顶点（64×64）都要扫一遍 1600 个盒子；一张图几百万次
 * 距离计算，五张图的测试要几十秒。缓存后每张图只算 4225 个格点，之后
 * terrainHeightAt 只做双线性采样。
 */
const MASK_CACHE = new WeakMap<LevelDef, MaskGrid>()

function maskGridFor(level: LevelDef): MaskGrid {
  const cached = MASK_CACHE.get(level)
  if (cached) return cached
  const segments = TERRAIN_SEGMENTS
  const half = level.boundsHalf
  const step = (half * 2) / segments
  const values = new Float32Array((segments + 1) * (segments + 1))
  let i = 0
  for (let iz = 0; iz <= segments; iz++) {
    const z = -half + iz * step
    for (let ix = 0; ix <= segments; ix++) {
      const x = -half + ix * step
      const clear = Math.min(boxDistance(level, x, z), markerDistance(level, x, z), waterDistance(level, x, z))
      values[i++] = smoothstep(FLAT_RADIUS, FULL_RADIUS, clear)
    }
  }
  const grid: MaskGrid = { segments, half, step, values }
  MASK_CACHE.set(level, grid)
  return grid
}

/** 双线性采样平坦度。 */
function maskAt(level: LevelDef, x: number, z: number): number {
  const grid = maskGridFor(level)
  const gx = Math.min(grid.segments, Math.max(0, (x + grid.half) / grid.step))
  const gz = Math.min(grid.segments, Math.max(0, (z + grid.half) / grid.step))
  const ix = Math.min(grid.segments - 1, Math.floor(gx))
  const iz = Math.min(grid.segments - 1, Math.floor(gz))
  const fx = gx - ix
  const fz = gz - iz
  const row = grid.segments + 1
  const a = grid.values[iz * row + ix]!
  const b = grid.values[iz * row + ix + 1]!
  const c = grid.values[(iz + 1) * row + ix]!
  const d = grid.values[(iz + 1) * row + ix + 1]!
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz
}

/**
 * 世界坐标 (x,z) 处的脚底高度。
 *
 * 平坦区返回 level.groundY；野地返回 groundY + 低频起伏。幅度 ±1.15m，
 * 是"能看出是坡、但不会把角色推离路线"的量级。
 */
export function terrainHeightAt(level: LevelDef, x: number, z: number): number {
  const mask = maskAt(level, x, z)
  if (mask <= 0.0001) return level.groundY
  const n1 = valueNoise(x * 0.022, z * 0.022) - 0.5
  const n2 = valueNoise(x * 0.061 + 11.3, z * 0.061 + 7.1) - 0.5
  return level.groundY + (n1 * 2 * 0.85 + n2 * 2 * 0.18) * AMPLITUDE * mask
}

export interface TerrainGrid {
  /** xyz 三元组，世界坐标。 */
  vertices: Float32Array
  /** 三角形索引（Uint32）。 */
  indices: Uint32Array
  /** 世界边长。 */
  size: number
  segments: number
}

/** 生成渲染与物理共用的地面网格。 */
export function buildTerrainGrid(level: LevelDef): TerrainGrid {
  const segments = TERRAIN_SEGMENTS
  const size = level.boundsHalf * 2
  const step = size / segments
  const half = size / 2
  const vertices = new Float32Array((segments + 1) * (segments + 1) * 3)
  let v = 0
  for (let iz = 0; iz <= segments; iz++) {
    const z = -half + iz * step
    for (let ix = 0; ix <= segments; ix++) {
      const x = -half + ix * step
      vertices[v++] = x
      vertices[v++] = terrainHeightAt(level, x, z)
      vertices[v++] = z
    }
  }

  const indices = new Uint32Array(segments * segments * 6)
  let i = 0
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * (segments + 1) + ix
      const b = a + 1
      const c = a + (segments + 1)
      const d = c + 1
      // 逆时针朝上（y 轴正向）。
      indices[i++] = a
      indices[i++] = c
      indices[i++] = b
      indices[i++] = b
      indices[i++] = c
      indices[i++] = d
    }
  }
  return { vertices, indices, size, segments }
}
