/**
 * 动态分辨率治理器：慢就降、稳定就升，并且**防止来回抖**。
 *
 * ## 为什么单独抽成纯函数
 *
 * 这段逻辑以前散在 `Game.adaptResolution` 里，只有"降"没有"升"，也无法单测。
 * 现在它是一个纯状态机：输入本帧帧时间与当前 scale，输出"这一帧该不该动"。
 * 于是可以用 `node --test` 直接跑几千帧，验证滞回、冷却、反抖动是否真的成立，
 * 而不是靠肉眼看"帧率好像稳了"。
 *
 * ## 为什么升分辨率要这么保守
 *
 * 每次改 scale 都要重建 HDR 目标与泛光金字塔；60fps 下这是一次可见的顿挫。
 * 如果"一好就升、一升又掉"，玩家看到的是每隔几秒卡一下，比稳定在低一点的
 * 分辨率更难受（项目早期踩过）。
 *
 * 所以回升需要同时满足：
 * - 连续 `STABLE_FRAMES`（5 秒）低于 `STABLE_RATIO × 预算`；
 * - 过了 `UP_COOLDOWN`（10 秒）；
 * - 不在反抖动封锁期；
 * - 还没到玩家设置的上限（`maxScale` 是设置与画质档的较小值）。
 *
 * 如果一次回升后 10 秒内又掉回来，说明这台机器撑不住那个 scale：封锁
 * 60 秒，期间不再尝试回升。宁可少升一次，也不要周期性顿挫。
 */

export type QualityTier = 'performance' | 'balanced' | 'quality'

export interface ResolutionState {
  /** 指数平滑后的帧时间（毫秒）。 */
  smoothedMs: number
  /** 连续明显超标的帧数。 */
  lowFrames: number
  /** 连续稳定低于阈值的帧数。 */
  highFrames: number
  /** 到这个渲染帧之前不做任何动作。 */
  cooldownUntil: number
  /** 到这个渲染帧之前不再尝试升分辨率（反抖动封锁）。 */
  upBlockedUntil: number
  /** 上一次升分辨率发生在哪一帧；用于识别"升完马上掉"。 */
  lastUpscaleFrame: number
  /** 启动/换档后的预热截止帧。 */
  warmupUntil: number
  upscales: number
  downscales: number
  qualityDrops: number
}

export interface ResolutionInput {
  /** 本帧真实帧时长（毫秒）。 */
  frameMs: number
  /** 绝对渲染帧号。 */
  frame: number
  scale: number
  minScale: number
  /** 玩家设置与当前画质档允许的最大 scale。 */
  maxScale: number
  autoQuality: boolean
  tier: QualityTier
}

export interface ResolutionAction {
  /** 新的 renderScale；null = 不改。 */
  scale: number | null
  /** 调用方负责把画质降一档并重建 RT。 */
  qualityDown: boolean
  reason: 'slow' | 'stable' | null
}

const BUDGET_MS = 1000 / 60
const WARMUP_FRAMES = 120
const SLOW_RATIO = 1.45
const STABLE_RATIO = 0.75
const LOW_FRAMES = 60
const STABLE_FRAMES = 300
const DOWN_COOLDOWN = 150
const QUALITY_COOLDOWN = 300
const UP_COOLDOWN = 600
/**
 * 升后多久内又掉，算"这次升错了"。
 *
 * 必须大于 UP_COOLDOWN + LOW_FRAMES（600 + 60 ≈ 11 秒），否则降档永远
 * 落在窗口外，反抖动分支就是死代码。30 秒也覆盖"升完过一会儿才热起来"。
 */
const THRASH_WINDOW = 1800
/** 判定升错后封锁多久再尝试。 */
const UP_BLOCK = 3600
const DOWN_STEP = 0.1
const UP_STEP = 0.05

const NO_ACTION: ResolutionAction = Object.freeze({
  scale: null,
  qualityDown: false,
  reason: null,
})

