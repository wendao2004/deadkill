/**
 * 命中反馈层：命中标记、击杀播报、受击方向弧、飘伤害数字、死亡/复活演出。
 *
 * ## 为什么自己造 DOM 而不是改 index.html
 * 所有 HUD 节点的 id 都被 main.ts 用 need() 硬绑着，index.html 现在也由别人在改，
 * 所以这一层**自己 createElement + 自己 append** 到传入的 container，
 * 样式也自己注入一个 <style>，宿主页面一行都不用动。
 *
 * 部署环境的 CSP 是 default-src 'self'; img-src 'self' data: blob:，
 * 禁止外链字体/图片，因此所有图形都是纯 CSS：平涂色块 + 3px 油墨描边 +
 * **零模糊的错位硬投影**。模糊投影会瞬间把画面拉回「通用 Web UI」，
 * 和卡通描边的场景打架 —— 所以这里所有 box-shadow / text-shadow
 * 的模糊半径一律为 0。
 *
 * ## 为什么动画只碰 transform / opacity
 * 每帧改 top/left/width 会让浏览器走一遍 layout + paint，60fps 下就是整屏重排。
 * transform / opacity 走合成器。
 *
 * ## 为什么 update(dt) 里绝不查 DOM
 * 元素引用全部在构造函数里缓存好（伤害数字和受击弧是预分配的池），
 * update 只做「读自己的数值 → 写 style」两件事。
 *
 * ## 层级
 * 根节点 z-index 8：压在 #hud(7) 之上、**#dead(9) 之下**。死亡遮罩由 main.ts
 * 控制，它必须永远赢，否则死亡画面会被自己的击杀播报盖住。
 */

export interface FeedbackOptions {
  container: HTMLElement
}

/** 命中标记总时长（毫秒）。180ms ≈ 11 帧，够看清又不糊视线。 */
const HIT_MS = 180
/** 击杀播报停留时长（秒），之后开始滑出。 */
const KILL_HOLD = 4
/** 滑出用时（秒）。 */
const KILL_SLIDE = 0.3
/** 同时可见的播报行上限；再多会把右侧糊成一堵墙。 */
const MAX_KILL_ROWS = 6
/** 同时在屏的受击弧上限；超过 4 道就是一个实心红环，方向信息全丢。 */
const MAX_ARCS = 4
/** 受击弧淡出时长（秒）。 */
const ARC_LIFE = 0.7
/** 同时在屏的伤害数字上限，超了直接丢新的（连喷时宁可少字也别掉帧）。 */
const MAX_NUMBERS = 12
/** 伤害数字上飘时长（秒）。 */
const NUMBER_LIFE = 0.6
/** 一帧最大推进量：切标签页回来会甩出一个巨大的 dt，钳住避免特效瞬间过期。 */
const MAX_STEP = 0.1

interface KillRow {
  el: HTMLDivElement
  age: number
}

interface ArcSlot {
  wrap: HTMLDivElement
  seg: HTMLDivElement
  active: boolean
  age: number
}

interface NumberSlot {
  el: HTMLDivElement
  active: boolean
  age: number
  /** 生成时定下的随机偏移，保证同一时刻的多个数字不重叠成一坨。 */
  ox: number
  oy: number
}

