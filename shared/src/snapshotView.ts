/**
 * 快照投影：把服务端内部状态整理成"要发出去的那一份"。
 *
 * 为什么值得单独一个文件：快照是全服最热的路径（20Hz × 每个接收者），
 * 也是"客户端能看到什么"的唯一出口。以前这段逻辑混在 broadcastSnapshot 里，
 * 一半是取数、一半是每接收者复制 16 个对象，改任何一边都要先读懂另一边。
 *
 * 这里只做两件纯事：
 * 1. `projectPlayer` —— 一个玩家在快照里的样子（不含只属于接收者的 ackSeq）；
 * 2. `attachAck` —— 把接收者自己的 ackSeq 贴上去，其它人一律 0。
 *
 * 编码与发送留在服务端：那需要协议与 socket。
 */

import type { PlayerSnapshot } from './protocol.ts'

/** 投影一个玩家需要的最小输入。服务端从 Character/Loadout 取值填进来。 */
export interface PlayerViewSource {
  id: number
  /** 脚底位置（不是刚体中心）：协议里 y 一直是脚底。 */
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  health: number
  /** 姿态位（站立/蹲/开镜/换弹…），由 stateFlagsOf 算好再传进来。 */
  flags: number
  team: number
  weaponId: number
  ammo: number
  reserve: number
  slot: number
}

/**
 * 一个玩家在快照里的样子。
 *
 * `ackSeq` 固定填 0：它只对"收件人自己"有意义，由 `attachAck` 覆盖。
 * 放在这里而不是让调用方记着清零 —— 忘记清零等于把别人的输入序号发给全场。
 */
export function projectPlayer(src: PlayerViewSource): PlayerSnapshot {
  return {
    id: src.id,
    x: src.x,
    y: src.y,
    z: src.z,
    vx: src.vx,
    vy: src.vy,
    vz: src.vz,
    yaw: src.yaw,
    pitch: src.pitch,
    health: src.health,
    flags: src.flags,
    team: src.team,
    weaponId: src.weaponId,
    ammo: src.ammo,
    reserve: src.reserve,
    slot: src.slot,
    ackSeq: 0,
  }
}

/**
 * 给第一个 id 命中的条目贴上 ackSeq，返回它的下标（没命中返回 -1）。
 *
 * 就地改而不是复制整个数组：16 个玩家 × 20Hz 的快照，每帧给每个接收者
 * 重建 16 个对象就是每秒两万次分配，GC 停顿会直接变成 p99 抖动。
 * 调用方用完必须 `clearAck` 复位 —— 否则下一个接收者会收到别人的序号。
 */
export function attachAck(view: PlayerSnapshot[], receiverId: number, ackSeq: number): number {
  for (let i = 0; i < view.length; i++) {
    const entry = view[i]!
    if (entry.id !== receiverId) continue
    entry.ackSeq = ackSeq
    return i
  }
  return -1
}

/** 复位 attachAck 写进去的值。 */
export function clearAck(view: PlayerSnapshot[], index: number): void {
  const entry = view[index]
  if (entry !== undefined) entry.ackSeq = 0
}
