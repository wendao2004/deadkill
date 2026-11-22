/**
 * 快照兴趣管理：谁能拿到精确位姿，谁只能拿到“音频层”的量化位置。
 *
 * 猎杀类的核心是信息稀缺；服务端如果把 16 个玩家的精确坐标 20Hz 广播给
 * 每个人，改客户端就能做透视/雷达。这里的折中：
 *
 * - **full**：同队或距离内且视线可见 → 精确位置，正常渲染；
 * - **audio**：墙后/掩体后但在听觉半径内 → 位置量化到 2m 网格，客户端不画
 *   模型，只用来播脚步/换弹/怪物声；
 * - **none**：太远且看不见/听不见 → 不下发。
 *
 * 纯函数放在 shared，服务端与客户端对“多少米算远/听得到”用同一张表。
 */

export type InterestTier = 'full' | 'audio' | 'none'

export interface InterestRanges {
  /** 精确可见的最大距离；超出但听得见仍会走 audio。 */
  full?: number
  /** 音频层最大距离；超出完全不下发。 */
  audio?: number
}

// 精确层必须覆盖武器的最大命中距离（神射手 90m×3=270m），否则会出现
// “看不见却能被打中”。墙后仍由视线射线决定，不会因此获得透视。
export const INTEREST_FULL_RANGE = 280
export const INTEREST_AUDIO_RANGE = 45
/** 枪声/怪物枪声的可听事件半径；事件坐标会量化到 4m。 */
export const INTEREST_EVENT_AUDIO_RANGE = 120
/** 音频层的位置量化步长（米）：2m 足够听方向，不够做透视。 */
export const INTEREST_AUDIO_QUANTUM = 2

export function interestTier(
  distance: number,
  visible: boolean,
  sameTeam: boolean,
  ranges: InterestRanges = {},
): InterestTier {
  if (sameTeam) return 'full'
  const full = ranges.full ?? INTEREST_FULL_RANGE
  const audio = ranges.audio ?? INTEREST_AUDIO_RANGE
  if (distance <= full && visible) return 'full'
  if (distance <= audio) return 'audio'
  return 'none'
}

/** 音频层位置量化；四舍五入到最近网格，保证两端看到同一个近似点。 */
export function quantizePosition(value: number, step = INTEREST_AUDIO_QUANTUM): number {
  if (!Number.isFinite(value) || step <= 0) return 0
  return Math.round(value / step) * step
}

/** 可见性缓存键：接收者 → 目标。 */
export function interestPairKey(receiverId: number, targetId: number): string {
  return `${receiverId}:${targetId}`
}
