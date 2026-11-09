/**
 * 目标 HUD：线索点阵 / 比赛计时 / 阶段横幅 / 放逐与撤离进度 / 收场演出。
 *
 * ## 为什么是纯 DOM，一行 WebGL 都不碰
 * 主画面已经是 Three.js + Rapier 的满屏战斗，HUD 再要一个 canvas 上下文只会
 * 把 GPU 时间抢走；而这些信息全是"文字 + 条 + 环"，CSS 能画得更好也更省。
 * 整层合成完毕后，一帧的开销就是浏览器的合成器，主线程 0 工作。
 *
 * ## 为什么自己造 DOM 并选择挂到 #hud 以外
 * #hud 是 index.html 里的 flex 流式容器（生命 / 弹药 / 日志贴着底边走），
 * 往里插绝对定位的子节点会被 flex 布局一起卷进去，还要跟 #hp、#ammo 抢
 * justify-content；#hud 的 padding 与 gap 也会顺带影响我们。
 * 所以 createObjectiveHud(root) 收下 root（调用方传 #app 或 #hud 都行），
 * 自己 append 一个 position:fixed 的 host：fixed 让 host 完全脱出 root 的
 * 布局流，root 是谁都不再影响定位，dispose() 只摘掉这一个节点，root 里
 * 原本属于别人的节点一个都不碰。
 *
 * ## 每帧零分配 + 零 DOM 写入
 * update() 只在**值真的变了**时才写 DOM，而且所有写操作都是"比较整数缓存"：
 *   线索数  → found/total 两个整数
 *   阶段    → 字符串枚举引用比较
 *   计时    → 秒级整数（MM:SS 只在跨秒时才拼一次字符串）
 *   进度    → 量化到 1/200 的整数，变化不足 0.5% 直接跳过
 * 这样 120Hz 下调用 update() 也就是几次数值比较，不产生任何对象，
 * 不会触发 GC，更不会触发浏览器重排。
 *
 * ## 动画用 WAAPI 而不是 CSS class
 * 横幅可以被随时顶掉、收场演出需要"重置后重播"，这两件事用 class 切换都
 * 做不到可靠的重入（同名 class 连续增删会被浏览器合并进同一帧，表现是
 * 第二次播不出来）。WAAPI 的 animate() 每次返回独立句柄，cancel() 语义清晰，
 * 而且 fill:'none' + 关键帧终点 opacity:0 能保证播完自动回到不可见。
 *
 * 随机数只有一处（线索点的倾角），用写死种子的 mulberry32：Math.random
 * 会让同一局里 UI 的手作感每次刷新都重新长一遍。
 *
 * ## 过场"幕"为什么是四片遮幅而不是 mask
 * 墨迹擦开最直观的做法是 SVG/CSS mask 加径向渐变，但 mask 的每一帧都要重新
 * 光栅化遮罩（主线程 + 离屏纹理），而幕是**满屏**的 —— 在满屏尺寸上做这件事，
 * 代价比它换来的观感大得多。四片纯色面板各向一个方向平移则全部落在合成层上，
 * 主线程 0 工作，最后一段甚至不需要重绘。
 * 几何上四片各覆 56%（相邻两片重叠 12%），合起来是一块无缝的满屏黑；
 * 抽走时每片移出 101% 自身尺寸，中心线在抽走的头几十毫秒就让开了，
 * 所以「完全看不见准星」的窗口压得比 0.4s 更短。
 *
 * ## 死亡层为什么要挂到 body
 * 去饱和靠 mix-blend-mode: saturation 跟"下面的 canvas"混合，而混合只发生在
 * 同一个层叠上下文里：.dko 和 #dead 都带 position + z-index，会把混合隔离在
 * 自己那一组里，结果是一块纯灰板而不是把画面变灰。所以死亡层直接 append 到
 * body（和 #grain 用 multiply 是同一个套路），dispose() 时原样摘掉。
 */

import { CONTRACTS, RESPAWN_DELAY_MS, wrapAngle } from '@dk/shared'
import './hud.css'

// ---------------------------------------------------------------- 对外契约

export type MatchPhase = 'hunt' | 'banish' | 'extract' | 'over'

export interface ObjectiveModel {
  phase: MatchPhase
  /** 已收集线索数 */
  cluesFound: number
  cluesTotal: number
  /** 是否已经暴露 boss 巢穴位置 */
  lairRevealed: boolean
  /** 放逐进度 0..1，phase !== 'banish' 时忽略 */
  banishProgress: number
  /** 正在放逐/已持有赏金的玩家 id，0 = 没人 */
  bountyCarrier: number
  /** 玩家当前所在撤离点名字，'' = 不在撤离点内 */
  extractName: string
  /** 撤离进度 0..1 */
  extractProgress: number
  /** 本局剩余秒数 */
  secondsLeft: number
  /** 世界事件：0 无 / 1 补给空投 / 2 血月 */
  event?: number
  /** 事件剩余秒数 */
  eventSeconds?: number
  outcome: 'none' | 'escaped' | 'dead'

  // ---- 以下全部可选：服务端还在加三槽武器，接线前不传就整块不动 ----
  /** 当前武器槽：0 主 / 1 副 / 2 刀 */
  slot?: number
  /** 三槽的弹药快照；刀没有弹药数，只有"有没有装备" */
  slots?: { pr: number; sec: number; melee: boolean }
  /** 当前武器是否在换弹（沿用 index.html 的 is-reloading 抖动语义） */
  reloading?: boolean
  /** 服务端 Switching 标志：切枪动作进行中 */
  switching?: boolean
}

/** 过场幕的种类。kind 决定配色、时长档位与默认文案。 */
export type TransitionKind =
  | 'clue'
  | 'lair'
  | 'bounty'
  | 'extract'
  | 'escaped'
  | 'failed'
  | 'death'
  | 'revive'

export interface ObjectiveHud {
  update(model: ObjectiveModel): void
  /**
   * 每帧更新"携带者看到的撤离点方位"。
   *
   * 只给真正带着赏金的人：非携带者拿到的是"赏金在 #id 身上"，不该同时
   * 看到三个出口，否则信息稀缺就变成了免费地图。`active=false` 时整块隐藏。
   */
  updateBearing(
    yaw: number,
    x: number,
    z: number,
    active: boolean,
    extracts: { name: string; x: number; z: number }[],
  ): void
  /**
   * 顶部罗盘：N/E/S/W + 未收集线索 / 血巢 / 撤离点方位。
   *
   * 每帧跟 yaw 更新，不依赖 1Hz 的目标包；`clueMask < 0` 表示目标包还没到，
   * 这时只画基本方位，不画目标点。
   */
  updateCompass(
    yaw: number,
    x: number,
    z: number,
    clueMask: number,
    clues: { x: number; z: number }[],
    lair: { x: number; z: number } | null,
    extracts: { x: number; z: number }[],
  ): void
  updateContract(contract: number, progress: number): void
  banner(title: string, subtitle: string, tone?: 'amber' | 'blood' | 'bile'): void
  /**
   * 播一段全屏"幕"。
   * @param kind     幕的种类（决定配色 / 时长档位 / 默认文案）
   * @param title    大字；不传用内置文案，传 '' 表示这一幕不出卡（仍会压黑+墨溅）
   * @param subtitle 小字；不传用内置文案
   */
  playTransition(kind: TransitionKind, title?: string, subtitle?: string): void
  setVisible(visible: boolean): void
  dispose(): void
}

