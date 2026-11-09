/**
 * 客户端主循环：预测、和解、插值、把结果交给渲染层。
 *
 * ## 三条时间线，必须分清
 *
 * 1. **本地输入时间线**：玩家按键 → 立刻在本地物理里跑一遍 → 相机跟着动。
 *    这条线是 0 延迟的，手感就靠它。它算出来的位置是"我的猜测"。
 * 2. **服务端权威时间线**：每 20Hz 一份快照，带着"我处理到你的第几个输入"。
 *    它会把我的猜测纠正回来 —— 但如果每帧照抄服务器位置，画面就会一抖一抖。
 * 3. **远端玩家的插值时间线**：别人的位置只能从快照得知，所以刻意
 *    **延后 `INTERP_DELAY_MS` 播放**，用两帧之间的插值把 20Hz 填成 60fps。
 *
 * 这三条线搞混的典型症状：把远端玩家也拿"最新快照"直接渲染 → 他们
 * 瞬移；拿服务端位置直接覆盖本地 → 自己走路一顿一顿。
 */

import {
  BOUNTY_VALUE,
  Buttons,
  Character,
  EventBus,
  Kernel,
  Rng,
  CLUE_TOTAL,
  CLUE_RADIUS,
  DEFAULT_WEAPON_ID,
  INTERP_DELAY_MS,
  MATCH_SECONDS,
  KNIFE_HEAVY_INTERVAL_MS,
  MAX_INPUTS_PER_PACKET,
  MONSTER_SPECS,
  SCOPE_MIN_ZOOM,
  SNAPSHOT_RATE,
  SPOT_ID_NONE,
  StateFlags,
  TICK_DT,
  TICK_MS,
  Trait,
  WEAPONS,
  fireIntervalScale,
  switchScale,
  buildLevelWorld,
  attachmentOf,
  CONTRACTS,
  setDoorOpen,
  clamp,
  getModifier,
  initPhysics,
  isBossKind,
  isPersonalEscape,
  lairOf,
  loreOf,
  monsterKindFromCode,
  bossNameOf,
  traceShot,
  weaponForSlot,
  wrapAngle,
  type FrameTime,
  type GameEvent,
  type LevelDef,
  type LootItem,
  type LootPacket,
  type ObjectivePacket,
  type PlayerInput,
  type PlayerSnapshot,
  type Snapshot,
  type Vec3,
} from '@dk/shared'

import type { World as PhysicsWorld } from '@dimforge/rapier3d-compat'

import { AudioKit } from './audio.ts'
import { Feedback } from './feedback.ts'
import { createObjectiveHud, type ObjectiveHud, type ObjectiveModel } from './hud.ts'
import { createMapOverlay, type MapOverlay } from './map.ts'
import { InputController, SLOT_CYCLE_BACK, SLOT_CYCLE_FORWARD } from './input.ts'
import { Net, type CloseInfo } from './net.ts'
import { Renderer } from './render.ts'
import { impactSurfaceOf, surfaceAt } from './surfaces.ts'
import type { MarkerClue, ObjectiveView } from './markers.ts'
import type { ImpactKind } from './vfx.ts'
import type { MonsterView } from './monsters.ts'
import { loadSavedSettings, type GraphicsQuality, type MenuSettings } from './settings.ts'

/** 空数组常量：每帧给罗盘传"没有撤离点"时不分配新数组。 */
const NO_POINTS: { x: number; z: number }[] = []

/**
 * 客户端内核事件表。
 *
 * 只放"跨阶段的事实"，不放每帧连续状态：连续状态走系统公开 getter，
 * 事件走这里。新增事件必须同时写清谁发、谁收、在 fixed 还是 update 阶段。
 */
interface ClientEvents {
  resize: { width: number; height: number }
}

/** 内核上下文：所有系统共享的只读入口。`time` 必须指向 kernel.clock.time。 */
interface ClientContext {
  readonly events: EventBus<ClientEvents>
  readonly time: FrameTime
  readonly game: Game
  /** 本渲染帧的 rAF 时间戳（ms）。只有 update 阶段的系统需要。 */
  now: number
}

/**
 * 客户端随机种子。`?seed=` 固定它，无头截图/回放才能逐帧对齐；
 * 不传时只在这里取一次 Math.random，之后所有表现随机都走 Rng。
 */
function seedFromLocation(): number {
  try {
    const raw = new URLSearchParams(location.search).get('seed')
    if (raw !== null && /^\d+$/.test(raw)) return Number.parseInt(raw, 10) >>> 0
  } catch {
    // 非浏览器/被裁掉的 location：退回流随机种子。
  }
  return (Math.random() * 0x100000000) >>> 0
}

/** 可访问性：镜头运动强度。 */
function motionScaleOf(setting: MenuSettings['cameraMotion']): number {
  return setting === 'off' ? 0 : setting === 'reduced' ? 0.45 : 1
}

/**
 * 一局结束后多久弹结算卡。
 *
 * 2.4 秒：给"撤离成功 / 狩猎失败"的横幅留出读完的时间，又不至于让输了的人
 * 盯着空场地发呆。横幅与卡片同时出现会让前者白播。
 */
const RESULT_DELAY_MS = 2400
/** 空仓"咔"的最短间隔（ms）。 */
const DRY_FIRE_GAP_MS = 320

/** 可搜容器的中文名。服务端只给类型码，措辞留在客户端。 */
const SEARCH_LABEL: Record<string, string> = {
  crate: '搜索木箱',
  sack: '翻找麻袋',
  corpse: '搜查尸体',
}

/** 走多少米算一步。不按时间算：站着不动不该有脚步声。 */
const STEP_DISTANCE = 2.1
/** 疾跑时步幅更长。 */
const STEP_DISTANCE_SPRINT = 2.9

/** 预测位置与服务端位置差多少米以上才做硬和解。 */
const RECONCILE_EPSILON = 0.06

/** 保留多少毫秒的快照用于插值。 */
const SNAPSHOT_BUFFER_MS = 1000

/**
 * 一帧最多补跑几个固定步。
 *
 * 上限取 8 = `MAX_INPUTS_PER_PACKET`：一个包塞得下多少条输入，就决定
 * 了一帧最多能提交多少条。超过就得丢时间，不能塞进两个包 ——
 * 拆包会让服务端把同一帧的输入分摊到两个 tick 消费，动作被拉长。
 */
const MAX_LOCAL_STEPS = 8

interface PendingInput {
  input: PlayerInput
  /** 应用这个输入之后我预测的脚底位置，用于事后比对。 */
  predicted: Vec3
}

interface RemoteState {
  /** 按 serverTime 排序的快照样本，插值用。 */
  samples: { time: number; player: PlayerSnapshot }[]
  /** 上一次快照的位置/时间：用来累积步幅、推断冲刺。 */
  lastX: number
  lastZ: number
  lastTime: number
  /** 已经走过多少米还没放一步（按步幅触发，不按时间）。 */
  stepAccum: number
  /** 上一帧是否在换弹：只在翻转时放一次开仓/上膛。 */
  reloading: boolean
}

export interface GameOptions {
  container: HTMLElement
  level: LevelDef
  matchId: string
  nickname: string
  /**
   * 大厅里选的主武器（`PRIMARY_CHOICES` 之一）。
   *
   * 握手的 Hello 只表达"我是谁、我要进哪张图"，配装单独走一条 Msg.Loadout：
   * 这样服务端能明确判断"这个人还没开过枪，允许换"，而不用去猜 Hello 的
   * 哪个可选段是配装。
   */
  primaryId: number
  /** 本局带的天赋掩码（见 shared/src/traits.ts）。局中不变。 */
  traits: number
  /** 本局合同 id（见 shared/src/contracts.ts）。0 = 不接。 */
  contract?: number
  /** 随身补给位图（bit0 绷带、bit1 备弹）。 */
  extras?: number
  /** 主武器配件 id（见 shared/src/attachments.ts）。 */
  attachment?: number
  /**
   * 某条天赋刚起了作用。HUD 那颗徽记会闪一下 —— 天赋是看不见的数值加成，
   * 不给这一下反馈，玩家永远不知道自己买的天赋到底生效没有。
   */
  onTraitFx?: (bit: number) => void
  onStatus: (text: string) => void
  /** 连接关闭。带 code/transient，靠它决定重连还是回大厅。 */
  onClose: (info: CloseInfo) => void
  onHud: (hud: HudState) => void
  /**
   * 一局结束、横幅播完之后才调：先让"撤离成功 / 狩猎失败"四个字落进眼里，
   * 再盖结算卡。同帧弹卡片会把那句话吞掉，玩家只记得"突然一片黑"。
   */
  onResult: (result: MatchResult) => void
  /** 服务端发给本人的一句话（搜到什么东西）。可选：探针脚本里不需要 UI。 */
  onText?: (text: string) => void
  /**
   * 线索文献：捡到一条线索 / 集齐三条解开封印时，弹一张可读的卡片。
   *
   * 走回调而不是 overlay 自己的单例：Game 不该知道界面长什么样，探针里也
   * 不需要 DOM（没有这个回调就只是不弹）。
   */
  onLore?: (card: LoreCard) => void
}

/** 一张线索文献。clue 是单条线索，seal 是三条集齐后的解语。 */
export interface LoreCard {
  kind: 'clue' | 'seal'
  /** 线索序号（0..2）；解语固定 CLUE_TOTAL。 */
  index: number
  title: string
  body: string
  glyph: string
  /** 只有解语有：三个字拼起来的"答案"。 */
  word: string
}

/**
 * 一局的结算数据。
 *
 * 只带数字与物品，不带措辞：怎么说"这一趟值不值"是 UI 的事，这里一旦写死文案，
 * 以后想改口就得动游戏逻辑。赏金价值在客户端算 —— 服务端的 carriedValue 只统计
 * 搜刮现金，两边都加会重复计一次。
 */
export interface MatchResult {
  escaped: boolean
  /** 搜刮到的现金（美元）。 */
  lootValue: number
  /** 带出赏金的额外价值；0 = 没带出来。 */
  bountyValue: number
  items: LootItem[]
}

export interface HudState {
  health: number
  ammo: number
  /** 当前槽位备弹（不含弹匣内）。 */
  reserve: number
  reloading: boolean
  weaponName: string
  ping: number
  tick: number
  fps: number
  /** 身上搜到的现金，结算与 HUD 共用。 */
  lootValue: number
  /** 正在搜的进度 0..100。 */
  searchPct: number
  /** 身边可搜点的提示文案；空串 = 附近没有能搜的东西。 */
  searchLabel: string
  /** 是否站在未收集线索的 CLUE_RADIUS 内。 */
  clueNear: boolean
  /** 该线索的收集进度 0..100；0 = 还没开始。 */
  cluePct: number
  /** 是否在开镜（右键按住）。腰射才显示准星。 */
  ads: boolean
  /** 当前武器带镜且已开镜：显示镜筒遮罩与分划，隐藏准星。 */
  scoped: boolean
  /** 本局带的天赋掩码（HUD 那一排徽记靠它决定亮哪个）。 */
  traits: number
  /** 背包里还剩几条绷带。 */
  bandages: number
  /** 包扎进度 0..100。 */
  healPct: number
  /** 场上那只 Boss 的血量百分比 0..100；-1 = 它还没出笼。 */
  bossPct: number
  /** Boss 种类码（3..6）；-1 = 没有。血条据此换名字。 */
  bossKind: number
  /** 本局的天气修正名（死寂 / 浓雾 / 骤雨 / 虫潮）。 */
  modifierName: string
  /** 修正的一句话说明，卡在 HUD 角上一局。 */
  modifierDesc: string
}

export class Game {
  /**
   * 客户端运行时内核。
   *
   * 它只负责三件事：固定步换算、系统顺序、生命周期。预测、远端插值、
   * 渲染、反馈分别注册成系统；Game 保留状态与网络语义，但不再手写
   * "累加器 + 三个 if" 的主循环。服务端仍然权威 —— 内核不改变任何
   * 权威判定，只让客户端的相位顺序有唯一出处。
   */
  private readonly kernel: Kernel<ClientContext>
  private readonly events = new EventBus<ClientEvents>()
  private readonly ctx: ClientContext
  /** 客户端视觉/表现随机流。与 shared 的玩法 RNG 分开，避免扰动服务端复现。 */
  private readonly rng = new Rng(seedFromLocation())
  private frameNow = 0
  private lastKernelSteps = 0

  private readonly net = new Net()
  private readonly input: InputController
  private readonly renderer: Renderer
  private world: PhysicsWorld | null = null
  private character: Character | null = null

  private myId = 0
  private seq = 0
  private pending: PendingInput[] = []
  private remote = new Map<number, RemoteState>()
  private lastSnapshot: Snapshot | null = null
  private lastAckSeq = 0
  private ackedTick = 0

  /** 服务端时钟与本机时钟的偏移，用来把 serverTime 映射到本机时间轴。 */
  private clockOffset = 0
  private clockSynced = false

  private running = false
  private raf = 0
  private lastFrameAt = 0
  private fpsAccum = 0
  private fpsFrames = 0
  private fps = 0
  private lastHudAt = 0
  private localCursor = 0

  /**
   * 每帧各阶段耗时的移动平均（毫秒）。
   *
   * 只有把"模拟 / 网络 / 渲染"三段分开计时，才能回答"10fps 是 CPU 还是 GPU"。
   * 一次性采样抖动太大，用 1/8 的指数平均，读数稳定又跟得上变化。
   */
  private costSim = 0
  private costNet = 0
  private costDraw = 0
  /** 帧时间移动平均（毫秒）与降分辨率后的冷却帧数，见 adaptResolution。 */
  private frameMs = 16.7
  private scaleCooldown = 0
  private viewWidth = 1
  private viewHeight = 1

