import test from 'node:test'
import assert from 'node:assert/strict'

import {
  Buttons,
  DISCONNECT_GRACE_MS,
  KILL_REWARD,
  MAX_HEALTH,
  PLAYER_HALF_HEIGHT,
  PLAYER_RADIUS,
  SEARCH_MS,
  SEARCH_RADIUS,
  STARTING_BANDAGES,
  TICK_MS,
} from '../shared/src/constants.ts'
import { DEFAULT_LEVEL_ID, LEVELS, type BoxBrush, type SearchSpot } from '../shared/src/level.ts'
import {
  LOOT_HEADER,
  LOOT_ITEM,
  LOOT_ITEM_SIZE,
  LOOT_MAX_ITEMS,
  Msg,
  SPOT_ID_MIN,
  SPOT_ID_NONE,
  decodeLoot,
  decodeText,
  encodeLoot,
  type LootPacket,
} from '../shared/src/protocol.ts'
import { initPhysics } from '../shared/src/worldbuild.ts'
import { World, rollLoot } from '../server/src/world.ts'
import type { WebSocket } from 'ws'

// ---------------------------------------------------------------- 编解码

function roundTrip(packet: LootPacket): LootPacket {
  return decodeLoot(encodeLoot(packet))
}

test('战利品包往返：value 顶到 u16 上限也原样回来', () => {
  // 65535 是 u16 的边界：再多 1 就会在 setUint16 里抛 RangeError，
  // 也就是"搜到第 65536 块钱的时候连接断掉"—— 必须钳制而不是崩。
  const high = roundTrip({ value: 0xffff, searchPct: 100, searchSpotId: 15, nearSpotId: 3, items: [] })
  assert.equal(high.value, 65535)
  assert.equal(high.searchPct, 100)
  assert.equal(high.searchSpotId, 15)
  assert.equal(high.nearSpotId, 3)
  assert.deepEqual(high.items, [])

  // 负数/超限一律被钳制在协议能表达的范围里，不会抛异常。
  const clamped = roundTrip({ value: -5, searchPct: 300, searchSpotId: -9, nearSpotId: 1e9, items: [] })
  assert.equal(clamped.value, 0)
  assert.equal(clamped.searchPct, 100)
  assert.equal(clamped.searchSpotId, -9)
  assert.equal(clamped.nearSpotId, 0x7fff)
  // 尸体缓存下标可以到 -64；再往下按协议下限钳制。
  assert.equal(roundTrip({ value: 0, searchPct: 0, searchSpotId: -1000, nearSpotId: -2, items: [] }).searchSpotId, SPOT_ID_MIN)
  assert.equal(roundTrip({ value: 0, searchPct: 0, searchSpotId: -1000, nearSpotId: -2, items: [] }).nearSpotId, -2)
  // 非有限数（NaN）也要落到 -1，而不是写进包里变成随机下标。
  assert.equal(roundTrip({ value: 0, searchPct: 0, searchSpotId: NaN, nearSpotId: NaN, items: [] }).searchSpotId, -1)
})

test('战利品包往返：空列表、满列表（255 件）、标量都在', () => {
  const empty = roundTrip({ value: 0, searchPct: 0, searchSpotId: -1, nearSpotId: -1, items: [] })
  assert.deepEqual(empty.items, [])
  assert.equal(empty.searchSpotId, -1)
  assert.equal(empty.nearSpotId, -1)

  const items = Array.from({ length: LOOT_MAX_ITEMS }, (_, i) => ({ id: i % 4, count: 1 + (i % 3) }))
  const full = roundTrip({ value: 1234, searchPct: 42, searchSpotId: 12, nearSpotId: 5, items })
  assert.deepEqual(full.items, items)
  assert.equal(full.value, 1234)
  assert.equal(full.searchPct, 42)


  // + 2 searchSpot + 2 nearSpot + 1 itemCount + 1 bandages + 1 healPct。
  assert.equal(LOOT_HEADER, 14)
  assert.equal(LOOT_ITEM_SIZE, 2)
  assert.equal(encodeLoot({ value: 0, searchPct: 0, searchSpotId: -1, nearSpotId: -1, items }).byteLength, LOOT_HEADER + LOOT_MAX_ITEMS * LOOT_ITEM_SIZE)
})

