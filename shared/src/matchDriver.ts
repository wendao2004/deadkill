/**
 * 一局比赛的目标流程推进器：线索 → 放逐 → 撤离。
 *
 * 纯逻辑（加一点点"遍历玩家位置"的世界访问），**不碰物理、不发包** ——
 * 发包由 world.ts 的 publishObjective 做。这样这个文件能被单测直接跑，
 * 不必起一个 Rapier 世界。
 *
 * ## 三条设计规则
 *
 * 1. **目标是全局单份状态**，不是每人一份。若每人一份，HUD 该画谁的？而且
 *    "谁先摸到血巢"本身的争夺就是玩法 —— 共享一份等于逼两队抢同一个进度条。
 * 2. **进度不清零，只回退**。离开线索 / 撤离点之后按 `CLUE_DECAY_RATE` 半速回退：
 *    被怪打断一次就前功尽弃的挫败感，远大于"站着不能动"的风险感。
 * 3. **超时不踢人**：`secondsLeft` 归零只是把 outcome 记成 dead。踢掉的话，
 *    上层就分不清"这一局输了"和"网络断了"。
 */

import {
  BANISH_MS,
  CLUE_DECAY_RATE,
  CLUE_HOLD_MS,
  CLUE_RADIUS,
  CLUE_TOTAL,
  EXTRACT_MS,
  EXTRACT_RADIUS,
  LAIR_RADIUS,
  EVENT_BLOODMOON,
  EVENT_NONE,
  EVENT_SUPPLY,
  MATCH_RESET_MS,
  MATCH_SECONDS,
  createMatchState,
  lairOf,
  type MatchState,
  type ObjectivePacket,
} from './match.ts'
import { TICK_MS } from './constants.ts'
import type { LevelDef } from './level.ts'
import type { Vec3 } from './math.ts'

/** 推进器需要的世界访问，用接口而不是直接吃 World，避免循环依赖。 */
export interface MatchActors {
  /** 所有玩家的脚底位置与存活状态。每 tick 调一次，实现里别分配大对象。 */
  players(): Iterable<{ id: number; alive: boolean; feet: Vec3 }>
  /**
   * 血巢的 Boss 是否已经被打死。
   *
   * 放逐的门禁：线索集齐只是"找到了地方"，得先把守在那里的屠夫打死，血巢才
   * 认账。没有这个门禁，最省事的打法就是绕开 Boss 直接站桩 25 秒 —— 一个
   * 1500 血的怪变得完全不用打，那它就不该存在。
   */
  bossDown(): boolean
  /**
   * 赏金是否正躺在某具尸体缓存里。
   *
   * 携带者死后，赏金不再"回炉到血巢"：它掉在死亡点，谁摸到谁成为新的携带者。
   * 只要它还在地上，`stepExtract` 就不能把阶段退回 banish —— 否则玩家刚看到
   * "赏金掉落"，下一 tick 又被告知"去血巢重新站 25 秒"。
   */
  bountyOnGround(): boolean
}

export class MatchDriver {
  readonly state: MatchState = createMatchState()
  private readonly level: LevelDef
  private readonly actors: MatchActors
  private readonly lair: { x: number; z: number }
  /** 本驱动自己的 tick 计数（从 0 起），只用来换算倒计时与各阶段时长。 */
  private tick = 0
  /** 世界事件只触发一次。 */
  private supplyDone = false
  private bloodMoonDone = false
  private supplyUntilTick = 0

  constructor(level: LevelDef, actors: MatchActors) {
    this.level = level
    this.actors = actors
    this.lair = lairOf(level)
  }

  get lairPosition(): { x: number; z: number } {
    return this.lair
  }

  /** 关卡里的实际线索条数。打包用真实值，而不是常量 —— 改关卡不必再改常量。 */
  get clueCount(): number {
    return this.level.clues?.length ?? CLUE_TOTAL
  }

  toPacket(): ObjectivePacket {
    const s = this.state
    return {
      phase: s.phase,
      cluesFound: s.cluesFound,
      clueMask: s.clueMask,
      cluesTotal: this.clueCount,
      lairRevealed: s.lairRevealed,
      clueIndex: s.clueIndex,
      clueProgress: s.clueProgress,
      banishProgress: s.banishProgress,
      bountyCarrier: s.bountyCarrier,
      extractIndex: s.extractIndex,
      extractProgress: s.extractProgress,
      secondsLeft: s.secondsLeft,
      outcome: s.outcome,
      modifier: s.modifier,
      event: s.event,
      eventX: s.eventX,
      eventZ: s.eventZ,
      eventSeconds: s.eventSeconds,
      doorsMask: s.doorsMask,
      trapsMask: s.trapsMask,
      lightsMask: s.lightsMask,
    }
  }

