/**
 * 断线重连的回归测试。
 *
 * 这里锁住的是三层"看起来都在动、其实身体没动"的故障：
 * 1. 断线保留期内回来 → 必须接管原角色，而不是新建一个；
 * 2. 旧 socket 还没关（半开连接）新连接就来了 → 也必须接管，并把旧连接踢掉，
 *    否则世界里会永远多一个没人控制的幽灵；
 * 3. 新连接的输入 seq 从 1 重新计数 → ackSeq/队列必须归零，否则服务端把所有
 *    新输入都当成重发的旧包丢掉。
 *
 * 用假的 WebSocket 直接驱动 World，不经过 HTTP/WS 层：这能精确控制"旧连接
 * 什么时候关、新连接什么时候来"的先后顺序，而这正是幽灵人最容易出现的窗口。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { Msg, decodeSnapshot, type PlayerInput, type Snapshot } from '../shared/src/protocol.ts'
import { TICK_MS } from '../shared/src/constants.ts'
import { LEVELS } from '../shared/src/level.ts'
import { initPhysics } from '../shared/src/worldbuild.ts'
import { World } from '../server/src/world.ts'
import type { WebSocket } from 'ws'

interface FakeSocket {
  readyState: number
  sent: ArrayBuffer[]
  closedWith: { code?: number; reason?: string } | null
  send(buffer: ArrayBuffer): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
}

function fakeSocket(): FakeSocket {
  return {
    readyState: 1,
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

/** 一张空图：没有怪、没有墙，只有出生点。移动与网络状态才是被测对象。 */
function testLevel(id: string) {
  const base = LEVELS['marsh-p0']!
  return {
    ...base,
    id,
    boxes: [],
    nests: [],
    clues: [],
    extracts: [],
    searchSpots: [],
    doors: [],
    traps: [],
    lamps: [],
    spawns: [{ x: 0, y: base.groundY, z: 0 }],
  } as never
}

function input(seq: number, forward = 1): PlayerInput {
  return {
    seq,
    dtMs: TICK_MS,
    forward,
    right: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
  }
}

/** 推进一整个 tick（全部九个阶段）。World.step 是私有的，测试里直接打穿。 */
function tick(world: World): void {
  ;(world as unknown as { step(): void }).step()
}

function latestSnapshot(socket: FakeSocket): Snapshot | null {
  for (let i = socket.sent.length - 1; i >= 0; i--) {
    const buffer = socket.sent[i]!
    if (new DataView(buffer).getUint8(0) !== Msg.Snapshot) continue
    return decodeSnapshot(buffer)
  }
  return null
}

interface Internals {
  players: Map<
    number,
    {
      ackSeq: number
      ackedTick: number
      detachedAt: number
      alive: boolean
      health: number
      maxHealth: number
      lastLoot: Uint8Array | null
      queue: PlayerInput[]
      character: { feet: { x: number; y: number; z: number } }
    }
  >
}

