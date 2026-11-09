import test from 'node:test'
import assert from 'node:assert/strict'

// 与 protocol.test.ts 同一套理由：仓库根没有 @dk/* 的 workspace 链接。
// server/src/match.ts 自己 import '@dk/shared'，Node 按"引用它的那个文件"
// 的目录去找，所以从根跑也能解析到 server/node_modules/@dk/shared。
import { MatchDriver, lairOf } from '../server/src/match.ts'
import { LEVEL_MARSH } from '../shared/src/level.ts'
import {
  BANISH_MS,
  CLUE_DECAY_RATE,
  CLUE_HOLD_MS,
  decodeObjective,
  encodeObjective,
  EXTRACT_MS,
  isPersonalEscape,
  MATCH_RESET_MS,
  MATCH_SECONDS,
  Msg,
  NO_EXTRACT,
  OBJECTIVE_FLAG_DEAD,
  OBJECTIVE_FLAG_ESCAPED,
  OBJECTIVE_FLAG_LAIR,
  OBJECTIVE_SIZE,
  TICK_MS,
  type ObjectivePacket,
} from '../shared/src/index.ts'

interface Actor {
  id: number
  alive: boolean
  feet: { x: number; y: number; z: number }
}

/** 一局可复现的测试世界：只有一个猎人，位置随时改。 */
function makeRig(options: { bossDown?: () => boolean; bountyOnGround?: () => boolean } = {}) {
  const actors: Actor[] = [{ id: 7, alive: true, feet: { x: 0, y: 0, z: 0 } }]
  const driver = new MatchDriver(LEVEL_MARSH, {
    players: () => actors,
    bossDown: options.bossDown ?? (() => true),
    bountyOnGround: options.bountyOnGround ?? (() => false),
  })
  const run = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) driver.step()
  }
  const go = (x: number, z: number): void => {
    actors[0]!.feet = { x, y: 0, z }
  }
  const standAllClues = (): void => {
    for (const clue of LEVEL_MARSH.clues!) {
      go(clue.x, clue.z)
      run(Math.ceil(CLUE_HOLD_MS / TICK_MS) + 2)
    }
  }
  return { actors, driver, run, go, standAllClues }
}

const holdTicks = Math.ceil(CLUE_HOLD_MS / TICK_MS)

test('撤离结算只认真正带走赏金的人，不是全场共享 outcome', () => {
  assert.equal(isPersonalEscape('escaped', 7, 7), true)
  assert.equal(isPersonalEscape('escaped', 7, 8), false, '别人撤离不该算我撤离')
  assert.equal(isPersonalEscape('dead', 7, 7), false, '超时判负不是撤离')
  assert.equal(isPersonalEscape('none', 0, 0), false)
})

test('血巢位置是三条线索的质心，改线索就跟着走', () => {
  const lair = lairOf(LEVEL_MARSH)
  const clues = LEVEL_MARSH.clues!
  const sx = clues.reduce((sum, clue) => sum + clue.x, 0) / clues.length
  const sz = clues.reduce((sum, clue) => sum + clue.z, 0) / clues.length
  assert.equal(lair.x, sx)
  assert.equal(lair.z, sz)
  // 质心落在墙里也不纠偏：放逐半径 4.5m 足够贴着墙推进度。
  assert.equal(lairOf({ ...LEVEL_MARSH, clues: undefined }).x, 0)
})

test('站满 CLUE_HOLD_MS 拿到一条线索，中途离开按半速回退而不是清零', () => {
  const { driver, run, go } = makeRig()
  const clue = LEVEL_MARSH.clues![0]!

  go(clue.x, clue.z)
  run(Math.floor(holdTicks / 2))
  const half = driver.state.clueProgress
  assert.ok(half > 0.4 && half < 0.6, `半程进度应约 0.5，实际 ${half}`)
  assert.equal(driver.state.clueIndex, 0)

  // 走开：按 CLUE_DECAY_RATE 回退，但不清零。
  go(clue.x + 40, clue.z)
  run(Math.floor(holdTicks / 4))
  const decayed = driver.state.clueProgress
  assert.ok(decayed > 0 && decayed < half, '离开后进度必须下降但保留')
  assert.equal(driver.state.clueIndex, -1)
  assert.ok(Math.abs(decayed - (half - (CLUE_DECAY_RATE * Math.floor(holdTicks / 4)) / holdTicks)) < 0.02)

  // 进度会掉到 0 就停住，不会变负。
  run(holdTicks * 4)
  assert.equal(driver.state.clueProgress, 0)
})

