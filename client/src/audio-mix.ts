/**
 * 混音底层件：距离模型、噪声/脉冲 buffer、音源池、地形参数表。
 *
 * 为什么单独一个文件：`audio.ts` 里要堆十几种"声音配方"（枪、脚步、怪物、
 * 环境、身体声），每个配方都是七八行节点接线。如果把 buffer 构造、抢声、
 * 回收这些机制也塞进去，文件会变成 2000 行、改一个脚步要跳三次上下文。
 * 这里只放**与"具体是什么声音"无关**的东西，audio.ts 只负责配方。
 *
 * 三条贯穿全文件的取舍：
 *
 * 1. **不用 PannerNode 做距离衰减**，只用它做方向。PannerNode 自带
 *    distanceModel，但它的增益曲线是固定的几个公式，我们真正想要的"远处
 *    只剩闷响"必须靠**低通**实现 —— 那是一个 PannerNode 给不了的自由度。
 *    所以：PannerNode 负责"在左还是在右"，我们自己算距离 → 低通 + 空气延迟。
 *
 * 2. **所有噪声 buffer 首尾交叉淡化**。环境声是 loop 的，白噪声接缝是一声
 *    "咔"（采样不连续），布朗噪声接缝是一声"噗"（直流分量跳变）。把生成
 *    长度做长 fade 个样本，用尾部去和头部加权混合，接缝两侧就融在一起了。
 *
 * 3. **音源数硬上限 + 优先级**。音频线程和主线程共用一条消息队列，节点一多
 *    整个游戏的帧就抖。玩家自己的换弹声比 60 米外的脚步重要得多 —— 所以
 *    满了就按优先级丢"远处的"，而不是按创建顺序丢"最早的"。
 */

import { clamp } from '@dk/shared'

// ---------------------------------------------------------------- 类型

/** 世界坐标。故意用结构类型而不是 three 的 Vector3：调用方不必为此 import three。 */
export interface WorldPoint {
  x: number
  y: number
  z: number
}

/** 地形：决定脚步声的频谱与包络，是玩家在黑夜里判断"敌人在哪条路上"的主要线索。 */
export type FootstepSurface = 'wood' | 'stone' | 'mud' | 'metal' | 'foliage' | 'water'

/** 区域：同一套环境声在沼泽、室内、开阔地的配比完全不同。 */
export type AmbienceBias = 'marsh' | 'indoor' | 'open'

/** 怪物叫声类型。 */
export type MonsterKind = 'grunt' | 'hound'

/**
 * 优先级：数字越小越重要，抢声时先牺牲大的。
 *
 * 玩家自身永远 0 —— 换弹、心跳、喘息是"我自己的状态"，丢掉它会让玩家
 * 怀疑操作没生效；而远处的交火丢一发只是少一条信息。
 */
export const PRIORITY = {
  self: 0,
  near: 1,
  far: 2,
  ambience: 3,
} as const

/** 同时活跃的瞬态音源上限（不含常驻环境层）。 */
export const MAX_VOICES = 24

/** 距离小于这个值就当"自己脚下"，不挂 PannerNode：HRTF 对 0 距离会爆成单声道尖刺。 */
export const SELF_RADIUS_M = 1

// ---------------------------------------------------------------- 距离模型

/** 增益正好为 1 的参考距离（米）：这个距离以内都是"贴脸"，不再变响。 */
export const REF_DISTANCE_M = 4

/** 再远也不彻底静音。0.01 是"听得见但分不清方向"的底噪级。 */
export const GAIN_FLOOR = 0.01

/** 0m 处的低通截止。18k 已经足够亮，再往上只是把混叠毛刺放进来。 */
export const CUTOFF_NEAR_HZ = 18000

/** 截止频率每隔多少米掉一半：18000 / (1 + d/25)。 */
export const CUTOFF_SPAN_M = 25

/** 低通地板。低于这个值枪声就只剩"噗"，玩家会以为没打出去。 */
export const CUTOFF_FLOOR_HZ = 1200

