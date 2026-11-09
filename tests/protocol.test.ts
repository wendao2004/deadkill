import test from 'node:test'
import assert from 'node:assert/strict'

// 用相对路径而不是 '@dk/shared'：仓库根的 node_modules 下没有 @dk/* 的
// workspace 链接（依赖只装在 shared/node_modules 里），从根目录跑
// 'node --test' 时唯一保证能解析的就是相对路径。
import {
  decodeAck,
  decodeEvents,
  decodeHello,
  decodeInputPacket,
  decodeSnapshot,
  decodeSwitchSlot,
  decodeWelcome,
  encodeAck,
  encodeEvents,
  encodeHello,
  encodeInputPacket,
  encodeSnapshot,
  encodeSwitchSlot,
  encodeWelcome,
  EventKind,
  INPUT_SIZE,
  MAX_EVENT_SIZE,
  MAX_INPUTS_PER_PACKET,
  MONSTER_SNAPSHOT_SIZE,
  Msg,
  PLAYER_SNAPSHOT_SIZE,
  PROTOCOL_VERSION,
  SNAPSHOT_HEADER,
  SWITCH_SLOT_SIZE,
  WELCOME_SIZE,
} from '../shared/src/index.ts'
import type { GameEvent, MonsterSnapshot, PlayerInput, PlayerSnapshot } from '../shared/src/index.ts'

// ---------------------------------------------------------------- 夹具

function player(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    id: 1,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    health: 100,
    flags: 0,
    weaponId: 1,
    ammo: 8,
    reserve: 32,
    slot: 0,
    ackSeq: 0,
    ...overrides,
  }
}

function monster(overrides: Partial<MonsterSnapshot> = {}): MonsterSnapshot {
  return {
    id: 1,
    kind: 0,
    state: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    health: 100,
    ...overrides,
  }
}

function input(seq: number, overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    seq,
    dtMs: 16,
    forward: 0,
    right: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
    ...overrides,
  }
}

/** 协议里所有角度都用同一个 u16 映射，量化误差上限是一个量化步长。 */
const ANGLE_TOLERANCE = (2 * Math.PI) / 65535

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    label + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual,
  )
}

/**
 * 截断缓冲区的观测结果（在本仓库的 Node 24 上实测）：
 * 每个解码器都直接对着 DataView 读，不做长度校验，所以越界一律抛
 * RangeError: Offset is outside the bounds of the DataView。
 * 也就是说"解码器对截断数据是崩溃而不是返回半截数据"——这比静默读乱
 * 数据安全，但意味着调用方必须自己兜住异常。这里把这个约定钉死：
 * 一旦有人把解码改成"尽力解析"，这些用例会立刻红。
 */
function assertTruncationThrows(label: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RangeError, label + ': 期望 RangeError，实际 ' + String(error))
    assert.match((error as RangeError).message, /outside the bounds of the DataView/)
    return true
  }, label)
}

// ---------------------------------------------------------------- hello

test('hello: 4 字节头 + utf8 昵称，版本号与 PROTOCOL_VERSION 一致', () => {
  const buffer = encodeHello('ash')
  assert.equal(buffer.byteLength, 4 + 3)
  const hello = decodeHello(buffer)
  assert.equal(hello.version, PROTOCOL_VERSION)
  assert.equal(hello.nickname, 'ash')

  // 昵称按 UTF-8 字节长度写进 u8 长度位，超长在编码侧截到 24 个字符。
  const long = encodeHello('x'.repeat(30))
  assert.equal(long.byteLength, 4 + 24)
  assert.equal(decodeHello(long).nickname.length, 24)
})

// ---------------------------------------------------------------- welcome

