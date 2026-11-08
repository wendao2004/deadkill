/**
 * 全合成音效 + 空间混音器。仓库里没有、也不会有任何音频资源文件：CSP 禁掉一切
 * 外链，部署容器只有 512MB。所以每一个声音都是现搓的 Web Audio 图。
 *
 * ## 玩家反馈"没有声音"——根因（有头 Chrome + CDP 实测）
 *
 * 先说结论：**类内的合成配方没问题，静音全部来自上下文生命周期。**
 *
 * 实测（裸 AudioKit，click 手势后 new + await unlock()）：ctx.state="running"、
 * sampleRate 48000、masterGain=0.8、compressor -16/6；在 destination 前串一个
 * AnalyserNode 取 0.3s 窗：ambience RMS 0.0034 / peak 0.0104，shot(1,0) RMS 0.0766 /
 * peak 1.05（压缩器前已过 0dB）。也就是说图是响的。
 *
 * 真正让玩家听到全静音的是三处生命周期缺陷（旧代码逐条对应，这一版都修了）：
 *
 * 1. **一次 dispose() 之后永久静音，且没有任何重建路径。**
 *    旧 live() 用 ctx.state === 'closed' 判死，dispose() 又把 disposed 置成永久
 *    锁。真实启动链里 Game 构造 → unlock() → startAmbience() 都跑完了，随后一次
 *    dispose() 把上下文 close 掉（CDP 抓到 states:["closed"]、__edges 里有一条
 *    {closed:15005}），此后每一发 shot/footstep 都在 live() 里被静默丢弃 ——
 *    玩家听到的就是"全静音"，而控制台干净得没有一个报错。
 *    修法：unlock() 遇到 closed 就地重建整套图；create() 里挂 ctx.onstatechange，
 *    上下文被外部关掉/挂起也能自愈。
 *
 * 2. **unlock() 里 resume() 跟 250ms 超时赛跑，输了就没人补环境声。**
 *    resume 慢于 250ms（或永远 pending）时 ready 是 false → startAmbience() 静默
 *    返回，而旧代码只在"下一次 unlock()"里补 —— 玩家不点画面就永远没有环境声。
 *    修法：startAmbience() 自带一次性重试（20 次 × 600ms），并且 onstatechange
 *    恢复 running 时自动补播。
 *
 * 3. **suspended 状态下照样往下排音源。** 旧 live() 只把 closed 当死。挂起时排进
 *    去的音源不会响，而是排队，恢复的瞬间一次性全炸出来（听起来像爆音）。
 *    修法：live() 对非 running 直接返回 null，顺手 resume() 一次，并丢掉这一声。
 *
 * 顺手还修掉一个"初值被覆盖"的隐患：setVolume() 在 create() 之前调用时只写字段，
 * create() 用 this.volume 初始化 master gain。旧代码 master 初值靠 setVolume 覆盖，
 * 一旦调用顺序反过来就是永久静音 —— 这种 bug 不报错，只能靠不依赖调用顺序来避免。
 *
 * ## 空间化：这次为什么挂了 PannerNode
 *
 * 上一版是自己算增益 + 低通，理由是"没有节点状态，不会出现某一帧忘了更新 listener
 * 就永久歪掉"。但玩家明确要求"黑夜地图要靠听声音判断局势"——那需要**方向**，纯
 * 增益给不了。所以这一版：距离 → 空气低通 + 反平方增益（纯函数，还是那两条曲线），
 * 方向 → HRTF PannerNode，listener 每帧由 setListener() 喂。
 *
 * 空气低通挂在 PannerNode **之前**：PannerNode 只改音量，不会把 40m 外的枪声变闷，
 * 而"闷"才是玩家判断距离的主要线索。声速延迟（343m/s，封顶 0.3s）在最后加：
 * 60m 外 0.17s 的延迟是"这枪不是冲我来的"最直接的提示。
 *
 * ## 预算与回收
 *
 * 同时最多 MAX_VOICES=24 路（VoiceBus 管），抢声规则是优先级 → 电平 → 时间。
 * 每一路的所有节点都登记在案，播完（最后一个音源 ended）连同混响送出一起
 * disconnect；另外挂一次性兜底定时器，因为上下文挂起时 ended 可能永远不来 ——
 * 这正是"玩十分钟内存一直涨"的来源。
 *
 * ## 主输出
 *
 * 所有声音 → master(gain=volume) → DynamicsCompressor(-16/24/6) → destination。
 * 压缩器参数保持旧值不动：十六人同时开枪时样本相加会过 ±1.0 被硬削顶，削顶是全
 * 频段方波失真，听感比"吵"糟糕得多。混响是共享 ConvolverNode（1.7s 衰减 IR），
 * 每路按 wet 送出，不做 per-voice IR —— 那会瞬间吃光 CPU。
 */

import { WEAPONS, clamp, type WeaponSpec } from '@dk/shared'
import {
  AMBIENCE_MIX,
  OCCLUDED_CUTOFF_HZ,
  OCCLUDED_GAIN,
  OCCLUDED_WET_BONUS,
  PRIORITY,
  REF_DISTANCE_M,
  SELF_RADIUS_M,
  SURFACES,
  VoiceBus,
  airDelay,
  attenuationCutoff,
  attenuationGain,
  buildLoopNoise,
  buildReverbImpulse,
  click,
  guessSurface,
  hashPoint,
  jitter,
  newRecipe,
  planarDistance,
  reverbWet,
  safeDistance,
  shake,
  tone,
  type AmbienceBias,
  type FootstepSurface,
  type MixVoice,
  type MonsterKind,
  type Recipe,
  type WorldPoint,
} from './audio-mix.ts'

const DEFAULT_VOLUME = 0.8

/**
 * 风的基准电平。旧版 0.045 实测 RMS 只有 0.0034 —— 夜里戴着耳机基本听不出
 * "有环境"这回事。0.075 在压缩器前仍然远低于 1.0，不会挤占枪声。
 */
const WIND_LEVEL = 0.075
const CRICKET_LEVEL = 0.05
const CRITTER_LEVEL = 0.075
const BELL_LEVEL = 0.05

/** 低于这个血量比例开始心跳。 */
const HEARTBEAT_LOW = 0.4

/** 空气低通只在截止低于它时才真的挂节点：贴脸声不需要多一层滤波。 */
const AIR_CUTOFF_SKIP_HZ = 15000

/**
 * 双耳定位只在这个距离内用。HRTF 是一次卷积 per voice，24 路叠起来能把一帧吃掉
 * 好几个毫秒；而 25m 外的声音本来就被空气滤掉了细节，equalpower 足够分左右。
 */
const HRTF_MAX_M = 25

/** 环境声重建的重试预算：20 × 600ms ≈ 12s，之后靠 unlock()/onstatechange 补。 */
const AMBIENCE_RETRIES = 20
const AMBIENCE_RETRY_MS = 600

function shotWeight(weaponId: number): number {
  // 协议里 weaponId 是裸数字，运行时完全可能收到未知 id，别指望索引签名兜底。
  const spec: WeaponSpec | undefined = WEAPONS[weaponId]
  if (spec === undefined) return 0.45 // 未知武器给中间值：宁可保守，也不要静音
  const power = clamp((spec.damage * spec.pellets - 50) / 90, 0, 1)
  const cadence = clamp((spec.fireIntervalMs - 150) / 800, 0, 1)
  return clamp(power * 0.75 + cadence * 0.25, 0, 1)
}

/**
 * 刀砍中的材质表。
 *
 * 四档材质的区别**全在带通中心与余响**上，不在音量上：肉的 300Hz 是"闷进去"，
 * 金属的 3200Hz + 两个不成整数比的分音是"撞在铁上"。thump 是手臂推进去的那点
 * 体重（低频正弦），没有它刀会显得没有质量。
 */
interface KnifeMaterial {
  /** 撞击噪声的带通中心与 Q。 */
  band: number
  q: number
  /** 噪声体长度与峰值。 */
  dur: number
  peak: number
  hp: number
  lp: number
  /** 低频"进去"的起止频率与电平。 */
  thumpFrom: number
  thumpTo: number
  thumpPeak: number
  /** 余响：0 表示没有（肉和木头不会唱）。 */
  ring: number
  ringFreq: number
  ringDur: number
  /** 只有肉才有的"吸"：刀拔出来时组织回弹的一点湿声。 */
  suck: number
}

const KNIFE_MATERIALS: Record<'flesh' | 'wood' | 'stone' | 'metal', KnifeMaterial> = {
  // 肉：低通压到 900，带通只有 300 —— 一点金属味都不该有，只有"进去了"。
  flesh: { band: 300, q: 1.1, dur: 0.13, peak: 0.42, hp: 60, lp: 900, thumpFrom: 96, thumpTo: 50, thumpPeak: 0.3, ring: 0, ringFreq: 0, ringDur: 0, suck: 1 },
  // 木头：钝。640Hz 的空腔 + 150 → 82Hz，像砍进一根干透的木头。
  wood: { band: 640, q: 2, dur: 0.1, peak: 0.4, hp: 140, lp: 2600, thumpFrom: 150, thumpTo: 82, thumpPeak: 0.24, ring: 0, ringFreq: 0, ringDur: 0, suck: 0 },
  // 石头：脆。高带通 + 只有 50ms 的 4200Hz 擦响，没有余响 —— 石头不会唱。
  stone: { band: 2600, q: 2.6, dur: 0.07, peak: 0.36, hp: 700, lp: 12000, thumpFrom: 190, thumpTo: 96, thumpPeak: 0.12, ring: 0.16, ringFreq: 4200, ringDur: 0.05, suck: 0 },
  // 金属：亮。Q=6 的 3200Hz + 3050/4390 两个不成整数比的分音 —— 和钟声同一套
  // 道理：整数比听起来像按键音，不成整数比才"金属"。
  metal: { band: 3200, q: 6, dur: 0.09, peak: 0.34, hp: 900, lp: 15000, thumpFrom: 210, thumpTo: 110, thumpPeak: 0.14, ring: 0.3, ringFreq: 3050, ringDur: 0.3, suck: 0 },
}

/** open() 的参数。at 与 distance 二选一：有坐标就用真实几何，没有就用协议给的距离。 */
interface OpenOptions {
  /** 世界坐标。给了就挂 HRTF PannerNode。 */
  at?: WorldPoint
  /** 没有坐标时的距离（远端枪声只带一个 distance 数字）。 */
  distance?: number
  /** 混响送出量 0..1。室内/钟声给大，贴脸的小动作给 0。 */
  wet?: number
  /** 覆盖默认出口（环境声要过区域 muffle 总线）。 */
  dest?: AudioNode
  /** 覆盖优先级；默认按距离推。 */
  priority?: number
  /** 供抢声用的电平线索：越响的越不容易被抢。 */
  level?: number
  /** 射线被墙挡住：音量砍到 OCCLUDED_GAIN，同时把低通压到 900Hz。 */
  occluded?: boolean
}

interface Opened {
  ctx: AudioContext
  voice: MixVoice
  /** 配方里所有音源都接到这里，由它统一做空气低通 → 定位 → 衰减。 */
  input: GainNode
  distance: number
  recipe: Recipe
}

/** 常驻的环境声机架。dispose() 必须一个不漏地拆掉。 */
interface AmbienceRig {
  /** 环境总出口：切区域/拆除时整体淡出。 */
  out: GainNode
  /** 区域低通——"在室内"靠它，而不是靠变小声。 */
  muffle: BiquadFilterNode
  windGain: GainNode
  cricketGain: GainNode
  critterGain: GainNode
  bellGain: GainNode
  nodes: AudioNode[]
  sources: AudioScheduledSourceNode[]
}

export class AudioKit {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  /** 干路：所有瞬态音源的默认出口。 */
  private dry: GainNode | null = null
  /** 混响送出/返回（共享一条 ConvolverNode）。 */
  private reverbSend: GainNode | null = null
  private reverbReturn: GainNode | null = null
  private convolver: ConvolverNode | null = null
  private bus: VoiceBus | null = null

  private noise: AudioBuffer | null = null
  private wind: AudioBuffer | null = null

  private volume = DEFAULT_VOLUME
  private disposed = false

  private listenerPos: WorldPoint = { x: 0, y: 1.6, z: 0 }
  private listenerForward: WorldPoint = { x: 0, y: 0, z: -1 }

  private ambience: AmbienceRig | null = null
  private ambienceWanted = false
  private ambienceRetries = 0
  private retryTimer: number | null = null
  private cricketTimer: number | null = null
  private critterTimer: number | null = null
  private bellTimer: number | null = null
  private bias: AmbienceBias = 'marsh'

  private health = { value: 150, max: 150 }
  private heartTimer: number | null = null

  /** 当前挂着的 PannerNode 数量：调试/验证用，也顺手当泄漏探针。 */
  private panners = 0

  /** 最近一次 open() 算出的空间参数，只给探针读（听感无法自动化，只能看数值）。 */
  private lastSpatial: {
    distance: number
    gain: number
    cutoff: number
    wet: number
    occluded: boolean
    panning: string
  } = { distance: 0, gain: 1, cutoff: 0, wet: 0, occluded: false, panning: 'none' }
  /** 因为池满被丢掉的声音数（验证抢声策略用）。 */
  private dropped = 0