/** 声速（米/秒）。40m 外的枪声比光晚 117ms —— 这点延迟是"距离感"的一半。 */
export const SPEED_OF_SOUND = 343

/** 空气延迟上限：再远就快跟不上画面了，450ms 大约 150m 之外。 */
const MAX_AIR_DELAY_S = 0.45

/**
 * 遮挡：射线被墙挡住时，声音只剩"从缝里漏进来"的一点。
 *
 * 0.35 是量出来的 —— 再低就完全听不出方向，玩家会把隔墙的交火当成自己背后；
 * 再高就还是"墙不存在"。真正让它"闷"的是低通压到 900Hz，枪声的宽带噪声
 * 被砍掉一大半，听感上比这个增益数字暗得多。
 */
export const OCCLUDED_GAIN = 0.35
export const OCCLUDED_CUTOFF_HZ = 900
export const OCCLUDED_WET_BONUS = 0.15

/**
 * 距离 → 混响送出量。远处的声音在户外也带一点空间，因为空气和地面的散射
 * 把直达声吃掉了；贴脸的枪声则几乎干的，不然会像在桶里开枪。
 */
export function reverbWet(distance: number): number {
  return 0.06 + 0.3 * Math.min(1, safeDistance(distance) / 80)
}

export function safeDistance(distance: number): number {
  return Number.isFinite(distance) && distance > 0 ? distance : 0
}

/**
 * 距离 → 增益。反平方律：REF/max(REF, d)。
 *
 * 真 1/d² 在 5m 内会炸成 Infinity、在 100m 外又低到听不见。这条曲线在
 * 4m 以内平着走（贴脸不该再变响），之后每翻一倍距离掉一半：10m 0.4、
 * 40m 0.1、100m 0.04 —— 远处的交火仍然"有"，但明显不是发生在身边。
 */
export function attenuationGain(distance: number): number {
  const d = safeDistance(distance)
  return clamp(REF_DISTANCE_M / Math.max(REF_DISTANCE_M, d), GAIN_FLOOR, 1)
}

/**
 * 距离 → 低通截止。这条曲线才是空间感的真正来源：
 * 20m 只剩 8k、80m 只剩 5k、200m 剩 2.4k，高频瞬态被空气一点点吃掉，
 * 听上去从"啪"变成"嘭"。地板给到 1.2k，否则远枪声会退化成一声闷屁。
 */
export function attenuationCutoff(distance: number): number {
  const d = safeDistance(distance)
  return clamp(CUTOFF_NEAR_HZ / (1 + d / CUTOFF_SPAN_M), CUTOFF_FLOOR_HZ, CUTOFF_NEAR_HZ)
}

/** 声音跑完这段距离要多久（秒），封顶 0.45s。 */
export function airDelay(distance: number): number {
  return Math.min(safeDistance(distance) / SPEED_OF_SOUND, MAX_AIR_DELAY_S)
}

/** 水平面上的距离：脚步在楼上楼下时不该当成"就在旁边"。 */
export function planarDistance(a: WorldPoint, b: WorldPoint): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  const dy = (a.y - b.y) * 0.5 // 垂直方向压一半：同一栋楼的二楼仍然算"近"
  return safeDistance(Math.hypot(dx, dy, dz))
}

/** 廉价 3D→1D 哈希：拿世界点当音色种子。同一个木箱每次都一样，墙和铁皮不一样。 */
export function hashPoint(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
  return s - Math.floor(s)
}

/** -1..1 的对称抖动：让每一步、每一枪都不完全一样，耳朵才不会听出"机器"。 */
export function jitter(amount: number): number {
  return (Math.random() * 2 - 1) * amount
}

// ---------------------------------------------------------------- buffer

