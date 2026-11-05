/**
 * 确定性随机源（xoshiro128**）。
 *
 * 为什么不用 `Math.random`：回放、无头截图、延迟补偿重放都要求"同一串种子
 * 产出同一串轨迹"。`Math.random` 的算法没有跨引擎保证，也无法 fork ——
 * 一个音频抖动扰动一次，AI 的游荡方向就全变了。
 *
 * 用法约定：
 * - 每个子系统用自己的 `fork()` 流。粒子/音频/镜头各占一条流，互不扰动。
 * - 玩法随机（AI、掉落、后坐扩散）只走玩法流；纯视觉抖动走视觉流。
 * - 需要记录回放时，把外层种子和每个 fork 的初始种子一起存下来即可。
 *
 * 算法本身来自 xoshiro128** 的公开参考实现；这里只补了种子扩散、fork、
 * 状态快照与本项目常用的取数辅助。所有运算都是 32 位整数，逐位可复现。
 */

export type RngState = readonly [number, number, number, number]

export class Rng {
  private s0 = 0
  private s1 = 0
  private s2 = 0
  private s3 = 0
  /** Box–Muller 的第二个样本，下一次 gauss() 直接取用。 */
  private spare: number | undefined

  constructor(seed = 0x9e3779b9) {
    this.reseed(seed)
  }

  /** SplitMix32 扩散种子，避免相邻种子产生高度相关的第一串数。 */
  reseed(seed: number): this {
    let z = seed >>> 0
    const next = (): number => {
      z = (z + 0x9e3779b9) >>> 0
      let x = z
      x = Math.imul(x ^ (x >>> 16), 0x21f0aaad)
      x = Math.imul(x ^ (x >>> 15), 0x735a2d97)
      return (x ^ (x >>> 15)) >>> 0
    }
    this.s0 = next()
    this.s1 = next()
    this.s2 = next()
    this.s3 = next()
    this.spare = undefined
    return this
  }

  /** 均匀 uint32。 */
  u32(): number {
    const rot = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0
    const result = Math.imul(rot(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0
    const t = (this.s1 << 9) >>> 0
    this.s2 ^= this.s0
    this.s3 ^= this.s1
    this.s1 ^= this.s2
    this.s0 ^= this.s3
    this.s2 ^= t
    this.s3 = rot(this.s3, 11)
    return result
  }

  /** [0,1)。 */
  float(): number {
    return this.u32() / 4294967296
  }

  /** [min,max) 连续值。 */
  range(min: number, max: number): number {
    return min + (max - min) * this.float()
  }

  /** [min,max] 整数（含两端）。 */
  int(min: number, max: number): number {
    return min + (this.u32() % (max - min + 1))
  }

  /** [-1,1)。 */
  signed(): number {
    return this.float() * 2 - 1
  }

  /** 标准正态；Box–Muller 缓存另一半，避免每个样本两次三角函数。 */
  gauss(): number {
    if (this.spare !== undefined) {
      const v = this.spare
      this.spare = undefined
      return v
    }
    let u = 0
    while (u === 0) u = this.float()
    const r = Math.sqrt(-2 * Math.log(u))
    const theta = 2 * Math.PI * this.float()
    this.spare = r * Math.sin(theta)
    return r * Math.cos(theta)
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array')
    return items[this.u32() % items.length]!
  }

  /** 单位圆盘内均匀一点。子弹散布、粒子发射方向都用它。 */
  disc(out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
    const r = Math.sqrt(this.float())
    const a = this.float() * Math.PI * 2
    out.x = Math.cos(a) * r
    out.y = Math.sin(a) * r
    return out
  }

  /**
   * 派生一条独立流。父流的后续取数不受子流影响，反之亦然。
   * 子系统初始化时各 fork 一次，是保证"换一个粒子上限不会改变 AI 路线"的
   * 最低成本做法。
   */
  fork(): Rng {
    return new Rng(this.u32())
  }

  /** 当前四字状态。用于回放存档/单测精确断言。 */
  state(): RngState {
    return [this.s0 >>> 0, this.s1 >>> 0, this.s2 >>> 0, this.s3 >>> 0]
  }

  /** 恢复状态。不做种子扩散 —— 这是给回放用的原始状态，不是用户种子。 */
  restore(state: RngState): this {
    this.s0 = state[0] >>> 0
    this.s1 = state[1] >>> 0
    this.s2 = state[2] >>> 0
    this.s3 = state[3] >>> 0
    this.spare = undefined
    return this
  }
}
