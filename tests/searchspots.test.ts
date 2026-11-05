/**
 * 每张地图都必须有足够、可站立、彼此分开的搜刮点。
 *
 * 这条测试是"3/4 张图没有战利品"那次事故的护栏：以后新增地图如果忘了
 * 挂 searchSpots，加载时会自动补点位；补出来的点如果落进墙/水/别人的点上，
 * 这里会红，而不是等玩家进图才发现搜不到东西。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { LEVELS, PLAYER_HALF_HEIGHT, PLAYER_RADIUS, type BoxBrush, type WaterRect } from '../shared/src/index.ts'

function boxFootprintDistance(b: BoxBrush, x: number, z: number): number {
  const dx = x - b.x
  const dz = z - b.z
  const c = Math.cos(b.rotY ?? 0)
  const s = Math.sin(b.rotY ?? 0)
  const lx = dx * c + dz * s
  const lz = -dx * s + dz * c
  return Math.hypot(Math.max(0, Math.abs(lx) - b.hx), Math.max(0, Math.abs(lz) - b.hz))
}

function waterDistance(w: WaterRect, x: number, z: number): number {
  return boxFootprintDistance({ x: w.x, y: 0, z: w.z, hx: w.hx, hy: 1, hz: w.hz, rotY: w.rotY }, x, z)
}

test('每张图有 >=12 个搜刮点，且都在可站立的位置', () => {
  for (const [id, level] of Object.entries(LEVELS)) {
    const spots = level.searchSpots ?? []
    const bandLow = level.groundY + 0.05
    const bandHigh = level.groundY + PLAYER_HALF_HEIGHT * 2 + PLAYER_RADIUS * 2
    const solid = level.boxes.filter(
      (b) => !b.noCollide && b.y + b.hy > bandLow && b.y - b.hy < bandHigh,
    )
    assert.ok(spots.length >= 12, `${id} 只有 ${spots.length} 个搜刮点，至少需要 12 个`)
    assert.ok(
      spots.filter((s) => s.kind === 'corpse').length >= 2,
      `${id} 至少要有 2 个高价值尸体点`,
    )

    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!
      const label = `${id} 点 #${i} (${s.x}, ${s.z})`
      assert.ok(
        Math.abs(s.x) <= level.boundsHalf - 2 && Math.abs(s.z) <= level.boundsHalf - 2,
        `${label} 离地图边界太近`,
      )

      for (const b of solid) {
        assert.ok(
          boxFootprintDistance(b, s.x, s.z) >= 1.0,
          `${label} 离实心盒 (${b.x}, ${b.z}) 只有 ${boxFootprintDistance(b, s.x, s.z).toFixed(2)}m`,
        )
      }

      for (const w of level.water ?? []) {
        assert.ok(
          waterDistance(w, s.x, s.z) >= 0.4,
          `${label} 落在水面 (${w.x}, ${w.z}) 里`,
        )
      }

      for (let j = 0; j < i; j++) {
        const other = spots[j]!
        const d = Math.hypot(s.x - other.x, s.z - other.z)
        assert.ok(d >= 6, `${id} 点 #${i} 与 #${j} 只隔 ${d.toFixed(1)}m，会互相抢判定`)
      }
    }

    for (const zone of level.zones ?? []) {
      assert.ok(
        spots.some((s) => Math.hypot(s.x - zone.x, s.z - zone.z) <= zone.radius + 2),
        `${id} 的区域「${zone.name}」没有任何搜刮点`,
      )
    }
  }
})