test('welcome: 定长 WELCOME_SIZE 字节', () => {
  assert.equal(WELCOME_SIZE, 25)

  const buffer = encodeWelcome({
    playerId: 3,
    tickRate: 60,
    snapshotRate: 20,
    serverTime: 1234.5,
    spawn: { x: 1.5, y: 0.02, z: -2.25 },
  })
  assert.equal(buffer.byteLength, WELCOME_SIZE)

  const welcome = decodeWelcome(buffer)
  assert.equal(welcome.playerId, 3)
  assert.equal(welcome.tickRate, 60)
  assert.equal(welcome.snapshotRate, 20)
  // serverTime 是 f64：必须按位还原。
  assert.equal(welcome.serverTime, 1234.5)
  // 出生点是 f32，只能按容差比，但三个分量都必须带（只带 y 会让客户端
  // 出生在 z=0 的直线上）。
  assertClose(welcome.spawn.x, 1.5, 1e-6, 'spawn.x')
  assertClose(welcome.spawn.y, 0.02, 1e-6, 'spawn.y')
  assertClose(welcome.spawn.z, -2.25, 1e-6, 'spawn.z')
})

// ---------------------------------------------------------------- 输入包

test('input packet: n = 1 / 2 / MAX_INPUTS_PER_PACKET 的总长恰好是 6 + n * INPUT_SIZE', () => {
  assert.equal(INPUT_SIZE, 19)

  for (const n of [1, 2, MAX_INPUTS_PER_PACKET]) {
    const inputs = Array.from({ length: n }, (_, i) =>
      input(1000 + i, { dtMs: 16, forward: 1, right: -1, yaw: 0.5, pitch: -0.25, buttons: 0b10101 }),
    )
    const buffer = encodeInputPacket(inputs, 777)
    assert.equal(buffer.byteLength, 6 + n * INPUT_SIZE, 'n=' + n)

    const decoded = decodeInputPacket(buffer)
    assert.equal(decoded.inputs.length, n, 'n=' + n)
    assert.equal(decoded.ackedTick, 777, 'n=' + n)
    for (let i = 0; i < n; i++) {
      const got = decoded.inputs[i]!
      const want = inputs[i]!
      assert.equal(got.seq, want.seq)
      assert.equal(got.dtMs, 16)
      assert.equal(got.forward, 127)
      assert.equal(got.right, -127)
      assert.equal(got.buttons, want.buttons)
      assertClose(got.yaw, want.yaw, ANGLE_TOLERANCE, 'yaw[' + i + ']')
      assertClose(got.pitch, want.pitch, ANGLE_TOLERANCE, 'pitch[' + i + ']')
      assertClose(got.aimYaw ?? NaN, want.yaw, ANGLE_TOLERANCE, 'aimYaw[' + i + ']')
      assertClose(got.aimPitch ?? NaN, want.pitch, ANGLE_TOLERANCE, 'aimPitch[' + i + ']')
    }
  }
})

test('input packet: 超过 MAX_INPUTS_PER_PACKET 的输入被截断，解码侧也按上限封顶', () => {
  const tooMany = Array.from({ length: MAX_INPUTS_PER_PACKET + 12 }, (_, i) => input(i))
  const buffer = encodeInputPacket(tooMany)
  assert.equal(buffer.byteLength, 6 + MAX_INPUTS_PER_PACKET * INPUT_SIZE)
  assert.equal(decodeInputPacket(buffer).inputs.length, MAX_INPUTS_PER_PACKET)

  // 头部声称 n=200 但仅有一个输入的包：不能"尽力解析"出一堆垃圾。
  const one = encodeInputPacket([input(1)])
  new DataView(one).setUint8(1, 200)
  assertTruncationThrows('input packet 头部 n=200', () => decodeInputPacket(one))
})

test('input packet: forward/right 量化到 i8，buttons 只留低 8 位', () => {
  // clampI8: |v| >= 1 压到 +/-127，其余四舍五入（0.5*127 = 63.5 -> 64）。
  const decoded = decodeInputPacket(
    encodeInputPacket([input(0, { forward: 0.5, right: 2, buttons: 300 })]),
  ).inputs[0]!
  assert.equal(decoded.forward, 64)
  assert.equal(decoded.right, 127)
  assert.equal(decoded.buttons, 300 & 0xff)

  assert.equal(decodeInputPacket(encodeInputPacket([input(0, { forward: -2 })])).inputs[0]!.forward, -127)
})

// ---------------------------------------------------------------- 快照

