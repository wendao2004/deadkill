/**
 * 二进制协议。手写编解码，没有代码生成步骤。
 *
 * 为什么不是 protobuf / flatbuffers：
 *  - 快照是**定长结构体数组**（16 个玩家各一份位姿），protobuf 每个字段的
 *    tag 字节在这里是纯开销。手写定长 = 一个人 26 字节，16 人快照约 420 字节。
 *  - 服务端要 `node src/index.ts` 直接跑，不能引入构建步骤。
 *
 * 代价是**加字段必须同时改两端**。用 PROTOCOL_VERSION 在握手时卡住：
 * 版本不一致直接踢掉，绝不做"尽力解析"——二进制错位的后果是静默读出乱数据，
 * 比连不上难查十倍。
 *
 * 所有多字节数值一律**小端**，且全部由 DataView 读写（不依赖平台字节序）。
 */

import {
  dequantizeAngle,
  quantizeAngle,
  type Vec3,
} from './math.ts'
import { MAX_INPUTS_PER_PACKET, PROTOCOL_VERSION } from './constants.ts'

// ---------------------------------------------------------------- 消息类型

export const Msg = {
  /** C→S 连接后第一条：协议版本 + 昵称。 */
  Hello: 1,
  /** S→C 握手确认：自己的 id + 世界配置。 */
  Welcome: 2,
  /** C→S 每帧输入（可批量补发）。 */
  Input: 3,
  /** S→C 状态快照。 */
  Snapshot: 4,
  /** S→C 对自己发出的输入的最后处理序号（用于丢弃已确认的预测）。 */
  Ack: 5,
  /** S→C 一次性事件：命中、死亡、开枪声。 */
  Event: 6,
  /** 双向：聊天/系统提示（纯文本）。 */
  Text: 7,
  /**
   * S→C 比赛目标状态（线索/放逐/撤离）。
   *
   * 独立一个包而不是并进快照：快照 20Hz、每个字节都要为位置服务，而目标
   * 状态十几秒才变一次。并进去等于为了一个 20 秒的进度条，让每一帧的每个
   * 玩家快照多背 12 字节。
   */
  Objective: 8,
  /**
   * C→S 切槽请求：u8 slot。
   *
   * 不塞进 InputPacket 的 buttons 位：输入包是"每帧可批量补发"的移动意图，
   * 丢一个包由下一个补上；切枪是一次离散指令，混进可重复的按钮位就得额外
   * 发明"边沿还是持续"的语义，而服务端只想要"他按了 1 键"这一个事实。
   */
  SwitchSlot: 9,
  /**
   * S→C 战利品/搜索状态，**只发给本人**。
   *
   * 为什么不并进快照：快照是广播包（16 个人都收），而"我身上多少钱、
   * 我搜到几成、我旁边哪个箱子能搜"只对一个人有意义。并进去等于每秒
   * 给 15 个不相干的人各推 20 次别人的钱包。
   */
  Loot: 11,
  /**
   * C→S 主武器选择：u8 kind + u16le 武器 id。
   *
   * 为什么不做进 Hello：Hello 尾部已经是「u8 长度 + 字符串」的可选段，
   * 长度为 0 表示"没有这一段"。在它后面再接定长字段，解析就得先判断那个
   * 长度字节到底是"空串"还是"下一段的开头"——这种二义性是二进制协议里
   * 最容易写错、又最难查的地方（错了只是静默错位）。选枪本来就是进游戏后
   * 一次性的独立指令，单独一个包最省事。
   */
  Loadout: 12,
} as const

export const EventKind = {
  Shot: 1,
  Hit: 2,
  Death: 3,
  Respawn: 4,
  /** 子弹打中怪物。不能复用 Hit：Hit 的 victimId 与玩家 id 共用一套编号。 */
  MonsterHit: 5,
  MonsterDeath: 6,
  /** 怪物开枪：客户端据此画曳光、按距离放枪声。 */
  MonsterShot: 7,
  /** Boss 范围脉冲（钟声 / 砸地）：客户端画地面冲击环并放对应的低频声。 */
  BossPulse: 8,
} as const

// ---------------------------------------------------------------- 输入

export interface PlayerInput {
  /** 客户端自增序号，服务端原样回显用于确认。 */
  seq: number
  /** 客户端这一帧的时长（毫秒），钳制在合理范围防止加速外挂。 */
  dtMs: number
  /** -1..1 的前后；+1 = 向前（-Z）。 */
  forward: number
  /** -1..1 的左右；+1 = 向右。 */
  right: number
  yaw: number
  pitch: number
  /**
   * 瞄准朝向（含后坐力偏移）。缺省等于 yaw/pitch，旧测试/旧调用方不用改。
   *
   * 移动方向用 yaw/pitch（鼠标原始朝向），命中/曳光/远端朝向用 aimYaw/aimPitch。
   * 拆开是因为相机后坐力只应该推弹道，不应该让"按 W 前进"跟着甩。
   */
  aimYaw?: number
  aimPitch?: number
  buttons: number
}

// seq(u32) dtMs(f32) fwd(i8) right(i8) yaw(u16) pitch(u16) aimYaw(u16) aimPitch(u16) buttons(u8)
const INPUT_WITHOUT_SEQ = 4 + 1 + 1 + 2 + 2 + 2 + 2 + 1
export const INPUT_SIZE = 4 + INPUT_WITHOUT_SEQ