  constructor() {
    // 故意什么都不做。AudioContext 必须在真实用户手势里创建（见 unlock）：
    // 在构造函数里 new 出来，Chrome 会给你一个永远 suspended 的上下文，之后
    // 每一次发声都是静默的，而且**不报任何错** —— 排查起来极其恶心。
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 浏览器要求音频上下文必须在真实用户手势（click / keydown）里创建或恢复。
   * 幂等：可以每次点击都调用。
   */
  async unlock(): Promise<void> {
    if (this.disposed) return
    let ctx = this.ctx
    // 上下文被 close 掉（外部 dispose、浏览器回收）之后旧图已经死了，必须重建。
    // 旧代码在这里直接 return，于是整局游戏再也发不出任何声音。
    if (ctx === null || ctx.state === 'closed') ctx = this.create()
    if (ctx === null) return
    if (ctx.state !== 'running') {
      // resume() 在"没有用户手势"时会返回一个永远 pending 的 promise —— 它既不
      // 成功也不失败，就那样挂着。无脑 await 会把调用方的整条启动链挂死：主界面
      // 那层黑色转场幕会一直停在 opacity 1（表现为"进了游戏但画面全黑"）。
      // 所以只等一个很短的窗口，剩下的交给重试/onstatechange。
      await Promise.race([
        ctx.resume().catch(() => undefined),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 250)
        }),
      ])
    }
    // 不管等到没等到都试一次：startAmbienceNow 内部有 ready 守卫 + 重试。
    if (this.ambienceWanted) this.startAmbienceNow()
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running'
  }

  setVolume(v: number): void {
    this.volume = clamp(Number.isFinite(v) ? v : DEFAULT_VOLUME, 0, 1)
    const ctx = this.ctx
    const master = this.master
    if (ctx === null || master === null) return
    // 不要直接赋 .value：拖音量条时逐帧跳变会拉出"拉拉链"的噪声。
    master.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.02)
  }

  private create(): AudioContext | null {
    let ctx: AudioContext
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' })
    } catch {
      // 被策略禁掉/不支持的浏览器：整套音频降级为静音，游戏照常能玩。
      return null
    }

    // 只当"过载保险"，不当混音工具。早先 -16dB/6:1 会把远处枪声抬回近处
    // 的电平 —— 距离衰减被压缩器抵消，听起来就像全世界都贴着你开枪。
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -6
    compressor.knee.value = 12
    compressor.ratio.value = 2.5
    compressor.attack.value = 0.004
    compressor.release.value = 0.25
    compressor.connect(ctx.destination)

    const master = ctx.createGain()
    // 关键：用**已经存下来的音量**初始化，而不是 0。旧代码靠 setVolume 事后覆盖，
    // 调用顺序一反就是永久静音。
    master.gain.value = this.volume
    master.connect(compressor)

    const dry = ctx.createGain()
    dry.gain.value = 1
    dry.connect(master)

    // 共享混响：一条 IR 给所有需要"空间"的声音用。per-voice IR 会瞬间吃光 CPU。
    const convolver = ctx.createConvolver()
    convolver.buffer = buildReverbImpulse(ctx)
    const reverbSend = ctx.createGain()
    reverbSend.gain.value = 1
    const reverbReturn = ctx.createGain()
    reverbReturn.gain.value = 0.5
    reverbSend.connect(convolver)
    convolver.connect(reverbReturn)
    reverbReturn.connect(master)

    this.ctx = ctx
    this.master = master
    this.compressor = compressor
    this.dry = dry
    this.convolver = convolver
    this.reverbSend = reverbSend
    this.reverbReturn = reverbReturn
    this.bus = new VoiceBus(ctx)
    // 白噪声首尾交叉淡化：脚步/枪声按随机偏移借一段，偶尔会跨过首尾接缝。
    this.noise = buildLoopNoise(ctx, 2, 0.2)
    // 风用布朗噪声（-6dB/oct，比白噪声更像空气），6s + 0.6s 交叉淡化保证无缝。
    this.wind = buildLoopNoise(ctx, 6, 0.6, 0.55, true)

    // 自愈：被浏览器挂起后自动恢复；被外部 close 后清掉引用，等下一次 unlock 重建。
    ctx.onstatechange = (): void => {
      if (this.ctx !== ctx) return
      if (this.disposed) return
      if (ctx.state === 'running') {
        if (this.ambienceWanted) this.startAmbienceNow()
        return
      }
      if (ctx.state === 'closed') this.teardownRefs()
    }

    this.applyListener(ctx)
    return ctx
  }

  /** 拆掉指向这个上下文的引用（上下文本身已经死了，不再 close）。 */
  private teardownRefs(): void {
    this.stopAmbience(0.01)
    this.bus?.hushAll(0.01)
    this.bus = null
    this.ctx = null
    this.master = null
    this.compressor = null
    this.dry = null
    this.convolver = null
    this.reverbSend = null
    this.reverbReturn = null
    this.noise = null
    this.wind = null
    this.panners = 0
  }

  /** 只返回"现在真的能发声"的上下文；顺手把挂起的唤醒一次。 */
  private live(): { ctx: AudioContext; master: GainNode; dry: GainNode } | null {
    if (this.disposed) return null
    const ctx = this.ctx
    const master = this.master
    const dry = this.dry
    if (ctx === null || master === null || dry === null) return null
    if (ctx.state === 'closed') return null
    if (ctx.state !== 'running') {
      // 挂起时排进去的音源不会响，只会在恢复的瞬间一起炸出来 —— 宁可丢掉这一声。
      void ctx.resume().catch(() => undefined)
      return null
    }
    return { ctx, master, dry }
  }

  // ---------------------------------------------------------------- 空间

  /**
   * 每帧由调用方喂相机位置与朝向。
   *
   * 用 setTargetAtTime 而不是直接赋 .value：200fps 下逐帧跳变会让 HRTF 的声像
   * "拉链"式抖动。20ms 的时间常数既跟得上转身，也听不出台阶。
   */
  setListener(pos: WorldPoint, forward: WorldPoint): void {
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z }
    const len = Math.hypot(forward.x, forward.y, forward.z)
    this.listenerForward =
      Number.isFinite(len) && len > 1e-4
        ? { x: forward.x / len, y: forward.y / len, z: forward.z / len }
        : { x: 0, y: 0, z: -1 }
    const ctx = this.ctx
    if (ctx === null || this.disposed) return
    this.applyListener(ctx)
  }

  private applyListener(ctx: AudioContext): void {
    const l = ctx.listener
    const now = ctx.currentTime
    const pos = this.listenerPos
    const fwd = this.listenerForward
    const smooth = (param: AudioParam | undefined, value: number): void => {
      if (param === undefined || !Number.isFinite(value)) return
      param.setTargetAtTime(value, now, 0.02)
    }
    // positionX 这些 AudioParam 只有新浏览器有；老实现只有 setPosition/setOrientation。
    if (l.positionX !== undefined) {
      smooth(l.positionX, pos.x)
      smooth(l.positionY, pos.y)
      smooth(l.positionZ, pos.z)
      smooth(l.forwardX, fwd.x)
      smooth(l.forwardY, fwd.y)
      smooth(l.forwardZ, fwd.z)
      smooth(l.upX, 0)
      smooth(l.upY, 1)
      smooth(l.upZ, 0)
      return
    }
    l.setPosition(pos.x, pos.y, pos.z)
    l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0)
  }

  /** 按距离推优先级：贴脸（自己）> 18m 内 > 更远。 */
  private priorityFor(distance: number): number {
    if (distance <= SELF_RADIUS_M) return PRIORITY.self
    if (distance < 18) return PRIORITY.near
    return PRIORITY.far
  }

  /**
   * 所有声音的唯一入口：申请一路 → 空气低通 → 定位 → 混响送出。
   *
   * 配方只管往 o.input 上接音源，节点/音源登记在 recipe 里，最后由 seal() 交给
   * VoiceBus 托管回收 —— 这样"每个声音自己记得 disconnect"就不再是纪律问题。
   */
  private open(opts: OpenOptions = {}): Opened | null {
    const live = this.live()
    const bus = this.bus
    if (live === null || bus === null) return null
    const ctx = live.ctx
    const at = opts.at
    const distance = at === undefined ? safeDistance(opts.distance ?? 0) : planarDistance(this.listenerPos, at)
    const priority = opts.priority ?? this.priorityFor(distance)
    const voice = bus.begin(priority, opts.level ?? 0.4, opts.dest ?? live.dry)
    if (voice === null) {
      this.dropped += 1
      return null
    }

    const recipe = newRecipe()
    const input = ctx.createGain()
    input.gain.value = 1
    recipe.nodes.push(input)
    let tail: AudioNode = input

    // 空气吸收挂在 Panner 之前：PannerNode 只改音量，不会把远处的声音变闷。
    // 被墙挡住时在距离曲线之上再压一道：隔墙的枪声不是"变小"，而是"变闷"。
    const occluded = opts.occluded === true
    const cutoff = occluded
      ? Math.min(attenuationCutoff(distance), OCCLUDED_CUTOFF_HZ)
      : attenuationCutoff(distance)
    if (cutoff < AIR_CUTOFF_SKIP_HZ) {
      const air = ctx.createBiquadFilter()
      air.type = 'lowpass'
      air.frequency.value = cutoff
      air.Q.value = 0.7
      tail.connect(air)
      tail = air
      recipe.nodes.push(air)
    }

    // 衰减**永远**由这里算。旧代码在有坐标时把衰减交给 PannerNode 的 inverse 模型
    // （rolloff 1），40m 的枪声因此掉到 1/7 —— 有没有坐标两条路音量对不上，
    // 正是"听不出远近"的根因。现在 Panner 只负责方位，rolloff 归零。
    if (distance > SELF_RADIUS_M) {
      const gain = ctx.createGain()
      gain.gain.value = attenuationGain(distance) * (occluded ? OCCLUDED_GAIN : 1)
      tail.connect(gain)
      tail = gain
      recipe.nodes.push(gain)
    }

    if (at !== undefined && distance > SELF_RADIUS_M) {
      // 25m 内用 HRTF：双耳滤波带来的前后/左右差，才是"闭着眼能转头找到那只怪"
      // 的关键。再远就没有细节可分辨了，换 equalpower 省掉每路一次卷积。
      const panner = ctx.createPanner()
      panner.panningModel = distance < HRTF_MAX_M ? 'HRTF' : 'equalpower'
      panner.distanceModel = 'inverse'
      panner.refDistance = REF_DISTANCE_M
      panner.rolloffFactor = 0
      panner.maxDistance = 400
      panner.positionX.value = at.x
      panner.positionY.value = at.y
      panner.positionZ.value = at.z
      tail.connect(panner)
      tail = panner
      recipe.nodes.push(panner)
      this.panners += 1
      const previous = voice.onRelease
      voice.onRelease = (): void => {
        this.panners -= 1
        previous?.()
      }
      // 声速延迟：低于 12ms 的贴脸声等这一下反而"软"，跳过更自然。
      const delay = airDelay(distance)
      if (delay > 0.012) {
        const air2 = ctx.createDelay(0.6)
        air2.delayTime.value = delay
        tail.connect(air2)
        tail = air2
        recipe.nodes.push(air2)
      }
    }

    tail.connect(voice.out)

    // 越远越湿：空气散射把直达声吃掉，远处的声音总带着所在空间的味道。
    const wet = opts.wet ?? reverbWet(distance) + (occluded ? OCCLUDED_WET_BONUS : 0)
    this.lastSpatial = {
      distance,
      gain: distance > SELF_RADIUS_M ? attenuationGain(distance) * (occluded ? OCCLUDED_GAIN : 1) : 1,
      cutoff,
      wet,
      occluded,
      panning: at !== undefined && distance > SELF_RADIUS_M ? (distance < HRTF_MAX_M ? 'hrtf' : 'equalpower') : 'none',
    }
    const reverbSend = this.reverbSend
    if (wet > 0.001 && reverbSend !== null) {
      const send = ctx.createGain()
      send.gain.value = wet
      voice.out.connect(send)
      send.connect(reverbSend)
      recipe.nodes.push(send)
    }

    return { ctx, voice, input, distance, recipe }
  }

  /** 配方搭完之后调一次：把节点交给池子托管，播完自动 disconnect。 */
  private seal(o: Opened): void {
    this.bus?.seal(o.voice, o.recipe)
  }

  // ---------------------------------------------------------------- 开火

  /** @param distance 监听者到开枪者的世界距离（米）。 */
  shot(weaponId: number, distance: number, loudness = 1): void {
    this.fire(weaponId, { distance: safeDistance(distance) }, clamp(loudness, 0, 2))
  }

  /**
   * @param loudness 0..1 的额外音量系数（室内开枪、消音器）。
   * @param occluded 监听者到枪口之间挡了墙：音量砍到 18% 且只剩闷响。
   */
  shotAt(weaponId: number, at: WorldPoint, loudness = 1, occluded = false): void {
    this.fire(weaponId, { at, occluded }, clamp(loudness, 0, 2))
  }

  private fire(weaponId: number, opts: OpenOptions, loudness: number): void {
    const noise = this.noise
    const weight = shotWeight(weaponId)
    // 不写死 wet：远处枪声该有更多空间尾巴，交给 open() 按距离算。
    const o = this.open({ ...opts, level: 0.9 * loudness })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002 // 一点点提前量，保证所有 ramp 都有起点
    const rate = 0.9 + Math.random() * 0.2

    // --- 1. 噪声爆裂：枪声的"体"。霰弹枪更暗、更宽、更长（截止 9000 → 3800）。
    const burst = 0.1 + weight * 0.26
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: (0.9 + weight * 0.6) * loudness,
      attack: 0.004,
      dur: burst,
      type: 'lowpass',
      freq: 9000 - weight * 5200,
      q: 0.7 + weight * 1.3,
      rate,
    })

    // --- 2. 炮身：低频正弦快速下坠，这一下是"后坐力"的听觉版本（150 → 38Hz）。
    const bodyTail = 0.1 + weight * 0.15
    tone(ctx, recipe, input, {
      type: 'sine',
      from: 150 - weight * 60,
      to: 38,
      at: t,
      peak: (0.35 + weight * 0.55) * loudness,
      attack: 0.006,
      dur: bodyTail,
    })

    // --- 3. 爆音瞬态：枪口那一"啪"。越重越少 —— 霰弹枪是一声闷炸，不是脆响。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: (0.55 - weight * 0.25) * loudness,
      attack: 0.0015,
      dur: 0.034,
      type: 'highpass',
      freq: 3200 - weight * 1000,
      rate: rate * 1.4,
    })

    this.seal(o)
  }

  /**
   * 空仓的"咔—嗒"：极短、窄带，但补一记低频让"枪机空撞"有实体。
   *
   * 单声高频 click 在夜图里很容易被当成环境音；加一声下坠的 120→70Hz
   * 才能读成"扳机扣到底、击锤打空"。
   */
  dryFire(weaponId = 0): void {
    const noise = this.noise
    const weight = shotWeight(weaponId)
    const o = this.open({ priority: PRIORITY.self, level: 0.42, wet: 0.02 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    click(ctx, recipe, input, noise, t, 2600 - weight * 500, 0.34, 0.045)
    click(ctx, recipe, input, noise, t + 0.035, 1700 - weight * 300, 0.2, 0.05)
    tone(ctx, recipe, input, {
      type: 'sine',
      from: 120 - weight * 40,
      to: 70,
      at: t,
      peak: 0.1 + weight * 0.08,
      attack: 0.004,
      dur: 0.09,
    })
    this.seal(o)
  }

  /** 最后一发打空：枪机/弹仓空仓的机构声，和"扣空扳机"分开。 */
  magEmpty(weaponId = 0): void {
    const noise = this.noise
    const weight = shotWeight(weaponId)
    const o = this.open({ priority: PRIORITY.self, level: 0.5, wet: 0.03 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    // 稍微晚于枪声，才不会被枪口噪声完全盖住。
    const t = ctx.currentTime + 0.055
    click(ctx, recipe, input, noise, t, 2200 - weight * 400, 0.3, 0.045)
    click(ctx, recipe, input, noise, t + 0.06, 1450 - weight * 300, 0.22, 0.06)
    tone(ctx, recipe, input, {
      type: 'sine',
      from: 130 - weight * 40,
      to: 58,
      at: t,
      peak: 0.12 + weight * 0.1,
      attack: 0.004,
      dur: 0.13,
    })
    this.seal(o)
  }

  /**
   * 左轮转轮棘轮：一串不匀的金属"嗒"，带一条低通吱呀。
   *
   * 转轮不是电机，每格之间有小回弹；所以 click 的间隔/频率都做 ±10% 抖动，
   * 再叠一条低频带通噪声当"转轴干涩的吱呀"。短版用于每发吐轮，长版用于换弹。
   */
  cylinderRatchet(long = false): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: long ? 0.44 : 0.32, wet: 0.02 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + (long ? 0.05 : 0.075)
    const count = long ? 6 : 2
    for (let i = 0; i < count; i++) {
      const k = i / Math.max(1, count - 1)
      const at = t + i * (long ? 0.055 : 0.045) * (0.9 + jitter(0.2))
      click(ctx, recipe, input, noise, at, 1800 + k * 900 + jitter(120), long ? 0.18 : 0.14, 0.03)
    }
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: long ? 0.12 : 0.06,
      attack: 0.02,
      dur: long ? 0.46 : 0.12,
      type: 'bandpass',
      freq: 680,
      sweepTo: 1500,
      q: 1.2,
      hp: 220,
      lp: 3200,
      rate: 0.7,
    })
    this.seal(o)
  }

  /** 收刀花式：两段反向掠过空气的风声 + 一记很轻的刃鸣。 */
  knifeFlourish(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.36, wet: 0.03 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.06
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: 0.17,
      attack: 0.03,
      dur: 0.28,
      type: 'bandpass',
      freq: 620,
      sweepTo: 2600,
      q: 0.9,
      hp: 260,
      rate: 1.1,
    })
    shake(ctx, recipe, input, {
      noise,
      at: t + 0.22,
      peak: 0.12,
      attack: 0.025,
      dur: 0.24,
      type: 'bandpass',
      freq: 2400,
      sweepTo: 760,
      q: 1.1,
      hp: 700,
      rate: 1,
    })
    tone(ctx, recipe, input, {
      type: 'triangle',
      from: 1800,
      to: 2400,
      at: t + 0.24,
      peak: 0.055,
      attack: 0.01,
      dur: 0.2,
    })
    this.seal(o)
  }

  // ---------------------------------------------------------------- 界面音

  /**
   * 主界面的悬停声。
   *
   * 主界面是玩家停留最久的地方：一列导航、四张地图卡、五张枪卡、十来行设置，
   * 鼠标随便挪一下就要撞上三四个。所以这条必须**轻到只确认"能点"**：电平
   * 0.16、22ms 的高频摩擦，比空仓的"咔"（0.3）还低一档半。再重一点，第二次
   * 打开菜单时它就是噪音了。
   *
   * 也不要湿声：干声才像"界面"，混响一加就变成"世界里的某个东西在响"。
   */
  uiHover(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.16, wet: 0.02 })
    if (o === null) return
    if (noise !== null) click(o.ctx, o.recipe, o.input, noise, o.ctx.currentTime + 0.002, 4200, 0.12, 0.022)
    this.seal(o)
  }

  /**
   * 界面点击：两声错开的机构声。
   *
   * 为什么不是一声：单声"嗒"跟悬停音只差音量，玩家分不清"碰到"和"按下了"。
   * 第二声低 650Hz、晚 45ms，听起来是"扣到位"，也顺手给界面的猎杀气质定调
   * ——这里用的是击锤与卡榫的语汇，不是网页的"哔"。
   */
  uiClick(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.36, wet: 0.03 })
    if (o === null) return
    if (noise !== null) {
      const { ctx, recipe, input } = o
      const t = ctx.currentTime + 0.002
      click(ctx, recipe, input, noise, t, 2400, 0.2, 0.03)
      click(ctx, recipe, input, noise, t + 0.045, 1750, 0.14, 0.04)
    }
    this.seal(o)
  }

  /**
   * 出击：击锤落下 + 一记低频、一层远去的嘶声。
   *
   * 这个音必须比转场长（约 1.1s），它是**唯一**把"点了按钮"和"画面已经切走"
   * 连起来的东西：转场是 620ms 的淡出，声音拖过它，玩家才觉得是"被推进去"
   * 而不是"页面换了"。
   */
  uiLaunch(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.62, wet: 0.12 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    // 低频"落地"先给：60→38Hz 的扫频，几乎听不见音高，只有胸腔感。
    tone(ctx, recipe, input, { type: 'sine', from: 62, to: 38, at: t, peak: 0.5, attack: 0.006, dur: 0.9 })
    if (noise !== null) {
      click(ctx, recipe, input, noise, t, 900, 0.4, 0.08)
      shake(ctx, recipe, input, { noise, at: t + 0.01, peak: 0.42, attack: 0.004, dur: 0.85, type: 'lowpass', freq: 320, rate: 0.35 })
    }
    this.seal(o)
  }

  // ---------------------------------------------------------------- 换弹 / 机构

  /** 开弹仓：一声金属轻响 + 一记更闷的"松扣"。远端传 at 走 Panner。 */
  reloadStart(weaponId: number, at?: WorldPoint): void {
    const noise = this.noise
    const opts: OpenOptions = { level: 0.5, wet: at ? 0.01 : 0.03 }
    if (at) opts.at = at
    else opts.priority = PRIORITY.self
    const o = this.open(opts)
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    const weight = shotWeight(weaponId)
    click(ctx, recipe, input, noise, t, 1800 - weight * 500, 0.22, 0.05)
    // 弹匣滑出的摩擦：低通 700 的噪声，起音很软
    shake(ctx, recipe, input, { noise, at: t + 0.05, peak: 0.16 + weight * 0.1, attack: 0.012, dur: 0.14, type: 'lowpass', freq: 700, rate: 0.6 })
    // 左轮换弹：弹仓甩出后逐格上弹，六声棘轮 + 一条转轴的干涩摩擦。
    if (WEAPONS[weaponId]?.kind === 'revolver') {
      for (let i = 0; i < 6; i++) {
        click(ctx, recipe, input, noise, t + 0.12 + i * 0.075 * (0.92 + jitter(0.16)), 1900 + i * 130 + jitter(120), 0.14, 0.03)
      }
      shake(ctx, recipe, input, {
        noise,
        at: t + 0.1,
        peak: 0.1,
        attack: 0.02,
        dur: 0.5,
        type: 'bandpass',
        freq: 650,
        sweepTo: 1400,
        q: 1.1,
        hp: 220,
        lp: 3000,
        rate: 0.7,
      })
    }
    this.seal(o)
  }

  /** 上膛：两声紧挨着的金属撞击，第二声略高，才像"扣合"而不是"敲了一下"。 */
  reloadEnd(at?: WorldPoint): void {
    const noise = this.noise
    const opts: OpenOptions = { level: 0.5, wet: at ? 0.01 : 0.03 }
    if (at) opts.at = at
    else opts.priority = PRIORITY.self
    const o = this.open(opts)
    if (o === null) return
    if (noise !== null) {
      const t = o.ctx.currentTime + 0.002
      click(o.ctx, o.recipe, o.input, noise, t, 2200, 0.26, 0.045)
      click(o.ctx, o.recipe, o.input, noise, t + 0.075, 3100, 0.2, 0.035)
    }
    this.seal(o)
  }

  /**
   * 切枪：两声机构脱扣 + 弹簧归位 + 枪身落到手上。
   *
   * 玩家反馈"换枪没声音"，根因是这一条被三处细节一起压没了（旧代码）：
   * 1. **电平**：两声 click 只有 0.2 / 0.12，click 里的三角波那层再乘 0.35 →
   *    0.07；弹簧 0.1。而一步脚步的噪声峰值是 0.34、一发枪是 1.5。也就是说
   *    切枪比玩家自己的脚步还轻一档，离枪声差着 25dB —— 在夜图的风声
   *    （WIND_LEVEL 0.075）里它落在"好像有动静"的灰区。
   * 2. **时长**：每声 30~40ms 的指数衰减，60ms 之后整件事就结束了，耳朵来不及
   *    把它当成"一个动作"，只当成一声若有若无的 tick。
   * 3. **频段与重量**：两个 Q=7 的窄带都挤在 1.9~3kHz，而且第一声的中心频率
   *    随重量**往上**走（1900 + weight*400）—— 重枪反而更尖，跨度只有 400Hz。
   *    枪与枪之间听上去是同一把：转轮手枪（weight 0.13）和狙击枪（0.71）
   *    在 Q=7 的窄带里只差 10% 的带宽。
   *
   * 现在：整体抬到 level 0.62 / 峰值 0.24~0.5，两个机件按重量拉开间隔，重枪
   * 低、闷、慢（多一层 150Hz 的"沉"），轻枪脆、快、亮。
   */
  weaponSwitch(weaponId = 0): void {
    const noise = this.noise
    const weight = shotWeight(weaponId)
    const o = this.open({ priority: PRIORITY.self, level: 0.62, wet: 0.04 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    // 重量决定三件事：机件间隔（慢）、中心频率（低）、低频身体的量（沉）。
    const slow = 0.72 + weight * 0.86
    const pitch = 1 + jitter(0.02)
    const detent = (2700 - weight * 1300) * pitch

    // 1. 脱扣：枪机/弹仓解锁的第一声。Q=7 的窄带 + 三角波 = 金属片，不是鼓。
    click(ctx, recipe, input, noise, t, detent, 0.36, 0.05 + weight * 0.02)

    // 2. 扣合：比第一声高一个纯五度左右，间隔随重量拉长 —— 耳朵才数得出"两下"。
    click(ctx, recipe, input, noise, t + 0.085 * slow, detent * 1.55, 0.26, 0.042)

    // 3. 弹簧归位：轻枪短促、重枪长而下坠；低通跟着重量收紧就是"闷"。
    const springFrom = (360 - weight * 150) * pitch
    tone(ctx, recipe, input, {
      type: 'triangle',
      from: springFrom,
      to: springFrom * (0.52 - weight * 0.14),
      at: t + 0.02 * slow,
      peak: 0.16 + weight * 0.07,
      attack: 0.005,
      dur: 0.11 + weight * 0.16,
      lp: 3400 - weight * 1900,
    })

    // 4. 重量：枪身落进手里的低频。转轮手枪几乎不该有，狙击枪必须有。
    tone(ctx, recipe, input, {
      type: 'sine',
      from: 150 - weight * 55,
      to: 58,
      at: t + 0.035 * slow,
      peak: 0.08 + weight * 0.26,
      attack: 0.006,
      dur: 0.12 + weight * 0.12,
    })

    // 5. 背带/衣料摩擦：给整声一条"动作有多长"的尾巴 —— 纯金属咔哒像在敲铁片。
    shake(ctx, recipe, input, {
      noise,
      at: t + 0.012 * slow,
      peak: 0.1 + weight * 0.06,
      attack: 0.022,
      dur: 0.16 * slow,
      type: 'bandpass',
      freq: 820 - weight * 260,
      q: 1.1,
      hp: 320,
      rate: 1 + jitter(0.12),
    })
    this.seal(o)
  }

  /**
   * 抛壳：一声很轻的高频金属碰响。
   *
   * 它必须比枪声晚：枪声是"我开火了"，这一声是"壳飞出去落地了"。
   * 电平压得很低（0.18），否则连射时它会变成一串敲铁皮的噪音。
   */
  shellEject(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.18, wet: 0.04 })
    if (o === null) return
    if (noise !== null) {
      const { ctx, recipe, input } = o
      const t = ctx.currentTime + 0.18
      click(ctx, recipe, input, noise, t, 5200, 0.1, 0.02)
      click(ctx, recipe, input, noise, t + 0.035, 3700, 0.06, 0.03)
    }
    this.seal(o)
  }

  /** 刀出鞘：刀身擦鞘（带通 1800 → 5200 上扫）+ 扣到位的一声。 */
  knifeDraw(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.4, wet: 0.04 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    shake(ctx, recipe, input, { noise, at: t, peak: 0.16, attack: 0.02, dur: 0.22, type: 'bandpass', freq: 1800, sweepTo: 5200, q: 3, hp: 900 })
    click(ctx, recipe, input, noise, t + 0.2, 3400, 0.12, 0.03)
    this.seal(o)
  }

  /**
   * 挥空：宽 Q 的带通从 320 扫到 1700，慢起音 —— 这是"风"而不是"撞击"。
   *
   * 和 knifeImpact 的分工是刻意的，两条曲线必须相反：挥空**没有**低频（高通
   * 180Hz）、起音 35ms（慢）、频段低；砍中是 1.5ms 的硬起音、带 100Hz 的体重、
   * 频段跟着材质走。听觉上这两者要一秒就能分开，否则玩家不知道刀碰没碰到人。
   */
  knifeSwing(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.4, wet: 0.05 })
    if (o === null) return
    if (noise !== null) {
      shake(o.ctx, o.recipe, o.input, {
        noise,
        at: o.ctx.currentTime + 0.002,
        peak: 0.22,
        attack: 0.035,
        dur: 0.24,
        type: 'bandpass',
        freq: 320,
        sweepTo: 1700,
        q: 0.8,
        hp: 180,
        rate: 1.2,
      })
      // 刃尖切过空气的细声：只出现在后半程。缺了它挥刀像在拍棉被（只有"呼"）。
      shake(o.ctx, o.recipe, o.input, {
        noise,
        at: o.ctx.currentTime + 0.05,
        peak: 0.09,
        attack: 0.02,
        dur: 0.18,
        type: 'bandpass',
        freq: 2400,
        sweepTo: 4200,
        q: 1.6,
        hp: 1600,
        rate: 1.15,
      })
    }
    this.seal(o)
  }

  /** 重刀：比轻刀更低、更长、更重的一刀；后半程多一条刃尖切风的亮线。 */
  knifeHeavySwing(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.55, wet: 0.06 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    // 1. 手臂抡起来的风：比轻刀更慢的起音和更低的中心。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: 0.26,
      attack: 0.05,
      dur: 0.4,
      type: 'bandpass',
      freq: 220,
      sweepTo: 1400,
      q: 0.75,
      hp: 120,
      rate: 1,
    })
    // 2. 刃尖切过空气：迟 70ms，频率更高。
    shake(ctx, recipe, input, {
      noise,
      at: t + 0.07,
      peak: 0.13,
      attack: 0.02,
      dur: 0.26,
      type: 'bandpass',
      freq: 1900,
      sweepTo: 4800,
      q: 1.5,
      hp: 1200,
      rate: 1.1,
    })
    // 3. 体重：抡刀时胸腔里的低频，轻刀没有这一层。
    tone(ctx, recipe, input, {
      type: 'sine',
      from: 118,
      to: 52,
      at: t,
      peak: 0.2,
      attack: 0.01,
      dur: 0.18,
    })
    // 4. 收势的一点刃鸣，给这一刀一个"甩出去"的尾巴。
    tone(ctx, recipe, input, {
      type: 'triangle',
      from: 1600,
      to: 1250,
      at: t + 0.2,
      peak: 0.06,
      attack: 0.01,
      dur: 0.22,
    })
    this.seal(o)
  }

  /**
   * 刀砍到东西。
   *
   * 四档材质共用三层结构：硬起音的撞击噪声（材质）、低频体重（手臂推进去的
   * 那一下）、以及各自的余响。**肉是最闷的一档**（低通 900、没有余响、多一层
   * 0.9kHz 的湿声），金属是最亮的一档 —— 玩家闭着眼也该听出"我砍的是人还是箱子"。
   */
  knifeImpact(kind: 'flesh' | 'wood' | 'stone' | 'metal'): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.58, wet: 0.06 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    const material = KNIFE_MATERIALS[kind] ?? KNIFE_MATERIALS.flesh
    const pitch = 1 + jitter(0.05)

    // 1. 撞击：1.5ms 起音。这一条"硬"就是它和挥空唯一的、也是最关键的差别。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: material.peak,
      attack: 0.0015,
      dur: material.dur,
      type: 'bandpass',
      freq: material.band * pitch,
      q: material.q,
      hp: material.hp,
      lp: material.lp,
      rate: 1 + jitter(0.1),
    })

    // 2. 体重：刀身把手臂的力送进目标里，没有这层刀就没有质量。
    tone(ctx, recipe, input, {
      type: 'sine',
      from: material.thumpFrom * pitch,
      to: material.thumpTo,
      at: t,
      peak: material.thumpPeak,
      attack: 0.004,
      dur: material.dur * 1.6,
    })

    // 3. 余响：石头的脆响只有 50ms，金属的"叮"拖到 300ms，还多一个分音。
    if (material.ring > 0) {
      tone(ctx, recipe, input, {
        type: 'triangle',
        from: material.ringFreq * pitch,
        to: material.ringFreq * pitch * 0.94,
        at: t,
        peak: material.ring * 0.6,
        attack: 0.002,
        dur: material.ringDur,
      })
      if (material.ring > 0.2) {
        tone(ctx, recipe, input, {
          type: 'triangle',
          from: material.ringFreq * pitch * 1.44,
          to: material.ringFreq * pitch * 1.4,
          at: t,
          peak: material.ring * 0.32,
          attack: 0.002,
          dur: material.ringDur * 0.7,
          lag: 0.012,
        })
      }
    }

    // 4. 湿声：只有肉有。撞击过去 45ms 才起来，慢起音 —— 组织回弹，不是撞击。
    if (material.suck > 0) {
      shake(ctx, recipe, input, {
        noise,
        at: t + 0.045,
        peak: 0.13 * material.suck,
        attack: 0.03,
        dur: 0.12,
        type: 'bandpass',
        freq: 900 * pitch,
        q: 1.6,
        hp: 300,
        rate: 0.75,
      })
    }
    this.seal(o)
  }

  // ---------------------------------------------------------------- 命中 / 玩家状态

  /** @param point 世界命中点：既是空间坐标，也是"打到了什么材质"的种子。 */
  impact(point: WorldPoint, distance?: number): void {
    const noise = this.noise
    // 混响不写死：同一声命中在 3m 和 40m 之外该有不同空间，交给 open() 按距离算。
    const opts: OpenOptions = { at: point, level: 0.5 }
    if (distance !== undefined) opts.distance = distance
    const o = this.open(opts)
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    const seed = hashPoint(point.x, point.y, point.z)
    // 种子决定带通中心：木头 600 哑、铁皮 2600 尖，同一个箱子每次一样。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: 0.5,
      attack: 0.002,
      dur: 0.09,
      type: 'bandpass',
      freq: 600 + seed * 2000,
      q: 2.2,
      rate: 1 + seed * 0.4,
    })
    // 远处命中只剩噪声会彻底消失，补一记低频"噗"告诉玩家"打中了"。
    if (o.distance > 12) tone(ctx, recipe, input, { type: 'sine', from: 120, to: 62, at: t, peak: 0.22, attack: 0.004, dur: 0.12 })
    this.seal(o)
  }

  /**
   * 子弹打进身体：低频"钝" + 湿噪声 + 爆头脆裂。
   *
   * 和 `hitConfirm` 的 UI 叮是两件事：那个只回答"记分有效"，这个回答
   * "打进去了"。没有它，命中反馈就只剩屏幕上一个 X 和一声电子音，枪的
   * 重量完全没有传到手上。距离/遮挡由 open() 按命中点算，所以远处中弹
   * 是闷的，贴脸中弹才有那一下"噗"。
   *
   * @param damage 用来定重量：105 的狙击比 42 的卡宾沉一倍多。
   */
  fleshImpact(at: WorldPoint, damage: number, headshot: boolean, occluded = false): void {
    const noise = this.noise
    const power = Math.min(1, Math.max(0.2, damage / 120))
    const o = this.open({ at, level: 0.27 + power * 0.15, priority: PRIORITY.self, occluded })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002

    // 1. 体重：比脚步更低、更短。命中越重，下潜越深。
    tone(ctx, recipe, input, {
      type: 'sine',
      from: 120 - power * 30,
      to: 48 - power * 6,
      at: t,
      peak: 0.2 + power * 0.15,
      attack: 0.003,
      dur: 0.1 + power * 0.07,
    })
    // 2. 湿声：500–800Hz 的带通，Q 压低，读成"打进软组织"而不是敲木头。
    shake(ctx, recipe, input, {
      noise,
      at: t + 0.004,
      peak: 0.16 + power * 0.12,
      attack: 0.002,
      dur: 0.08 + power * 0.05,
      type: 'bandpass',
      freq: 520 + power * 220,
      q: 1.1,
      hp: 70,
      lp: 1800,
      rate: 0.9 + power * 0.3,
    })
    // 3. 爆头：额外一记短脆的高频，和普通命中一秒就能分开。
    if (headshot) {
      click(ctx, recipe, input, noise, t, 3000, 0.1, 0.02)
      tone(ctx, recipe, input, {
        type: 'triangle',
        from: 2200,
        to: 1400,
        at: t,
        peak: 0.08,
        attack: 0.002,
        dur: 0.04,
      })
    }
    this.seal(o)
  }

  /**
   * 命中确认：战地式"金属 tick"，不是电子音。
   *
   * 旧版是三角波 900→760 再叠一声 1050Hz 的 hitMarker，加上肉体声之后三层
   * 一起糊；听感像"叮——嗒"，既不干脆也没有层次。现在压成一条 55ms 的
   * 三段音：1ms 的硬起音（金属片）、40ms 的短共鸣（三角波）、60ms 的低频
   * 体重。爆头整体上移一个八度并多一记 4.2kHz 的亮边，普通命中保持中性。
   *
   * 不做长尾、不加湿声：命中确认属于 UI 层，肉体声在 fleshImpact 里。
   */
  hitConfirm(headshot: boolean): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: headshot ? 0.42 : 0.34, wet: 0.01 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    const base = headshot ? 3400 : 2400
    const body = headshot ? 2100 : 1600

    // 1. 硬起音：越短越像"钢铁碰了一下"，超过 20ms 就开始像铃铛。
    if (noise !== null) click(ctx, recipe, input, noise, t, base, headshot ? 0.28 : 0.2, 0.016)
    // 2. 短共鸣：三角波自带奇次谐波，50ms 内收完。
    tone(ctx, recipe, input, {
      type: 'triangle',
      from: base * 0.72,
      to: body,
      at: t,
      peak: headshot ? 0.18 : 0.14,
      attack: 0.001,
      dur: 0.05,
    })
    // 3. 体重：压在 150→88Hz，只负责"有东西被击中"的实体感。
    tone(ctx, recipe, input, {
      type: 'sine',
      from: headshot ? 160 : 140,
      to: 88,
      at: t,
      peak: headshot ? 0.16 : 0.12,
      attack: 0.003,
      dur: 0.06,
    })
    // 4. 爆头专属：再高一档的亮边，和普通命中一秒就能分开。
    if (headshot && noise !== null) click(ctx, recipe, input, noise, t + 0.004, 4200, 0.14, 0.02)
    this.seal(o)
  }

  /**
   * 击杀确认：比 hitConfirm 重一档。
   *
   * 打中的一瞬间玩家听的是"有没有效"，击杀听的是"结束了"。所以这里不再靠高频叮：
   * 90 → 45Hz 的闷响给重量，金属 click 给"打穿了"的信息，噪声尾巴把整声拖过 0.3s
   * —— 短促的确认音会被下一发枪声吞掉，只有带尾巴的才读得出那个"停"。
   * 爆头多一记 2600Hz 的尖 click，和普通击杀的 1750Hz 差着半个八度多，隔着一发
   * 枪也分得清。
   */
  killConfirm(headshot: boolean): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: headshot ? 0.66 : 0.58, wet: 0.12 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002

    // 1. 重量：胸口那一下比耳朵那一下重要。
    tone(ctx, recipe, input, { type: 'sine', from: 90, to: 45, at: t, peak: 0.55, attack: 0.006, dur: 0.25 })
    if (noise !== null) {
      // 2. 金属：两个频率都压在 3kHz 以下，别和枪声的尾巴抢频段。
      click(ctx, recipe, input, noise, t, headshot ? 2400 : 1750, headshot ? 0.34 : 0.3, 0.05)
      // 3. 尾巴：低通 700 让它只是"余震"，不是"嘶"。
      shake(ctx, recipe, input, { noise, at: t + 0.01, peak: 0.16, attack: 0.02, dur: 0.3, type: 'lowpass', freq: 700, q: 0.8, rate: 0.7 })
      // 4. 爆头专属：单独一记高频，位置比其他分量都高。
      if (headshot) click(ctx, recipe, input, noise, t + 0.028, 2600, 0.26, 0.03)
    }
    this.seal(o)
  }

  /**
   * 命中未击杀：只说"打到了"。
   *
   * 整声压在 60ms 以内、电平 0.3 以下 —— 它永远和枪声同时出现，长了就是糊，响了
   * 就是盖。爆头只抬频段（1500Hz 对 1050Hz），不加音量：位置感比大小更容易分辨。
   */
  hitMarker(headshot: boolean): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: headshot ? 0.28 : 0.22, wet: 0.02 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    const f = headshot ? 1500 : 1050
    // 2ms 起音、35ms 收完：单听像一声"嗒"，在枪声里是一枚能数出来的点。
    tone(ctx, recipe, input, { type: 'triangle', from: f, to: f * 0.8, at: t, peak: 0.2, attack: 0.002, dur: 0.035 })
    if (noise !== null) click(ctx, recipe, input, noise, t, headshot ? 2600 : 1900, 0.14, 0.028)
    this.seal(o)
  }

  /**
   * 命中定格那一刻的 sub 冲击。
   *
   * 60ms、58 → 40Hz，**不要混响也不要噪声**：任何尾巴都会把定格听成慢动作，而
   * 这一声的作用正好相反 —— 画面停住的那一帧，耳朵也被按下去。所以峰值敢给 0.7。
   */
  hitStopThud(): void {
    const o = this.open({ priority: PRIORITY.self, level: 0.5, wet: 0 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    tone(ctx, recipe, input, { type: 'sine', from: 58, to: 40, at: t, peak: 0.7, attack: 0.003, dur: 0.06 })
    this.seal(o)
  }

  /**
   * 自己被击中：一记**高频脆响 + 闷响 + 低频下坠**三层。
   *
   * 只有低频闷响时，混在枪声里几乎听不出来"是我中弹了"；最前面补一个
   * 1.4k→500Hz 的短脆响（像子弹擦过耳边），再接身体的低频冲击。
   * damage 决定低频层的重量：霰弹贴脸和手枪擦伤不该一样沉。
   */
  hurt(damage = 30): void {
    const noise = this.noise
    const weight = Math.min(1, Math.max(0.35, damage / 90))
    const o = this.open({ priority: PRIORITY.self, level: 0.85, wet: 0.04 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    // 第一层：高频脆响。120ms 内从 1.4kHz 扫到 500Hz，只给 0.24 峰值，
    // 够刺耳但不至于盖过后续的低频体重。
    tone(ctx, recipe, input, { type: 'square', from: 1400, to: 500, at: t, peak: 0.22, attack: 0.002, dur: 0.09 })
    if (noise !== null) {
      shake(ctx, recipe, input, {
        noise, at: t, peak: 0.5, attack: 0.005, dur: 0.16, type: 'bandpass', freq: 900, rate: 1.2,
      })
      // 第二层：身体被撞的闷响。
      shake(ctx, recipe, input, {
        noise, at: t + 0.01, peak: 0.55, attack: 0.008, dur: 0.24, type: 'lowpass', freq: 420, rate: 0.7,
      })
    }
    // 第三层：低频下坠，按伤害加重。
    tone(ctx, recipe, input, {
      type: 'sine', from: 130, to: 42, at: t + 0.006, peak: 0.3 + weight * 0.2, attack: 0.012, dur: 0.3,
    })
    this.seal(o)
  }

  /** 死亡：所有东西一起往下沉，然后彻底安静（等 respawn 再说话）。 */
  death(): void {
    this.clearHeartbeat()
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.9, wet: 0.2 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    // 低通跟着音高一起往下扫：2400 → 180，最后只剩"呼"的一声
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(2400, t)
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.9)
    lp.connect(input)
    recipe.nodes.push(lp)
    tone(ctx, recipe, lp, { type: 'sawtooth', from: 220, to: 46, at: t, peak: 0.3, attack: 0.05, dur: 1.0 })
    if (noise !== null) shake(ctx, recipe, lp, { noise, at: t, peak: 0.2, attack: 0.1, dur: 1.0, type: 'lowpass', freq: 900, rate: 0.5 })
    this.seal(o)
  }

  /**
   * 怪物死亡。
   *
   * 旧的 `death()` 是给玩家用的：220→46Hz 的锯齿在 1 秒里滑到次声，
   * 听感就是一声长而软的低频下滑 —— 也就是"放屁"。怪物死亡需要**短促、
   * 有冲击、有肉体**：先一记干硬的撞击和低频体重，再一层湿声，喉音只给
   * 0.2–0.3s 的短促下坠，最后半拍后身体砸地。体型决定频率与时长：猎犬
   * 偏高偏短，行尸中等，巨像/Boss 更低更长。
   *
   * 传 at 时走 HRTF：玩家应该听得出"倒在我左边 8 米"，而不是从自己胸口
   * 冒出来一声。
   */
  monsterDeath(kind: number, at?: WorldPoint, occluded = false): void {
    const noise = this.noise
    const heavy = kind >= 3
    const hound = kind === 1
    const o = this.open({
      at,
      priority: at === undefined ? PRIORITY.self : undefined,
      level: heavy ? 0.95 : 0.8,
      wet: at === undefined ? 0.18 : 0.1,
      occluded,
    })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    const base = heavy ? 170 : hound ? 520 : 260
    const end = heavy ? 62 : hound ? 190 : 96

    // 1. 冲击：一记很短的高频"啪"给起音，再让低频体重落下去。
    click(ctx, recipe, input, noise, t, heavy ? 1200 : 2000, heavy ? 0.3 : 0.24, 0.02)
    tone(ctx, recipe, input, {
      type: 'sine',
      from: base * 1.3,
      to: end,
      at: t,
      peak: heavy ? 0.5 : 0.38,
      attack: 0.003,
      dur: heavy ? 0.22 : 0.16,
    })

    // 2. 湿声：肉被撕开的那一下，宽 Q 带通，不能是"轰"。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: heavy ? 0.42 : 0.34,
      attack: 0.002,
      dur: heavy ? 0.18 : 0.13,
      type: 'bandpass',
      freq: hound ? 1300 : 800,
      q: 1.1,
      hp: 120,
      lp: 2600,
      rate: 1.1,
    })

    // 3. 喉音：0.24–0.34s 的短促下坠，带通/低通压住高频，不做长滑音。
    tone(ctx, recipe, input, {
      type: 'sawtooth',
      from: base,
      to: end * 1.2,
      at: t + 0.008,
      peak: heavy ? 0.26 : 0.2,
      attack: 0.012,
      dur: heavy ? 0.34 : 0.24,
      lp: heavy ? 700 : 1100,
    })

    // 4. 倒地：迟 0.16s，身体砸进泥里；有它才有"死了"的重量。
    tone(ctx, recipe, input, {
      type: 'sine',
      from: 100,
      to: 42,
      at: t + 0.16,
      peak: heavy ? 0.4 : 0.26,
      attack: 0.004,
      dur: heavy ? 0.34 : 0.24,
    })
    shake(ctx, recipe, input, {
      noise,
      at: t + 0.16,
      peak: heavy ? 0.24 : 0.16,
      attack: 0.01,
      dur: 0.24,
      type: 'lowpass',
      freq: 420,
      rate: 0.6,
    })

    // 5. 猎犬：额外一记高音短嚎，和行尸的闷死区分开。
    if (hound) {
      tone(ctx, recipe, input, {
        type: 'triangle',
        from: 980,
        to: 420,
        at: t + 0.02,
        peak: 0.2,
        attack: 0.006,
        dur: 0.16,
      })
    }
    this.seal(o)
  }

  /** 复活：两声上行短音，干净、不带混响 —— 和死亡的沉闷刻意相反。 */
  respawn(): void {
    const o = this.open({ priority: PRIORITY.self, level: 0.5, wet: 0 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    tone(ctx, recipe, input, { type: 'triangle', from: 420, to: 630, at: t, peak: 0.22, attack: 0.02, dur: 0.11 })
    tone(ctx, recipe, input, { type: 'triangle', from: 630, to: 630, at: t, peak: 0.22, attack: 0.02, dur: 0.22, lag: 0.11 })
    this.seal(o)
  }

  // ---------------------------------------------------------------- 搜刮 / 结算

  /**
   * 开始搜刮：掀开箱盖/翻袋子的第一声。
   *
   * 三层叠出"有个东西被打开"：合页的吱呀（慢起音 + 带通上扫，这是"被掀开"
   * 而不是"被敲了一下"）、箱体的重量（低频闷响），以及衣料/口袋的摩擦。
   * 电平压在 0.44 / 峰值 0.24 以下 —— 翻箱子比开枪轻得多，但它必须听得见。
   */
  searchStart(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.44, wet: 0.04 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    const pitch = 1 + jitter(0.05)

    // 1. 合页：75ms 的慢起音 + 低 Q 带上扫 520 → 1180。慢起音是"木头在扭"。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: 0.2,
      attack: 0.075,
      dur: 0.3,
      type: 'bandpass',
      freq: 520 * pitch,
      sweepTo: 1180 * pitch,
      q: 3.2,
      hp: 240,
      rate: 1 + jitter(0.1),
    })

    // 2. 盖子的重量：110 → 74Hz 的短正弦。迟 90ms 起来，跟"掀"的动作对齐。
    tone(ctx, recipe, input, { type: 'sine', from: 132 * pitch, to: 72, at: t + 0.09, peak: 0.24, attack: 0.008, dur: 0.22 })

    // 3. 衣料/袋子：宽 Q 的中频摩擦，把整声填到 0.35s，否则前两层听起来是"空的"。
    shake(ctx, recipe, input, { noise, at: t + 0.05, peak: 0.13, attack: 0.04, dur: 0.3, type: 'bandpass', freq: 1500, q: 0.9, hp: 420 })
    this.seal(o)
  }

  /**
   * 每翻找一下。progress 越接近 1 说明东西越少 —— 声音要跟着变轻、变短、变干。
   *
   * 三层全按 (1 - progress) 缩放，起音和音高只做 jitter（沿用文件里既有的抖动
   * 方式）：翻找是连续的同一动作，随机换音色反而会让它听起来像有人在敲门。
   */
  searchTick(progress: number): void {
    const noise = this.noise
    const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1)
    const o = this.open({ priority: PRIORITY.self, level: 0.5 - p * 0.3, wet: 0.03 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002 + jitter(0.004)
    // 1 → 0.38：翻到底时只剩原来的三成多一点。
    const left = 1 - p * 0.62
    const pitch = 1 + jitter(0.2)
    const dur = 0.06 + (1 - p) * 0.07

    // 1. 布料/纸袋的摩擦：翻箱子的"底噪"，每一下时间长短都不一样（dur 随 p 变）。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: 0.26 * left,
      attack: 0.004,
      dur,
      type: 'bandpass',
      freq: 1200 * pitch,
      q: 1.2,
      hp: 360,
      rate: 1 + jitter(0.15),
    })

    // 2. 碰到硬物的一下"嗒"：2400 → 1900Hz 的三角波，极短。东西翻完之后它先消失。
    tone(ctx, recipe, input, { type: 'triangle', from: 2400 * pitch, to: 1900, at: t, peak: 0.07 * left, attack: 0.002, dur: 0.05 })
    this.seal(o)
  }

  /**
   * 搜刮完成："掀开" + 抓取的金属/布料细节。
   *
   * 和 searchStart 是同一套合页，但这次是被甩开的（快起音、扫得更宽、更短），
   * 后面接两枚不成整数比的"叮"和一记布料 —— 这是玩家唯一一次听到"拿到了"。
   */
  searchDone(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.52, wet: 0.05 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    const pitch = 1 + jitter(0.04)

    // 1. 甩开的合页：30ms 起音、扫 620 → 2100，比 searchStart 短一半。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: 0.26,
      attack: 0.03,
      dur: 0.26,
      type: 'bandpass',
      freq: 620 * pitch,
      sweepTo: 2100 * pitch,
      q: 2.6,
      hp: 300,
      rate: 1 + jitter(0.1),
    })

    // 2. 盖子落到底：150 → 66Hz，比 searchStart 的那一记更低更长（它是一次落定）。
    tone(ctx, recipe, input, { type: 'sine', from: 150 * pitch, to: 66, at: t + 0.06, peak: 0.26, attack: 0.006, dur: 0.24 })

    // 3. 拾取：2380 与 3410 不成整数比（不是八度也不是五度）→ 像"一件金属物"，
    //    而不是一个音。第二声迟 45ms，是硬币落回口袋。
    tone(ctx, recipe, input, { type: 'triangle', from: 2380 * pitch, to: 2260, at: t + 0.1, peak: 0.13, attack: 0.002, dur: 0.22 })
    tone(ctx, recipe, input, { type: 'triangle', from: 3410 * pitch, to: 3200, at: t + 0.1, peak: 0.08, attack: 0.002, dur: 0.16, lag: 0.045 })
    shake(ctx, recipe, input, { noise, at: t + 0.06, peak: 0.1, attack: 0.02, dur: 0.18, type: 'bandpass', freq: 1700, q: 1.1, hp: 500 })
    this.seal(o)
  }

  /**
   * 一无所获：一声闷响 + 短促的气音。
   *
   * 刻意**一个高音都没有**（全部低通 320 以下）：玩家听到的是"空的"。这一声
   * 和 searchDone 的差别只在频段上，不在音量上 —— 音量一样的"空"与"有"，
   * 才是这套声音里最有信息量的对比。
   */
  searchEmpty(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.42, wet: 0.03 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002

    // 1. 空心闷响：低通 320 的噪声 + 110 → 48Hz。箱子是空的，所以连共鸣都没有。
    if (noise !== null) {
      shake(ctx, recipe, input, { noise, at: t, peak: 0.3, attack: 0.006, dur: 0.2, type: 'lowpass', freq: 320, q: 0.7, rate: 0.7 })
    }
    tone(ctx, recipe, input, { type: 'sine', from: 110, to: 48, at: t, peak: 0.26, attack: 0.01, dur: 0.22, lp: 240 })

    // 2. 气音：一口气从牙缝里漏出去。慢起音、高通 500 → 只有"气"，没有"声"。
    if (noise !== null) {
      shake(ctx, recipe, input, { noise, at: t + 0.05, peak: 0.14, attack: 0.03, dur: 0.22, type: 'bandpass', freq: 1100, q: 1.5, hp: 500 })
    }
    this.seal(o)
  }

  /**
   * 结算。
   *
   * 撤离成功：C-E-G 三音上行，每个音都叠一层低八度正弦（暖）+ 三角波（有芯），
   * 混响送出 0.5 —— 共享 IR 是 1.7s，听起来像"在教堂里松了口气"。
   * 失败：F3 → C3 两音下行，全部过 700Hz 低通、混响只给 0.14：闷、短、没有余响。
   * 这两个声音的频段和空间感是相反的，玩家在结算界面上闭着眼也知道自己活没活下来。
   */
  matchResult(escaped: boolean): void {
    if (escaped) {
      const o = this.open({ priority: PRIORITY.self, level: 0.72, wet: 0.5 })
      if (o === null) return
      const { ctx, recipe, input } = o
      const t = ctx.currentTime + 0.01
      let lag = 0
      for (const f of [261.63, 329.63, 392]) {
        const last = lag > 0.4
        // 三角波给"芯"，低八度正弦给"暖"：只有正弦的三音和弦听起来像电子闹钟。
        tone(ctx, recipe, input, { type: 'triangle', from: f, to: f, at: t, peak: 0.2, attack: 0.03, dur: last ? 1.5 : 1, lag })
        tone(ctx, recipe, input, { type: 'sine', from: f * 0.5, to: f * 0.5, at: t, peak: 0.12, attack: 0.04, dur: last ? 1.6 : 1.1, lag })
        lag += 0.23
      }
      this.seal(o)
      return
    }

    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.6, wet: 0.14 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.01
    // 两个下行音，都闷：174.61 → 146.83，然后 138.59 → 130.81（相差一个下行四度）。
    tone(ctx, recipe, input, { type: 'triangle', from: 174.61, to: 146.83, at: t, peak: 0.24, attack: 0.03, dur: 0.5, lp: 700 })
    tone(ctx, recipe, input, { type: 'triangle', from: 138.59, to: 130.81, at: t, peak: 0.26, attack: 0.04, dur: 0.9, lp: 620, lag: 0.34 })
    tone(ctx, recipe, input, { type: 'sine', from: 65.41, to: 61.74, at: t, peak: 0.2, attack: 0.05, dur: 1, lag: 0.34 })
    // 压在所有东西下面的"落幕"：慢起音慢收的低通噪声，让两个音听起来是"沉下去"的。
    if (noise !== null) {
      shake(ctx, recipe, input, { noise, at: t + 0.2, peak: 0.14, attack: 0.15, dur: 1.1, type: 'lowpass', freq: 420, rate: 0.6 })
    }
    this.seal(o)
  }

  // ---------------------------------------------------------------- 击杀 / 解锁 / Boss

  /**
   * 结算金币入账：count 枚硬币落进袋子，最多 8 枚。
   *
   * 频高随序号往上（1900 → 3020Hz）、峰值随序号往下：枚数多的时候听起来是"一串"
   * 而不是 8 个同音炸点。55ms 的间隔比耳朵的融合阈值（约 30~40ms）长，数得清。
   */
  coinTick(count: number): void {
    const n = clamp(Math.round(Number.isFinite(count) ? count : 1), 0, 8)
    if (n < 1) return
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.42, wet: 0.08 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    for (let i = 0; i < n; i += 1) {
      const at = t + i * 0.055
      const f = 1900 + i * 160
      click(ctx, recipe, input, noise, at, f, 0.26 - i * 0.012, 0.045)
      // 硬币的"金属尾"：1.5 倍频的三角波，和 click 自带的分音错开。
      tone(ctx, recipe, input, { type: 'triangle', from: f * 1.5, to: f * 1.42, at, peak: 0.06, attack: 0.002, dur: 0.06 })
    }
    this.seal(o)
  }

  /**
   * 线索/文献翻开：纸页摩擦 + 一笔落墨。
   *
   * 纸的关键是"没有低频也没有余响"：900Hz 高通以上的宽带噪声，带上扫才是"被手指
   * 推开"而不是"被敲了一下"。笔触晚 0.16s 起来，玩家才觉得是"翻到那一页、然后记
   * 下来"；0.2s 那记 165 → 110Hz 是纸落到桌面上的体量，没有它整声是飘的。
   */
  codexWrite(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.34, wet: 0.03 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: 0.16,
      attack: 0.05,
      dur: 0.26,
      type: 'bandpass',
      freq: 2200,
      sweepTo: 3800,
      q: 0.8,
      hp: 900,
      rate: 1 + jitter(0.1),
    })
    tone(ctx, recipe, input, { type: 'sine', from: 165, to: 110, at: t + 0.2, peak: 0.1, attack: 0.006, dur: 0.1 })
    click(ctx, recipe, input, noise, t + 0.16, 3200, 0.1, 0.022)
    this.seal(o)
  }

  /**
   * Boss 登场/吼叫：远处的一个巨物。
   *
   * 三条一起才成立"远"：0.4s 的慢起音（贴脸的声音没有这个起音时间）、低通把直达
   * 声压到 380Hz（距离本身就是最狠的低通）、混响送出 0.35 让尾巴比本体长。
   * 两层 sawtooth 差 7 音分是廉价的"失真感"：比接 waveshaper 少一个节点，听感上
   * 同样是"一个东西在同时发两个音高"，而且低频不同相才不会被听成喇叭。
   */
  bossRoar(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.9, wet: 0.35 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.01
    const dur = 2.2

    // 本体出口：1200 → 380Hz 的慢扫，越吼越闷（远处的大东西不会有高频）。
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(1200, t)
    lp.frequency.exponentialRampToValueAtTime(380, t + dur)
    lp.Q.value = 0.9
    lp.connect(input)
    recipe.nodes.push(lp)

    for (const cents of [-7, 7]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.detune.value = cents
      osc.frequency.setValueAtTime(70, t)
      osc.frequency.exponentialRampToValueAtTime(38, t + dur)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(cents < 0 ? 0.42 : 0.34, t + 0.4)
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(env)
      env.connect(lp)
      osc.start(t)
      osc.stop(t + dur + 0.05)
      recipe.sources.push(osc)
      recipe.nodes.push(osc, env)
    }

    if (noise !== null) {
      // 喉部的砂：260 → 900Hz 的 lowpass 上扫，吼到中段才放开。
      shake(ctx, recipe, input, {
        noise,
        at: t + 0.12,
        peak: 0.2,
        attack: 0.5,
        dur: 1.8,
        type: 'lowpass',
        freq: 260,
        sweepTo: 900,
        q: 1.4,
        rate: 0.55,
      })
      // 低频垫底：2.2s 才散干净，混响之外再给一层体量。
      shake(ctx, recipe, input, { noise, at: t, peak: 0.1, attack: 0.6, dur: 2.2, type: 'lowpass', freq: 180, q: 0.7, rate: 0.4 })
    }
    this.seal(o)
  }

  /**
   * 天赋解锁：520 / 660 / 880Hz 三音上行，每个 120ms。
   *
   * 全用三角波：正弦像系统提示音，方波像失败，三角波那几个奇次谐波才有"器物的芯"。
   * 金属尾用 2380 / 3410 这对不成整数比的分音 —— 和 searchDone 同一套道理，整数比
   * 听起来像按键音。
   */
  traitUnlock(): void {
    const o = this.open({ priority: PRIORITY.self, level: 0.56, wet: 0.22 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.01
    let lag = 0
    for (const f of [520, 660, 880]) {
      // 每个音微微上滑 1%：三个干净的音会像电子音阶，一点点滑才"亮起来"。
      tone(ctx, recipe, input, { type: 'triangle', from: f, to: f * 1.01, at: t, peak: 0.2, attack: 0.008, dur: 0.12, lag })
      lag += 0.09
    }
    tone(ctx, recipe, input, { type: 'triangle', from: 2380, to: 2270, at: t, peak: 0.06, attack: 0.004, dur: 0.45, lag: 0.18 })
    tone(ctx, recipe, input, { type: 'triangle', from: 3410, to: 3260, at: t, peak: 0.04, attack: 0.004, dur: 0.3, lag: 0.18 })
    this.seal(o)
  }

  /**
   * Boss 范围脉冲：三种音色必须能闭眼分辨。
   *  - 敲钟人：金属钟的基频 + 两个非整数泛音，尾巴比本体长。
   *  - 石心巨像：只有低频与土石噪声，像整面墙砸在地上。
   *  - 末班车长：短促的铜哨，两声，第二声更高 —— 那是"叫狗"不是"攻击"。
   */
  bossPulse(kind: number): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.92, wet: kind === 4 ? 0.42 : 0.3 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.005

    if (kind === 4) {
      // 钟：基频 180Hz，泛音按 2.4 / 3.9 倍排，衰减各不相同。
      tone(ctx, recipe, input, { type: 'sine', from: 184, to: 178, at: t, peak: 0.5, attack: 0.004, dur: 2.4 })
      tone(ctx, recipe, input, { type: 'sine', from: 442, to: 428, at: t, peak: 0.24, attack: 0.004, dur: 1.6 })
      tone(ctx, recipe, input, { type: 'sine', from: 718, to: 690, at: t, peak: 0.12, attack: 0.004, dur: 1.1 })
      if (noise !== null) {
        shake(ctx, recipe, input, { noise, at: t, peak: 0.14, attack: 0.004, dur: 0.5, type: 'bandpass', freq: 2600, q: 1.2, rate: 0.7 })
      }
    } else if (kind === 5) {
      tone(ctx, recipe, input, { type: 'sine', from: 74, to: 28, at: t, peak: 0.55, attack: 0.008, dur: 0.9 })
      tone(ctx, recipe, input, { type: 'sawtooth', from: 52, to: 31, at: t, peak: 0.18, attack: 0.01, dur: 0.7, lp: 180 })
      if (noise !== null) {
        shake(ctx, recipe, input, { noise, at: t, peak: 0.38, attack: 0.005, dur: 0.55, type: 'lowpass', freq: 420, q: 0.8, rate: 0.45 })
      }
    } else if (kind === 6) {
      tone(ctx, recipe, input, { type: 'triangle', from: 1180, to: 1120, at: t, peak: 0.22, attack: 0.006, dur: 0.18 })
      tone(ctx, recipe, input, { type: 'triangle', from: 1390, to: 1330, at: t + 0.2, peak: 0.2, attack: 0.006, dur: 0.24 })
    } else {
      tone(ctx, recipe, input, { type: 'sine', from: 110, to: 40, at: t, peak: 0.4, attack: 0.01, dur: 0.8 })
    }
    this.seal(o)
  }

  /**
   * Boss 被击杀：一路掉下去。
   *
   * 三个事件在时间上是错开的 —— 先"垮"（120 → 30Hz 的 1.2s 下坠），0.55s 后
   * "砸到地上"（body thud），最后才是"地上起了一片灰"（1.6s 的噪声余韵）。同时
   * 起来的话只会是一声难听的低频爆炸，玩家听不出击杀了什么东西。
   */
  bossDown(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.86, wet: 0.3 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.005

    // 1. 下坠：锯齿波压在 420Hz 以下，只剩"金属疲劳"的低频。
    tone(ctx, recipe, input, { type: 'sawtooth', from: 120, to: 30, at: t, peak: 0.4, attack: 0.02, dur: 1.2, lp: 420 })
    // 2. 体重：正弦垫在底下，下坠才不是"一个滑音"。
    tone(ctx, recipe, input, { type: 'sine', from: 90, to: 34, at: t, peak: 0.34, attack: 0.03, dur: 1.3 })
    // 3. 落地：迟 0.55s，比下坠本身更短更硬。
    tone(ctx, recipe, input, { type: 'sine', from: 140, to: 52, at: t + 0.55, peak: 0.5, attack: 0.006, dur: 0.3 })
    if (noise !== null) {
      shake(ctx, recipe, input, { noise, at: t + 0.55, peak: 0.3, attack: 0.008, dur: 0.32, type: 'lowpass', freq: 520, q: 0.9, rate: 0.6 })
      // 4. 余韵：600 → 150Hz 下扫，跟着混响一起收干。
      shake(ctx, recipe, input, { noise, at: t + 0.6, peak: 0.16, attack: 0.12, dur: 1.6, type: 'lowpass', freq: 600, sweepTo: 150, q: 0.8, rate: 0.5 })
    }
    this.seal(o)
  }

  // ---------------------------------------------------------------- 身体声

  /** 疾跑喘息：吸气（亮、快）+ 呼气（闷、慢）。两段都过带通 = "从肺里出来的风"。 */
  exertion(sprinting = false): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: sprinting ? 0.5 : 0.3, wet: 0 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.004
    const level = sprinting ? 1 : 0.6
    shake(ctx, recipe, input, { noise, at: t, peak: 0.14 * level, attack: 0.07, dur: 0.3, type: 'bandpass', freq: 780, q: 1.3, hp: 300 })
    shake(ctx, recipe, input, { noise, at: t + 0.4, peak: 0.11 * level, attack: 0.09, dur: 0.34, type: 'bandpass', freq: 1050, q: 1.1, hp: 420 })
    this.seal(o)
  }

  /** 开镜呼吸：极轻的一道气声，慢起音 —— 玩家不该"注意到"它，只该觉得安静。 */
  aimBreath(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.18, wet: 0 })
    if (o === null) return
    if (noise !== null) {
      shake(o.ctx, o.recipe, o.input, {
        noise,
        at: o.ctx.currentTime + 0.004,
        peak: 0.06,
        attack: 0.15,
        dur: 0.6,
        type: 'bandpass',
        freq: 520,
        q: 1.2,
        hp: 240,
      })
    }
    this.seal(o)
  }

  /** 喝药：三口吞咽（210 → 150Hz 的短正弦）+ 液体晃动。 */
  heal(): void {
    const noise = this.noise
    const o = this.open({ priority: PRIORITY.self, level: 0.5, wet: 0 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002
    for (let i = 0; i < 3; i++) {
      tone(ctx, recipe, input, {
        type: 'sine',
        from: 210 + Math.random() * 40,
        to: 148,
        at: t,
        peak: 0.18,
        attack: 0.012,
        dur: 0.12,
        lp: 700,
        lag: i * 0.17,
      })
    }
    if (noise !== null) shake(ctx, recipe, input, { noise, at: t, peak: 0.12, attack: 0.03, dur: 0.5, type: 'lowpass', freq: 600, rate: 0.8 })
    this.seal(o)
  }

  // ---------------------------------------------------------------- 脚步

  /**
   * 地形脚步。
   *
   * 旧调用点（game.ts:427）只传一个 boolean，所以第一个参数同时接受地形字符串：
   * 传 boolean 时用脚下坐标猜一个地形，猜不出来落回石头。
   */
  footstep(surfaceOrSprinting: FootstepSurface | boolean, sprinting = false, crouching = false): void {
    if (typeof surfaceOrSprinting === 'boolean') {
      this.step(guessSurface(this.listenerPos), surfaceOrSprinting, false, null)
      return
    }
    this.step(surfaceOrSprinting, sprinting, crouching, null)
  }

  /** 别人（或怪物）的脚步：走 HRTF Panner，1m 以内当成自己的。 */
  footstepAt(at: WorldPoint, surface: FootstepSurface, sprinting = false, crouching = false, occluded = false): void {
    this.step(surface, sprinting, crouching, at, occluded)
  }

  /**
   * 怪物脚步。
   *
   * 和人的脚步共用同一套材质/地面音，但重量不同：猎犬轻快，行尸更重，
   * Boss 是"一步一震"。没有单独的怪物采样，靠 pitch 与电平做出体型差 ——
   * 玩家听到的应该是"有东西在靠近"，而不是"又一个人在走"。
   */
  monsterStepAt(at: WorldPoint, surface: FootstepSurface, kind: number, occluded = false): void {
    const weight = kind === 1 ? 0.7 : kind >= 3 ? 1.9 : 1.25
    this.step(surface, false, false, at, occluded, weight)
  }

  /**
   * 一步。
   *
   * 三层叠起来才是"踩在某种材质上"：闷响（体重）+ 摩擦噪声（鞋底）+ 特征音
   * （木头的吱呀、金属的余响、水/泥的水花）。每一步都随机化音高和时长，
   * 因为完全一样的采样重复二十次，耳朵立刻就把它识别成"机器"。
   */
  private step(
    surface: FootstepSurface,
    sprinting: boolean,
    crouching: boolean,
    at: WorldPoint | null,
    occluded = false,
    weight = 1,
  ): void {
    const noise = this.noise
    const spec = SURFACES[surface]
    const opts: OpenOptions = { level: (sprinting ? spec.peak * 1.35 : spec.peak) * weight }
    // 有坐标就交给 open() 按距离算混响：10m 外的脚步和 60m 外的不该站在同一个空间里。
    if (at !== null) opts.at = at
    else opts.wet = 0.02
    if (occluded) opts.occluded = true
    const o = this.open(opts)
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.002 + jitter(0.004)
    // 蹲行的目标是"几乎听不见但不静音"：电平砍到 35%，同时把 2.4k 以上全削掉。
    const level = (crouching ? 0.35 : sprinting ? 1.5 : 1) * weight
    // 体型越大，落地频率越低。用立方根而不是线性：Boss 1.9 倍重量只降约 19%，
    // 线性会把它的脚步压成一声闷雷，反而听不出方向。
    const pitch = (1 + jitter(spec.jitter)) / Math.cbrt(weight) // 每一步音高都不同
    const dur = spec.dur * (sprinting ? 0.85 : 1)

    // 1. 闷响：体重落地的低频。wood 的 95 → 52Hz 最"空心"，stone 高一点更"实"。
    if (spec.thumpPeak > 0) {
      tone(ctx, recipe, input, {
        type: 'sine',
        from: spec.thumpFrom * pitch,
        to: spec.thumpTo,
        at: t,
        peak: spec.thumpPeak * level,
        attack: 0.004,
        dur: dur * 0.9,
      })
    }

    // 2. 摩擦噪声：带通中心决定材质（木 900 / 石 2100 / 草 3300 / 泥 520）。
    shake(ctx, recipe, input, {
      noise,
      at: t,
      peak: spec.peak * level,
      attack: 0.003,
      dur,
      type: 'bandpass',
      freq: spec.band * pitch * (sprinting ? 1.15 : 1),
      q: spec.q,
      hp: spec.hp,
      lp: crouching ? Math.min(spec.lp, 2400) : spec.lp,
      rate: 0.85 + Math.random() * 0.3,
    })

    // 3. 木板的吱呀：190 → 150Hz 的短锯齿，木头"空心"的秘密就在这一层。
    if (spec.creak > 0) {
      tone(ctx, recipe, input, {
        type: 'sawtooth',
        from: 190 * pitch,
        to: 150,
        at: t,
        peak: 0.06 * spec.creak * level,
        attack: 0.01,
        dur: dur * 1.2,
        lp: 1400,
      })
    }

    // 4. 金属余响：两个不成整数倍的分音 + 晚 70ms 的一次轻回声。
    if (spec.ping > 0) {
      tone(ctx, recipe, input, { type: 'triangle', from: 2240 * pitch, to: 2040, at: t, peak: 0.09 * spec.ping * level, attack: 0.002, dur: 0.26 })
      tone(ctx, recipe, input, { type: 'triangle', from: 3120 * pitch, to: 2900, at: t, peak: 0.05 * spec.ping * level, attack: 0.002, dur: 0.18, lag: 0.07 })
    }

    // 5. 水花/泥浆：带通从 1200 上扫到 3600，包络稍长 —— 水是"溅"出来的，不是撞出来的。
    if (spec.splash > 0) {
      shake(ctx, recipe, input, {
        noise,
        at: t,
        peak: 0.16 * spec.splash * level,
        attack: 0.008,
        dur: dur * 1.5,
        type: 'bandpass',
        freq: 1200,
        sweepTo: 3600,
        q: 1.1,
        hp: 400,
        rate: 1.1,
      })
    }

    this.seal(o)
  }

  // ---------------------------------------------------------------- 怪物

  /** 贴脸（或没有坐标）的怪物叫声。 */
  monsterGrowl(kind: MonsterKind = 'grunt'): void {
    this.growl(kind, { priority: PRIORITY.self, level: 0.8, wet: 0.06 }, 1)
  }

  monsterGrowlAt(at: WorldPoint, kind: MonsterKind = 'grunt'): void {
    this.growl(kind, { at, level: 0.85, wet: 0.16 }, 1)
  }

  /**
   * 怪物叫。
   *
   * 不能只用一条滑音正弦：动物的叫声是"带颤音的声带 + 两三个固定共振峰"。
   * hound 基调 132Hz、颤音 6.2Hz（急促，像犬科），grunt 74Hz、3.4Hz（低沉，
   * 胸腔大）。共振峰 430/980 与 720/1750 是两条带通并联 —— 这两个数决定它是
   * "咕哝"还是"嘶吼"，比音量重要得多。
   */
  private growl(kind: MonsterKind, opts: OpenOptions, loudness: number): void {
    const noise = this.noise
    const o = this.open(opts)
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.01
    const hound = kind === 'hound'
    const dur = hound ? 0.62 : 1.0
    const base = hound ? 132 : 74

    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(base * (0.94 + Math.random() * 0.12), t)
    osc.frequency.exponentialRampToValueAtTime(base * 0.78, t + dur)

    const vib = ctx.createOscillator()
    vib.type = 'sine'
    vib.frequency.value = hound ? 6.2 : 3.4
    const vibDepth = ctx.createGain()
    vibDepth.gain.value = hound ? 9 : 4.5
    vib.connect(vibDepth)
    vibDepth.connect(osc.frequency)

    const formant1 = ctx.createBiquadFilter()
    formant1.type = 'bandpass'
    formant1.frequency.value = hound ? 720 : 430
    formant1.Q.value = 4.5
    const formant2 = ctx.createBiquadFilter()
    formant2.type = 'bandpass'
    formant2.frequency.value = hound ? 1750 : 980
    formant2.Q.value = 6

    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime((hound ? 0.9 : 1.1) * loudness, t + 0.09)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)

    osc.connect(formant1)
    osc.connect(formant2)
    formant1.connect(env)
    formant2.connect(env)
    env.connect(input)

    // 呼气的"砂"：喉咙里的噪声，没有这层就只是合成器
    shake(ctx, recipe, input, { noise, at: t, peak: 0.16 * loudness, attack: 0.12, dur, type: 'bandpass', freq: hound ? 900 : 520, q: 1.6 })

    osc.start(t)
    osc.stop(t + dur + 0.05)
    vib.start(t)
    vib.stop(t + dur + 0.05)
    recipe.nodes.push(formant1, formant2, env, vibDepth)
    recipe.sources.push(osc, vib)
    this.seal(o)
  }

  // ---------------------------------------------------------------- 环境声

  /**
   * 环境声总开关。幂等。
   *
   * 没解锁时不硬等：记下"想要"就返回，由重试定时器 + onstatechange + unlock()
   * 三条路各自补一次。旧代码在这里静默 return 且只在 unlock() 里补，玩家切回
   * 前台就再也听不到环境声了。
   */
  startAmbience(): void {
    if (this.disposed) return
    this.ambienceWanted = true
    this.ambienceRetries = AMBIENCE_RETRIES
    this.startAmbienceNow()
  }

  /** 区域配比：marsh / indoor / open。切换是平滑的，不会"啪"一下换房间。 */
  setAmbienceBias(bias: AmbienceBias): void {
    if (this.bias === bias) return
    this.bias = bias
    const rig = this.ambience
    const ctx = this.ctx
    if (rig === null || ctx === null) return
    const mix = AMBIENCE_MIX[bias]
    const now = ctx.currentTime
    rig.muffle.frequency.setTargetAtTime(mix.muffle, now, 0.6)
    rig.windGain.gain.setTargetAtTime(WIND_LEVEL * mix.wind, now, 0.6)
    rig.cricketGain.gain.setTargetAtTime(mix.cricket, now, 0.6)
    rig.critterGain.gain.setTargetAtTime(mix.critter, now, 0.6)
    rig.bellGain.gain.setTargetAtTime(mix.bell, now, 0.6)
  }

  private startAmbienceNow(): void {
    if (this.disposed) return
    if (this.ambience !== null) return
    const live = this.live()
    const wind = this.wind
    if (live === null || wind === null) {
      this.scheduleAmbienceRetry()
      return
    }
    const { ctx, dry } = live
    const mix = AMBIENCE_MIX[this.bias]
    const now = ctx.currentTime

    // 环境总出口：起步 0.0001，2.5s 淡入。进游戏时"环境声先于画面出现"比突然
    // 全音量扑上来舒服得多。
    const out = ctx.createGain()
    out.gain.setValueAtTime(0.0001, now)
    out.gain.linearRampToValueAtTime(1, now + 2.5)

    // 区域低通："在室内"靠高频没了，而不是靠变小声。
    const muffle = ctx.createBiquadFilter()
    muffle.type = 'lowpass'
    muffle.frequency.value = mix.muffle
    muffle.Q.value = 0.5
    out.connect(muffle)
    muffle.connect(dry)

    const nodes: AudioNode[] = [out, muffle]
    const sources: AudioScheduledSourceNode[] = []

    // --- 层 1：低频风。布朗噪声过 380Hz 低通，0.07Hz 的 LFO 让截止在 ±170Hz 摆动：
    // 固定截止的噪声听着像空调，不像旷野。
    const windSrc = ctx.createBufferSource()
    windSrc.buffer = wind
    windSrc.loop = true
    const windLp = ctx.createBiquadFilter()
    windLp.type = 'lowpass'
    windLp.frequency.value = 380
    windLp.Q.value = 0.6
    const windLfo = ctx.createOscillator()
    windLfo.type = 'sine'
    windLfo.frequency.value = 0.07
    const windDepth = ctx.createGain()
    windDepth.gain.value = 170
    windLfo.connect(windDepth)
    windDepth.connect(windLp.frequency)
    const windGain = ctx.createGain()
    windGain.gain.setValueAtTime(0.0001, now)
    windGain.gain.linearRampToValueAtTime(WIND_LEVEL * mix.wind, now + 2.5)
    windSrc.connect(windLp)
    windLp.connect(windGain)
    windGain.connect(out)

    // --- 层 1b：阵风。同一个 buffer 换 0.7 倍速放，两条不相关的布朗噪声叠起来才有
    // "风一阵一阵"的感觉（单条只是嘶嘶）。
    const gustSrc = ctx.createBufferSource()
    gustSrc.buffer = wind
    gustSrc.loop = true
    gustSrc.playbackRate.value = 0.7
    const gustBp = ctx.createBiquadFilter()
    gustBp.type = 'bandpass'
    gustBp.frequency.value = 720
    gustBp.Q.value = 0.9
    const gustLfo = ctx.createOscillator()
    gustLfo.type = 'sine'
    gustLfo.frequency.value = 0.043
    const gustDepth = ctx.createGain()
    gustDepth.gain.value = 0.45
    const gustGain = ctx.createGain()
    gustGain.gain.value = 0
    gustLfo.connect(gustDepth)
    gustDepth.connect(gustGain.gain)
    gustSrc.connect(gustBp)
    gustBp.connect(gustGain)
    gustGain.connect(out)

    // --- 层 2/3/4 的子总线：区域配比直接乘在这里，事件本身不用知道区域。
    const cricketGain = ctx.createGain()
    cricketGain.gain.value = mix.cricket
    cricketGain.connect(out)
    const critterGain = ctx.createGain()
    critterGain.gain.value = mix.critter
    critterGain.connect(out)
    const bellGain = ctx.createGain()
    bellGain.gain.value = mix.bell
    bellGain.connect(out)

    windSrc.start(now)
    windLfo.start(now)
    gustSrc.start(now)
    gustLfo.start(now)
    sources.push(windSrc, windLfo, gustSrc, gustLfo)
    nodes.push(windSrc, windLp, windLfo, windDepth, windGain, gustSrc, gustBp, gustLfo, gustDepth, gustGain, cricketGain, critterGain, bellGain)

    this.ambience = { out, muffle, windGain, cricketGain, critterGain, bellGain, nodes, sources }
    this.scheduleCricket()
    this.scheduleCritter()
    this.scheduleBell()
  }

  private scheduleAmbienceRetry(): void {
    if (this.disposed || this.retryTimer !== null) return
    if (this.ambienceRetries <= 0) return
    this.ambienceRetries -= 1
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      if (this.ambienceWanted && this.ambience === null) this.startAmbienceNow()
    }, AMBIENCE_RETRY_MS)
  }

  /** 虫鸣：2~5 个极短的高频脉冲（带通 4400~5800Hz，Q18）。周期随机，绝不规律。 */
  private cricket(dest: AudioNode): void {
    const noise = this.noise
    const o = this.open({ dest, priority: PRIORITY.ambience, level: 0.03, wet: 0.3 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.01
    const freq = 4400 + Math.random() * 1400
    const pulses = 2 + Math.floor(Math.random() * 4)
    let cursor = t
    for (let i = 0; i < pulses; i++) {
      shake(ctx, recipe, input, {
        noise,
        at: cursor,
        peak: CRICKET_LEVEL * (0.6 + Math.random() * 0.4),
        attack: 0.004,
        dur: 0.028,
        type: 'bandpass',
        freq,
        q: 18,
      })
      cursor += 0.045 + Math.random() * 0.03
    }
    this.seal(o)
  }

  /** 飞禽：猫头鹰（两声气声长音）或乌鸦（2~3 个沙哑音节，带通 900 Q6）。 */
  private critter(dest: AudioNode): void {
    const noise = this.noise
    const o = this.open({ dest, priority: PRIORITY.ambience, level: 0.05, wet: 0.4 })
    if (o === null) return
    if (noise === null) {
      this.seal(o)
      return
    }
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.02
    if (Math.random() < 0.55) {
      // 猫头鹰：低通 1100 才像"从林子深处传来的"，否则太近。
      tone(ctx, recipe, input, { type: 'sine', from: 392, to: 352, at: t, peak: CRITTER_LEVEL * 0.8, attack: 0.06, dur: 0.22, lp: 1100 })
      tone(ctx, recipe, input, { type: 'sine', from: 372, to: 330, at: t, peak: CRITTER_LEVEL * 0.6, attack: 0.07, dur: 0.24, lp: 1000, lag: 0.3 })
    } else {
      const blips = 2 + Math.floor(Math.random() * 2)
      let cursor = t
      for (let i = 0; i < blips; i++) {
        const dur = 0.07 + Math.random() * 0.05
        tone(ctx, recipe, input, { type: 'sawtooth', from: 820 + i * 45, to: 430, at: cursor, peak: CRITTER_LEVEL, attack: 0.01, dur, lp: 1600 })
        cursor += dur + 0.045
      }
      shake(ctx, recipe, input, { noise, at: t, peak: 0.02, attack: 0.02, dur: 0.6, type: 'bandpass', freq: 900, q: 6 })
    }
    this.seal(o)
  }

  /**
   * 极远处的钟声 / 管风琴残响。
   *
   * 钟的分音是 2.0 / 2.76 / 5.4 倍 —— 不成整数比，所以听起来"金属"而不是"音高"。
   * 管风琴用一个小三和弦长音 + 0.6s 慢起音，靠混响送出 0.9 制造"很远的大空间"。
   */
  private bell(dest: AudioNode): void {
    const o = this.open({ dest, priority: PRIORITY.ambience, level: 0.04, wet: 0.9 })
    if (o === null) return
    const { ctx, recipe, input } = o
    const t = ctx.currentTime + 0.02
    if (Math.random() < 0.6) {
      const f = 165 + Math.random() * 55
      tone(ctx, recipe, input, { from: f, at: t, peak: BELL_LEVEL, attack: 0.02, dur: 3.6 })
      tone(ctx, recipe, input, { from: f * 2.76, at: t, peak: BELL_LEVEL * 0.5, attack: 0.02, dur: 2.6, lag: 0.01 })
      tone(ctx, recipe, input, { from: f * 5.4, at: t, peak: BELL_LEVEL * 0.25, attack: 0.02, dur: 1.8, lag: 0.02 })
    } else {
      // C 小三和弦（130.8 / 155.6 / 196 / 261.6Hz）× 慢起音 ≈ 远处的管风琴
      for (const f of [130.8, 155.6, 196, 261.6]) {
        tone(ctx, recipe, input, { from: f, at: t, peak: BELL_LEVEL * 0.42, attack: 0.6, dur: 4.2, lp: 1200 })
      }
    }
    this.seal(o)
  }

  private scheduleCricket(): void {
    if (this.cricketTimer !== null) return
    this.cricketTimer = window.setTimeout(() => {
      this.cricketTimer = null
      const rig = this.ambience
      if (this.disposed || rig === null) return
      this.cricket(rig.cricketGain)
      this.scheduleCricket()
    }, 2200 + Math.random() * 5500)
  }

  private scheduleCritter(): void {
    if (this.critterTimer !== null) return
    this.critterTimer = window.setTimeout(() => {
      this.critterTimer = null
      const rig = this.ambience
      if (this.disposed || rig === null) return
      this.critter(rig.critterGain)
      this.scheduleCritter()
    }, 9000 + Math.random() * 21000)
  }

  private scheduleBell(): void {
    if (this.bellTimer !== null) return
    this.bellTimer = window.setTimeout(() => {
      this.bellTimer = null
      const rig = this.ambience
      if (this.disposed || rig === null) return
      this.bell(rig.bellGain)
      this.scheduleBell()
    }, 35000 + Math.random() * 75000)
  }

  /** 停掉环境声（保留"想要"标记，下次 unlock 会自动回来）。 */
  stopAmbience(fade = 0.4): void {
    this.clearTimer("cricket")
    this.clearTimer("critter")
    this.clearTimer("bell")
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const rig = this.ambience
    const ctx = this.ctx
    this.ambience = null
    if (rig === null || ctx === null) return
    const now = ctx.currentTime
    rig.out.gain.cancelScheduledValues(now)
    rig.out.gain.setTargetAtTime(0.0001, now, Math.max(fade, 0.01) / 3)
    for (const source of rig.sources) {
      try {
        source.stop(now + fade + 0.05)
      } catch {
        // 已经停了
      }
    }
    window.setTimeout(() => {
      for (const node of rig.nodes) {
        try {
          node.disconnect()
        } catch {
          // 重复 disconnect 忽略
        }
      }
    }, (fade + 0.2) * 1000)
  }

  private clearTimer(which: 'cricket' | 'critter' | 'bell'): void {
    const timer = which === 'cricket' ? this.cricketTimer : which === 'critter' ? this.critterTimer : this.bellTimer
    if (timer === null) return
    window.clearTimeout(timer)
    if (which === 'cricket') this.cricketTimer = null
    else if (which === 'critter') this.critterTimer = null
    else this.bellTimer = null
  }

  // ---------------------------------------------------------------- 心跳

  /**
   * 血量。低于 40% 开始心跳，而且**血量越低越快**（62 → 128bpm）。
   *
   * 心跳是最廉价的信息通道：玩家不用看 HUD 就知道自己快死了，而 128bpm 的
   * 心跳比任何"HP 低"提示都更让人想跑。
   */
  setHealth(health: number, maxHealth = 150): void {
    const max = Number.isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 150
    this.health = { value: clamp(Number.isFinite(health) ? health : max, 0, max), max }
    if (this.health.value / this.health.max >= HEARTBEAT_LOW) {
      this.clearHeartbeat()
      return
    }
    if (this.heartTimer === null) this.beat()
  }

  private clearHeartbeat(): void {
    if (this.heartTimer === null) return
    window.clearTimeout(this.heartTimer)
    this.heartTimer = null
  }

  private beat(): void {
    this.heartTimer = null
    if (this.disposed) return
    const ratio = this.health.value / this.health.max
    if (!(ratio > 0) || ratio >= HEARTBEAT_LOW) return
    const urgency = 1 - ratio / HEARTBEAT_LOW
    const bpm = 62 + urgency * 66
    const peak = 0.22 + urgency * 0.14
    // 第一声"咚"是心室收缩，第二声轻一点是动脉回弹；两下之间 160ms。
    this.heartThump(0, peak)
    this.heartThump(0.16, peak * 0.7)
    this.heartTimer = window.setTimeout(() => this.beat(), Math.max(320, 60000 / bpm))
  }

  private heartThump(delay: number, peak: number): void {
    const o = this.open({ priority: PRIORITY.self, level: 0.4, wet: 0 })
    if (o === null) return
    // 55Hz 附近几乎是纯冲击：心跳在胸腔里，一点高频都不该有（低通 200Hz）。
    tone(o.ctx, o.recipe, o.input, {
      type: 'sine',
      from: 58,
      to: 40,
      at: o.ctx.currentTime + 0.004 + delay,
      peak,
      attack: 0.012,
      dur: 0.16,
      lp: 200,
    })
    this.seal(o)
  }

  // ---------------------------------------------------------------- 调试

  /** 给 CDP 验证/泄漏排查用的快照。游戏本身不调它。 */
  debugStats(): {
    state: string
    sampleRate: number
    masterGain: number
    volume: number
    voices: number
    sources: number
    nodes: number
    panners: number
    dropped: number
    ambienceLayers: number
    bias: AmbienceBias
    listener: { x: number; y: number; z: number; fx: number; fz: number }
    health: { value: number; max: number }
    spatial: { distance: number; gain: number; cutoff: number; wet: number; occluded: boolean; panning: string }
  } {
    const ctx = this.ctx
    const mate = this.master
    const bus = this.bus
    const rig = this.ambience
    return {
      state: ctx === null ? 'none' : ctx.state,
      sampleRate: ctx === null ? 0 : ctx.sampleRate,
      masterGain: mate === null ? 0 : mate.gain.value,
      volume: this.volume,
      voices: bus === null ? 0 : bus.size,
      sources: bus === null ? 0 : bus.activeSources,
      nodes: bus === null ? 0 : bus.activeNodes,
      panners: this.panners,
      dropped: this.dropped,
      ambienceLayers: rig === null ? 0 : rig.sources.length,
      bias: this.bias,
      listener: {
        x: this.listenerPos.x,
        y: this.listenerPos.y,
        z: this.listenerPos.z,
        fx: this.listenerForward.x,
        fz: this.listenerForward.z,
      },
      health: { value: this.health.value, max: this.health.max },
      spatial: { ...this.lastSpatial },
    }
  }

  // ---------------------------------------------------------------- 收尾

  /** 关上下文并拆掉所有常驻节点。之后这个实例不可再用（时间不会倒流）。 */
  dispose(): void {
    this.disposed = true
    this.ambienceWanted = false
    this.clearHeartbeat()
    this.clearTimer("cricket")
    this.clearTimer("critter")
    this.clearTimer("bell")
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    // 先淡后拆：上下文马上就要 close，我不指望 onended 再来替我们收尾。
    this.bus?.hushAll(0.02)
    this.stopAmbience(0.02)

    this.dry?.disconnect()
    this.reverbSend?.disconnect()
    this.convolver?.disconnect()
    this.reverbReturn?.disconnect()
    this.master?.disconnect()
    this.compressor?.disconnect()

    const ctx = this.ctx
    this.ctx = null
    this.master = null
    this.compressor = null
    this.dry = null
    this.convolver = null
    this.reverbSend = null
    this.reverbReturn = null
    this.bus = null
    this.noise = null
    this.wind = null
    this.panners = 0
    if (ctx !== null && ctx.state !== 'closed') void ctx.close()
  }
}