const CSS = `
  /* 根层：铺满视口但不吃鼠标事件，层级压在 #dead(9) 之下。 */
  .dkfb {
    position: fixed; inset: 0;
    pointer-events: none;
    z-index: 8;
    font-family: var(--font-ui);
    color: var(--paper);
  }

  /* ---------- 命中标记：两根 ±45° 的墨条拼成 X ---------- */
  /* 用两根旋转的 div 而不是 SVG/字体：没有外部资源，且整体 scale 一次就是
     整个 X 缩放，动画只需要一条 transform 关键帧。 */
  .dkfb-hit {
    position: fixed; left: 50%; top: 50%;
    width: 44px; height: 44px;
    pointer-events: none;
    opacity: 0;
    transform: translate(-50%, -50%) scale(1);
    will-change: transform, opacity;
  }
  /* 爆头：整体变大一号，墨条换成血红（静态 class，不进动画）。 */
  .dkfb-hit--head { pointer-events: none; width: 58px; height: 58px; }
  /* 墨条是 fixed，但对的是 .dkfb-hit 而不是视口：外壳那个恒等 transform
     使它成为 fixed 后代的包含块，于是 left/top/width 都按 44×44 算。 */
  .dkfb-hit-bar {
    position: fixed; left: 0; top: 50%;
    width: 100%; height: 4px;
    pointer-events: none;
    background: var(--paper);
    border: 3px solid var(--ink);
    /* 硬投影：纯偏移，模糊半径 0 —— 印刷错位感，不是网页的柔和阴影。 */
    box-shadow: 4px 4px 0 rgba(18, 16, 14, 0.55);
  }
  .dkfb-hit-bar--a { pointer-events: none; transform: translateY(-50%) rotate(45deg); }
  .dkfb-hit-bar--b { pointer-events: none; transform: translateY(-50%) rotate(-45deg); }
  .dkfb-hit--head .dkfb-hit-bar { pointer-events: none; background: var(--blood); }

  /* ---------- 击杀播报 ---------- */
  .dkfb-feed {
    position: fixed; right: 26px; top: 17%;
    display: flex; flex-direction: column; align-items: flex-end; gap: 7px;
    pointer-events: none;
  }
  /* 行在 fixed 容器里走正常流（position: relative，不是 fixed）：行高随名字
     长短变化，若把行也做成 fixed 就得给每行手算一个 top —— 那是插入时的强制
     重排。容器 fixed + 行在流内，只有插入新行时才 layout，动画仍然只碰
     transform / opacity。pointer-events 依旧由元素与规则双重钉死为 none。 */
  .dkfb-kill {
    position: relative;
    display: flex; align-items: center; gap: 7px;
    max-width: 44vw; overflow: hidden; white-space: nowrap;
    padding: 4px 9px 4px 11px;
    pointer-events: none;
    background: var(--paper);
    border: 3px solid var(--ink);
    box-shadow: 4px 4px 0 var(--ink);
    font-family: var(--font-display); font-weight: 900;
    font-size: 15px; line-height: 1; letter-spacing: 0.03em;
    color: var(--ink);
    transform: translateX(0) rotate(-0.5deg);
    will-change: transform, opacity;
  }
  .dkfb-kill-name { pointer-events: none; color: var(--ink); }
  .dkfb-kill-victim { pointer-events: none; color: var(--blood); }
  .dkfb-kill-weapon {
    pointer-events: none;
    padding: 1px 5px;
    background: var(--acid); color: var(--ink);
    border: 2px solid var(--ink);
    box-shadow: 2px 2px 0 var(--ink);
    font-size: 10.5px; letter-spacing: 0.08em;
  }
  .dkfb-kill-head {
    pointer-events: none;
    padding: 1px 5px;
    background: var(--blood); color: var(--paper);
    border: 2px solid var(--ink);
    box-shadow: 2px 2px 0 var(--ink);
    font-size: 10.5px; letter-spacing: 0.08em;
  }

  /* ---------- 受击方向弧 ---------- */
  /* 外层是 0×0 的轴心，钉在屏幕中心：rotate 在生成时写一次，之后不再改；
     内层红色弧段用 translateY 往外飘 + 淡出，全是合成器属性。 */
  .dkfb-arc {
    position: fixed; left: 50%; top: 50%;
    width: 0; height: 0;
    pointer-events: none;
    transform-origin: 0 0;
    /* 旋转变换在生成时才写；先给一个恒等变换，这个 0×0 的轴心才会从一开始
       就成为 .dkfb-arc-seg 的包含块（带 transform 的元素会成为 fixed 后代的
       包含块）。否则首帧之前那道弧会按视口定位，跑到屏幕左上角外去。 */
    transform: rotate(0deg);
  }
  /* 半径吃 vmin：写死 300px 在 800×450 的小窗里会飘出屏幕外，弧就看不见了。 */
  .dkfb-arc-seg {
    position: fixed; left: -80px; top: calc(-1 * min(300px, 29vmin));
    width: 160px; height: 22px;
    pointer-events: none;
    opacity: 0;
    background: var(--blood);
    border: 3px solid var(--ink);
    border-radius: 12px 12px 0 0;
    box-shadow: 5px 5px 0 rgba(18, 16, 14, 0.6);
    will-change: transform, opacity;
  }

  /* ---------- 飘字伤害数字 ---------- */
  .dkfb-num {
    position: fixed; left: 50%; top: 50%;
    pointer-events: none;
    opacity: 0;
    font-family: var(--font-display); font-weight: 900;
    font-size: 26px; line-height: 1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: var(--paper);
    -webkit-text-stroke: 3px var(--ink);
    paint-order: stroke fill;
    text-shadow: 3px 3px 0 var(--ink);
    will-change: transform, opacity;
  }
  /* 爆头：血红 + 1.4 倍字号（字号是静态写入，不参与逐帧动画）。 */
  .dkfb-num--head {
    pointer-events: none;
    font-size: calc(26px * 1.4);
    color: var(--blood);
  }

  /* ---------- 死亡 / 复活整屏演出 ---------- */
  .dkfb-dead {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
    visibility: hidden; opacity: 0;
    background-image:
      radial-gradient(circle at 50% 48%, rgba(178, 58, 42, 0.74), rgba(18, 16, 14, 0.94) 72%),
      radial-gradient(circle at 50% 50%, rgba(18, 16, 14, 0.5) 1.2px, transparent 1.5px);
    background-size: auto, 9px 9px;
  }
  .dkfb-dead-frame {
    position: fixed; inset: 14px;
    pointer-events: none;
    border: 6px solid var(--ink);
    box-shadow: inset 0 0 0 6px var(--blood);
  }
  .dkfb-dead-mark {
    position: fixed; left: 50%; top: 50%;
    pointer-events: none;
    font-family: var(--font-display); font-weight: 900; line-height: 1;
    font-size: clamp(56px, 13vw, 150px);
    letter-spacing: 0.08em;
    color: var(--blood);
    -webkit-text-stroke: 4px var(--ink);
    paint-order: stroke fill;
    text-shadow: 9px 9px 0 var(--ink);
    transform: translate(-50%, -50%) rotate(-4deg);
    will-change: transform;
  }
  .dkfb-revive {
    position: fixed; inset: 0;
    pointer-events: none;
    visibility: hidden;
    background-image: radial-gradient(circle at 50% 50%, rgba(200, 217, 74, 0.86), rgba(200, 217, 74, 0) 68%);
    will-change: opacity;
  }
`

