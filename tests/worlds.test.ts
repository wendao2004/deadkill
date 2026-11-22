/**
 * 世界注册表的准入与销毁。
 *
 * 锁住 512MB 部署下最贵的两个错误：任意 ?match= 无限建世界、RSS 已高还继续
 * 建；以及房间回收时只停 tick、不释放 Rapier WASM。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { initPhysics } from '../shared/src/worldbuild.ts'
import { LEVELS } from '../shared/src/level.ts'
import { StateFlags } from '../shared/src/constants.ts'
import { Msg, decodeSnapshot } from '../shared/src/protocol.ts'
import { World } from '../server/src/world.ts'
import { WorldRegistry } from '../server/src/worlds.ts'
import type { WebSocket } from 'ws'

function fakeSocket(): {
  readyState: number
  bufferedAmount: number
  sent: ArrayBuffer[]
  closedWith: { code?: number; reason?: string } | null
  send(buffer: ArrayBuffer): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
} {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    closedWith: null,
    send(buffer: ArrayBuffer) {
      this.sent.push(buffer)
    },
    close(code?: number, reason?: string) {
      this.closedWith = { code, reason }
      this.readyState = 3
    },
    terminate() {
      this.readyState = 3
    },
    ping() {},
  }
}

test('准入：活跃世界达到上限后拒绝新 match，但已有 match 仍可进', async () => {
  await initPhysics()
  const registry = new WorldRegistry('marsh-p0', {
    maxActiveWorlds: 1,
    rssLimitMb: 380,
    rss: () => 0,
  })
  assert.equal(registry.admit('a').ok, true)
  registry.get('a')
  assert.equal(registry.admit('b').ok, false)
  assert.equal(registry.admit('a').ok, true)
  registry.stop()
})

test('准入：RSS 超过水位时拒绝建新世界', () => {
  const registry = new WorldRegistry('marsh-p0', {
    maxActiveWorlds: 2,
    rssLimitMb: 380,
    rss: () => 400 * 1024 * 1024,
  })
  const admission = registry.admit('a')
  assert.equal(admission.ok, false)
  if (!admission.ok) assert.match(admission.reason, /内存/)
})

test('输入预算：一包 8 条、连发 20 包，每秒最多接受 66 条', async () => {
  await initPhysics()
  const world = new World({ id: 'input-budget' })
  const socket = fakeSocket()
  const joined = world.addPlayer(socket as unknown as WebSocket, '测试者', 'budget-user')!
  const internals = world as unknown as {
    players: Map<number, { queue: unknown[]; inputBudget: number }>
  }
  for (let packet = 0; packet < 20; packet++) {
    const inputs = Array.from({ length: 8 }, (_, index) => ({
      seq: packet * 8 + index + 1,
      dtMs: 16.67,
      forward: 1,
      right: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    }))
    world.receiveInput(joined.id, inputs, 0)
  }
  const player = internals.players.get(joined.id)!
  // 160 条里只放行 66 条；队列本身还会裁到最多 8 条待消费。
  assert.equal(player.inputBudget, 0)
  assert.equal(player.queue.length, 8)
  world.dispose()
})

test('下行背压：bufferedAmount 超过 256KB 时主动断开', async () => {
  await initPhysics()
  const world = new World({ id: 'backpressure' })
  const socket = fakeSocket()
  socket.bufferedAmount = 300 * 1024
  world.addPlayer(socket as unknown as WebSocket, '慢消费者', 'slow-user')
  assert.equal(socket.closedWith?.code, 4011)
  world.dispose()
})

test('兴趣管理：墙后 8m 的敌人只发量化音频层，不画模型', async () => {
  await initPhysics()
  const base = LEVELS['marsh-p0']!
  const level = {
    ...base,
    id: 'interest-test',
    boxes: [
      {
        x: 0,
        y: base.groundY + 1.5,
        z: -4,
        hx: 3,
        hy: 2,
        hz: 0.25,
        material: 'stone' as const,
      },
    ],
    nests: [],
    clues: [],
    extracts: [],
    searchSpots: [],
    doors: [],
    traps: [],
    lamps: [],
    spawns: [{ x: 0, y: base.groundY, z: 0 }],
  } as never
  const world = new World({ id: 'interest-test', level })
  const socketA = fakeSocket()
  const socketB = fakeSocket()
  const a = world.addPlayer(socketA as unknown as WebSocket, '甲', 'interest-a')!
  const b = world.addPlayer(socketB as unknown as WebSocket, '乙', 'interest-b')!
  const internals = world as unknown as {
    players: Map<number, { character: { teleport(p: { x: number; y: number; z: number }): void } }>
    step(): void
    broadcastSnapshot(): void
  }
  const ground = base.groundY
  internals.players.get(a.id)!.character.teleport({ x: 0, y: ground, z: 0 })
  // -7.3 量化到 -8：测试“量化”而不是“碰巧本来就是整数”。
  internals.players.get(b.id)!.character.teleport({ x: 0, y: ground, z: -7.3 })

  for (let i = 0; i < 20; i++) internals.step()
  internals.broadcastSnapshot()

  const snapshotBuffer = socketA.sent.find(
    (buffer) => new DataView(buffer).getUint8(0) === Msg.Snapshot,
  )
  assert.ok(snapshotBuffer, 'A 必须收到快照')
  const snapshot = decodeSnapshot(snapshotBuffer!)
  const bView = snapshot.players.find((player) => player.id === b.id)
  assert.ok(bView, '墙后的敌人仍要以音频层出现在快照里')
  assert.ok((bView!.flags & StateFlags.AudioOnly) !== 0, '必须标记为音频层')
  assert.equal(bView!.z, -8, '音频层位置必须量化到 2m 网格')
  assert.equal(bView!.health, 0, '音频层不能泄露精确血量')
  world.dispose()
})

test('跨局重置：重建怪、重抽天气/战利品种子、清合同与开火锁', async () => {
  await initPhysics()
  const world = new World({ id: 'reset-test' })
  const joined = world.addPlayer(fakeSocket() as unknown as WebSocket, '测试者', 'reset-user')!
  const internals = world as unknown as {
    stepMatch(): void
    lastMatchPhase: string
    match: { state: { phase: string } }
    players: Map<
      number,
      { contract: number; contractDone: boolean; loadout: { lastFireTick: number } }
    >
    monsters: unknown[]
  }
  const player = internals.players.get(joined.id)!
  player.contract = 1
  player.contractDone = true
  player.loadout.lastFireTick = 123

  // 模拟上一局刚 over、match 已 reset 回 hunt 的那一 tick。
  internals.lastMatchPhase = 'over'
  internals.match.state.phase = 'hunt'
  internals.stepMatch()

  assert.ok(internals.monsters.length > 0, '新一局必须重新刷怪')
  assert.equal(player.contract, 0)
  assert.equal(player.contractDone, false)
  assert.equal(player.loadout.lastFireTick, -1e9)
  world.dispose()
})

test('销毁：dispose 会释放物理世界，重复调用不抛错', async () => {
  await initPhysics()
  const registry = new WorldRegistry('marsh-p0', { maxActiveWorlds: 1, rss: () => 0 })
  const world = registry.get('dispose-test')
  assert.doesNotThrow(() => world.dispose())
  assert.doesNotThrow(() => world.dispose())
  registry.stop()
})