test('战利品包：kind 不对、长度不够、物品段被截断都必须抛', () => {
  const good = encodeLoot({
    value: 86,
    searchPct: 55,
    searchSpotId: 7,
    nearSpotId: 7,
    items: [{ id: LOOT_ITEM.Watch, count: 1 }],
  })

  // kind 不符：客户端拿到别的类型的包必须拒绝，不能按偏移硬解。
  const wrongKind = good.slice(0)
  new Uint8Array(wrongKind)[0] = Msg.Snapshot
  assert.throws(() => decodeLoot(wrongKind), /不是战利品包/)

  assert.throws(() => decodeLoot(good.slice(0, LOOT_HEADER - 1)), /战利品包长度不足/)
  assert.throws(() => decodeLoot(new ArrayBuffer(0)), /战利品包长度不足/)

  // 声明了 1 件，但物品段只来了 1 个字节。
  const truncated = good.slice(0, LOOT_HEADER + LOOT_ITEM_SIZE - 1)
  assert.throws(() => decodeLoot(truncated), /战利品包被截断/)
})

// ---------------------------------------------------------------- 地图数据

const MARSH = LEVELS[DEFAULT_LEVEL_ID]!
const SPOTS: SearchSpot[] = MARSH.searchSpots ?? []

/** 点离某个盒刷"足迹"的水平距离。0 表示在盒子里。 */
function footprintDistance(b: BoxBrush, x: number, z: number): number {
  const dx = x - b.x
  const dz = z - b.z
  const rot = b.rotY ?? 0
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  // 反向旋转到盒子本地系，再按 AABB 算外距。
  const lx = dx * cos + dz * sin
  const lz = -dx * sin + dz * cos
  return Math.hypot(Math.max(0, Math.abs(lx) - b.hx), Math.max(0, Math.abs(lz) - b.hz))
}

/** 点到水面矩形的水平距离，0 表示泡在水里。 */
function waterDistance(w: { x: number; z: number; hx: number; hz: number; rotY?: number }, x: number, z: number): number {
  const dx = x - w.x
  const dz = z - w.z
  const rot = w.rotY ?? 0
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const lx = dx * cos + dz * sin
  const lz = -dx * sin + dz * cos
  return Math.hypot(Math.max(0, Math.abs(lx) - w.hx), Math.max(0, Math.abs(lz) - w.hz))
}

/** 一个搜刮点必须让开多少米，才不至于"人贴着模型却算站进去了"。 */
const CLEAR = 1.0
/** 人站得住的高度带：从地面到胶囊顶。只有横跨这条带的盒子才真的会卡人。 */
const bandLow = MARSH.groundY + 0.05
const bandHigh = MARSH.groundY + PLAYER_HALF_HEIGHT * 2 + PLAYER_RADIUS * 2
/** 会挡人的实心盒刷（noCollide 的装饰件不算）。 */
const solid = MARSH.boxes.filter((b) => !b.noCollide && b.y + b.hy > bandLow && b.y - b.hy < bandHigh)

test('沼泽图有 16 个搜刮点，两两间距 >= 8m', () => {
  assert.equal(SPOTS.length, 16, '沼泽图要有 16 个搜刮点')
  for (let i = 0; i < SPOTS.length; i++) {
    for (let j = i + 1; j < SPOTS.length; j++) {
      const a = SPOTS[i]!
      const b = SPOTS[j]!
      const d = Math.hypot(a.x - b.x, a.z - b.z)
      // 间距必须大于两倍判定半径，否则一个位置能同时"看见"两个点。
      assert.ok(d >= 8, '点 ' + i + ' 与点 ' + j + ' 只隔 ' + d.toFixed(2) + 'm')
    }
  }
})

