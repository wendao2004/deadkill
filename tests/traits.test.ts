import test from 'node:test'
import assert from 'node:assert/strict'

import { Buttons, HEAL_AMOUNT, HEAL_MS, MAX_HEALTH, TICK_MS } from '../shared/src/constants.ts'
import { DEFAULT_LEVEL_ID, LEVELS } from '../shared/src/level.ts'
import { LOOT_ITEM, Msg, decodeText } from '../shared/src/protocol.ts'
import {
  MAX_TRAITS,
  TRAITS,
  TRAIT_COST,
  TRAIT_FX,
  TRAIT_MAX_LEVEL,
  Trait,
  actionScale,
  clampTraitLevels,
  damageTakenScale,
  fireIntervalScale,
  lootCashScale,
  maxHealthBonus,
  meleeDamageScale,
  normalizeTraitLevels,
  packSelection,
  selectionOf,
  setTraitLevel,
  spreadScale,
  switchScale,
  toggleSelection,
  traitCount,
  traitLevel,
  traitList,
  traitUpgradeCost,
} from '../shared/src/traits.ts'
import { initPhysics } from '../shared/src/worldbuild.ts'
import { World, rollLoot } from '../server/src/world.ts'
import type { WebSocket } from 'ws'

/** 只装备一条天赋，并给它指定等级 —— 服务端收到的就是这种形状。 */
function solo(bit: number, level: number): number {
  return packSelection(bit, setTraitLevel(0, bit, level))
}

// ---------------------------------------------------------------- 等级打包

test('等级打包：每条天赋占 2 bit，0..3 两个方向都可逆', () => {
  let packed = 0
  for (const spec of TRAITS) packed = setTraitLevel(packed, spec.bit, 2)
  assert.equal(traitCount(packed), TRAITS.length)
  for (const spec of TRAITS) assert.equal(traitLevel(packed, spec.bit), 2)

  // 越界等级一律夹到 0..3：4 会溢出到隔壁那条天赋身上，那是最恶心的一种串味。
  assert.equal(traitLevel(setTraitLevel(0, Trait.HundredHands, 9), Trait.Ambidextrous), 0)
  assert.equal(traitLevel(setTraitLevel(0, Trait.HundredHands, 9), Trait.HundredHands), TRAIT_MAX_LEVEL)
  assert.equal(traitLevel(setTraitLevel(0, Trait.HundredHands, -3), Trait.HundredHands), 0)
})

test('脏存档：表外的高位必须丢掉，非法等级不许带出隐形天赋', () => {
  // 表里只用到 20 bit（10 条 × 2）；再往上是脏数据。
  assert.equal(normalizeTraitLevels(1 << 24), 0)
  // 合法的部分必须原样保留。
  const good = setTraitLevel(0, Trait.Scavenger, 3)
  assert.equal(normalizeTraitLevels(good | (1 << 26)), good)
  assert.equal(normalizeTraitLevels(Number.NaN), 0)
})

test('最多三条：超选按表顺序截断，先选的先留下', () => {
  let all = 0
  for (const spec of TRAITS) all = setTraitLevel(all, spec.bit, 1)
  const kept = clampTraitLevels(all)
  assert.equal(traitCount(kept), MAX_TRAITS)
  assert.deepEqual(
    traitList(kept).map((entry) => entry.spec.bit),
    TRAITS.slice(0, MAX_TRAITS).map((spec) => spec.bit),
    '超选时必须按 TRAITS 的顺序取前三条，否则大厅显示和实际生效会对不上',
  )
  // 已经合规的必须原样返回：clamp 不能顺手改掉玩家的选择。
  const two = solo(Trait.IronGrip, 2) | solo(Trait.Bulwark, 1)
  assert.equal(clampTraitLevels(two), two)
})