export function writeInput(view: DataView, offset: number, input: PlayerInput): number {
  view.setUint32(offset, input.seq >>> 0, true)
  view.setFloat32(offset + 4, input.dtMs, true)
  view.setInt8(offset + 8, clampI8(input.forward))
  view.setInt8(offset + 9, clampI8(input.right))
  view.setUint16(offset + 10, quantizeAngle(input.yaw), true)
  // pitch 只在 ±PI/2 之间，用同一个量化函数就够了
  view.setUint16(offset + 12, quantizeAngle(input.pitch), true)
  view.setUint16(offset + 14, quantizeAngle(input.aimYaw ?? input.yaw), true)
  view.setUint16(offset + 16, quantizeAngle(input.aimPitch ?? input.pitch), true)
  view.setUint8(offset + 18, input.buttons & 0xff)
  return offset + INPUT_SIZE
}

export function readInput(view: DataView, offset: number): PlayerInput {
  return {
    seq: view.getUint32(offset, true),
    dtMs: view.getFloat32(offset + 4, true),
    forward: view.getInt8(offset + 8),
    right: view.getInt8(offset + 9),
    yaw: dequantizeAngle(view.getUint16(offset + 10, true)),
    pitch: dequantizeAngle(view.getUint16(offset + 12, true)),
    aimYaw: dequantizeAngle(view.getUint16(offset + 14, true)),
    aimPitch: dequantizeAngle(view.getUint16(offset + 16, true)),
    buttons: view.getUint8(offset + 18),
  }
}

/** 前后/左右量化到 [-127, 127] 的单字节。 */
function clampI8(v: number): number {
  if (v >= 1) return 127
  if (v <= -1) return -127
  return Math.round(v * 127)
}

// ---------------------------------------------------------------- 切枪

/**
 * C→S 切槽请求：u8 kind + u8 slot，共 2 字节。
 *
 * 定长、无长度前缀：服务端只要看到首字节是 Msg.SwitchSlot 就知道后面还有
 * 正好 1 个字节，不必解析长度也不会被短包骗。
 */
export const SWITCH_SLOT_SIZE = 1 + 1

export function encodeSwitchSlot(slot: number): ArrayBuffer {
  const buffer = new ArrayBuffer(SWITCH_SLOT_SIZE)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.SwitchSlot)
  view.setUint8(1, slot & 0xff)
  return buffer
}

export function decodeSwitchSlot(buffer: ArrayBuffer): number {
  const view = new DataView(buffer)
  if (view.getUint8(0) !== Msg.SwitchSlot) throw new Error('不是切枪包')
  return view.getUint8(1)
}

// ---------------------------------------------------------------- 选枪

/**
 * C→S 配装请求：u8 kind + u16le 武器 id + u32le 天赋等级包，共 7 字节。
 *
 * 用 u16 而不是 u8：武器表 id 现在只到 10，但 id 是"目录编号"，将来加枪
 * 一定会有第 256 把以外的情况——协议里省下这 1 个字节，换来的是一场
 * 谁都没预料到的静默截断。
 */
export const LOADOUT_SIZE = 1 + 2 + 4 + 1 + 1 + 1

/**
 * 配装包：u8 kind + u16le 武器 id + u32le 天赋等级包。
 *
 * 天赋搭这趟车而不是另开一个包：两者都是"开局前定好、局中不改"的东西，
 * 分两个包只会多出一种"只收到一半"的中间状态。
 *
 * u32 里装的是**每 2 bit 一个等级的十项天赋**（见 shared/src/traits.ts），
 * 不是早期的"一位一个天赋"。十个天赋 × 3 级最多 20 bit，u32 还留着余量；
 * 之所以不让客户端把等级算成倍率再发，是因为"3 级铁腕 = 0.75 散布"这种
 * 数字一旦由客户端算，服务端就只能信它 —— 而服务端本来就持有同一张表。
 */
export interface LoadoutRequest {
  weaponId: number
  /** 天赋等级包（packed levels）。0 = 不带天赋。 */
  traits: number
  /** 本局合同 id（0 = 不接）。 */
  contract: number
  /** 随身补给位图：bit0 = 额外绷带，bit1 = 额外备弹。 */
  extras: number
  /** 主武器配件 id（见 shared/src/attachments.ts）。 */
  attachment: number
}

export function encodeLoadout(weaponId: number, traits = 0, contract = 0, extras = 0, attachment = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(LOADOUT_SIZE)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Loadout)
  view.setUint16(1, weaponId & 0xffff, true)
  view.setUint32(3, traits >>> 0, true)
  view.setUint8(7, contract & 0xff)
  view.setUint8(8, extras & 0xff)
  view.setUint8(9, attachment & 0xff)
  return buffer
}

export function decodeLoadout(buffer: ArrayBuffer): LoadoutRequest {
  if (buffer.byteLength < LOADOUT_SIZE) throw new Error('选枪包不完整')
  const view = new DataView(buffer)
  if (view.getUint8(0) !== Msg.Loadout) throw new Error('不是选枪包')
  const contract = buffer.byteLength > 7 ? view.getUint8(7) : 0
  const extras = buffer.byteLength > 8 ? view.getUint8(8) : 0
  const attachment = buffer.byteLength > 9 ? view.getUint8(9) : 0
  return { weaponId: view.getUint16(1, true), traits: view.getUint32(3, true), contract, extras, attachment }
}

// ---------------------------------------------------------------- 快照

export interface PlayerSnapshot {
  id: number
  /** 位置：毫米级精度整数 → 除以 1000 得到米。 */
  x: number
  y: number
  z: number
  /** 速度，服务端用于调试和反作弊；客户端可以用来推算移动方向。 */
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  health: number
  flags: number
  weaponId: number
  ammo: number
  /** 当前槽位的备弹（不含弹匣内），换弹从这里扣。 */
  reserve: number
  /** 当前槽位：0 主武器、1 副武器、2 近战。客户端据此换模型/换准星。 */
  slot: number
  /** 服务端最近处理到的输入序号。 */
  ackSeq: number
}

