/**
 * 一局比赛的**目标流程**（线索 → 放逐 → 撤离）。
 *
 * ## 为什么单独一个文件
 *
 * 这段状态机两端都要用：服务端每个 tick 推进它，客户端拿它画 HUD 与标记。
 * 放在 protocol.ts 里会和字节布局混在一起；放在 server/ 里客户端就只能靠
 * 猜。纯函数写在这里，连 Node 单测都能直接跑（不碰 Rapier、不碰 DOM）。
 *
 * ## 为什么不是"每局一个 Boss 怪物"
 *
 * 放逐的对象是**静止的血巢**，不是第三个怪物种类。理由：怪物种类要新增
 * 一套 AI 参数、一套协议枚举、一套 rig 与动画；而"站在血巢旁边按住"这
 * 件事的价值在于**逼玩家暴露位置**（放逐时全场都能看到光柱），跟怪物
 * 会怎么走位关系不大。少一个种类，少一整条线。
 */

export type MatchPhase = 'hunt' | 'banish' | 'extract' | 'over'

export type MatchOutcome = 'none' | 'escaped' | 'dead'

/** 线上编码用的小整数。两端必须是同一套数字，否则 HUD 会把放逐说成撤离。 */
export const PHASE_CODES: Record<MatchPhase, number> = {
  hunt: 0,
  banish: 1,
  extract: 2,
  over: 3,
}
export const PHASE_NAMES: MatchPhase[] = ['hunt', 'banish', 'extract', 'over']

/** 世界事件的线上 id。 */
export const EVENT_NONE = 0
export const EVENT_SUPPLY = 1
export const EVENT_BLOODMOON = 2

/** 一局的总时长。15 分钟是"够跑三处线索 + 一次放逐 + 一次撤离"的下限。 */
export const MATCH_SECONDS = 900

/** 线索总数。3 个而不是 5 个：地图只有 80m 见方，再多就变成捡垃圾。 */
export const CLUE_TOTAL = 3

/**
 * 站在线索上多久算收集完成（毫秒）。
 *
 * 4 秒是刻意"难受"的长度：短了没有风险，长了没人愿意在开阔地蹲着不动。
 * 收集进度**整个中途保留**（离开半径不清零，只缓慢回退），否则被怪打断一次
 * 就得从头再来，挫败感远大于风险感。
 */
export const CLUE_HOLD_MS = 4000

/** 离开线索范围后进度回退的速度倍数（1 = 与收集同速）。 */
export const CLUE_DECAY_RATE = 0.5

/** 线索交互半径（米）。比撤离点小得多：线索是"凑上去"，撤离是"站进去"。 */
export const CLUE_RADIUS = 3.2

/** 放逐血巢需要按住多久（毫秒）。25 秒足够让另外两队跑过来。 */
export const BANISH_MS = 25_000

/** 放逐交互半径。血巢本身占地不小。 */
export const LAIR_RADIUS = 4.5

/** 撤离需要站多久（毫秒）。20 秒是"我知道你在里面，来得及赶到"的窗口。 */
export const EXTRACT_MS = 20_000

/** 撤离点半径。 */
export const EXTRACT_RADIUS = 6

/** 撤离完成后的复盘停留时长（毫秒），之后重置回 hunt。 */
export const MATCH_RESET_MS = 12_000

/**
 * 一局的全部可变状态。
 *
 * 整个结构每 tick 原地修改（不 new）：服务端 60Hz 跑，客户端 4Hz 收快照，
 * 两次分配都不是钱的问题，但"每帧 new 一个对象"会让人以为可以随手塞字段。
 */
export interface MatchState {
  phase: MatchPhase
  /**
   * 本局的环境修饰 id（见 shared/src/modifiers.ts）。
   *
   * 放在目标包里而不是放进 Welcome：它一局不变，但客户端要在**整局**里随时
   * 能读到（重连后也要），而目标包本来就在 1Hz 地重复下发，搭这趟车比再加
   * 一个"进局后只发一次、丢了就永远没有"的包更稳。
   */
  modifier: number
  /** 已找过的线索数（= clueMask 里 1 的个数），HUD 的 "1 / 3" 用它。 */
  cluesFound: number
  /**
   * 哪几条线索已经找过，bit i = 第 i 条。
   *
   * 线索没有固定顺序 —— 三条线索都亮在地图上，玩家就近收最近的那条。
   * 早期的实现只允许 0→1→2 依次推进，结果站在第 3 条上完全没有反应，
   * 玩家会以为光柱是装饰。计数仍留着，因为光有掩码算不出 "还差几条" 的文案。
   */
  clueMask: number
  /** 当前线索的收集进度 0..1。只跟踪**正在被收集的那一条**。 */
  clueProgress: number
  /** 当前正在被收集的线索下标，-1 = 没人在收。 */
  clueIndex: number
  /** 线索全部找齐 → 血巢位置暴露。 */
  lairRevealed: boolean
  banishProgress: number
  /** 持有赏金的玩家 id，0 = 没人。 */
  bountyCarrier: number
  /** 玩家当前所在的撤离点下标，-1 = 不在任何撤离点内。 */
  extractIndex: number
  extractProgress: number
  /** 剩余整秒。 */
  secondsLeft: number
  outcome: MatchOutcome
  /** 比赛结束的时刻（tick），0 = 还没结束。 */
  overTick: number
  /** 当前世界事件 id（EVENT_*），0 = 没有。 */
  event: number
  /** 事件位置（补给空投用；其它事件为 0）。 */
  eventX: number
  eventZ: number
  /** 事件剩余秒数；0 表示事件没有持续时间（一次性）。 */
  eventSeconds: number
  /** 门状态位图：bit i = 第 i 扇门是开着的。最多 8 扇。 */
  doorsMask: number
  /** 捕兽夹状态位图：bit i = 第 i 个夹子已经弹开。 */
  trapsMask: number
  /** 油灯状态位图：bit i = 第 i 盏灯还亮着。 */
  lightsMask: number
}