test('集齐全部线索才揭示血巢并进入放逐阶段', () => {
  const { driver, run, go, standAllClues } = makeRig()
  const clues = LEVEL_MARSH.clues!

  // 差最后一条：仍然 hunt、血巢未揭示。
  for (const clue of clues.slice(0, -1)) {
    go(clue.x, clue.z)
    run(holdTicks + 2)
  }
  assert.equal(driver.state.phase, 'hunt')
  assert.equal(driver.state.cluesFound, clues.length - 1)
  assert.equal(driver.state.lairRevealed, false)

  standAllClues()
  assert.equal(driver.state.phase, 'banish')
  assert.equal(driver.state.cluesFound, clues.length)
  assert.equal(driver.state.lairRevealed, true)
  assert.equal(driver.toPacket().cluesTotal, clues.length)
})

test('线索可以任意顺序收集：站在最后一条上照样推进，掩码点亮对应光柱', () => {
  const { driver, run, go } = makeRig()
  const clues = LEVEL_MARSH.clues!
  const last = clues.length - 1

  // 直接站到最后一条上：早期实现会完全没有反应。
  go(clues[last]!.x, clues[last]!.z)
  run(holdTicks + 2)
  assert.equal(driver.state.cluesFound, 1)
  assert.equal(driver.state.clueMask, 1 << last, '点亮的是收过的那条，而不是第 0 条')
  assert.equal(driver.toPacket().clueMask, 1 << last)

  // 再回到第 0 条：还没收过的照样能收，计数继续涨。
  go(clues[0]!.x, clues[0]!.z)
  run(holdTicks + 2)
  assert.equal(driver.state.clueMask, (1 << last) | 1)
  assert.equal(driver.state.cluesFound, 2)
})

test('换一条线索从头攒进度，不把上一条的进度带走', () => {
  const { driver, run, go } = makeRig()
  const clues = LEVEL_MARSH.clues!

  go(clues[0]!.x, clues[0]!.z)
  run(Math.floor(holdTicks / 2))
  assert.ok(driver.state.clueProgress > 0.4)

  // 不离开半径就直接换人（这里是同一个人的传送，服务端看到的只是"下标变了"）。
  go(clues[1]!.x, clues[1]!.z)
  run(2)
  assert.equal(driver.state.clueIndex, 1)
  assert.ok(driver.state.clueProgress < 0.2, `换线索后进度必须重来，实际 ${driver.state.clueProgress}`)
})

test('屠夫没倒下时放逐进度不涨反降，倒下后才读得满', () => {
  let bossDown = false
  const { driver, run, go, standAllClues } = makeRig({ bossDown: () => bossDown })
  standAllClues()
  assert.equal(driver.state.lairRevealed, true)

  const lair = lairOf(LEVEL_MARSH)
  go(lair.x, lair.z)
  // 站在血巢里整整一个 BANISH_MS：屠夫还活着，进度必须还是 0。
  run(Math.ceil(BANISH_MS / TICK_MS) + 2)
  assert.equal(driver.state.banishProgress, 0)
  assert.equal(driver.state.phase, 'banish')

  // 已经攒下的进度会按 CLUE_DECAY_RATE 往回掉，而不是冻在半路等 Boss 死。
  driver.state.banishProgress = 0.5
  run(10)
  assert.ok(driver.state.banishProgress < 0.5, '没杀屠夫时进度必须回退')
  assert.ok(driver.state.banishProgress > 0.4, '回退是半速，不该一 tick 掉光')

  bossDown = true
  run(Math.ceil(BANISH_MS / TICK_MS) + 2)
  assert.equal(driver.state.phase, 'extract')
  assert.equal(driver.state.bountyCarrier, 7)
})

test('放逐同 tick 多人到场时赏金归最近的人，不依赖遍历顺序', () => {
  const { actors, driver, run, go, standAllClues } = makeRig()
  standAllClues()

  const lair = lairOf(LEVEL_MARSH)
  // 把 id 7（远的那位）钉在血巢正中心，id 3 摆在边上：若实现按遍历顺序取第一个
  // 到场者，它拿到的是 id 3，这条就会挂。
  actors[0]!.feet = { x: lair.x, y: 0, z: lair.z }
  actors.unshift({ id: 3, alive: true, feet: { x: lair.x + 3.5, y: 0, z: lair.z } })
  run(Math.ceil(BANISH_MS / TICK_MS) + 2)

  assert.equal(driver.state.phase, 'extract')
  assert.equal(driver.state.bountyCarrier, 7)
})