/**
 * 一个玩家的定长编码大小 = 36。
 *
 * 逐字段写出来而不是写成 `2 + 3*4 + ...` 这样的算术式：之前那一版漏了一个
 * 字段，算式少算 1 字节，`encodeSnapshot` 于是在最后一个字段上抛
 * `RangeError: Offset is outside the bounds of the DataView`。
 * 定长协议的容量必须能从字段清单直接数出来，不能让读者去验算。
 */
export const PLAYER_SNAPSHOT_SIZE =
  2 + // id
  4 * 3 + // x, y, z（毫米整数）
  2 * 3 + // vx, vy, vz（米×1000）
  2 + // yaw
  2 + // pitch
  2 + // health
  2 + // flags（u16：滑铲/翻越/攀爬三个状态位）
  1 + // weaponId
  1 + // ammo
  1 + // reserve
  1 + // slot
  4 // ackSeq

/**
 * 一只怪物的快照记录，定长 20 字节。
 *
 * 比玩家记录短是有意的：怪物不预测、不作弊，客户端只需要"它现在在哪、朝哪、
 * 还剩多少血"来插值，速度分量对它是纯冗余。世界是服务端权威的，
 * 客户端没有任何理由需要怪物的速度。
 */
/**
 * 怪物种类与状态的线上编码。
 *
 * 写成常量表而不是直接传字符串：这两个字段在快照里各占 1 字节，
 * 两端必须用同一套数字，否则客户端会把猎犬画成僵尸。
 */
export const MonsterKindCode = {
  Grunt: 0,
  Hound: 1,
  Gunner: 2,
  Boss: 3,
  Bellkeeper: 4,
  Golem: 5,
  Conductor: 6,
} as const
export const MonsterStateCode = { Idle: 0, Chase: 1, Attack: 2, Dead: 3, Special: 4 } as const

export interface MonsterSnapshot {
  id: number
  kind: number
  state: number
  x: number
  y: number
  z: number
  yaw: number
  health: number
}

/** 怪物记录 = id(2) kind(1) state(1) xyz(12) yaw(2) health(2) = 20。 */
export const MONSTER_SNAPSHOT_SIZE =
  2 + // id
  1 + // kind
  1 + // state
  4 * 3 + // x, y, z（毫米整数）
  2 + // yaw
  2 // health

export interface Snapshot {
  /** 服务端 tick 号，客户端用来判断丢包/乱序。 */
  tick: number
  /** 服务端时间戳（毫秒）。 */
  serverTime: number
  players: PlayerSnapshot[]
  monsters: MonsterSnapshot[]
}

/**
 * 快照头 17 字节：u8 kind + u32 tick + f64 serverTime + u16 playerCount +
 * u16 monsterCount。怪物段紧跟在玩家段之后。
 */
export const SNAPSHOT_HEADER = 1 + 4 + 8 + 2 + 2

export function encodeSnapshot(snapshot: Snapshot): ArrayBuffer {
  const players = snapshot.players
  const monsters = snapshot.monsters
  const size =
    SNAPSHOT_HEADER +
    players.length * PLAYER_SNAPSHOT_SIZE +
    monsters.length * MONSTER_SNAPSHOT_SIZE
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Snapshot)
  view.setUint32(1, snapshot.tick >>> 0, true)
  view.setFloat64(5, snapshot.serverTime, true)
  view.setUint16(13, players.length, true)
  view.setUint16(15, monsters.length, true)

  let off = SNAPSHOT_HEADER
  for (const p of snapshot.players) {
    view.setUint16(off, p.id, true)
    view.setInt32(off + 2, Math.round(p.x * 1000), true)
    view.setInt32(off + 6, Math.round(p.y * 1000), true)
    view.setInt32(off + 10, Math.round(p.z * 1000), true)
    view.setInt16(off + 14, Math.round(p.vx * 1000), true)
    view.setInt16(off + 16, Math.round(p.vy * 1000), true)
    view.setInt16(off + 18, Math.round(p.vz * 1000), true)
    view.setUint16(off + 20, quantizeAngle(p.yaw), true)
    view.setUint16(off + 22, quantizeAngle(p.pitch), true)
    view.setUint16(off + 24, Math.max(0, Math.round(p.health)), true)
    view.setUint16(off + 26, p.flags & 0xffff, true)
    view.setUint8(off + 28, p.weaponId & 0xff)
    view.setUint8(off + 29, p.ammo & 0xff)
    view.setUint8(off + 30, p.reserve & 0xff)
    view.setUint8(off + 31, p.slot & 0xff)
    view.setUint32(off + 32, p.ackSeq >>> 0, true)
    off += PLAYER_SNAPSHOT_SIZE
  }

  for (const m of monsters) {
    view.setUint16(off, m.id, true)
    view.setUint8(off + 2, m.kind & 0xff)
    view.setUint8(off + 3, m.state & 0xff)
    view.setInt32(off + 4, Math.round(m.x * 1000), true)
    view.setInt32(off + 8, Math.round(m.y * 1000), true)
    view.setInt32(off + 12, Math.round(m.z * 1000), true)
    view.setUint16(off + 16, quantizeAngle(m.yaw), true)
    view.setUint16(off + 18, Math.max(0, Math.round(m.health)), true)
    off += MONSTER_SNAPSHOT_SIZE
  }
  return buffer
}