// ---------------------------------------------------------------- 样式注入
// 引用计数的单例：多个 Feedback 实例共用同一个 <style>，最后一个 dispose
// 时才摘掉它。这样既不重复注入，也不会出现「先关掉的那个把样式带走」。
let styleRefs = 0
let styleEl: HTMLStyleElement | null = null

function acquireStyle(): void {
  if (styleRefs === 0) {
    const el = document.createElement('style')
    el.setAttribute('data-dk-feedback', '')
    // 只有静态 CSS 文本，不含任何玩家数据。
    el.textContent = CSS
    document.head.appendChild(el)
    styleEl = el
  }
  styleRefs++
}

function releaseStyle(): void {
  styleRefs--
  if (styleRefs > 0) return
  styleRefs = 0
  styleEl?.remove()
  styleEl = null
}

// ---------------------------------------------------------------- 建元素

/** 建 div 并顺手钉上 pointer-events：反馈层永远不吃鼠标，免得挡住画面点击锁指针。 */
function div(className: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  el.style.pointerEvents = 'none'
  return el
}

/** 建 span 并写入纯文本。只走 textContent —— 名字来自网络，见 kill() 的 XSS 说明。 */
function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = className
  el.style.pointerEvents = 'none'
  el.textContent = text
  return el
}

// ---------------------------------------------------------------- 主体

export class Feedback {
  private readonly root: HTMLDivElement
  private readonly hitMarker: HTMLDivElement
  private readonly feed: HTMLDivElement
  private readonly deadLayer: HTMLDivElement
  private readonly deadMark: HTMLDivElement
  private readonly reviveFlash: HTMLDivElement

  /** 播报行：从旧到新，索引 0 是最老的一条。 */
  private readonly rows: KillRow[] = []
  private readonly arcs: ArcSlot[] = []
  private readonly numbers: NumberSlot[] = []

