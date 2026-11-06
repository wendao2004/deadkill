/**
 * 两块"盖在游戏画面上"的 DOM：搜刮提示 与 撤离结算。
 *
 * ## 为什么单独一个模块
 * 它们和 hud.ts 的职责不同：hud 是**每帧**都要跟游戏状态同步的常驻信息，
 * 这里两块都是"事件驱动、平时不存在"的临时层。放进 hud 会让那个本来就在
 * 800 行、每帧零分配的文件再长两百行，还要为它们维护一套 hide/show 状态机。
 *
 * ## 为什么样式写进 JS 字符串
 * 只有这一处用到它们，单独一个 .css 要额外一次请求、还要在 index.html 里
 * 多一行引用；而这两块的层叠关系（z-index 60）必须紧挨着 DOM 结构才能读懂。
 * 注入时带一个 id 标记，重复创建不会叠加两份。
 *
 * ## 结算卡片的数字从哪来
 * 全部由 main.ts 传进来 —— 这块 UI 不认识网络协议，也不认识关卡。
 */

import type { LootItem } from '@dk/shared'
import { bossNameOf, monsterKindFromCode } from '@dk/shared'

const STYLE_ID = 'dk-overlay-style'
const ITEM_NAMES = ['绷带', '弹药', '烈酒', '怀表']

/** 结算卡停留时长：足够读完三行数字，又不至于让人以为卡住了。 */
const AUTO_BACK_MS = 10_000

const CSS = `
.dkov-host{position:fixed;inset:0;pointer-events:none;z-index:60;font-family:"Songti SC","Noto Serif SC",serif}
.dkov-prompt{position:absolute;left:50%;bottom:24%;transform:translateX(-50%);display:none;flex-direction:column;align-items:center;gap:8px;color:#e6ddc8;text-shadow:0 2px 6px rgba(0,0,0,.9)}
.dkov-prompt.on{display:flex}
.dkov-prompt .row{display:flex;align-items:center;gap:10px;font-size:17px;letter-spacing:.22em}
.dkov-key{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border:2px solid #d8cfba;border-radius:4px;font-size:15px;letter-spacing:0;background:rgba(12,12,10,.55)}
.dkov-bar{width:196px;height:5px;background:rgba(216,207,186,.22);border-radius:1px;overflow:hidden}
.dkov-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#d8a24a,#f0d79a);transition:width .09s linear}
.dkov-toast{position:absolute;left:50%;bottom:31%;transform:translate(-50%,10px);opacity:0;font-size:19px;letter-spacing:.18em;color:#efe4c9;text-shadow:0 2px 9px rgba(0,0,0,.95);transition:opacity .22s ease,transform .22s ease}
.dkov-toast.on{opacity:1;transform:translate(-50%,0)}
.dkov-settle{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 45%,rgba(20,18,15,.86),rgba(6,6,5,.96));pointer-events:auto}
.dkov-settle.on{display:flex}
.dkov-card{min-width:340px;max-width:440px;padding:30px 34px 26px;border:1px solid rgba(216,207,186,.28);border-top:3px solid #d8a24a;background:rgba(14,13,11,.92);color:#ddd3bd;box-shadow:0 24px 70px rgba(0,0,0,.7)}
.dkov-card.bad{border-top-color:#a8302a}
.dkov-title{font-size:30px;letter-spacing:.34em;margin-bottom:6px;color:#f2e8d2}
.dkov-card.bad .dkov-title{color:#d98b83}
.dkov-sub{font-size:13px;letter-spacing:.16em;color:#8d8577;margin-bottom:20px}
.dkov-line{display:flex;justify-content:space-between;gap:18px;font-size:14px;letter-spacing:.1em;padding:6px 0;border-bottom:1px dashed rgba(216,207,186,.14)}
.dkov-line span:last-child{color:#e8dcc0}
.dkov-total{margin-top:16px;display:flex;justify-content:space-between;align-items:baseline;font-size:15px;letter-spacing:.14em}
.dkov-total b{font-size:28px;letter-spacing:.04em;color:#e9c877}
.dkov-hint{margin-top:22px;font-size:12px;letter-spacing:.16em;color:#7f7768;text-align:center}
.dkov-line.gain b{color:#f0c063}
/* 线索文献：一张斜插在画面左侧的档案纸。右上角那枚字是"封印字"，
   三条线索各给一个，集齐后拼成解语。 */
.dkov-lore{position:absolute;left:6%;top:50%;width:min(360px,42vw);transform:translate(-14px,-50%) rotate(-1.2deg);padding:26px 28px 24px;background:linear-gradient(160deg,rgba(28,25,20,.97),rgba(14,13,11,.97));border:1px solid rgba(216,207,186,.3);border-left:3px solid #d8a24a;box-shadow:0 22px 60px rgba(0,0,0,.75);color:#ddd3bd;opacity:0;pointer-events:none;transition:opacity .18s steps(3,end),transform .18s steps(3,end)}
.dkov-lore.on{opacity:1;transform:translate(0,-50%) rotate(-1.2deg)}
.dkov-lore .seal{position:absolute;right:14px;top:10px;font-size:44px;line-height:1;color:rgba(216,162,74,.32);font-family:"Songti SC","Noto Serif SC",serif}
.dkov-lore .kicker{font-size:11px;letter-spacing:.34em;color:#a2895a}
.dkov-lore h3{margin:10px 0 12px;font-size:21px;font-weight:600;letter-spacing:.1em;color:#efe4cb}
.dkov-lore p{margin:0;font-size:14px;line-height:1.85;letter-spacing:.04em;color:#c3b79c}
.dkov-lore .word{margin-top:14px;font-size:13px;letter-spacing:.3em;color:#f0c063}
/* 屠夫血条：顶部一条细长的墨线血条，只在它活着的时候出现。 */
.dkov-boss{position:absolute;left:50%;top:5.2%;width:min(520px,58vw);transform:translateX(-50%);display:none}
.dkov-boss.on{display:block}
.dkov-boss .name{font-size:13px;letter-spacing:.42em;color:#e0cfae;text-align:center;text-shadow:0 2px 6px rgba(0,0,0,.9)}
.dkov-boss .track{margin-top:6px;height:7px;border:1px solid rgba(12,11,10,.9);background:rgba(10,9,8,.72);box-shadow:0 2px 0 rgba(0,0,0,.5)}
.dkov-boss .track i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#8d2b22,#d8a24a);transition:width .12s linear}
`.trim()

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