/**
 * 可无缝循环的噪声。**首尾交叉淡化**是这里唯一的技巧：
 *
 * 生成 len+fade 个样本，前 fade 个样本用"尾部样本"按权重替换掉一部分，
 * 于是第 len 个样本之后紧接着的第 0 个样本，波形是连续过渡过去的 ——
 * 直接 loop 生噪听起来像"每秒一次的水滴"，交叉淡化之后才是风。
 *
 * @param tint 幅度系数。0.6 左右更适合做"远处的底噪"。
 * @param brown true = 布朗噪声（低频占多数，风声），false = 白噪声（撞击体）。
 */
export function buildLoopNoise(
  ctx: AudioContext,
  seconds: number,
  crossfade = 0.35,
  tint = 1,
  brown = false,
): AudioBuffer {
  const rate = ctx.sampleRate
  const len = Math.max(64, Math.floor(rate * seconds))
  const fade = Math.min(Math.floor(rate * crossfade), Math.floor(len / 3))
  const buffer = ctx.createBuffer(1, len, rate)
  const data = buffer.getChannelData(0)
  // 多算 fade 个样本，专门用来做"尾部盖住头部"的那段混合
  const extra = new Float32Array(fade)
  if (brown) {
    // 一阶低通的随机游走：能量集中在低频，正是"风"和"低频轰鸣"的形状
    let last = 0
    for (let i = 0; i < len; i++) {
      last = (last + (Math.random() * 2 - 1) * 0.02) / 1.02
      data[i] = last * 3.2 * tint
    }
    for (let i = 0; i < fade; i++) {
      last = (last + (Math.random() * 2 - 1) * 0.02) / 1.02
      extra[i] = last * 3.2 * tint
    }
  } else {
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * tint
    for (let i = 0; i < fade; i++) extra[i] = (Math.random() * 2 - 1) * tint
  }
  for (let i = 0; i < fade; i++) {
    const w = i / fade
    data[i] = data[i] * w + extra[i] * (1 - w)
  }
  return buffer
}

/**
 * 混响脉冲响应：指数衰减的低通噪声。
 *
 * 为什么不用 `createConvolver` 之外的"反馈延迟网络"：ConvolverNode 是浏览器
 * 原生实现（可能是 FFT 的），32 路同时挂也不吃主线程；自己搭 FDN 要十来个
 * Delay+Feedback 节点，还得每帧手算，收益只有"可调早期反射"。
 *
 * 一阶低通是必须的：纯白噪 IR 听起来像铁皮罐，真空间的尾音高频衰减更快。
 */
export function buildReverbImpulse(ctx: AudioContext, seconds = 1.7, decay = 2.6, preDelay = 0.02): AudioBuffer {
  const rate = ctx.sampleRate
  const len = Math.max(64, Math.floor(rate * seconds))
  const pre = Math.min(len - 1, Math.floor(rate * preDelay))
  const buffer = ctx.createBuffer(2, len, rate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    let lp = 0
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre)
      lp += ((Math.random() * 2 - 1) - lp) * 0.3
      // 两个声道用不同的随机序列 → 天然去相关，听起来是"空间"而不是"一格回声"
      data[i] = lp * Math.pow(1 - x, decay) * (channel === 0 ? 1 : 0.94)
    }
  }
  return buffer
}

// ---------------------------------------------------------------- 音源池

/** 一声的全部节点与音源。回收时逐个 disconnect —— 不回收的话节点会一直被音频图引用着。 */
export interface Recipe {
  nodes: AudioNode[]
  sources: AudioScheduledSourceNode[]
}

export function newRecipe(): Recipe {
  return { nodes: [], sources: [] }
}

/** 一路正在响的声音。 */
export interface MixVoice {
  priority: number
  /** 这一声的估算电平，同优先级里挑"最轻的"牺牲。 */
  level: number
  /** 出口增益：淡出、抢声都从这里下手（不要硬切，硬切本身就是一声咔哒）。 */
  out: GainNode
  startedAt: number
  nodes: AudioNode[]
  sources: AudioScheduledSourceNode[]
  released: boolean
  /** 回收回调：给调用方维护"当前挂了几个 PannerNode"这类计数。 */
  onRelease?: () => void
}