test('snapshot: 总长恰好是头 SNAPSHOT_HEADER + n * 玩家 + m * 怪物', () => {
  // v2 的三段式布局：17 字节头 + 玩家段 + 怪物段。任何一个尺寸常数被
  // "顺手调一下"都会让客户端解析出垃圾，所以这里连常数本身一起钉死。
  // v3：玩家段多了 1 字节 slot（33 → 34），flags 多了 Switching 位。
  // v4：只动了目标包（尾部多 1 字节 clueMask），快照布局没变。
  // v7：目标包尾部多 1 字节 modifier，快照布局仍然没变。
  // v10：玩家快照多 1 字节 reserve（34 → 35）。
  // v11：四种地图 Boss 与 BossPulse 事件，快照布局不变。
  // v12：flags 从 u8 扩到 u16（35 → 36），攀爬位进快照。
  // v13：目标包加世界事件（16 → 23 字节），配装包加合同 1 字节；快照布局不变。
  // v14：目标包加门状态位图 1 字节（23 → 24）。
  assert.equal(PROTOCOL_VERSION, 14)
  assert.equal(SNAPSHOT_HEADER, 17)
  assert.equal(PLAYER_SNAPSHOT_SIZE, 36)
  assert.equal(MONSTER_SNAPSHOT_SIZE, 20)

  for (const n of [0, 1, 3]) {
    for (const m of [0, 1, 2]) {
      // 用 0.5 毫米级的取值：既在毫米映射上无损，又避开 -0（-0 编码成
      // int32 后读回来是 +0，见下面量化用例的说明）。
      const players = Array.from({ length: n }, (_, i) => player({ id: i + 1, x: i + 0.5, z: -(i + 0.5) }))
      const monsters = Array.from({ length: m }, (_, i) => monster({ id: 100 + i, x: i + 0.5, z: -(i + 0.5) }))
      const buffer = encodeSnapshot({ tick: 42, serverTime: 987.25, players, monsters })
      assert.equal(
        buffer.byteLength,
        SNAPSHOT_HEADER + n * PLAYER_SNAPSHOT_SIZE + m * MONSTER_SNAPSHOT_SIZE,
        'n=' + n + ' m=' + m,
      )

      const decoded = decodeSnapshot(buffer)
      assert.equal(decoded.tick, 42)
      assert.equal(decoded.serverTime, 987.25)
      assert.equal(decoded.players.length, n, 'n=' + n + ' m=' + m)
      assert.equal(decoded.monsters.length, m, 'n=' + n + ' m=' + m)
      for (let i = 0; i < n; i++) {
        assert.equal(decoded.players[i]!.id, i + 1)
        assert.equal(decoded.players[i]!.x, i + 0.5)
        assert.equal(decoded.players[i]!.z, -(i + 0.5))
      }
      for (let i = 0; i < m; i++) {
        assert.equal(decoded.monsters[i]!.id, 100 + i)
        assert.equal(decoded.monsters[i]!.x, i + 0.5)
        assert.equal(decoded.monsters[i]!.z, -(i + 0.5))
      }
    }
  }
})

test('snapshot: slot 单独占 1 字节，夹在 ammo 与 ackSeq 之间（v3 布局）', () => {
  // 槽位是客户端换模型/换准星的唯一依据，所以它的偏移必须是契约的一部分：
  // 挪到 ackSeq 后面看起来更"整洁"，但会让旧客户端的 ackSeq 读成 slot。
  const buffer = encodeSnapshot({
    tick: 1,
    serverTime: 0,
    players: [player({ weaponId: 10, ammo: 0, slot: 2, ackSeq: 0x01020304 })],
    monsters: [],
  })
  const view = new DataView(buffer)
  const off = SNAPSHOT_HEADER
  assert.equal(view.getUint16(off + 26, true), 0) // flags（u16）
  assert.equal(view.getUint8(off + 28), 10) // weaponId
  assert.equal(view.getUint8(off + 29), 0) // ammo
  assert.equal(view.getUint8(off + 30), 32) // reserve
  assert.equal(view.getUint8(off + 31), 2) // slot
  assert.equal(view.getUint32(off + 32, true), 0x01020304) // ackSeq

  const decoded = decodeSnapshot(buffer)
  assert.equal(decoded.players[0]!.slot, 2)
  assert.equal(decoded.players[0]!.ackSeq, 0x01020304)
})

