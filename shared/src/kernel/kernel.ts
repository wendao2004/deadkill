/**
 * 游戏内核：只负责"按什么顺序驱动系统"，不认识任何具体玩法。
 *
 * 与渲染引擎（Three.js）、物理引擎（Rapier）和网络协议全部解耦。客户端
 * 可以用它跑预测与表现，服务端也可以用它跑权威 tick；两边共享的是同一套
 * 固定步换算、依赖顺序和生命周期，而不是同一份业务代码。
 *
 * 一帧的顺序固定为：
 *   1. FixedClock 计算本帧要跑几个固定步；
 *   2. fixedUpdate(fixedDt) × N —— 确定性玩法（移动/命中/AI）；
 *   3. update(dt) —— 每帧一次的表现层（相机/动画/HUD 采样）；
 *   4. lateUpdate(dt) —— 必须看到最终变换之后再做的事（音频听者/标记）；
 *   5. render(ctx) —— 只允许有渲染职责的系统实现。
 *
 * 生命周期方法全部可选。`init` 按依赖拓扑序串行 await；`dispose` 按逆序，
 * 先关依赖方再关被依赖方。
 */

import { EventBus } from './events.ts'
import { FixedClock, type FixedClockOptions, type FrameTime } from './fixed-clock.ts'
import { SystemRegistry, type KernelSystem } from './registry.ts'

/** 所有子系统的公共上下文最小形状；具体项目可以扩展。 */
export interface KernelContext {
  readonly events: EventBus<any>
  readonly time: FrameTime
}

export interface KernelOptions extends FixedClockOptions {
  /** 初始化进度回调：Boot 画面用它显示真实阶段，而不是一个假进度条。 */
  onProgress?: (fraction: number, id: string) => void
}

export class Kernel<C extends KernelContext> {
  readonly clock: FixedClock
  readonly registry = new SystemRegistry<C>()
  /**
   * 单系统错误记录。
   *
   * 一个表现系统抛错（比如某个粒子池拿到 null 贴图）不该让本帧剩下的系统
   * 全部不跑 —— 敌人的位置、HUD 的读数、声音都还在等着更新。所以每个
   * (系统, 阶段) 单独 try/catch，同一处只报一次，其余照常推进。
   */
  readonly errors: { system: string; phase: string; error: unknown }[] = []
  private readonly reported = new Set<string>()
  private initialized = false
  private disposed = false

  constructor(options: KernelOptions = {}) {
    this.clock = new FixedClock(options)
    if (options.onProgress !== undefined) {
      this.onProgress = options.onProgress
    }
  }

  private readonly onProgress?: (fraction: number, id: string) => void

  add(id: string, system: KernelSystem<C>, deps: readonly string[] = []): this {
    if (this.initialized) throw new Error('cannot add subsystem after init')
    this.registry.add(id, system, deps)
    return this
  }

  /** 按拓扑序初始化。ctx.time 必须是 this.clock.time（由调用方构造）。 */
  async init(ctx: C): Promise<void> {
    if (this.initialized) return
    const order = this.registry.resolve()
    for (let i = 0; i < order.length; i++) {
      const entry = order[i]!
      this.onProgress?.(i / Math.max(1, order.length), entry.id)
      await entry.system.init?.(ctx)
    }
    this.onProgress?.(1, 'kernel')
    this.initialized = true
  }

  /**
   * 推进一个渲染帧。返回本帧执行的固定步数量，供诊断面板统计。
   *
   * 调用方必须先保证 ctx.time === this.clock.time。这里不再做一次运行时
   * 检查：每帧一次的对象比较是纯浪费，而错了会在第一帧就显形。
   */
  advance(ctx: C, rawDt: number): number {
    if (this.disposed) return 0
    const steps = this.clock.advance(rawDt)
    const fixed = this.registry.with('fixedUpdate')
    for (let i = 0; i < steps; i++) {
      for (const entry of fixed) {
        if (entry.system.fixedUpdate === undefined) continue
        this.guard(entry.id, 'fixedUpdate', () => entry.system.fixedUpdate!(ctx.time.fixed, ctx))
      }
    }
    for (const entry of this.registry.with('update')) {
      if (entry.system.update === undefined) continue
      this.guard(entry.id, 'update', () => entry.system.update!(ctx.time.dt, ctx))
    }
    for (const entry of this.registry.with('lateUpdate')) {
      if (entry.system.lateUpdate === undefined) continue
      this.guard(entry.id, 'lateUpdate', () => entry.system.lateUpdate!(ctx.time.dt, ctx))
    }
    for (const entry of this.registry.with('render')) {
      if (entry.system.render === undefined) continue
      this.guard(entry.id, 'render', () => entry.system.render!(ctx))
    }
    return steps
  }

  /**
   * 错误隔离：同一 (系统, 阶段) 只记录/打印一次。
   *
   * 每帧刷同一条栈的代价很高（console 在 DevTools 打开时会同步序列化参数），
   * 足以把一个 30fps 的场景拖到 10fps —— 观察者效应会让"哪里坏了"更难查。
   */
  private guard(id: string, phase: string, run: () => void): void {
    try {
      run()
    } catch (error) {
      const key = `${id}:${phase}`
      if (this.reported.has(key)) return
      this.reported.add(key)
      this.errors.push({ system: id, phase, error })
      console.error(`[kernel] ${id}.${phase} 抛错（已隔离，后续帧继续尝试）`, error)
    }
  }

  resize(width: number, height: number, ctx: C): void {
    for (const entry of this.registry.with('resize')) {
      entry.system.resize?.(width, height, ctx)
    }
    ctx.events.emit('resize', { width, height })
  }

  dispose(ctx?: C): void {
    if (this.disposed) return
    this.disposed = true
    const order = this.registry.ordered
    for (let i = order.length - 1; i >= 0; i--) order[i]!.system.dispose?.()
    if (ctx !== undefined) ctx.events.clear()
    this.registry.clear()
  }

  get running(): boolean {
    return this.initialized && !this.disposed
  }
}