  /** 所有还活着的 WAAPI 动画，dispose 时统一 cancel。 */
  private readonly anims = new Set<Animation>()
  private hitAnim: Animation | null = null
  private deadAnim: Animation | null = null
  private reviveAnim: Animation | null = null

  private disposed = false

  constructor(options: FeedbackOptions) {
    acquireStyle()

    this.root = div('dkfb')

    // 命中标记：外壳负责整体缩放，两根本体各转 ±45° 拼成 X。
    this.hitMarker = div('dkfb-hit')
    this.hitMarker.append(div('dkfb-hit-bar dkfb-hit-bar--a'), div('dkfb-hit-bar dkfb-hit-bar--b'))
    this.root.append(this.hitMarker)

    this.feed = div('dkfb-feed')
    this.root.append(this.feed)

    // 受击弧池：预先建好 4 个轴心 + 弧段，运行时只改 style，不再 createElement。
    for (let i = 0; i < MAX_ARCS; i++) {
      const wrap = div('dkfb-arc')
      const seg = div('dkfb-arc-seg')
      wrap.append(seg)
      this.root.append(wrap)
      this.arcs.push({ wrap, seg, active: false, age: 0 })
    }

    // 伤害数字池。
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const el = div('dkfb-num')
      this.root.append(el)
      this.numbers.push({ el, active: false, age: 0, ox: 0, oy: 0 })
    }

    // 死亡遮罩：出血网点 + 厚重黑框 + K.O. 冲击字。
    this.deadLayer = div('dkfb-dead')
    this.deadMark = div('dkfb-dead-mark')
    this.deadMark.textContent = 'K.O.'
    this.deadLayer.append(div('dkfb-dead-frame'), this.deadMark)
    this.root.append(this.deadLayer)

    this.reviveFlash = div('dkfb-revive')
    this.root.append(this.reviveFlash)