export function decodeSnapshot(buffer: ArrayBuffer): Snapshot {
  const view = new DataView(buffer)
  if (view.getUint8(0) !== Msg.Snapshot) throw new Error('不是快照包')
  const tick = view.getUint32(1, true)
  const serverTime = view.getFloat64(5, true)
  const count = view.getUint16(13, true)
  const monsterCount = view.getUint16(15, true)
  const players: PlayerSnapshot[] = []
  let off = SNAPSHOT_HEADER
  for (let i = 0; i < count; i++) {
    players.push({
      id: view.getUint16(off, true),
      x: view.getInt32(off + 2, true) / 1000,
      y: view.getInt32(off + 6, true) / 1000,
      z: view.getInt32(off + 10, true) / 1000,
      vx: view.getInt16(off + 14, true) / 1000,
      vy: view.getInt16(off + 16, true) / 1000,
      vz: view.getInt16(off + 18, true) / 1000,
      yaw: dequantizeAngle(view.getUint16(off + 20, true)),
      pitch: dequantizeAngle(view.getUint16(off + 22, true)),
      health: view.getUint16(off + 24, true),
      flags: view.getUint16(off + 26, true),
      weaponId: view.getUint8(off + 28),
      ammo: view.getUint8(off + 29),
      reserve: view.getUint8(off + 30),
      slot: view.getUint8(off + 31),
      ackSeq: view.getUint32(off + 32, true),
    })
    off += PLAYER_SNAPSHOT_SIZE
  }

  const monsters: MonsterSnapshot[] = []
  for (let i = 0; i < monsterCount; i++) {
    monsters.push({
      id: view.getUint16(off, true),
      kind: view.getUint8(off + 2),
      state: view.getUint8(off + 3),
      x: view.getInt32(off + 4, true) / 1000,
      y: view.getInt32(off + 8, true) / 1000,
      z: view.getInt32(off + 12, true) / 1000,
      yaw: dequantizeAngle(view.getUint16(off + 16, true)),
      health: view.getUint16(off + 18, true),
    })
    off += MONSTER_SNAPSHOT_SIZE
  }
  return { tick, serverTime, players, monsters }
}

// ---------------------------------------------------------------- 输入包

export interface InputPacket {
  inputs: PlayerInput[]
  /**
   * 客户端最近一次收到的快照 tick。
   *
   * 服务端拿它估算单向延迟（= 现在 - 那个 tick 的模拟时刻），开火时按这个
   * 延迟把对手位置倒回过去再判定。没有它就只能用 0 延迟判定，玩家在
   * 网络稍差时打移动目标必然空枪。
   *
   * 4 字节的开销换掉"明明打中了不算"，值。
   */
  ackedTick: number
}

export function encodeInputPacket(inputs: PlayerInput[], ackedTick = 0): ArrayBuffer {
  const n = Math.min(inputs.length, MAX_INPUTS_PER_PACKET)
  const buffer = new ArrayBuffer(6 + n * INPUT_SIZE)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Input)
  view.setUint8(1, n)
  view.setUint32(2, ackedTick >>> 0, true)
  let off = 6
  for (let i = 0; i < n; i++) off = writeInput(view, off, inputs[i]!)
  return buffer
}

export function decodeInputPacket(buffer: ArrayBuffer): InputPacket {
  const view = new DataView(buffer)
  if (view.getUint8(0) !== Msg.Input) throw new Error('不是输入包')
  const n = Math.min(view.getUint8(1), MAX_INPUTS_PER_PACKET)
  const ackedTick = view.getUint32(2, true)
  const inputs: PlayerInput[] = []
  let off = 6
  for (let i = 0; i < n; i++) {
    inputs.push(readInput(view, off))
    off += INPUT_SIZE
  }
  return { inputs, ackedTick }
}

// ---------------------------------------------------------------- 事件

export interface ShotEvent {
  kind: typeof EventKind.Shot
  playerId: number
  origin: Vec3
  dir: Vec3
  weaponId: number
  /** 配件 id（消音器影响远处音量）。旧调用方不传 = 0。 */
  attachment?: number
}

export interface HitEvent {
  kind: typeof EventKind.Hit
  attackerId: number
  victimId: number
  damage: number
  headshot: boolean
  /** 命中点，客户端用来放血花特效。 */
  point: Vec3
}

export interface DeathEvent {
  kind: typeof EventKind.Death
  victimId: number
  killerId: number
  headshot: boolean
}

export interface RespawnEvent {
  kind: typeof EventKind.Respawn
  playerId: number
  position: Vec3
}

export interface MonsterHitEvent {
  kind: typeof EventKind.MonsterHit
  attackerId: number
  monsterId: number
  damage: number
  /** 命中点，客户端用来放血花与命中数字。 */
  point: Vec3
}

export interface MonsterDeathEvent {
  kind: typeof EventKind.MonsterDeath
  monsterId: number
  killerId: number
  /** MonsterKind 的数值形式，客户端据此决定倒地音与尸体外观。 */
  monsterKind: number
}

export interface MonsterShotEvent {
  kind: typeof EventKind.MonsterShot
  monsterId: number
  /** 枪口位置（也用于客户端给那一带打一下光）。 */
  origin: Vec3
  /** 单位方向。 */
  dir: Vec3
  /** 子弹飞了多远（打到人就是到人的距离，打空就是射程尽头）。 */
  distance: number
  hit: boolean
}

export interface BossPulseEvent {
  kind: typeof EventKind.BossPulse
  monsterId: number
  /** 脉冲圆心（怪物脚下；客户端把环贴在这个高度）。 */
  x: number
  y: number
  z: number
  radius: number
}

export type GameEvent =
  | ShotEvent
  | HitEvent
  | DeathEvent
  | RespawnEvent
  | MonsterHitEvent
  | MonsterDeathEvent
  | MonsterShotEvent
  | BossPulseEvent

const EVENT_BASE = 1 + 1 + 1 // kind(u8) eventKind(u8) ...
const EVENT_POINT = 3 * 4

/** 一个事件的最大字节数，用于批量包的容量预估。 */
export const MAX_EVENT_SIZE = EVENT_BASE + 1 + 2 + EVENT_POINT * 2 + 4 + 1