test('选中掩码：点一下选上、再点取消、满三条之后点新卡什么都不做', () => {
  const two = TRAITS[0]!.bit | TRAITS[1]!.bit
  assert.equal(toggleSelection(two, TRAITS[2]!.bit), two | TRAITS[2]!.bit, '没满时必须能加上')
  assert.equal(toggleSelection(two, TRAITS[1]!.bit), TRAITS[0]!.bit, '再点一次必须取消')
  const three = TRAITS[0]!.bit | TRAITS[1]!.bit | TRAITS[2]!.bit
  assert.equal(toggleSelection(three, TRAITS[5]!.bit), three, '满了之后点新卡必须什么都不做')
})

test('packSelection：只把"选中且已解锁"的那几条等级带到局内', () => {
  const owned = setTraitLevel(setTraitLevel(0, Trait.HundredHands, 3), Trait.Bulwark, 2)
  const packed = packSelection(Trait.HundredHands | Trait.Scavenger, owned)
  assert.equal(traitLevel(packed, Trait.HundredHands), 3, '选中且已拥有：按已有等级生效')
  assert.equal(traitLevel(packed, Trait.Scavenger), 0, '选了但没解锁：不许生效')
  assert.equal(traitLevel(packed, Trait.Bulwark), 0, '已拥有但没选：不许生效')
  assert.equal(selectionOf(packed), Trait.HundredHands, '服务端要能从小包里反查选择了哪些')
})

test('价目：解锁 120，二级 320，三级 760，满级之后不再收费', () => {
  assert.equal(traitUpgradeCost(0), TRAIT_COST[0])
  assert.equal(traitUpgradeCost(1), TRAIT_COST[1])
  assert.equal(traitUpgradeCost(2), TRAIT_COST[2])
  assert.equal(traitUpgradeCost(3), 0)
})

// ---------------------------------------------------------------- 倍率

test('倍率：每条天赋只影响它该影响的东西，且随等级变强', () => {
  assert.equal(meleeDamageScale(0), 1)
  assert.equal(meleeDamageScale(solo(Trait.HundredHands, 1)), TRAIT_FX.meleeDamage[0])
  assert.equal(meleeDamageScale(solo(Trait.HundredHands, 3)), TRAIT_FX.meleeDamage[2])
  assert.equal(switchScale(solo(Trait.Ambidextrous, 2)), TRAIT_FX.switchTime[1])
  assert.equal(switchScale(solo(Trait.Bulwark, 3)), 1)
  assert.equal(damageTakenScale(solo(Trait.Bulwark, 3)), TRAIT_FX.damageTaken[2])
  assert.equal(spreadScale(solo(Trait.IronGrip, 1)), TRAIT_FX.spread[0])
  assert.equal(actionScale(solo(Trait.QuickHand, 3)), TRAIT_FX.actionTime[2])
  assert.equal(lootCashScale(solo(Trait.Scavenger, 2)), TRAIT_FX.lootCash[1])
  assert.equal(maxHealthBonus(solo(Trait.Vigor, 3)), TRAIT_FX.maxHealth[2])
  // 左右开工只加快转轮，步枪射速不许跟着变 —— 否则它变成一把无脑全加成。
  assert.equal(fireIntervalScale('revolver', solo(Trait.Ambidextrous, 1)), TRAIT_FX.revolverInterval[0])
  assert.equal(fireIntervalScale('rifle', solo(Trait.Ambidextrous, 3)), 1)
  // 百臂巨人只加快挥刀。
  assert.equal(fireIntervalScale('knife', solo(Trait.HundredHands, 2)), TRAIT_FX.meleeInterval[1])
  assert.equal(fireIntervalScale('knife', solo(Trait.Ambidextrous, 3)), 1)
})

// ---------------------------------------------------------------- 包扎（真 World 驱动）

const GROUND = LEVELS[DEFAULT_LEVEL_ID]!.groundY

interface TestPlayer {
  character: {
    feet: { x: number; y: number; z: number }
    teleport(feet: { x: number; y: number; z: number }): void
  }
  health: number
  loot: { id: number; count: number }[]
  heal: boolean
  healMs: number
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
  join(nickname: string): { id: number; socket: FakeSocket }
}