test('snapshot: 怪物段紧跟在玩家段之后，偏移 17 + n * 36 才是第一个怪物记录', () => {
  const buffer = encodeSnapshot({
    tick: 5,
    serverTime: 1.5,
    players: [player({ id: 7, x: 1.5, z: -1.5 })],
    monsters: [monster({ id: 900, kind: 1, state: 2, x: 2.5, z: -2.5 }), monster({ id: 901, x: 3.5, z: -3.5 })],
  })
  const view = new DataView(buffer)

  // 头：kind / tick / serverTime / 玩家数 / 怪物数。
  assert.equal(view.getUint8(0), Msg.Snapshot)
  assert.equal(view.getUint32(1, true), 5)
  assert.equal(view.getFloat64(5, true), 1.5)
  assert.equal(view.getUint16(13, true), 1)
  assert.equal(view.getUint16(15, true), 2)

  // 第一个怪物记录的 id 就在 17 + 36 = 53 处，第二个再 +20。若有人把
  // 怪物段插到玩家段前面，这两个读数会变成玩家字段的碎片。
  const firstMonster = SNAPSHOT_HEADER + PLAYER_SNAPSHOT_SIZE
  assert.equal(view.getUint16(firstMonster, true), 900)
  assert.equal(view.getUint8(firstMonster + 2), 1) // kind
  assert.equal(view.getUint8(firstMonster + 3), 2) // state
  assert.equal(view.getUint16(firstMonster + MONSTER_SNAPSHOT_SIZE, true), 901)

  const decoded = decodeSnapshot(buffer)
  assert.equal(decoded.monsters[0]!.kind, 1)
  assert.equal(decoded.monsters[0]!.state, 2)
})

test('snapshot: 位置以毫米整数传输，0.001 的整数倍按位还原（玩家与怪物同一套映射）', () => {
  // 都是 0.001 的整数倍且能被 double 精确表达的取值：编解码必须无损，
  // 差一个 ulp 就是线上"位置永远差一点点"。怪物记录的 x/y/z 走的是同一
  // 个 Math.round(v * 1000) 映射，所以两段一起测。
  const values = [0, 0.001, -0.001, 12.345, -3.007, 123.456, -1234.567, 7.7, 3.003, 1.001]
  for (const value of values) {
    const decoded = decodeSnapshot(
      encodeSnapshot({
        tick: 0,
        serverTime: 0,
        players: [player({ x: value, y: value, z: value })],
        monsters: [monster({ x: value, y: value, z: value })],
      }),
    )
    assert.equal(decoded.players[0]!.x, value, 'player x=' + value)
    assert.equal(decoded.players[0]!.y, value, 'player y=' + value)
    assert.equal(decoded.players[0]!.z, value, 'player z=' + value)
    assert.equal(decoded.monsters[0]!.x, value, 'monster x=' + value)
    assert.equal(decoded.monsters[0]!.y, value, 'monster y=' + value)
    assert.equal(decoded.monsters[0]!.z, value, 'monster z=' + value)
  }

  // 0.1 + 0.2 = 0.30000000000000004 本身不是毫米整数，量化后回到 0.3：
  // 这是预期内的舍入，不是 bug，用 1e-9 容差而不是按位相等。
  const rounded = decodeSnapshot(
    encodeSnapshot({ tick: 0, serverTime: 0, players: [player({ x: 0.1 + 0.2 })], monsters: [] }),
  ).players[0]!
  assert.equal(rounded.x, 0.3)

  // 观测到的行为：-0 经过 Math.round(-0 * 1000) -> setInt32(-0) -> getInt32()
  // 读回来是 +0，所以 -0 不保持符号。这里显式记录，避免以后有人当成回归。
  const negativeZero = decodeSnapshot(
    encodeSnapshot({ tick: 0, serverTime: 0, players: [player({ x: -0 })], monsters: [] }),
  ).players[0]!
  assert.equal(negativeZero.x, 0)
  assert.ok(!Object.is(negativeZero.x, -0))
})