export function encodeEvents(events: GameEvent[]): ArrayBuffer {
  const buffer = new ArrayBuffer(2 + events.length * MAX_EVENT_SIZE)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Event)
  view.setUint8(1, events.length)
  let off = 2
  for (const ev of events) {
    view.setUint8(off, Msg.Event)
    view.setUint8(off + 1, ev.kind)
    if (ev.kind === EventKind.Shot) {
      view.setUint16(off + 2, ev.playerId, true)
      view.setFloat32(off + 4, ev.origin.x, true)
      view.setFloat32(off + 8, ev.origin.y, true)
      view.setFloat32(off + 12, ev.origin.z, true)
      view.setFloat32(off + 16, ev.dir.x, true)
      view.setFloat32(off + 20, ev.dir.y, true)
      view.setFloat32(off + 24, ev.dir.z, true)
      view.setUint8(off + 28, ev.weaponId)
      view.setUint8(off + 29, ev.attachment ?? 0)
      off += 30
    } else if (ev.kind === EventKind.Hit) {
      view.setUint16(off + 2, ev.attackerId, true)
      view.setUint16(off + 4, ev.victimId, true)
      view.setUint16(off + 6, Math.round(ev.damage), true)
      view.setUint8(off + 8, ev.headshot ? 1 : 0)
      view.setFloat32(off + 9, ev.point.x, true)
      view.setFloat32(off + 13, ev.point.y, true)
      view.setFloat32(off + 17, ev.point.z, true)
      off += 21
    } else if (ev.kind === EventKind.Death) {
      view.setUint16(off + 2, ev.victimId, true)
      view.setUint16(off + 4, ev.killerId, true)
      view.setUint8(off + 6, ev.headshot ? 1 : 0)
      off += 7
    } else if (ev.kind === EventKind.MonsterHit) {
      view.setUint16(off + 2, ev.attackerId, true)
      view.setUint16(off + 4, ev.monsterId, true)
      view.setUint16(off + 6, Math.round(ev.damage), true)
      view.setFloat32(off + 8, ev.point.x, true)
      view.setFloat32(off + 12, ev.point.y, true)
      view.setFloat32(off + 16, ev.point.z, true)
      off += 20
    } else if (ev.kind === EventKind.MonsterDeath) {
      view.setUint16(off + 2, ev.monsterId, true)
      view.setUint16(off + 4, ev.killerId, true)
      view.setUint8(off + 6, ev.monsterKind & 0xff)
      off += 7
    } else if (ev.kind === EventKind.MonsterShot) {
      view.setUint16(off + 2, ev.monsterId, true)
      view.setUint8(off + 4, ev.hit ? 1 : 0)
      view.setFloat32(off + 5, ev.origin.x, true)
      view.setFloat32(off + 9, ev.origin.y, true)
      view.setFloat32(off + 13, ev.origin.z, true)
      view.setFloat32(off + 17, ev.dir.x, true)
      view.setFloat32(off + 21, ev.dir.y, true)
      view.setFloat32(off + 25, ev.dir.z, true)
      view.setFloat32(off + 29, ev.distance, true)
      off += 33
    } else if (ev.kind === EventKind.BossPulse) {
      view.setUint16(off + 2, ev.monsterId, true)
      view.setFloat32(off + 4, ev.x, true)
      view.setFloat32(off + 8, ev.y, true)
      view.setFloat32(off + 12, ev.z, true)
      view.setFloat32(off + 16, ev.radius, true)
      off += 20
    } else {
      view.setUint16(off + 2, ev.playerId, true)
      view.setFloat32(off + 4, ev.position.x, true)
      view.setFloat32(off + 8, ev.position.y, true)
      view.setFloat32(off + 12, ev.position.z, true)
      off += 16
    }
  }
  return buffer.slice(0, off)
}

export function decodeEvents(buffer: ArrayBuffer): GameEvent[] {
  const view = new DataView(buffer)
  if (view.getUint8(0) !== Msg.Event) throw new Error('不是事件包')
  const count = view.getUint8(1)
  const out: GameEvent[] = []
  let off = 2
  for (let i = 0; i < count; i++) {
    const kind = view.getUint8(off + 1)
    if (kind === EventKind.Shot) {
      out.push({
        kind: EventKind.Shot,
        playerId: view.getUint16(off + 2, true),
        origin: {
          x: view.getFloat32(off + 4, true),
          y: view.getFloat32(off + 8, true),
          z: view.getFloat32(off + 12, true),
        },
        dir: {
          x: view.getFloat32(off + 16, true),
          y: view.getFloat32(off + 20, true),
          z: view.getFloat32(off + 24, true),
        },
        weaponId: view.getUint8(off + 28),
        attachment: view.getUint8(off + 29),
      })
      off += 30
    } else if (kind === EventKind.Hit) {
      out.push({
        kind: EventKind.Hit,
        attackerId: view.getUint16(off + 2, true),
        victimId: view.getUint16(off + 4, true),
        damage: view.getUint16(off + 6, true),
        headshot: view.getUint8(off + 8) === 1,
        point: {
          x: view.getFloat32(off + 9, true),
          y: view.getFloat32(off + 13, true),
          z: view.getFloat32(off + 17, true),
        },
      })
      off += 21
    } else if (kind === EventKind.Death) {
      out.push({
        kind: EventKind.Death,
        victimId: view.getUint16(off + 2, true),
        killerId: view.getUint16(off + 4, true),
        headshot: view.getUint8(off + 6) === 1,
      })
      off += 7
    } else if (kind === EventKind.MonsterHit) {
      out.push({
        kind: EventKind.MonsterHit,
        attackerId: view.getUint16(off + 2, true),
        monsterId: view.getUint16(off + 4, true),
        damage: view.getUint16(off + 6, true),
        point: {
          x: view.getFloat32(off + 8, true),
          y: view.getFloat32(off + 12, true),
          z: view.getFloat32(off + 16, true),
        },
      })
      off += 20
    } else if (kind === EventKind.MonsterDeath) {
      out.push({
        kind: EventKind.MonsterDeath,
        monsterId: view.getUint16(off + 2, true),
        killerId: view.getUint16(off + 4, true),
        monsterKind: view.getUint8(off + 6),
      })
      off += 7
    } else if (kind === EventKind.MonsterShot) {
      out.push({
        kind: EventKind.MonsterShot,
        monsterId: view.getUint16(off + 2, true),
        hit: view.getUint8(off + 4) === 1,
        origin: {
          x: view.getFloat32(off + 5, true),
          y: view.getFloat32(off + 9, true),
          z: view.getFloat32(off + 13, true),
        },
        dir: {
          x: view.getFloat32(off + 17, true),
          y: view.getFloat32(off + 21, true),
          z: view.getFloat32(off + 25, true),
        },
        distance: view.getFloat32(off + 29, true),
      })
      off += 33
    } else if (kind === EventKind.BossPulse) {
      out.push({
        kind: EventKind.BossPulse,
        monsterId: view.getUint16(off + 2, true),
        x: view.getFloat32(off + 4, true),
        y: view.getFloat32(off + 8, true),
        z: view.getFloat32(off + 12, true),
        radius: view.getFloat32(off + 16, true),
      })
      off += 20
    } else {
      out.push({
        kind: EventKind.Respawn,
        playerId: view.getUint16(off + 2, true),
        position: {
          x: view.getFloat32(off + 4, true),
          y: view.getFloat32(off + 8, true),
          z: view.getFloat32(off + 12, true),
        },
      })
      off += 16
    }
  }
  return out
}

