/**
 * 页面接线：主界面、HUD、状态栏，以及"进入沼泽"的启动流程。
 *
 * 这里的职责刻意只做 DOM 与生命周期，不放任何游戏逻辑 —— 所有循环都在 `Game` 里，
 * 主界面的视觉与交互都在 `menu.ts` 里。好处是将来把这一层换成 Vue 组件
 * （宿主 WebLearning 的前端是 Vue 3）时，只替换这个文件，下面一行都不用动。
 */

import {
  DEFAULT_WEAPON_ID,
  MAX_HEALTH,
  MAX_TRAITS,
  Trait,
  getLevel,
  normalizeTraitLevels,
  packSelection,
  traitList,
  type LevelDef,
} from '@dk/shared'

import { AudioKit } from './audio.ts'
import { Game, type HudState, type MatchResult } from './game.ts'
import { createPauseOverlay, type PauseOverlay } from './pause.ts'
import { type MenuSettings } from './settings.ts'
import { createTraitIcon } from './traits.ts'
import { pickLevelId } from './level-choice.ts'
import {
  createMenu,
  loadSavedConfig,
  loadSavedSettings,
  saveConfig,
  type Menu,
  type MenuConfig,
} from './menu.ts'
import {
  createBossBar,
  createInteractPrompt,
  createLoreCard,
  createSettlement,
  createToast,
  type BossBar,
  type InteractPrompt,
  type LoreCard,
  type Settlement,
  type Toast,
} from './overlay.ts'

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`缺少 DOM 节点 #${id}`)
  return el as T
}

const app = need('app')
const menuRoot = need('menu')
const hpText = need('hp')
const ammoText = need('ammo')
const reserveText = need('reserve')
const debugText = need('debug')
const logText = need('log')
const damageOverlay = need('damage')
const deadScreen = need('dead')
const traitsBox = need('traits')
const bandageText = need('bandages')

let game: Game | null = null
let menu: Menu | null = null
let prompt: InteractPrompt | null = null
let settlement: Settlement | null = null
let pause: PauseOverlay | null = null
/** 首局操作卡：只显示一次，退出/关闭时摘掉。 */
let controlsCard: HTMLElement | null = null
/** 局内刷新/关页保护：一局十几分钟，F5 一下就把身上的东西全丢了。 */
let beforeUnloadGuard: ((event: BeforeUnloadEvent) => void) | null = null
/** 屏幕中下方的一行提示（搜到的东西）。只跟着服务端文本包走。 */
let toast: Toast | null = null
/** 线索文献卡：捡到线索 / 集齐解语时自己淡出，不需要点。 */
let lore: LoreCard | null = null
/** 屠夫血条：只在它活着时出现。 */
let bossBar: BossBar | null = null
/** 上一帧的天候修正名：只在换局时报一次，不必每帧刷新。 */
let lastModifier = ''
let lastHealth = 150

/** 跨局金币。键名与大厅商店共用（client/src/menu.ts 读同一个键）。 */
const COIN_KEY = 'dk.coins'
const OWNED_KEY = 'dk.traitOwned'