test('赏金携带者阵亡时赏金落回血巢，回到放逐阶段重新抢', () => {
  const { actors, driver, run, go, standAllClues } = makeRig()
  standAllClues()
  const lair = lairOf(LEVEL_MARSH)
  go(lair.x, lair.z)
  run(Math.ceil(BANISH_MS / TICK_MS) + 2)
  assert.equal(driver.state.phase, 'extract')

  actors[0]!.alive = false
  run(1)
  assert.equal(driver.state.phase, 'banish')
  assert.equal(driver.state.bountyCarrier, 0)
  assert.equal(driver.state.banishProgress, 0)
  assert.equal(driver.state.extractProgress, 0)
})

test('赏金掉在尸体上时保持撤离阶段，不退回放逐', () => {
  let onGround = false
  const { actors, driver, run, go, standAllClues } = makeRig({ bountyOnGround: () => onGround })
  standAllClues()
  const lair = lairOf(LEVEL_MARSH)
  go(lair.x, lair.z)
  run(Math.ceil(BANISH_MS / TICK_MS) + 2)
  assert.equal(driver.state.phase, 'extract')

  // 携带者阵亡，但赏金落在尸体缓存里：阶段不能退回 banish。
  actors[0]!.alive = false
  onGround = true
  run(1)
  assert.equal(driver.state.phase, 'extract')
  assert.equal(driver.state.bountyCarrier, 0)
  assert.equal(driver.state.extractProgress, 0)

  // 有人摸到赏金：重新成为携带者，撤离继续。
  actors[0]!.alive = true
  onGround = false
  driver.state.bountyCarrier = 7
  driver.state.phase = 'extract'
  run(1)
  assert.equal(driver.state.phase, 'extract')
  assert.equal(driver.state.bountyCarrier, 7)
})

test('撤离进度中途离开也按半速回退，读满才判定撤离成功', () => {
  const { driver, run, go, standAllClues } = makeRig()
  standAllClues()
  const lair = lairOf(LEVEL_MARSH)
  go(lair.x, lair.z)
  run(Math.ceil(BANISH_MS / TICK_MS) + 2)

  const extract = LEVEL_MARSH.extracts![0]!
  const extractTicks = Math.ceil(EXTRACT_MS / TICK_MS)
  go(extract.x, extract.z)
  run(Math.floor(extractTicks / 4))
  const mid = driver.state.extractProgress
  assert.ok(mid > 0.2 && mid < 0.3, `撤离四分之一处应约 0.25，实际 ${mid}`)
  assert.equal(driver.state.extractIndex, 0)

  go(extract.x + 30, extract.z)
  run(Math.floor(extractTicks / 10))
  assert.ok(driver.state.extractIndex === -1 && driver.state.extractProgress < mid)
  assert.equal(driver.state.outcome, 'none', '退出去不等于失败')

  go(extract.x, extract.z)
  run(extractTicks + 2)
  assert.equal(driver.state.phase, 'over')
  assert.equal(driver.state.outcome, 'escaped')
  // 时钟必须停在撤离那一刻的剩余时间上。旧实现进 over 就清零，结果"带着赏金
  // 走出去"和"被时间耗死"在 HUD 上是同一个 00:00，玩家看不出自己是赢了还是输了。
  assert.ok(driver.state.secondsLeft > 0, `撤离成功时时钟应保留剩余时间，实际 ${driver.state.secondsLeft}`)
})

test('复盘停留 MATCH_RESET_MS 之后自动开下一局并清空所有进度', () => {
  const { driver, run, go, standAllClues } = makeRig()
  standAllClues()
  const lair = lairOf(LEVEL_MARSH)
  go(lair.x, lair.z)
  run(Math.ceil(BANISH_MS / TICK_MS) + 2)
  const extract = LEVEL_MARSH.extracts![0]!
  go(extract.x, extract.z)
  run(Math.ceil(EXTRACT_MS / TICK_MS) + 2)
  assert.equal(driver.state.outcome, 'escaped')

  run(Math.ceil(MATCH_RESET_MS / TICK_MS) + 2)
  assert.equal(driver.state.phase, 'hunt')
  assert.equal(driver.state.outcome, 'none')
  assert.equal(driver.state.cluesFound, 0)
  assert.equal(driver.state.lairRevealed, false)
  // reset() 把驱动自己的 tick 一起归零，所以新一局是从满时间重新起跑的。
  assert.equal(driver.state.secondsLeft, MATCH_SECONDS)
  assert.equal(driver.state.clueIndex, -1)
  assert.equal(driver.state.bountyCarrier, 0)
})

