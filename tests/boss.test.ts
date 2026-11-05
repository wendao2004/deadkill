/**
 * 四图 Boss 的装配回归：地图 → bossKind → World 刷怪 → 物理移动。
 *
 * 纯 AI 测试（tests/ai.test.ts）只跑 stepMonster，证明不了"这只 Boss 在这张
 * 地图上真的站得住、走得动"。这里把 World 连同 Rapier 一起跑起来，专门抓
 * 两类线上会立刻暴露的问题：出生点埋在墙里、以及大半径 Boss 原地推墙。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { LEVELS } from '../shared/src/level.ts'
import { initPhysics } from '../shared/src/worldbuild.ts'
import { World } from '../server/src/world.ts'
import type { WebSocket } from 'ws'

const MAPS = ['marsh-p0', 'chapel-night', 'quarry-dust', 'station-dusk'] as const

interface PlayerLike {
  id: number
  health: number
  maxHealth: number
  alive: boolean
  character: { teleport(p: { x: number; y: number; z: number }): void; feet: { x: number; y: number; z: number } }
}

interface BossLike {
  data: {
    kind: string
    x: number
    y: number
    z: number
    state: string
  }
}

function makeWorld(mapId: string): {
  world: World
  internals: {
    spawnBoss(): void
    stepMonsters(): void
    bossEntity: BossLike | null
    players: Map<number, PlayerLike>
    tick: number
    pendingEvents: { kind: number }[]
  }
  player: PlayerLike
} {
  const level = LEVELS[mapId]!
  const world = new World({ id: 'boss-test-' + mapId, level })
  const socket = { readyState: 1, sent: [], send: () => {}, close: () => {} }
  const join = world.addPlayer(socket as unknown as WebSocket, 'BossTester')!
  const internals = world as unknown as {
    spawnBoss(): void
    stepMonsters(): void
    bossEntity: BossLike | null
    players: Map<number, PlayerLike>
    tick: number
    pendingEvents: { kind: number }[]
  }
  const player = internals.players.get(join.id)!
  return { world, internals, player }
}

test('每张图的 Boss 出生在可站立位置，且种类与地图一致', async () => {
  await initPhysics()
  for (const id of MAPS) {
    const level = LEVELS[id]!
    const { internals } = makeWorld(id)
    internals.spawnBoss()
    const boss = internals.bossEntity
    assert.ok(boss, id + ' 没有刷出 Boss')
    assert.equal(boss!.data.kind, level.bossKind, id + ' 刷错了 Boss')
    assert.ok(Number.isFinite(boss!.data.y), id + ' Boss 的 y 不是有限数')
    // 出生后不能埋在地面以下；0.05m 留给浮点与地面厚度。
    assert.ok(boss!.data.y >= level.groundY - 0.05, id + ' Boss 埋进了地面：y=' + boss!.data.y)
    // 位置必须在地图边界内。
    assert.ok(Math.abs(boss!.data.x) < level.boundsHalf, id + ' Boss x 越界')
    assert.ok(Math.abs(boss!.data.z) < level.boundsHalf, id + ' Boss z 越界')
  }
})

/**
 * 一张空图：只验证"Boss 会朝玩家走 / 会按要求后撤"，不把地图墙也拖进来。
 * 真正的出生点检查已经由上一支用例覆盖。
 */
function clearLevel(kind: string) {
  const base = LEVELS['marsh-p0']!
  return {
    ...base,
    id: 'boss-clear-' + kind,
    boxes: [],
    nests: [],
    clues: [],
    extracts: [],
    searchSpots: [],
    spawns: [{ x: 0, y: base.groundY, z: 0 }],
    bossKind: kind,
  }
}

function simulate(
  id: string,
  kind: string,
  playerOffset: number,
  ticks: number,
): { startDist: number; endDist: number; minDist: number; states: Set<string>; events: number[] } {
  const world = new World({ id, level: clearLevel(kind) as never })
  const socket = { readyState: 1, sent: [], send: () => {}, close: () => {} }
  const join = world.addPlayer(socket as unknown as WebSocket, 'Tester')!
  const internals = world as unknown as {
    spawnBoss(): void
    stepMonsters(): void
    bossEntity: BossLike | null
    players: Map<number, PlayerLike>
    tick: number
    pendingEvents: { kind: number }[]
  }
  const player = internals.players.get(join.id)!
  internals.spawnBoss()
  const boss = internals.bossEntity!
  const start = { x: boss.data.x + playerOffset, y: boss.data.y, z: boss.data.z }
  player.character.teleport(start)
  const startDist = Math.hypot(start.x - boss.data.x, start.z - boss.data.z)
  let minDist = startDist
  const states = new Set<string>()
  const events: number[] = []
  for (let i = 0; i < ticks; i++) {
    // 玩家站在原地但不会被咬死：这条用例只关心 Boss 的位移与状态。
    player.health = player.maxHealth
    player.alive = true
    internals.tick++
    internals.stepMonsters()
    states.add(boss.data.state)
    for (const ev of internals.pendingEvents) events.push(ev.kind)
    internals.pendingEvents.length = 0
    const feet = player.character.feet
    const d = Math.hypot(feet.x - boss.data.x, feet.z - boss.data.z)
    minDist = Math.min(minDist, d)
  }
  const feet = player.character.feet
  const endDist = Math.hypot(feet.x - boss.data.x, feet.z - boss.data.z)
  return { startDist, endDist, minDist, states, events }
}

test('近战 Boss 在真实物理里会走位近身，而不是原地推墙', async () => {
  await initPhysics()
  for (const kind of ['boss', 'bellkeeper', 'golem']) {
    const r = simulate('walk-' + kind, kind, 14, 240)
    assert.ok(
      r.minDist < r.startDist - 3,
      kind + ' 四秒内没靠近玩家：' + r.startDist.toFixed(1) + ' → ' + r.minDist.toFixed(1),
    )
    assert.ok(r.states.has('chase') || r.states.has('attack'), kind + ' 从没进入追击/攻击')
  }
})

test('末班车长保持枪线：远了会贴近射程，贴脸会后撤', async () => {
  await initPhysics()
  // 14m：在 20m 射程内，直接站定开枪，不需要靠近。
  const far = simulate('conductor-far', 'conductor', 14, 200)
  assert.ok(far.states.has('attack'), '14m 没有进入射击状态')
  assert.ok(far.events.length > 0, '一枪都没开')
  // 4m：进入 keepDistance(8m) 内，应当后撤而不是让玩家贴脸。
  const close = simulate('conductor-close', 'conductor', 4, 200)
  assert.ok(close.endDist > close.startDist + 0.8, '贴脸后没有后撤：' + close.startDist.toFixed(1) + ' → ' + close.endDist.toFixed(1))
})