test('snapshot: 速度走 i16 * 1000 映射，量程内按位还原', () => {
  // i16 能表达的极限就是 +/-32.767 m/s —— 超出会回绕，这是字段宽度决定
  // 的硬上限（服务端必须先钳制，不要指望编解码兜住）。
  for (const value of [0, 1.234, -0.001, 0.3, -0.3, 32.767, -32.767]) {
    const decoded = decodeSnapshot(
      encodeSnapshot({ tick: 0, serverTime: 0, players: [player({ vx: value, vy: value, vz: value })], monsters: [] }),
    ).players[0]!
    assert.equal(decoded.vx, value, 'vx=' + value)
    assert.equal(decoded.vy, value, 'vy=' + value)
    assert.equal(decoded.vz, value, 'vz=' + value)
  }
})

test('snapshot: yaw/pitch 走同一个 u16 映射，误差不超过一个量化步长', () => {
  for (const angle of [-Math.PI, -2, -0.5, 0, 0.001, 0.5, 2, 3]) {
    const decoded = decodeSnapshot(
      encodeSnapshot({
        tick: 0,
        serverTime: 0,
        players: [player({ yaw: angle, pitch: angle / 3 })],
        monsters: [],
      }),
    ).players[0]!
    assertClose(decoded.yaw, angle, ANGLE_TOLERANCE, 'yaw=' + angle)
    assertClose(decoded.pitch, angle / 3, ANGLE_TOLERANCE, 'pitch=' + angle / 3)
  }

  // 满量程两端都要落在 [-PI, PI] 之内并能还原。
  const atPi = decodeSnapshot(
    encodeSnapshot({ tick: 0, serverTime: 0, players: [player({ yaw: Math.PI })], monsters: [] }),
  ).players[0]!
  assertClose(atPi.yaw, Math.PI, ANGLE_TOLERANCE, 'yaw=PI')
})

test('snapshot: health 向上取整且不为负，health 取整、flags 留 16 位、weaponId/ammo 留 8 位', () => {
  const decoded = decodeSnapshot(
    encodeSnapshot({
      tick: 0,
      serverTime: 0,
      players: [
        player({ health: 99.6, flags: 0x1ff, weaponId: 0x102, ammo: 0x1f, ackSeq: 0xdeadbeef }),
        player({ health: -5 }),
      ],
      monsters: [],
    }),
  ).players
  assert.equal(decoded[0]!.health, 100)
  assert.equal(decoded[0]!.flags, 0x1ff)
  assert.equal(decoded[0]!.weaponId, 0x02)
  assert.equal(decoded[0]!.ammo, 0x1f)
  assert.equal(decoded[0]!.ackSeq, 0xdeadbeef)
  // Math.max(0, Math.round(health))：负数不许冲成 u16 的 65531。
  assert.equal(decoded[1]!.health, 0)
})

test('snapshot: 怪物的 kind/state 只留低 8 位，health 不为负，yaw 走同一个 u16 映射', () => {
  const decoded = decodeSnapshot(
    encodeSnapshot({
      tick: 0,
      serverTime: 0,
      players: [],
      monsters: [
        monster({ id: 0xffff, kind: 0x102, state: 0x1ff, health: -5, yaw: Math.PI }),
        monster({ id: 2, kind: 1, state: 3, health: 99.6 }),
      ],
    }),
  ).monsters

  // id 是 u16，不该被截成 8 位；kind/state 是 u8，高位必须掉。
  assert.equal(decoded[0]!.id, 0xffff)
  assert.equal(decoded[0]!.kind, 0x02)
  assert.equal(decoded[0]!.state, 0xff)
  // Math.max(0, Math.round(health))：-5 不许回绕成 65531。
  assert.equal(decoded[0]!.health, 0)
  assertClose(decoded[0]!.yaw, Math.PI, ANGLE_TOLERANCE, 'monster yaw=PI')
  assert.equal(decoded[1]!.health, 100)
})

// ---------------------------------------------------------------- 事件