export interface InteractPrompt {
  /**
   * @param visible 是否显示
   * @param label   提示文案（'搜索' / '已被搜过'）
   * @param pct     搜索进度 0..100；0 时条是空的
   */
  update(visible: boolean, label: string, pct: number, keyName?: string): void
  dispose(): void
}

export interface SettlementModel {
  escaped: boolean
  /** 搜刮到的现金。 */
  lootValue: number
  /** 带出赏金的额外价值（0 = 没带出来）。 */
  bountyValue: number
  items: LootItem[]
  /** 本局挣到的金币（解锁天赋用）。只有带出东西才算，死了归零。 */
  coins?: number
  /** 结算后钱包余额。 */
  coinsTotal?: number
  /** 本局天候修正名；不传就不显示这一行。 */
  modifierName?: string
}

export interface Settlement {
  show(model: SettlementModel, onBack: () => void): void
  hide(): void
  dispose(): void
}

export function createInteractPrompt(): InteractPrompt {
  ensureStyle()
  const host = document.createElement('div')
  host.className = 'dkov-host'
  host.style.pointerEvents = 'none'
  const box = document.createElement('div')
  box.className = 'dkov-prompt'
  const row = document.createElement('div')
  row.className = 'row'
  const key = document.createElement('span')
  key.className = 'dkov-key'
  key.textContent = 'E'
  const label = document.createElement('span')
  label.textContent = '搜索'
  row.append(key, label)
  const bar = document.createElement('div')
  bar.className = 'dkov-bar'
  const fill = document.createElement('i')
  bar.appendChild(fill)
  box.append(row, bar)
  host.appendChild(box)
  document.body.appendChild(host)

  let shown = false
  let lastLabel = ''
  let lastKey = 'E'
  let lastPct = -1
  return {
    update(visible: boolean, text: string, pct: number, keyName = 'E'): void {
      if (visible !== shown) {
        shown = visible
        box.classList.toggle('on', visible)
      }
      if (!visible) return
      // 键位跟着动作走：搜刮是 E，包扎是 F。同一个提示条既当"能搜"又当"在扎"，
      // 靠 keyName 区分，省掉第二套 DOM 与第二套布局。
      if (keyName !== lastKey) {
        lastKey = keyName
        key.textContent = keyName
        // 空键盘 = 这个动作不需要按键（线索是站定自动调查），不要留一个空框。
        key.style.display = keyName === '' ? 'none' : ''
      }
      if (text !== lastLabel) {
        lastLabel = text
        label.textContent = text
      }
      // 量化到整数百分比：服务端 10Hz 发一次，剩下 5 帧不该重写样式。
      const q = Math.max(0, Math.min(100, Math.round(pct)))
      if (q !== lastPct) {
        lastPct = q
        fill.style.width = q + '%'
      }
    },
    dispose(): void {
      host.remove()
    },
  }
}

