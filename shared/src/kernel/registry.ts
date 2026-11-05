/**
 * 子系统注册表：显式依赖 + 拓扑排序 + 生命周期方法缓存。
 *
 * 这是"内核不知道业务"的关键。引擎只认识 id、deps 和五个可选生命周期方法；
 * 某个系统是渲染、网络还是音频，注册表一概不关心。
 *
 * 每个系统可以声明自己必须在谁之后初始化。初始化顺序与注册顺序无关，
 * 这样 `main.ts` 里新增一行注册不会悄悄改变别人的启动顺序。
 *
 * 约束：
 * - id 唯一，重复直接抛错（静默覆盖会让被覆盖者永远不启动）；
 * - 依赖必须已注册，缺一个就抛错；
 * - 循环依赖直接抛错，并在错误里带上从哪条边绕回来的；
 * - `with(method)` 的结果缓存：帧循环里每帧筛选一遍数组纯属浪费。
 */

export interface KernelSystem<C> {
  init?(ctx: C): void | Promise<void>
  fixedUpdate?(dt: number, ctx: C): void
  update?(dt: number, ctx: C): void
  lateUpdate?(dt: number, ctx: C): void
  render?(ctx: C): void
  resize?(width: number, height: number, ctx: C): void
  dispose?(): void
}

export interface SystemEntry<C> {
  readonly id: string
  readonly deps: readonly string[]
  readonly system: KernelSystem<C>
}

export class SystemRegistry<C> {
  private readonly entries = new Map<string, SystemEntry<C>>()
  private order: SystemEntry<C>[] = []
  private readonly methodCache = new Map<string, SystemEntry<C>[]>()

  /** 注册一个系统实例。id 必须由调用方给出，便于测试与无类系统。 */
  add(id: string, system: KernelSystem<C>, deps: readonly string[] = []): this {
    if (id.length === 0) throw new Error('system id must not be empty')
    if (this.entries.has(id)) throw new Error(`duplicate subsystem id "${id}"`)
    this.entries.set(id, { id, deps: [...deps], system })
    this.order = []
    this.methodCache.clear()
    return this
  }

  get(id: string): KernelSystem<C> {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`subsystem "${id}" is not registered`)
    return entry.system
  }

  /** 可选依赖：没注册返回 null，而不是抛错。 */
  peek(id: string): KernelSystem<C> | null {
    return this.entries.get(id)?.system ?? null
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** 按依赖做 DFS 拓扑排序。任何缺失/环都会在启动时暴露，而不是运行到一半。 */
  resolve(): SystemEntry<C>[] {
    if (this.order.length > 0) return this.order
    const state = new Map<string, 0 | 1>()
    const out: SystemEntry<C>[] = []
    const visit = (id: string, from: string): void => {
      const s = state.get(id)
      if (s === 1) return
      if (s === 0) throw new Error(`dependency cycle at "${id}" (via "${from}")`)
      const entry = this.entries.get(id)
      if (entry === undefined) throw new Error(`"${from}" depends on unregistered subsystem "${id}"`)
      state.set(id, 0)
      for (const dep of entry.deps) visit(dep, id)
      state.set(id, 1)
      out.push(entry)
    }
    for (const id of this.entries.keys()) visit(id, '<root>')
    this.order = out
    return out
  }

  get ordered(): SystemEntry<C>[] {
    return this.order.length > 0 ? this.order : this.resolve()
  }

  /** 实现了某个生命周期方法的系统，按依赖顺序返回并缓存。 */
  with(method: keyof KernelSystem<C>): SystemEntry<C>[] {
    const key = String(method)
    const cached = this.methodCache.get(key)
    if (cached !== undefined) return cached
    const list = this.ordered.filter((entry) => typeof entry.system[method] === 'function')
    this.methodCache.set(key, list)
    return list
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.order = []
    this.methodCache.clear()
  }
}
