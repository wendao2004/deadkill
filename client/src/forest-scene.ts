/**
 * 松林营地的视觉铺装：把程序化 GLB 摆进关卡。
 *
 * 摆放规则只有三条：
 * 1. **建筑用 heroes 锚点**（来自 LevelDef，和碰撞盒同一份数据）；
 * 2. **树按树冠盒子定位** —— 关卡里的树干盒子负责碰撞与断视线，模型只是
 *    长在那个盒子上，所以视觉与判定永远不会漂移；
 * 3. **草/石头/树桩按地形撒**，并且避开所有实心盒子与水面，否则会出现
 *    "草从墙里长出来"这种最廉价的可疑感。
 *
 * 这个模块刻意不认识渲染器：输入是 LevelDef 与资产表，输出是一棵 Group。
 */

import { Group, type Object3D } from 'three'
import { terrainHeightAt, type LevelDef } from '@dk/shared'
import type { GeneratedAssets, Placement } from './generated-assets.ts'
import { instanceAsset } from './generated-assets.ts'

/** 与 shared/src/maps/kit.ts 同源的确定性随机（这张图的两个端都要能复现）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash2(x: number, z: number): number {
  let h = Math.imul(Math.round(x * 10) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(z * 10) | 0, 0x165667b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return h >>> 0
}

/** 点是否落在实心盒子的脚印里（旋转盒子用外接圆，宁可多避一点）。 */
function insideSolid(level: LevelDef, x: number, z: number, margin: number): boolean {
  for (const b of level.boxes) {
    if (b.noCollide) continue
    const ex = (b.rotY ? Math.hypot(b.hx, b.hz) : b.hx) + margin
    const ez = (b.rotY ? Math.hypot(b.hx, b.hz) : b.hz) + margin
    if (x > b.x - ex && x < b.x + ex && z > b.z - ez && z < b.z + ez) return true
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
  level: LevelDef,
  rng: () => number,
  accept: (x: number, z: number) => boolean,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []
  const limit = level.boundsHalf - 3
  for (let attempt = 0; attempt < count * 8 && out.length < count; attempt++) {
    const x = (rng() * 2 - 1) * limit
    const z = (rng() * 2 - 1) * limit
    if (accept(x, z)) out.push({ x, z })
  }
  return out
}

/** 三个"体型"不同的松树，按位置哈希挑，避免一眼看出复制粘贴。 */
const PINES = ['pine_a', 'pine_b', 'pine_dead'] as const

export function decoratePineCamp(parent: Object3D, level: LevelDef, assets: GeneratedAssets): boolean {
  if (assets.size === 0) return false
  const rng = mulberry32(0x9e3779b9 ^ ((level.boundsHalf * 131) | 0))
  const root = new Group()
  root.name = 'generated-forest'
  let placed = 0

  // ---- 1. 主角资产：建筑、篝火、原木堆、路灯 ----
  const byAsset = new Map<string, Placement[]>()
  for (const h of level.heroes ?? []) {
    const list = byAsset.get(h.asset) ?? []
    list.push({ x: h.x, z: h.z, y: level.groundY, rotY: h.rotY ?? 0, scale: h.scale ?? 1 })
    byAsset.set(h.asset, list)
  }
  for (const [name, list] of byAsset) {
    const asset = assets.get(name)
    if (!asset) {
      console.warn(`[generated] 缺少资产 ${name}，跳过 ${list.length} 个锚点`)
      continue
    }
    // 篝火/路灯是发光体，不投阴影；建筑和原木堆要投。
    const light = asset.tags.includes('light')
    instanceAsset(root, asset, list, { chunk: 0, castShadow: !light, receiveShadow: true })
    placed += list.length
  }

  // ---- 2. 树：定位来自树冠盒子 ----
  const trees: Record<(typeof PINES)[number], Placement[]> = {
    pine_a: [],
    pine_b: [],
    pine_dead: [],
  }
  for (const b of level.boxes) {
    if (b.material !== 'foliage' || b.hy < 1.2 || b.y < level.groundY + 2) continue
    const crownTop = b.y + b.hy
    const y = terrainHeightAt(level, b.x, b.z)
    const height = Math.min(18, Math.max(3.4, crownTop - y))
    const dead = b.x < -30 && b.z > 12 // 烧焦林整片枯木
    const asset = assets.get(dead ? 'pine_dead' : PINES[hash2(b.x, b.z) % 2]!)
    if (!asset) continue
    const scale = Math.min(1.8, Math.max(0.45, height / asset.size.y))
    const tint = dead ? 0xffffff : hash2(b.x, b.z) % 3 === 0 ? 0xf0f8e6 : 0xffffff
    trees[dead ? 'pine_dead' : PINES[hash2(b.x, b.z) % 2]!].push({
      x: b.x + (rng() - 0.5) * 0.5,
      z: b.z + (rng() - 0.5) * 0.5,
      y,
      rotY: rng() * Math.PI * 2,
      scale,
      tint,
    })
  }
  for (const [name, list] of Object.entries(trees)) {
    const asset = assets.get(name)
    if (!asset || list.length === 0) continue
    instanceAsset(root, asset, list, { chunk: 64, castShadow: true, receiveShadow: true })
    placed += list.length
  }

  // ---- 3. 草：贴地撒，避开墙、水、树桩 ----
  const grassAsset = assets.get('grass_clump')
  if (grassAsset) {
    const spots = scatter(1700, level, rng, (x, z) => !insideSolid(level, x, z, 0.1) && !insideWater(level, x, z))
    const placements: Placement[] = spots.map((p) => ({
      x: p.x,
      z: p.z,
      y: terrainHeightAt(level, p.x, p.z) - 0.02,
      rotY: rng() * Math.PI * 2,
      scale: 0.75 + rng() * 0.75,
      tint: rng() < 0.35 ? 0xe4efd2 : 0xffffff,
    }))
    instanceAsset(root, grassAsset, placements, { chunk: 64, castShadow: false, receiveShadow: true })
    placed += placements.length
  }

  // ---- 4. 石头与树桩：稀疏点缀，避免整张图只有树和草 ----
  const rockAsset = assets.get('rock_a')
  if (rockAsset) {
    const spots = scatter(26, level, rng, (x, z) => !insideSolid(level, x, z, 0.6) && !insideWater(level, x, z))
    instanceAsset(
      root,
      rockAsset,
      spots.map((p) => ({
        x: p.x,
        z: p.z,
        y: terrainHeightAt(level, p.x, p.z),
        rotY: rng() * Math.PI * 2,
        scale: 0.45 + rng() * 0.7,
      })),
      { chunk: 64 },
    )
    placed += spots.length
  }
  const stumpAsset = assets.get('stump')
  if (stumpAsset) {
    const spots = scatter(30, level, rng, (x, z) => !insideSolid(level, x, z, 0.5) && !insideWater(level, x, z))
    instanceAsset(
      root,
      stumpAsset,
      spots.map((p) => ({
        x: p.x,
        z: p.z,
        y: terrainHeightAt(level, p.x, p.z),
        rotY: rng() * Math.PI * 2,
        scale: 0.7 + rng() * 0.6,
      })),
      { chunk: 64 },
    )
    placed += spots.length
  }

  parent.add(root)
  return placed > 0
}