let physicsReady: Promise<void> | null = null

async function boot(): Promise<Harness> {
  physicsReady ??= initPhysics()
  await physicsReady
  const world = new World({ id: 'traits-test' })
  const internals = world as unknown as { step(): void; players: Map<number, TestPlayer> }
  let socket: FakeSocket = { readyState: 1, sent: [], send: () => {}, close: () => {} }
  return {
    world,
    step: () => internals.step(),
    player: (id) => internals.players.get(id)!,
    join(nickname) {
      socket = {
        readyState: 1,
        sent: [],
        send: (buffer: ArrayBuffer) => {
          if (socket.readyState === 1) socket.sent.push(buffer)
        },
        close: () => {},
      }
      const joined = world.addPlayer(socket as unknown as WebSocket, nickname)!
      return { id: joined.id, socket }
    },
  }
}

/** 按住给定按键 n 个 tick。 */
function hold(h: Harness, id: number, ticks: number, buttons: number): void {
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

function stand(h: Harness, id: number, x: number, z: number): void {
  h.player(id).character.teleport({ x, y: GROUND, z })
}

/** 扎一针需要的 tick 数（算上浮点余量）。 */
function healTicks(scale = 1): number {
  return Math.ceil((HEAL_MS * scale) / TICK_MS) + 2
}

test('包扎：按住 F 满 HEAL_MS 吃一条绷带、回 HEAL_AMOUNT 血', async () => {
  const h = await boot()
  const { id, socket } = h.join('包扎的人')
  stand(h, id, 0, 0)
  const p = h.player(id)
  p.health = 80
  p.loot = [{ id: LOOT_ITEM.Bandage, count: 2 }]
  h.step()

  // 扎一半：血一点没涨、绷带也还没扣。这条断言就是"打药不能被跳过"的守卫。
  hold(h, id, 20, Buttons.Heal)
  assert.ok(p.healMs > 0, '按住 F 必须开始积累进度')
  assert.equal(p.health, 80, '进度没满不许提前回血')
  assert.equal(p.loot[0]!.count, 2, '进度没满不许扣绷带')

  hold(h, id, healTicks(), Buttons.Heal)
  assert.equal(p.health, 80 + HEAL_AMOUNT, '扎完必须回满 HEAL_AMOUNT')
  assert.equal(p.loot[0]!.count, 1, '扎一次扣一条绷带')
  // 不在这里断言 healMs === 0：手里还有第二条绷带、血也没满，包扎会自动接着开始
  // （这正是我们想要的粘手行为），所以进度条在扎完的那一刻就已经从 0 重新长了。

  const texts = socket.sent.filter((b) => new Uint8Array(b)[0] === Msg.Text).map((b) => decodeText(b))
  assert.ok(
    texts.some((t) => t.includes('包扎完成') && t.includes('+' + HEAL_AMOUNT)),
    '扎完必须给一句提示，实际收到：' + JSON.stringify(texts),
  )
})

test('包扎：满血按住 F 什么都不发生（不浪费绷带）', async () => {
  const h = await boot()
  const { id } = h.join('满血的人')
  stand(h, id, 0, 0)
  const p = h.player(id)
  p.health = MAX_HEALTH
  p.loot = [{ id: LOOT_ITEM.Bandage, count: 1 }]
  hold(h, id, healTicks() * 2, Buttons.Heal)
  assert.equal(p.health, MAX_HEALTH)
  assert.equal(p.loot[0]!.count, 1, '满血不该白白消耗绷带')
  assert.equal(p.healMs, 0)
})

test('包扎：没有绷带时按 F 不会凭空回血', async () => {
  const h = await boot()
  const { id } = h.join('空手的人')
  stand(h, id, 0, 0)
  const p = h.player(id)
  p.health = 40
  p.loot = []
  hold(h, id, healTicks() * 2, Buttons.Heal)
  assert.equal(p.health, 40, '没有绷带就绝不能回血 —— 否则"打药"这条机制等于不存在')
  assert.equal(p.healMs, 0)
})

test('包扎：中途走开超过容差就清零，进度不保留', async () => {
  const h = await boot()
  const { id } = h.join('乱跑的人')
  stand(h, id, 0, 0)
  const p = h.player(id)
  p.health = 80
  p.loot = [{ id: LOOT_ITEM.Bandage, count: 1 }]
  hold(h, id, 40, Buttons.Heal)
  assert.ok(p.healMs > 0)

  // 挪 2 米：包扎是"站定不动"的动作，跑动中缠绷带会让它变成一个可以随时取用的血包。
  stand(h, id, 2, 0)
  hold(h, id, 2, Buttons.Heal)
  // 清零之后同一帧就会从新位置重新开扎，所以只能断言"从头开始"，不能断言等于 0。
  assert.ok(p.healMs <= TICK_MS * 2 + 0.01, '位移超过容差必须从 0 重来，实际 ' + p.healMs)
  assert.equal(p.health, 80)
  assert.equal(p.loot[0]!.count, 1)
})

test('快手：包扎与搜刮都只要七成时间', async () => {
  const slow = await boot()
  const fast = await boot()
  for (const h of [slow, fast]) {
    const { id } = h.join('对比')
    stand(h, id, 0, 0)
    const p = h.player(id)
    p.health = 80
    p.loot = [{ id: LOOT_ITEM.Bandage, count: 1 }]
    h.step()
    if (h === fast) {
      h.world.receiveLoadout(id, 1, solo(Trait.QuickHand, 3))
      h.step()
    }
    // 两个世界都只按"七成时间 + 2 tick"，此时未加速的那个还不该扎完。
    hold(h, id, healTicks(TRAIT_FX.actionTime[2]), Buttons.Heal)
  }
  assert.equal(fast.player(1).health, 80 + HEAL_AMOUNT, '带快手必须更早扎完')
  assert.equal(slow.player(1).health, 80, '没带快手不许提前扎完')

  // 剩余时间给足之后，没加速的也能扎完 —— 差别只在时间，不是"扎不动"。
  hold(slow, 1, healTicks(), Buttons.Heal)
  assert.equal(slow.player(1).health, 80 + HEAL_AMOUNT)
})

test('搜到的绷带只进背包，不回血', async () => {
  const h = await boot()
  // 找一个确定掉绷带的搜刮点：要按这一局真正的种子去算，否则"哪个点掉绷带"
  // 跟世界里的骰子对不上（种子每局不同）。
  const spots = LEVELS[DEFAULT_LEVEL_ID]!.searchSpots ?? []
  const index = spots.findIndex((s, i) =>
    rollLoot(i, s.kind, h.world.lootSeed).items.some((it) => it.id === LOOT_ITEM.Bandage),
  )
  assert.ok(index >= 0, '这张图必须至少有一个点会掉绷带')
  const { id } = h.join('搜刮的人')
  const p = h.player(id)
  stand(h, id, spots[index]!.x, spots[index]!.z)
  p.health = 100
  h.step()

  // 交互键和包扎键是两个位：搜刮时同时按 F 不该把刚搜到的绷带立刻用掉。
  let seq = 1
  for (let i = 0; i < Math.ceil(1400 / TICK_MS) + 4; i++) {
    h.world.receiveInput(
      id,
      [{ seq: seq++, dtMs: TICK_MS, forward: 0, right: 0, yaw: 0, pitch: 0, buttons: Buttons.Interact }],
      0,
    )
    h.step()
  }
  assert.ok(
    p.loot.some((item) => item.id === LOOT_ITEM.Bandage),
    '搜到绷带必须进背包，实际背包：' + JSON.stringify(p.loot),
  )
  assert.equal(p.health, 100, '绷带落进背包的那一刻不许立刻回血 —— 打药是个动作')
})