/**
 * 血巢位置：三条线索的质心。
 *
 * 两端都要用它（服务端判半径、客户端画光柱），所以放在共享层。不写进关卡：
 * 改关卡的人只会改 clues，血巢跟着走；否则迟早出现"线索搬到地图另一头、
 * 血巢还留在原地、两点相距 60m"。质心可能落在墙里，这里不纠偏 ——
 * 放逐半径 4.5m 足够大，贴着墙也能推进度。
 */
export function lairOf(level: { clues?: { x: number; z: number }[] }): { x: number; z: number } {
  const clues = level.clues ?? []
  if (clues.length === 0) return { x: 0, z: 0 }
  let sx = 0
  let sz = 0
  for (const clue of clues) {
    sx += clue.x
    sz += clue.z
  }
  return { x: sx / clues.length, z: sz / clues.length }
}

export function createMatchState(): MatchState {
  return {
    phase: 'hunt',
    modifier: 0,
    cluesFound: 0,
    clueMask: 0,
    clueProgress: 0,
    clueIndex: -1,
    lairRevealed: false,
    banishProgress: 0,
    bountyCarrier: 0,
    extractIndex: -1,
    extractProgress: 0,
    secondsLeft: MATCH_SECONDS,
    outcome: 'none',
    overTick: 0,
    event: EVENT_NONE,
    eventX: 0,
    eventZ: 0,
    eventSeconds: 0,
    doorsMask: 0,
    trapsMask: 0,
    lightsMask: 0xff,
  }
}

/**
 * 这个玩家本人是否真的撤离了。
 *
 * `outcome` 是全局的：携带者读满 20 秒，整局都进入 over。以前客户端直接拿
 * 全局 outcome 当自己的结果，于是 100 米外挂机、甚至已经死掉的人也会看到
 * “撤离成功”并拿金币。真正的撤离者只有一个：带走赏金的那个人。
 *
 * 放在 shared 里是为了让服务端结算与客户端展示用同一条规则，也方便单测。
 */
export function isPersonalEscape(
  outcome: MatchOutcome,
  bountyCarrier: number,
  playerId: number,
): boolean {
  return outcome === 'escaped' && bountyCarrier === playerId
}

// ---------------------------------------------------------------- 线上编码

import { Msg } from './protocol.ts'

/**
 * 目标包 16 字节：u8 kind + u8 phase + u8 cluesFound + u8 cluesTotal +
 * u8 flags + u8 clueIndex + u8 clueProgress + u8 banish + u16 carrier +
 * u8 extract + u8 extractProgress + u16 secondsLeft + u8 clueMask +
 * u8 modifier。
 *
 * 与快照分成两个包是刻意的：快照 20Hz 且每一字节都要为位置服务，而目标
 * 状态 1 秒变不了几次。把它们并进去等于为了一个 20 秒的进度条，让每帧的
 * 每个玩家快照都多背 12 字节。
 */
export const OBJECTIVE_SIZE =
  1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + // kind, phase, cluesFound, cluesTotal, flags, clueIndex, clueProgress, banish
  2 + // bountyCarrier (u16)
  1 + 1 + // extractIndex, extractProgress
  2 + // secondsLeft (u16)
  1 + 1 + // clueMask, modifier
  1 + 2 + 2 + 2 + // event, eventX, eventZ, eventSeconds
  1 + 1 + 1 // doorsMask, trapsMask, lightsMask

export const OBJECTIVE_FLAG_LAIR = 1 << 0
export const OBJECTIVE_FLAG_ESCAPED = 1 << 1
export const OBJECTIVE_FLAG_DEAD = 1 << 2

/** 没有撤离点时线上填 255（u8 的 -1）。 */
export const NO_EXTRACT = 255