test('event: 每种事件占用的字节数是固定的 29 / 21 / 7 / 16 / 20 / 7 / 20', () => {
  // 最长的事件是 Shot(29)，MAX_EVENT_SIZE 是它的上界，不是"怪物事件变长
  // 了"——怪物事件比 Shot 短得多。
  assert.equal(MAX_EVENT_SIZE, 35)

  const events: GameEvent[] = [
    {
      kind: EventKind.Shot,
      playerId: 1,
      origin: { x: 1, y: 2, z: 3 },
      dir: { x: 0, y: 0, z: -1 },
      weaponId: 1,
    },
    {
      kind: EventKind.Hit,
      attackerId: 1,
      victimId: 2,
      damage: 12.6,
      headshot: true,
      point: { x: 1, y: 2, z: 3 },
    },
    { kind: EventKind.Death, victimId: 2, killerId: 1, headshot: false },
    { kind: EventKind.Respawn, playerId: 2, position: { x: 4, y: 5, z: 6 } },
    {
      kind: EventKind.MonsterHit,
      attackerId: 1,
      monsterId: 900,
      damage: 22,
      point: { x: 0.5, y: -1.5, z: 2.25 },
    },
    { kind: EventKind.MonsterDeath, monsterId: 900, killerId: 1, monsterKind: 1 },
    { kind: EventKind.BossPulse, monsterId: 901, x: 1.5, y: 0.25, z: -2.5, radius: 8 },
  ]

  // 编码器按 MAX_EVENT_SIZE 预分配再 slice 到实际长度：单个事件时
  // 2 字节包头 + 该事件的净长度。
  const sizes = [29, 21, 7, 16, 20, 7, 20]
  for (let i = 0; i < events.length; i++) {
    const buffer = encodeEvents([events[i]!])
    assert.equal(buffer.byteLength, 2 + sizes[i]!, 'event kind=' + events[i]!.kind)
  }

  // 混合批量包 = 2 + 各事件长度之和（120 字节），解码逐条对齐。
  const batch = encodeEvents(events)
  assert.equal(batch.byteLength, 2 + sizes.reduce((a, b) => a + b, 0))
  const decoded = decodeEvents(batch)
  assert.equal(decoded.length, 7)
  assert.deepEqual(decoded[0], events[0])
  assert.deepEqual(decoded[2], events[2])
  assert.deepEqual(decoded[3], events[3])
  // MonsterHit 的 point 是 f32，取的都是二进制小数可精确表达的整数/半整
  // 数，所以能 deepEqual；伤害在线上是整数。
  assert.deepEqual(decoded[4], { ...events[4]!, damage: 22 })
  assert.deepEqual(decoded[5], events[5])
  assert.deepEqual(decoded[6], events[6])
})

test('event: MonsterHit 与 MonsterDeath 的字段顺序与宽度被钉死', () => {
  assert.equal(EventKind.MonsterHit, 5)
  assert.equal(EventKind.MonsterDeath, 6)

  // MonsterHit：u8 Msg.Event + u8 kind + attackerId(u16) + monsterId(u16)
  // + damage(u16) + point(x/y/z f32) = 20 字节。
  const hitBuffer = encodeEvents([
    { kind: EventKind.MonsterHit, attackerId: 0xffff, monsterId: 900, damage: 22.6, point: { x: 0.5, y: -1.5, z: 2.25 } },
  ])
  assert.equal(hitBuffer.byteLength, 2 + 20)
  const hitView = new DataView(hitBuffer)
  assert.equal(hitView.getUint8(2), Msg.Event)
  assert.equal(hitView.getUint8(3), 5)
  assert.equal(hitView.getUint16(4, true), 0xffff)
  assert.equal(hitView.getUint16(6, true), 900)
  assert.equal(hitView.getUint16(8, true), 23) // Math.round(22.6)
  assert.equal(hitView.getFloat32(10, true), 0.5)
  assert.equal(hitView.getFloat32(14, true), -1.5)
  assert.equal(hitView.getFloat32(18, true), 2.25)
  const [hit] = decodeEvents(hitBuffer)
  assert.ok(hit && hit.kind === EventKind.MonsterHit)
  assert.equal(hit.damage, 23)
  assert.deepEqual(hit.point, { x: 0.5, y: -1.5, z: 2.25 })

  // MonsterDeath：u8 Msg.Event + u8 kind + monsterId(u16) + killerId(u16)
  // + monsterKind(u8) = 7 字节 —— 和 Death 一样短，别照着 MonsterHit 猜。
  const deathBuffer = encodeEvents([
    { kind: EventKind.MonsterDeath, monsterId: 900, killerId: 0xffff, monsterKind: 0x101 },
  ])
  assert.equal(deathBuffer.byteLength, 2 + 7)
  const deathView = new DataView(deathBuffer)
  assert.equal(deathView.getUint8(3), 6)
  assert.equal(deathView.getUint16(4, true), 900)
  assert.equal(deathView.getUint16(6, true), 0xffff)
  assert.equal(deathView.getUint8(8), 0x01) // monsterKind & 0xff
  const [death] = decodeEvents(deathBuffer)
  assert.deepEqual(death, {
    kind: EventKind.MonsterDeath,
    monsterId: 900,
    killerId: 0xffff,
    monsterKind: 1,
  })
})