  /** 本帧已模拟、还没发出去的输入。 */
  private unsent: PlayerInput[] = []

  /**
   * 最近一次战利品包（只发给我本人）。
   *
   * 不并进快照：快照里每人每帧 34 字节、20Hz，是全链路最敏感的数字，
   * 而搜刮进度是低频状态。缓存这一份，HUD 与结算都以它为准。
   */
  private loot: LootPacket | null = null
  /** 结算卡片的延迟句柄：横幅要先播完。 */
  private resultTimer = 0

  /** 场上 Boss 的血量百分比；-1 = 还没出笼。 */
  private bossPct = -1
  /** 场上的 Boss 种类码（3..6）；-1 = 没有。血条名字靠它切换。 */
  private bossKind = -1
  /** 上一份快照里有没有 Boss：用它播"出笼吼"与"倒下"，两者都不是事件包。 */
  private bossSeen = false
  /** 已经弹过文献的线索位。重复弹同一张卡比不弹更烦人。 */
  private loreBits = 0
  /** 当前生效的天气修正 id；-1 = 还没收到过目标包。 */
  private modifierId = -1

  private readonly audio = new AudioKit()
  private readonly feedback: Feedback
  /** 已走过的距离，攒够一个步幅就响一次脚声。 */
  private stepAccum = 0
  private lastFeet: Vec3 | null = null

  /**
   * 玩家设置：进场时从 localStorage 读一次，之后由 setSettings 更新。
   *
   * 刻意由 Game 自己读而不是让 main.ts 传进来：settings.ts 是纯数据模块，
   * 而 main.ts 已经要管 DOM、主界面、进出场了，再让它当设置的二传手，
   * 任何一次"忘记透传"都会让滑条看起来没反应。
   */
  private settings: MenuSettings = loadSavedSettings()
  /** 当前实际画质档（auto 会被解析成具体档；运行中只在持续掉帧时降档）。 */
  private qualityTier: 'performance' | 'balanced' | 'quality' = 'balanced'
  /** 连续多少帧明显超标；满 60 帧才动分辨率/画质，避免被单次尖峰带着抖。 */
  private lowFrameFrames = 0
  /**
   * 本地角色最近两个固定步的脚底位置/眼高，用于渲染插值。
   *
   * 旧实现直接把 60Hz 的预测位置塞给相机：144Hz 屏幕上位置每 16.7ms 跳一次、
   * 视角每帧都在转，读起来就是"移动卡卡的"。`kernel.clock.time.alpha` 本来
   * 就是为这件事准备的，只是之前没用上。
   */
  private readonly prevFeet = { x: 0, y: 0, z: 0 }
  private readonly currFeet = { x: 0, y: 0, z: 0 }
  private readonly renderFeet = { x: 0, y: 0, z: 0 }
  private prevEyeHeight = 1.62
  private currEyeHeight = 1.62
  private renderEyeHeight = 1.62
  private hasFeetSample = false
  /** 和解造成的视觉残差：物理立刻对齐，相机用 0.12s 追上，避免 6cm 硬跳。 */
  private readonly reconcileOffset = { x: 0, y: 0, z: 0 }
  /** 渲染脚底 y 的低通，滤掉胶囊 snap-to-ground/台阶的厘米级抖动。 */
  private smoothedFeetY = 0
  /** 贴墙程度 0..1：视图模型据此把枪压下，避免画穿墙。 */
  private wallBlock = 0
  private readonly wallDir = { x: 0, y: 0, z: 0 }

  constructor(private readonly options: GameOptions) {
    this.kernel = new Kernel<ClientContext>({
      hz: 60,
      // 上限不是一个"性能参数"，而是协议参数：一包最多 8 条输入，
      // 一帧最多补 8 步，才能保证每帧只发一个输入包。
      maxSubsteps: MAX_LOCAL_STEPS,
      maxFrameDt: 0.1,
    })
    this.ctx = {
      events: this.events,
      time: this.kernel.clock.time,
      game: this,
      now: 0,
    }
    this.renderer = new Renderer(options.container, options.level)
    // 反馈层挂 body 而不是 #app：镜筒 #scope 是 fixed 层（z-index 5），
    // #app 会形成自己的层叠上下文，挂在里面的命中标记/击杀播报会被镜筒
    // 一起吃掉。body 直属 + z-index 8 让它稳定压在镜筒之上。
    this.feedback = new Feedback({ container: document.body })
    this.viewWidth = options.container.clientWidth || window.innerWidth
    this.viewHeight = options.container.clientHeight || window.innerHeight
    this.renderer.setFov(this.settings.fov)
    this.renderer.setBrightness(this.settings.brightness)
    this.renderer.setMotionScale(motionScaleOf(this.settings.cameraMotion))
    this.renderer.setRenderScale(this.settings.renderScale)
    // 第一帧前按 GPU/设置定型：核显/软件渲染直接从性能档起步，
    // 避免"先卡十秒再自动降档"。
    this.applyGraphicsQuality(this.settings.graphics)
    this.audio.setVolume(this.settings.volume)
    // 目标 HUD 单独一层（hud.css 里 position:fixed、z-index:7），挂 body
    // 而不是 #app：它必须能盖在镜筒遮罩上，开镜时计时/线索/撤离进度仍然可读。
    this.objectiveHud = createObjectiveHud(document.body)
    this.mapOverlay = createMapOverlay(options.level)
    this.objectiveHud.update(this.objectiveModel(null))

    // 标记的视图对象在这里一次建好，之后每帧只改字段。
    this.lair = lairOf(options.level)
    this.markerClues = (options.level.clues ?? []).map((clue) => ({ x: clue.x, z: clue.z, found: false }))
    this.markerView = {
      phase: 'hunt',
      clues: this.markerClues,
      activeClue: -1,
      clueProgress: 0,
      lairX: this.lair.x,
      lairZ: this.lair.z,
      lairRevealed: false,
      banishProgress: 0,
      bountyAt: null,
      myX: 0,
      myY: 0,
      myZ: 0,
      extracts: options.level.extracts ?? [],
      extractIndex: -1,
      extractProgress: 0,
      event: 0,
      eventX: 0,
      eventZ: 0,
      eventSeconds: 0,
    }
    // 手上这把枪从开局就得是"大厅里选的那把"：以前初值写死 DEFAULT_WEAPON_ID，
    // 只有切槽才会重算，于是选了神射手步枪进局还是端着温菲尔德的模型，
    // 倍镜、后坐力、换弹速度也全按温菲尔德走（服务端给的伤害却是对的）。
    this.heldWeapon = weaponForSlot(options.primaryId, 0)
    this.input = new InputController(this.renderer.canvas, (locked) => {
      if (!locked) options.onStatus('已释放鼠标 · 点击画面继续')
      // 每次点回画面都是一次真实手势，顺手把音频上下文捞起来 ——
      // Chrome 在标签页失焦后会挂起 AudioContext，不 resume 就永久静音。
      else void this.audio.unlock().then(() => this.audio.startAmbience())
    })
    this.input.applySettings(this.settings)

    // 注册顺序就是声明，依赖关系由 deps 兜底。这里刻意把四个阶段拆开：
    // 固定步只跑预测（一个 tick 一个输入），update 先做远端插值再做表现，
    // lateUpdate 只放"必须看到最终画面状态"的反馈（DOM/粒子收尾）。
    this.kernel
      .add('prediction', { fixedUpdate: () => this.fixedStep() })
      .add('replication', { update: () => this.updateReplication() }, ['prediction'])
      .add('presentation', { update: (dt) => this.updatePresentation(dt) }, ['replication'])
      .add('feedback', { lateUpdate: (dt) => this.feedback.update(dt) }, ['presentation'])
      .add('viewport', { resize: (width, height) => this.renderer.setSize(width, height) })
  }

  /**
   * 必须在真实用户手势里调用（点"进入沼泽"那一刻）。
   *
   * 音频上下文在手势之外创建会一直停在 suspended，之后所有声音都是静音的，
   * 而且不会报错 —— 这是 WebAudio 最典型的"什么都没坏但就是没声音"。
   */
  async unlockAudio(): Promise<void> {
    await this.audio.unlock()
    this.audio.startAmbience()
  }

  /** 防止 onWelcome 重入时启动两条 rAF 循环。 */
  private starting = false