// ---------------------------------------------------------------- 握手

/** 昵称的最大字节数。编码时截断，两端遵守同一个上限。 */
const NICKNAME_MAX_BYTES = 24

/** 关卡 id 的最大字节数。关卡 id 都是短 ASCII（marsh-p0、chapel-p1）。 */
export const LEVEL_ID_MAX_BYTES = 32

/**
 * Hello/Welcome 的尾部**可选段**：`u8 长度 + UTF-8`，整段缺失或长度 0 都表示"没有"。
 *
 * 为什么用尾巴而不是把 levelId 插进定长区：这两个包都是定长起步的结构，
 * 往中间插字段会让旧客户端把后面的字节读串位，而二进制错位是**静默**的
 * （玩家的位置莫名乱跳、子弹打不中），比连不上难查十倍。
 * 追加在尾部时旧对端只是"不读最后这几个字节"，握手照常成功 —— 这是不升
 * PROTOCOL_VERSION 也能加字段的唯一办法。整段缺失时 levelId 解成 null，
 * 语义是"用 DEFAULT_LEVEL_ID"。
 */
function writeTail(view: DataView, offset: number, value: string): void {
  const bytes = new TextEncoder().encode(value)
  view.setUint8(offset, bytes.length)
  new Uint8Array(view.buffer, view.byteOffset + offset + 1, bytes.length).set(bytes)
}

/**
 * 读尾部可选段：整段缺失（旧对端发的包）或长度 0 一律返回 null。
 *
 * 用边界判断而不是 try/catch —— 越界在这里是**正常情况**（老客户端握手成功
 * 是硬要求），把它当异常处理会把一条正常路径写成控制流。
 */
function readTail(view: DataView, offset: number): string | null {
  if (offset + 1 > view.byteLength) return null
  const len = view.getUint8(offset)
  if (len === 0 || offset + 1 + len > view.byteLength) return null
  return new TextDecoder().decode(
    new Uint8Array(view.buffer, view.byteOffset + offset + 1, len),
  )
}

/** 尾部可选段占几个字节：没有 value 时是 0（连长度字节都不写）。 */
function tailByteLength(value: string): number {
  return value ? 1 + new TextEncoder().encode(value).length : 0
}

/** 编码前统一截断：超长的 levelId 不该让包体越过 u8 长度域。 */
function clampLevelId(levelId: string | null | undefined): string {
  return levelId ? levelId.slice(0, LEVEL_ID_MAX_BYTES) : ''
}

/**
 * C→S 握手包：u8 kind + u16le version + u8 昵称长度 + 昵称
 * + 【可选】u8 levelId 长度 + levelId。
 *
 * 不带 levelId 时包体与老版本**逐字节相同**（旧服务端照样能读）。
 */
export function encodeHello(nickname: string, levelId?: string | null): ArrayBuffer {
  const bytes = new TextEncoder().encode(nickname.slice(0, NICKNAME_MAX_BYTES))
  const tail = clampLevelId(levelId)
  const buffer = new ArrayBuffer(4 + bytes.length + tailByteLength(tail))
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Hello)
  view.setUint16(1, PROTOCOL_VERSION, true)
  view.setUint8(3, bytes.length)
  new Uint8Array(buffer, 4).set(bytes)
  if (tail) writeTail(view, 4 + bytes.length, tail)
  return buffer
}

export function decodeHello(buffer: ArrayBuffer): {
  version: number
  nickname: string
  /** 客户端想进的图；null = 没指定（旧客户端）→ 服务端用 DEFAULT_LEVEL_ID。 */
  levelId: string | null
} {
  const view = new DataView(buffer)
  if (view.getUint8(0) !== Msg.Hello) throw new Error('不是握手包')
  const version = view.getUint16(1, true)
  const len = view.getUint8(3)
  const nickname = new TextDecoder().decode(new Uint8Array(buffer, 4, len))
  return { version, nickname, levelId: readTail(view, 4 + len) }
}

/**
 * Welcome 包的**最小**长度：头 5 + serverTime 8 + spawn 12 = 25。
 *
 * 后面可能还跟一段可选的 levelId（见 writeTail）。老客户端只读前 25 字节，
 * 多出来的尾巴对它无影响。
 */