test('每个搜刮点都站得住：不在墙里、不在水里、离地图边界够远', () => {
  for (const [i, s] of SPOTS.entries()) {
    const label = '点 ' + i + ' (' + s.x + ',' + s.z + ',' + s.kind + ')'
    assert.ok(
      Math.abs(s.x) <= MARSH.boundsHalf - 4 && Math.abs(s.z) <= MARSH.boundsHalf - 4,
      label + ' 离地图边界太近，会被空气墙卡住',
    )
    for (const [k, b] of solid.entries()) {
      const d = footprintDistance(b, s.x, s.z)
      assert.ok(
        d >= CLEAR,
        label + ' 被盒刷 #' + k + ' (' + b.x + ', ' + b.y + ', ' + b.z + ' hx' + b.hx + ' hz' + b.hz +
          ') 挡住，只隔 ' + d.toFixed(2) + 'm',
      )
    }
    for (const [k, w] of (MARSH.water ?? []).entries()) {
      const d = waterDistance(w, s.x, s.z)
      assert.ok(d >= 0.5, label + ' 落在水面 #' + k + ' 里，只隔 ' + d.toFixed(2) + 'm')
    }
  }
})

test('搜刮点类型都在协议里能编码，且 SEARCH_RADIUS 小于最小间距的一半', () => {
  for (const s of SPOTS) {
    assert.ok(['crate', 'sack', 'corpse'].includes(s.kind), '未知搜刮点类型 ' + s.kind)
    if (s.rotY !== undefined) {
      assert.ok(Number.isFinite(s.rotY), 'rotY 必须是有限数')
    }
  }
  // 判定半径必须明显小于最小间距，否则一个位置能同时命中两个点。
  assert.ok(SEARCH_RADIUS * 2 < 8, 'SEARCH_RADIUS 太大，两个点会同时进判定半径')
  assert.ok(SEARCH_MS > 0 && MAX_HEALTH > 0)
})

// ---------------------------------------------------------------- 搜索状态机

// 用真的 World 驱动，而不是把状态机在这里抄一份：抄一份就等于只是在测抄件，
// 线上那份改了测试也不会红。私有字段靠断言用的窄类型拿到（TS 的 private 只在
// 编译期存在）。

const GROUND = LEVELS[DEFAULT_LEVEL_ID]!.groundY

/** 搜刮后的背包 = 出生自带的绷带 + 这个点掉的东西（同 id 合并）。 */
function withStarterLoot(items: { id: number; count: number }[]): { id: number; count: number }[] {
  const bandage = items.find((item) => item.id === LOOT_ITEM.Bandage)?.count ?? 0
  const rest = items.filter((item) => item.id !== LOOT_ITEM.Bandage)
  const out: { id: number; count: number }[] = []
  if (STARTING_BANDAGES + bandage > 0) {
    out.push({ id: LOOT_ITEM.Bandage, count: STARTING_BANDAGES + bandage })
  }
  out.push(...rest)
  return out
}

interface TestPlayer {
  character: {
    feet: { x: number; y: number; z: number }
    teleport(feet: { x: number; y: number; z: number }): void
  }
  health: number
  maxHealth: number
  alive: boolean
  carriedValue: number
  loot: { id: number; count: number }[]
  searchSpotId: number
  searchMs: number
  nearSpotId: number
  interact: boolean
}

interface FakeSocket {
  readyState: number
  sent: ArrayBuffer[]
  send(buffer: ArrayBuffer): void
  close(): void
}

interface Harness {
  world: World
  step(): void
  player(id: number): TestPlayer
  searched: Set<number>
  join(nickname: string): { id: number; socket: FakeSocket }
}

let physicsReady: Promise<void> | null = null

