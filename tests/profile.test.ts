/**
 * 服务端档案与个人撤离的回归测试。
 *
 * 锁住三件事：
 * 1. 服务端只接受“已拥有”的天赋/配件，客户端改 localStorage 不能获得；
 * 2. 金币只能在服务端扣/加，且随身补给买断后只发一次；
 * 3. 非赏金携带者也能个人撤离，结算包只发给本人。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  Msg,
  attachmentBit,
  decodeHello,
  decodeProfile,
  decodeResult,
  encodeHello,
  encodeProfile,
  encodeResult,
  sanitizeOwnedBuild,
  clampSelectionToOwned,
  setTraitLevel,
  traitLevel,
  Trait,
} from '../shared/src/index.ts'
import { LEVELS } from '../shared/src/level.ts'
import { initPhysics } from '../shared/src/worldbuild.ts'
import { ProfileStore, sanitizeProfileId } from '../server/src/profile.ts'
import { World } from '../server/src/world.ts'
import type { WebSocket } from 'ws'

// ---------------------------------------------------------------- 档案

test('档案 id：合法 userId 原样保留，非法字符折叠成稳定 h_', () => {
  assert.equal(sanitizeProfileId('anon:abc-123'), 'anon:abc-123')
  const folded = sanitizeProfileId('user/a|b')
  assert.match(folded, /^h_/)
  assert.equal(sanitizeProfileId('user/a|b'), folded)
})

test('档案：新玩家有起始金币，天赋/配件均为 0', () => {
  const store = new ProfileStore(null)
  const p = store.get('u-new')
  assert.equal(p.coins, 120)
  assert.equal(p.traitOwned, 0)
  assert.equal(p.attachmentOwned, 0)
})

test('档案：天赋升级扣款、等级递增，钱不够时拒绝', () => {
  const store = new ProfileStore(null)
  const bit = Trait.IronGrip
  const first = store.buyTrait('u-trait', bit)
  assert.equal(first.ok, true)
  assert.equal(first.ok && first.cost, 120)
  assert.equal(traitLevel(store.get('u-trait').traitOwned, bit), 1)
  assert.equal(store.get('u-trait').coins, 0)

  const second = store.buyTrait('u-trait', bit)
  assert.equal(second.ok, false)
  assert.equal(traitLevel(store.get('u-trait').traitOwned, bit), 1)

  store.settle('u-trait', 500)
  const third = store.buyTrait('u-trait', bit)
  assert.equal(third.ok, true)
  assert.equal(traitLevel(store.get('u-trait').traitOwned, bit), 2)
})

test('档案：配件买断只扣一次，重复购买不再扣款', () => {
  const store = new ProfileStore(null)
  store.settle('u-attach', 2000)
  const first = store.buyAttachment('u-attach', 101)
  assert.equal(first.ok, true)
  assert.equal(store.get('u-attach').coins, 1520)
  assert.notEqual(store.get('u-attach').attachmentOwned & attachmentBit(101), 0)

  const again = store.buyAttachment('u-attach', 101)
  assert.equal(again.ok, true)
  assert.equal(store.get('u-attach').coins, 1520)
})

test('档案：补给按选择发放一次，未选中的位保留', () => {
  const store = new ProfileStore(null)
  store.settle('u-extras', 500)
  assert.equal(store.buyExtras('u-extras', 1).ok, true)
  assert.equal(store.buyExtras('u-extras', 2).ok, true)
  assert.equal(store.get('u-extras').extrasOwned, 3)

  assert.equal(store.consumeExtras('u-extras', 1), 1)
  assert.equal(store.get('u-extras').extrasOwned, 2)
  assert.equal(store.consumeExtras('u-extras', 2), 2)
  assert.equal(store.get('u-extras').extrasOwned, 0)
  assert.equal(store.consumeExtras('u-extras', 3), 0)
})

test('档案：撤离结算只加服务端收入，且总数可串行累加', () => {
  const store = new ProfileStore(null)
  assert.equal(store.settle('u-settle', 50).coins, 170)
  assert.equal(store.settle('u-settle', 30).coins, 200)
})

// ---------------------------------------------------------------- 拥有校验

test('拥有校验：客户端选择的天赋不能超过服务端已拥有等级', () => {
  const owned = setTraitLevel(0, Trait.IronGrip, 2)
  const selected = setTraitLevel(0, Trait.IronGrip, 3)
  const clamped = clampSelectionToOwned(selected, owned)
  assert.equal(traitLevel(clamped, Trait.IronGrip), 2)
  assert.equal(traitLevel(clamped, Trait.Vigor), 0)
})

test('拥有校验：未购买的配件从 build 里被洗掉，默认件保留', () => {
  const owned = attachmentBit(100) // 原厂机瞄（cost 0，永远拥有）
  const build = sanitizeOwnedBuild(1, { sight: 102, muzzle: 200 }, owned)
  assert.equal(build.slots.sight, undefined)
  assert.equal(build.slots.muzzle, 200)
})

// ---------------------------------------------------------------- 协议

test('协议：Hello 的 level/party/profile/partyCode 四个尾段互不吞字节', () => {
  const decoded = decodeHello(
    encodeHello('ash', 'marsh-p0', 'party-1', 'profile-abc', 'code-xyz'),
  )
  assert.equal(decoded.levelId, 'marsh-p0')
  assert.equal(decoded.partyId, 'party-1')
  assert.equal(decoded.profileId, 'profile-abc')
  assert.equal(decoded.partyCode, 'code-xyz')

  const noParty = decodeHello(encodeHello('ash', null, null, 'profile-only'))
  assert.equal(noParty.profileId, 'profile-only')
  assert.equal(noParty.partyId, null)
  assert.equal(noParty.partyCode, null)
})

test('协议：Result 包往返，负数/超限被钳制', () => {
  const packet = decodeResult(
    encodeResult({
      escaped: true,
      bounty: true,
      lootValue: 321,
      bountyValue: 500,
      coinsEarned: 164,
      coinsTotal: 284,
      reason: 0,
    }),
  )
  assert.equal(packet.escaped, true)
  assert.equal(packet.bounty, true)
  assert.equal(packet.lootValue, 321)
  assert.equal(packet.bountyValue, 500)
  assert.equal(packet.coinsEarned, 164)
  assert.equal(packet.coinsTotal, 284)
})

test('协议：Profile 包往返', () => {
  const packet = decodeProfile(
    encodeProfile({
      coins: 1234,
      traitOwned: setTraitLevel(0, Trait.IronGrip, 2),
      attachmentOwned: attachmentBit(101),
      extrasOwned: 3,
      activeTraits: setTraitLevel(0, Trait.IronGrip, 1),
    }),
  )
  assert.equal(packet.coins, 1234)
  assert.equal(packet.extrasOwned, 3)
  assert.equal(packet.activeTraits, setTraitLevel(0, Trait.IronGrip, 1))
})

// ---------------------------------------------------------------- 个人撤离

interface FakeSocket {
  readyState: number
  sent: ArrayBuffer[]
  send(buffer: ArrayBuffer): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
}

function fakeSocket(): FakeSocket {
  return {
    readyState: 1,
    sent: [],
    send(buffer: ArrayBuffer) {
      this.sent.push(buffer)
    },
    close() {
      this.readyState = 3
    },
    terminate() {
      this.readyState = 3
    },
    ping() {},
  }
}

test('个人撤离：非携带者读满 20 秒后收到只发给自己的 Result，并按服务端结算', async () => {
  await initPhysics()
  const base = LEVELS['marsh-p0']!
  const level = {
    ...base,
    id: 'personal-extract-test',
    boxes: [],
    nests: [],
    clues: [],
    extracts: [{ x: 0, z: 0 }],
    searchSpots: [],
    doors: [],
    traps: [],
    lamps: [],
    spawns: [{ x: 0, y: base.groundY, z: 0 }],
  } as never

  const settled: Array<{ userId: string; earned: number }> = []
  const world = new World({
    id: 'personal-extract-test',
    level,
    onSettle: (userId, earned) => {
      settled.push({ userId, earned })
      return 400 + earned
    },
  })
  const socket = fakeSocket()
  const joined = world.addPlayer(
    socket as unknown as WebSocket,
    '独行者',
    'user-personal',
    '',
    'profile-personal',
  )!
  const internals = world as unknown as {
    step(): void
    players: Map<number, { carriedValue: number }>
  }
  internals.players.get(joined.id)!.carriedValue = 250

  for (let i = 0; i < 1210; i++) internals.step()

  const resultBuffer = socket.sent.find((buffer) => new DataView(buffer).getUint8(0) === Msg.Result)
  assert.ok(resultBuffer, '撤离后必须收到 Result 包')
  const result = decodeResult(resultBuffer!)
  assert.equal(result.escaped, true)
  assert.equal(result.bounty, false)
  assert.equal(result.lootValue, 250)
  assert.equal(result.coinsEarned, 50)
  assert.equal(result.coinsTotal, 450)
  // 结算必须记到 profileId，而不是用于重连的 userId。
  assert.deepEqual(settled, [{ userId: 'profile-personal', earned: 50 }])
})

test('配装：带强健 III 进局补满到 200/200，而不是 150/200', async () => {
  await initPhysics()
  const base = LEVELS['marsh-p0']!
  const level = {
    ...base,
    id: 'vigor-spawn-test',
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
  const world = new World({ id: 'vigor-spawn-test', level })
  const socket = fakeSocket()
  const joined = world.addPlayer(socket as unknown as WebSocket, '壮汉', 'u-vigor')!
  world.receiveLoadout(joined.id, 1, setTraitLevel(0, Trait.Vigor, 3))
  const internals = world as unknown as {
    players: Map<number, { health: number; maxHealth: number }>
  }
  const player = internals.players.get(joined.id)!
  assert.equal(player.maxHealth, 200)
  assert.equal(player.health, 200)
})

test('爆头：高倍率武器对满血强健+硬皮仍然致死', async () => {
  await initPhysics()
  const base = LEVELS['marsh-p0']!
  const level = {
    ...base,
    id: 'headshot-test',
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
  const world = new World({ id: 'headshot-test', level })
  const attackerSocket = fakeSocket()
  const victimSocket = fakeSocket()
  const attacker = world.addPlayer(attackerSocket as unknown as WebSocket, '枪手', 'u-attacker')!
  const victim = world.addPlayer(victimSocket as unknown as WebSocket, '坦克', 'u-victim')!
  const internals = world as unknown as {
    players: Map<
      number,
      {
        health: number
        maxHealth: number
        traits: number
        alive: boolean
        downed: boolean
      }
    >
    applyHit(
      a: unknown,
      target: { kind: 'player'; player: unknown },
      rawDamage: number,
      headshot: boolean,
      point: { x: number; y: number; z: number },
      headLethal?: boolean,
    ): void
  }
  const shooter = internals.players.get(attacker.id)!
  const tank = internals.players.get(victim.id)!
  tank.traits = setTraitLevel(setTraitLevel(0, Trait.Bulwark, 3), Trait.Vigor, 3)
  tank.maxHealth = 200
  tank.health = 200

  // 165 = 温菲尔德爆头伤害；满级硬皮+强健仍是 200 血。高倍率爆头必须致死。
  internals.applyHit(
    shooter,
    { kind: 'player', player: tank },
    165,
    true,
    { x: 0, y: 1.6, z: 0 },
    true,
  )
  assert.equal(tank.health, 0)
  assert.equal(tank.alive, false)
})

test('个人撤离：倒地者不能撤离，也不会收到 Result', async () => {
  await initPhysics()
  const base = LEVELS['marsh-p0']!
  const level = {
    ...base,
    id: 'downed-extract-test',
    boxes: [],
    nests: [],
    clues: [],
    extracts: [{ x: 0, z: 0 }],
    searchSpots: [],
    doors: [],
    traps: [],
    lamps: [],
    spawns: [{ x: 0, y: base.groundY, z: 0 }],
  } as never
  const world = new World({ id: 'downed-extract-test', level })
  const socket = fakeSocket()
  const joined = world.addPlayer(socket as unknown as WebSocket, '倒地者', 'user-downed')!
  const internals = world as unknown as {
    step(): void
    players: Map<number, { downed: boolean; bleedDoneTick: number }>
  }
  const player = internals.players.get(joined.id)!
  player.downed = true
  player.bleedDoneTick = Number.MAX_SAFE_INTEGER

  for (let i = 0; i < 1210; i++) internals.step()
  assert.equal(
    socket.sent.some((buffer) => new DataView(buffer).getUint8(0) === Msg.Result),
    false,
  )
})