/** 新建状态。`frame` 是当前帧号；预热从这一刻起算。 */
export function createResolutionState(frame = 0): ResolutionState {
  return {
    smoothedMs: BUDGET_MS,
    lowFrames: 0,
    highFrames: 0,
    cooldownUntil: 0,
    upBlockedUntil: 0,
    lastUpscaleFrame: -1e9,
    warmupUntil: frame + WARMUP_FRAMES,
    upscales: 0,
    downscales: 0,
    qualityDrops: 0,
  }
}

/**
 * 推进一帧。纯函数：只改传入的 state，不碰 DOM、不碰渲染器。
 *
 * 调用方拿到 `scale` 后负责 `setRenderScale + setSize`；拿到 `qualityDown`
 * 后负责切换 tier。两者都不会在同一帧同时返回。
 */
export function stepResolution(
  state: ResolutionState,
  input: ResolutionInput,
): ResolutionAction {
  // 启动/换档后的首帧：着色器编译、纹理上传、RT 分配都会让帧时间飙高，
  // 那不是稳态性能，不能触发降档。
  if (input.frame < state.warmupUntil) {
    state.lowFrames = 0
    state.highFrames = 0
    return NO_ACTION
  }

  state.smoothedMs += (input.frameMs - state.smoothedMs) * 0.1

  // 冷却期内连计数都不做：刚重建过 RT 的那几帧不能当作"新证据"。
  if (input.frame < state.cooldownUntil) {
    state.lowFrames = 0
    state.highFrames = 0
    return NO_ACTION
  }

  if (state.smoothedMs > BUDGET_MS * SLOW_RATIO) {
    state.highFrames = 0
    state.lowFrames++
    if (state.lowFrames < LOW_FRAMES) return NO_ACTION

    if (input.scale > input.minScale + 1e-6) {
      // 升完不到 10 秒又掉：这次升错了，封锁一段时间。
      if (input.frame - state.lastUpscaleFrame < THRASH_WINDOW) {
        state.upBlockedUntil = input.frame + UP_BLOCK
      }
      // 保留两位小数：连续加减浮点数会在诊断/日志里留下 0.6000000000000001。
      const next = Math.round(Math.max(input.minScale, input.scale - DOWN_STEP) * 100) / 100
      state.lowFrames = 0
      state.downscales++
      state.cooldownUntil = input.frame + DOWN_COOLDOWN
      return { scale: next, qualityDown: false, reason: 'slow' }
    }

    if (input.autoQuality && input.tier !== 'performance') {
      state.lowFrames = 0
      state.qualityDrops++
      state.cooldownUntil = input.frame + QUALITY_COOLDOWN
      return { scale: null, qualityDown: true, reason: 'slow' }
    }
    // 已经到本档下限且不能降档：保持现状，继续累计也无意义。
    return NO_ACTION
  }

  if (state.smoothedMs < BUDGET_MS * STABLE_RATIO) {
    state.lowFrames = 0
    if (input.frame < state.upBlockedUntil) {
      state.highFrames = 0
      return NO_ACTION
    }
    state.highFrames++
    if (state.highFrames < STABLE_FRAMES) return NO_ACTION
    if (input.scale >= input.maxScale - 1e-6) {
      // 已经顶到玩家设置/画质档的上限，不必再数。
      state.highFrames = 0
      return NO_ACTION
    }
    const next = Math.round(Math.min(input.maxScale, input.scale + UP_STEP) * 100) / 100
    state.highFrames = 0
    state.upscales++
    state.lastUpscaleFrame = input.frame
    state.cooldownUntil = input.frame + UP_COOLDOWN
    return { scale: next, qualityDown: false, reason: 'stable' }
  }

  // 中间地带：既不慢也不够稳，两个计数器都清零，要求连续证据。
  state.lowFrames = 0
  state.highFrames = 0
  return NO_ACTION
}
