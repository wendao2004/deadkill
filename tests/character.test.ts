import test from 'node:test'
import assert from 'node:assert/strict'

import { initPhysics, buildLevelWorld } from '../shared/src/worldbuild.ts'
import { Character } from '../shared/src/character.ts'
import { Buttons } from '../shared/src/constants.ts'
import type { LevelDef } from '../shared/src/level.ts'

/**
 * 角色输入边沿的回归测试。
 *
 * 2026-11-08 的线上问题："长按空格人物一直抖"。根因是预测回滚：
 * 回滚把角色拨回服务端位置时顺手清掉了 jumpLatch / prevJumpHeld，
 * 重放的第一帧就把"仍然按住的空格"当成一次新的按下 —— 每次网络修正都
 * 多跳一次，预测误差又把下一次修正引出来，形成自激振荡。
 */

const FLAT: LevelDef = {
  id: 'flat-test',
  name: '平坦测试场',
  biome: 'forest',
  groundY: 0,
  boundsHalf: 20,
  groundMaterial: 'mud',
  fogColor: 0x000000,
  fogDensity: 0.01,
  boxes: [],
  spawns: [{ x: 0, y: 0, z: 0 }],
  zones: [{ name: '空地', x: 0, z: 0, radius: 20 }],
  clues: [],
  nests: [],
  extracts: [],
}

const DT = 1 / 60
const HELD_JUMP = { forward: 0, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Jump }

await initPhysics()

function makeCharacter(world: ReturnType<typeof buildLevelWorld>): Character {
  return new Character(world, { x: 0, y: 0, z: 0 })
}

test('长按空格只起跳一次', () => {
  const world = buildLevelWorld(FLAT)
  const c = makeCharacter(world)
  let jumps = 0
  let wasAirborne = false
  for (let i = 0; i < 120; i++) {
    c.step(world, HELD_JUMP, DT)
    world.step()
    const airborne = !c.grounded
    if (airborne && !wasAirborne && c.vy > 1) jumps++
    wasAirborne = airborne
  }
  world.free()
  assert.equal(jumps, 1, '按住空格不应该反复起跳')
})

test('预测回滚重放不会把按住空格当成新的按下', () => {
  const world = buildLevelWorld(FLAT)
  const c = makeCharacter(world)
  // 先完整跳一次并落回地面（此时空格仍按住，jumpLatch = true）
  for (let i = 0; i < 60; i++) {
    c.step(world, HELD_JUMP, DT)
    world.step()
  }
  assert.ok(c.grounded, '应该已经落地')

  const before = c.feet.y
  // 模拟一次网络修正：拨回权威位置（保留输入边沿状态）并重放按住空格的输入
  c.teleport({ x: c.feet.x, y: c.feet.y, z: c.feet.z }, true)
  c.step(world, HELD_JUMP, DT)
  world.step()

  const after = c.feet.y
  world.free()
  assert.ok(Math.abs(after - before) < 0.01, `重放不应该再次起跳（${before} → ${after}）`)
})