async function boot(): Promise<Harness> {
  physicsReady ??= initPhysics()
  await physicsReady
  const world = new World({ id: 'loot-test' })
  const internals = world as unknown as {
    step(): void
    players: Map<number, TestPlayer>
    searchedSpots: Set<number>
  }
  let socket: FakeSocket = { readyState: 1, sent: [], send: () => {}, close: () => {} }
  const deliver = (buffer: ArrayBuffer): void => {
    if (socket.readyState !== 1) return
    socket.sent.push(buffer)
  }
  return {
    world,
    step: () => internals.step(),
    player: (id) => internals.players.get(id)!,
    searched: internals.searchedSpots,
    join(nickname) {
      socket = { readyState: 1, sent: [], send: deliver, close: () => {} }
      const joined = world.addPlayer(socket as unknown as WebSocket, nickname)!
      return { id: joined.id, socket }
    },
  }
}

/** 让某个玩家按住（或松开）交互键 n 个 tick。 */
function hold(h: Harness, id: number, ticks: number, buttons: number = Buttons.Interact): void {
  let seq = 1
  for (let i = 0; i < ticks; i++) {
    h.world.receiveInput(
      id,
      [{ seq: seq++, dtMs: TICK_MS, forward: 0, right: 0, yaw: 0, pitch: 0, buttons }],
      0,
    )
    h.step()
  }
}

/** 把一个玩家直接放到某个搜刮点上（省得走一路）。 */
function stand(h: Harness, id: number, x: number, z: number): void {
  h.player(id).character.teleport({ x, y: GROUND, z })
}

/** 这个 socket 收到的战利品包（按发送顺序）。 */
function lootPackets(socket: FakeSocket): LootPacket[] {
  return socket.sent.filter((b) => new Uint8Array(b)[0] === Msg.Loot).map((b) => decodeLoot(b))
}

/** 搜空一个点需要的 tick 数，多给两个 tick 的余量。 */
const FULL_TICKS = Math.ceil(SEARCH_MS / TICK_MS) + 2

test('搜索进度：站住不动按住交互，累积到 100% 后点被搜空', async () => {
  const h = await boot()
  const { id, socket } = h.join('搜刮者')
  const spot = SPOTS[0]!
  stand(h, id, spot.x, spot.z)
  h.step()
  assert.equal(h.player(id).nearSpotId, 0, '站到点上就该认出身边这个点')

  // 搜一半：进度在涨、点还在（进度不是"按一下就瞬发"）。
  hold(h, id, 20)
  const midway = h.player(id)
  assert.equal(midway.searchSpotId, 0)
  assert.ok(midway.searchMs > 0 && midway.searchMs < SEARCH_MS, '中途进度必须小于 100%')
  assert.equal(h.searched.has(0), false)

  // 搜完：点被标记、进度清零、身上多了钱和东西。
  hold(h, id, FULL_TICKS)
  const done = h.player(id)
  assert.equal(h.searched.has(0), true, '搜完必须标记这个点已被搜过')
  assert.equal(done.searchMs, 0)
  assert.equal(done.searchSpotId, -1)
  assert.equal(done.nearSpotId, -1, '搜空的点不该再算"身边有点"')

  const expected = rollLoot(0, spot.kind, h.world.lootSeed)
  let cash = expected.cash
  for (const item of expected.items) {
    if (item.id === LOOT_ITEM.Liquor) cash += 30 * item.count
    if (item.id === LOOT_ITEM.Watch) cash += 90 * item.count
  }
  assert.equal(done.carriedValue, cash, '到手价值必须等于这个点算出来的现金 + 消耗品折价')
  assert.deepEqual(done.loot, withStarterLoot(expected.items))

  // 搜到东西必须给本人一句提示（走已有的 Text 通道，不占广播）。
  const texts = socket.sent.filter((b) => new Uint8Array(b)[0] === Msg.Text).map((b) => decodeText(b))
  assert.ok(
    texts.some((t) => t.startsWith('搜到 ') && t.includes('$' + expected.cash)),
    '没给"搜到 $" 的提示，实际收到：' + JSON.stringify(texts),
  )

  // 10Hz 的下发：最后一包里 value 就是刚到手的钱，进度回 0，spots 全是 -1。
  hold(h, id, 12, 0)
  const packets = lootPackets(socket)
  assert.ok(packets.length > 0, '战利品包必须发出去')
  const last = packets[packets.length - 1]!
  assert.equal(last.value, done.carriedValue)
  assert.equal(last.searchPct, 0)
  assert.equal(last.searchSpotId, -1)
  assert.equal(last.nearSpotId, -1)
  assert.deepEqual(last.items, withStarterLoot(expected.items), '包里的物品必须和背包一致')
})