export interface Toast {
  /** 弹一条短暂提示（'搜到 $86、怀表 ×1'）。同一条连发只保留最后一次。 */
  show(text: string): void
  dispose(): void
}

/** 停留时长：够读完一行，又不至于挡住下一次搜索的提示。 */
const TOAST_MS = 2600

/**
 * 屏幕中下方的一次性提示条。
 *
 * 为什么不用 hud：hud 每帧跟游戏状态同步，而这条是服务端事件驱动的，
 * 生命周期只有两秒多，塞进 hud 就得为它维护一个倒计时字段和一次每帧重写。
 */
export function createToast(): Toast {
  ensureStyle()
  const host = document.createElement('div')
  host.className = 'dkov-host'
  const box = document.createElement('div')
  box.className = 'dkov-toast'
  host.appendChild(box)
  document.body.appendChild(host)

  let timer = 0
  return {
    show(text: string): void {
      box.textContent = text
      box.classList.add('on')
      if (timer !== 0) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = 0
        box.classList.remove('on')
      }, TOAST_MS)
    },
    dispose(): void {
      if (timer !== 0) window.clearTimeout(timer)
      timer = 0
      host.remove()
    },
  }
}

export function createSettlement(): Settlement {
  ensureStyle()
  const host = document.createElement('div')
  host.className = 'dkov-host'
  const layer = document.createElement('div')
  layer.className = 'dkov-settle'
  const card = document.createElement('div')
  card.className = 'dkov-card'
  layer.appendChild(card)
  host.appendChild(layer)
  document.body.appendChild(host)

  let visible = false
  let timer = 0
  let onBack: (() => void) | null = null

  const back = (): void => {
    if (!visible) return
    const cb = onBack
    hide()
    cb?.()
  }

  const onKey = (event: KeyboardEvent): void => {
    if (!visible) return
    if (event.code === 'Space' || event.code === 'Enter' || event.code === 'Escape') {
      event.preventDefault()
      back()
    }
  }

  function hide(): void {
    visible = false
    layer.classList.remove('on')
    if (timer !== 0) {
      window.clearInterval(timer)
      timer = 0
    }
    card.replaceChildren()
    onBack = null
  }

  return {
    show(model: SettlementModel, cb: () => void): void {
      hide()
      onBack = cb
      visible = true
      card.classList.toggle('bad', !model.escaped)

      const title = document.createElement('div')
      title.className = 'dkov-title'
      title.textContent = model.escaped ? '撤 离' : '失 败'
      const sub = document.createElement('div')
      sub.className = 'dkov-sub'
      sub.textContent = model.escaped ? '你把命和东西一起带出了沼泽' : '这一趟什么也没带回来'
      card.append(title, sub)

      const line = (name: string, value: string): void => {
        const row = document.createElement('div')
        row.className = 'dkov-line'
        const a = document.createElement('span')
        a.textContent = name
        const b = document.createElement('span')
        b.textContent = value
        row.append(a, b)
        card.appendChild(row)
      }

      line('搜刮所得', '$' + model.lootValue)
      if (model.bountyValue > 0) line('赏金', '$' + model.bountyValue)
      if (model.modifierName) line('本局天候', model.modifierName)
      if (model.items.length === 0) line('随身物品', '空手')
      else {
        // 标签只写在第一行：连写三行"随身物品"看起来像三份不同的东西。
        for (let i = 0; i < model.items.length; i++) {
          const item = model.items[i]!
          const name = (ITEM_NAMES[item.id] ?? '杂物') + ' ×' + item.count
          line(i === 0 ? '随身物品' : '', name)
        }
      }

      const total = document.createElement('div')
      total.className = 'dkov-total'
      const label = document.createElement('span')
      label.textContent = '合计'
      const amount = document.createElement('b')
      amount.textContent = '$' + (model.escaped ? model.lootValue + model.bountyValue : 0)
      total.append(label, amount)
      card.appendChild(total)

      // 金币单独一行、单独颜色：它是跨局资产，和"这一趟值多少现金"不是一回事，
      // 混进合计里会让人以为这局输了钱。
      if (model.coins !== undefined) {
        const gain = model.coins > 0 ? '+' + model.coins.toLocaleString('en-US') : '0'
        const suffix =
          model.coinsTotal !== undefined
            ? `  （共 ${model.coinsTotal.toLocaleString('en-US')}）`
            : ''
        const row = document.createElement('div')
        row.className = 'dkov-line gain'
        const a = document.createElement('span')
        a.textContent = '金币'
        const b = document.createElement('span')
        b.textContent = gain + suffix
        row.append(a, b)
        card.appendChild(row)
      }

      const hint = document.createElement('div')
      hint.className = 'dkov-hint'
      card.appendChild(hint)
      layer.classList.add('on')
      window.addEventListener('keydown', onKey)

      // 自动回大厅：一局结束以后还停在这里的人，多半是在等别人先退。
      // 给一个读秒的出口比让他们自己找"返回"更省事，空格可以立刻走。
      const deadline = performance.now() + AUTO_BACK_MS
      const tick = (): void => {
        const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
        hint.textContent = left > 0 ? left + ' 秒后返回大厅 · 空格立即返回' : '返回大厅…'
        if (left === 0) back()
      }
      tick()
      timer = window.setInterval(tick, 250)
    },
    hide,
    dispose(): void {
      hide()
      window.removeEventListener('keydown', onKey)
      host.remove()
    },
  }
}

