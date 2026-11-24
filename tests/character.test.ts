import test from 'node:test'
import assert from 'node:assert/strict'

import { initPhysics, buildLevelWorld } from '../shared/src/worldbuild.ts'
import { Character, stateFlagsOf } from '../shared/src/character.ts'
import { computeMoveVelocity } from '../shared/src/sim.ts'
import { Buttons, StateFlags } from '../shared/src/constants.ts'
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


test('stateFlagsOf：冲刺位与音频层位是追加的，不改变既有姿态位', () => {
  const flags = stateFlagsOf({
    grounded: true,
    crouching: false,
    ads: false,
    alive: true,
    reloading: false,
    sprinting: true,
    audioOnly: true,
  })
  assert.ok((flags & StateFlags.Alive) !== 0)
  assert.ok((flags & StateFlags.Grounded) !== 0)
  assert.ok((flags & StateFlags.Sprinting) !== 0)
  assert.ok((flags & StateFlags.AudioOnly) !== 0)
  assert.equal((flags & StateFlags.Crouching) !== 0, false)
})


test('长时间连续爬同一面墙会在体力耗尽后强制坠落', () => {
  const wallLevel: LevelDef = {
    ...FLAT,
    id: 'wall-exhaust-test',
    name: '爬墙体力测试场',
    boxes: [{ x: 0, y: 3, z: -1.6, hx: 2, hy: 3, hz: 0.3, material: 'stone' }],
  }
  const world = buildLevelWorld(wallLevel)
  const c = makeCharacter(world)
  c.step(world, HELD_JUMP, DT)
  world.step()
  let climbed = false
  let lockedWhileAirborne = false
  for (let i = 0; i < 180; i++) {
    c.step(world, RUN_FORWARD, DT)
    world.step()
    if (c.climbing) climbed = true
    if (!c.climbing && !c.grounded) lockedWhileAirborne = true
  }
  world.free()
  assert.ok(climbed, '应该先进入攀爬')
  assert.ok(lockedWhileAirborne, '体力耗尽后应在空中强制脱手')
  assert.ok(!c.climbing, '不能无限贴墙')
})

/**
 * 预测回滚不许打断"动作状态机"。
 *
 * 2026-11-24 的线上手感问题："滑铲像被拽住、人走起来一卡一卡"。
 * 20Hz 快照每 50ms 触发一次 reconcile → teleport(keepInputState=true)，
 * 修复前它会顺手把 sliding / sprinting 清掉：一次 1.15s 的滑铲只活 3 帧，
 * 之后速度在 1.74 与 2.44 之间来回跳；冲刺也永远攒不满 0.05s 起步延迟。
 */
test('预测回滚不会打断滑铲', () => {
  const world = buildLevelWorld(FLAT)
  const c = makeCharacter(world)
  const sprint = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Sprint }
  const slide = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Sprint | Buttons.Crouch }
  for (let i = 0; i < 60; i++) {
    c.step(world, sprint, DT)
    world.step()
  }
  const from = c.feet

  let slideFrames = 0
  let minWhileSliding = Infinity
  for (let i = 0; i < 150; i++) {
    // 每 3 帧一次修正 = 20Hz 快照。修正只拨位置（服务端速度原样写回）。
    if (i % 3 === 0 && i > 0) {
      const vx = c.vx
      const vz = c.vz
      c.teleport({ x: c.feet.x, y: c.feet.y, z: c.feet.z }, true)
      c.vx = vx
      c.vz = vz
      world.step()
    }
    c.step(world, slide, DT)
    world.step()
    if (c.sliding) {
      slideFrames++
      minWhileSliding = Math.min(minWhileSliding, Math.hypot(c.vx, c.vz))
    }
  }
  const travelled = Math.hypot(c.feet.x - from.x, c.feet.z - from.z)
  world.free()

  // 1.15s 的滑铲在 60Hz 下是 ~68 帧；给网络修正留 10 帧余量。
  assert.ok(slideFrames > 58, `滑铲应该完整活过一次滑行（只活了 ${slideFrames} 帧）`)
  assert.ok(travelled > 8.5, `滑行距离不应被修正吃掉（只走了 ${travelled.toFixed(2)}m）`)
  // 滑铲中速度必须单调衰减，不能出现"刹住又弹起"的锯齿。
  assert.ok(minWhileSliding > 2.3, `滑铲速度不应掉到蹲行以下（最低 ${minWhileSliding.toFixed(2)}）`)
})

test('预测回滚不会重置冲刺的起步延迟', () => {
  const world = buildLevelWorld(FLAT)
  const c = makeCharacter(world)
  const sprint = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Sprint }
  for (let i = 0; i < 40; i++) {
    c.step(world, sprint, DT)
    world.step()
  }
  assert.equal(c.sprinting, true, '先要进入冲刺')
  for (let i = 0; i < 30; i++) {
    // 每 3 帧一次修正：sprintHold 若被清零，sprinting 会在 false/true 之间抖。
    if (i % 3 === 0) {
      const vx = c.vx
      const vz = c.vz
      c.teleport({ x: c.feet.x, y: c.feet.y, z: c.feet.z }, true)
      c.vx = vx
      c.vz = vz
      world.step()
    }
    c.step(world, sprint, DT)
    world.step()
    assert.equal(c.sprinting, true, `第 ${i} 帧冲刺被网络修正打断了`)
  }
  world.free()
})