test('搜索进度：中途走开超过 0.6 米就清零，进度不能存着', async () => {
  const h = await boot()
  const { id } = h.join('分心的人')
  const spot = SPOTS[1]!
  stand(h, id, spot.x, spot.z)
  h.step()

  hold(h, id, 20)
  assert.ok(h.player(id).searchMs > 0)

  // 挪 1.5 米：还在 SEARCH_RADIUS(2.2) 之内，但超过 0.6 米的容差 ——
  // 恰好是最容易写错的一档（"还算在搜、但已经不站着了"）。
  stand(h, id, spot.x + 1.5, spot.z)
  h.step()
  const reset = h.player(id)
  assert.equal(reset.searchMs, 0, '挪超过 0.6 米必须清零')
  assert.equal(reset.searchSpotId, -1)

  // 丢掉的那 20 tick 不能白算：再搜 60 tick（1000ms < 1400ms）仍然不许完成。
  hold(h, id, 60)
  const partial = h.player(id)
  assert.ok(partial.searchMs < SEARCH_MS, '清零后的进度不能接着旧进度算')
  assert.equal(h.searched.has(1), false, '不到 1.4 秒不许结算')

  hold(h, id, 30)
  assert.equal(h.searched.has(1), true, '从 0 开始够了 1.4 秒就该搜完')
})

test('同一个点搜过一次之后再搜是空的（全场共享）', async () => {
  const h = await boot()
  const spot = SPOTS[2]!
  const first = h.join('先到的人')
  stand(h, first.id, spot.x, spot.z)
  hold(h, first.id, FULL_TICKS)
  assert.equal(h.searched.has(2), true)
  assert.ok(h.player(first.id).carriedValue > 0)
  assert.equal(h.player(first.id).searchSpotId, -1)

  // 第二个人站在同一个位置：既不该认出"身边有点"，也不该拿到任何东西。
  const second = h.join('后来的人')
  stand(h, second.id, spot.x, spot.z)
  h.step()
  assert.equal(h.player(second.id).nearSpotId, -1, '搜过的点不该再出现在身边提示里')

  hold(h, second.id, FULL_TICKS)
  const empty = h.player(second.id)
  assert.equal(empty.carriedValue, 0, '搜过的点必须什么都给不出来')
  assert.deepEqual(empty.loot, withStarterLoot([]), '搜过的点不该再给东西（只剩出生绷带）')
  assert.equal(empty.searchMs, 0, '对着空点按交互不该积累进度')
  assert.equal(empty.searchSpotId, -1)
})

