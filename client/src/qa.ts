/**
 * QA 验收基础设施：URL 参数 + 诊断全局。
 *
 * 为什么单独一个模块：这些开关**不参与游戏设计**，只服务于"同一张图、同一个
 * seed、同一条相机路径，换一台机器也能复现"。把它们散进 main.ts / game.ts /
 * render.ts 的话，任何一次重构都可能顺手删掉一个参数，而删除不会报错 ——
 * 只会让自动截图在某天悄悄变成"一张看起来差不多的图"。
 *
 * 约定（写进 docs/QA与验收.md）：
 *   ?q=performance|balanced|quality|auto   固定画质档（low/medium/high/ultra 亦可）
 *   ?scale=0.6..1                          固定渲染分辨率倍率
 *   ?wet=0..1                              固定场景湿度（朝上表面压暗/降粗糙）
 *   ?reload=0..1                           强制换弹进度（配合 show=weapon 看时间轴）
 *   ?seed=4207                             固定程序化随机种子（game.ts 读取）
 *   ?noaudio=1                             不创建/不解锁音频，便于无声环境跑基准
 *   ?post=0                                关闭泛光/颗粒/暗角/色差/锐化/接触阴影
 *   ?postfail=1                            强制绕过整条后处理链，验证前向直出回退
 *   ?autostart=1                           跳过主界面直接进场（shot/bench/show 隐含）
 *   ?dt=0                                  冻结模拟，只重绘；?dt=16.67 固定每帧 16.67ms
 *   ?cam=x,y,z,tx,ty,tz                    固定机位（世界坐标，看向 target）
 *   ?vm=0                                  隐藏第一人称武器层（纯场景截图）
 *   ?hud=0                                 隐藏 HUD/颗粒/暗角/准星
 *   ?shot=1                                截图模式：稳定 12 帧后 __shotReady=true
 *   ?bench=1                               基准模式：绕玩家 360° 巡游 600 帧后输出 __bench
 *   ?show=lair|clue|spawn                  子系统/地点展示：进场后自动摆到该点
 *   ?map=<levelId>                         关卡（level-choice.ts 读取）
 *   ?time=day|night|7|19                   时段（07:00 / 19:00），约束本局天气池
 */

import type { MatchTimeBand } from '@dk/shared'

import type { GraphicsQuality, MenuSettings } from './settings.ts'

/** 固定机位：世界坐标位置 + 注视点。 */
export interface QaCamera {
  x: number
  y: number
  z: number
  tx: number
  ty: number
  tz: number
}

export interface QaParams {
  /** 固定随机种子；null = 每次启动随机。真正的读取在 game.ts（同一份）。 */
  seed: number | null
  quality: GraphicsQuality | null
  renderScale: number | null
  /** 固定场景湿度 0..1；null = 跟随每局天气修饰。 */
  wet: number | null
  /** 强制换弹进度 0..1，用于展示时间轴；null = 跟随玩家状态。 */
  reload: number | null
  /** `?show=weapon` 的机位距离（米）。近景检查模型细节时用 0.35~0.45。 */
  vmdist: number | null
  /**
   * `?build=brake,scope4,heavy`：强制一套配件外观，用于给每件配件拍验收图。
   * 只影响外观，不改数值（数值仍由服务端按真实 build 算）。
   */
  build: string | null
  /** `?colliders=1`：把参与碰撞的盒刷画成线框（含 noRender 隐形骨架）。 */
  colliders: boolean
  /** `?story=1`：给叙事静物插标记杆，用于「这段叙事到底摆在哪」的定位与验收。 */
  story: boolean
  /**
   * `?match=xxx`：覆盖 QA 自动进场用的房间号。
   *
   * 不带这个参数时永远是 `qa` 房间，而**服务端按房间第一位玩家的图定关卡** ——
   * 于是同一台服务端上，第二次 `?map=quarry` 拍到的还是第一次那张图。
   * 想逐图验收就必须换房间号。
   */
  match: string | null
  /**
   * `?time=day|night`：把这一局钉在 07:00 或 19:00。
   *
   * 之前验收只能用 `fx-N` 一个个试，因为天气是房间种子抽的；有了这个参数，
   * 画质对比不用再靠运气 —— 光位、雾色、曝光至少有一半变量被钉住。
   */
  time: MatchTimeBand | null
  noaudio: boolean
  /** false = ?post=0，关闭画面风格层。 */
  post: boolean
  /** true = ?postfail=1，强制绕过整条后处理链，验证前向直出回退。 */
  postFail: boolean
  autostart: boolean
  /** 固定每帧时长（秒）。0 = 冻结模拟，只重绘。 */
  fixedDt: number | null
  cam: QaCamera | null
  show: string | null
  shot: boolean
  bench: boolean
  hud: boolean
  viewmodel: boolean
  /** 原始 query，__stats() 里回显，便于截图留档对账。 */
  source: string
}

