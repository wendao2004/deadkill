import test from 'node:test'
import assert from 'node:assert/strict'

import {
  boxSpan,
  brushAt,
  penetrationFor,
  penetrationPower,
  type LevelDef,
} from '../shared/src/index.ts'

const level = {
  boxes: [
    { x: 0, y: 1, z: 0, hx: 0.2, hy: 1, hz: 2, material: 'wood' },
    { x: 3, y: 1, z: 0, hx: 0.2, hy: 1, hz: 2, material: 'stone' },
  ],
} as unknown as LevelDef

test('穿透规则：木头/植被可穿，石头不可穿', () => {
  assert.ok(penetrationFor('wood', 'rifle').maxThickness > 0)
  assert.ok(penetrationFor('foliage', 'rifle').maxThickness > 0)
  assert.equal(penetrationFor('stone', 'rifle').maxThickness, 0)
  assert.equal(penetrationFor(undefined, 'rifle').maxThickness, 0)
})

test('穿透规则：狙击 > 步枪 > 转轮 > 霰弹，且伤害都小于 1', () => {
  const sniper = penetrationPower('sniper')
  const rifle = penetrationPower('rifle')
  const revolver = penetrationPower('revolver')
  const shotgun = penetrationPower('shotgun')
  assert.ok(sniper > rifle && rifle > revolver && revolver > shotgun)
  for (const kind of ['sniper', 'rifle', 'revolver', 'shotgun']) {
    const rule = penetrationFor('wood', kind)
    assert.ok(rule.damageScale > 0 && rule.damageScale < 1, kind)
  }
})

test('boxSpan：0.4m 木墙的入射/出射距离与厚度', () => {
  const span = boxSpan(level.boxes[0]!, { x: -2, y: 1, z: 0 }, { x: 1, y: 0, z: 0 })
  assert.ok(span)
  assert.ok(Math.abs(span.enter - 1.8) < 1e-6, String(span.enter))
  assert.ok(Math.abs(span.exit - 2.2) < 1e-6, String(span.exit))
  assert.ok(Math.abs(span.exit - span.enter - 0.4) < 1e-6)
})

test('brushAt：命中面附近的点能找到对应盒子，地面/空处找不到', () => {
  assert.equal(brushAt(level, { x: 0.2, y: 1, z: 0 })?.material, 'wood')
  assert.equal(brushAt(level, { x: 3.2, y: 1, z: 0 })?.material, 'stone')
  assert.equal(brushAt(level, { x: 10, y: 0, z: 10 }), null)
})