test('出生/复活用的 teleport 仍然清空全部动作状态', () => {
  const world = buildLevelWorld(FLAT)
  const c = makeCharacter(world)
  const sprint = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Sprint }
  for (let i = 0; i < 40; i++) {
    c.step(world, sprint, DT)
    world.step()
  }
  c.teleport({ x: 0, y: 0, z: 0 })
  world.free()
  assert.equal(c.sprinting, false, '复活不该继承上一具身体的冲刺')
  assert.equal(c.sliding, false, '复活不该继承上一具身体的滑铲')
})

// ---------------------------------------------------------------- 跳跃/蹬墙/翻越手感
// 2026-11-24 玩家反馈："跳跃判定卡卡的，蹬墙或爬墙过度不自然"。根因有三个：
// ①空中速度超过补充上限（3.4）后输入完全不改变方向，蹬墙跳的 5.4 m/s 是一条
//   直线；②抓墙判定先于翻沿、且允许上升段（vy<3.5）抓，跳向矮台先被"粘"住
//   急停；③翻越落点只探一个固定 0.28m 深度，探测点常落在墙皮外侧，翻越
//   失败掉进抓墙分支，变成沿墙皮"过度攀爬"。

const THICK_LEDGE: LevelDef = {
  ...FLAT,
  id: 'thick-ledge-test',
  name: '厚台面测试场',
  // 1.0m 高、0.8m 厚的石台：旧的单深度落点探测在它面前经常失败。
  boxes: [{ x: 0, y: 0.5, z: -2.4, hx: 1.5, hy: 0.5, hz: 0.4, material: 'stone' }],
}

test('空中超速动量可以被转向（蹬墙跳不再是一条直线）', () => {
  // 蹬墙跳出去：5.4 m/s 沿 +Z。玩家把视角转向 +X（yaw = -π/2 → forward=(1,0,0)）。
  let vx = 0
  let vz = 5.4
  const steer = { forward: 1, right: 0, yaw: -Math.PI / 2, pitch: 0, buttons: 0 }
  const state = { vx, vz, grounded: false }
  for (let i = 0; i < 30; i++) {
    const move = computeMoveVelocity(steer, state, DT, false)
    state.vx = move.vx
    state.vz = move.vz
  }
  const speed = Math.hypot(state.vx, state.vz)
  // 方向明显偏向 +X；速度不超过旧模型的上限（动量 + 空中补充的矢量合）。
  assert.ok(state.vx > 1.5, `往 +X 看了半秒，速度还几乎没转过来（vx=${state.vx}）`)
  assert.ok(state.vz < 5.39, 'Z 分量应该被转走一部分')
  assert.ok(speed < 7.5, `转向不该把速度吹到矢量合之外（${speed}）`)
})

test('跳向矮台是翻越，不是被粘在墙皮上', () => {
  const world = buildLevelWorld(LEDGE)
  const c = makeCharacter(world)
  const run = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Jump }
  let everClimbed = false
  let onTop = false
  for (let i = 0; i < 90; i++) {
    c.step(world, run, DT)
    world.step()
    if (c.climbing) everClimbed = true
    if (c.feet.y > 0.85) {
      onTop = true
      break
    }
  }
  world.free()
  assert.equal(everClimbed, false, '0.9m 的台面不该触发抓墙攀爬')
  assert.ok(onTop, '跑跳向矮台应该被翻上去（y>0.85）')
})

test('0.8m 厚的石台也能翻上去（多深度落点探测）', () => {
  const world = buildLevelWorld(THICK_LEDGE)
  const c = makeCharacter(world)
  const run = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Jump }
  let everClimbed = false
  let onTop = false
  for (let i = 0; i < 120; i++) {
    c.step(world, run, DT)
    world.step()
    if (c.climbing) everClimbed = true
    if (c.feet.y > 0.95) {
      onTop = true
      break
    }
  }
  world.free()
  assert.equal(everClimbed, false, '1.0m 的厚台面不该退化成抓墙攀爬')
  assert.ok(onTop, '厚台面应该被多深度探测翻上去（y>0.95）')
})

test('翻越保留入场动量（空中带速接翻越不再减速）', () => {
  const world = buildLevelWorld(THICK_LEDGE)
  const c = makeCharacter(world)
  // 直接构造"空中带速接翻越"：距厚台面 1.4m、贴着下落沿带 7m/s 水平速度。
  // 现实里这就是冲刺跳的抛物线末端；从地面起跑反而到不了这里 ——
  // 1m 的台面会先把人挡停，再跳就成了原地起跳，没有动量可保留。
  c.teleport({ x: 0, y: 0.2, z: -0.65 })
  c.vx = -7
  c.vz = 0
  c.vy = 1.0
  const hold = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: 0 }
  let maxSpeed = 0
  let vaulted = false
  for (let i = 0; i < 60; i++) {
    c.step(world, hold, DT)
    world.step()
    if (c.vaulting) {
      vaulted = true
      maxSpeed = Math.max(maxSpeed, Math.hypot(c.vx, c.vz))
    }
  }
  world.free()
  assert.ok(vaulted, '应该触发一次翻越')
  assert.ok(maxSpeed > 4.5, `带 7m/s 接翻越，脚本速度不该压回 4.2（实测 ${maxSpeed}）`)
})