/** 画质别名的唯一映射处。手册用的 low/medium/high/ultra 与项目的三档对齐。 */
const QUALITY_ALIASES: Record<string, GraphicsQuality> = {
  low: 'performance',
  performance: 'performance',
  medium: 'balanced',
  balanced: 'balanced',
  test: 'balanced',
  high: 'quality',
  quality: 'quality',
  ultra: 'quality',
  auto: 'auto',
}

function has(trueish: string | null): boolean {
  if (trueish === null || trueish === '' || trueish === '1' || trueish === 'true') return true
  return !(trueish === '0' || trueish === 'false')
}

function flag(params: URLSearchParams, key: string, fallback: boolean): boolean {
  if (!params.has(key)) return fallback
  return has(params.get(key))
}

function finite(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function clamp(value: number | null, lo: number, hi: number): number | null {
  if (value === null) return null
  return Math.min(hi, Math.max(lo, value))
}

function parseQuality(raw: string | null): GraphicsQuality | null {
  if (raw === null) return null
  return QUALITY_ALIASES[raw.trim().toLowerCase()] ?? null
}

function parseCamera(raw: string | null): QaCamera | null {
  if (raw === null) return null
  const parts = raw.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return null
  return { x: parts[0]!, y: parts[1]!, z: parts[2]!, tx: parts[3]!, ty: parts[4]!, tz: parts[5]! }
}

/** 时段：接受 day/night 与两个整点，其它一律当"没指定"。 */
function parseTimeBand(raw: string | null): MatchTimeBand | null {
  if (raw === null) return null
  const key = raw.trim().toLowerCase()
  if (key === 'day' || key === '7' || key === '07:00' || key === '07') return 'day'
  if (key === 'night' || key === '19' || key === '19:00') return 'night'
  return null
}

function parseSeed(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null
  return Number.parseInt(raw, 10) >>> 0
}

/**
 * 解析 URL 参数。导出是为了单测：`location.search` 在 Node 里不存在，
 * 而参数解析恰恰是最容易写错（0 被当成假、笛卡尔积手误）的一段。
 */
export function parseQa(source: string): QaParams {
  let params = new URLSearchParams()
  try {
    params = new URLSearchParams(source)
  } catch {
    // 畸形 query：全部走默认值。
  }

  const shot = flag(params, 'shot', false)
  const bench = flag(params, 'bench', false)
  const show = params.get('show')
  // 截图/基准/展示都要求"已经在局内"，不自动进场等于参数完全无效。
  const autostart = flag(params, 'autostart', false) || shot || bench || show !== null

  const dtMs = finite(params.get('dt'))
  // ?show= 是"看场景"，默认不出 HUD、不出枪；要保留就显式 ?hud=1 ?vm=1。
  // 例外是 show=weapon：它展示的就是枪，默认必须保留武器层。
  const scenic = show !== null
  const clean = show !== null && show !== 'weapon'
  return {
    seed: parseSeed(params.get('seed')),
    quality: parseQuality(params.get('q')),
    renderScale: clamp(finite(params.get('scale')), 0.5, 1),
    wet: clamp(finite(params.get('wet')), 0, 1),
    reload: clamp(finite(params.get('reload')), 0, 1),
    vmdist: finite(params.get('vmdist')),
    build: params.get('build'),
    colliders: flag(params, 'colliders', false),
    story: flag(params, 'story', false),
    match: params.get('match'),
    time: parseTimeBand(params.get('time')),
    noaudio: flag(params, 'noaudio', false),
    post: flag(params, 'post', true),
    postFail: flag(params, 'postfail', false),
    autostart,
    // dt 以毫秒书写（16.67 = 60Hz）；0 是冻结，不是"没设"。
    fixedDt: dtMs === null ? null : Math.max(0, dtMs) / 1000,
    cam: parseCamera(params.get('cam')),
    show,
    shot,
    bench,
    hud: flag(params, 'hud', !scenic),
    viewmodel: flag(params, 'vm', !clean),
    source,
  }
}

/** 启动时解析一次。后续再改 URL 不会生效：截图必须钉在同一个状态上。 */
export const qa: QaParams = parseQa(typeof location === 'undefined' ? '' : location.search)

/**
 * 把 QA 覆盖叠到玩家设置上。
 *
 * 只复制、不写回 localStorage：一次 `?q=low` 不该永久把玩家的画质改掉。
 * 返回值交给 Game 构造函数，菜单里的滑条仍然显示玩家自己的设置。
 */
export function applyQaSettings(settings: MenuSettings): MenuSettings {
  if (qa.quality === null && qa.renderScale === null && !qa.noaudio) return settings
  const next = { ...settings }
  if (qa.quality !== null) next.graphics = qa.quality
  if (qa.renderScale !== null) next.renderScale = qa.renderScale
  if (qa.noaudio) next.volume = 0
  return next
}

// ------------------------------------------------------------------ 诊断

/**
 * 诊断状态。
 *
 * 单独抽成对象（而不是直接往 window 上挂）是为了让 Game 能在不碰 DOM 的地方
 * 打点；`installDiagnostics()` 只做一件事：把同一份数据映射成手册约定的
 * `__ready / __fatal / __errors / __stats`。
 */
export interface DiagnosticsState {
  readonly errors: string[]
  fatal: string | null
  /** 至少两帧真正渲染完成。 */
  ready: boolean
  /** 截图/基准模式下稳定 N 帧。 */
  shotReady: boolean
  frames: number
  shotFrames: number
  markFrame(): void
  /** 只记一条错误，不升级成 fatal（运行期可恢复的错误走这里）。 */
  record(error: unknown): void
  /** 记录并把第一条升级成 fatal（启动失败、无法继续的错误）。 */
  fail(error: unknown): void
  reset(): void
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 稳定多少帧后才认为截图可用：首帧可能还在编译着色器/上传纹理。 */
const SHOT_SETTLE_FRAMES = 12
/** 错误最多留多少条：每帧刷屏时不能让诊断本身吃掉内存。 */
const MAX_ERRORS = 100

export const diag: DiagnosticsState = {
  errors: [],
  fatal: null,
  ready: false,
  shotReady: false,
  frames: 0,
  shotFrames: 0,
  markFrame(): void {
    this.frames++
    if (!this.ready && this.frames >= 2) this.ready = true
    if (!this.shotReady && (qa.shot || qa.bench)) {
      this.shotFrames++
      if (this.shotFrames >= SHOT_SETTLE_FRAMES) this.shotReady = true
    }
  },
  record(error: unknown): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(describe(error))
  },
  fail(error: unknown): void {
    if (this.fatal === null) this.fatal = describe(error)
    this.record(error)
  },
  reset(): void {
    this.errors.length = 0
    this.fatal = null
    this.ready = false
    this.shotReady = false
    this.frames = 0
    this.shotFrames = 0
  },
}

let statsProvider: (() => unknown) | null = null
let installed = false

/** main.ts 注册：`__stats()` 在局内回传渲染器/网络读数，在大厅回传菜单状态。 */
export function setStatsProvider(provider: (() => unknown) | null): void {
  statsProvider = provider
}

/**
 * 安装诊断全局。幂等：重复调用（例如热重载）不会叠多层 console 包装。
 *
 * 同时接管 console.error：模块初始化阶段的异常会被浏览器吞进控制台，
 * 而无头截图只能读 window 上的东西 —— 这是让 `__errors` 真正为空/非空
 * 有意义的唯一办法。
 */
export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const originalError = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    diag.record(args.map(describe).join(' '))
    originalError(...args)
  }

  // console.error 抓不到未捕获异常/被拒绝的 Promise —— 它们恰恰是"画面
  // 停住但控制台没人看"的主要来源。只记录，不升级成 fatal。
  window.addEventListener('error', (event) => {
    diag.record(event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    diag.record(event.reason)
  })

  const w = window as unknown as Record<string, unknown>
  const define = (key: string, get: () => unknown): void => {
    Object.defineProperty(w, key, { get, configurable: true })
  }
  define('__ready', () => diag.ready)
  define('__fatal', () => diag.fatal)
  define('__errors', () => diag.errors)
  define('__shotReady', () => diag.shotReady)
  w.__stats = (): unknown => ({
    ready: diag.ready,
    fatal: diag.fatal,
    errors: diag.errors.length,
    frames: diag.frames,
    params: qa.source,
    ...(statsProvider === null ? {} : (statsProvider() as Record<string, unknown>)),
  })
  w.__diag = diag
  w.__qa = qa
}

// ------------------------------------------------------------------ 基准

export interface BenchResult {
  frames: number
  avg: number
  median: number
  p99: number
  min: number
  max: number
  /** 超过 50ms 的帧数：avg/p99 会被一次 100ms 尖峰稀释，这个数不会。 */
  hitches: number
  gpu: string
}

/**
 * 把逐帧毫秒整理成 avg/median/p99。
 *
 * p99 比 avg 重要：平均 16ms 但每两秒一次 80ms 卡顿，玩家感受到的是后者。
 * 排序一份副本，不改变调用方的采样顺序。
 */
export function summarizeFrames(samples: readonly number[], gpu: string): BenchResult | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, n) => acc + n, 0)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
  return {
    frames: sorted.length,
    avg: Math.round((sum / sorted.length) * 100) / 100,
    median: Math.round(at(0.5) * 100) / 100,
    p99: Math.round(at(0.99) * 100) / 100,
    min: Math.round(sorted[0]! * 100) / 100,
    max: Math.round(sorted[sorted.length - 1]! * 100) / 100,
    hitches: samples.reduce((count, ms) => count + (ms > 50 ? 1 : 0), 0),
    gpu,
  }
}
