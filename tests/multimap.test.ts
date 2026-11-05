/**
 * 多图链路：Hello/Welcome 的可选关卡段，以及 WorldRegistry 按 matchId 选图。
 *
 * 这两件事必须一起测：协议层保证"客户端说要进哪张图"能到服务端，
 * 注册表保证"服务端给这个 matchId 用了哪张图"能回传给客户端。
 * 任何一半坏了，症状都是"能连上、能动，但站在空气里"。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// 相对路径：仓库根 node_modules 下没有 @dk/* 的 workspace 链接。
// server/src/worlds.ts 自己 import '@dk/shared'，Node 按"引用它的那个文件"的
// 目录去找，所以从根跑也能解析到 server/node_modules/@dk/shared。
import {
  DEFAULT_LEVEL_ID,
  LEVEL_IDS,
  LEVEL_ID_MAX_BYTES,
  Msg,
  PROTOCOL_VERSION,
  WELCOME_SIZE,
  decodeHello,
  decodeWelcome,
  encodeHello,
  encodeWelcome,
} from '../shared/src/index.ts'
import { WorldRegistry, resolveLevelId } from '../server/src/worlds.ts'
// 建真世界要先 await 一次 WASM（rapier3d-compat 把 wasm 内联成 base64，
// 但任何 new World() 之前都必须先初始化，否则是 rawintegrationparameters_new 的 undefined）。
import { initPhysics } from '../shared/src/worldbuild.ts'

/** 拿一张确定不等于默认图的 id，避免测试依赖 LEVELS 的键顺序。 */
const OTHER_LEVEL_ID = LEVEL_IDS.find((id) => id !== DEFAULT_LEVEL_ID) ?? DEFAULT_LEVEL_ID

function welcome(levelId?: string | null) {
  return encodeWelcome({
    playerId: 7,
    tickRate: 60,
    snapshotRate: 20,
    serverTime: 1234.5,
    spawn: { x: 1, y: 2, z: 3 },
    ...(levelId === undefined ? {} : { levelId }),
  })
}

// ---------------------------------------------------------------- Hello

test('hello: 不带关卡时 levelId 为 null 且包体与老格式一致', () => {
  const buffer = encodeHello('ash')
  assert.equal(buffer.byteLength, 4 + 3)
  assert.deepEqual(decodeHello(buffer), { version: PROTOCOL_VERSION, nickname: 'ash', levelId: null })
})

test('hello: 带关卡时往返，且前缀与不带关卡逐字节相同', () => {
  const plain = new Uint8Array(encodeHello('ash'))
  const withMap = encodeHello('ash', OTHER_LEVEL_ID)
  const hello = decodeHello(withMap)

  assert.equal(hello.levelId, OTHER_LEVEL_ID)
  assert.equal(hello.nickname, 'ash')
  // 老服务端只读 4 + len 字节：这段必须一字节都没变，否则旧服务端会读出乱码。
  assert.deepEqual(new Uint8Array(withMap, 0, plain.length), plain)
  // 尾巴 = u8 长度 + 字节。
  assert.equal(withMap.byteLength, plain.length + 1 + OTHER_LEVEL_ID.length)
})

test('hello: 老客户端手工构的包（没有尾部）照样能解', () => {
  const name = new TextEncoder().encode('ash')
  const buffer = new ArrayBuffer(4 + name.length)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Hello)
  view.setUint16(1, PROTOCOL_VERSION, true)
  view.setUint8(3, name.length)
  new Uint8Array(buffer, 4).set(name)

  assert.deepEqual(decodeHello(buffer), { version: PROTOCOL_VERSION, nickname: 'ash', levelId: null })
})

test('hello: 空长度的尾部等同于没有（旧版留的 0 长度是合法输入）', () => {
  const buffer = encodeHello('ash')
  const padded = new Uint8Array(buffer.byteLength + 1)
  padded.set(new Uint8Array(buffer))
  padded[buffer.byteLength] = 0
  assert.equal(decodeHello(padded.buffer as ArrayBuffer).levelId, null)
})

test('hello: 尾部被截断时给 null 而不是抛错', () => {
  const full = encodeHello('ash', OTHER_LEVEL_ID)
  // 只保留长度字节，砍掉内容。
  const cut = full.slice(0, 4 + 3 + 1)
  assert.equal(decodeHello(cut).levelId, null)
})

test('hello: 超长关卡 id 被截到上限，长度字节不会溢出', () => {
  const long = 'x'.repeat(LEVEL_ID_MAX_BYTES + 40)
  const hello = decodeHello(encodeHello('ash', long))
  assert.equal(hello.levelId?.length, LEVEL_ID_MAX_BYTES)
})

// ---------------------------------------------------------------- Welcome

test('welcome: 不带关卡时仍是 25 字节定长，levelId 为 null', () => {
  const buffer = welcome()
  assert.equal(buffer.byteLength, WELCOME_SIZE)
  assert.equal(decodeWelcome(buffer).levelId, null)
})

test('welcome: 带关卡时往返，且前 25 字节与不带关卡相同', () => {
  const plain = new Uint8Array(welcome())
  const withMap = welcome(OTHER_LEVEL_ID)
  const decoded = decodeWelcome(withMap)

  assert.equal(decoded.levelId, OTHER_LEVEL_ID)
  assert.deepEqual(new Uint8Array(withMap, 0, WELCOME_SIZE), plain)
  assert.equal(decoded.spawn.z, 3)
  assert.equal(withMap.byteLength, WELCOME_SIZE + 1 + OTHER_LEVEL_ID.length)
})

