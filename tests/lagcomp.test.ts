/**
 * 延迟补偿的回归测试。
 *
 * 背景：Rapier 0.21 的 `castRay` 先过 broad-phase 的 AABB 剪枝，而 AABB 只在
 * `step()` 里刷新。曾经把其他玩家 `setTranslation` 回历史帧来补偿，碰撞体的变换
 * 跟上了、剪枝用的还是旧位置 —— 回滚后的位置反而打不到（探针实测 0/5），
 * 表现为"明明瞄准了却没中"。现在改成解析射线-胶囊求交，这两条断言就是它的护栏。
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { MAX_HEALTH } from '../shared/src/constants.ts'
import { Buttons, TICK_MS } from '../shared/src/constants.ts'
import { rayCapsule } from '../shared/src/hit.ts'
import { DEFAULT_LEVEL_ID, LEVELS } from '../shared/src/level.ts'
import { refillSlot } from '../shared/src/loadout.ts'
import { initPhysics } from '../shared/src/worldbuild.ts'
import { World } from '../server/src/world.ts'
import type { WebSocket } from 'ws'

const GROUND = LEVELS[DEFAULT_LEVEL_ID]!.groundY
const LAG_TICKS = 2 // 客户端手里最新的快照大约落后 2 tick（20Hz 下行）
const INTERP_TICKS = 5 // 90ms 插值延迟 ≈ 5 tick

/**
 * 延迟补偿测试专用的空图。
 *
 * 默认沼泽图的出生点是随机的（pickSpawn 带 Math.random），其中一些点旁边
 * 就有盒子；射线先撞静态几何，测试就会随机变成 0/4。这里去掉所有盒子/
 * 巢穴/线索，只留地面和原点出生点，让这条测试只验证"回滚位姿"本身。
 */
const CLEAR_LEVEL = {
  ...LEVELS[DEFAULT_LEVEL_ID]!,
  boxes: [],
  nests: [],
  clues: [],
  extracts: [],
  searchSpots: [],
  spawns: [{ x: 0, y: GROUND, z: 0 }],
}

interface PlayerLike {
  id: number
  health: number
  alive: boolean
  loadout: Parameters<typeof refillSlot>[0]
  character: {
    teleport(p: { x: number; y: number; z: number }): void
    body: { translation(): { x: number; y: number; z: number } }
  }
}

test('rayCapsule: 正对胶囊打中，偏出一个半径就打空', () => {
  const origin = { x: 0, y: 0, z: 0 }
  const dir = { x: 0, y: 0, z: -1 }
  const a = { x: 0, y: -0.6, z: -5 }
  const b = { x: 0, y: 0.6, z: -5 }
  const hit = rayCapsule(origin, dir, a, b, 0.26)
  assert.ok(hit !== null, '正对轴线必须命中')
  assert.ok(Math.abs(hit - 4.74) < 0.02, '命中距离应等于 5 减去半径，实际 ' + hit)

  const miss = rayCapsule({ x: 0.4, y: 0, z: 0 }, dir, a, b, 0.26)
  assert.equal(miss, null, '偏 0.4m 超出半径 0.26m，必须打空')

  // 反向打：胶囊在身后，不该有命中。
  assert.equal(rayCapsule(origin, { x: 0, y: 0, z: 1 }, a, b, 0.26), null)
})

test('延迟补偿: 打历史位姿命中，打当下位姿打空', async () => {
  await initPhysics()
  const world = new World({ id: 'lagcomp', level: CLEAR_LEVEL })
  const internals = world as unknown as { step(): void; players: Map<number, PlayerLike> }
  const socket = { readyState: 1, sent: [], send: () => {}, close: () => {} }
  const aJoin = world.addPlayer(socket as unknown as WebSocket, 'A')!
  const bJoin = world.addPlayer(socket as unknown as WebSocket, 'B')!
  const A = internals.players.get(aJoin.id)!
  const B = internals.players.get(bJoin.id)!

  const base = aJoin.spawn
  A.character.teleport({ x: base.x, y: GROUND, z: base.z })
  B.character.teleport({ x: base.x, y: GROUND, z: base.z - 8 })

  const hist = new Map<number, { x: number; z: number }>()
  let seqA = 1
  let seqB = 1
  let tick = 0

  const stepOnce = (fire: boolean, aim: { x: number; z: number }, acked: number): void => {
    const my = A.character.body.translation()
    const dx = aim.x - my.x
    const dz = aim.z - my.z
    const dy = GROUND + 1.0 - (my.y + 1.0)
    const yaw = Math.atan2(-dx, -dz)
    const pitch = Math.atan2(dy, Math.hypot(dx, dz))
    world.receiveInput(
      A.id,
      [{ seq: seqA++, dtMs: TICK_MS, forward: 0, right: 0, yaw, pitch, buttons: fire ? Buttons.Fire : 0 }],
      acked,
    )
    // B 一直向右横移：没有位移就没有"历史位姿与当下位姿不同"，也就测不出补偿。
    world.receiveInput(
      B.id,
      [{ seq: seqB++, dtMs: TICK_MS, forward: 0, right: 100, yaw: 0, pitch: 0, buttons: Buttons.Sprint }],
      0,
    )
    internals.step()
    tick++
    const t = B.character.body.translation()
    hist.set(tick, { x: t.x, z: t.z })
  }

  const idle = (n: number): void => {
    for (let i = 0; i < n; i++) stepOnce(false, { x: 0, z: 0 }, Math.max(0, tick - LAG_TICKS))
  }

  /**
   * 开一枪，返回是否掉血。
   *
   * `useHistorical` 决定瞄哪一帧的 B：true = 客户端屏幕上的他（插值 + 快照落后），
   * false = 服务器此刻的他。每枪前把 B 摆回原位再空跑 12 tick，
   * 让每枪的地形与历史深度完全一致（不摆的话连打十几枪后 B 会横移出 8m 那条线）。
   */
  const shoot = (useHistorical: boolean): boolean => {
    B.character.teleport({ x: base.x, y: GROUND, z: base.z - 8 })
    idle(12)
    const aimTick = tick - LAG_TICKS - INTERP_TICKS
    const b = B.character.body.translation()
    const aim = useHistorical ? hist.get(aimTick) ?? { x: b.x, z: b.z } : { x: b.x, z: b.z }
    B.health = MAX_HEALTH
    refillSlot(A.loadout)
    stepOnce(true, aim, Math.max(0, tick - LAG_TICKS))
    const hit = B.health < MAX_HEALTH
    idle(56) // 900ms 射速闸
    return hit
  }

  idle(30)

  // 打"屏幕上看到的他"（= 5 tick 插值 + 2 tick 快照落后）必须命中。
  let historical = 0
  for (let i = 0; i < 4; i++) if (shoot(true)) historical++
  assert.equal(historical, 4, '瞄历史位姿应 4/4 命中，实际 ' + historical)

  // 打"服务器此刻的他"：补偿会把命中体挪回 110ms 前，反而应该打空。
  let current = 0
  for (let i = 0; i < 4; i++) if (shoot(false)) current++
  assert.equal(current, 0, '补偿开着却瞄当下位姿应 0/4，实际 ' + current)

  world.stop()
})