test('搜刮是确定性的：同一个点两次独立重算得到同一份战利品', async () => {
  for (let i = 0; i < SPOTS.length; i++) {
    const kind = SPOTS[i]!.kind
    const once = rollLoot(i, kind)
    const twice = rollLoot(i, kind)
    assert.deepEqual(once, twice, '点 #' + i + ' 两次重算结果不一致')
    const [low, high] = kind === 'crate' ? [40, 120] : kind === 'sack' ? [25, 70] : [60, 160]
    assert.ok(once.cash >= low && once.cash <= high, '点 #' + i + ' 现金 ' + once.cash + ' 超出 ' + kind + ' 的区间')
    for (const item of once.items) {
      assert.ok(
        [LOOT_ITEM.Bandage, LOOT_ITEM.Ammo, LOOT_ITEM.Liquor, LOOT_ITEM.Watch].indexOf(item.id) >= 0,
        '未知物品 id ' + item.id,
      )
    }
  }

  // 种子真的在用：16 个点不可能全是同一份。
  const signatures = new Set(SPOTS.map((s, i) => JSON.stringify(rollLoot(i, s.kind))))
  assert.ok(signatures.size >= 10, '不同点的战利品几乎完全一样，说明种子没吃到下标')

  // 端到端：两个互相独立的世界各搜一次 #3，拿到的东西必须一模一样。
  const runs: { value: number; loot: { id: number; count: number }[] }[] = []
  for (const nickname of ['甲', '乙']) {
    const h = await boot()
    const { id } = h.join(nickname)
    stand(h, id, SPOTS[3]!.x, SPOTS[3]!.z)
    hold(h, id, FULL_TICKS)
    const player = h.player(id)
    runs.push({ value: player.carriedValue, loot: player.loot })
    assert.equal(h.searched.has(3), true)
  }
  assert.deepEqual(runs[0], runs[1], '两个独立世界的同一个点必须掉同一份东西')
})

test('尸体缓存：击杀掉落、赏金掉落、摸尸接管', async () => {
  const h = await boot()
  const a = h.join('甲')
  const b = h.join('乙')
  const A = h.player(a.id)
  const B = h.player(b.id)

  // 把乙放到 (0,0)：离任何静态搜刮点都超过 SEARCH_RADIUS，保证搜到的是尸体。
  stand(h, b.id, 0, 0)
  B.carriedValue = 300
  B.loot = [{ id: LOOT_ITEM.Bandage, count: 2 }]

  const internals = h.world as unknown as {
    kill(victim: TestPlayer, killerId: number, headshot: boolean): void
    bodyCaches: { id: number; value: number; items: { id: number; count: number }[]; bounty: boolean; x: number; z: number }[]
    match: { state: { bountyCarrier: number; phase: string } }
  }
  // 让乙成为赏金携带者，再被甲击杀。
  internals.match.state.bountyCarrier = b.id
  internals.match.state.phase = 'extract'
  internals.kill(B, a.id, false)

  assert.equal(B.carriedValue, 0, '死者现金必须清空，转进尸体')
  assert.deepEqual(B.loot, [], '死者背包必须清空，转进尸体')
  assert.equal(A.carriedValue, KILL_REWARD, '击杀者应立刻拿到击杀奖励')
  assert.equal(internals.bodyCaches.length, 1, '应留下一个尸体缓存')
  const cache = internals.bodyCaches[0]!
  assert.equal(cache.value, 300)
  assert.equal(cache.bounty, true)
  assert.ok(cache.id < SPOT_ID_NONE, '尸体缓存必须用负数 id，和静态点区分')
  assert.equal(internals.match.state.bountyCarrier, 0, '赏金应在掉落瞬间离开死者')

  // 甲走到尸体上按住 E：拿到现金/物品/赏金。
  stand(h, a.id, 0, 0)
  hold(h, a.id, FULL_TICKS)
  assert.equal(A.carriedValue, KILL_REWARD + 300, '搜尸后应拿到死者的现金')
  assert.deepEqual(
    A.loot,
    [{ id: LOOT_ITEM.Bandage, count: STARTING_BANDAGES + 2 }],
    '搜尸后应拿到死者的物品（叠加自己出生自带的绷带）',
  )
  assert.equal(internals.bodyCaches.length, 0, '搜完尸体缓存必须删除')
  assert.equal(internals.match.state.bountyCarrier, a.id, '搜尸者应接管赏金')
  assert.equal(internals.match.state.phase, 'extract', '接管赏金后应回到撤离阶段')
})


test('出生自带 1 条绷带：没有搜刮点的图也能至少止血一次', async () => {
  const h = await boot()
  const { id } = h.join('新猎人')
  assert.deepEqual(h.player(id).loot, [{ id: LOOT_ITEM.Bandage, count: STARTING_BANDAGES }])
})