test('event: 怪物击杀玩家的伤害事件与玩家打怪的命中事件互不串味', () => {
  // 同一批量包里同时有 Hit（玩家挨咬）与 MonsterHit（怪物挨枪），
  // 解码侧靠 eventKind 分支，字段名不同但位宽一致，最容易写错。
  const batch = encodeEvents([
    {
      kind: EventKind.Hit,
      attackerId: 3,
      victimId: 7,
      damage: 22,
      headshot: false,
      point: { x: 1, y: 2, z: 3 },
    },
    {
      kind: EventKind.MonsterHit,
      attackerId: 3,
      monsterId: 7,
      damage: 41,
      point: { x: 1, y: 2, z: 3 },
    },
  ])
  const decoded = decodeEvents(batch)
  assert.equal(decoded.length, 2)
  const [playerHit, monsterHit] = decoded
  assert.ok(playerHit && playerHit.kind === EventKind.Hit)
  assert.equal(playerHit.victimId, 7)
  assert.equal(playerHit.damage, 22)
  assert.ok(monsterHit && monsterHit.kind === EventKind.MonsterHit)
  assert.equal(monsterHit.monsterId, 7)
  assert.equal(monsterHit.damage, 41)
})

test('event: Hit 的伤害按整数传输、爆头位与命中点还原', () => {
  const buffer = encodeEvents([
    {
      kind: EventKind.Hit,
      attackerId: 0xffff,
      victimId: 7,
      damage: 12.6,
      headshot: true,
      point: { x: 0.5, y: -1.5, z: 2.25 },
    },
  ])
  const [hit] = decodeEvents(buffer)
  assert.ok(hit && hit.kind === EventKind.Hit)
  assert.equal(hit.attackerId, 0xffff)
  assert.equal(hit.victimId, 7)
  // Math.round(12.6) = 13：伤害在线上是整数，别指望小数。
  assert.equal(hit.damage, 13)
  assert.equal(hit.headshot, true)
  assert.deepEqual(hit.point, { x: 0.5, y: -1.5, z: 2.25 })
})

test('switch slot: 2 字节往返，且不会被当成输入包解', () => {
  assert.equal(SWITCH_SLOT_SIZE, 2)
  assert.equal(new DataView(encodeSwitchSlot(1)).getUint8(0), Msg.SwitchSlot)
  for (const slot of [0, 1, 2]) assert.equal(decodeSwitchSlot(encodeSwitchSlot(slot)), slot)
  assert.throws(() => decodeSwitchSlot(encodeInputPacket([input(1)])), /不是切枪包/)
  // 反向：切枪包也不能被当成输入包解（kind 9 !== 3）。
  assert.throws(() => decodeInputPacket(encodeSwitchSlot(0)), /不是输入包/)
})

// ---------------------------------------------------------------- ack

test('ack: 5 字节（u8 kind + u32 seq）往返', () => {
  assert.equal(encodeAck(0).byteLength, 5)
  assert.equal(decodeAck(encodeAck(0)), 0)
  assert.equal(decodeAck(encodeAck(123456)), 123456)
  // seq >>> 0：无符号 32 位，-1 就是 0xFFFFFFFF。
  assert.equal(decodeAck(encodeAck(-1)), 0xffffffff)
})