export const WELCOME_SIZE = 5 + 8 + 3 * 4

export function encodeWelcome(payload: {
  playerId: number
  tickRate: number
  snapshotRate: number
  serverTime: number
  spawn: Vec3
  /**
   * 服务端**实际**用的关卡 id（可能不等于客户端请求的那张：这个 matchId
   * 的世界在你之前已经按别的图建好了，服务端世界里已有玩家物理状态，
   * 不能中途换图）。为 null/省略时包体就是老的 25 字节定长格式。
   */
  levelId?: string | null
}): ArrayBuffer {
  const tail = clampLevelId(payload.levelId)
  const buffer = new ArrayBuffer(WELCOME_SIZE + tailByteLength(tail))
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Welcome)
  view.setUint16(1, payload.playerId, true)
  view.setUint8(3, payload.tickRate)
  view.setUint8(4, payload.snapshotRate)
  view.setFloat64(5, payload.serverTime, true)
  // 出生点是三维的，必须三个分量都带 —— 只带 y 会让客户端把自己摆在
  // z=0 的直线上，而服务端在别处，表现为"一出生就被拽走"。
  view.setFloat32(13, payload.spawn.x, true)
  view.setFloat32(17, payload.spawn.y, true)
  view.setFloat32(21, payload.spawn.z, true)
  if (tail) writeTail(view, WELCOME_SIZE, tail)
  return buffer
}

export function decodeWelcome(buffer: ArrayBuffer): {
  playerId: number
  tickRate: number
  snapshotRate: number
  serverTime: number
  spawn: Vec3
  /** 服务端实际用的关卡 id；null = 旧服务端没带这一段（按默认图处理）。 */
  levelId: string | null
} {
  const view = new DataView(buffer)
  if (view.getUint8(0) !== Msg.Welcome) throw new Error('不是欢迎包')
  return {
    playerId: view.getUint16(1, true),
    tickRate: view.getUint8(3),
    snapshotRate: view.getUint8(4),
    serverTime: view.getFloat64(5, true),
    spawn: {
      x: view.getFloat32(13, true),
      y: view.getFloat32(17, true),
      z: view.getFloat32(21, true),
    },
    levelId: readTail(view, WELCOME_SIZE),
  }
}

// ---------------------------------------------------------------- Ack

/** 服务端确认自己处理到哪个输入序号。4 字节。 */
export function encodeAck(ackSeq: number): ArrayBuffer {
  const buffer = new ArrayBuffer(5)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Ack)
  view.setUint32(1, ackSeq >>> 0, true)
  return buffer
}

export function decodeAck(buffer: ArrayBuffer): number {
  const view = new DataView(buffer)
  if (view.getUint8(0) !== Msg.Ack) throw new Error('不是确认包')
  return view.getUint32(1, true)
}

// ---------------------------------------------------------------- 战利品

/**
 * 物品 id。**线上编码**：客户端的图标表、服务端的效果分支都按这个数字说话。
 *
 * 只有四种：搜刮不该变成捡垃圾。四种刚好让"这一趟值不值"是一笔可算的账
 * （绷带续命、弹药续火力、烈酒/怀表换钱），再多就变成背包管理了。
 */
export const LOOT_ITEM = { Bandage: 0, Ammo: 1, Liquor: 2, Watch: 3 } as const

/** 物品的中文名。服务端发提示、客户端显示列表都用它，避免两端各写一份。 */
export const LOOT_ITEM_NAME: Record<number, string> = {
  [LOOT_ITEM.Bandage]: '绷带',
  [LOOT_ITEM.Ammo]: '弹药',
  [LOOT_ITEM.Liquor]: '烈酒',
  [LOOT_ITEM.Watch]: '怀表',
}

export interface LootItem {
  id: number
  count: number
}

export interface LootPacket {
  /** 身上带着的赏金总额（美元）。 */
  value: number
  /** 当前搜索进度 0..100，没在搜就是 0。 */
  searchPct: number
  /** 正在搜的点在 level.searchSpots 里的下标；-1 = 没有。 */
  searchSpotId: number
  /**
   * 身边最近的可搜点下标（未搜过且在 SEARCH_RADIUS 内），-1 = 附近没有。
   *
   * 与是否按着交互键无关：客户端靠它显示"[E] 搜索"提示。每 tick 都算，
   * 所以提示的延迟只受 10Hz 下发节奏限制。
   */
  nearSpotId: number
  items: LootItem[]
  /** 背包里还剩几条绷带：包扎按钮该不该亮就看它。 */
  bandages: number
  /** 当前包扎进度 0..100，没在包扎就是 0。 */
  healPct: number
}

/**
 * 包头长度：kind(u8) + value(u16) + searchPct(u8) + searchSpotId(i16)
 * + nearSpotId(i16) + itemCount(u8) + bandages(u8) + healPct(u8) = 11 字节。
 *
 * 写成"字段清单相加"而不是写死数字：加字段时改的是清单，包长自动跟着变。
 * 新字段一律追加在 itemCount 之后：物品记录紧跟在包头后面，往前插会连带
 * 改掉每条记录的偏移。
 */
export const LOOT_HEADER = 1 + 2 + 1 + 2 + 2 + 1 + 1 + 1

/** 每件物品 2 字节：id(u8) + count(u8)。 */
export const LOOT_ITEM_SIZE = 2

/** 单个物品堆叠上限（u8）。count 超出它就是编码方的 bug，编码时钳制。 */
const LOOT_COUNT_MAX = 255

/** 一个 Loot 包最多能装几件物品（itemCount 是 u8）。 */
export const LOOT_MAX_ITEMS = 255

