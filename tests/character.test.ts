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

/** 前方 0.9m 高的台面：翻越与空中攀沿都用它。 */
const LEDGE: LevelDef = {
  ...FLAT,
  id: 'ledge-test',
  name: '台面测试场',
  boxes: [{ x: 0, y: 0.45, z: -2.2, hx: 2, hy: 0.45, hz: 0.7, material: 'stone' }],
}

const DT = 1 / 60
const HELD_JUMP = { forward: 0, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Jump }
const RUN_FORWARD = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: 0 }

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

test('松开 Shift 后冲刺速度平滑回落到步行', () => {
  const world = buildLevelWorld(FLAT)
  const c = makeCharacter(world)
  const sprint = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Sprint }
  for (let i = 0; i < 40; i++) {
    c.step(world, sprint, DT)
    world.step()
  }
  const before = Math.hypot(c.vx, c.vz)
  assert.ok(before > 6.5, `冲刺速度应该到 7 左右（${before.toFixed(2)}）`)

  // 松开 Shift 的第一帧：不能原地掉成步行
  c.step(world, RUN_FORWARD, DT)
  world.step()
  const after1 = Math.hypot(c.vx, c.vz)
  assert.ok(after1 > 6.0, `松手第一帧不应该骤降到步行（${after1.toFixed(2)}）`)

  // 渐变结束：回到步行速度附近
  for (let i = 0; i < 30; i++) {
    c.step(world, RUN_FORWARD, DT)
    world.step()
  }
  const after2 = Math.hypot(c.vx, c.vz)
  const sprinting = c.sprinting
  world.free()
  assert.ok(after2 > 4.0 && after2 < 5.2, `最终应回落到步行速度（${after2.toFixed(2)}）`)
  assert.equal(sprinting, false, '渐变结束后冲刺状态应关闭')
})

test('硬着陆后 0.16s 内不能起跑，之后恢复', () => {
  const world = buildLevelWorld(FLAT)
  const c = makeCharacter(world)
  c.teleport({ x: 0, y: 5, z: 0 })
  const sprint = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Sprint }
  // 自由下落直到落地
  for (let i = 0; i < 120 && !c.grounded; i++) {
    c.step(world, { ...sprint, buttons: 0 }, DT)
    world.step()
  }
  assert.ok(c.grounded, '应该已经落地')
  // 落地第一帧按住冲刺：不允许起跑
  c.step(world, sprint, DT)
  world.step()
  const early = c.sprinting
  // 缓冲结束后可以起跑（0.05s 起步延迟之外）
  for (let i = 0; i < 24; i++) {
    c.step(world, sprint, DT)
    world.step()
  }
  const late = c.sprinting
  world.free()
  assert.equal(early, false, '硬着陆后立刻起跑应被缓冲挡住')
  assert.equal(late, true, '缓冲结束后应恢复起跑')
})

test('空中贴墙可以攀爬，按跳跃触发蹬墙跳', () => {
  const wallLevel: LevelDef = {
    ...FLAT,
    id: 'wall-test',
    name: '墙面测试场',
    boxes: [{ x: 0, y: 3, z: -1.6, hx: 2, hy: 3, hz: 0.3, material: 'stone' }],
  }
  const world = buildLevelWorld(wallLevel)
  const c = makeCharacter(world)
  // 起跳后一直按前进，等上升速度降下来再抓墙
  c.step(world, HELD_JUMP, DT)
  world.step()
  let climbed = false
  for (let i = 0; i < 40; i++) {
    c.step(world, RUN_FORWARD, DT)
    world.step()
    if (c.climbing) climbed = true
  }
  assert.ok(climbed, '贴上高墙后应该进入攀爬')
  const yBefore = c.feet.y

  // 攀爬中按跳跃 = 蹬墙跳：朝墙外推 + 向上
  c.step(world, HELD_JUMP, DT)
  world.step()
  const vz = c.vz
  const vy = c.vy
  // 蹬墙跳的那一帧只改速度，位移要等后续 tick
  for (let i = 0; i < 6; i++) {
    c.step(world, RUN_FORWARD, DT)
    world.step()
  }
  const yAfter = c.feet.y
  world.free()
  assert.ok(!c.climbing, '蹬墙跳后应离开墙面')
  assert.ok(vz > 3, `应该被推离墙面（vz=${vz.toFixed(2)}）`)
  assert.ok(vy > 2, `应该向上弹起（vy=${vy.toFixed(2)}）`)
  assert.ok(yAfter > yBefore, '蹬墙跳不应该往下掉')
})

test('空中贴着 0.9m 台面会自动攀沿', () => {
  const world = buildLevelWorld(LEDGE)
  const c = makeCharacter(world)
  // 悬在台面前方，脚比台面低；向前推，不按跳跃
  c.teleport({ x: 0, y: 0.3, z: -1.2 })
  let vaulted = false
  for (let i = 0; i < 30; i++) {
    c.step(world, RUN_FORWARD, DT)
    world.step()
    if (c.vaulting) vaulted = true
  }
  const top = c.feet.y
  world.free()
  assert.ok(vaulted, '应该触发一次空中攀沿')
  assert.ok(top > 0.7, `攀沿后应该站上台面（feet.y=${top.toFixed(2)}）`)
})
