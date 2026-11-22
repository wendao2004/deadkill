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
import { EventKind, Msg, decodeEvents, decodeSnapshot } from '../shared/src/protocol.ts'
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
  const worldA = registry.get('a')
  worldA.addPlayer(fakeSocket() as unknown as WebSocket, '占位', 'admit-a')
  assert.equal(registry.admit('b').ok, false)
  assert.equal(registry.admit('a').ok, true)
  registry.stop()
})

test('准入：空世界不占名额，两个弃房不能锁死新 match', async () => {
  await initPhysics()
  const registry = new WorldRegistry('marsh-p0', {
    maxActiveWorlds: 2,
    rssLimitMb: 380,
    rss: () => 0,
  })
  registry.get('a')
  registry.get('b')
  assert.equal(registry.admit('c').ok, true, '空世界不应占活跃名额')
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

test('追帧输入：一包 8 条每 tick 只推进一次 Character.step，冷却不加速', async () => {
  await initPhysics()
  const world = new World({ id: 'input-cooldown' })
  const socket = fakeSocket()
  const joined = world.addPlayer(socket as unknown as WebSocket, '追帧者', 'cooldown-user')!
  const internals = world as unknown as {
    step(): void
    players: Map<number, { ackSeq: number; character: { jumpCooldown: number } }>
  }
  const player = internals.players.get(joined.id)!
  player.character.jumpCooldown = 1
  world.receiveInput(
    joined.id,
    Array.from({ length: 8 }, (_, index) => ({
      seq: index + 1,
      dtMs: 16.67,
      forward: 1,
      right: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    })),
    0,
  )
  internals.step()
  // 只跑一次 TICK_DT（约 0.0167s）；旧实现会跑 8 次，剩约 0.866。
  assert.ok(player.character.jumpCooldown > 0.95, `冷却被推进了多次：${player.character.jumpCooldown}`)
  assert.equal(player.ackSeq, 8, '最新输入序号必须被确认')
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
        hx: 30,
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
    players: Map<
      number,
      {
        reloading: boolean
        character: { teleport(p: { x: number; y: number; z: number }): void }
      }
    >
    step(): void
    broadcastSnapshot(): void
    flushEvents(): void
    pendingEvents: Array<{
      kind: number
      playerId: number
      origin: { x: number; y: number; z: number }
      dir: { x: number; y: number; z: number }
      weaponId: number
    }>
  }
  const ground = base.groundY
  internals.players.get(a.id)!.character.teleport({ x: 0, y: ground, z: 0 })
  // -7.3 量化到 -8：测试“量化”而不是“碰巧本来就是整数”。
  internals.players.get(b.id)!.character.teleport({ x: 0, y: ground, z: -7.3 })
  for (let i = 0; i < 20; i++) internals.step()
  internals.broadcastSnapshot()
  const silentBuffer = socketA.sent
    .filter((buffer) => new DataView(buffer).getUint8(0) === Msg.Snapshot)
    .at(-1)
  assert.equal(
    decodeSnapshot(silentBuffer!).players.find((player) => player.id === b.id),
    undefined,
    '站桩且无声的墙后目标不应暴露位置',
  )

  // 音频层只下发“正在移动/换弹”的敌人；站桩无声目标不该暴露位置。
  // 放到 step 之后设置：reload 状态机会在 tick 里把没有换弹动作的标记清掉。
  internals.players.get(b.id)!.reloading = true
  internals.broadcastSnapshot()

  const snapshotBuffer = socketA.sent
    .filter((buffer) => new DataView(buffer).getUint8(0) === Msg.Snapshot)
    .at(-1)
  assert.ok(snapshotBuffer, 'A 必须收到快照')
  const snapshot = decodeSnapshot(snapshotBuffer!)
  const bView = snapshot.players.find((player) => player.id === b.id)
  assert.ok(bView, '墙后的敌人仍要以音频层出现在快照里')
  assert.ok((bView!.flags & StateFlags.AudioOnly) !== 0, '必须标记为音频层')
  assert.equal(bView!.z, -8, '音频层位置必须量化到 2m 网格')
  assert.equal(bView!.health, 0, '音频层不能泄露精确血量')
  assert.equal(bView!.vx, 0, '音频层不能泄露精确速度')
  assert.equal(bView!.vz, 0, '音频层不能泄露精确速度')
  assert.ok(Math.abs(bView!.yaw) < 0.01, '音频层不能泄露瞄准朝向')
  assert.ok(Math.abs(bView!.pitch) < 0.01, '音频层不能泄露瞄准朝向')

  // 通视控制组：同一侧、无遮挡的目标必须恢复精确位姿。
  const bPlayer = internals.players.get(b.id)!
  bPlayer.character.teleport({ x: 0, y: ground, z: -2 })
  bPlayer.reloading = true
  for (let i = 0; i < 6; i++) internals.step()
  internals.broadcastSnapshot()
  const visibleBuffer = socketA.sent
    .filter((buffer) => new DataView(buffer).getUint8(0) === Msg.Snapshot)
    .at(-1)
  const visibleView = decodeSnapshot(visibleBuffer!).players.find((player) => player.id === b.id)
  assert.ok(visibleView, '通视目标必须在快照里')
  assert.equal((visibleView!.flags & StateFlags.AudioOnly) !== 0, false, '通视目标不能是音频层')
  assert.equal(visibleView!.z, -2, '通视目标必须给精确位置')

  // 距离控制组：>45m 且墙后，不再下发。
  bPlayer.character.teleport({ x: 50, y: ground, z: -7.3 })
  for (let i = 0; i < 6; i++) internals.step()
  internals.broadcastSnapshot()
  const farBuffer = socketA.sent
    .filter((buffer) => new DataView(buffer).getUint8(0) === Msg.Snapshot)
    .at(-1)
  const farView = decodeSnapshot(farBuffer!).players.find((player) => player.id === b.id)
  assert.equal(farView, undefined, '45m 外的墙后目标不应下发')

  // 事件兴趣：墙后 7m 的枪声只给 4m 量化原点与零方向，不给精确眼位。
  bPlayer.character.teleport({ x: 0, y: ground, z: -7.3 })
  for (let i = 0; i < 3; i++) internals.step()
  internals.pendingEvents.push({
    kind: EventKind.Shot,
    playerId: b.id,
    origin: { x: 0.3, y: 1.6, z: -7.3 },
    dir: { x: 0, y: 0, z: -1 },
    weaponId: 1,
  })
  internals.flushEvents()
  const eventBuffer = socketA.sent
    .filter((buffer) => new DataView(buffer).getUint8(0) === Msg.Event)
    .at(-1)
  assert.ok(eventBuffer, '墙后枪声仍要作为可听事件下发')
  const shot = decodeEvents(eventBuffer!).find((event) => event.kind === EventKind.Shot)
  assert.ok(shot && shot.kind === EventKind.Shot)
  assert.equal(shot!.origin.z, -8, '事件原点也必须量化到 4m 网格')
  assert.deepEqual(shot!.dir, { x: 0, y: 0, z: 0 }, '音频事件不能泄露精确朝向')

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


test('RTT：按客户端 ack 的快照年龄估计，不被“距上次发送”压到 120ms', async () => {
  await initPhysics()
  const world = new World({ id: 'rtt-ack' })
  const joined = world.addPlayer(fakeSocket() as unknown as WebSocket, '延迟', 'rtt-user')!
  const internals = world as unknown as {
    players: Map<
      number,
      {
        rttMs: number
        lastSnapshotTick: number
        snapshotSentAt: Map<number, number>
      }
    >
  }
  const player = internals.players.get(joined.id)!
  player.lastSnapshotTick = 10
  player.snapshotSentAt.set(10, performance.now() - 160)
  world.receiveInput(
    joined.id,
    [{ seq: 1, dtMs: 16.67, forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0 }],
    10,
  )
  assert.ok(player.rttMs >= 140, `RTT 应接近 160ms，实际 ${player.rttMs.toFixed(0)}`)
  world.dispose()
})

test('追帧输入：普通两条输入分两 tick 消费，ack 与 Character.step 同步', async () => {
  await initPhysics()
  const world = new World({ id: 'ack-step' })
  const joined = world.addPlayer(fakeSocket() as unknown as WebSocket, '步进', 'ack-user')!
  const internals = world as unknown as {
    players: Map<number, { ackSeq: number }>
    step(): void
  }
  const player = internals.players.get(joined.id)!
  world.receiveInput(
    joined.id,
    [
      { seq: 1, dtMs: 16.67, forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0 },
      { seq: 2, dtMs: 16.67, forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0 },
    ],
    0,
  )
  internals.step()
  assert.equal(player.ackSeq, 1, '第一条输入只 step 一次，只 ack 一条')
  internals.step()
  assert.equal(player.ackSeq, 2, '第二条在下一 tick 被消费并 ack')
  world.dispose()
})


test('编队：重复 joinTeam 同一队不再传送回出生点', async () => {
  await initPhysics()
  const world = new World({ id: 'team-teleport' })
  const joined = world.addPlayer(fakeSocket() as unknown as WebSocket, '不回城', 'team-user')!
  const internals = world as unknown as {
    players: Map<
      number,
      {
        team: number
        character: { feet: { x: number; y: number; z: number }; teleport(p: { x: number; y: number; z: number }): void }
      }
    >
    joinTeam(player: unknown, team: number): void
  }
  const player = internals.players.get(joined.id)!
  player.character.teleport({ x: 12, y: 0, z: 12 })
  const before = { ...player.character.feet }
  internals.joinTeam(player, player.team)
  assert.deepEqual(player.character.feet, before, '同队重发配装不能瞬移回出生点')
  world.dispose()
})


test('配装：本命第一次 Loadout 后切 squad 不再传送', async () => {
  await initPhysics()
  const world = new World({ id: 'loadout-lock' })
  const joined = world.addPlayer(fakeSocket() as unknown as WebSocket, '锁队', 'loadout-user')!
  const internals = world as unknown as {
    players: Map<
      number,
      {
        character: {
          feet: { x: number; y: number; z: number }
          teleport(p: { x: number; y: number; z: number }): void
        }
      }
    >
  }
  const player = internals.players.get(joined.id)!
  world.receiveLoadout(joined.id, 1, 0, 0, 0, 0, 1, '', undefined)
  player.character.teleport({ x: 40, y: 0, z: 40 })
  const before = { ...player.character.feet }
  world.receiveLoadout(joined.id, 1, 0, 0, 0, 0, 0, '', undefined)
  assert.deepEqual(player.character.feet, before, '本命第二次 Loadout 不能改队传送')
  world.dispose()
})
