import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LEVEL,
  DEFAULT_LEVEL_ID,
  getLevel,
  initPhysics,
  LEVEL_IDS,
  LEVELS,
  type BoxBrush,
  type LevelDef,
} from '../shared/src/index.ts'
import { buildLevelWorld } from '../shared/src/worldbuild.ts'

/**
 * 每张图的盒子上限。
 *
 * 旧值 1100 来自“每盒一个 Mesh + 一条 EdgesGeometry”的时代；现在关卡按材质
 * 合批成 5~6 个 Mesh，盒子数更多只影响 Rapier 的碰撞体数量与生成时间。
 * 1800 是实测能稳住 1080p 60fps 的上限，也是“视觉细节不进 level.boxes”
 * 这条规则的硬闸门 —— 需要更多细节时先考虑客户端视觉壳。
 */
const MAX_BOXES = 1800
/** 角色控制器自动上台阶的高度；可攀爬高差必须严格等于它。 */
const STEP = 0.4
/** 出生点到最近的巢穴/线索的最小距离。 */
const MIN_SPAWN_SAFE = 35
/** 撤离点到地图中心的最小距离。 */
const MIN_EXTRACT_FROM_CENTER = 60
const EPS = 1e-6

const levels = LEVEL_IDS.map((id) => getLevel(id))

/** 所有参与碰撞的盒子（装饰片不算遮挡，也不算墙）。 */
function solid(boxes: BoxBrush[]): BoxBrush[] {
  return boxes.filter((b) => !b.noCollide)
}

function allNumbers(boxes: BoxBrush[]): number[] {
  const out: number[] = []
  for (const b of boxes) out.push(b.x, b.y, b.z, b.hx, b.hy, b.hz, b.rotY ?? 0)
  return out
}

/**
 * 均匀网格加速的遮挡查询：一张图有近千个盒子，逐盒遍历会让
 * "每张图 144 个方向 × 数百步"变成千万级判定。
 */
const CELL = 8
function makeGrid(boxes: BoxBrush[]): Map<string, BoxBrush[]> {
  const grid = new Map<string, BoxBrush[]>()
  for (const b of boxes) {
    // 旋转盒子用外接圆半径扩张成轴对齐包围盒，宁可多算一格也不漏
    const r = b.rotY ? Math.hypot(b.hx, b.hz) : 0
    const x0 = Math.floor((b.x - b.hx - r) / CELL)
    const x1 = Math.floor((b.x + b.hx + r) / CELL)
    const z0 = Math.floor((b.z - b.hz - r) / CELL)
    const z1 = Math.floor((b.z + b.hz + r) / CELL)
    for (let i = x0; i <= x1; i++) {
      for (let k = z0; k <= z1; k++) {
        const key = `${i}:${k}`
        const cell = grid.get(key)
        if (cell) cell.push(b)
        else grid.set(key, [b])
      }
    }
  }
  return grid
}

function inside(b: BoxBrush, x: number, y: number, z: number, pad = 0): boolean {
  if (y < b.y - b.hy - EPS || y > b.y + b.hy + EPS) return false
  let dx = x - b.x
  let dz = z - b.z
  if (b.rotY) {
    const c = Math.cos(-b.rotY)
    const s = Math.sin(-b.rotY)
    const rx = dx * c - dz * s
    const rz = dx * s + dz * c
    dx = rx
    dz = rz
  }
  return Math.abs(dx) <= b.hx + pad + EPS && Math.abs(dz) <= b.hz + pad + EPS
}