    options.container.append(this.root)
  }

  /** 命中敌人：屏幕中心爆一个 X，伤害数字同时飘起。 */
  hit(headshot: boolean, damage: number): void {
    if (this.disposed) return

    // 爆头只切一次 class（静态配色），不是动画。
    this.hitMarker.classList.toggle('dkfb-hit--head', headshot)

    // 命中越重，X 越大、停留越久：一发 105 的狙击和一发 16 的霰弹弹丸
    // 如果反馈完全一样，玩家就只能靠伤害数字确认自己换枪了。上限压在
    // 62px，别让重击把屏幕中心糊住。
    const power = Math.min(1, Math.max(0.2, damage / 120))
    const size = Math.round(40 + power * 18 + (headshot ? 10 : 0))
    this.hitMarker.style.width = `${size}px`
    this.hitMarker.style.height = `${size}px`
    const startScale = 1.35 + power * 0.3

    // 必须 cancel 上一段动画再起新的：cancel 会把元素打回关键帧起点，
    // 于是连发时每一发都是满强度的满屏 X。若改用 class 开关，
    // 浏览器会把「移除再添加同名动画」合并进同一帧，表现是越打越淡甚至整段不播。
    this.hitAnim?.cancel()
    const anim = this.hitMarker.animate(
      [
        { transform: `translate(-50%, -50%) scale(${startScale})`, opacity: 1 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
      ],
      // steps() 让淡出走台阶而不是线性滑 —— 手绘/印刷质感，也省掉插值。
      { duration: HIT_MS + Math.round(power * 80) + (headshot ? 30 : 0), easing: 'steps(6, end)', fill: 'none' },
    )
    this.track(anim)
    this.hitAnim = anim

    this.spawnNumber(damage, headshot)
  }

  /**
   * 击杀播报。
   *
   * 安全：killerName / victimName / weaponName 全部来自网络（服务端把昵称原样
   * 广播），是**攻击者可控**的字符串。本页与游戏服务同源部署，只要这里用
   * innerHTML 拼一次，<img src=x onerror=...> 就是同源上的持久化 XSS ——
   * 能读 localStorage 里的代号、能替玩家发输入包。所以这里只用
   * textContent / createTextNode 写入文本，永远不把变量拼进 HTML。
   */
  kill(killerName: string, victimName: string, weaponName: string, headshot: boolean): void {
    if (this.disposed) return

    const row = div('dkfb-kill')
    row.append(span('dkfb-kill-name', killerName))
    row.append(span('dkfb-kill-weapon', weaponName))
    row.append(span('dkfb-kill-victim', victimName))
    if (headshot) row.append(span('dkfb-kill-head', '爆头'))

    this.feed.append(row)
    this.rows.push({ el: row, age: 0 })

    // 超出上限就从最老的开始摘，保证右侧永远只有最近 6 条。
    while (this.rows.length > MAX_KILL_ROWS) {
      this.rows.shift()?.el.remove()
    }
  }

  /** 受伤方向指示：从屏幕中心朝该世界方向闪一道红弧。 */
  damageFrom(angleRad: number): void {
    if (this.disposed) return

    // 池满（同时 4 道）就丢弃新的：再画会连成一圈，反而看不出方向。
    const slot = this.arcs.find((arc) => !arc.active)
    if (!slot) return

    slot.active = true
    slot.age = 0
    // 角度只在生成时写一次，进到 update 里就只剩 transform / opacity。
    const deg = (angleRad * 180) / Math.PI
    slot.wrap.style.transform = `rotate(${deg}deg)`
    slot.seg.style.opacity = '1'
    slot.seg.style.transform = 'translateY(0) scale(1, 1)'
  }

  /** 自己死亡：整屏血红遮罩 + 厚黑画格边框 + K.O. 冲击字。 */
  died(): void {
    if (this.disposed) return

    this.reviveAnim?.cancel()
    this.reviveAnim = null
    this.deadAnim?.cancel()
    this.deadLayer.style.visibility = 'visible'

    const layer = this.deadLayer.animate(
      [
        { opacity: 0, transform: 'scale(1.14)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 420, easing: 'cubic-bezier(.2, .9, .2, 1)', fill: 'forwards' },
    )
    this.track(layer)
    this.deadAnim = layer

    const punch = this.deadMark.animate(
      [
        { transform: 'translate(-50%, -50%) scale(.35) rotate(-16deg)' },
        { transform: 'translate(-50%, -50%) scale(1) rotate(-4deg)' },
      ],
      { duration: 420, easing: 'cubic-bezier(.15, 1.5, .35, 1)', fill: 'forwards' },
    )
    this.track(punch)
  }

  /** 复活：遮罩淡出 + 一记酸绿闪。 */
  revived(): void {
    if (this.disposed) return

    this.deadAnim?.cancel()
    this.deadAnim = null
    this.reviveAnim?.cancel()
    // cancel 会一并撤掉上一条动画的 forwards 填充，遮罩瞬间掉回 CSS 的
    // opacity:0 —— 死亡画面会闪一下空白。先补一个内联 1，新动画同帧接管。
    this.deadLayer.style.visibility = 'visible'
    this.deadLayer.style.opacity = '1'

    const out = this.deadLayer.animate(
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(1.06)' },
      ],
      { duration: 460, easing: 'ease-out', fill: 'forwards' },
    )
    // 动画结束后把层藏起来：留一个 visibility:visible 的全屏遮罩，
    // 浏览器仍要把它排进合成列表，纯浪费。
    this.track(out, () => {
      this.deadLayer.style.visibility = 'hidden'
      this.deadLayer.style.opacity = '0'
      out.cancel()
    })
    this.reviveAnim = out

    this.reviveFlash.style.visibility = 'visible'
    const flash = this.reviveFlash.animate(
      [
        { opacity: 0 },
        { opacity: 1, offset: 0.18 },
        { opacity: 0 },
      ],
      { duration: 520, easing: 'ease-out', fill: 'forwards' },
    )
    this.track(flash, () => {
      this.reviveFlash.style.visibility = 'hidden'
      flash.cancel()
    })
  }

  /** 每帧一次：推进受击弧、伤害数字、播报行。这里不碰任何 DOM 查询。 */
  update(dt: number): void {
    if (this.disposed) return
    const step = Math.min(Math.max(dt, 0), MAX_STEP)

    this.stepArcs(step)
    this.stepNumbers(step)
    this.stepRows(step)
  }

  /** 摘掉自己造的每一个元素和那份注入的样式。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const anim of this.anims) anim.cancel()
    this.anims.clear()
    this.hitAnim = null
    this.deadAnim = null
    this.reviveAnim = null

    this.rows.length = 0
    this.arcs.length = 0
    this.numbers.length = 0

    this.root.remove()
    releaseStyle()
  }

  // -------------------------------------------------------------- 内部

  private stepArcs(dt: number): void {
    for (const arc of this.arcs) {
      if (!arc.active) continue
      arc.age += dt
      const p = arc.age / ARC_LIFE
      if (p >= 1) {
        arc.active = false
        arc.seg.style.opacity = '0'
        continue
      }
      const ease = 1 - (1 - p) * (1 - p)
      arc.seg.style.opacity = (1 - p * p).toFixed(3)
      arc.seg.style.transform =
        `translateY(${(-26 * ease).toFixed(1)}px) scale(${(1 + 0.18 * p).toFixed(3)}, 1)`
    }
  }

  private stepNumbers(dt: number): void {
    for (const slot of this.numbers) {
      if (!slot.active) continue
      slot.age += dt
      const p = slot.age / NUMBER_LIFE
      if (p >= 1) {
        slot.active = false
        slot.el.style.opacity = '0'
        continue
      }
      const ease = 1 - (1 - p) * (1 - p)
      slot.el.style.opacity = (1 - p * p).toFixed(3)
      slot.el.style.transform =
        `translate(-50%, -50%) translate(${slot.ox}px, ${(slot.oy - 52 * ease).toFixed(1)}px) scale(${(1 + 0.22 * (1 - p)).toFixed(3)})`
    }
  }

  private stepRows(dt: number): void {
    // 倒序遍历：滑出结束要把自己 splice 掉。
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i]!
      row.age += dt
      if (row.age < KILL_HOLD) continue
      const p = (row.age - KILL_HOLD) / KILL_SLIDE
      if (p >= 1) {
        row.el.remove()
        this.rows.splice(i, 1)
        continue
      }
      row.el.style.opacity = (1 - p).toFixed(3)
      row.el.style.transform = `translateX(${(140 * p).toFixed(1)}%) rotate(-0.5deg)`
    }
  }

  private spawnNumber(damage: number, headshot: boolean): void {
    // 池满（12 个）就直接丢：连喷时少一行字，也别让 update 变成 O(爆发数)。
    const slot = this.numbers.find((item) => !item.active)
    if (!slot) return

    slot.active = true
    slot.age = 0
    // 轻微随机偏移，避免同一瞬间的多个数字叠成一坨糊字。
    slot.ox = Math.round((Math.random() - 0.5) * 96)
    slot.oy = Math.round((Math.random() - 0.5) * 64)
    slot.el.classList.toggle('dkfb-num--head', headshot)
    // 数字是我们算的整数，但仍然用 textContent，不拼任何 HTML。
    slot.el.textContent = String(Math.max(0, Math.round(damage)))
    slot.el.style.opacity = '1'
    // 重击的数字初始更大：数字本身也是命中反馈的一部分，不只负责报数。
    const pop = 1.12 + Math.min(0.5, damage / 220) + (headshot ? 0.18 : 0)
    slot.el.style.transform =
      `translate(-50%, -50%) translate(${slot.ox}px, ${slot.oy}px) scale(${pop})`
  }

  /**
   * 登记动画并在结束时注销自己。after 用来做收尾（比如把死亡遮罩藏回去）——
   * 收尾逻辑必须走这里，不能在调用点覆写 onfinish，否则动画就永远留在
   * anims 集合里，dispose 时 cancel 一堆早就播完的东西。
   */
  private track(anim: Animation, after?: () => void): Animation {
    this.anims.add(anim)
    anim.onfinish = (): void => {
      this.anims.delete(anim)
      if (this.disposed) return
      after?.()
    }
    // 命中标记连发时会 cancel 掉上一段：cancel 只触发 oncancel 不触发 onfinish，
    // 少了这一行，被打断的动画会永远留在集合里，一局下来是个无界增长的泄漏。
    anim.oncancel = (): void => {
      this.anims.delete(anim)
    }
    return anim
  }
}