/**
 * value 是 u16：65535 美元上限。
 *
 * 一场能搜到的现金最多 16 个点 × 160 = 2560，远不到天花板；钳制的唯一理由
 * 是 setUint16 越界会抛 RangeError，把整条连接炸掉。
 */
const LOOT_VALUE_MAX = 0xffff

export function encodeLoot(p: LootPacket): ArrayBuffer {
  const count = Math.min(p.items.length, LOOT_MAX_ITEMS)
  const buffer = new ArrayBuffer(LOOT_HEADER + count * LOOT_ITEM_SIZE)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Loot)
  // value: 身上的赏金总额（美元，u16 小端）
  view.setUint16(1, Math.max(0, Math.min(LOOT_VALUE_MAX, Math.round(p.value))), true)
  // searchPct: 搜索进度 0..100（u8）
  view.setUint8(3, Math.max(0, Math.min(100, Math.round(p.searchPct))))
  // searchSpotId: 正在搜的点下标（i16，-1 = 没有，-2..-64 = 尸体缓存）
  view.setInt16(4, clampSpotId(p.searchSpotId), true)
  // nearSpotId: 附近的可搜点下标（i16，-1 = 没有，-2..-64 = 尸体缓存）
  view.setInt16(6, clampSpotId(p.nearSpotId), true)
  // itemCount: 后面跟多少条 2 字节记录（u8）
  view.setUint8(8, count)
  // bandages: 身上的绷带条数（u8）
  view.setUint8(9, Math.max(0, Math.min(LOOT_COUNT_MAX, Math.round(p.bandages))))
  // healPct: 包扎进度 0..100（u8）
  view.setUint8(10, Math.max(0, Math.min(100, Math.round(p.healPct))))
  let off = LOOT_HEADER
  for (let i = 0; i < count; i++) {
    const item = p.items[i]!
    // id 只可能是 0..3。超出范围时原样写 u8（而不是静默改成 0）：
    // 客户端查表失败一眼能看出"服务端拼错了物品表"。
    view.setUint8(off, item.id & 0xff)
    view.setUint8(off + 1, Math.max(0, Math.min(LOOT_COUNT_MAX, item.count | 0)))
    off += LOOT_ITEM_SIZE
  }
  return buffer
}

export function decodeLoot(buffer: ArrayBuffer): LootPacket {
  const view = new DataView(buffer)
  if (view.byteLength < LOOT_HEADER) throw new Error('战利品包长度不足')
  if (view.getUint8(0) !== Msg.Loot) throw new Error('不是战利品包')
  const value = view.getUint16(1, true)
  const searchPct = view.getUint8(3)
  const searchSpotId = view.getInt16(4, true)
  const nearSpotId = view.getInt16(6, true)
  const count = view.getUint8(8)
  const bandages = view.getUint8(9)
  const healPct = view.getUint8(10)
  // 先按 itemCount 算出应有长度再读：少一个字节就抛，绝不读出半条记录。
  if (view.byteLength < LOOT_HEADER + count * LOOT_ITEM_SIZE) {
    throw new Error(
      '战利品包被截断：声明 ' + count + ' 件，需要 ' +
        (LOOT_HEADER + count * LOOT_ITEM_SIZE) + ' 字节，实到 ' + view.byteLength,
    )
  }
  const items: LootItem[] = []
  let off = LOOT_HEADER
  for (let i = 0; i < count; i++) {
    items.push({ id: view.getUint8(off), count: view.getUint8(off + 1) })
    off += LOOT_ITEM_SIZE
  }
  return { value, searchPct, searchSpotId, nearSpotId, items, bandages, healPct }
}

/** i16 的合法范围。spotId 只可能是 -1 或一个小下标，钳制纯属防御。 */
/**
 * 战利品包里的点下标下限。
 *
 * -1 = 没有；-2..-64 = 动态尸体缓存。静态搜刮点是 0..N。用负数而不是新增字段，
 * 是为了让"附近有什么可搜"仍然只占 int16 的 2 字节，而且不与静态点下标冲突。
 */
export const SPOT_ID_NONE = -1
export const SPOT_ID_MIN = -64

function clampSpotId(id: number): number {
  if (!Number.isFinite(id)) return SPOT_ID_NONE
  return Math.max(SPOT_ID_MIN, Math.min(0x7fff, Math.trunc(id)))
}

// ---------------------------------------------------------------- 文本

/**
 * 文本包上限（UTF-8 字节）。长度域是 u8，所以一个包最多 255 字节。
 *
 * 中文一个字 3 字节，255 字节约 85 个汉字 —— 够一句系统提示
 * （"搜到 怀表 ×1"），不够当聊天室，这也正是它现在的用途。
 */
export const TEXT_MAX_BYTES = 255

/**
 * 文本包：u8 kind + u8 字节长度 + UTF-8 正文。
 *
 * 服务端用它给本人发提示（搜到什么东西）。Text **不是广播包**：它的语义是
 * "对某个人说的话"，所以 world.ts 只 send 给目标玩家。
 */
export function encodeText(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text).slice(0, TEXT_MAX_BYTES)
  const buffer = new ArrayBuffer(2 + bytes.length)
  const view = new DataView(buffer)
  view.setUint8(0, Msg.Text)
  view.setUint8(1, bytes.length)
  new Uint8Array(buffer, 2).set(bytes)
  return buffer
}

export function decodeText(buffer: ArrayBuffer): string {
  const view = new DataView(buffer)
  if (view.byteLength < 2) throw new Error('文本包长度不足')
  if (view.getUint8(0) !== Msg.Text) throw new Error('不是文本包')
  const len = view.getUint8(1)
  if (view.byteLength < 2 + len) {
    throw new Error('文本包被截断：声明 ' + len + ' 字节，实到 ' + (view.byteLength - 2))
  }
  return new TextDecoder().decode(new Uint8Array(buffer, 2, len))
}