// ---------------------------------------------------------------- 截断 / 错类型

test('解码器遇到截断缓冲区一律抛 RangeError，绝不返回半截数据', () => {
  const snapshot = encodeSnapshot({
    tick: 1,
    serverTime: 1,
    players: [player({ id: 1 }), player({ id: 2 }), player({ id: 3 })],
    monsters: [monster({ id: 900 })],
  })
  // 包头声称 3 个玩家 + 1 个怪物，实际只给了 1 个玩家的字节。
  assertTruncationThrows('snapshot 少 2 个玩家', () => decodeSnapshot(snapshot.slice(0, SNAPSHOT_HEADER + PLAYER_SNAPSHOT_SIZE)))
  // 玩家段完整、怪物段一个字节都没给：怪物循环必须越界而不是返回 0 只怪物。
  assertTruncationThrows('snapshot 少 1 个怪物', () =>
    decodeSnapshot(snapshot.slice(0, SNAPSHOT_HEADER + 3 * PLAYER_SNAPSHOT_SIZE)),
  )
  // 怪物段只给了半个记录（20 字节里给 8 字节）。
  assertTruncationThrows('snapshot 怪物记录只给一半', () =>
    decodeSnapshot(snapshot.slice(0, SNAPSHOT_HEADER + 3 * PLAYER_SNAPSHOT_SIZE + 8)),
  )
  assertTruncationThrows('snapshot 只剩 10 字节', () => decodeSnapshot(snapshot.slice(0, 10)))
  assertTruncationThrows('snapshot 空包', () => decodeSnapshot(new ArrayBuffer(0)))

  const packet = encodeInputPacket([input(1), input(2)])
  assertTruncationThrows('input packet 少一个输入', () => decodeInputPacket(packet.slice(0, 6 + INPUT_SIZE)))
  assertTruncationThrows('input packet 只剩包头', () => decodeInputPacket(packet.slice(0, 3)))

  assertTruncationThrows('ack 只剩 3 字节', () => decodeAck(encodeAck(1).slice(0, 3)))
  assertTruncationThrows('event 包被截断', () =>
    decodeEvents(
      encodeEvents([
        {
          kind: EventKind.Shot,
          playerId: 1,
          origin: { x: 1, y: 2, z: 3 },
          dir: { x: 0, y: 0, z: -1 },
          weaponId: 1,
        },
      ]).slice(0, 20),
    ),
  )

  // hello 的截断不是 DataView 越界，而是 TextDecoder 前先按 u8 长度
  // 构造 Uint8Array 时越界：RangeError: Invalid typed array length。
  assert.throws(() => decodeHello(encodeHello('abc').slice(0, 4)), RangeError)
})

test('解码器按首字节的 kind 拒绝错类型包', () => {
  const packet = encodeInputPacket([input(1)])
  assert.throws(() => decodeSnapshot(packet), /不是快照包/)
  assert.throws(() => decodeEvents(packet), /不是事件包/)
  assert.throws(() => decodeAck(packet), /不是确认包/)
  assert.throws(() => decodeWelcome(packet), /不是欢迎包/)
  assert.throws(() => decodeHello(packet), /不是握手包/)

  // 反向：快照包不能被当成输入包解（kind 4 !== 3）。
  assert.throws(
    () => decodeInputPacket(encodeSnapshot({ tick: 0, serverTime: 0, players: [], monsters: [] })),
    /不是输入包/,
  )
})

test('Msg 的消息类型编号是线上契约，不能被"整理"', () => {
  assert.deepEqual(
    {
      Hello: Msg.Hello,
      Welcome: Msg.Welcome,
      Input: Msg.Input,
      Snapshot: Msg.Snapshot,
      Ack: Msg.Ack,
      Event: Msg.Event,
      Text: Msg.Text,
      SwitchSlot: Msg.SwitchSlot,
    },
    { Hello: 1, Welcome: 2, Input: 3, Snapshot: 4, Ack: 5, Event: 6, Text: 7, SwitchSlot: 9 },
  )
})
