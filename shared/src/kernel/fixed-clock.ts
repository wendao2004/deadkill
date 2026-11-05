/**
 * 固定步长时钟：渲染帧与模拟 tick 之间唯一的换算点。
 *
 * 这个模块不碰 DOM、不碰 Three.js、也不碰网络。它只回答一个问题：
 * "这一帧真实时间过去了 rawDt，模拟该跑几个固定步？" 客户端预测和服务端
 * 权威 tick 必须用同一套换算规则，否则同一个输入在两端走出的距离不同，
 * 表现就是每个快照都要把玩家往回拽一点。
 *
 * 三条硬规则：
 * 1. `rawDt` 先夹在 [0, maxFrameDt]。切标签页回来时 dt 可能是好几秒，
 *    不夹会让角色一步穿过整张地图。
 * 2. 一帧最多补 `maxSubsteps` 个固定步。补不完的积压直接丢掉 ——
 *    继续补只会让下一帧更慢，进入"越卡越补、越补越卡"的死亡螺旋。
 * 3. `alpha` 是上一次固定步与下一次固定步之间的插值比例，渲染层用它把
 *    60Hz 的模拟画成 144Hz 的连续运动。
 */

export interface FrameTime {
  /** 未缩放、已夹紧的真实帧时长（秒）。 */
  raw: number
  /** 应用 `scale` 后的模拟帧时长（秒）。 */
  dt: number
  /** 累计模拟时间（秒），不含本帧尚未消费的余量。 */
  elapsed: number
  /** 固定步长（秒）。 */
  fixed: number
  /** 两次固定步之间的插值比例 0..1。 */
  alpha: number
  /** 已推进的渲染帧数。 */
  frame: number
  /** 时间缩放。0 = 暂停；慢动作可设 0.25。 */
  scale: number
}

export interface FixedClockOptions {
  /** 固定步频率，默认 60Hz（与服务端 TICK_RATE 对齐）。 */
  hz?: number
  /** 单帧最多补几步，默认 8。 */
  maxSubsteps?: number
  /** 单帧真实时间上限，默认 0.1s。 */
  maxFrameDt?: number
}

export class FixedClock {
  readonly time: FrameTime
  readonly maxSubsteps: number
  readonly maxFrameDt: number

  /** 还没被固定步消费的时间（秒）。 */
  private accumulator = 0

  constructor(options: FixedClockOptions = {}) {
    const hz = options.hz !== undefined && options.hz > 0 ? options.hz : 60
    this.maxSubsteps = Math.max(1, Math.floor(options.maxSubsteps ?? 8))
    this.maxFrameDt = Math.max(1 / 1000, options.maxFrameDt ?? 0.1)
    this.time = {
      raw: 0,
      dt: 0,
      elapsed: 0,
      fixed: 1 / hz,
      alpha: 0,
      frame: 0,
      scale: 1,
    }
  }

  /** 固定步长（秒）。 */
  get fixedDt(): number {
    return this.time.fixed
  }

  /** 还有多少秒没被固定步消费。测试与调试用。 */
  get pending(): number {
    return this.accumulator
  }

  /**
   * 推进一个渲染帧，返回本帧应当执行的固定步数量。
   *
   * 调用方拿返回值去循环 `fixedUpdate(fixedDt)`；本类不持有任何系统，
   * 也不执行回调 —— 纯计算才能被单测到每一个边界。
   */
  advance(rawDt: number): number {
    const t = this.time
    const safe = Number.isFinite(rawDt) ? Math.max(0, rawDt) : 0
    const raw = Math.min(safe, this.maxFrameDt)
    t.raw = raw
    t.dt = raw * t.scale
    t.elapsed += t.dt
    t.frame++

    this.accumulator += t.dt
    let steps = Math.floor(this.accumulator / t.fixed)
    if (steps > this.maxSubsteps) {
      steps = this.maxSubsteps
      // 丢掉积压，而不是留着下一帧继续补。参考实现同样在这里清零，
      // 因为一旦补帧速度低于真实时间，积压只会单调增长。
      this.accumulator = 0
    } else {
      this.accumulator -= steps * t.fixed
    }
    // 浮点余量可能因为连续减法变成极小负数，alpha 必须是 0..1。
    t.alpha = Math.max(0, Math.min(1, this.accumulator / t.fixed))
    return steps
  }

  /** 暂停/恢复。暂停时 `advance` 仍会推进 frame，但不产生模拟步。 */
  setScale(scale: number): void {
    this.time.scale = Number.isFinite(scale) && scale >= 0 ? scale : 1
  }

  /** 重开一局：时间、帧号、余量全部归零。 */
  reset(): void {
    const t = this.time
    t.raw = 0
    t.dt = 0
    t.elapsed = 0
    t.alpha = 0
    t.frame = 0
    t.scale = 1
    this.accumulator = 0
  }
}