/**
 * 音源池：硬上限 + 优先级抢声 + 播完自动 disconnect。
 *
 * 抢声规则是**三段式**而不是"丢最老的"：
 *   1. 先找优先级最低的（远处的脚步 < 近处的枪 < 自己换弹）
 *   2. 同优先级找电平最低的（听不见的那一路）
 *   3. 再同电平找最早开始的（它本来也快完了）
 * 如果所有在响的声音都比新来的重要，新来的**直接被丢掉** —— 宁可缺一声，
 * 也不要把正在传达信息的那路掐掉。
 */
export class VoiceBus {
  private readonly voices = new Set<MixVoice>()
  // 显式字段而不是构造函数参数属性：这个文件要能被 node --experimental-strip-types
  // 直接 import（tests/audio-mix.test.ts 钉距离曲线），参数属性在 strip-only 模式下会直接报错。
  private readonly ctx: AudioContext
  private readonly max: number

  constructor(ctx: AudioContext, max: number = MAX_VOICES) {
    this.ctx = ctx
    this.max = max
  }

  get size(): number {
    return this.voices.size
  }

  get activeSources(): number {
    let count = 0
    for (const voice of this.voices) count += voice.sources.length
    return count
  }

  get activeNodes(): number {
    let count = 0
    for (const voice of this.voices) count += voice.nodes.length
    return count
  }

  /** 每个还在响的 voice 的节点清单，供调试/验证读取。 */
  inspect(): { priority: number; level: number; sources: number; nodes: number }[] {
    const list: { priority: number; level: number; sources: number; nodes: number }[] = []
    for (const voice of this.voices) {
      list.push({ priority: voice.priority, level: voice.level, sources: voice.sources.length, nodes: voice.nodes.length })
    }
    return list
  }

  /** 申请一路。返回 null 表示这一声被丢掉了（池满且全部比它重要）。 */
  begin(priority: number, level: number, dest: AudioNode): MixVoice | null {
    if (this.voices.size >= this.max) {
      const victim = this.pickVictim(priority, level)
      if (victim === null) return null
      this.hush(victim, 0.04)
    }
    const out = this.ctx.createGain()
    out.gain.value = 1
    out.connect(dest)
    const voice: MixVoice = {
      priority,
      level,
      out,
      startedAt: this.ctx.currentTime,
      nodes: [out],
      sources: [],
      released: false,
    }
    this.voices.add(voice)
    return voice
  }

  /** 把节点/音源交给池子托管，并挂上"最后一个音源结束时回收"的回调。 */
  seal(voice: MixVoice, recipe: Recipe, backstopSeconds = 12): void {
    for (const node of recipe.nodes) voice.nodes.push(node)
    for (const source of recipe.sources) voice.sources.push(source)
    const sources = voice.sources
    if (sources.length === 0) {
      this.free(voice)
      return
    }
    // 等**全部**音源结束再回收：一发枪声里噪声、炮身、爆音、混响送出的停点是
    // 错开的，拿"最后创建的那个音源"当回收点，会把还在响的邻居一起掐掉 ——
    // 听感上就是枪声的尾巴被剪断。
    let pending = sources.length
    for (const source of sources) {
      source.addEventListener('ended', () => {
        pending -= 1
        if (pending <= 0) this.free(voice)
      })
    }
    // 兜底：上下文被挂起/被浏览器冻结时 ended 可能永远不来，节点就一直挂着 ——
    // 这正是"玩十分钟内存一直涨"的来源。一个一次性定时器保证最坏情况也能摘掉。
    setTimeout(() => {
      this.free(voice)
    }, Math.max(1, backstopSeconds) * 1000)
  }

  /** 立即摘掉（不管音源停没停）。幂等：hush 的兜底定时器和 onended 可能都调它。 */
  free(voice: MixVoice): void {
    if (voice.released) return
    voice.released = true
    this.voices.delete(voice)
    for (const source of voice.sources) {
      try {
        source.disconnect()
      } catch {
        // 重复 disconnect 在部分实现上会抛，忽略
      }
    }
    for (const node of voice.nodes) {
      try {
        node.disconnect()
      } catch {
        // 同上
      }
    }
    voice.sources.length = 0
    voice.nodes.length = 0
    voice.onRelease?.()
  }