test('时间耗尽只判负、不踢人：phase 变 over，玩家仍在 actors 里', () => {
  const { actors, driver, run } = makeRig()
  run(Math.ceil((MATCH_SECONDS * 1000) / TICK_MS) + 2)
  assert.equal(driver.state.phase, 'over')
  assert.equal(driver.state.outcome, 'dead')
  assert.equal(driver.state.secondsLeft, 0)
  assert.equal(actors.length, 1, '超时不该把玩家从世界里删掉')
})

test('目标包是 25 字节，-1 的下标走 NO_EXTRACT，进度量化误差不超过 1/255', () => {
  const packet: ObjectivePacket = {
    phase: 'banish',
    modifier: 2,
    cluesFound: 3,
    clueMask: 0b101,
    cluesTotal: 3,
    lairRevealed: true,
    clueIndex: -1,
    clueProgress: 0,
    banishProgress: 0.4,
    bountyCarrier: 513,
    extractIndex: -1,
    extractProgress: 0,
    secondsLeft: 65535,
    outcome: 'none',
    event: 1,
    eventX: -12,
    eventZ: 34,
    eventSeconds: 10,
    doorsMask: 0b101,
    trapsMask: 0b011,
  }
  const buffer = encodeObjective(packet)
  assert.equal(buffer.byteLength, OBJECTIVE_SIZE)
  assert.equal(OBJECTIVE_SIZE, 25)

  const view = new DataView(buffer)
  assert.equal(view.getUint8(0), Msg.Objective)
  assert.equal(view.getUint8(5), NO_EXTRACT)
  assert.equal(NO_EXTRACT, 255)
  assert.equal(view.getUint8(10), NO_EXTRACT)
  assert.equal(view.getUint8(4), OBJECTIVE_FLAG_LAIR)

  const back = decodeObjective(buffer)
  assert.deepEqual(back, packet)
})

test('目标包的 outcome 落在 flags 的第 1、2 位，两者互斥', () => {
  const base: ObjectivePacket = {
    phase: 'over',
    cluesFound: 0,
    clueMask: 0,
    cluesTotal: 3,
    lairRevealed: false,
    clueIndex: -1,
    clueProgress: 0,
    banishProgress: 0,
    bountyCarrier: 0,
    extractIndex: -1,
    extractProgress: 0,
    secondsLeft: 0,
    outcome: 'escaped',
  }
  const escaped = new DataView(encodeObjective(base))
  assert.equal(escaped.getUint8(4) & OBJECTIVE_FLAG_ESCAPED, OBJECTIVE_FLAG_ESCAPED)
  assert.equal(escaped.getUint8(4) & OBJECTIVE_FLAG_DEAD, 0)

  const dead = new DataView(encodeObjective({ ...base, outcome: 'dead' }))
  assert.equal(dead.getUint8(4) & OBJECTIVE_FLAG_DEAD, OBJECTIVE_FLAG_DEAD)
  assert.equal(dead.getUint8(4) & OBJECTIVE_FLAG_ESCAPED, 0)

  // 'none' 两位都不置：客户端据此区分"还没结束"和"输了"。
  assert.equal(new DataView(encodeObjective({ ...base, outcome: 'none' })).getUint8(4), 0)
  assert.equal(decodeObjective(encodeObjective({ ...base, outcome: 'none' })).outcome, 'none')
})

test('解码器把越界的相位号与小数进度都夹回合法区间', () => {
  const packet: ObjectivePacket = {
    phase: 'extract',
    cluesFound: 300,
    clueMask: 0,
    cluesTotal: 0,
    lairRevealed: false,
    clueIndex: 17,
    clueProgress: 1.7,
    banishProgress: -2,
    bountyCarrier: 1,
    extractIndex: 2,
    extractProgress: 0.004,
    secondsLeft: 70000,
    outcome: 'none',
  }
  const back = decodeObjective(encodeObjective(packet))
  assert.equal(back.cluesFound, 255, 'u8 上限')
  assert.equal(back.clueProgress, 1, '超过 1 的进度夹到 1')
  assert.equal(back.banishProgress, 0, '负进度夹到 0')
  assert.equal(back.secondsLeft, 65535, 'u16 上限')
  assert.ok(Math.abs(back.extractProgress - 0.004) <= 1 / 255)
})