test('重连：断线保留期内接管原角色，新会话的 seq 从 1 重新生效', async () => {
  await initPhysics()
  const world = new World({ id: 'reconnect-resume', level: testLevel('reconnect-resume') })
  const internals = world as unknown as Internals

  const socketA = fakeSocket()
  const joined = world.addPlayer(socketA as unknown as WebSocket, '猎人', 'user-1')!
  assert.equal(joined.resumed, false)
  const player = internals.players.get(joined.id)!

  // 先让角色真的走一段：会话正常时输入必须被消费。
  for (let seq = 1; seq <= 5; seq++) {
    world.receiveInput(joined.id, [input(seq)], 0)
    tick(world)
  }
  assert.equal(player.ackSeq, 5)
  const movedBefore = { ...player.character.feet }

  // 模拟网络断开：旧连接被服务端标记成 detached，角色保留。
  world.detachPlayer(joined.id, socketA as unknown as WebSocket)
  assert.ok(player.detachedAt > 0)
  // 模拟旧的"只在变化时发"缓存：重连后必须强制重发。
  player.lastLoot = new Uint8Array([1, 2, 3])
  player.queue.push(input(9999))

  const socketB = fakeSocket()
  const resumed = world.addPlayer(socketB as unknown as WebSocket, '猎人', 'user-1')!
  assert.equal(resumed.id, joined.id, '重连必须回到同一个 player id')
  assert.equal(resumed.resumed, true)
  assert.equal(player.detachedAt, 0)
  assert.equal(player.ackSeq, 0, '新会话的 ackSeq 必须清零')
  assert.equal(player.ackedTick, 0)
  assert.deepEqual(player.queue, [], '旧队列必须清空，否则旧 seq 会推高 ackSeq')
  assert.equal(player.lastLoot, null, '战利品必须强制重发一次')

  // 新客户端从 seq 1 重新开始：必须被接受并推进物理。
  for (let seq = 1; seq <= 5; seq++) {
    world.receiveInput(joined.id, [input(seq)], 0)
    tick(world)
  }
  assert.equal(player.ackSeq, 5, '新会话的 seq 必须能被消费')
  const movedAfter = player.character.feet
  const travelled = Math.hypot(movedAfter.x - movedBefore.x, movedAfter.z - movedBefore.z)
  assert.ok(travelled > 0.05, '重连后输入没有让角色移动：' + travelled.toFixed(3) + 'm')

  // 快照里的 ackSeq 也必须是新会话的，客户端才能用它做预测校正。
  const snapshot = latestSnapshot(socketB)
  assert.ok(snapshot, '重连后没有收到快照')
  const me = snapshot!.players.find((entry) => entry.id === joined.id)
  assert.ok(me, '快照里没有自己')
  assert.ok(me!.ackSeq > 0, '快照没有回传新会话的 ackSeq')
})

test('重连：旧 socket 还开着（半开连接）时，新连接也必须接管而不是新建角色', async () => {
  await initPhysics()
  const world = new World({ id: 'reconnect-takeover', level: testLevel('reconnect-takeover') })
  const internals = world as unknown as Internals

  const socketA = fakeSocket()
  const joined = world.addPlayer(socketA as unknown as WebSocket, '猎人', 'user-2')!
  const player = internals.players.get(joined.id)!
  world.receiveInput(joined.id, [input(1)], 0)
  tick(world)
  player.queue.push(input(5000, 0))

  const socketB = fakeSocket()
  const resumed = world.addPlayer(socketB as unknown as WebSocket, '猎人', 'user-2')!

  assert.equal(resumed.id, joined.id, '半开连接也必须接管原角色')
  assert.equal(internals.players.size, 1, '世界里不能出现第二个幽灵角色')
  assert.equal(world.ownsPlayer(joined.id, socketB as unknown as WebSocket), true)
  assert.equal(world.ownsPlayer(joined.id, socketA as unknown as WebSocket), false)
  assert.equal(socketA.closedWith?.code, 4002, '旧连接必须被主动踢掉')
  assert.equal(player.ackSeq, 0)
  assert.deepEqual(player.queue, [])

  // 旧连接迟到的 close / 错误不能删掉刚接管的角色。
  world.detachPlayer(joined.id, socketA as unknown as WebSocket)
  assert.equal(player.detachedAt, 0)
  world.removePlayer(joined.id, socketA as unknown as WebSocket)
  assert.equal(internals.players.has(joined.id), true)

  // 新连接的输入照常生效。
  world.receiveInput(joined.id, [input(1)], 0)
  tick(world)
  assert.equal(player.ackSeq, 1)
})

test('重连：断线期间被打死，回来必须复活而不是一具能动的尸体', async () => {
  await initPhysics()
  const world = new World({ id: 'reconnect-dead', level: testLevel('reconnect-dead') })
  const internals = world as unknown as Internals

  const socketA = fakeSocket()
  const joined = world.addPlayer(socketA as unknown as WebSocket, '猎人', 'user-3')!
  const player = internals.players.get(joined.id)!

  player.alive = false
  player.health = 0
  world.detachPlayer(joined.id, socketA as unknown as WebSocket)

  const socketB = fakeSocket()
  world.addPlayer(socketB as unknown as WebSocket, '猎人', 'user-3')!
  assert.equal(player.alive, true, '重连后必须复活')
  assert.equal(player.health, player.maxHealth)

  // 复活后输入必须能推动角色。
  world.receiveInput(joined.id, [input(1)], 0)
  tick(world)
  assert.equal(player.ackSeq, 1)
})