function readCoins(): number {
  try {
    const raw = localStorage.getItem(COIN_KEY)
    const n = raw === null ? 0 : Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

function writeCoins(value: number): void {
  try {
    localStorage.setItem(COIN_KEY, String(Math.max(0, Math.floor(value))))
  } catch {
    // 隐私模式下 localStorage 会抛。金币只是进度糖，存不上不该影响这一局。
  }
}

/** 已拥有等级（打包值）。读不到/越界时按"全未解锁"处理。 */
function ownedTraits(): number {
  try {
    const raw = localStorage.getItem(OWNED_KEY)
    const n = raw === null ? 0 : Number(raw)
    return Number.isFinite(n) ? normalizeTraitLevels(Math.floor(n)) : 0
  } catch {
    return 0
  }
}
let inGame = false
/** 徽记条当前画的是哪套天赋。和 hud.traits 一致时一帧都不动 DOM。 */
let traitMaskShown = -1
/** 上一帧的战利品总额。只在涨钱时点亮拾荒者徽记。 */
let lastLootValue = 0
/** 徽记 -> 高亮定时器。连开两枪要重新计时，不能让旧定时器提前摘掉新的高亮。 */
const traitFlashTimers = new Map<number, number>()

/** 天赋没带满三条时补一个虚线圈：一眼看出还能再选。 */
function renderTraits(mask: number): void {
  if (mask === traitMaskShown) return
  traitMaskShown = mask
  traitsBox.textContent = ''
  const bits = traitList(mask)
  for (const entry of bits) traitsBox.append(createTraitIcon(entry.spec.bit, 0, entry.level))
  for (let i = bits.length; i < MAX_TRAITS; i++) {
    const slot = document.createElement('span')
    slot.className = 'dk-trait-slot'
    traitsBox.append(slot)
  }
}

/** 天赋刚派上用场：那一颗闪一下琥珀。没带这条天赋时什么也不发生。 */
function flashTrait(bit: number): void {
  const node = traitsBox.querySelector<HTMLElement>(`.dk-trait-icon[data-trait-bit="${bit}"]`)
  if (!node) return
  node.classList.remove('is-live')
  // 强制一次重排，否则连续两次 flash 之间浏览器会合并动画、看不见第二次。
  void node.offsetWidth
  node.classList.add('is-live')
  const old = traitFlashTimers.get(bit)
  if (old !== undefined) window.clearTimeout(old)
  traitFlashTimers.set(
    bit,
    window.setTimeout(() => {
      traitFlashTimers.delete(bit)
      node.classList.remove('is-live')
    }, 720),
  )
}

/**
 * 会话号：每进一次场 +1。
 *
 * 用处只有一个 —— 让**上一把**的回调认出自己已经过期。dispose() 会关 socket，
 * 关 socket 会触发 onClose，而 onClose 里又要 dispose……没有这道闸门，
 * 一次主动退出会被当成"连接中断"，然后自动重连回一局新的。
 */
let sessionId = 0
/** 当前这次进场已经重连过几次。从主界面主动进场的次数永远是 0。 */
let reconnectAttempts = 0
let reconnectTimer = 0
/** 临时性的重连上限：连不上三次就承认是真断了，回大厅说清楚。 */
const MAX_RECONNECT = 3

/**
 * 状态提示有两个去处：菜单里是主界面底部状态条，进游戏后是 HUD 的 #log。
 *
 * #menu 在进游戏后整层隐藏，往里写文字等于丢消息 —— 所以"点击画面锁定鼠标"
 * 这类提示必须改投 #log，否则玩家看到的是一个静止画面没有任何指引。
 */
function setStatus(text: string): void {
  if (inGame) logText.textContent = text || logText.dataset.weapon || ''
  else menu?.setStatus(text)
}

function closeControls(): void {
  if (controlsCard === null) return
  controlsCard.remove()
  controlsCard = null
}

function armBeforeUnload(): void {
  if (beforeUnloadGuard !== null) return
  beforeUnloadGuard = (event: BeforeUnloadEvent): void => {
    event.preventDefault()
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', beforeUnloadGuard)
}

function disarmBeforeUnload(): void {
  if (beforeUnloadGuard === null) return
  window.removeEventListener('beforeunload', beforeUnloadGuard)
  beforeUnloadGuard = null
}

function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return code
    .replace('ShiftLeft', 'Shift')
    .replace('ShiftRight', 'Shift')
    .replace('ControlLeft', 'Ctrl')
    .replace('ControlRight', 'Ctrl')
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓')
}

/**
 * 首局操作卡：玩家进图后 8 秒内能读到所有非默认键。
 *
 * 只显示一次（`dk.seenControls`），任意键/点击关闭。它不拦游戏输入 ——
 * 卡片自己 pointer-events:auto，点它只是关闭；点画面仍然是锁定鼠标。
 */
function maybeShowControls(): void {
  if (controlsCard !== null) return
  try {
    if (localStorage.getItem('dk.seenControls') === '1') return
    localStorage.setItem('dk.seenControls', '1')
  } catch {
    // 隐私模式：每次显示一次也无妨，不阻断进游戏。
  }
  const keymap = loadSavedSettings().keymap
  const card = document.createElement('div')
  card.className = 'dk-controls-card'
  const title = document.createElement('div')
  title.className = 'dk-controls-card__title'
  title.textContent = '猎 场 操 作'
  const hint = document.createElement('div')
  hint.className = 'dk-controls-card__hint'
  hint.textContent = '任意键或点击关闭 · 之后可在主菜单「操作」页改键'
  card.append(title, hint)

  const rows: Array<[string, string]> = [
    ['移动', `${keyName(keymap.forward)}${keyName(keymap.left)}${keyName(keymap.back)}${keyName(keymap.right)}`],
    ['疾跑 / 蹲伏', `${keyName(keymap.sprint)} / ${keyName(keymap.crouch)}`],
    ['跳跃', keyName(keymap.jump)],
    ['开火 / 瞄准', '鼠标左键 / 右键'],
    ['换弹', keyName(keymap.reload)],
    ['切枪', `${keyName(keymap.slot1)} / ${keyName(keymap.slot2)} / ${keyName(keymap.slot3)}`],
    ['搜索 / 包扎', `${keyName(keymap.interact)} / ${keyName(keymap.heal)}`],
    ['地图 / 菜单', 'M / Esc'],
  ]
  const list = document.createElement('div')
  list.className = 'dk-controls-card__list'
  for (const [label, value] of rows) {
    const line = document.createElement('div')
    line.className = 'dk-controls-card__row'
    const a = document.createElement('span')
    a.textContent = label
    const b = document.createElement('b')
    b.textContent = value
    line.append(a, b)
    list.append(line)
  }
  card.append(list)
  document.body.append(card)
  controlsCard = card
  const close = (): void => {
    window.removeEventListener('keydown', onCloseKey, true)
    closeControls()
  }
  const onCloseKey = (event: KeyboardEvent): void => {
    // 第一个按键只用来关卡片，别再触发 Esc 暂停/M 地图等局内快捷键。
    event.stopPropagation()
    close()
  }
  card.addEventListener('click', (event) => {
    event.stopPropagation()
    close()
  })
  window.addEventListener('keydown', onCloseKey, true)
  window.setTimeout(close, 8000)
}

function setHud(hud: HudState): void {
  hpText.textContent = String(Math.max(0, Math.round(hud.health)))
  hpText.classList.toggle('low', hud.health <= 50)
  // 弹药位永远是数字：换弹状态挂到 class 上。把文本换成「装填」等于在换弹的
  // 2.6 秒里把玩家唯一能看到的弹药量抹掉，探针与录像也读不到。
  ammoText.textContent = String(hud.ammo)
  ammoText.classList.toggle('is-reloading', hud.reloading)
  reserveText.textContent = '/ ' + hud.reserve
  reserveText.classList.toggle('is-empty', hud.reserve <= 0)
  deadScreen.style.display = hud.health > 0 ? 'none' : 'flex'

  // 掉血时闪一下红：这是唯一能告诉玩家"你正在挨打"的线索，方向先不重要。
  // 归零放在下一帧，让 CSS 的 transition 从 1 淡回 0；同一帧写 0 不会触发过渡。
  if (hud.health < lastHealth) {
    damageOverlay.style.opacity = '1'
    requestAnimationFrame(() => {
      damageOverlay.style.opacity = '0'
    })
  }
  lastHealth = hud.health

  const gpuTag = game ? ` · ${game.gpuLabel()}/${game.qualityLabel()}` : ''
  debugText.textContent = `${Math.round(hud.fps)}fps · ${hud.ping}ms · tick ${hud.tick}${gpuTag}`
  // 武器名记在 dataset 里，这样"命中 75"这种临时提示过期后能 restore 回来。
  // 只在"这一行显示的正是旧武器名（或是空的）"时才改写：这样换枪/选枪后会刷新，
  // 而「点击画面锁定鼠标」这类临时提示不会被每帧的枪名顶掉。
  const prevWeapon = logText.dataset.weapon
  logText.dataset.weapon = hud.weaponName
  if (!logText.textContent || logText.textContent === prevWeapon) logText.textContent = hud.weaponName

  // 搜刮提示：[E] 芯片只在"附近有能搜的东西"时出现。附近没有可搜点时
  // 服务端给空串，这里把整块收起来 —— 常驻一个 [E] 会让人怀疑按了没用。
  // 同一条提示条承载三件事，优先级：正在包扎 > 正在搜刮 > 附近能搜 > 可以包扎。
  // 包扎必须比"附近有箱子"优先：血线见底时站在箱子边上，玩家要的是止血提示。
  // 键位跟着动作走（E 搜 / F 扎），否则按提示按下去什么都不会发生。
  const healing = hud.healPct > 0
  const searching = hud.searchPct > 0
  const canHeal = !healing && !searching && hud.bandages > 0 && hud.health < MAX_HEALTH
  if (healing) prompt?.update(true, '包扎中', hud.healPct, keyName(liveKeymap.heal))
  else if (searching) prompt?.update(true, '搜索中', hud.searchPct, keyName(liveKeymap.interact))
  else if (hud.clueNear)
    prompt?.update(
      true,
      hud.cluePct > 0 ? '调查线索 · 站住别动' : '站到线索旁调查',
      hud.cluePct,
      '',
    )
  else if (hud.searchLabel !== '')
    prompt?.update(true, hud.searchLabel, 0, keyName(liveKeymap.interact))
  else if (canHeal)
    prompt?.update(true, `包扎（剩 ${hud.bandages} 条）`, 0, keyName(liveKeymap.heal))
  else prompt?.update(false, '', 0)

  renderTraits(hud.traits)
  const bags = bandageText.querySelector('b')
  if (bags) bags.textContent = String(hud.bandages)
  bandageText.classList.toggle('is-empty', hud.bandages <= 0)
  // 拾荒者是唯一没有"动作"的天赋（它只是让钱变多），只能靠战利品总额变化点亮。
  if (hud.lootValue > lastLootValue) flashTrait(Trait.Scavenger)
  lastLootValue = hud.lootValue

  // 开镜时收准星、带镜的枪再叠一层镜筒。两套瞄准具同时在场上，玩家会本能地
  // 信十字准星而不是分划，那这把枪就永远打不准了。
  document.body.classList.toggle('dk-ads', hud.ads)
  document.body.classList.toggle('dk-scoped', hud.scoped)

  bossBar?.update(hud.bossPct, hud.bossKind)
  // 每局天候只在换了一局时报一次：它是一局的规则，不是会变的读数。
  // 空串是"目标包还没到"，那时不报，否则会先闪一个"死寂"再纠正。
  if (hud.modifierName !== '' && hud.modifierName !== lastModifier) {
    if (lastModifier !== '') toast?.show(`本局天候 · ${hud.modifierName}`)
    lastModifier = hud.modifierName
  }
}

/**
 * 退回主界面。
 *
 * 一局结束、被踢、启动失败都走这一条：它负责把会话号推进（旧回调从此全部认不出
 * 自己）、拆掉游戏实例与两块覆盖层、把主界面放回来。任何新增的"收场动作"
 * 都必须加在这里，否则会出现"回了大厅但还能听见沼泽里的虫子"。
 */
function exitToMenu(status = ''): void {
  // 放弃本局/启动失败时，任何排队中的重连都必须作废；否则玩家刚回大厅，
  // 0.9 秒后又被自动拉进一局新的。
  if (reconnectTimer !== 0) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = 0
  }
  reconnectAttempts = 0
  disarmBeforeUnload()
  sessionId++
  inGame = false
  logText.textContent = ''
  game?.dispose()
  game = null
  prompt?.dispose()
  prompt = null
  settlement?.dispose()
  settlement = null
  pause?.dispose()
  pause = null
  closeControls()
  toast?.dispose()
  toast = null
  lore?.dispose()
  lore = null
  bossBar?.dispose()
  bossBar = null
  lastModifier = ''
  // 下一局的徽记要重画：天赋可能换了，而 traitMaskShown 还记着上一局。
  traitMaskShown = -1
  lastLootValue = 0
  traitsBox.textContent = ''
  menu?.abortDeploy()
  menu?.setVisible(true)
  menu?.setStatus(status)
  // 大厅的声音要跟着回来。只在手势已经发生过时起：没有手势时 startAmbience
  // 会一直重试并且大概率永远拿不到 running，白占一个定时器。
  if (menuAudioArmed) menuAudio.startAmbience()
}

/**
 * 连接意外断开时的重连。
 *
 * 为什么值得做：一局十几分钟，掉一秒网、服务端抖一下就回大厅，等于把前面
 * 搜到的东西全判了死刑。重连是完整地重开一局（服务端不保证恢复原身位），
 * 所以只对**异常断开**做（CloseInfo.transient = 关闭码 < 4000），
 * 被服务端主动拒绝的（版本不对、房间满、消息过频）重连一百次也没用。
 */
function scheduleReconnect(config: MenuConfig): void {
  if (reconnectAttempts >= MAX_RECONNECT) {
    exitToMenu('与服务器的连接反复中断 · 已退回大厅')
    return
  }
  reconnectAttempts++
  game?.dispose()
  game = null
  prompt?.dispose()
  prompt = null
  settlement?.dispose()
  settlement = null
  pause?.dispose()
  pause = null
  closeControls()
  toast?.dispose()
  toast = null
  lore?.dispose()
  lore = null
  bossBar?.dispose()
  bossBar = null
  lastModifier = ''
  // 主界面保持隐藏：网络抖一下不该先看见一次大厅再跳回来。
  setStatus(`连接中断 · 正在重连（${reconnectAttempts}/${MAX_RECONNECT}）…`)
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0
    void enter(config, true).catch((error) => {
      exitToMenu(`重连失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, 900 + reconnectAttempts * 700)
}

async function enter(config: MenuConfig, reconnecting = false): Promise<void> {
  // 触屏设备/没有 Pointer Lock 的浏览器：菜单能开、进图却完全不能转视角。
  // 在进入前拦截，别让玩家进去后才看到角色不能动。
  const touchOnly =
    window.matchMedia('(pointer: coarse)').matches &&
    !window.matchMedia('(any-pointer: fine)').matches
  const canLock = 'requestPointerLock' in HTMLElement.prototype
  if (touchOnly || !canLock) {
    exitToMenu('本作需要键盘与鼠标 · 移动端暂不支持')
    return
  }
  // 主界面的转场动画已经播完才走到这里，所以先记下选择：即使启动失败，
  // 玩家也不用重打昵称。
  saveConfig(config)
  // 进哪张图在这里定，且只定一次：URL ?map= > 本会话记住的 > 随机一张。
  // 服务端可能在 Welcome 里否掉它（这个 matchId 早就被别人定了图），那时
  // net 层会整页跳到 ?map=<服务端那张>，不会走到"渲染 A、服务端在 B"的地狱。
  // 关卡 id 来自 URL 或本会话记忆，两者都可能是上一版的名字（图改名后旧书签
  // 还在用）。getLevel 会抛，抛在外的表现就是"点进游戏没反应"，所以在这里接住。
  let level: LevelDef
  try {
    level = getLevel(pickLevelId())
  } catch (error) {
    exitToMenu(`无法载入关卡：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!reconnecting) reconnectAttempts = 0
  setStatus(`正在载入${level.name}…`)

  const mine = ++sessionId
  const started = new Game({
    container: app,
    level,
    matchId: config.matchId,
    nickname: config.nickname,
    // 大厅还没交付选枪 UI 时也要能进游戏：回到默认步枪而不是崩在 undefined。
    primaryId: config.primaryId ?? DEFAULT_WEAPON_ID,
    // 大厅存的是"选中了哪几条"的位掩码，服务端要的是"每条几级"的等级包。
    // 转换放在进场这一处：局内所有加成判定都只认等级包一种形状。
    traits: packSelection(config.traits ?? 0, ownedTraits()),
    onTraitFx: flashTrait,
    onStatus: setStatus,
    onClose: (info) => {
      if (mine !== sessionId) return
      if (info.transient) {
        scheduleReconnect(config)
        return
      }
      // 被服务端明确拒绝（版本不对 / 房间满 / 消息过频）：重连没有意义，
      // 直接把原因写在主界面状态条上，玩家至少知道自己为什么没进去。
      exitToMenu(info.reason)
    },
    onHud: setHud,
    onResult: (result: MatchResult) => {
      if (mine !== sessionId) return
      // 结算卡是"这一局已经结束"的宣告：鼠标锁必须放开，否则玩家想点
      // 「返回大厅」却发现指针被锁在画面里。
      document.exitPointerLock()
      // 金币 = 带出来的身价 ÷ 5。除的是"节奏"：一局搜满约 $500~$900，
      // 折 100~180 金币，一级天赋 120 —— 打一局半能解锁一条，不会一次全开。
      const earned = result.escaped ? Math.floor((result.lootValue + result.bountyValue) / 5) : 0
      const total = readCoins() + earned
      if (earned > 0) writeCoins(total)
      // 菜单里的余额是构造时读的快照；不同步的话它在下次 saveConfig 时会写回旧值。
      menu?.setCoins(total)
      settlement?.show(
        {
          ...result,
          coins: earned,
          coinsTotal: total,
          modifierName: lastModifier,
        },
        () => exitToMenu(''),
      )
    },
    onText: (text) => {
      if (mine !== sessionId) return
      toast?.show(text)
    },
    onLore: (card) => {
      if (mine !== sessionId) return
      lore?.show(card)
    },
  })
  game = started
  // 本地开发探针：无头浏览器测试需要拿到渲染器/角色来做 Boss 模型与动作的
  // 定点截图。只在 localhost 暴露，NAS 上的正式构建不会挂这个引用。
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    ;(globalThis as Record<string, unknown>).__dkGame = started
  }
  prompt = createInteractPrompt()
  settlement = createSettlement()
  pause = createPauseOverlay({
    onResume: () => setStatus('点击画面锁定鼠标'),
    onQuit: () => {
      if (window.confirm('放弃本局会丢掉这一趟带出来的东西，确定吗？')) {
        exitToMenu('已放弃本局')
      }
    },
  })
  toast = createToast()
  lore = createLoreCard()
  bossBar = createBossBar()

  // 音频上下文必须在用户手势的"激活窗口"内创建。主界面点「出击」后播了
  // 约 620ms 转场，仍在 Chrome 的 transient activation 期限里；但一旦往下
  // 走到 await（物理 WASM + WebSocket 握手）就过期了，会一直 suspended。
  void started.unlockAudio()

  try {
    await started.start()
    if (mine !== sessionId) {
      started.dispose()
      return
    }
    // 先把主界面撤掉再补音频：音频那条链在无手势环境里可能拿不到 resume，
    // 一旦它卡住，黑色的转场幕（.dk-veil）会把整个游戏画面盖死 ——
    // 表现为"进了游戏但全黑，HUD 也消失"。收场动作必须排在可能挂起的 await 之前。
    menu?.setVisible(false)
    inGame = true
    armBeforeUnload()
    maybeShowControls()
    // HUD 不要"啪"一下全亮：0.52s 淡入，读起来是从黑场里浮出来而不是页面刷新。
    // 1.4s 后摘掉：这个 class 只服务入场那一次，留着会让后续挂载重播淡入。
    document.body.classList.add('dk-entering')
    window.setTimeout(() => document.body.classList.remove('dk-entering'), 1400)
    // start() 之后再补一次：如果上一步太早（上下文还没建好）就白等，
    // 现在角色已经进场，重试是幂等的。
    await started.unlockAudio()
    if (mine !== sessionId) {
      started.dispose()
      return
    }
    logText.textContent = ''
    lastHealth = 150
    // 不在这里主动 requestPointerLock：它必须发生在真实用户手势的激活窗口内，
    // 而 start() 里有 await，窗口早已过期，调用会被浏览器拒绝。改成让玩家
    // 点一下画面 —— InputController 已经在 canvas 的 click 上挂了请求。
    setStatus('点击画面锁定鼠标')
  } catch (error) {
    // 失败要能重试：dispose 掉半死不活的实例，把主界面放回来。
    started.dispose()
    if (game === started) game = null
    exitToMenu(`启动失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 主界面的音频实例。
 *
 * 和 Game 里那套**故意分开**：Game.dispose() 会 close 掉自己的上下文，而玩家退回
 * 大厅后还要继续听环境声与界面音。共用一个实例听起来省事，实际会踩到「关掉游戏
 * 的那一下把大厅也一起静音」——而且关闭是永久性的，不报任何错。
 *
 * 上下文只能在真实用户手势里创建（见 audio.ts 的构造函数注释），所以这里先建
 * 空壳，等第一次 pointerdown / keydown 再解锁。
 */
const menuAudio = new AudioKit()
menuAudio.setVolume(loadSavedSettings().volume)
let menuAudioArmed = false
/** 局内交互提示跟着当前键位走；改键后不刷新页面也能显示正确的键帽。 */
let liveKeymap = loadSavedSettings().keymap

/** 准星是 index.html 的固定 DOM，设置通过 CSS 变量生效，HUD 重绘时不必碰它。 */
function applyCrosshair(settings: MenuSettings): void {
  const style = document.documentElement.style
  style.setProperty('--dk-xhair-color', settings.crosshairColor)
  style.setProperty('--dk-xhair-scale', String(settings.crosshairScale))
  style.setProperty('--dk-xhair-opacity', String(settings.crosshairOpacity))
}
applyCrosshair(loadSavedSettings())

// 主界面没有 HUD 可以读音频状态，探针只能从这里问一句。游戏本身不用它。
;(globalThis as Record<string, unknown>).__dkMenuAudio = () => menuAudio.debugStats()

/** 首次用户手势：解锁主界面音频，并起一层沼泽底噪。幂等。 */
function armMenuAudio(): void {
  if (menuAudioArmed) return
  menuAudioArmed = true
  void menuAudio.unlock().then(() => {
    // 手势到手时玩家可能已经点进游戏了：局内那层由 Game 自己起，别在这里叠。
    if (inGame) return
    menuAudio.setAmbienceBias('marsh')
    menuAudio.startAmbience()
  })
}

window.addEventListener('pointerdown', armMenuAudio, true)
window.addEventListener('keydown', armMenuAudio, true)

menu = createMenu(menuRoot, {
  initial: loadSavedConfig(),
  // 从主界面按下出击：这是一次干净的开始，重连计数与进行中的重连定时器都作废。
  onDeploy: (config) => {
    if (reconnectTimer !== 0) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = 0
    }
    reconnectAttempts = 0
    // 击锤落下，大厅的底噪让位给游戏自己那层：0.5s 淡出刚好被 iris 收拢盖住。
    menuAudio.stopAmbience(0.5)
    void enter(config).catch((error) => {
      // 启动失败只把 message 写进状态条，堆栈必须留在控制台 —— 否则
      // "reading 'index'" 这种错误根本看不出是哪一层。
      console.error('[enter] 启动失败', error)
      exitToMenu(`启动失败：${error instanceof Error ? error.message : String(error)}`)
    })
  },
  // 设置改动要穿过主界面送到正在跑的 Game 上（灵敏度/FOV/音量）。
  // 没在游戏里时什么都不做 —— Game 自己在构造时读存档，所以照样生效。
  // 大厅那套上下文不归 Game 管，音量得单独同步，否则调完音量退回大厅会跳响。
  onSettingsChange: (settings) => {
    game?.setSettings(settings)
    menuAudio.setVolume(settings.volume)
    applyCrosshair(settings)
    liveKeymap = settings.keymap
  },
  sfx: {
    hover: () => menuAudio.uiHover(),
    click: () => menuAudio.uiClick(),
    launch: () => menuAudio.uiLaunch(),
  },
})
menu.mount()
menu.setVisible(true)
setStatus('')


function resize(): void {
  game?.resize(window.innerWidth, window.innerHeight)
}

window.addEventListener('resize', resize)

// M：猎场地图。只在局内生效；地图打开时游戏继续跑，玩家仍然暴露在危险里。
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyM' || event.repeat || !inGame) return
  game?.toggleMap()
})

// Esc：局内暂停/退出。多人对局不会真的暂停，层上会写清楚。
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Escape' || event.repeat || !inGame) return
  // 结算卡自己处理 Esc（返回大厅），不要叠一个暂停层在它下面。
  if (document.querySelector('.dkov-settle.on') !== null) return
  if (pause?.visible) pause.hide()
  else pause?.show()
})