export interface LoreCardModel {
  kind: 'clue' | 'seal'
  /** 线索序号 0..2；解语是 3。 */
  index: number
  title: string
  body: string
  /** 右上角那枚"封印字"。 */
  glyph: string
  /** 只有解语有。 */
  word: string
}

export interface LoreCard {
  show(model: LoreCardModel): void
  hide(): void
  dispose(): void
}

/** 文献停留时长：一页正文读得完，又不至于在打架时糊住左半边视野。 */
const LORE_MS = 7000

/**
 * 线索文献卡。
 *
 * 为什么是"左侧一张纸"而不是弹窗：线索是在跑图途中捡到的，弹窗必须点掉，
 * 等于每次都被打断一次；一张会自己淡出的纸既能读，也不挡路。
 */
export function createLoreCard(): LoreCard {
  ensureStyle()
  const host = document.createElement('div')
  host.className = 'dkov-host'
  const card = document.createElement('div')
  card.className = 'dkov-lore'
  host.appendChild(card)
  document.body.appendChild(host)

  let timer = 0

  const hide = (): void => {
    card.classList.remove('on')
    if (timer !== 0) {
      window.clearTimeout(timer)
      timer = 0
    }
  }

  return {
    show(model: LoreCardModel): void {
      card.replaceChildren()
      const seal = document.createElement('div')
      seal.className = 'seal'
      seal.textContent = model.kind === 'seal' ? (model.word.charAt(0) || '印') : model.glyph
      const kicker = document.createElement('div')
      kicker.className = 'kicker'
      kicker.textContent = model.kind === 'seal' ? '线 索 已 全 · 解 语' : `线 索 之 ${model.index + 1}`
      const title = document.createElement('h3')
      title.textContent = model.title
      const body = document.createElement('p')
      body.textContent = model.body
      card.append(seal, kicker, title, body)
      if (model.kind === 'seal') {
        const word = document.createElement('div')
        word.className = 'word'
        word.textContent = model.word
        card.appendChild(word)
      }
      card.classList.add('on')
      if (timer !== 0) window.clearTimeout(timer)
      timer = window.setTimeout(hide, LORE_MS)
    },
    hide,
    dispose(): void {
      hide()
      host.remove()
    },
  }
}

export interface BossBar {
  /** 血量百分比 0..100；传 <0 隐藏整条。kind 是种类码，用来换名字。 */
  update(pct: number, kind: number): void
  dispose(): void
}

/** Boss 血条。只在它活着的时候出现，一帧最多改一次宽度。 */
export function createBossBar(): BossBar {
  ensureStyle()
  const host = document.createElement('div')
  host.className = 'dkov-host'
  const box = document.createElement('div')
  box.className = 'dkov-boss'
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = '屠 夫'
  const track = document.createElement('div')
  track.className = 'track'
  const fill = document.createElement('i')
  track.appendChild(fill)
  box.append(name, track)
  host.appendChild(box)
  document.body.appendChild(host)

  let last = -2
  let lastKind = -2
  return {
    update(pct: number, kind: number): void {
      if (kind !== lastKind) {
        lastKind = kind
        const k = kind >= 0 ? monsterKindFromCode(kind) : null
        // 字距靠空格而不是 CSS（现有血条样式所有 Boss 共用）：逐字空一格在
        // 宋体里比 letter-spacing 更像碑文，而且不会影响跟随宽度的布局。
        name.textContent = k === null ? '血 巢' : bossNameOf(k).split('').join(' ')
      }
      const q = pct < 0 ? -1 : Math.max(0, Math.min(100, Math.round(pct)))
      if (q === last) return
      last = q
      box.classList.toggle('on', q >= 0)
      if (q >= 0) fill.style.width = q + '%'
    },
    dispose(): void {
      host.remove()
    },
  }
}