  /** 淡出并提前停掉一路。真正的 disconnect 交给 onended（或兜底定时器）。 */
  hush(voice: MixVoice, fade: number): void {
    if (voice.released) return
    this.voices.delete(voice)
    const now = this.ctx.currentTime
    try {
      voice.out.gain.cancelScheduledValues(now)
      voice.out.gain.setTargetAtTime(0, now, Math.max(fade, 0.005) / 3)
      for (const source of voice.sources) source.stop(now + fade + 0.02)
    } catch {
      this.free(voice)
      return
    }
    // 兜底：上下文被挂起时 onended 可能永远不来，定时器保证节点最终会被摘掉。
    setTimeout(() => this.free(voice), (fade + 0.2) * 1000)
  }

  /** 全部淡出（切场景 / dispose 用）。 */
  hushAll(fade: number): void {
    for (const voice of Array.from(this.voices)) this.hush(voice, fade)
  }

  private pickVictim(priority: number, level: number): MixVoice | null {
    let victim: MixVoice | null = null
    for (const voice of this.voices) {
      if (victim === null) {
        victim = voice
        continue
      }
      if (voice.priority > victim.priority) {
        victim = voice
        continue
      }
      if (voice.priority < victim.priority) continue
      if (voice.level < victim.level - 1e-4) victim = voice
      else if (Math.abs(voice.level - victim.level) <= 1e-4 && voice.startedAt < victim.startedAt) victim = voice
    }
    if (victim === null) return null
    // 比新来的还重要的，绝不牺牲
    if (victim.priority < priority) return null
    if (victim.priority === priority && victim.level >= level + 1e-4) return null
    return victim
  }
}

// ---------------------------------------------------------------- 配方原语

/** 包络：指数逼近 0.0001 而不是 0 —— exponentialRamp 到 0 会抛异常。 */
export function envelope(param: AudioParam, at: number, peak: number, attack: number, dur: number): void {
  const top = Math.max(0.0002, peak)
  param.setValueAtTime(0.0001, at)
  param.exponentialRampToValueAtTime(top, at + Math.max(0.0015, attack))
  param.exponentialRampToValueAtTime(0.0001, at + Math.max(attack + 0.005, dur))
}

export interface ShakeOptions {
  /** 共用的白噪声 buffer（1.5s 足够，loop 打开后不会用完）。 */
  noise: AudioBuffer
  at: number
  peak: number
  attack?: number
  dur: number
  type?: BiquadFilterType
  freq?: number
  q?: number
  /** 带通/低通的截止扫向这个频率（水花、刀风用）。 */
  sweepTo?: number
  hp?: number
  lp?: number
  rate?: number
}

/**
 * 噪声撞击体：几乎是所有"物体发声"的骨架。
 *
 * 为什么噪声 + 带通就够：枪声、脚步、金属撞击在物理上都是"宽带冲击被材质
 * 滤过一遍"。带通中心决定材质（600Hz 木头、2800Hz 铁皮），Q 决定"干脆还是
 * 浑浊"，包络决定"多重"。
 */