// ---------------------------------------------------------------- 常量

/**
 * 进度量化步数。要求是"变化小于 0.005 就跳过"，1/200 正好是 0.005，
 * 同时把 0.0049/0.0051 这类浮点抖动一起吃掉 —— 服务端每 tick 下发的
 * progress 是浮点数，直接比较会几乎每帧都不相等。
 */
const PROGRESS_STEPS = 200
/** 横幅入场 / 退场时长（毫秒）。入场用 clip-path 划开，占用主线程的时间极短。 */
const BANNER_IN = 520
const BANNER_OUT = 420
/** 横幅默认停留：要求 2.2 秒。自动播报用同一时长，玩家不用重新建立节奏感。 */
const BANNER_HOLD = 2200
/** 收场演进入场时长。死后可能立刻进结算，所以压到 0.9 秒。 */
const OUTCOME_IN = 900
/** 最后 60 秒转干血红并脉冲。 */
const CLOCK_CRITICAL = 60
/**
 * 线索点阵上限。契约说是 cluesTotal 个点，但这是外部（网络）来的数字，
 * 一个坏包写 1e6 就会在这条路径上 createElement 一百万次把页面打死。
 * 16 已经远超任何合理关卡设计（现有关卡 3 条线索）。
 */
const MAX_DOTS = 16
/** 线索点倾角种子：写死，保证同一局/同一刷新长得一样。 */
const SEED_DOT_TILT = 0x5eed1a17

const BANNER_TONE: Record<'amber' | 'blood' | 'bile', string> = {
  amber: 'dko-banner--amber',
  blood: 'dko-banner--blood',
  bile: 'dko-banner--bile',
}

/**
 * 幕的时间轴（毫秒）。
 * 硬指标：**屏幕中心（准星）被完全遮住的时间必须 < 400ms**，否则玩家会在
 * 自己看不见准星的半秒里被打死，然后认为是 BUG 而不是演出。
 * 这里的编排是：压黑 90ms → 完整盖住 CURTAIN_PEN(300ms) → 四片遮幅开始
 * 向四边抽走，中心线在抽走的头 60ms 内就让开了，合计约 360ms。
 * 总时长 1.0 / 1.2 秒：短了读不完一行字，长了像是掉帧。
 */
const CURTAIN_LIGHT = 1020
const CURTAIN_HEAVY = 1180
/** 遮幅完整盖住屏幕的时间（压黑之后） */
const CURTAIN_PEN = 300
/** 遮幅抽走的时长 */
const CURTAIN_OPEN = 300
/** 中央墨团消失的时间：它压在准星正上方，必须在 0.4s 内淡没 */
const CURTAIN_INK = 360
const CURTAIN_CARD_IN = 220
const CURTAIN_CARD_OUT = 240
/** 同一个 kind 在这段时间内重复触发会被吞掉（手动调用 + update 自动识别同帧去重） */
const CURTAIN_DEDUPE = 420
/** 复活闪白时长。必须短：玩家要立刻看清自己站在哪、谁在打他。 */
const DEATH_FLASH = 380
/** 切枪格子的动画时长（需求：0.2s） */
const SLOT_SWITCH = 200
/** 三槽的显示名，顺序 = slot 的 0/1/2 */
const SLOT_NAMES = ['主', '副', '刀']

type TransitionTone = 'amber' | 'bile' | 'blood' | 'bone'

const CURTAIN_TONE: Record<TransitionTone, string> = {
  amber: 'dko-curtain--amber',
  bile: 'dko-curtain--bile',
  blood: 'dko-curtain--blood',
  bone: 'dko-curtain--bone',
}

/**
 * 幕的默认文案。同一句话只在这里写一次：game.ts 想改词就传 title/subtitle，
 * 不传就按这张表来，避免两处各写一份、改一处漏一处。
 */
const TRANSITION_TEXT: Record<TransitionKind, { title: string; sub: string; tone: TransitionTone }> = {
  clue: { title: '线 索 已 齐', sub: '血巢的位置浮出来了', tone: 'amber' },
  lair: { title: '巢 穴 已 暴 露', sub: '血巢正在燃烧 · 全场都看见了', tone: 'bile' },
  bounty: { title: '赏 金 已 夺 取', sub: '带它走进撤离点', tone: 'amber' },
  extract: { title: '开 始 撤 离', sub: '别在最后一秒倒下', tone: 'bile' },
  escaped: { title: '撤 离 成 功', sub: '赏金已带走 · 猎场重置', tone: 'amber' },
  failed: { title: '撤 离 失 败', sub: '赏金丢了 · 猎场重置', tone: 'blood' },
  death: { title: '倒 下', sub: '血浸进泥里', tone: 'blood' },
  revive: { title: '重 新 站 起', sub: '枪还在手上', tone: 'bone' },
}

// ---------------------------------------------------------------- 小工具

/**
 * mulberry32：十行、全 32 位整数运算、跨浏览器逐位一致。
 * 与 props.ts / menu.ts 里的实现同源，内联而不是共享 —— 一处分隔就多一个
 * 被到处 import 的"工具模块"，而它真的只有十行。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 建节点并把文本写进 textContent —— 永远不拼 innerHTML（文案可能含玩家昵称）。 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 0..1 → 0..200 的整数刻度。仅用于"变没变"的判断与百分比文本。 */
function quantize(v: number): number {
  if (!Number.isFinite(v)) return 0
  const clamped = v < 0 ? 0 : v > 1 ? 1 : v
  return Math.round(clamped * PROGRESS_STEPS)
}

/** 整数刻度 → 百分比字符串。刻度是 1/200，所以一个刻度正好 0.5%。 */
function pctOf(step: number): string {
  return step / 2 + '%'
}

/**
 * 弹药数：外部（网络）来的数字，取整并夹到合理区间。
 * 坏包传 NaN / -3 / 1e9 都不能直接写进 DOM：NaN 会显示成"NaN"，
 * 1e9 会把格子撑破。夹取比校验便宜，也不会因为一次脏数据把 UI 弄坏。
 */
function countOf(v: number): number {
  if (!Number.isFinite(v)) return 0
  const n = Math.floor(v)
  return n < 0 ? 0 : n > 9999 ? 9999 : n
}

