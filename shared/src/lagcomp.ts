/**
 * 延迟补偿（lag compensation）的纯计算部分。
 *
 * 开火时不能拿"服务端此刻的位置"判射线：200ms 延迟的玩家打横向跑动的目标
 * 必然全部空枪。做法是把其他玩家倒回"射击者屏幕上那一刻"再判。
 *
 * 这里只放两件事：
 * 1. 回滚到哪一 tick（`rewindTickFor`）；
 * 2. 从历史帧里取出其他活人的胶囊位姿（`rewindTargets`）。
 *
 * 真正的射线求交留在物理层 —— 那需要 Rapier 的 `Ray`/`Capsule`，不能进
 * shared 的纯函数区（客户端也要用这两个函数画"我刚才打的是哪一帧"）。
 *
 * ## 一个不能改的细节
 *
 * 历史帧只存**刚体中心**，不存胶囊半高。半高由"当前中心 - 当前脚底"现算：
 * 这样蹲下/站起在回滚瞬间用的是当前姿态，而不是历史姿态。听起来不严谨，
 * 但历史帧里没有脚底位置，而蹲姿切换只有 0.5m 且发生在几百毫秒内 ——
 * 用历史中心配当前半高，实测比"整段退化成当前位姿"准得多。
 */

import type { Vec3 } from './math.ts'
import {
  INTERP_DELAY_MS,
  MAX_REWIND_MS,
  PLAYER_CROUCH_HALF_HEIGHT,
  PLAYER_HALF_HEIGHT,
  PLAYER_RADIUS,
  TICK_MS,
} from './constants.ts'

/** 历史帧里某个玩家的位姿，回滚用。 */
export interface HistoryEntry {
  playerId: number
  /** 刚体中心（回滚时写回刚体）。 */
  bx: number
  by: number
  bz: number
}

export interface HistoryFrame {
  tick: number
  entries: HistoryEntry[]
}

/** 回滚后的一个候选目标：一段竖直胶囊 + 头部判定带。 */
export interface RewindTarget {
  playerId: number
  /** 胶囊底端（不含半径）。 */
  a: Vec3
  /** 胶囊顶端（不含半径）。 */
  b: Vec3
  /** 脚底高度：打脚/爆头的分界都要用它。 */
  feetY: number
  /** 头部判定带的下沿：命中高度超过它就是爆头。 */
  headMinHeight: number
}

/** 回滚目标需要的最少信息：身份、存活、当前刚体中心、当前脚底。 */
export interface RewindActor {
  id: number
  alive: boolean
  /** 当前刚体中心（历史帧缺这一帧时退化用它）。 */
  center: Vec3
  /** 当前脚底世界高度。半高由它算出，见文件头的说明。 */
  feetY: number
}

/**
 * 该把世界倒回哪一 tick。
 *
 * `ackedTick` 是客户端"我已经看到第几帧"，再减去插值延迟就是它开火时屏幕
 * 上呈现的那一帧。按 `MAX_REWIND_MS` 夹住上限：不夹的话，玩家伪造一个很小
 * 的 ackedTick 就能把对手拽到五秒前的位置开枪，那是作弊而不是补偿。
 */
export function rewindTickFor(currentTick: number, ackedTick: number): number {
  if (ackedTick <= 0) return currentTick
  const maxRewindTicks = Math.floor(MAX_REWIND_MS / TICK_MS)
  const floor = currentTick - maxRewindTicks
  const interpTicks = Math.round(INTERP_DELAY_MS / TICK_MS)
  const target = Math.max(ackedTick - interpTicks, floor)
  return Math.min(target, currentTick)
}

/**
 * 取历史帧里其他活人的胶囊位姿。
 *
 * 没有对应历史帧时退化成当下位姿 —— 等价于"不补偿"，比凭空少一个人安全：
 * 少一个人是必空枪，凭空多一个则是打中空气。
 */
export function rewindTargets(
  frame: HistoryFrame | undefined,
  actors: Iterable<RewindActor>,
  shooterId: number,
): RewindTarget[] {
  const out: RewindTarget[] = []
  for (const other of actors) {
    // 过滤用**当前**存活状态，不是历史存活状态：这一 tick 刚死的人不该再被打中，
    // 而历史里活着的尸体反倒会变成"打不死的靶子"。
    if (other.id === shooterId || !other.alive) continue
    const entry = frame?.entries.find((e) => e.playerId === other.id)
    const cx = entry ? entry.bx : other.center.x
    const cy = entry ? entry.by : other.center.y
    const cz = entry ? entry.bz : other.center.z
    // 胶囊半高取"身体中心到脚底"再减半径：蹲下时这个值本来就小，不用另外判断姿态。
    const halfHeight = Math.max(0.05, other.center.y - other.feetY - PLAYER_RADIUS)
    const top = cy + halfHeight + PLAYER_RADIUS
    // 站立头顶 1.9 → 头部带 1.45；蹲下头顶 1.4 → 头部带 1.05。
    // 用半高区分姿态，避免"蹲下永远打不到头"。
    const mid = (PLAYER_HALF_HEIGHT + PLAYER_CROUCH_HALF_HEIGHT) / 2
    const headMinHeight = top - (halfHeight < mid ? 0.35 : 0.45)
    out.push({
      playerId: other.id,
      a: { x: cx, y: cy - halfHeight, z: cz },
      b: { x: cx, y: cy + halfHeight, z: cz },
      feetY: cy - halfHeight - PLAYER_RADIUS,
      headMinHeight,
    })
  }
  return out
}