export function shake(ctx: AudioContext, recipe: Recipe, dest: AudioNode, o: ShakeOptions): GainNode {
  const at = o.at
  const dur = Math.max(0.01, o.dur)
  const src = ctx.createBufferSource()
  src.buffer = o.noise
  // loop 打开：buffer 用完时源会自己结束、onended 提前触发，把还在响的
  // 邻居一起回收掉。loop 之后 stop() 才是唯一的结束点。
  src.loop = true
  src.playbackRate.value = o.rate ?? 1
  recipe.sources.push(src)
  recipe.nodes.push(src)
  let tail: AudioNode = src
  if (o.hp !== undefined) {
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = Math.max(20, o.hp)
    tail.connect(hp)
    tail = hp
    recipe.nodes.push(hp)
  }
  if (o.type !== undefined) {
    const filter = ctx.createBiquadFilter()
    filter.type = o.type
    filter.frequency.value = Math.max(30, o.freq ?? 1000)
    filter.Q.value = o.q ?? 1
    if (o.sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(30, o.sweepTo), at + dur)
    }
    tail.connect(filter)
    tail = filter
    recipe.nodes.push(filter)
  }
  if (o.lp !== undefined) {
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = Math.max(60, o.lp)
    tail.connect(lp)
    tail = lp
    recipe.nodes.push(lp)
  }
  const gain = ctx.createGain()
  envelope(gain.gain, at, o.peak, o.attack ?? 0.004, dur)
  tail.connect(gain)
  gain.connect(dest)
  recipe.nodes.push(gain)
  src.start(at, Math.random() * Math.max(0, o.noise.duration - 0.05))
  src.stop(at + dur + 0.04)
  return gain
}

export interface ToneOptions {
  type?: OscillatorType
  from: number
  to?: number
  at: number
  peak: number
  attack?: number
  dur: number
  lp?: number
  /** 起始延迟（秒）：同一发里的第二个音节、机械件扣合的第二声。 */
  lag?: number
}

/** 扫频音：低频"落地"、金属"叮"、上膛"咔"里的那个音高部分。 */
export function tone(ctx: AudioContext, recipe: Recipe, dest: AudioNode, o: ToneOptions): GainNode {
  const at = o.at + (o.lag ?? 0)
  const dur = Math.max(0.01, o.dur)
  const osc = ctx.createOscillator()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(Math.max(20, o.from), at)
  if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), at + dur)
  recipe.sources.push(osc)
  recipe.nodes.push(osc)
  let tail: AudioNode = osc
  if (o.lp !== undefined) {
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = Math.max(60, o.lp)
    tail.connect(lp)
    tail = lp
    recipe.nodes.push(lp)
  }
  const gain = ctx.createGain()
  envelope(gain.gain, at, o.peak, o.attack ?? 0.004, dur)
  tail.connect(gain)
  gain.connect(dest)
  recipe.nodes.push(gain)
  osc.start(at)
  osc.stop(at + dur + 0.04)
  return gain
}

/** 一声极短的金属"嗒"。换弹、切枪、空仓全用它，只是频率不同。 */
export function click(
  ctx: AudioContext,
  recipe: Recipe,
  dest: AudioNode,
  noise: AudioBuffer,
  at: number,
  freq: number,
  peak: number,
  dur: number,
): void {
  shake(ctx, recipe, dest, { noise, at, peak, attack: 0.0015, dur, type: 'bandpass', freq, q: 7 })
  tone(ctx, recipe, dest, { type: 'triangle', from: freq * 0.5, to: freq * 0.35, at, peak: peak * 0.35, attack: 0.0015, dur: dur * 0.8 })
}

// ---------------------------------------------------------------- 地形表

/**
 * 一种地形的脚印配方。
 *
 * 这些数字是"听感优先"的，不是物理量：
 * - 木头是**空心**的：低频 95Hz 的闷响 + 只在高频露出一点点吱呀（creak）。
 * - 石头是**干**的：带通中心高、Q 大、尾巴短，听起来像砂石在鞋底滚动。
 * - 泥是**黏**的：低频下坠更长，另加一段"吸"（sweepTo 往上）和一点水声。
 * - 草是**散**的：没有低频落地声，纯高频沙沙，时长最长、抖动最大。
 * - 金属是**亮**的：Q=9 的窄带 + 2.2kHz 的余响（ping）。
 * - 水是**溅**的：带通从 1.2k 扫到 3.6k，再加一组随机气泡。
 */