  /**
   * 每 tick 调一次。
   *
   * 顺序有意：先结算计时与复盘，再推进**当前阶段**的交互。切阶段之后本 tick
   * 直接 `return`，这样不会出现"一帧内连跨两个阶段"（集齐最后一条线索的同 tick
   * 又开始放逐）导致 HUD 少一次过渡。
   */
  step(): void {
    const s = this.state
    this.tick++

    if (s.phase === 'over') {
      // 不把 secondsLeft 清零：撤离成功和超时判负都会进 over，清零后两种结局在
      // 时钟上长得一模一样，玩家会以为自己是被时间耗死的。保留结束瞬间的剩余时间。
      const overTicks = Math.ceil(MATCH_RESET_MS / TICK_MS)
      if (s.overTick !== 0 && this.tick - s.overTick >= overTicks) this.reset()
      return
    }

    const secondsLeft = Math.max(0, MATCH_SECONDS - Math.floor((this.tick * TICK_MS) / 1000))
    s.secondsLeft = secondsLeft
    if (secondsLeft === 0) {
      s.outcome = 'dead'
      s.phase = 'over'
      s.overTick = this.tick
      s.extractProgress = 0
      s.extractIndex = -1
      return
    }

    this.stepEvents(secondsLeft)
    if (s.phase === 'hunt') this.stepHunt()
    else if (s.phase === 'banish') this.stepBanish()
    else this.stepExtract()
  }

  /**
   * 世界事件排期：每局都不同，但由 tick 决定，两端 + 重放完全一致。
   *
   * - 补给空投：开局 5 分钟，落点是离图心最近的区域（所有人都会去抢）。
   * - 血月：最后 3 分钟，怪更多、收益更高。
   */
  private stepEvents(secondsLeft: number): void {
    const s = this.state
    if (s.phase === 'over') return
    const elapsed = MATCH_SECONDS - secondsLeft

    if (!this.supplyDone && elapsed >= 300) {
      this.supplyDone = true
      const spot = this.supplyPoint()
      s.event = EVENT_SUPPLY
      s.eventX = spot.x
      s.eventZ = spot.z
      this.supplyUntilTick = this.tick + Math.ceil(10_000 / TICK_MS)
      s.eventSeconds = 10
      return
    }
    if (!this.bloodMoonDone && secondsLeft <= 180) {
      this.bloodMoonDone = true
      s.event = EVENT_BLOODMOON
      s.eventSeconds = secondsLeft
      return
    }
    if (s.event === EVENT_SUPPLY) {
      s.eventSeconds = Math.max(0, Math.ceil(((this.supplyUntilTick - this.tick) * TICK_MS) / 1000))
      if (s.eventSeconds <= 0) s.event = EVENT_NONE
    } else if (s.event === EVENT_BLOODMOON) {
      s.eventSeconds = secondsLeft
    }
  }

  private supplyPoint(): { x: number; z: number } {
    const zones = this.level.zones ?? []
    if (zones.length === 0) return { x: 0, z: 0 }
    let best = zones[0]!
    for (const zone of zones) {
      if (Math.hypot(zone.x, zone.z) < Math.hypot(best.x, best.z)) best = zone
    }
    return { x: best.x, z: best.z }
  }

  // ------------------------------------------------------------ 三个阶段

  private stepHunt(): void {
    const s = this.state
    const clues = this.level.clues ?? []
    if (clues.length === 0) return

    // 找**最近**的未找线索：不按 0→1→2 排队（站错那条就完全没反应的挫败感，
    // 远大于"按顺序推进"带来的仪式感），也不按最低下标（两个人分别站在第 0 和
    // 第 2 条上时，进度条应该跟着离人最近的那条走）。
    let bestIndex = -1
    let bestDistance = CLUE_RADIUS * CLUE_RADIUS
    for (let i = 0; i < clues.length; i++) {
      if ((s.clueMask & (1 << i)) !== 0) continue
      const clue = clues[i]!
      for (const actor of this.actors.players()) {
        if (!actor.alive) continue
        const dx = actor.feet.x - clue.x
        const dz = actor.feet.z - clue.z
        const distance = dx * dx + dz * dz
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = i
        }
      }
    }

    if (bestIndex < 0) {
      // 没人在收集：半速回退，不清零。
      s.clueProgress = Math.max(0, s.clueProgress - (TICK_MS / CLUE_HOLD_MS) * CLUE_DECAY_RATE)
      s.clueIndex = -1
      return
    }

    // 换了一条线索就从头攒：进度只属于"s.clueIndex 那条"，跟着人搬到 40 米外
    // 的另一条上就等于白送 90%。离开范围（clueIndex = -1）仍然保留进度回退。
    if (s.clueIndex >= 0 && s.clueIndex !== bestIndex) s.clueProgress = 0
    s.clueIndex = bestIndex
    s.clueProgress += TICK_MS / CLUE_HOLD_MS
    if (s.clueProgress < 1) return