test('回合清场：满血满弹、拿回出生绷带、尸体缓存计数器复位', async () => {
  const h = await boot()
  const a = h.join('甲')
  const b = h.join('乙')
  const A = h.player(a.id)
  const B = h.player(b.id)
  B.carriedValue = 100
  B.loot = [{ id: LOOT_ITEM.Watch, count: 1 }]

  const internals = h.world as unknown as {
    kill(victim: TestPlayer, killerId: number, headshot: boolean): void
    bodyCaches: { id: number; bounty: boolean }[]
    nextBodyId: number
    match: { state: { phase: string; outcome: string } }
  }
  internals.match.state.bountyCarrier = b.id
  internals.match.state.phase = 'extract'
  internals.kill(B, a.id, false)
  assert.equal(internals.bodyCaches.length, 1)
  assert.equal(internals.match.state.bountyCarrier, 0)

  // 模拟 match 走到 over，再 reset 回 hunt 的那一 tick。
  A.health = 40
  internals.match.state.phase = 'over'
  internals.match.state.outcome = 'dead'
  h.step()
  internals.match.state.phase = 'hunt'
  h.step()

  assert.equal(A.health, A.maxHealth, '新一局必须满血')
  assert.deepEqual(A.loot, [{ id: LOOT_ITEM.Bandage, count: STARTING_BANDAGES }], '新一局拿回出生绷带')
  assert.equal(B.alive, true, '上一局死掉的人要站起来')
  assert.equal(internals.bodyCaches.length, 0)
  assert.equal(internals.nextBodyId, -2, '尸体 id 计数器必须复位')

  // 池空且计数器见底时，下一条尸体要复位到 -2，而不是永远复用 -64。
  internals.nextBodyId = -65
  B.carriedValue = 1
  internals.kill(B, a.id, false)
  assert.equal(internals.bodyCaches[0]!.id, -2)
})

test('断线保留：同 userId 在宽限期内重连回同一角色、位置与战利品', async () => {
  const h = await boot()
  const socketA = { readyState: 1, sent: [], send: () => {}, close: () => {} }
  const socketB = { readyState: 1, sent: [], send: () => {}, close: () => {} }
  const first = h.world.addPlayer(socketA as unknown as WebSocket, '甲', 'user-reconnect')!
  assert.equal(first.resumed, false)
  const A = h.player(first.id)
  A.carriedValue = 250
  A.loot = [{ id: LOOT_ITEM.Watch, count: 1 }]
  A.character.teleport({ x: 5, y: GROUND, z: 7 })

  h.world.detachPlayer(first.id)
  assert.ok(A.detachedAt > 0, '断线后应进入保留状态')

  const second = h.world.addPlayer(socketB as unknown as WebSocket, '甲', 'user-reconnect')!
  assert.equal(second.resumed, true, '同账号必须接管原角色')
  assert.equal(second.id, first.id, '角色 id 不能变')
  assert.equal(second.spawn.x, 5, 'Welcome 出生点应是当前脚底位置')
  assert.equal(second.spawn.z, 7)
  assert.equal(h.player(first.id).carriedValue, 250, '携带现金必须保留')
  assert.deepEqual(h.player(first.id).loot, [{ id: LOOT_ITEM.Watch, count: 1 }])

  // 不同账号不能蹭别人的角色。
  const other = h.world.addPlayer(socketB as unknown as WebSocket, '乙', 'user-other')!
  assert.equal(other.resumed, false)
  assert.notEqual(other.id, first.id)
})


test('断线保留超时：超过宽限期仍没回来就从世界移除', async () => {
  const h = await boot()
  const socket = { readyState: 1, sent: [], send: () => {}, close: () => {} }
  const joined = h.world.addPlayer(socket as unknown as WebSocket, '甲', 'user-timeout')!
  h.world.detachPlayer(joined.id)
  h.player(joined.id).detachedAt = Date.now() - DISCONNECT_GRACE_MS - 1
  for (let i = 0; i < 30; i++) h.step()
  assert.equal(h.world.playerCount, 0, '超过宽限期必须回收角色')
})