test('welcome: 老服务端的 25 字节包解出 levelId = null', () => {
  const legacy = new Uint8Array(welcome())
  assert.equal(legacy.byteLength, WELCOME_SIZE)
  assert.equal(decodeWelcome(legacy.buffer as ArrayBuffer).levelId, null)
})

// ---------------------------------------------------------------- 关卡解析

test('resolveLevelId: 已知 id 原样接受', () => {
  for (const id of LEVEL_IDS) {
    assert.deepEqual(resolveLevelId(id), { levelId: id, rejected: null })
  }
})

test('resolveLevelId: 未知 id 回落到默认图并带出被拒的原值', () => {
  assert.deepEqual(resolveLevelId('no-such-map'), {
    levelId: DEFAULT_LEVEL_ID,
    rejected: 'no-such-map',
  })
})

test('resolveLevelId: 没请求（旧客户端）用默认图，不算被拒', () => {
  for (const empty of [null, undefined, '']) {
    assert.deepEqual(resolveLevelId(empty), { levelId: DEFAULT_LEVEL_ID, rejected: null })
  }
})

test('resolveLevelId: 兜底 id 本身非法时再落回 DEFAULT_LEVEL_ID', () => {
  assert.deepEqual(resolveLevelId('nope', 'also-nope'), {
    levelId: DEFAULT_LEVEL_ID,
    rejected: 'nope',
  })
})

// ---------------------------------------------------------------- 注册表

test('registry: 没登记过就是默认图', () => {
  const registry = new WorldRegistry()
  assert.equal(registry.levelIdOf('match-a'), DEFAULT_LEVEL_ID)
})

test('registry: 首个请求决定这个 matchId 的图', () => {
  const registry = new WorldRegistry()
  assert.equal(registry.registerLevel('match-a', OTHER_LEVEL_ID), OTHER_LEVEL_ID)
  assert.equal(registry.levelIdOf('match-a'), OTHER_LEVEL_ID)
  // 不同 matchId 互不影响 —— 一个进程跑多张图的核心。
  assert.equal(registry.registerLevel('match-b', DEFAULT_LEVEL_ID), DEFAULT_LEVEL_ID)
  assert.equal(registry.levelIdOf('match-b'), DEFAULT_LEVEL_ID)
})

test('registry: 同一张图重复登记是幂等的', () => {
  const registry = new WorldRegistry()
  registry.registerLevel('match-a', OTHER_LEVEL_ID)
  assert.equal(registry.registerLevel('match-a', OTHER_LEVEL_ID), OTHER_LEVEL_ID)
  assert.equal(registry.levelIdOf('match-a'), OTHER_LEVEL_ID)
})

test('registry: 还没建世界时换图会被采纳（没人被塞进旧几何）', () => {
  const registry = new WorldRegistry()
  registry.registerLevel('match-a', OTHER_LEVEL_ID)
  // 登记过但 get() 还没被调用 = 这个房号一个人都没进来过，
  // 没有任何物理状态可保，必须听后来的请求 —— 否则大厅的地图卡就白点了。
  assert.equal(registry.registerLevel('match-a', DEFAULT_LEVEL_ID), DEFAULT_LEVEL_ID)
  assert.equal(registry.levelIdOf('match-a'), DEFAULT_LEVEL_ID)
})

test('registry: 世界里还有人时绝不换图', async () => {
  await initPhysics()
  const registry = new WorldRegistry()
  registry.registerLevel('match-f', DEFAULT_LEVEL_ID)
  const world = registry.get('match-f')
  // 真塞一个玩家要走 socket 桩，这里只改计数：规则是"按人数判定"，不是"按对象存在判定"。
  Object.defineProperty(world, 'playerCount', { value: 1, configurable: true })
  assert.equal(registry.registerLevel('match-f', OTHER_LEVEL_ID), DEFAULT_LEVEL_ID)
  assert.equal(registry.levelIdOf('match-f'), DEFAULT_LEVEL_ID)
  assert.equal(registry.get('match-f'), world)
  registry.stop()
})

test('registry: 空场里换图会被采纳，并丢掉旧世界', async () => {
  await initPhysics()
  // 这一条对应「大厅四张地图卡都一样」的故障：房号一旦被谁用过，原实现
  // 就把图永久钉死。空场没有物理状态可保，必须听玩家的。
  const registry = new WorldRegistry()
  registry.registerLevel('match-e', OTHER_LEVEL_ID)
  const stale = registry.get('match-e')
  assert.equal(stale.playerCount, 0)
  assert.equal(registry.registerLevel('match-e', DEFAULT_LEVEL_ID), DEFAULT_LEVEL_ID)
  assert.equal(registry.levelIdOf('match-e'), DEFAULT_LEVEL_ID)
  // 旧世界必须销毁：否则下次 get 拿到的还是画着旧图的那一个。
  assert.notEqual(registry.get('match-e'), stale)
  registry.stop()
})

test('registry: 未知图不登记成原值，直接回落到默认图', () => {
  const registry = new WorldRegistry()
  assert.equal(registry.registerLevel('match-c', 'bogus'), DEFAULT_LEVEL_ID)
  assert.equal(registry.levelIdOf('match-c'), DEFAULT_LEVEL_ID)
})

test('registry: 构造时给的默认图非法会退回 DEFAULT_LEVEL_ID', () => {
  const registry = new WorldRegistry('bogus-default')
  assert.equal(registry.levelIdOf('match-d'), DEFAULT_LEVEL_ID)
  assert.equal(registry.registerLevel('match-d', null), DEFAULT_LEVEL_ID)
})