export interface SurfaceSpec {
  /** 主带通中心与 Q。 */
  band: number
  q: number
  /** 高频/低频切除：石头要砍掉低频，草要砍掉中低频。 */
  hp: number
  lp: number
  /** 噪声体长度与峰值。 */
  dur: number
  peak: number
  /** 低频落地（闷响）的起止频率与电平，0 表示这种地形没有落地声。 */
  thumpFrom: number
  thumpTo: number
  thumpPeak: number
  /** 木头的吱呀 / 泥的黏连：0..1。 */
  creak: number
  /** 金属余响：0..1。 */
  ping: number
  /** 水花：0..1。 */
  splash: number
  /** 音高/时长抖动：草和碎石每一步都不一样。 */
  jitter: number
}

export const SURFACES: Record<FootstepSurface, SurfaceSpec> = {
  wood: { band: 900, q: 1.2, hp: 90, lp: 2400, dur: 0.13, peak: 0.34, thumpFrom: 95, thumpTo: 52, thumpPeak: 0.3, creak: 0.5, ping: 0, splash: 0, jitter: 0.12 },
  stone: { band: 2100, q: 2.4, hp: 320, lp: 9000, dur: 0.085, peak: 0.3, thumpFrom: 140, thumpTo: 70, thumpPeak: 0.18, creak: 0, ping: 0.05, splash: 0, jitter: 0.18 },
  mud: { band: 520, q: 0.9, hp: 60, lp: 1500, dur: 0.19, peak: 0.3, thumpFrom: 78, thumpTo: 40, thumpPeak: 0.34, creak: 0.18, ping: 0, splash: 0.22, jitter: 0.15 },
  foliage: { band: 3300, q: 1.1, hp: 900, lp: 12000, dur: 0.21, peak: 0.24, thumpFrom: 0, thumpTo: 0, thumpPeak: 0, creak: 0, ping: 0, splash: 0, jitter: 0.25 },
  metal: { band: 2800, q: 9, hp: 420, lp: 12000, dur: 0.17, peak: 0.3, thumpFrom: 190, thumpTo: 90, thumpPeak: 0.14, creak: 0, ping: 0.45, splash: 0, jitter: 0.08 },
  water: { band: 1500, q: 1.4, hp: 200, lp: 8000, dur: 0.26, peak: 0.3, thumpFrom: 110, thumpTo: 60, thumpPeak: 0.16, creak: 0, ping: 0, splash: 0.6, jitter: 0.2 },
}

/** 从世界点猜地形（调用方没给 surface 时的兜底）：靠哈希保持"同一个位置永远同一种声音"。 */
export function guessSurface(point: WorldPoint): FootstepSurface {
  const seed = hashPoint(Math.round(point.x), Math.round(point.y), Math.round(point.z))
  if (seed < 0.42) return 'mud'
  if (seed < 0.62) return 'foliage'
  if (seed < 0.78) return 'water'
  if (seed < 0.9) return 'wood'
  return 'stone'
}

// ---------------------------------------------------------------- 区域配比

/**
 * 环境声的区域配比。
 *
 * muffle（低通截止）是"在室内"最关键的一条 —— 耳朵判断"我在屋子里"靠的
 * 不是声音变小，而是**高频没了**。所以 indoor 直接把整个环境总线的截止
 * 压到 2.6kHz，同时把虫鸣砍到 0.12、把钟声/管风琴抬到 1.5：
 * 室内应该听见的是建筑共鸣，不是虫子。
 */
export interface AmbienceMix {
  wind: number
  cricket: number
  critter: number
  bell: number
  /** 环境总线的低通截止（Hz）：室内闷、沼泽正常、开阔地最透。 */
  muffle: number
}

export const AMBIENCE_MIX: Record<AmbienceBias, AmbienceMix> = {
  marsh: { wind: 1, cricket: 1.25, critter: 1, bell: 0.55, muffle: 9000 },
  indoor: { wind: 0.35, cricket: 0.12, critter: 0.3, bell: 1.5, muffle: 2600 },
  open: { wind: 1.15, cricket: 0.85, critter: 1.1, bell: 0.8, muffle: 12000 },
}
