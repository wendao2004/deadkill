import test from 'node:test'
import assert from 'node:assert/strict'

import type { BoxBrush, LevelDef } from '../shared/src/level.ts'
import { surfaceAt, surfaceNormalAt } from '../client/src/surfaces.ts'

/**
 * 命中法线是贴花的唯一朝向来源（协议里不传法线），算错的表现是
 * "弹孔立在地板上"。这里逐面钉住盒刷的最近面判断，以及 rotY 的旋转。
 */

function levelWith(boxes: BoxBrush[], groundMaterial: 'wood' | 'stone' | 'mud' = 'mud'): LevelDef {
  return {
    id: 'surface-test',
    name: 'surface-test',
    groundY: 0,
    boundsHalf: 20,
    boxes,
    spawns: [{ x: 0, y: 0, z: 0 }],
    groundMaterial,
  } as LevelDef
}

const cube: BoxBrush = { x: 0, y: 1, z: 0, hx: 1, hy: 1, hz: 1, material: 'stone' }

test('表面法线：盒子的顶面/侧面/底面各朝各的轴', () => {
  const level = levelWith([cube])
  assert.deepEqual(surfaceNormalAt(level, { x: 0, y: 2.02, z: 0 }), { x: 0, y: 1, z: 0 })
  assert.deepEqual(surfaceNormalAt(level, { x: 1.02, y: 1, z: 0 }), { x: 1, y: 0, z: 0 })
  assert.deepEqual(surfaceNormalAt(level, { x: -1.02, y: 1, z: 0 }), { x: -1, y: 0, z: 0 })
  assert.deepEqual(surfaceNormalAt(level, { x: 0, y: 1, z: -1.02 }), { x: 0, y: 0, z: -1 })
  assert.deepEqual(surfaceNormalAt(level, { x: 0, y: 0.02, z: 0 }), { x: 0, y: -1, z: 0 })
})

test('表面法线：rotY 把局部面法线转回世界空间', () => {
  // 绕 Y 转 90°：局部 +X 面朝向世界 +Z。
  const rotated: BoxBrush = { ...cube, rotY: Math.PI / 2 }
  const level = levelWith([rotated])
  const normal = surfaceNormalAt(level, { x: 0, y: 1, z: 1.02 })
  assert.ok(Math.abs(normal.x) < 1e-9)
  assert.ok(Math.abs(normal.y) < 1e-9)
  assert.ok(Math.abs(normal.z - 1) < 1e-9)
})

test('表面法线：不贴盒子时按地面算，朝上', () => {
  const level = levelWith([])
  assert.deepEqual(surfaceNormalAt(level, { x: 5, y: 0.02, z: 5 }), { x: 0, y: 1, z: 0 })
  // 半空中的点（穿模等极端情况）也给向上，贴花至少不会消失。
  assert.deepEqual(surfaceNormalAt(level, { x: 5, y: 8, z: 5 }), { x: 0, y: 1, z: 0 })
})

test('表面材质与法线对同一点给出一致的几何判断', () => {
  const level = levelWith([cube])
  const point = { x: 0.2, y: 2.01, z: 0.2 }
  assert.equal(surfaceAt(level, point, 0.4), 'stone')
  assert.deepEqual(surfaceNormalAt(level, point), { x: 0, y: 1, z: 0 })
})