/** 秒 → MM:SS。只在跨秒时调用一次，所以这里的字符串拼接不是每帧分配。 */
function formatClock(totalSecs: number): string {
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

// ---------------------------------------------------------------- 主体

export function createObjectiveHud(root: HTMLElement): ObjectiveHud {
  // ---- 建 DOM（一次性；此后每帧零 createElement）----
  const host = el('div', 'dko')

  // 左上：线索
  const cluesBox = el('div', 'dko-clues')
  const cluesLabel = el('div', 'dko-clues-label', '线索')
  const cluesCount = el('span', 'dko-clues-count', '0/0')
  cluesLabel.append(cluesCount)
  const dotsRow = el('div', 'dko-dots')
  const lairFlag = el('div', 'dko-flag dko-flag--lair', '巢穴已暴露')
  const carrierFlag = el('div', 'dko-flag dko-flag--carrier', '赏金在逃')
  cluesBox.append(cluesLabel, dotsRow, lairFlag, carrierFlag)

  // 顶部中央：计时
  const clock = el('div', 'dko-clock')
  const clockNum = el('div', 'dko-clock-num', '--:--')
  const clockSub = el('div', 'dko-clock-sub', '剩余')
  clock.append(clockNum, clockSub)

  // 世界事件横幅：补给空投 / 血月。平时隐藏，事件期间挂在计时器下方。
  const eventBox = el('div', 'dko-event')
  const eventTitle = el('div', 'dko-event-title', '')
  const eventSub = el('div', 'dko-event-sub', '')
  eventBox.append(eventTitle, eventSub)

  // 合同进度：左下角的小条，只在本局接了合同时出现。
  const contractBox = el('div', 'dko-contract')
  const contractName = el('span', 'dko-contract-name', '')
  const contractProg = el('span', 'dko-contract-prog', '')
  contractBox.append(contractName, contractProg)

  // 携带赏金后的撤离点方位：三行"名字 距离 箭头"，只在本人携带时出现。
  const bearingBox = el('div', 'dko-bearing')
  const bearingRows = [0, 1, 2].map(() => {
    const row = el('div', 'dko-bearing-row')
    const name = el('span', 'dko-bearing-name', '')
    const dist = el('span', 'dko-bearing-dist', '')
    const arrow = el('span', 'dko-bearing-arrow', '')
    row.append(name, dist, arrow)
    bearingBox.append(row)
    return { row, name, dist, arrow }
  })

  // 顶部罗盘：四个方位字 + 三个线索 / 一个血巢 / 三个撤离点的小标记。
  const compass = el('div', 'dko-compass')
  const compassLabels = ['N', 'E', 'S', 'W'].map((text) => {
    const node = el('span', 'dko-compass-label', text)
    compass.append(node)
    return node
  })
  const cluePips = [0, 1, 2].map(() => {
    const node = el('i', 'dko-compass-pip dko-compass-pip--clue')
    compass.append(node)
    return node
  })
  const lairPip = el('i', 'dko-compass-pip dko-compass-pip--lair')
  const extractPips = [0, 1, 2].map(() => {
    const node = el('i', 'dko-compass-pip dko-compass-pip--extract')
    compass.append(node)
    return node
  })
  compass.append(lairPip, el('i', 'dko-compass-center'))

  // 阶段横幅（与收场演出刻意分成两层：横幅是"过程"，收场是"结局"，会同时出现）
  const bannerEl = el('div', 'dko-banner')
  const bannerTitle = el('div', 'dko-banner-title')
  const bannerSub = el('div', 'dko-banner-sub')
  bannerEl.append(bannerTitle, bannerSub)

  // 放逐：燃烧进度条
  const banishBox = el('div', 'dko-banish')
  const banishHead = el('div', 'dko-banish-head')
  const banishLabel = el('div', 'dko-banish-label', '放 逐')
  const banishPct = el('div', 'dko-banish-pct', '0%')
  banishHead.append(banishLabel, banishPct)
  const banishTrack = el('div', 'dko-banish-track')
  const banishFill = el('div', 'dko-banish-fill')
  banishTrack.append(banishFill)
  banishBox.append(banishHead, banishTrack)

  // 撤离：环形进度 + 点名
  const extractBox = el('div', 'dko-extract')
  const extractRing = el('div', 'dko-extract-ring')
  const extractPct = el('div', 'dko-extract-pct', '0%')
  extractRing.append(extractPct)
  const extractText = el('div', 'dko-extract-text')
  const extractName = el('div', 'dko-extract-name')
  const extractSub = el('div', 'dko-extract-sub', '撤 离 中')
  extractText.append(extractName, extractSub)
  extractBox.append(extractRing, extractText)

  // 收场：墨泼溅 + 大字
  const outcomeBox = el('div', 'dko-outcome')
  const outcomeSplash = el('div', 'dko-outcome-splash')
  const outcomeMark = el('div', 'dko-outcome-mark')
  outcomeBox.append(outcomeSplash, outcomeMark)

  // 过场幕：四片遮幅 + 中央墨团 + 标题卡
  const curtain = el('div', 'dko-curtain')
  const panelOut: { node: HTMLElement; tx: string }[] = [
    { node: el('i', 'dko-curtain-panel dko-curtain-panel--top'), tx: 'translate3d(0, -101%, 0)' },
    { node: el('i', 'dko-curtain-panel dko-curtain-panel--bottom'), tx: 'translate3d(0, 101%, 0)' },
    { node: el('i', 'dko-curtain-panel dko-curtain-panel--left'), tx: 'translate3d(-101%, 0, 0)' },
    { node: el('i', 'dko-curtain-panel dko-curtain-panel--right'), tx: 'translate3d(101%, 0, 0)' },
  ]
  const inkBlob = el('i', 'dko-curtain-ink')
  const curtainCard = el('div', 'dko-curtain-card')
  const curtainTitle = el('div', 'dko-curtain-title')
  const curtainSub = el('div', 'dko-curtain-sub')
  curtainCard.append(curtainTitle, curtainSub)
  curtain.append(panelOut[0].node, panelOut[1].node, panelOut[2].node, panelOut[3].node, inkBlob, curtainCard)

  // 武器槽位：右下角，压在 #ammo 大数字的上方（#ammo 是 main.ts 的契约，不动它）
  const slotsBox = el('div', 'dko-slots')
  const slotCells: HTMLElement[] = []
  const slotNums: HTMLElement[] = []
  for (let i = 0; i < SLOT_NAMES.length; i++) {
    const cell = el('div', 'dko-slot')
    const name = el('span', 'dko-slot-name', SLOT_NAMES[i])
    // 刀槽不给弹药数（刀没有弹药），给一个 clip-path 画的刀形图标
    const num = i === 2 ? el('span', 'dko-slot-blade') : el('span', 'dko-slot-num', '0')
    cell.append(name, num)
    slotsBox.append(cell)
    slotCells.push(cell)
    slotNums.push(num)
  }

  host.append(cluesBox, clock, eventBox, contractBox, compass, bearingBox, bannerEl, banishBox, extractBox, outcomeBox, slotsBox, curtain)
  root.append(host)

  // 死亡演出：去饱和层 + UI 层，都挂 body（见文件头的"为什么挂到 body"）
  const deathWash = el('div', 'dko-death-wash')
  const deathUi = el('div', 'dko-death-ui')
  const deathVignette = el('i', 'dko-death-vignette')
  const deathCard = el('div', 'dko-death-card')
  const deathTitle = el('div', 'dko-death-title', '倒 下')
  const deathSub = el('div', 'dko-death-sub', '猎 人 的 血 浸 进 泥 里')
  const deathCount = el('div', 'dko-death-count', '3')
  const deathHint = el('div', 'dko-death-hint', '等 待 复 活')
  deathCard.append(deathTitle, deathSub, deathCount, deathHint)
  const deathFlash = el('i', 'dko-death-flash')
  deathUi.append(deathVignette, deathCard, deathFlash)
  document.body.append(deathWash, deathUi)

  // ---- 缓存（全部是原始值，比较不产生对象）----
  let foundCache = -1
  let totalCache = -1
  let phaseCache: MatchPhase | null = null
  let lairCache = false
  let carrierCache = -1
  let clockCache = -1
  let eventCache = -1
  let eventSecCache = -1
  let criticalCache = false
  let banishCache = -1
  let extractOnCache = false
  let extractNameCache = ''
  let extractCache = -1
  let outcomeCache: ObjectiveModel['outcome'] | null = null
  let slotsOnCache = false
  let slotCache = -1
  let prCache = -1
  let secCache = -1
  let meleeCache: boolean | null = null
  let reloadCache: boolean | null = null
  let switchCache: boolean | null = null

  let dots: HTMLSpanElement[] = []
  let disposed = false

  // 减少动态：CSS 的 @media 管不到 WAAPI 关键帧（WAAPI 不走选择器），所以
  // 横幅/收场这两处的关键帧必须在 JS 里另判一次。构造期取一次 MediaQueryList
  // 并缓存，之后只读 .matches —— 每帧新建 MQL 会白白触发一次样式查询。
  const reducedMq: MediaQueryList | null = typeof document.defaultView?.matchMedia === 'function'
    ? document.defaultView.matchMedia('(prefers-reduced-motion: reduce)')
    : null

  // 横幅与收场各自的动画句柄集合。dispose / 被打断时必须 cancel，
  // 否则 fill:'forwards' 的残留会让元素卡在"播放中"的可见状态。
  const bannerAnims = new Set<Animation>()
  const outcomeAnims = new Set<Animation>()
  let bannerToken = 0

  // 线索点倾角：预先用固定种子摇好，进游戏后不再算随机数。
  const tiltRng = mulberry32(SEED_DOT_TILT)
  const tilts: number[] = []
  for (let i = 0; i < MAX_DOTS; i++) tilts.push((tiltRng() * 2 - 1) * 7)

  // ---- 内部实现 ----

  /**
   * 点阵按需增长 / 收缩。
   * 增长时逐个 append（不用 innerHTML 批量重建：重建会让"已找到"的动画
   * 全部重播一遍，表现为每拿到一条线索，之前所有点都重新溅一次）。
   * 收缩时只 remove 多余节点并截断索引，左侧已有的节点保持原样。
   */
  function ensureDots(total: number): void {
    const have = dots.length
    if (total === have) return
    if (total > have) {
      for (let i = have; i < total; i++) {
        const dot = el('span', 'dko-dot')
        // 倾角写进内联 transform：CSS 里那条 rotate(45deg) 只是默认值。
        // 动画全部落在伪元素上，所以这个 transform 从头到尾不会被覆盖。
        dot.style.transform = 'rotate(' + (45 + (tilts[i] ?? 0)) + 'deg)'
        dotsRow.append(dot)
        dots.push(dot)
      }
      return
    }
    for (let i = total; i < have; i++) dots[i].remove()
    dots.length = total
  }

  function stopBanner(): void {
    bannerToken++
    for (const anim of bannerAnims) anim.cancel()
    bannerAnims.clear()
    bannerEl.style.opacity = '0'
  }

  function startBannerOut(token: number): void {
    if (disposed || token !== bannerToken) return
    const outAnim = bannerEl.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: BANNER_OUT,
      easing: 'ease-out',
      fill: 'forwards',
    })
    bannerAnims.add(outAnim)
    outAnim.onfinish = (): void => {
      bannerAnims.delete(outAnim)
      if (disposed || token !== bannerToken) return
      // 内联 0 + cancel：先补静默态再撤动画，避免撤掉的瞬间闪回 opacity:1。
      bannerEl.style.opacity = '0'
      outAnim.cancel()
    }
    outAnim.oncancel = (): void => {
      bannerAnims.delete(outAnim)
    }
  }

  function playBanner(
    title: string,
    subtitle: string,
    tone: 'amber' | 'blood' | 'bile',
    hold: number,
  ): void {
    if (disposed) return
    // 同一时刻只留一条：先按掉上一条（含它的 onfinish 回调），再起新的。
    // 不排队是有意的 —— 连发时排队的结果是玩家在 3 秒后看到一条早已过期的
    // "放逐开始"，而屏幕上已经在撤离了。
    stopBanner()
    const token = bannerToken

    bannerEl.classList.remove('dko-banner--amber', 'dko-banner--blood', 'dko-banner--bile')
    bannerEl.classList.add(BANNER_TONE[tone])
    bannerTitle.textContent = title
    // 错版重影用 attr(data-text) 复制一份文案，所以 DOM 文本只写一次。
    bannerTitle.dataset['text'] = title
    bannerSub.textContent = subtitle

    // 入场："墨迹划开"——左右两侧黑纱先被 clip-path 裁到 0 宽，再横向张开。
    // 同时 scaleX 1.06 → 1 给一点回弹。clip-path 走主线程，但这个元素很小、
    // 只播 0.5 秒；换成宽高动画会连累整条横幅的 layout。
    // reduced-motion 下只留透明度：clip-path/scale 都是"位移"，正是要关掉的那类。
    const reduced = reducedMq?.matches === true
    const inFrames: Keyframe[] = reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          {
            opacity: 0,
            clipPath: 'inset(-12% 50% -12% 50%)',
            WebkitClipPath: 'inset(-12% 50% -12% 50%)',
            transform: 'translateX(-50%) scaleX(1.06)',
          },
          {
            opacity: 1,
            clipPath: 'inset(-12% -2% -12% -2%)',
            WebkitClipPath: 'inset(-12% -2% -12% -2%)',
            transform: 'translateX(-50%) scaleX(1)',
          },
        ]
    const inAnim = bannerEl.animate(inFrames, {
      duration: reduced ? 260 : BANNER_IN,
      easing: 'cubic-bezier(.16, .9, .22, 1)',
      fill: 'forwards',
    })
    bannerAnims.add(inAnim)
    inAnim.oncancel = (): void => {
      bannerAnims.delete(inAnim)
    }

    // 停留段用一条"什么都不变"的动画来计时，而不是 setTimeout：
    // 前者在标签页被切走时会跟着文档时间一起暂停，后者会在回来的一瞬间
    // 把早已到期的横幅直接抹掉。
    const holdAnim = bannerEl.animate([{ opacity: 1 }, { opacity: 1 }], {
      duration: Math.max(0, hold),
      fill: 'forwards',
    })
    bannerAnims.add(holdAnim)
    holdAnim.onfinish = (): void => {
      bannerAnims.delete(holdAnim)
      startBannerOut(token)
    }
    holdAnim.oncancel = (): void => {
      bannerAnims.delete(holdAnim)
    }
  }

  function stopOutcome(): void {
    for (const anim of outcomeAnims) anim.cancel()
    outcomeAnims.clear()
  }

  function trackOutcome(anim: Animation): void {
    outcomeAnims.add(anim)
    anim.oncancel = (): void => {
      outcomeAnims.delete(anim)
    }
    anim.onfinish = (): void => {
      outcomeAnims.delete(anim)
    }
  }

  function playOutcome(kind: 'escaped' | 'dead'): void {
    if (disposed) return
    stopOutcome()

    const escaped = kind === 'escaped'
    const mark = escaped ? '已 撤 离' : '猎 人 阵 亡'
    outcomeBox.classList.toggle('is-escaped', escaped)
    outcomeBox.classList.toggle('is-dead', !escaped)
    outcomeBox.classList.add('is-on')
    outcomeMark.textContent = mark
    outcomeMark.dataset['text'] = mark

    // reduced-motion：收场是"结局"，字必须留下，所以只淡入，不炸不砸。
    const reduced = reducedMq?.matches === true
    const dur = reduced ? 300 : OUTCOME_IN

    // 墨泼溅：从 0.55 倍炸到 1.04 倍再回落，毛边交给 CSS 的渐变形状，
    // 不再叠位移。
    const splashFrames: Keyframe[] = reduced
      ? [{ opacity: 0 }, { opacity: 0.86 }]
      : [
          { opacity: 0, transform: 'scale(.55) rotate(-6deg)' },
          { opacity: 1, offset: 0.34, transform: 'scale(1.04) rotate(1deg)' },
          { opacity: 0.86, transform: 'scale(1) rotate(0deg)' },
        ]
    const splash = outcomeSplash.animate(splashFrames, {
      duration: dur,
      easing: 'cubic-bezier(.14, .9, .2, 1)',
      fill: 'forwards',
    })
    trackOutcome(splash)

    // 大字：从压扁状态砸下来。整体 scale 不用会缩没 —— 这里只压 Y，
    // 保持字宽不变，观感更像"印章砸下"而不是"文字弹出"。
    const markFrames: Keyframe[] = reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: 'scale(1.6, .55) rotate(-4deg)' },
          { opacity: 1, offset: 0.42, transform: 'scale(.96, 1.04) rotate(-1deg)' },
          { opacity: 1, transform: 'scale(1) rotate(0deg)' },
        ]
    const punch = outcomeMark.animate(markFrames, {
      duration: dur,
      easing: 'cubic-bezier(.15, 1.3, .3, 1)',
      fill: 'forwards',
    })
    trackOutcome(punch)
  }

  function resetOutcome(): void {
    stopOutcome()
    // cancel 会撤掉 fill:'forwards'，元素自动回到 CSS 静默态（splash opacity:0）。
    outcomeBox.classList.remove('is-on', 'is-escaped', 'is-dead')
    outcomeMark.style.opacity = ''
  }

  // ---- 过场幕 ----

  // 幕的动画句柄：被顶掉、dispose、或换挡时必须 cancel，
  // 否则 fill:'forwards' 的残留会把遮幅卡在"抽到一半"的可见状态。
  const curtainAnims = new Set<Animation>()
  let curtainToken = 0
  let lastKind: TransitionKind | null = null
  let lastAt = 0

  function trackCurtain(anim: Animation): void {
    curtainAnims.add(anim)
    anim.oncancel = (): void => {
      curtainAnims.delete(anim)
    }
    anim.onfinish = (): void => {
      curtainAnims.delete(anim)
    }
  }

  function stopCurtain(): void {
    curtainToken++
    for (const anim of curtainAnims) anim.cancel()
    curtainAnims.clear()
    // 先把静默态写死再撤 class：cancel() 会撤掉 fill:'forwards'，
    // 遮幅会瞬间弹回"盖住全屏"，这时若 class 还在就会闪一帧黑。
    curtain.style.opacity = '0'
    curtain.classList.remove('is-on')
  }

  function playTransition(kind: TransitionKind, title?: string, subtitle?: string): void {
    if (disposed) return

    // 复活不是"幕"：只有一道闪白。它必须比任何幕都快 —— 玩家回来时眼睛
    // 还没适应就盖一块黑布，等于复活了还在挨打。
    if (kind === 'revive') {
      showDeath(false)
      return
    }

    // 去重：game.ts 手动调一次 playTransition，update() 同帧又会从状态变化里
    // 认出同一件事，不去重就会连播两遍（第二遍把第一遍顶掉，观感是幕闪了一下
    // 就从头再来）。420ms 足够覆盖"同一帧内两次调用"，又短于任何真实重复。
    const now = performance.now()
    if (kind === lastKind && now - lastAt < CURTAIN_DEDUPE) {
      // 去重时仍然要同步死亡层：死亡层是常驻状态，不是一次性演出。
      if (kind === 'death') showDeath(true)
      return
    }
    lastKind = kind
    lastAt = now

    if (kind === 'death') showDeath(true)

    const text = TRANSITION_TEXT[kind]
    const t = title ?? text.title
    const s = subtitle ?? text.sub
    // 死亡那一幕不出卡：字交给下面的死亡层（它要一直留到复活），
    // 否则同一句「倒 下」会上下叠着出现两次。
    const showCard = kind !== 'death' && t !== ''

    stopCurtain()
    const token = curtainToken
    const reduced = reducedMq?.matches === true
    // 重档：结局类幕多留 160ms 让字读完；过程类幕快一点，别打断节奏。
    const heavy = kind === 'escaped' || kind === 'failed' || kind === 'death'
    const total = heavy ? CURTAIN_HEAVY : CURTAIN_LIGHT

    curtain.classList.add('is-on')
    curtain.classList.remove('dko-curtain--amber', 'dko-curtain--bile', 'dko-curtain--blood', 'dko-curtain--bone')
    curtain.classList.add(CURTAIN_TONE[text.tone])
    curtainTitle.textContent = t
    // 错版重影用 attr(data-text) 复制一份文案，所以 DOM 文本只写一次。
    curtainTitle.dataset['text'] = t
    curtainSub.textContent = s

    // 收尾用一条"什么都不变"的动画计时，而不是 setTimeout：
    // 标签页被切走时它会跟着文档时间暂停，回来才不会一口气把幕抹掉。
    const tail = curtain.animate([{ opacity: 1 }, { opacity: 1 }], { duration: total, fill: 'forwards' })
    trackCurtain(tail)
    tail.onfinish = (): void => {
      curtainAnims.delete(tail)
      if (disposed || token !== curtainToken) return
      stopCurtain()
    }

    if (reduced) {
      // 降动态：只留透明度。遮幅不抽、墨团不炸，整块幕淡入淡出。
      // 关键帧自己写，是因为 WAAPI 不受 CSS 的 @media 管辖（同横幅的理由）。
      const fade = curtain.animate(
        [
          { opacity: 0, offset: 0 },
          { opacity: 0.9, offset: 0.2 },
          { opacity: 0.9, offset: 0.66 },
          { opacity: 0, offset: 1 },
        ],
        { duration: total, easing: 'linear', fill: 'forwards' },
      )
      trackCurtain(fade)
      if (showCard) {
        const cardFade = curtainCard.animate(
          [
            { opacity: 0, offset: 0 },
            { opacity: 1, offset: 0.24 },
            { opacity: 1, offset: 0.7 },
            { opacity: 0, offset: 1 },
          ],
          { duration: total, easing: 'linear', fill: 'forwards' },
        )
        trackCurtain(cardFade)
      }
      return
    }

    // 1) 压黑：steps(3) 硬切 90ms。手绘/漫画风格里连续的"淡入"会立刻被读成
    //    网页 UI，三段跳变更像老片子换本。
    const slam = curtain.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 90,
      easing: 'steps(3, end)',
      fill: 'forwards',
    })
    trackCurtain(slam)

    // 2) 墨团：从中心炸开、360ms 内淡没。它正压在准星上，必须在 0.4s 前消失。
    const ink = inkBlob.animate(
      [
        { opacity: 0, transform: 'translate(-50%, -50%) scale(.3) rotate(-10deg)' },
        { opacity: 0.92, offset: 0.3, transform: 'translate(-50%, -50%) scale(1.12) rotate(2deg)' },
        { opacity: 0.7, offset: 0.62, transform: 'translate(-50%, -50%) scale(1.32) rotate(8deg)' },
        { opacity: 0, transform: 'translate(-50%, -50%) scale(1.62) rotate(14deg)' },
      ],
      { duration: CURTAIN_INK, easing: 'cubic-bezier(.2, .8, .3, 1)', fill: 'forwards' },
    )
    trackCurtain(ink)

    // 3) 遮幅：先完整盖住 CURTAIN_PEN，再向四边抽走。
    //    抽走用 ease-out（cubic-bezier(.2,.86,.24,1)）：起步就快，中心线
    //    在头几十毫秒内就让开，"看不见准星"的窗口因此比 0.4s 更短。
    for (const panel of panelOut) {
      const open = panel.node.animate(
        [{ transform: 'translate3d(0, 0, 0)' }, { transform: panel.tx }],
        {
          duration: CURTAIN_OPEN,
          delay: CURTAIN_PEN,
          easing: 'cubic-bezier(.2, .86, .24, 1)',
          fill: 'forwards',
        },
      )
      trackCurtain(open)
    }

    // 4) 标题卡：位置在 38% 高度而不是正中 —— 准星在 50%，字压上去等于在
    //    最需要瞄准的那半秒里挡住准心。抬到 38% 后卡片可以留到 1 秒也不碍事。
    //    入场用"印章落下"：横向压扁的 scale 起手，落定时轻微过冲。
    if (showCard) {
      const cardIn = curtainCard.animate(
        [
          { opacity: 0, transform: 'translate(-50%, -50%) scale(1.06, .84) rotate(-1.8deg)' },
          { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(-1.2deg)' },
        ],
        { duration: CURTAIN_CARD_IN, delay: 70, easing: 'cubic-bezier(.16, .9, .22, 1)', fill: 'forwards' },
      )
      trackCurtain(cardIn)
      const cardOut = curtainCard.animate(
        [
          { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(-1.2deg)' },
          { opacity: 0, transform: 'translate(-50%, -50%) scale(1.03) rotate(-1.2deg)' },
        ],
        { duration: CURTAIN_CARD_OUT, delay: total - CURTAIN_CARD_OUT, easing: 'ease-in', fill: 'forwards' },
      )
      trackCurtain(cardOut)
    }
  }

  // ---- 死亡 / 复活 ----

  let deathShown = false
  let deathTimer = 0

  function playReviveFlash(): void {
    if (disposed) return
    // steps(4) 的硬闪，像老胶片断了一格。必须短：玩家要立刻看清自己站在哪。
    deathFlash.animate(
      [
        { opacity: 0 },
        { opacity: 0.95, offset: 0.22 },
        { opacity: 0.58, offset: 0.58 },
        { opacity: 0 },
      ],
      {
        duration: reducedMq?.matches === true ? 140 : DEATH_FLASH,
        easing: 'steps(4, end)',
        fill: 'forwards',
      },
    )
  }

  function showDeath(shown: boolean): void {
    if (shown === deathShown) return
    deathShown = shown
    deathWash.classList.toggle('is-on', shown)
    deathUi.classList.toggle('is-on', shown)

    if (shown) {
      // 倒计时用 shared 的复活等待时长，不抄数字：服务端哪天改成 5 秒，这里自动跟上。
      let left = Math.max(1, Math.round(RESPAWN_DELAY_MS / 1000))
      deathCount.textContent = String(left)
      if (deathTimer !== 0) window.clearInterval(deathTimer)
      deathTimer = window.setInterval((): void => {
        left--
        if (left > 0) {
          deathCount.textContent = String(left)
          return
        }
        // 归零不等于已经复活（复活由服务端确认），显示成省略号而不是 0，
        // 免得玩家以为卡在 0 秒。计时器同时摘掉，不在死后长期空转。
        deathCount.textContent = '· · ·'
        window.clearInterval(deathTimer)
        deathTimer = 0
      }, 1000)
      return
    }

    if (deathTimer !== 0) {
      window.clearInterval(deathTimer)
      deathTimer = 0
    }
    playReviveFlash()
  }

  /**
   * 死亡桥：**只读**地观察 main.ts 的 #dead。
   * main.ts 用 `#dead.style.display` 开关死亡屏，那是它的 DOM 契约，本模块不改它一个
   * 属性；这里只在它真的翻转时把布尔同步成自己的死亡演出。用 MutationObserver
   * 而不是每帧读样式：#dead 的 style 每次 onHud（约 120ms 一次）都可能被重写。
   * 拿不到节点（UI 被换掉）就整段跳过，调用方仍可显式 playTransition('death')。
   */
  const deadNode: HTMLElement | null = document.getElementById('dead')
  let deadObserver: MutationObserver | null = null
  if (deadNode !== null && typeof MutationObserver === 'function') {
    const node = deadNode
    deadObserver = new MutationObserver((): void => {
      if (disposed) return
      showDeath(getComputedStyle(node).display !== 'none')
    })
    deadObserver.observe(node, { attributes: true, attributeFilter: ['style', 'class'] })
  }

  // ---- 武器槽位 ----

  /** 切枪：格子只做 0.2s 的"抬一下"。右下角不能抢瞄准时的注意力。 */
  function playSlotSwitch(index: number): void {
    if (reducedMq?.matches === true) return
    const cell = slotCells[index]
    if (cell === undefined) return
    cell.animate(
      [
        { transform: 'translateY(0) scale(1)' },
        { transform: 'translateY(-3px) scale(1.07)', offset: 0.45 },
        { transform: 'translateY(0) scale(1)' },
      ],
      { duration: SLOT_SWITCH, easing: 'steps(2, end)' },
    )
  }

  function updateSlots(model: ObjectiveModel): void {
    const slots = model.slots
    const shown = slots !== undefined
    if (shown !== slotsOnCache) {
      slotsOnCache = shown
      slotsBox.classList.toggle('is-on', shown)
    }
    if (!shown || slots === undefined) return

    // 数字只在真的变了才写：120Hz 下每帧写 textContent 会触发排版。
    const pr = countOf(slots.pr)
    const sec = countOf(slots.sec)
    const melee = slots.melee === true
    if (pr !== prCache) {
      prCache = pr
      slotNums[0].textContent = String(pr)
    }
    if (sec !== secCache) {
      secCache = sec
      slotNums[1].textContent = String(sec)
    }
    if (melee !== meleeCache) {
      meleeCache = melee
      // 刀没装备：格子留位但压暗，玩家一眼能看出"这一槽没有东西"
      slotCells[2].classList.toggle('is-empty', !melee)
    }

    const rawSlot = model.slot
    const index = rawSlot === undefined || !Number.isFinite(rawSlot) ? 0 : rawSlot < 0.5 ? 0 : rawSlot < 1.5 ? 1 : 2
    if (index !== slotCache) {
      const prev = slotCache
      slotCache = index
      for (let i = 0; i < slotCells.length; i++) slotCells[i].classList.toggle('is-active', i === index)
      // 首次出现（prev < 0）不做切换动画：那是"HUD 刚起来"，不是玩家按了切枪键
      if (prev >= 0) playSlotSwitch(index)
    }

    const switching = model.switching === true
    if (switching !== switchCache) {
      switchCache = switching
      // 服务端的 Switching 标志：标志抬手时再抖一下。有些切枪是预输入，
      // slot 已经变了但枪还没抬起来，那时才是真正"换手"的一瞬。
      if (switching) playSlotSwitch(slotCache)
    }

    const reloading = model.reloading === true
    if (reloading !== reloadCache) {
      reloadCache = reloading
      // 换弹抖动只挂在当前槽的数字上，不再多一个全局状态类
      slotCells[slotCache].classList.toggle('is-reloading', reloading)
    }
  }

  // ---- 对外方法 ----

  function updateContract(contract: number, progress: number): void {
    if (contract <= 0) {
      contractBox.classList.remove('is-on')
      return
    }
    const spec = CONTRACTS[contract]
    if (!spec) {
      contractBox.classList.remove('is-on')
      return
    }
    contractBox.classList.add('is-on')
    const done = progress >= spec.target
    contractBox.classList.toggle('is-done', done)
    contractName.textContent = spec.name
    contractProg.textContent = done ? '完成 +$' + spec.reward : progress + '/' + spec.target
  }

  function update(model: ObjectiveModel): void {
    if (disposed) return

    // 幕的自动识别要"变化前后"两个值，而这一帧下面每个 section 都会就地写缓存，
    // 所以在最前面先留一份上一帧的快照。
    const prevFound = foundCache
    const prevLair = lairCache
    const prevCarried = carrierCache
    const prevExtract = extractOnCache
    const prevOutcome = outcomeCache

    // ---- 线索点阵 ----
    const rawTotal = Math.floor(model.cluesTotal)
    const total = rawTotal > 0 ? Math.min(rawTotal, MAX_DOTS) : 0
    ensureDots(total)

    let found = Math.floor(model.cluesFound)
    if (!(found >= 0)) found = 0
    if (found > total) found = total

    if (found !== foundCache || total !== totalCache) {
      foundCache = found
      totalCache = total
      cluesCount.textContent = found + '/' + total
      // toggle 的第二个参数是布尔：只有状态真的翻转的那个点才会触发样式重算，
      // 已经找到的点不会因为"再次 toggle(true)"而重播 CSS 动画。
      for (let i = 0; i < dots.length; i++) {
        dots[i].classList.toggle('is-found', i < found)
      }
    }

    // ---- 阶段 ----
    if (model.phase !== phaseCache) {
      phaseCache = model.phase

      const banishOn = model.phase === 'banish'
      banishBox.classList.toggle('is-on', banishOn)
      if (!banishOn) {
        // 只清缓存、不清数字：放逐完成那一帧 phase 已切到 extract，把条清零会让
        // 读数出现 100% → 0% 的跳变，看着像进度丢了。下一次放逐有新进度就会覆盖。
        banishCache = 0
      }

      // 刻意**不**在这里自动播横幅：阶段切换该说什么（"巢穴暴露"还是"赏金已夺取"）
      // 取决于达成方式，只有 game.ts 知道。HUD 主动插一条会和调用方同帧播的那条
      // 打架 —— 两个都播就是后一个顶掉前一个，看起来像横幅闪了一下就换词。
    }

    // ---- 放逐进度 ----
    if (model.phase === 'banish') {
      const step = quantize(model.banishProgress)
      if (step !== banishCache) {
        banishCache = step
        const text = pctOf(step)
        banishFill.style.width = text
        banishPct.textContent = text
      }
    }

    // ---- 计时 ----
    // Math.ceil：剩余 0.4 秒时显示 00:01 而不是 00:00，玩家不会以为已经结束。
    const secs = Math.max(0, Math.ceil(model.secondsLeft))
    if (secs !== clockCache) {
      clockCache = secs
      clockNum.textContent = formatClock(secs)
    }
    const critical = secs <= CLOCK_CRITICAL
    if (critical !== criticalCache) {
      criticalCache = critical
      clock.classList.toggle('is-critical', critical)
    }

    // ---- 世界事件横幅 ----
    const event = model.event ?? 0
    if (eventCache !== event) {
      eventCache = event
      eventBox.classList.toggle('is-on', event !== 0)
      eventBox.classList.toggle('is-blood', event === 2)
      if (event === 1) {
        eventTitle.textContent = '补 给 空 投'
        eventSub.textContent = '图心附近 · 高价值木箱'
      } else if (event === 2) {
        eventTitle.textContent = '血 月 升 起'
        eventSub.textContent = '怪物增多 · 现金 +25%'
      }
    }
    if (event === 2) {
      const eventSec = Math.max(0, Math.round(model.eventSeconds ?? 0))
      if (eventSecCache !== eventSec) {
        eventSecCache = eventSec
        eventSub.textContent = '怪物增多 · 现金 +25% · ' + eventSec + 's'
      }
    }

    // ---- 巢穴暴露 / 赏金持有 ----
    if (model.lairRevealed !== lairCache) {
      lairCache = model.lairRevealed
      lairFlag.classList.toggle('is-on', model.lairRevealed)
    }
    const carried = model.bountyCarrier > 0 ? 1 : 0
    if (carried !== carrierCache) {
      carrierCache = carried
      carrierFlag.classList.toggle('is-on', carried === 1)
    }

    // ---- 撤离 ----
    const inExtract = model.extractName !== ''
    if (model.extractName !== extractNameCache) {
      extractNameCache = model.extractName
      if (inExtract) extractName.textContent = model.extractName
    }
    // phase 走到 over 时即使 extractName 还没被清空也要收起，否则
    // "猎人阵亡"的大字会和撤离环同时挂在屏幕中央偏下，两个都看不清。
    const extractOn = inExtract && model.phase !== 'over'
    if (extractOn !== extractOnCache) {
      extractOnCache = extractOn
      extractBox.classList.toggle('is-on', extractOn)
    }
    if (extractOn) {
      const step = quantize(model.extractProgress)
      if (step !== extractCache) {
        extractCache = step
        const text = pctOf(step)
        // 只改一个自定义属性：conic-gradient 的色标位置由 CSS 里的 var() 决定，
        // 元素自身不用重建 background-image 字符串（那才是真正的分配大户）。
        extractRing.style.setProperty('--dkp', text)
        extractPct.textContent = text
      }
    }

    // ---- 收场 ----
    if (model.outcome !== outcomeCache) {
      outcomeCache = model.outcome
      if (model.outcome === 'none') resetOutcome()
      else playOutcome(model.outcome)
    }

    // ---- 武器槽位 ----
    updateSlots(model)

    // ---- 过场幕：从状态变化里认出"刚刚发生了什么事" ----
    // 顺序是有意的「越严重越靠后」：playTransition 同一时刻只演一幕，
    // 后调用的会把前一个顶掉，所以终局那一幕总能压过过程播报。
    // prevFound < 0 说明还在首帧（缓存都是初值），初始状态不是"刚发生的事"，不播。
    if (prevFound >= 0) {
      if (total > 0 && found >= total && prevFound < total) playTransition('clue')
      if (model.lairRevealed && !prevLair) playTransition('lair')
      if (carried === 1 && prevCarried === 0) playTransition('bounty')
      if (extractOn && !prevExtract) playTransition('extract')
      // 复活不在这里认：update 只拿得到 outcome，看不到血量。
      // death / revive 由 game.ts 显式调 playTransition，或由 #dead 的观察者触发。
      if (model.outcome !== 'none' && model.outcome !== prevOutcome) {
        playTransition(model.outcome === 'escaped' ? 'escaped' : 'failed')
      }
    }
  }

  function banner(title: string, subtitle: string, tone: 'amber' | 'blood' | 'bile' = 'amber'): void {
    playBanner(title, subtitle, tone, BANNER_HOLD)
  }

  /**
   * 携带赏金时的三个撤离点方位。
   *
   * 每帧调用；只有"名字/距离/箭头"真正变化时才写 DOM。`active=false` 时
   * 整块隐藏（非携带者看不到出口，保留信息稀缺）。
   */
  const BEARING_ARROWS = ['↑', '↖', '←', '↙', '↓', '↘', '→', '↗']
  let bearingKey = ''
  function updateBearing(
    yaw: number,
    x: number,
    z: number,
    active: boolean,
    extracts: { name: string; x: number; z: number }[],
  ): void {
    if (disposed) return
    if (!active || extracts.length === 0) {
      if (bearingBox.classList.contains('is-on')) {
        bearingBox.classList.remove('is-on')
        bearingKey = ''
      }
      return
    }
    bearingBox.classList.add('is-on')
    const sorted = extracts
      .map((e) => ({ ...e, d: Math.hypot(e.x - x, e.z - z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
    let key = ''
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i]!
      const rel = wrapAngle(Math.atan2(-(e.x - x), -(e.z - z)) - yaw)
      const arrow = BEARING_ARROWS[Math.round(rel / (Math.PI / 4)) & 7] ?? '↑'
      key += `${e.name}:${Math.round(e.d)}:${arrow}|`
    }
    if (key === bearingKey) return
    bearingKey = key
    for (let i = 0; i < bearingRows.length; i++) {
      const row = bearingRows[i]!
      const e = sorted[i]
      if (!e) {
        row.row.style.display = 'none'
        continue
      }
      row.row.style.display = ''
      const rel = wrapAngle(Math.atan2(-(e.x - x), -(e.z - z)) - yaw)
      row.name.textContent = e.name
      row.dist.textContent = Math.round(e.d) + 'm'
      row.arrow.textContent = BEARING_ARROWS[Math.round(rel / (Math.PI / 4)) & 7] ?? '↑'
    }
  }

  /**
   * 顶部罗盘：只显示前方 180°（背后目标藏起来，免得左右两边各出现一个
   * 同一个方向的镜像）。每帧只写"位置真的变了"的标记。
   */
  const compassLeft = new WeakMap<HTMLElement, number>()
  function updateCompass(
    yaw: number,
    x: number,
    z: number,
    clueMask: number,
    clues: { x: number; z: number }[],
    lair: { x: number; z: number } | null,
    extracts: { x: number; z: number }[],
  ): void {
    if (disposed) return
    const place = (node: HTMLElement, rel: number): void => {
      if (Math.abs(rel) > Math.PI / 2 + 0.02) {
        if (node.style.display !== 'none') node.style.display = 'none'
        return
      }
      if (node.style.display === 'none') node.style.display = ''
      // 屏幕 x：rel 正 = 目标在左（yaw 正方向是左转），所以左边用负号。
      const pct = Math.round((50 - (rel / (Math.PI / 2)) * 50) * 10) / 10
      if (compassLeft.get(node) !== pct) {
        compassLeft.set(node, pct)
        node.style.left = pct + '%'
      }
    }
    const relOf = (tx: number, tz: number): number =>
      wrapAngle(Math.atan2(-(tx - x), -(tz - z)) - yaw)

    // N / E / S / W：世界坐标里北 = -Z，东 = +X。方位角是"方向"，
    // 不能把 (0,-1) 当坐标点传给 relOf —— 那样玩家离原点越远，四个字越挤在一起。
    const cardinalBearings = [0, -Math.PI / 2, Math.PI, Math.PI / 2]
    for (let i = 0; i < cardinalBearings.length; i++) {
      place(compassLabels[i]!, wrapAngle(cardinalBearings[i]! - yaw))
    }

    for (let i = 0; i < 3; i++) {
      const c = clues[i]
      const found = clueMask >= 0 && (clueMask & (1 << i)) !== 0
      if (!c || found) {
        if (cluePips[i]!.style.display !== 'none') cluePips[i]!.style.display = 'none'
        continue
      }
      place(cluePips[i]!, relOf(c.x, c.z))
    }

    if (lair) place(lairPip, relOf(lair.x, lair.z))
    else if (lairPip.style.display !== 'none') lairPip.style.display = 'none'

    for (let i = 0; i < 3; i++) {
      const e = extracts[i]
      if (!e) {
        if (extractPips[i]!.style.display !== 'none') extractPips[i]!.style.display = 'none'
        continue
      }
      place(extractPips[i]!, relOf(e.x, e.z))
    }
  }

  function setVisible(visible: boolean): void {
    if (disposed) return
    host.classList.toggle('is-off', !visible)
    // 隐藏时把正在播的横幅与幕按掉：留下它只会在下次显示时已经放完。
    // 收场演出不清 —— 那是"本局结果"，重新显示时应该还在。
    if (!visible) {
      stopBanner()
      stopCurtain()
    }
  }

  function dispose(): void {
    if (disposed) return
    stopBanner()
    stopOutcome()
    stopCurtain()
    if (deathTimer !== 0) window.clearInterval(deathTimer)
    deathTimer = 0
    if (deadObserver !== null) deadObserver.disconnect()
    deadObserver = null
    disposed = true
    host.remove()
    // 死亡层挂在 body 上（不是 host 的子节点），必须单独摘
    deathWash.remove()
    deathUi.remove()
    dots = []
  }

  return { updateContract, update, updateBearing, updateCompass, banner, playTransition, setVisible, dispose }
}