    s.clueProgress = 0
    s.clueIndex = -1
    s.clueMask |= 1 << bestIndex
    s.cluesFound = countBits(s.clueMask)
    if (s.cluesFound >= clues.length) {
      s.cluesFound = clues.length
      s.lairRevealed = true
      s.phase = 'banish'
    }
  }

  private stepBanish(): void {
    const s = this.state
    // Boss 没死就不给进度：站桩的收益必须低于"先打掉 1500 血"，
    // 否则屠夫只是背景板。进度按回退速度掉，人离开时也是同一条曲线。
    if (!this.actors.bossDown()) {
      s.banishProgress = Math.max(0, s.banishProgress - (TICK_MS / BANISH_MS) * CLUE_DECAY_RATE)
      return
    }
    let occupant: { id: number; distance: number } | null = null
    for (const actor of this.actors.players()) {
      if (!actor.alive) continue
      const dx = actor.feet.x - this.lair.x
      const dz = actor.feet.z - this.lair.z
      const distance = Math.hypot(dx, dz)
      if (distance > LAIR_RADIUS) continue
      if (occupant === null || distance < occupant.distance) {
        occupant = { id: actor.id, distance }
      }
    }

    if (occupant === null) {
      s.banishProgress = Math.max(0, s.banishProgress - (TICK_MS / BANISH_MS) * CLUE_DECAY_RATE)
      return
    }

    s.banishProgress += TICK_MS / BANISH_MS
    if (s.banishProgress < 1) return

    // 离血巢最近的那个人拿走赏金：同 tick 多人在场时，这条规则可复现，
    // 不依赖 Map 的遍历顺序。
    s.banishProgress = 1
    s.bountyCarrier = occupant.id
    s.phase = 'extract'
  }

  private stepExtract(): void {
    const s = this.state
    const extracts = this.level.extracts ?? []
    const carrier = this.carrier()
    if (extracts.length === 0) {
      s.bountyCarrier = 0
      s.banishProgress = 0
      s.phase = 'banish'
      return
    }
    // 携带者阵亡 → 赏金落在地上（由 World 的尸体缓存承载），全场再抢一次。
    // 只要赏金还在地上，就保持 extract 阶段、不要退回 banish：玩家刚看到
    // "赏金掉落"又被要求回血巢站 25 秒，是两套互相打脸的规则。
    if (carrier === null) {
      s.bountyCarrier = 0
      s.extractIndex = -1
      s.extractProgress = 0
      if (!this.actors.bountyOnGround()) {
        s.banishProgress = 0
        s.phase = 'banish'
      }
      return
    }

    let bestIndex = -1
    let bestDistance = EXTRACT_RADIUS * EXTRACT_RADIUS
    for (let i = 0; i < extracts.length; i++) {
      const extract = extracts[i]!
      const dx = carrier.x - extract.x
      const dz = carrier.z - extract.z
      const distance = dx * dx + dz * dz
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = i
      }
    }

    if (bestIndex < 0) {
      s.extractIndex = -1
      s.extractProgress = Math.max(0, s.extractProgress - (TICK_MS / EXTRACT_MS) * CLUE_DECAY_RATE)
      return
    }

    s.extractIndex = bestIndex
    s.extractProgress += TICK_MS / EXTRACT_MS
    if (s.extractProgress < 1) return

    s.extractProgress = 1
    s.outcome = 'escaped'
    s.phase = 'over'
    s.overTick = this.tick
  }

  // ------------------------------------------------------------ 内部

  private carrier(): { id: number; x: number; z: number } | null {
    if (this.state.bountyCarrier === 0) return null
    for (const actor of this.actors.players()) {
      if (actor.id !== this.state.bountyCarrier) continue
      if (!actor.alive) return null
      return { id: actor.id, x: actor.feet.x, z: actor.feet.z }
    }
    return null
  }

  private reset(): void {
    this.state.phase = 'hunt'
    this.state.cluesFound = 0
    this.state.clueMask = 0
    this.state.clueProgress = 0
    this.state.clueIndex = -1
    this.state.lairRevealed = false
    this.state.banishProgress = 0
    this.state.bountyCarrier = 0
    this.state.extractIndex = -1
    this.state.extractProgress = 0
    this.state.secondsLeft = MATCH_SECONDS
    this.state.outcome = 'none'
    this.state.overTick = 0
    this.state.event = EVENT_NONE
    this.state.eventX = 0
    this.state.eventZ = 0
    this.state.eventSeconds = 0
    this.state.doorsMask = 0
    this.state.trapsMask = 0
    this.state.lightsMask = 0xff
    this.supplyDone = false
    this.bloodMoonDone = false
    this.supplyUntilTick = 0
    this.tick = 0
  }
}

/**
 * 掩码里有几位是 1（线索数最多 8 条）。
 *
 * 不写 `bits & (bits - 1)` 那套 popcount 技巧：这个函数一次比赛只跑三次，
 * 可读性比省两次按位运算重要。
 */
function countBits(mask: number): number {
  let count = 0
  for (let bits = mask; bits !== 0; bits >>>= 1) count += bits & 1
  return count
}