export interface ObjectivePacket {
  phase: MatchPhase
  /** 环境修饰 id（0..3），客户端据此调雾密度与名字。 */
  modifier: number
  cluesFound: number
  /** bit i = 第 i 条线索已找过，客户端据此点亮光柱（不能再用 "前 N 条" 推导）。 */
  clueMask: number
  cluesTotal: number
  lairRevealed: boolean
  /** 正在被读取的线索下标，-1 = 没有人在读。世界里的光柱要靠它决定谁在灌进度。 */
  clueIndex: number
  /** 当前线索读取进度 0..1。 */
  clueProgress: number
  banishProgress: number
  bountyCarrier: number
  extractIndex: number
  extractProgress: number
  secondsLeft: number
  outcome: MatchOutcome
  /** 世界事件：EVENT_*；eventX/Z 是补给空投的落点。 */
  event: number
  eventX: number
  eventZ: number
  /** 事件剩余秒数（血月用；补给为 0）。 */
  eventSeconds: number
  /** 门状态位图（见 MatchState.doorsMask）。 */
  doorsMask: number
  /** 捕兽夹状态位图（bit i = 已弹开）。 */
  trapsMask: number
  /** 油灯状态位图（bit i = 还亮着）。 */
  lightsMask: number
}

function byte01(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)))
}

function back01(value: number): number {
  return value / 255
}

export function encodeObjective(packet: ObjectivePacket): ArrayBuffer {
  const buffer = new ArrayBuffer(OBJECTIVE_SIZE)
  const view = new DataView(buffer)
  let flags = 0
  if (packet.lairRevealed) flags |= OBJECTIVE_FLAG_LAIR
  if (packet.outcome === 'escaped') flags |= OBJECTIVE_FLAG_ESCAPED
  if (packet.outcome === 'dead') flags |= OBJECTIVE_FLAG_DEAD
  view.setUint8(0, Msg.Objective)
  view.setUint8(1, PHASE_CODES[packet.phase])
  view.setUint8(2, Math.max(0, Math.min(255, packet.cluesFound)))
  view.setUint8(3, Math.max(0, Math.min(255, packet.cluesTotal)))
  view.setUint8(4, flags)
  view.setUint8(5, packet.clueIndex < 0 ? NO_EXTRACT : packet.clueIndex)
  view.setUint8(6, byte01(packet.clueProgress))
  view.setUint8(7, byte01(packet.banishProgress))
  view.setUint16(8, Math.max(0, packet.bountyCarrier) >>> 0, true)
  view.setUint8(10, packet.extractIndex < 0 ? NO_EXTRACT : packet.extractIndex)
  view.setUint8(11, byte01(packet.extractProgress))
  view.setUint16(12, Math.max(0, Math.min(65535, packet.secondsLeft)), true)
  view.setUint8(14, Math.max(0, Math.min(255, packet.clueMask)))
  view.setUint8(15, Math.max(0, Math.min(255, packet.modifier)))
  view.setUint8(16, Math.max(0, Math.min(255, packet.event)))
  view.setInt16(17, Math.round(packet.eventX), true)
  view.setInt16(19, Math.round(packet.eventZ), true)
  view.setUint16(21, Math.max(0, Math.min(65535, packet.eventSeconds)), true)
  view.setUint8(23, Math.max(0, Math.min(255, packet.doorsMask)))
  view.setUint8(24, Math.max(0, Math.min(255, packet.trapsMask)))
  view.setUint8(25, Math.max(0, Math.min(255, packet.lightsMask)))
  return buffer
}

export function decodeObjective(buffer: ArrayBuffer): ObjectivePacket {
  const view = new DataView(buffer)
  const flags = view.getUint8(4)
  const outcome: MatchOutcome =
    (flags & OBJECTIVE_FLAG_ESCAPED) !== 0 ? 'escaped' : (flags & OBJECTIVE_FLAG_DEAD) !== 0 ? 'dead' : 'none'
  const clueByte = view.getUint8(5)
  const extractByte = view.getUint8(10)
  return {
    phase: PHASE_NAMES[view.getUint8(1)] ?? 'hunt',
    modifier: view.getUint8(15),
    cluesFound: view.getUint8(2),
    clueMask: view.getUint8(14),
    cluesTotal: view.getUint8(3),
    lairRevealed: (flags & OBJECTIVE_FLAG_LAIR) !== 0,
    clueIndex: clueByte === NO_EXTRACT ? -1 : clueByte,
    clueProgress: back01(view.getUint8(6)),
    banishProgress: back01(view.getUint8(7)),
    bountyCarrier: view.getUint16(8, true),
    extractIndex: extractByte === NO_EXTRACT ? -1 : extractByte,
    extractProgress: back01(view.getUint8(11)),
    secondsLeft: view.getUint16(12, true),
    outcome,
    event: view.getUint8(16),
    eventX: view.getInt16(17, true),
    eventZ: view.getInt16(19, true),
    eventSeconds: view.getUint16(21, true),
    doorsMask: view.getUint8(23),
    trapsMask: view.getUint8(24),
    lightsMask: view.getUint8(25),
  }
}