  /**
   * 进局前的最后一步：预编译着色器 → 显示 GPU 提示 → 启动帧循环。
   *
   * 预编译失败只记日志；任何情况下都要把 running 打开，不能让玩家卡在
   * 加载页上。预热期间收到的快照照常写状态，只是不渲染。
   */
  private async beginAfterPrewarm(): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      await this.renderer.prewarm()
    } finally {
      const gpu = this.renderer.gpuInfo()
      // 核显/软件渲染时给一条看得见的提示。第三档已放弃这两类硬件：
      // 仍然允许进游戏看画面，但不再承诺帧率，也不再自动退回卡通档。
      this.options.onStatus(
        gpu.integrated || gpu.software
          ? '核显/软件渲染不在支持范围 · 已使用均衡写实画质 · 独显设置见 docs/显卡与性能.md'
          : '',
      )
      this.running = true
      this.lastFrameAt = performance.now()
      this.raf = requestAnimationFrame(this.frame)
    }
  }

  async start(): Promise<void> {
    await initPhysics()
    // 先换掉程序化占位贴图，再建世界/进局：避免进图后贴图才"啪"地跳出来。
    await this.renderer.loadTextures()
    // 程序化松树先加载：它决定 nature-assets 是否还要种那套 CC0 枯树。
    await this.renderer.loadGenerated()
    await this.renderer.loadNature()
    await this.renderer.loadVillage()
    await this.kernel.init(this.ctx)
    this.world = buildLevelWorld(this.options.level)

    // 第三个参数是"本地已经按哪张图建好了世界"，会随 Hello 发给服务端；
    // 服务端若早就给这个 matchId 定了别的图，net 层会整页重载对齐。
    this.net.connect(
      this.options.matchId,
      this.options.nickname,
      this.options.level.id,
      this.options.primaryId,
      this.options.traits,
      this.options.contract ?? 0,
      this.options.extras ?? 0,
      this.options.attachment ?? 0,
      {
      onWelcome: (info) => {
        this.myId = info.playerId
        this.clockOffset = info.serverTime - performance.now()
        this.clockSynced = true
        this.character = new Character(this.world!, info.spawn)
        // 出生后先 step 一次，让新碰撞体进入本地物理世界。
        this.world!.step()
        this.resetFeetSample()
        // 出生朝向：面朝地图中心，而不是面朝 -Z。
        // 0 度朝向在 12 个出生点里有一半正对着一面 3m 高的农舍外墙 ——
        // 玩家进游戏第一眼看到的是"一堵墙贴到脸上"，会以为是贴图错误。
        // 朝中心既能立刻看见地标（农舍/石台），也保证前方至少有一段视野。
        this.input.reset(yawToward(info.spawn, { x: 0, y: 0, z: 0 }), 0)
        // 三槽的初始弹药按各自弹匣填满（快照之后会覆盖成真值）。
        for (let slot = 0; slot < 3; slot++) {
          const id = weaponForSlot(this.options.primaryId, slot)
          this.ammoBySlot[slot] = WEAPONS[id]?.magazine ?? 0
        }
        // 沼泽/室内/开阔三种环境底噪的配比不同：进沼泽要听见虫与水，
        // 开阔地上风压过人声。地图群系决定一个初值，足够。
        this.audio.setAmbienceBias(this.options.level.biome === 'swamp' ? 'marsh' : 'open')
        // 先编译再开帧循环：否则第一帧见到的每个新材质都在主线程同步编译，
        // 玩家进局的第一眼就是几百毫秒的定格。预热只渲染、不推进模拟。
        this.options.onStatus('正在预编译着色器…')
        void this.beginAfterPrewarm()
      },
      onSnapshot: (snapshot) => this.onSnapshot(snapshot),
      onEvents: (events) => this.onEvents(events),
      onObjective: (objective) => this.onObjective(objective),
      onLoot: (loot) => this.onLoot(loot),
      onText: (text) => this.options.onText?.(text),
      onClose: (info) => {
        this.running = false
        this.clearResultTimer()
        this.options.onClose(info)
      },
    })
  }

  dispose(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.net.close()
    this.input.dispose()
    this.feedback.dispose()
    this.objectiveHud?.dispose()
    this.objectiveHud = null
    this.mapOverlay?.dispose()
    this.mapOverlay = null
    this.audio.dispose()
    this.renderer.dispose()
    this.kernel.dispose(this.ctx)
  }

  resize(width: number, height: number): void {
    this.viewWidth = width
    this.viewHeight = height
    this.kernel.resize(width, height, this.ctx)
  }

  /** 调试 HUD 用：当前 GPU 类别与画质档。 */
  gpuLabel(): string {
    return this.renderer.gpuLabel()
  }

  qualityLabel(): string {
    return this.qualityTier === 'performance' ? '性能' : this.qualityTier === 'balanced' ? '均衡' : '高清'
  }

  /** M 键：打开/关闭猎场地图。地图打开时游戏继续跑，玩家仍然暴露在危险里。 */
  toggleMap(): void {
    this.mapOverlay?.toggle()
  }

  /** 主界面改设置时调用，四条链路各自生效，不需要重开一局。 */
  setSettings(settings: MenuSettings): void {
    const prevGraphics = this.settings.graphics
    const prevRenderScale = this.settings.renderScale
    this.settings = { ...settings }
    this.input.applySettings(this.settings)
    this.renderer.setFov(this.settings.fov)
    this.renderer.setBrightness(this.settings.brightness)
    this.renderer.setMotionScale(motionScaleOf(this.settings.cameraMotion))
    // 只有画质档变了才重新定档；改灵敏度/音量不该顺手重置分辨率与 RT。
    if (settings.graphics !== prevGraphics) this.applyGraphicsQuality(settings.graphics)
    // 分辨率上限是显式操作：不再做"自动升分辨率"，所以玩家把它调高时必须
    // 立刻生效，否则滑条看起来没反应。
    if (settings.renderScale !== prevRenderScale) {
      this.renderer.setRenderScale(this.settings.renderScale)
      this.renderer.setSize(this.viewWidth, this.viewHeight)
    }
    this.audio.setVolume(this.settings.volume)
  }

  /**
   * 应用画质档。
   *
   * auto 的起点由 GPU 探测决定：独显 → quality；核显/软件渲染 → balanced
   * （写实材质仍然生效，只降采样/阴影/泛光，且不再自动退回 toon）。
   * 固定档则完全听玩家的。起始分辨率也随档位收敛，避免第一帧就顶着
   * 1080p + 4x MSAA 去编译/渲染。
   */
  private applyGraphicsQuality(mode: GraphicsQuality): void {
    if (mode === 'auto') {
      const gpu = this.renderer.gpuInfo()
      this.qualityTier = gpu.integrated || gpu.software ? 'balanced' : 'quality'
    } else {
      this.qualityTier = mode
    }
    this.renderer.setQuality(this.qualityTier)
    this.lowFrameFrames = 0
    const cap = this.qualityTier === 'performance' ? 0.65 : this.qualityTier === 'balanced' ? 0.85 : 1
    this.renderer.setRenderScale(Math.min(this.settings.renderScale, cap))
  }

  // ------------------------------------------------------------ 主循环

  private frame = (now: number): void => {
    if (!this.running) return
    // rAF 先续上再干活：任何阶段抛错时循环仍然活着，玩家不会卡死在一个
    // 静止画面里（错误会进控制台，下一帧继续尝试）。
    this.raf = requestAnimationFrame(this.frame)

    // dt 上限 100ms：切标签页回来时 dt 可能是好几秒。内核的 FixedClock
    // 再做一次夹紧与丢弃积压，这里是第一道闸。
    const rawDt = Math.min((now - this.lastFrameAt) / 1000, 0.1)
    this.lastFrameAt = now
    this.frameNow = now

    this.fpsAccum += rawDt
    this.fpsFrames++
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum
      this.fpsAccum = 0
      this.fpsFrames = 0
    }

    // 视角每渲染帧推进一次，不等模拟步：高于 60Hz 的屏幕上，只在固定步里
    // 更新会让准星一跳一跳（玩家说的"枪不跟手"）。
    this.input.meleeMode = this.heldSlot === 2
    this.input.consumeLook()
    this.ctx.now = now

    // 内核按 fixedUpdate×N → update → lateUpdate → render 的顺序推进。
    // 预测/远端插值/渲染/反馈分别注册成系统，顺序由 deps 明确，而不是
    // 靠这一处函数调用列表的书写顺序。
    const steps = this.kernel.advance(this.ctx, rawDt)
    this.lastKernelSteps = steps

    // 本帧累计的输入一次发完。拆成多个包会让服务端把它们分摊到多个 tick，
    // 动作被拉长成慢动作；而内核保证一帧最多 MAX_LOCAL_STEPS 步，
    // 正好塞进一个 InputPacket。
    if (steps > 0 && this.unsent.length > 0) {
      this.net.sendInputs(this.unsent, this.ackedTick)
      this.unsent = []
    }

    // 自适应分辨率用渲染帧时长决策，而不是固定步数：它要解决的是 GPU
    // 花在画布上的时间，和模拟跑了几步无关。
    this.adaptResolution(rawDt)
  }

  /**
   * 自适应分辨率：**只降不升**。
   *
   * 早期版本在阈值两侧自动升/降，结果每一次改分辨率都要重建 HDR 目标与
   * 泛光金字塔：帧率一好就升、升完又掉、再降 —— 玩家看到的是每隔几秒
   * 一次的顿挫，比稳定在低一点的分辨率更难受。
   *
   * 现在：连续 1 秒（60 帧）明显超标才降；降到当前画质档的下限后，仍然
   * 超标才降一档画质。升清晰度是玩家的显式操作（设置里的画质/分辨率上限），
   * 不做自动回弹。启动后 2 秒内不参与自适应，避开 shader 编译/首帧分配。
   */
  private adaptResolution(dt: number): void {
    if (dt <= 0) return
    const budget = 1000 / 60
    this.frameMs += (dt * 1000 - this.frameMs) * 0.1

    // 启动阶段：首帧 shader 编译、纹理上传、RT 分配都可能让 frameMs 飙高，
    // 这不是稳态性能，不该触发降档。
    if (this.kernel.clock.time.frame < 120) {
      this.lowFrameFrames = 0
      return
    }

    if (this.frameMs > budget * 1.45) this.lowFrameFrames++
    else this.lowFrameFrames = 0

    if (this.lowFrameFrames < 60) return
    if (--this.scaleCooldown > 0) return

    const scale = this.renderer.getScale()
    const minScale = this.renderer.getMinScale()
    const auto = this.settings.graphics === 'auto'

    if (scale > minScale + 1e-6) {
      // 先降世界分辨率。步长 0.1，且改完至少等 2.5 秒再评估下一次。
      this.renderer.setRenderScale(Math.max(minScale, scale - 0.1))
      this.renderer.setSize(this.viewWidth, this.viewHeight)
      this.scaleCooldown = 150
      this.lowFrameFrames = 0
    } else if (auto && this.qualityTier !== 'performance') {
      // 分辨率已经到本档下限，还是超标：降一档画质（会重建 RT/阴影图）。
      this.qualityTier = this.qualityTier === 'quality' ? 'balanced' : 'performance'
      this.renderer.setQuality(this.qualityTier)
      this.scaleCooldown = 300
      this.lowFrameFrames = 0
    }
  }

  /**
   * 一个固定步的本地预测。
   *
   * 内核的 `fixedUpdate` 每个 tick 调它一次，`TICK_DT` 由 FixedClock 保证，
   * 不再由这里自己累加。服务端每个 tick 取一条输入、固定推进 `TICK_DT`；
   * 客户端用同一个步长重放，预测才不会每个快照都被拽回去。
   */
  private fixedStep(): void {
    const character = this.character
    const world = this.world
    if (!character || !world) return
    const t0 = performance.now()
    this.stepOnce(TICK_DT)
    this.costSim += (performance.now() - t0 - this.costSim) * 0.125
  }

  /**
   * 每帧一次的远端插值采样。
   *
   * 远端玩家不做外推：渲染时间点固定落后 `INTERP_DELAY_MS`，样本之间线性
   * 插值，样本用完就停在最后一帧。这把 20Hz 快照画成连续运动，又不预测
   * 别人的下一步。
   */
  private updateReplication(): void {
    const t0 = performance.now()
    this.updateRemote(this.frameNow)
    this.costNet += (performance.now() - t0 - this.costNet) * 0.125
  }

  /** 表现系统：渲染、HUD、听者、标记。计时只用于 __dk 探针。 */
  private updatePresentation(dt: number): void {
    const t0 = performance.now()
    this.renderFrame(dt, this.frameNow)
    this.costDraw += (performance.now() - t0 - this.costDraw) * 0.125
  }

  /** 一步固定步长的模拟 + 入队待发。 */
  private stepOnce(dt: number): void {
    const character = this.character!
    const world = this.world!
    // 刀上右键是重刀而不是开镜：先告诉输入层，再采样本帧输入。
    this.input.meleeMode = this.heldSlot === 2
    const sample = this.input.sample()
    // 重刀按"按下沿"触发；按住右键不会连续重砍。
    const heavyDown = this.heldSlot === 2 && (sample.buttons & Buttons.Ads) !== 0
    if (heavyDown && !this.wasHeavyDown && this.switchProgress() >= 1) this.onLocalHeavyMelee()
    this.wasHeavyDown = heavyDown
    const punch = this.renderer.aimPunch()
    // 瞄准方向带相机后坐；移动方向保持鼠标原始朝向，避免按 W 时被枪口上跳带歪。
    const aimYaw = wrapAngle(sample.yaw + punch.yaw)
    const limit = Math.PI / 2 - 0.02
    const aimPitch = Math.max(-limit, Math.min(limit, sample.pitch + punch.pitch))
    this.pumpSlotRequests()
    this.seq++
    const input: PlayerInput = {
      seq: this.seq,
      dtMs: dt * 1000,
      forward: sample.forward,
      right: sample.right,
      yaw: sample.yaw,
      pitch: sample.pitch,
      aimYaw,
      aimPitch,
      buttons: sample.buttons,
    }

    // 固定步前后的脚底位置：渲染层用 alpha 在两者之间插值。
    const beforeFeet = character.feet
    const beforeEye = character.eyeHeightCurrent
    character.step(world, input, dt)
    world.step()
    const afterFeet = character.feet
    this.captureFeetSample(beforeFeet, beforeEye, afterFeet, character.eyeHeightCurrent)

    // 本地开火立刻给反馈（后坐、枪口火光、枪声），不等服务端确认。
    // 服务端的命中判定结果晚一拍才到，但"扣扳机"这件事必须是 0 延迟的。
    //
    // 两个例外：切枪没举好、手上是刀。前者服务端本来就拒绝开火，本地先亮
    // 枪口火光会让玩家以为"打出去了但没中"；后者走挥砍动画而不是枪的弹道反馈。
    if ((input.buttons & Buttons.Fire) !== 0 && this.switchProgress() >= 1) {
      if (this.heldSlot === 2) this.onLocalMelee()
      else this.onLocalFire()
    }

    // 脚步声按行进距离触发，不按时间 —— 按时间的话贴着墙原地蹭也会有脚步，
    // 而那在猎杀类游戏里是致命的信息泄露（等于给对方报点）。
    const feet = afterFeet
    if (this.lastFeet) {
      const moved = Math.hypot(feet.x - this.lastFeet.x, feet.z - this.lastFeet.z)
      this.stepAccum += moved
      const stride = (input.buttons & Buttons.Sprint) !== 0 ? STEP_DISTANCE_SPRINT : STEP_DISTANCE
      if (this.stepAccum >= stride) {
        this.stepAccum = 0
        const crouching = (input.buttons & Buttons.Crouch) !== 0
        const sprinting = (input.buttons & Buttons.Sprint) !== 0
        // 脚步的材质与命中特效同源（surfaces.ts）：踩在木地板和踩在烂泥里必须
        // 是两种声音，否则"听声辨位"只剩方向、没有地面信息。蹲行不静音，而是
        // 交给 audio 压到 0.35 电平 + 更低截止 —— 完全没有脚步反而会被读成
        // "这个人静止了"，而潜行的人其实还在动。
        const surface = surfaceAt(this.options.level, feet)
        this.audio.footstep(surface, sprinting, crouching)
        if (sprinting) this.audio.exertion(true)
      }
    }
    this.lastFeet = { x: feet.x, y: feet.y, z: feet.z }

    this.pending.push({ input, predicted: character.feet })
    // 保留最近 2 秒的输入用于重放。超过这个长度的往返延迟已经不是
    // "网络抖"，而是断线了，重放没有意义。
    if (this.pending.length > 120) this.pending.shift()

    this.unsent.push(input)
    // 一包最多 MAX_INPUTS_PER_PACKET 条，超了先发出去，避免编码时溢出。
    if (this.unsent.length >= MAX_INPUTS_PER_PACKET) {
      this.net.sendInputs(this.unsent, this.ackedTick)
      this.unsent = []
    }
  }

  // ------------------------------------------------------------ 和解

  private onSnapshot(snapshot: Snapshot): void {
    // 时钟同步：用 serverTime 与到达时刻建立一个恒定的偏移。
    // 不做平滑，因为本地时钟和服务器时钟都在单调走，偏移是常量；
    // 平滑反而会在重同步时让插值时间轴跳一下。
    if (this.clockSynced) {
      const local = performance.now() - this.clockOffset
      // 只在偏差超过 250ms 时重同步：否则一次 GC 停顿就会重置时间轴，
      // 远端玩家会集体倒退一下。
      if (Math.abs(snapshot.serverTime - local) > 250) {
        this.clockOffset = snapshot.serverTime - performance.now()
      }
    }

    this.ackedTick = Math.max(this.ackedTick, snapshot.tick)
    this.lastSnapshot = snapshot
    // 怪物不做客户端预测：它们由服务端独占地推进，且 20Hz 的快照 + 渲染器
    // 内部插值已经足够顺。这里只把最新一帧递过去。
    this.currentMonsters = snapshot.monsters
    // 怪物脚步：之前完全没接音频，玩家只能听见吼叫和枪声，一只猎犬绕后
    // 贴到脸上之前没有任何声音线索。这里按快照位移触发脚步，体型决定重量。
    this.trackMonsterAudio(snapshot.monsters, snapshot.serverTime)
    // Boss 不在事件流里：它的出现与倒下都只体现在快照的种类码上。
    // 两张吼各播一次，靠 bossSeen 记住上一次的状态。
    const boss = snapshot.monsters.find((m) => {
      if (m.state === 3) return false
      const kind = monsterKindFromCode(m.kind)
      return kind !== null && isBossKind(kind)
    })
    if (boss) {
      const kind = monsterKindFromCode(boss.kind)
      const spec = kind === null ? MONSTER_SPECS.boss : MONSTER_SPECS[kind]
      this.bossKind = boss.kind
      this.bossPct = Math.max(0, Math.min(100, Math.round((boss.health / spec.maxHealth) * 100)))
      if (!this.bossSeen) {
        this.bossSeen = true
        this.audio.bossRoar()
        const name = kind === null ? '血巢' : bossNameOf(kind)
        this.objectiveHud?.banner(
          '血 巢 苏 醒',
          `${name}已出笼 · 先杀它才能放逐`,
          'bile',
        )
      }
    } else if (this.bossSeen) {
      this.bossSeen = false
      this.bossKind = -1
      this.bossPct = -1
      this.audio.bossDown()
    }

    const me = snapshot.players.find((p) => p.id === this.myId)
    if (me) {
      this.trackReload(me)
      this.trackSlot(me)
      this.ammoBySlot[me.slot ?? this.heldSlot] = me.ammo
      // 心跳从 40% 血量起：这是"我快死了"唯一不需要看屏幕的通知。
      this.audio.setHealth(me.health)
      this.reconcile(me)
      this.options.onHud(this.hudOf(me, snapshot.tick))
    }

    // 远端玩家样本入队，供插值消费。
    const serverNow = snapshot.serverTime
    for (const player of snapshot.players) {
      if (player.id === this.myId) continue
      let state = this.remote.get(player.id)
      if (!state) {
        state = {
          samples: [],
          lastX: player.x,
          lastZ: player.z,
          lastTime: serverNow,
          stepAccum: 0,
          reloading: (player.flags & StateFlags.Reloading) !== 0,
        }
        this.remote.set(player.id, state)
      }
      this.trackRemoteAudio(player, state, serverNow)
      state.samples.push({ time: serverNow, player })
      const cutoff = serverNow - SNAPSHOT_BUFFER_MS
      while (state.samples.length > 2 && state.samples[0]!.time < cutoff) state.samples.shift()
    }
    // 快照里不再出现的玩家 = 已离开，清掉。
    const alive = new Set(snapshot.players.map((p) => p.id))
    for (const id of [...this.remote.keys()]) if (!alive.has(id)) this.remote.delete(id)
  }

  /**
   * 远端玩家的脚步与换弹声。
   *
   * 这是"声音是核心情报"里最重要的一条：敌人移动必须能被听见，否则绕后的人
   * 是隐形的。数据全部来自 20Hz 快照，不需要改协议：
   * - 位置差累积到步幅才放一步（按距离而不是按时间，贴墙原地蹭不会响）；
   * - 速度 > 5m/s 视为冲刺，蹲姿从 StateFlags 取；
   * - 45m 外不播，墙后的声音交给 heardThrough 压暗；
   * - 换弹只在 flags 翻转时播一次，远端也要能听见"他现在空窗"。
   */
  private trackRemoteAudio(player: PlayerSnapshot, state: RemoteState, now: number): void {
    const dt = (now - state.lastTime) / 1000
    const dx = player.x - state.lastX
    const dz = player.z - state.lastZ
    const moved = Math.hypot(dx, dz)
    const speed = dt > 1e-4 ? moved / dt : 0
    const crouching = (player.flags & StateFlags.Crouching) !== 0
    const sprinting = !crouching && speed > 5
    const at = { x: player.x, y: player.y, z: player.z }
    const eye = this.character?.eye
    const distance = eye ? Math.hypot(at.x - eye.x, at.y - eye.y, at.z - eye.z) : Infinity

    // 传送/复活的一帧位移会达到几十米，不能当成一步。
    if (moved > 5) {
      state.stepAccum = 0
    } else if (moved > 0.005 && distance <= 45) {
      state.stepAccum += moved
      const stride = crouching ? 1.4 : sprinting ? STEP_DISTANCE_SPRINT : STEP_DISTANCE
      if (state.stepAccum >= stride) {
        state.stepAccum = 0
        this.audio.footstepAt(
          at,
          surfaceAt(this.options.level, at),
          sprinting,
          crouching,
          this.heardThrough(at),
        )
      }
    }

    const reloading = (player.flags & StateFlags.Reloading) !== 0
    if (reloading !== state.reloading) {
      state.reloading = reloading
      if (distance <= 45) {
        if (reloading) this.audio.reloadStart(player.weaponId, at)
        else this.audio.reloadEnd(at)
      }
    }

    state.lastX = player.x
    state.lastZ = player.z
    state.lastTime = now
  }

  /**
   * 怪物脚步：按 20Hz 快照的位移触发，而不是按时间硬跳。
   *
   * 和远端玩家同一套思路：移动距离累积到步幅才响一步，站住/被挤住的怪
   * 不会原地踏步；传送/刷新的几十米位移直接丢弃。体型决定步幅与重量：
   * 猎犬小碎步、行尸正常、Boss 一步一震。
   */
  private trackMonsterAudio(monsters: MonsterView[], now: number): void {
    const eye = this.character?.eye
    const seen = new Set<number>()
    for (const monster of monsters) {
      seen.add(monster.id)
      let state = this.monsterAudio.get(monster.id)
      if (state === undefined) {
        this.monsterAudio.set(monster.id, {
          x: monster.x,
          z: monster.z,
          time: now,
          accum: 0,
        })
        continue
      }
      const dt = (now - state.time) / 1000
      const moved = Math.hypot(monster.x - state.x, monster.z - state.z)
      if (dt > 1e-4 && moved < 5 && moved > 0.005 && monster.state !== 3 /* dead */) {
        const speed = moved / dt
        const at = { x: monster.x, y: monster.y, z: monster.z }
        const distance = eye ? Math.hypot(at.x - eye.x, at.y - eye.y, at.z - eye.z) : Infinity
        if (speed > 0.35 && distance <= 45) {
          state.accum += moved
          // 步幅按体型：猎犬 1.0m、行尸 1.6m、Boss/巨像 2.2m。
          const stride = monster.kind === 1 ? 1.0 : monster.kind >= 3 ? 2.2 : 1.6
          if (state.accum >= stride) {
            state.accum = 0
            this.audio.monsterStepAt(
              at,
              surfaceAt(this.options.level, at),
              monster.kind,
              this.heardThrough(at),
            )
          }
        }
      }
      state.x = monster.x
      state.z = monster.z
      state.time = now
    }
    for (const id of [...this.monsterAudio.keys()]) {
      if (!seen.has(id)) this.monsterAudio.delete(id)
    }
  }

  /**
   * 把服务端的权威位置与我的预测对齐。
   *
   * 两种处理，选择哪种是本文件最关键的一个判断：
   *
   * - 差距小（`RECONCILE_EPSILON` 以内）：**什么都不做**。这点差异是正常的
   *   浮点/时序误差，每帧硬拉会让角色以 20Hz 抖动。
   * - 差距大：把自己瞬移到服务器位置，然后**重放**服务端还没确认的输入。
   *   只瞬移不重放会让玩家在撞墙/被推之后"卡"一下再走出来，手感断裂。
   */
  private reconcile(me: PlayerSnapshot): void {
    const character = this.character
    const world = this.world
    if (!character || !world) return
    if (me.ackSeq <= this.lastAckSeq) return

    // 丢掉服务端已确认的输入。
    while (this.pending.length > 0 && this.pending[0]!.input.seq <= me.ackSeq) {
      this.pending.shift()
    }
    this.lastAckSeq = me.ackSeq

    const predicted = this.pending[0]?.predicted ?? character.feet
    const dx = predicted.x - me.x
    const dy = predicted.y - me.y
    const dz = predicted.z - me.z
    const error = Math.hypot(dx, dy, dz)
    if (error < RECONCILE_EPSILON) return

    // 记录修正前的视觉位置：物理立刻对齐，但相机用一小段残差平滑追上去。
    const before = character.feet

    // 把自己拨回权威位置，速度也用服务端的。
    // keepInputState：回滚后要重放输入，不能把"正按住的空格"当成新的按下，
    // 否则每次网络修正都会多跳一次（长按空格的抖动就是这么来的）。
    character.teleport({ x: me.x, y: me.y, z: me.z }, true)
    character.vx = me.vx
    character.vy = me.vy
    character.vz = me.vz
    character.grounded = (me.flags & StateFlags.Grounded) !== 0
    world.step()

    // 重放尚未被确认的输入。
    for (const entry of this.pending) {
      character.step(world, entry.input, entry.input.dtMs / 1000)
      world.step()
      entry.predicted = character.feet
    }

    // 样本对齐到重放后的最终位置（不是 teleport 那一刻）：否则相机会
    // 落后整个重放距离。然后按修正量设置视觉残差。
    this.resetFeetSample()
    const after = character.feet
    const jumpX = before.x - after.x
    const jumpY = before.y - after.y
    const jumpZ = before.z - after.z
    if (Math.hypot(jumpX, jumpY, jumpZ) < 1.2) {
      this.reconcileOffset.x = jumpX
      this.reconcileOffset.y = jumpY
      this.reconcileOffset.z = jumpZ
      this.smoothedFeetY = before.y
    }
  }

  // ------------------------------------------------------------ 远端插值

  private updateRemote(now: number): void {
    if (!this.lastSnapshot || !this.character) return
    // 我要渲染的时间点 = 本机时间映射到服务端时间轴，再往回退 interp delay。
    const renderAt = now - this.clockOffset - INTERP_DELAY_MS

    const players: PlayerSnapshot[] = []
    for (const [id, state] of this.remote) {
      const interpolated = sampleAt(state.samples, renderAt)
      if (interpolated) players.push(interpolated)
      void id
    }

    this.currentRemote = players
  }

  private currentRemote: PlayerSnapshot[] = []

  /**
   * 换弹计时的本机起点（ms）。
   *
   * 快照只给一个 Reloading 位，没有"已经塞了几发"——服务端自己也只需要知道
   * 完成帧。所以进度只能由客户端按 spec.reloadMs 从看到标志那一刻起自己推：
   * 起点用 rAF 时刻而不是快照里的 serverTime，两者相差一个网络延迟，
   * 而玩家看到的枪是本地时间轴上的东西。
   */
  private reloadStartAt = 0
  private reloadMs = 0
  /** 这次换弹属于哪把枪：切枪打断后旧枪的"上膛"声不能再播。 */
  private reloadWeaponId = 0
  private wasReloading = false
  /** 本地预测的当前槽位与武器 id（0 主 / 1 副 / 2 刀）。 */
  private heldSlot = 0
  private heldWeapon = DEFAULT_WEAPON_ID
  private switchStartAt = 0
  private switchMs = 0
  private meleeStartAt = 0
  private meleeMs = 0
  /** 这一刀是重刀：视图模型据此放大蓄力/劈砍幅度。 */
  private meleeHeavy = false
  /** 刀上右键（协议里的 Ads 位）的边沿状态。 */
  private wasHeavyDown = false
  /** 重刀后的本地锁定截止时间；和服务端 heavyUntilTick 同义。 */
  private heavyUntilAt = 0
  /**
   * 每个槽位最后一次在快照里看到的弹药数。
   *
   * 快照只带"手上这把枪"的弹药（1 字节），不带三个槽的各自余弹 —— 要显示
   * HUD 那排小格子里的主/副数，只能在自己握住某个槽时把它抄下来。换槽不会
   * 让弹匣变化，所以这份缓存不会过期；重生时由 trackSlot 的复位清掉。
   */
  private readonly ammoBySlot = [0, 0, 0]
  /** 上一帧的开镜状态，用来抓 0→1 的那一下（呼吸声只在那一刻起）。 */
  private wasAds = false
  /** 下一次可以本地开火的时刻（ms）。按武器射速拦住按住不放的重复反馈。 */
  private fireReadyAt = 0
  /**
   * 下一次可以放"空仓咔"的时刻（ms）。
   *
   * 空仓拦截后 onLocalFire 每 tick 都会被调用，按住左键就是 20Hz 的一串"咔"，
   * 听起来像马达。用 DRY_FIRE_GAP_MS 抽稀到跟手、也仍然明显是"打空了"。
   */
  private dryReadyAt = 0
  /** 打空的次数（只在真的放出那声「咔」时 +1）。探针用它区分「没反应」与「空仓」。 */
  private dryShots = 0
  private currentMonsters: MonsterView[] = []
  /** 每只怪物上一次快照的位置与累计步幅（20Hz 位移驱动脚步）。 */
  private readonly monsterAudio = new Map<
    number,
    { x: number; z: number; time: number; accum: number }
  >()
  /**
   * 下一次可以放"怪的动静"的倒计时（秒）。
   *
   * 这是把声音当信息通道用的地方：怪的脚步与喉音是玩家判断"附近有什么、
   * 在哪个方向"的唯一线索，但它不能像雷达一样每帧响 —— 那就成了听声辩位外挂。
   * 用随机间隔 + 只取最近一只，玩家得到的是"这一带不干净"，而不是精确坐标。
   */
  private growlTimer = 2.5

  /**
   * 目标状态（线索/放逐/撤离）。
   *
   * 这份状态**不做客户端预测** —— 与位置不同，它是全局单份的裁判结果，
   * 我自己猜"我读到 60% 了"没有任何意义（真正决定能不能读满的是服务端
   * 半径判定）。所以它是纯展示层：到达即渲染。
   */
  private objective: ObjectivePacket | null = null
  private objectiveHud: ObjectiveHud | null = null
  private mapOverlay: MapOverlay | null = null

  /**
   * 世界标记的视图对象。**只建一次，之后每帧改字段** —— 每帧重造一个对象
   * 等于每帧给 GC 送垃圾，markers.ts 自己做的稳态零分配就白费了。
   */
  private readonly markerClues: MarkerClue[]
  private readonly markerView: ObjectiveView
  /** 血巢 = 线索质心。客户端也算一遍，不从网络取（省 4 字节且不会与关卡不同步）。 */
  private readonly lair: { x: number; z: number }
  /** 赏金光晕的位置缓冲，同样复用以免每帧分配。 */
  private readonly bountyPoint = { x: 0, y: 0, z: 0 }
  /** 命中方向缓冲，同理。 */
  private readonly impactDir = { x: 0, y: 1, z: 0 }

  // ------------------------------------------------------------ 事件

  private onEvents(events: GameEvent[]): void {
    const eye = this.character?.eye ?? null
    // 同一批事件里已经命中玩家/怪的枪，不再补"打在墙上"的落点声：
    // 否则一枪打在人身上，身后那面墙也会响一下。
    const hitAttackers = new Set<number>()
    for (const event of events) {
      if (event.kind === 2 /* Hit */ || event.kind === 5 /* MonsterHit */) hitAttackers.add(event.attackerId)
    }

    for (const event of events) {
      if (event.kind === 1 /* Shot */) {
        // 刀也走 Shot 事件（服务端靠它广播挥砍），但刀没有弹道：不能画曳光、
        // 不能沿视线在墙上补"弹着点"、也不能放枪声。命中反馈由后续的
        // Hit/MonsterHit 负责（血雾 + 刀切声），这才是刀该有的样子。
        if (WEAPONS[event.weaponId]?.kind === 'knife') continue
        const distance = eye ? dist(eye, event.origin) : 999
        if (!hitAttackers.has(event.playerId)) this.playShotImpact(event.origin, event.dir)
        if (event.playerId === this.myId) {
          // 自己开火：声音已经在 onLocalFire 里放了，这里只画曳光。
          this.renderer.addTracer(event.origin, event.dir, 40, true)
          continue
        }
        // 别人开枪：曳光 + 按距离衰减的枪声。远处是一声闷响而不是同样的爆响，
        // 这是这类游戏里"听声辨位"的全部技术基础。
        this.renderer.addTracer(event.origin, event.dir, 40, false)
        // shotAt 带世界坐标：枪声要落在开火者那个方向上（HRTF 左右声道），
        // 只按距离衰减的话所有枪声都从正中冒出来，听不出东南西北。
        this.audio.shotAt(
          event.weaponId,
          event.origin,
          (WEAPONS[event.weaponId]?.loudness ?? 1) * attachmentOf(event.attachment ?? 0).soundScale,
          this.heardThrough(event.origin),
        )
      } else if (event.kind === 2 /* Hit */) {
        if (event.attackerId === this.myId) {
          this.feedback.hit(event.headshot, event.damage)
          this.renderer.hitPunch(event.damage, event.headshot, false)
          // 手里是刀时命中声不能借用"枪命中"那声金属叮：刀切进去和子弹打进身体
          // 是两件事，听不出来就等于每次挥刀都在怀疑自己打没打中。
          if (this.heldSlot === 2) {
            this.playKnifeImpact(event.point, 'flesh')
          } else {
            this.audio.hitConfirm(event.headshot)
            // UI 叮只说明"记分有效"；这声才是子弹打进身体的重量。
            this.audio.fleshImpact(
              event.point,
              event.damage,
              event.headshot,
              this.heardThrough(event.point),
            )
          }
          this.spawnImpact(event.point, 'flesh')
          // 打中了人：血花 + 音效都在本地给，不再借用状态栏（状态栏会被
          // 后面的提示覆盖掉，而命中反馈必须立刻、且必须有声音）。
          if (event.victimId === this.myId) this.audio.hurt(event.damage)
        } else if (event.victimId === this.myId) {
          // 我被打中：方向指示 + 受伤音。方向来自命中点相对我的位置，
          // 这样即使我在看别处也知道该往哪转向。
          this.audio.hurt(event.damage)
          // 自己中弹也要有"打进身体"的一下；方向指示是战术信息，这声是体感。
          this.audio.fleshImpact(event.point, event.damage, event.headshot, false)
          this.options.onTraitFx?.(Trait.Bulwark)
          this.spawnImpact(event.point, 'flesh')
          if (eye) this.feedback.damageFrom(angleTo(eye, event.point, this.input.yaw))
        } else {
          // 别人打中别人：命中事件一定是肉体，不再用墙面材质声。
          this.audio.fleshImpact(event.point, event.damage, event.headshot, this.heardThrough(event.point))
          this.spawnImpact(event.point, 'flesh')
        }
      } else if (event.kind === 3 /* Death */) {
        if (event.victimId === this.myId) this.feedback.died()
        // 打死人才是这局最重的一下：镜头定格更长、再补一声"确认"。
        if (event.killerId === this.myId) {
          this.renderer.hitPunch(80, event.headshot, true)
          this.audio.killConfirm(event.headshot)
          // 刀杀收尾：顺手转一刀。枪杀不触发 —— 花式只属于近战。
          if (this.heldSlot === 2) {
            this.renderer.flourish()
            this.audio.knifeFlourish()
          }
        }
        this.audio.death()
        this.feedback.kill(
          nameOf(event.killerId),
          nameOf(event.victimId),
          this.weaponNameOf(event.killerId),
          event.headshot,
        )
      } else if (event.kind === 4 /* Respawn */) {
        if (event.playerId === this.myId) {
          this.feedback.revived()
          this.stepAccum = 0
          this.lastFeet = null
        }
        this.audio.respawn()
      } else if (event.kind === 5 /* MonsterHit */) {
        if (event.attackerId === this.myId) {
          // 打中怪走和打中人同一套命中反馈：玩家不需要知道"这一枪打的不是人"，
          // 他只需要立刻知道"打中了"。
          this.feedback.hit(false, event.damage)
          this.renderer.hitPunch(event.damage, false, false)
          if (this.heldSlot === 2) {
            this.playKnifeImpact(event.point, 'flesh')
          } else {
            this.audio.hitConfirm(false)
            this.audio.fleshImpact(
              event.point,
              event.damage,
              false,
              this.heardThrough(event.point),
            )
          }
        } else {
          this.audio.fleshImpact(event.point, event.damage, false, this.heardThrough(event.point))
        }
      } else if (event.kind === 6 /* MonsterDeath */) {
        const at = this.monsterPoint(event.monsterId)
        // Boss 的死亡由 bossDown() 的整套下坠/砸地负责，这里不再叠一条低频；
        // 普通怪用专门的怪物死亡声，按死亡位置空间化。
        if (event.monsterKind < 3) {
          if (at) this.audio.monsterDeath(event.monsterKind, at, this.heardThrough(at))
          else this.audio.monsterDeath(event.monsterKind)
        }
        if (at) {
          // 死亡按种类给个头骨大小：猎犬瘦、行尸胖，一坨同样大的墨会显得假。
          this.renderer.effects.burst(at, event.monsterKind === 1 ? 0.85 : 1.2)
        }
        // 只在自己击杀时进击杀播报：怪被怪杀、或别人杀怪都与我无关，
        // 慷慨播报会把真正重要的"谁死了"挤掉。
        if (event.killerId === this.myId) {
          this.feedback.kill('你', monsterNameOf(event.monsterKind), this.weaponNameOf(this.myId), false)
          // 打死怪也要有收尾声：爆头一枪倒地和打中但没倒是两种不同的结果。
          this.renderer.hitPunch(event.monsterKind >= 3 ? 90 : 45, false, true)
          this.audio.killConfirm(event.monsterKind >= 3)
          if (this.heldSlot === 2) {
            this.renderer.flourish()
            this.audio.knifeFlourish()
          }
        }
      } else if (event.kind === 7 /* MonsterShot */) {
        // 持枪行尸开枪：曳光 + 落在它那个方向上的枪声，和玩家那一枪完全同款。
        // 不做区分是有意的 —— 玩家该先听到"有人开枪"再判断那是人还是别的什么，
        // 一开始就能听出对面是 AI，这些行尸就白端枪了。
        this.renderer.addTracer(event.origin, event.dir, event.distance, event.hit)
        this.audio.shotAt(1, event.origin, 1, this.heardThrough(event.origin))
        if (!event.hit) {
          // 打偏的子弹得在墙上留个坑：曳光的终点就是落点，不给碎屑会像打空。
          const p = {
            x: event.origin.x + event.dir.x * event.distance,
            y: event.origin.y + event.dir.y * event.distance,
            z: event.origin.z + event.dir.z * event.distance,
          }
          this.spawnImpact(p, this.surfaceAt(p))
        }
      } else if (event.kind === 8 /* BossPulse */) {
        // 钟声/砸地：一圈向外扫的尘土 + 按 Boss 种类区分的低频。
        const p = { x: event.x, y: event.y, z: event.z }
        this.renderer.effects.shockwave(p, event.radius)
        this.audio.bossPulse(this.bossKind)
        const me = this.lastSnapshot?.players.find((pl) => pl.id === this.myId)
        if (me && me.health > 0) {
          const d = Math.hypot(me.x - event.x, me.z - event.z)
          // 近处才有拳感；远处只听到声音，不然每次砸地屏幕都抖。
          if (d < event.radius * 1.2) this.renderer.hitPunch(40, false, false)
        }
      }
    }
  }

  /**
   * 命中点的表面材质。
   *
   * 事件包里没有材质字段（每发子弹、每个玩家都要多 1 字节，而它只影响
   * 碎屑颜色），所以在这一端就近推断。推断本身在 surfaces.ts —— 脚步声和
   * 命中特效必须对"这是什么材质"给出同一个答案，否则会听到木头脚步、看到
   * 泥屑飞溅。0.4m 之外不算"打在它身上"，否则站在木箱边开枪会满屏木屑。
   */
  /**
   * 这声枪响是不是隔着墙。监听者的世界里只有静态几何（别的角色和怪都不在客户端
   * 物理世界），所以"射线半路撞到东西"就等于"中间有墙"。
   *
   * 2m 以内直接判直射：贴脸开枪时枪口本身就在自己身侧，射线会立刻撞上掩体。
   */
  private heardThrough(at: Vec3): boolean {
    const world = this.world
    const character = this.character
    if (!world || !character) return false
    const eye = character.eye
    const dx = at.x - eye.x
    const dy = at.y - eye.y
    const dz = at.z - eye.z
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (distance < 2) return false
    const blocked = traceShot(world, {
      origin: eye,
      dir: { x: dx, y: dy, z: dz },
      maxDistance: distance - 0.2,
      exclude: character.collider,
      classify: () => null,
    })
    return blocked.hit
  }

  /**
   * 打空的子弹也要有落点声。
   *
   * 本地预测世界里有完整的静态几何（关卡盒刷 + 地面），用它从枪口沿弹道
   * 打一条射线，取第一个墙/地落点放 impact。这比"只有命中玩家才响"多出
   * 一条关键情报：这一枪打偏了、偏到哪面墙上。
   *
   * 命中玩家/怪的枪由服务端的 Hit 事件负责（血花 + 肉体声），这里跳过；
   * 本地角色自己排除，避免从别人枪口打到自己身上。
   */
  private playShotImpact(origin: Vec3, dir: Vec3): void {
    const world = this.world
    if (!world) return
    const hit = traceShot(world, {
      origin,
      dir,
      maxDistance: 80,
      exclude: this.character?.collider,
      classify: () => null,
    })
    if (!hit.hit) return
    this.audio.impact(hit.point)
  }

  private surfaceAt(point: Vec3): ImpactKind {
    return impactSurfaceOf(surfaceAt(this.options.level, point, 0.4)) as ImpactKind
  }

  /** 从眼睛到命中点的方向，复用同一个对象给 vfx（它只在调用瞬间读）。 */
  private spawnImpact(point: Vec3, kind: ImpactKind): void {
    const eye = this.character?.eye
    if (!eye) return
    const dx = point.x - eye.x
    const dy = point.y - eye.y
    const dz = point.z - eye.z
    const length = Math.hypot(dx, dy, dz) || 1
    this.impactDir.x = dx / length
    this.impactDir.y = dy / length
    this.impactDir.z = dz / length
    this.renderer.effects.impact(point, this.impactDir, kind)
  }

  /** 怪物当前的世界位置（死亡特效要用）。不在快照里就返回 null，宁可不画。 */
  private monsterPoint(id: number): Vec3 | null {
    for (const monster of this.currentMonsters) {
      if (monster.id !== id) continue
      return { x: monster.x, y: monster.y, z: monster.z }
    }
    return null
  }

  /** 本地开火立刻给反馈，不等服务端 —— 这就是"手感"。 */
  private onLocalFire(): void {
    const now = performance.now()
    const meNow = this.lastSnapshot?.players.find((p) => p.id === this.myId) ?? null
    // 按住左键时 Fire 位每 tick 都是 1，但一把温菲尔德 900ms 才打一发。
    // 不在本地按射速拦住的话，按住不放会 60fps 地闪枪口火光、抖视角、响枪声，
    // 而服务端只认一发 —— 这是"按住左键画面乱抖但没伤害"的来源。
    if (now < this.fireReadyAt) return
    if (meNow && (meNow.flags & StateFlags.Reloading) !== 0) return
    const spec = WEAPONS[meNow?.weaponId ?? 1]
    // 空仓不许"空放"。服务端 canFire 在 0 弹时直接 return，一枪都不结算；而旧代码
    // 照样闪枪口火光、抖视角、放枪声，只额外补一声"咔" —— 玩家看到的是一次完整
    // 开火却没有伤害，报成了"没子弹还能射击"。刀刃没有弹匣（magazine 0），必须排除。
    if (meNow && spec?.kind !== 'knife' && meNow.ammo <= 0) {
      if (now >= this.dryReadyAt) {
        this.dryReadyAt = now + DRY_FIRE_GAP_MS
        this.dryShots++
        this.audio.dryFire(spec?.id ?? 0)
      }
      return
    }
    // 射速也要吃天赋（左右开工 / 百臂巨人）：本地拦得太慢会让"能开火却不开火"，
    // 拦得太快则是客户端先闪枪口火光、伤害被服务端丢掉。
    this.fireReadyAt = now + (spec?.fireIntervalMs ?? 500) * fireIntervalScale(spec?.kind ?? '', this.options.traits)
    // 推背量按武器给：神射手/霰弹的视角跳动必须明显大于转轮手枪，否则
    // 六把枪开起来手感一模一样，玩家分辨不出自己拿的是什么。
    // 神射手 1.7 → 1.45：开镜后 3.8 倍视野里，一次 1.7 的推背会把镜心甩出
    // 目标半个屏幕，玩家必须等它完全回正才敢打第二枪；1.45 仍有明显的"大枪"
    // 手感，但恢复时间短了约 15%。
    const kick =
      spec?.kind === 'sniper' ? 1.45 : spec?.kind === 'shotgun' ? 1.5 : spec?.kind === 'revolver' ? 0.8 : 1
    if (spec?.kind === 'revolver') this.options.onTraitFx?.(Trait.Ambidextrous)
    if (this.input.ads) this.options.onTraitFx?.(Trait.IronGrip)
    this.renderer.onLocalShot(kick * attachmentOf(this.options.attachment ?? 0).recoilScale)
    // 左轮吐轮：每发转 60°，棘轮声必须跟着枪机走，而不是跟着键盘。
    if (spec?.kind === 'revolver') this.audio.cylinderRatchet(false)
    // 最后一发：枪机空仓的机构声。它和"扣空扳机"的 dryFire 是两件事。
    if (spec !== undefined && spec.magazine > 0 && meNow?.ammo === 1) this.audio.magEmpty(spec.id)
    // 抛壳声与枪声分开：枪声在第 0 帧，黄铜落地/碰撞的高频"叮"要在
    // 壳飞出去之后才出现。AudioKit 内部按优先级调度，不会抢枪声。
    this.audio.shellEject()
    const eye = this.character?.eye
    if (eye) {
      // 直接算而不是调 lookDirection(yaw, pitch)：那个函数每次返回新对象，
      // 60fps 的开枪频率下等于每发给 GC 送一个 {x,y,z}。
      const sample = this.input
      const punch = this.renderer.aimPunch()
      const yaw = sample.yaw + punch.yaw
      const limit = Math.PI / 2 - 0.02
      const pitch = Math.max(-limit, Math.min(limit, sample.pitch + punch.pitch))
      const cp = Math.cos(pitch)
      this.impactDir.x = -Math.sin(yaw) * cp
      this.impactDir.y = Math.sin(pitch)
      this.impactDir.z = -Math.cos(yaw) * cp
      this.renderer.effects.muzzle(eye, this.impactDir, sample.ads)
    }
    this.audio.shot(
      meNow?.weaponId ?? 1,
      0,
      (WEAPONS[meNow?.weaponId ?? 1]?.loudness ?? 1) * attachmentOf(this.options.attachment ?? 0).soundScale,
    )
  }

  /**
   * 新的战利品包。
   *
   * 只在"变化方向"上出声：progress 涨了才是摩擦声，值变了才是翻到了东西。
   * 服务端 10Hz 下发，但只在变化时发，所以这里不做节流也不会连成一片。
   */
  private onLoot(loot: LootPacket): void {
    const previous = this.loot
    this.loot = loot
    if (loot.value > (previous?.value ?? 0)) {
      this.audio.searchDone()
      return
    }
    const was = previous?.searchPct ?? 0
    if (loot.searchPct > 0 && was === 0) this.audio.searchStart()
    else if (loot.searchPct > was) this.audio.searchTick(loot.searchPct / 100)
    // 包扎用的是同一套布料摩擦声：绷带缠上去和后袋里翻东西在听感上是同一类噪音，
    // 为它单独做一条音轨不值当，但"有没有在扎"必须听得出来。
    const healWas = previous?.healPct ?? 0
    if ((loot.searchPct > 0 && was === 0) || (loot.healPct > 0 && healWas === 0))
      this.options.onTraitFx?.(Trait.QuickHand)
    if (loot.healPct > 0 && healWas === 0) this.audio.searchStart()
    else if (loot.healPct > healWas) this.audio.searchTick(loot.healPct / 100)
    this.objectiveHud?.updateContract(loot.contract, loot.contractProgress)
    // 合同完成那一下必须有自己的横幅：只认"跨过目标线"的那一帧，重复下发不会重播。
    if (loot.contract > 0 && previous && previous.contract === loot.contract) {
      const spec = CONTRACTS[loot.contract]
      if (spec && loot.contractProgress >= spec.target && previous.contractProgress < spec.target) {
        this.objectiveHud?.banner('合 同 完 成', spec.name + ' · +$' + spec.reward, 'bile')
      }
    }
  }

  private clearResultTimer(): void {
    if (this.resultTimer === 0) return
    window.clearTimeout(this.resultTimer)
    this.resultTimer = 0
  }

  /**
   * 排一次结算。文案与"值不值"的判断都在上层，这里只把数字打包出去。
   *
   * 赏金价值在这里加上而不是让服务端算：服务端的 carriedValue 只统计搜刮现金，
   * 若它也把赏金算进去，客户端再补一次就会翻倍。
   */
  private scheduleResult(objective: ObjectivePacket): void {
    this.clearResultTimer()
    const loot = this.loot
    // 全局 outcome 只说明"这局以撤离结束"，不等于"我撤离了"：
    // 只有真正带走赏金的那个人拿到撤离结算，其他人按失败处理。
    const escaped = isPersonalEscape(objective.outcome, objective.bountyCarrier, this.myId)
    const carriedBounty = escaped && objective.bountyCarrier === this.myId
    this.resultTimer = window.setTimeout(() => {
      this.resultTimer = 0
      this.audio.matchResult(escaped)
      this.options.onResult({
        escaped,
        lootValue: loot?.value ?? 0,
        bountyValue: carriedBounty ? BOUNTY_VALUE : 0,
        items: loot?.items.slice() ?? [],
      })
    }, RESULT_DELAY_MS)
  }

  // ------------------------------------------------------------ 目标状态

  /**
   * 收到新的目标状态。
   *
   * 包里只带 `extractIndex`（撤离点是关卡数据，名字有几 KB 的文案，
   * 每 50ms 广播一遍纯属浪费），名字在这里从关卡表里查。
   */
  private onObjective(objective: ObjectivePacket): void {
    const previous = this.objective
    this.objective = objective
    this.renderer.setDoors(objective.doorsMask)
    this.renderer.setTraps(objective.trapsMask)
    this.renderer.setLamps(objective.lightsMask)
    // 客户端预测也要用同一套门碰撞体：否则服务端开了门，本地还被挡着。
    if (this.world) {
      const doors = this.options.level.doors ?? []
      for (let i = 0; i < doors.length; i++) {
        setDoorOpen(this.world, i, (objective.doorsMask & (1 << i)) !== 0)
      }
    }
    this.objectiveHud?.update(this.objectiveModel(objective))
    this.updateMarkerView(objective)

    // 每局的天气修正：目标包 1Hz 重复下发，只在真的变了那一帧动渲染器。
    if (objective.modifier !== this.modifierId) {
      this.modifierId = objective.modifier
      const modifier = getModifier(objective.modifier)
      this.renderer.setModifier(modifier.fogScale, modifier.fogTint)
      this.renderer.setRain(modifier.key === 'storm')
    }

    // 线索文献：新点亮的那一位对应一段故事；三条集齐再解开一张"解语"。
    // 用位掩码做增量，所以重连后重放同一份目标包不会把读过的卡再弹一次。
    const fresh = previous ? objective.clueMask & ~this.loreBits : 0
    const lore = loreOf(this.options.level.id)
    if (fresh !== 0) {
      for (let i = 0; i < lore.clues.length; i++) {
        if ((fresh & (1 << i)) === 0) continue
        const clue = lore.clues[i]!
        this.audio.codexWrite()
        this.options.onLore?.({ kind: 'clue', index: i, title: clue.title, body: clue.body, glyph: clue.glyph, word: '' })
      }
    }
    const full = (1 << lore.clues.length) - 1
    if (previous && objective.clueMask === full && previous.clueMask !== full) {
      this.audio.codexWrite()
      this.options.onLore?.({
        kind: 'seal',
        index: lore.clues.length,
        title: lore.seal.title,
        body: lore.seal.body,
        glyph: 'seal',
        word: lore.seal.word,
      })
    }
    this.loreBits = objective.clueMask

    if (!previous) return

    // 只在"跨越阶段"时播报，而不是每次状态变化都播 —— 进度条动一格也弹横幅
    // 会把屏幕糊死，玩家真正需要被告知的只有阶段切换。
    if (previous.phase !== objective.phase) {
      if (objective.phase === 'banish') {
        this.objectiveHud?.banner('巢 穴 已 暴 露', '血巢正在燃烧 · 全场都看见了', 'bile')
      } else if (objective.phase === 'extract') {
        this.objectiveHud?.banner('赏 金 已 夺 取', '带它走进撤离点', 'amber')
      } else if (objective.phase === 'hunt' && previous.phase === 'over') {
        // 新一局：上一把的钱和物品不能跟着我进下一场，否则搜刮就没意义了。
        this.loot = null
        this.objectiveHud?.banner('新 的 一 局', '猎场已重置', 'bile')
      }
    }

    // 线索数是玩家唯一能主动推进的计数，值得一次独立播报。
    if (objective.cluesFound > previous.cluesFound && objective.phase === 'hunt') {
      this.objectiveHud?.banner(
        '线索 ' + objective.cluesFound + ' / ' + objective.cluesTotal,
        '血巢的位置更清楚了',
        'amber',
      )
    }

    if (objective.phase === 'over' && previous.phase !== 'over') {
      this.objectiveHud?.banner(
        objective.outcome === 'escaped' ? '撤 离 成 功' : '狩 猎 失 败',
        objective.outcome === 'escaped' ? '赏金已带走' : '时间耗尽',
        objective.outcome === 'escaped' ? 'amber' : 'blood',
      )
      this.scheduleResult(objective)
    }
  }

  /**
   * 把网络包写进标记视图（原地改字段，不新建对象）。
   *
   * 赏金光晕的位置来自快照里携带者的实时坐标，而不是包里的 4 字节 id：
   * 光晕要跟着人走，如果每 20Hz 才更新一次位置，跑动时它会像拖在身后。
   * 携带者不在线（掉线/阵亡）时不画。
   */
  private updateMarkerView(objective: ObjectivePacket): void {
    const view = this.markerView
    view.phase = objective.phase
    view.activeClue = objective.clueIndex
    view.clueProgress = objective.clueProgress
    view.lairRevealed = objective.lairRevealed
    view.banishProgress = objective.banishProgress
    view.extractIndex = objective.extractIndex
    view.extractProgress = objective.extractProgress

    // 哪几条找过由掩码说了算：线索是就近任意顺序收的，用 "前 N 条" 推导会把
    // 光柱点错（刚收完第 3 条却熄掉第 1 条）。
    for (let i = 0; i < this.markerClues.length; i++) {
      this.markerClues[i]!.found = (objective.clueMask & (1 << i)) !== 0
    }

    const carrier = objective.bountyCarrier
    const snapshot = this.lastSnapshot
    let bounty: { x: number; y: number; z: number } | null = null
    if (carrier !== 0 && snapshot) {
      const who =
        carrier === this.myId
          ? this.character
            ? { x: this.character.feet.x, y: this.character.feet.y, z: this.character.feet.z }
            : null
          : (snapshot.players.find((p) => p.id === carrier) ?? null)
      if (who) {
        this.bountyPoint.x = who.x
        this.bountyPoint.y = who.y
        this.bountyPoint.z = who.z
        bounty = this.bountyPoint
      }
    }
    view.bountyAt = bounty
  }

  /** 把网络包 + 关卡数据拼成 HUD 需要的模型。`packet` 为 null 时给一份初始值。 */
  private objectiveModel(packet: ObjectivePacket | null): ObjectiveModel {
    const extracts = this.options.level.extracts ?? []
    const index = packet?.extractIndex ?? -1
    return {
      phase: packet?.phase ?? 'hunt',
      cluesFound: packet?.cluesFound ?? 0,
      cluesTotal: packet?.cluesTotal ?? (this.options.level.clues?.length ?? CLUE_TOTAL),
      lairRevealed: packet?.lairRevealed ?? false,
      banishProgress: packet?.banishProgress ?? 0,
      bountyCarrier: packet?.bountyCarrier ?? 0,
      // 撤离点名字只在真正站进去时才显示（进度 > 0）：把三个地名常驻在屏幕上
      // 等于免费给玩家一张地图，而这类游戏里"知道撤离线在哪"本身就是情报。
      extractName: index >= 0 && (packet?.extractProgress ?? 0) > 0 ? (extracts[index]?.name ?? '') : '',
      extractProgress: packet?.extractProgress ?? 0,
      secondsLeft: packet?.secondsLeft ?? MATCH_SECONDS,
      event: packet?.event ?? 0,
      eventSeconds: packet?.eventSeconds ?? 0,
      outcome: packet?.outcome ?? 'none',
      // 三槽属于"目标 HUD"而不是"我的读数"：它们是常驻的三格栏位图示，
      // 和线索/撤离一样刷新频率低，走同一份缓存比对。
      slot: this.heldSlot,
      slots: {
        pr: this.ammoBySlot[0] ?? 0,
        sec: this.ammoBySlot[1] ?? 0,
        melee: true,
      },
      reloading: this.wasReloading,
      switching: this.switchStartAt > 0 && performance.now() - this.switchStartAt < this.switchMs,
    }
  }

  /**
   * 跟踪换弹的起止，给出 0..1 的进度给武器动画。
   *
   * 只在标志位翻转时重置起点：快照 20Hz 到达，每次都重置会让进度永远停在 0
   * （枪反复压下去又抬起来）。换弹中途被打断（切成别的枪、死亡）时标志位消失，
   * 这时把进度留在原地，视图模块会用指数回落收尾。
   */
  private trackReload(me: PlayerSnapshot): void {
    // 本地已经切到别的枪时，快照里旧枪的 Reloading 位晚到一两帧是正常的；
    // 不能再据此重启换弹动画/声音（否则打断后又会压一次枪）。
    if (me.weaponId !== this.heldWeapon) {
      this.wasReloading = false
      this.reloadMs = 0
      return
    }
    const reloading = (me.flags & StateFlags.Reloading) !== 0
    if (reloading && !this.wasReloading) {
      this.reloadStartAt = performance.now()
      this.reloadMs = WEAPONS[me.weaponId]?.reloadMs ?? 0
      this.reloadWeaponId = me.weaponId
      // 自己的换弹也要有声音：开仓 + 上膛；配方早就有，之前只是没人调用。
      this.audio.reloadStart(me.weaponId)
    } else if (!reloading && this.wasReloading) {
      // 换枪打断换弹时不播"上膛"：那是换成功了的声音。
      if (me.weaponId === this.reloadWeaponId) this.audio.reloadEnd()
    }
    this.wasReloading = reloading
  }

  /** 当前换弹进度 0..1（没在换弹时给 0，视图模块按 reloading=false 忽略）。 */
  private reloadProgress(): number {
    if (!this.wasReloading || this.reloadMs <= 0) return 0
    const t = (performance.now() - this.reloadStartAt) / this.reloadMs
    return t < 0 ? 0 : t > 1 ? 1 : t
  }

  // ------------------------------------------------------------ 渲染

  // ------------------------------------------------------- 槽位与切枪

  /**
   * 消费一次切枪请求（1/2/3 键、Q、滚轮）。
   *
   * 本地立刻改 heldSlot/heldWeapon 并起一段 switchMs 的计时：切枪动作必须和
   * 按键同帧开始，等 20Hz 的快照回来再动，每次切枪都会像"卡了半拍"。
   * 权威仍在服务端 —— 快照里的 slot 与本地不一致时以服务端为准（trackSlot）。
   */
  private pumpSlotRequests(): void {
    const request = this.input.takeSlotRequest()
    if (request === null) return
    if (request === SLOT_CYCLE_FORWARD || request === SLOT_CYCLE_BACK) {
      // 三槽一条链，循环切：滚轮与 Q 都走这条路。
      const count = 3
      const next = request === SLOT_CYCLE_FORWARD ? this.heldSlot + 1 : this.heldSlot + count - 1
      this.beginSwitch(next % count)
      return
    }
    this.beginSwitch(request)
  }

  private beginSwitch(slot: number): void {
    if (slot < 0 || slot > 2 || slot === this.heldSlot) return
    const weaponId = weaponForSlot(this.options.primaryId, slot)
    const spec = WEAPONS[weaponId]
    if (!spec) return
    this.heldSlot = slot
    this.heldWeapon = weaponId
    this.switchStartAt = performance.now()
    this.switchMs = spec.switchMs * switchScale(this.options.traits)
    // 切枪的机械声是"我在干什么"的听觉确认，必须和按键同帧。
    // 刀是拔鞘而不是上膛：一声金属摩擦比枪机上膛声更像那么回事。
    if (slot === 2) {
      this.audio.knifeDraw()
      // 收刀花式：出鞘后顺势转一圈手腕。视觉由 viewmodel 的 flourish 驱动，
      // 声音在这里起，晚 60ms，不和拔鞘声糊在一起。
      this.audio.knifeFlourish()
    } else this.audio.weaponSwitch(weaponId)
    this.net.sendSlot(slot)
  }

  /** 举枪进度（0..1）。到 1 才能开火，和 shared/loadout.ts 的 canFire 同源。 */
  private switchProgress(): number {
    if (this.switchMs <= 0) return 1
    const t = (performance.now() - this.switchStartAt) / this.switchMs
    return t < 0 ? 0 : t > 1 ? 1 : t
  }

  /**
   * 用快照里的 slot 校正本地预测。
   *
   * 只在**真的不一致**时重置计时：快照 20Hz、切枪 400~1200ms，每次都重置的话
   * 举枪进度会被永远按回 0，表现为枪永远举不起来。
   */
  private trackSlot(me: PlayerSnapshot): void {
    const slot = me.slot ?? 0
    if (slot === this.heldSlot) return
    this.heldSlot = slot
    this.heldWeapon = weaponForSlot(this.options.primaryId, slot)
    this.switchStartAt = performance.now()
    this.switchMs = (WEAPONS[this.heldWeapon]?.switchMs ?? 0) * switchScale(this.options.traits)
  }

  /**
   * 挥刀。
   *
   * 刀没有独立的挥砍事件：服务端把一次挥砍当作 Shot（weaponId 10）广播，
   * 命中仍是 Hit/MonsterHit。所以动作只能在本地按射速间隔自己起。
   */
  private onLocalMelee(): void {
    const now = performance.now()
    const spec = WEAPONS[this.heldWeapon]
    const interval = (spec?.fireIntervalMs ?? 380) * fireIntervalScale('knife', this.options.traits)
    this.options.onTraitFx?.(Trait.HundredHands)
    if (now < this.heavyUntilAt) return
    if (now - this.meleeStartAt < interval) return
    this.meleeStartAt = now
    this.meleeMs = interval
    this.meleeHeavy = false
    this.audio.knifeSwing()
    // 刀的"推背"只有一点点：视角猛跳的话近身缠斗会看不清对方的手。
    // 第二个参数关掉枪口闪光 —— 挥刀却在枪口放一团光，等于在黑暗里给对手报点。
    this.renderer.onLocalShot(0.25, false)
  }

  /**
   * 重刀：右键按下沿触发。和轻刀共用 meleeStartAt，所以轻刀后立刻右键
   * 会按重刀的长冷却被拦下；服务端用同一份 shared 常量，不会两套节奏。
   */
  private onLocalHeavyMelee(): void {
    const now = performance.now()
    const interval = KNIFE_HEAVY_INTERVAL_MS * fireIntervalScale('knife', this.options.traits)
    if (now - this.meleeStartAt < interval) return
    this.meleeStartAt = now
    this.meleeMs = interval
    this.meleeHeavy = true
    this.heavyUntilAt = now + interval
    this.audio.knifeHeavySwing()
    // 重刀的推背比轻刀大：这一下必须让屏幕知道"我用了全力"。
    this.renderer.onLocalShot(0.5, false)
  }

  /**
   * 刀命中：按表面换材质声。
   *
   * 枪命中的"叮"是一个抽象的确认音；刀必须让人听出**切进了什么** —— 肉是闷的、
   * 木箱是脆的、石头是擦出火星的、铁皮是拖尾的。同一把刀砍石头和砍人给出
   * 同一个声音，近战就只剩下一个盲目的挥动动作。
   */
  private playKnifeImpact(point: Vec3, fallback: 'flesh' | 'wood' | 'stone' | 'metal'): void {
    const surface = this.surfaceAt(point)
    const kind =
      surface === 'flesh' || surface === 'wood' || surface === 'stone' || surface === 'metal'
        ? surface
        : fallback === 'flesh' && surface === 'mud'
          ? 'flesh'
          : 'stone'
    this.audio.knifeImpact(kind)
  }

  /** 挥砍进度（0..1）；没在挥时返回 0。 */
  private meleeProgress(): number {
    if (this.meleeMs <= 0) return 0
    const t = (performance.now() - this.meleeStartAt) / this.meleeMs
    return t <= 0 || t >= 1 ? 0 : t
  }

  /**
   * 让附近的怪偶尔出声。
   *
   * 距离用平方比较（省一次 sqrt），34m 这个上限是"能听见但还看不清"的边界：
   * 更远的声音在夜里的混响里分不出来，更近的已经该看得见了。
   */
  private tickGrowls(dt: number): void {
    const feet = this.character?.feet
    if (!feet || this.currentMonsters.length === 0) return
    this.growlTimer -= dt
    if (this.growlTimer > 0) return
    this.growlTimer = this.rng.range(4, 9)

    let nearest: MonsterView | null = null
    let best = 34 * 34
    for (const monster of this.currentMonsters) {
      if (monster.state === 3 /* dead */) continue
      const dx = monster.x - feet.x
      const dz = monster.z - feet.z
      const d = dx * dx + dz * dz
      if (d < best) {
        best = d
        nearest = monster
      }
    }
    if (!nearest) return
    this.audio.monsterGrowlAt(
      { x: nearest.x, y: nearest.y + 1.2, z: nearest.z },
      nearest.kind === 1 ? 'hound' : 'grunt',
    )
  }

  /**
   * 记录一个固定步的起点/终点。
   *
   * 位移过大时直接吸附：服务器和解/传送/复活的位置跳变如果也做 16ms 插值，
   * 相机会像被橡皮筋从旧位置拖过来。小幅修正才值得插值。
   */
  private captureFeetSample(
    before: Vec3,
    beforeEye: number,
    after: Vec3,
    afterEye: number,
  ): void {
    const jump = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)
    if (!this.hasFeetSample || jump > 2) {
      this.prevFeet.x = after.x
      this.prevFeet.y = after.y
      this.prevFeet.z = after.z
      this.prevEyeHeight = afterEye
    } else {
      this.prevFeet.x = before.x
      this.prevFeet.y = before.y
      this.prevFeet.z = before.z
      this.prevEyeHeight = beforeEye
    }
    this.currFeet.x = after.x
    this.currFeet.y = after.y
    this.currFeet.z = after.z
    this.currEyeHeight = afterEye
    this.hasFeetSample = true
  }

  /** 出生/传送后把两个样本都对齐到当前位置。 */
  private resetFeetSample(): void {
    const character = this.character
    if (!character) return
    const feet = character.feet
    this.prevFeet.x = feet.x
    this.prevFeet.y = feet.y
    this.prevFeet.z = feet.z
    this.currFeet.x = feet.x
    this.currFeet.y = feet.y
    this.currFeet.z = feet.z
    this.renderFeet.x = feet.x
    this.renderFeet.y = feet.y
    this.renderFeet.z = feet.z
    this.prevEyeHeight = character.eyeHeightCurrent
    this.currEyeHeight = character.eyeHeightCurrent
    this.renderEyeHeight = character.eyeHeightCurrent
    this.smoothedFeetY = feet.y
    this.reconcileOffset.x = 0
    this.reconcileOffset.y = 0
    this.reconcileOffset.z = 0
    this.hasFeetSample = true
  }

  /** 渲染用的脚底位置：60Hz 模拟 → 任意刷新率的连续运动。 */
  private renderFeetAt(alpha: number): Vec3 {
    const character = this.character
    if (!character) return { x: 0, y: 0, z: 0 }
    const r = this.renderFeet
    if (!this.hasFeetSample) {
      const f = character.feet
      r.x = f.x + this.reconcileOffset.x
      r.y = f.y + this.reconcileOffset.y
      r.z = f.z + this.reconcileOffset.z
      return r
    }
    const p = this.prevFeet
    const q = this.currFeet
    r.x = p.x + (q.x - p.x) * alpha + this.reconcileOffset.x
    r.y = p.y + (q.y - p.y) * alpha + this.reconcileOffset.y
    r.z = p.z + (q.z - p.z) * alpha + this.reconcileOffset.z
    return r
  }

  private renderFrame(dt: number, _now: number): void {
    const character = this.character
    if (!character) return
    const sample = this.input
    // 60Hz 的模拟用 alpha 插值成渲染帧的位置；眼高单独做一次指数平滑，
    // 蹲/起立时镜头不会"啪"地跳一截。
    const feet = this.renderFeetAt(this.kernel.clock.time.alpha)
    // 垂直低通：角色控制器在慢速走时会做台阶/贴地的小幅修正，60Hz 固定步
    // 下这些厘米级 y 变化比冲刺时更容易被看见。水平位置保持精确插值。
    this.smoothedFeetY += (feet.y - this.smoothedFeetY) * Math.min(1, dt * 25)
    feet.y = this.smoothedFeetY
    // 和解残差按 0.12s 衰减；物理已经在权威位置，镜头只是追上去。
    const reconcileDecay = Math.exp(-dt / 0.12)
    this.reconcileOffset.x *= reconcileDecay
    this.reconcileOffset.y *= reconcileDecay
    this.reconcileOffset.z *= reconcileDecay
    if (
      Math.abs(this.reconcileOffset.x) < 1e-4 &&
      Math.abs(this.reconcileOffset.y) < 1e-4 &&
      Math.abs(this.reconcileOffset.z) < 1e-4
    ) {
      this.reconcileOffset.x = 0
      this.reconcileOffset.y = 0
      this.reconcileOffset.z = 0
    }
    const eyeTarget = character.eyeHeightCurrent
    this.renderEyeHeight += (eyeTarget - this.renderEyeHeight) * Math.min(1, dt * 16)
    const eyeHeight = this.renderEyeHeight

    // 贴墙检测：视图模型是独立场景、不参与世界深度，枪口顶到墙时会直接
    // 画在墙前面。这里从眼睛沿视线打一条 1.6m 的射线，把"墙离多近"变成
    // 一个 0..1 的标量交给武器动画，把枪压出瞄准线。
    let targetWallBlock = 0
    if (this.world) {
      const eye = character.eye
      const cp = Math.cos(sample.pitch)
      this.wallDir.x = -Math.sin(sample.yaw) * cp
      this.wallDir.y = Math.sin(sample.pitch)
      this.wallDir.z = -Math.cos(sample.yaw) * cp
      const wallHit = traceShot(this.world, {
        origin: eye,
        dir: this.wallDir,
        maxDistance: 1.6,
        exclude: character.collider,
        classify: () => null,
      })
      if (wallHit.hit) {
        const t = Math.min(1, Math.max(0, (wallHit.distance - 0.35) / 1.25))
        targetWallBlock = 1 - t * t * (3 - 2 * t)
      }
    }
    this.wallBlock += (targetWallBlock - this.wallBlock) * Math.min(1, dt * 10)

    // 重刀姿势开关：视图模型只在这一刀是重刀时放大蓄力/劈砍。
    this.renderer.setMeleeHeavy(this.meleeHeavy)
    // 战局压力：光随剩余时间变暗，最后 28% 地平线往暗红偏。
    // 只信服务端 1Hz 的目标包；重连前默认按满时长，不会一进来就天黑。
    const secondsLeft = this.objective?.secondsLeft ?? MATCH_SECONDS
    this.renderer.setPressure(1 - Math.max(0, secondsLeft) / MATCH_SECONDS)

    // 眼高直接取角色控制器的当前值（蹲下时更矮）：镜头和射线起点必须同源，
    // 否则近距离会出现"准星在他头上，服务端却判没打中"。
    this.renderer.updateCamera(
      feet,
      eyeHeight,
      sample.yaw,
      sample.pitch,
      sample.ads,
      dt,
      Math.hypot(character.vx, character.vz),
      character.vx,
      character.vz,
      character.vy,
      sample.sprinting,
      !character.grounded,
      character.sliding,
      this.wasReloading,
      this.reloadProgress(),
      this.heldWeapon,
      this.heldSlot,
      this.switchProgress(),
      this.meleeProgress(),
      (WEAPONS[this.heldWeapon]?.adsZoom ?? 1) * attachmentOf(this.options.attachment ?? 0).zoomScale,
      this.wallBlock,
    )
    // 指南针/撤离方位必须每帧跟着 yaw 走，不能等 1Hz 的目标包。
    this.objectiveHud?.updateBearing(
      sample.yaw,
      feet.x,
      feet.z,
      this.objective?.bountyCarrier === this.myId,
      this.options.level.extracts ?? [],
    )
    this.objectiveHud?.updateCompass(
      sample.yaw,
      feet.x,
      feet.z,
      this.objective?.clueMask ?? -1,
      this.options.level.clues ?? [],
      this.objective?.lairRevealed ? this.lair : null,
      this.objective?.bountyCarrier === this.myId ? (this.options.level.extracts ?? []) : NO_POINTS,
    )
    this.mapOverlay?.update(feet.x, feet.z, sample.yaw, {
      clueMask: this.objective?.clueMask ?? -1,
      lairRevealed: this.objective?.lairRevealed ?? false,
      carrierIsMe: this.objective?.bountyCarrier === this.myId,
      phase: this.objective?.phase ?? 'hunt',
    })
    // 听觉的"眼睛"必须和相机的位姿完全一致：右耳机里的枪声位置全靠它。
    // 相机含后坐 punch，听者也必须含，否则开火后声音方位会偏一帧。
    const listenerPunch = this.renderer.aimPunch()
    const listenerYaw = sample.yaw + listenerPunch.yaw
    const listenerLimit = Math.PI / 2 - 0.02
    const listenerPitch = Math.max(
      -listenerLimit,
      Math.min(listenerLimit, sample.pitch + listenerPunch.pitch),
    )
    const cp = Math.cos(listenerPitch)
    this.audio.setListener(
      { x: feet.x, y: feet.y + eyeHeight, z: feet.z },
      { x: -Math.sin(listenerYaw) * cp, y: Math.sin(listenerPitch), z: -Math.cos(listenerYaw) * cp },
    )
    if (sample.ads && !this.wasAds) this.audio.aimBreath()
    this.wasAds = sample.ads

    this.markerView.myX = feet.x
    this.markerView.myY = feet.y
    this.markerView.myZ = feet.z
    this.renderer.syncAvatars(this.currentRemote, this.myId, dt)
    this.renderer.syncMonsters(this.currentMonsters, dt)
    this.tickGrowls(dt)
    this.renderer.syncObjective(this.markerView, dt)
    this.renderer.render()

    const hudAt = performance.now()
    if (hudAt - this.lastHudAt > 120) {
      this.lastHudAt = hudAt
      this.options.onHud(this.hudOf(null, this.lastSnapshot?.tick ?? 0))
      // 调试探针：预测/和解到底有没有在跑，只能看这几个数。
      // 挂到 window 而不是每帧打日志 —— console 在这个频率下会拖慢主线程，
      // 反而把要观察的现象本身改掉。
      ;(globalThis as Record<string, unknown>).__dk = {
        seq: this.seq,
        // 音频图没法从截图看出来：把"上下文状态/活着的声源数/环境层数"挂出来，
        // 自动探针才能在无扬声器的环境里判断"到底有没有声"。
        audio: this.audio.debugStats(),
        lastAckSeq: this.lastAckSeq,
        pending: this.pending.length,
        ackedTick: this.ackedTick,
        myId: this.myId,
        tick: this.lastSnapshot?.tick ?? 0,
        remote: this.currentRemote.length,
        // 位置与朝向：自动探针要靠它算走位，否则只能自己 hook WebSocket 解快照。
        x: Math.round(feet.x * 100) / 100,
        y: Math.round(feet.y * 100) / 100,
        z: Math.round(feet.z * 100) / 100,
        yaw: Math.round(sample.yaw * 1000) / 1000,
        fps: Math.round(this.fps),
        // 当前实际跑在哪张卡、哪一档画质：帧率低时先看这两个，
        // 而不是盲目怀疑代码。gpu 为空表示浏览器没暴露 UNMASKED_RENDERER。
        gpu: this.renderer.gpuInfo().renderer,
        quality: this.qualityTier,
        // 拿枪身份与开镜数值：换枪后模型/倍镜到底有没有跟着换，只能在这里看。
        weapon: this.heldWeapon,
        ammo: this.ammoBySlot[this.heldSlot] ?? 0,
        dry: this.dryShots,
        ads: this.input.ads,
        aim: this.renderer.aim(),
        // 三段耗时（ms）分开看，才能回答"10fps 是 CPU 还是 GPU"。
        sim: Math.round(this.costSim * 100) / 100,
        net: Math.round(this.costNet * 100) / 100,
        draw: Math.round(this.costDraw * 100) / 100,
        // 内核相位：固定步数/插值 alpha/系统数量。自动探针用它区分
        // "掉帧"与"固定步没跑满"——两者在 fps 上看起来一样。
        kernel: {
          frame: this.kernel.clock.time.frame,
          steps: this.lastKernelSteps,
          alpha: Math.round(this.kernel.clock.time.alpha * 1000) / 1000,
          systems: this.kernel.registry.size,
        },
        ...this.renderer.stats(),
      }
    }
  }

  /**
   * 击杀播报里的武器名。
   *
   * 以前两处都写死 `WEAPONS[1]!.name`（温菲尔德 M1873），于是换成神射手一枪爆头，
   * 播报里也照样念"温菲尔德 M1873"。快照里每个人的 weaponId 本来就有，按击杀者取，
   * 刀杀会正确显示"猎刀"。拿不到快照时才回落到自己的主武器。
   */
  private weaponNameOf(id: number): string {
    const player = this.lastSnapshot?.players.find((p) => p.id === id)
    return WEAPONS[player?.weaponId ?? this.options.primaryId]?.name ?? WEAPONS[1]!.name
  }

  private hudOf(me: PlayerSnapshot | null, tick: number): HudState {
    const self = me ?? this.lastSnapshot?.players.find((p) => p.id === this.myId) ?? null
    const spec = WEAPONS[self?.weaponId ?? 1]!
    const nearId = this.loot?.nearSpotId ?? SPOT_ID_NONE
    // 负数（-2..-64）= 动态尸体缓存；静态点才是 0..N。
    const nearBody = nearId < SPOT_ID_NONE
    const nearSpot = !nearBody && nearId >= 0 ? this.options.level.searchSpots?.[nearId] : undefined
    // 线索提示：服务端是"站进 3.2m 自动累积 4 秒"，没有按键。HUD 必须告诉
    // 玩家"你正在调查/站住别动"，否则他只会看到 0/3 永远不动。
    let clueNear = false
    let cluePct = 0
    const feet = this.character?.feet
    const clues = this.options.level.clues ?? []
    if (feet && this.objective && this.objective.phase === 'hunt') {
      const active = this.objective.clueIndex
      if (active >= 0 && active < clues.length) {
        const c = clues[active]!
        if (Math.hypot(feet.x - c.x, feet.z - c.z) <= CLUE_RADIUS) {
          clueNear = true
          cluePct = Math.round(this.objective.clueProgress * 100)
        }
      }
      if (!clueNear) {
        for (let i = 0; i < clues.length; i++) {
          if ((this.objective.clueMask & (1 << i)) !== 0) continue
          const c = clues[i]!
          if (Math.hypot(feet.x - c.x, feet.z - c.z) <= CLUE_RADIUS) {
            clueNear = true
            break
          }
        }
      }
    }
    return {
      health: self?.health ?? 0,
      ammo: self?.ammo ?? 0,
      reserve: self?.reserve ?? 0,
      reloading: self ? (self.flags & StateFlags.Reloading) !== 0 : false,
      weaponName: spec.name,
      ping: this.estimatePing(),
      tick,
      fps: this.fps,
      lootValue: this.loot?.value ?? 0,
      searchPct: this.loot?.searchPct ?? 0,
      searchLabel: nearBody ? '搜刮尸体' : nearSpot ? (SEARCH_LABEL[nearSpot.kind] ?? '搜索') : '',
      clueNear,
      cluePct,
      ads: this.input.ads,
      // 只给"真带镜"的枪（3 倍以上，现只有 3.8 倍神射手）上镜筒遮罩：
      // 1.7/1.3 倍走机械瞄具，遮成黑圈会让人看不见铁瞄，反而更难打。
      scoped: this.input.ads && (WEAPONS[this.heldWeapon]?.adsZoom ?? 1) >= SCOPE_MIN_ZOOM,
      bossPct: this.bossPct,
      bossKind: this.bossKind,
      modifierName: getModifier(this.modifierId >= 0 ? this.modifierId : 0).name,
      modifierDesc: getModifier(this.modifierId >= 0 ? this.modifierId : 0).desc,
      traits: this.options.traits,
      bandages: this.loot?.bandages ?? 0,
      healPct: this.loot?.healPct ?? 0,
    }
  }

  /**
   * 往返延迟的粗估：还没被服务端确认的输入条数 × 一个 tick 的时长。
   *
   * 用 pending 长度而不是 `seq - lastAckSeq`：后者是"累计发出过多少条"，
   * 只要曾经积压过一次（比如 WASM 初始化时的停顿），这个差值就再也回不去，
   * 表现为延迟数字一直挂在钳制上限上。pending 只会保留服务端尚未确认的
   * 输入，长度天然就是当前的往返延迟，且积压消退后它会自己降回去。
   */
  private estimatePing(): number {
    return Math.round(clamp(this.pending.length * TICK_MS, 0, 500))
  }
}