/** 从 (ox,oz) 沿 (dx,dz) 走，返回第一次被挡住的水平距离（没挡住返回 max）。 */
function sightAt(
  grid: Map<string, BoxBrush[]>,
  ox: number,
  oz: number,
  y: number,
  dx: number,
  dz: number,
  max: number,
): number {
  for (let t = 0.5; t < max; t += 0.5) {
    const x = ox + dx * t
    const z = oz + dz * t
    const cell = grid.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`)
    if (!cell) continue
    for (const b of cell) if (inside(b, x, y, z)) return t
  }
  return max
}

test('关卡注册表：LEVELS/LEVEL_IDS/getLevel/DEFAULT_LEVEL 一致', () => {
  assert.ok(levels.length >= 3, '至少三张图')
  assert.equal(new Set(LEVEL_IDS).size, LEVEL_IDS.length, 'id 不能重复')
  assert.ok(getLevel(DEFAULT_LEVEL_ID), '默认 id 必须存在')
  assert.equal(DEFAULT_LEVEL, LEVELS[DEFAULT_LEVEL_ID])
  assert.equal(DEFAULT_LEVEL.id, 'marsh-p0', 'LEVEL_MARSH 的 id 被服务端与客户端引用，不能改')
  assert.ok(LEVELS['marsh-p0'], 'marsh-p0 必须在注册表里')
  assert.throws(() => getLevel('no-such-map'), /未知关卡 id/, '未知 id 必须抛错')
  for (const level of levels) {
    assert.equal(LEVELS[level.id], level, '注册表的键必须等于 level.id')
    assert.ok(level.name.length > 0)
    assert.ok(level.biome, `${level.id} 必须显式给 biome`)
    assert.ok(level.groundMaterial, `${level.id} 必须显式给 groundMaterial`)
    assert.notEqual(level.groundMaterial, 'water' as never, '地面不能是水')
    assert.ok(level.fogDensity > 0 && level.fogDensity < 1, '雾浓度必须合理')
  }
})

test('每张图都能被 buildLevelWorld 建成物理世界，且盒子数在上限内', async () => {
  await initPhysics()
  for (const level of levels) {
    assert.ok(Array.isArray(level.boxes) && level.boxes.length > 0, `${level.id} 没有几何`)
    assert.ok(
      level.boxes.length <= MAX_BOXES,
      `${level.id} 盒子数 ${level.boxes.length} 超过红线 ${MAX_BOXES}`,
    )
    const world = buildLevelWorld(level)
    // 地面 + 每块可碰撞盒子 + 4 道边界墙
    assert.equal(
      world.colliders.len(),
      solid(level.boxes).length + 5,
      `${level.id} 的碰撞体数量对不上`,
    )
    world.free()
  }
})

test('所有数值都不是 NaN/Infinity', () => {
  for (const level of levels) {
    const nums = [
      level.groundY,
      level.boundsHalf,
      level.fogColor,
      level.fogDensity,
      ...allNumbers(level.boxes),
      ...level.spawns.flatMap((s) => [s.x, s.y, s.z]),
      ...(level.nests ?? []).flatMap((n) => [n.x, n.z]),
      ...(level.clues ?? []).flatMap((c) => [c.x, c.z]),
      ...(level.extracts ?? []).flatMap((e) => [e.x, e.z]),
      ...(level.water ?? []).flatMap((w) => [w.x, w.z, w.hx, w.hz, w.rotY ?? 0]),
      ...(level.zones ?? []).flatMap((z) => [z.x, z.z, z.radius]),
    ]
    for (const n of nums) assert.ok(Number.isFinite(n), `${level.id} 里有非有限数 ${n}`)
    for (const b of level.boxes) {
      assert.ok(b.hx > 0 && b.hy > 0 && b.hz > 0, `${level.id} 有零尺寸盒子 @${b.x},${b.y},${b.z}`)
    }
  }
})

test('标记点数量：3 线索 / ≥6 巢穴 / ≥2 撤离 / ≥4 出生', () => {
  for (const level of levels) {
    assert.equal(level.clues?.length, 3, `${level.id} 必须正好 3 条线索（server 的 CLUE_TOTAL）`)
    assert.ok(
      (level.nests?.length ?? 0) >= 6,
      `${level.id} 至少 6 处巢穴（每条线索附近一个 + 原有巢穴）`,
    )
    assert.ok((level.extracts?.length ?? 0) >= 2, `${level.id} 至少 2 个撤离点`)
    assert.ok(level.spawns.length >= 4, `${level.id} 至少 4 个出生点`)
    assert.ok((level.zones?.length ?? 0) >= 4, `${level.id} 至少划分 4 个区域`)

    // 每条线索 14m 内都要有巢穴：PvE 必须真的守在线索附近，而不是散在图角。
    for (const clue of level.clues ?? []) {
      const nearest = Math.min(
        ...(level.nests ?? []).map((n) => Math.hypot(n.x - clue.x, n.z - clue.z)),
      )
      assert.ok(
        nearest <= 14,
        `${level.id} 线索 @${clue.x},${clue.z} 最近的巢穴有 ${nearest.toFixed(1)}m，超过 14m`,
      )
    }
  }
})

test('出生点离最近的巢穴与线索都 ≥35m', () => {
  for (const level of levels) {
    const targets = [
      ...(level.nests ?? []).map((n) => `巢穴@${n.x},${n.z}`),
      ...(level.clues ?? []).map((c) => `线索@${c.x},${c.z}`),
    ]
    for (const spawn of level.spawns) {
      for (const [i, t] of [...(level.nests ?? []), ...(level.clues ?? [])].entries()) {
        const d = Math.hypot(spawn.x - t.x, spawn.z - t.z)
        assert.ok(
          d >= MIN_SPAWN_SAFE,
          `${level.id} 出生点 ${spawn.x},${spawn.z} 离 ${targets[i]} 只有 ${d.toFixed(1)}m`,
        )
      }
    }
  }
})

test('撤离点 ≥2 个，且离地图中心 ≥60m', () => {
  for (const level of levels) {
    for (const e of level.extracts ?? []) {
      const d = Math.hypot(e.x, e.z)
      assert.ok(d >= MIN_EXTRACT_FROM_CENTER, `${level.id} 撤离点「${e.name}」离中心只有 ${d.toFixed(1)}m`)
      assert.ok(
        Math.abs(e.x) < level.boundsHalf && Math.abs(e.z) < level.boundsHalf,
        `${level.id} 撤离点「${e.name}」在边界外`,
      )
    }
  }
})

test('所有能从地面迈上去的盒顶都严格落在 0.4m 网格上', () => {
  for (const level of levels) {
    const g = level.groundY
    for (const b of solid(level.boxes)) {
      const bottom = b.y - b.hy
      if (bottom > g + STEP + EPS) continue // 悬空的东西踩不到，不受台阶规则约束
      const top = b.y + b.hy - g
      const k = top / STEP
      assert.ok(
        Math.abs(k - Math.round(k)) < 1e-4,
        `${level.id} 可攀爬盒顶 ${top.toFixed(3)}m 不在 0.4m 网格上 @${b.x.toFixed(1)},${b.z.toFixed(1)}`,
      )
    }
  }
})

test('标记点不嵌在墙里（能够站人）', () => {
  for (const level of levels) {
    const grid = makeGrid(solid(level.boxes))
    const marks: [string, number, number][] = [
      ...level.spawns.map((s, i) => [`出生点#${i}`, s.x, s.z] as [string, number, number]),
      ...(level.nests ?? []).map((n, i) => [`巢穴#${i}`, n.x, n.z] as [string, number, number]),
      ...(level.clues ?? []).map((c, i) => [`线索#${i}`, c.x, c.z] as [string, number, number]),
      ...(level.extracts ?? []).map((e) => [`撤离点「${e.name}」`, e.x, e.z] as [string, number, number]),
    ]
    for (const [label, x, z] of marks) {
      assert.ok(Math.abs(x) < level.boundsHalf && Math.abs(z) < level.boundsHalf, `${level.id} ${label} 出界`)
      const cell = grid.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`) ?? []
      for (const b of cell) {
        // 只有挡人（顶面高过 0.8m）且贴着站位的盒子才算"嵌墙"；0.4m 踏步是可以站的
        if (b.y + b.hy < level.groundY + 0.8) continue
        const near = inside(b, x, level.groundY + 0.9, z, 0.3)
        assert.ok(!near, `${level.id} ${label} @${x},${z} 嵌在盒子里（${b.x.toFixed(1)},${b.z.toFixed(1)}）`)
      }
    }
  }
})

test('视线管理：任意两个区域之间至少有一处遮挡，且不存在 200m 无遮挡长廊', () => {
  for (const level of levels) {
    const grid = makeGrid(solid(level.boxes))
    const eye = level.groundY + 1.5
    const zones = level.zones ?? []

    // 区域对：三条平行视线（偏 0 / ±1.6m）里至少要有一条被挡住
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i]
        const b = zones[j]
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        if (len < 1) continue
        const dx = (b.x - a.x) / len
        const dz = (b.z - a.z) / len
        const blocked = [-1.6, 0, 1.6].some((off) => {
          const t = sightAt(grid, a.x - dz * off, a.z + dx * off, eye, dx, dz, len)
          return t < len - 0.5
        })
        assert.ok(blocked, `${level.id} 区域「${a.name}」与「${b.name}」之间 ${len.toFixed(0)}m 完全无遮挡`)
      }
    }

    // 长廊：从每个出生点扫 144 个方向，连续 >150m 的扇区宽度不得超过 15°
    const step = (Math.PI * 2) / 144
    for (const [si, s] of level.spawns.entries()) {
      let run = 0
      let worst = 0
      for (let k = 0; k < 144 * 2; k++) {
        const ang = k * step
        const t = sightAt(grid, s.x, s.z, eye, Math.cos(ang), Math.sin(ang), level.boundsHalf * 2)
        if (t > 150) {
          run++
          worst = Math.max(worst, run)
        } else run = 0
      }
      const deg = Math.min(worst, 144) * (360 / 144)
      assert.ok(deg <= 15, `${level.id} 出生点#${si} 有一个 ${deg.toFixed(1)}° 宽的无遮挡长廊`)
    }
  }
})