/** 在两份快照之间插值；`time` 是目标时间（服务端时间轴）。 */
function sampleAt(
  samples: { time: number; player: PlayerSnapshot }[],
  time: number,
): PlayerSnapshot | null {
  if (samples.length === 0) return null
  if (samples.length === 1) return samples[0]!.player

  // 找包含 time 的区间。
  let before = samples[0]!
  let after = samples[samples.length - 1]!
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!
    const b = samples[i + 1]!
    if (time >= a.time && time <= b.time) {
      before = a
      after = b
      break
    }
  }
  const span = after.time - before.time
  // 时间点落在所有样本之后 = 已经断流（对方掉线或我这边卡了）。
  // 这时把最后一个样本原样返回，不要外推：外推会让敌人继续往前走，
  // 而他其实早就站住了。
  if (span <= 0 || time >= after.time) return after.player
  if (time <= before.time) return before.player

  const t = (time - before.time) / span
  const p = before.player
  const n = after.player
  return {
    ...n,
    x: p.x + (n.x - p.x) * t,
    y: p.y + (n.y - p.y) * t,
    z: p.z + (n.z - p.z) * t,
    yaw: lerpAngle(p.yaw, n.yaw, t),
    pitch: p.pitch + (n.pitch - p.pitch) * t,
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/**
 * 命中点在屏幕上的方位角（相对当前朝向）。
 *
 * 返回的是"我在看的方向"到"伤害来源"的夹角，所以无论我朝哪看，
 * 屏幕上的红弧都指向正确的相对方位 —— 这是受击方向指示的全部意义。
 */
function angleTo(eye: Vec3, point: Vec3, yaw: number): number {
  const world = Math.atan2(-(point.x - eye.x), -(point.z - eye.z))
  return world - yaw
}

/**
 * 玩家显示名。
 *
 * P0 快照里不带昵称（省带宽，也避免把玩家名反复广播给所有人）。等接入
 * WebLearning 的账号体系后，这里换成从宿主拿到的猎人名；在此之前用 id
 * 代替，至少能看出"是谁杀的谁"。
 */
/** 怪物显示名。kind 是线上码（MonsterKindCode），不是 MonsterKind 字符串。 */
/**
 * 从 from 看向 to 的 yaw（弧度）。
 *
 * 与 math.ts 的 yawToForward 同源约定：yaw = 0 时朝 -Z，forward = (-sin, 0, -cos)。
 * 写成 atan2(-dx, -dz) 而不是 atan2(dx, dz)：差一个 π 就是"背对着地图中心出生"，
 * 那种错在截图里很难一眼看出，但玩家会一路往边界跑。
 */
function yawToward(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

function monsterNameOf(kind: number): string {
  if (kind === 1) return '沼泽猎犬'
  if (kind === 2) return '持枪行尸'
  if (kind === 3) return '屠夫'
  if (kind === 4) return '敲钟人'
  if (kind === 5) return '石心巨像'
  if (kind === 6) return '末班车长'
  return '沼泽行尸'
}

function nameOf(id: number): string {
  return id > 0 ? `猎人 #${id}` : '沼泽'
}

/** 角度插值要按最短弧，否则 179° → -179° 会转一大圈。 */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return a + delta * t
}

export { Buttons, SNAPSHOT_RATE }
