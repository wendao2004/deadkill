/**
 * 键鼠输入 → 每帧一个 PlayerInput。
 *
 * 三个约定，都是射击游戏手感的基础：
 *
 * 1. **鼠标位移累积到下一帧消费**，而不是在 mousemove 里直接转相机。
 *    mousemove 的频率跟着鼠标回报率走（125~1000Hz），而相机每帧只该转一次；
 *    在事件里直接转会让高回报率鼠标的灵敏度比低回报率的高一倍。
 * 2. **视角按"角度"累积，不按像素**、且不设上限地 wrap 到 [-π, π]。
 *    时间长了浮点数会掉精度（尤其是连续加几万次），位置诡异。
 * 3. **开火是"按下的瞬间"也算一次**。只按 `buttons` 的当前状态发的话，
 *    一次短促点击可能落在两帧之间，被完全丢掉。
 */

import { Buttons, clamp, wrapAngle } from '@dk/shared'

import { DEFAULT_KEYMAP, DEFAULT_SETTINGS, type Action, type Keymap, type MenuSettings } from './settings.ts'

/** 每像素转动多少弧度。1200 DPI 的鼠标横穿屏幕约 0.6π，接近常见射击游戏。 */
const RADIANS_PER_PIXEL = 0.0022
const PITCH_LIMIT = Math.PI / 2 - 0.02

/** 指针锁生效后这段时间内的鼠标按下不算开火（吞掉"点画面拿锁定"的那一下）。 */
const FIRE_GRACE_MS = 250

/** 指针锁生效后多久内丢弃鼠标位移（与上面那个手势窗口同源，理由见 handleMouseMove）。 */
const LOOK_GRACE_MS = 250

/** 单次 mousemove 的位移上限（像素）。真人甩鼠标 60fps 下一帧也就 70px 左右。 */
const MAX_LOOK_DELTA = 160

/**
 * 武器槽位号。
 *
 * 与 shared 的 `DEFAULT_SLOT_ORDER` 同序（0 主武器 / 1 副武器 / 2 近战），
 * 但输入层**不查表**：哪个槽装哪把枪由服务端说了算，这里只管"玩家想切到几号槽"，
 * 具体切哪把枪是 game.ts 拿快照里的 slot 去对。
 */
export const SLOT_PRIMARY = 0
export const SLOT_SECONDARY = 1
export const SLOT_MELEE = 2
/** 循环切枪（Q 与滚轮共用）：-1 下一把、-2 上一把。负数是刻意的 —— 它不是槽位号。 */
export const SLOT_CYCLE_FORWARD = -1
export const SLOT_CYCLE_BACK = -2

export class InputController {
  yaw = 0
  pitch = 0
  private keys = new Set<string>()
  private accumX = 0
  private accumY = 0
  private fireQueued = false
  private reloadQueued = false
  private jumpQueued = false
  /** 待消费的切枪请求，语义见 takeSlotRequest()。 */
  private slotQueued: number | null = null
  private locked = false
  /** 指针锁生效的时刻（ms）。用来吞掉「请求锁的那一下点击」变成的开火。 */
  private lockAt = 0
  /** 供 HUD 显示的最近一次按键状态（疾跑/蹲下提示用）。 */
  sprinting = false
  crouching = false
  ads = false
  /**
   * 当前手持近战：右键不再是开镜，而是重刀。
   *
   * 协议不改：刀上右键仍然发 Ads 位，服务端按"刀 + Ads = 重刀"解释。
   * 这样不用新增输入位，也不必动输入包的位宽。
   */
  meleeMode = false
  /**
   * 玩家设置。默认一份拷贝而不是引用 DEFAULT_SETTINGS —— 否则任何一次
   * 就地修改都会污染"出厂默认"，而设置面板的"恢复默认"按钮靠它。
   */
  private settings: MenuSettings = { ...DEFAULT_SETTINGS }
  /** 当前键位表。默认一份拷贝，设置页改键后 applySettings 整份替换。 */
  private keymap: Keymap = { ...DEFAULT_KEYMAP }
  /** 键位表的反查集合：keydown 时决定要不要 preventDefault，避免每次 Object.values。 */
  private keymapCodes = new Set<string>(Object.values(DEFAULT_KEYMAP))

  constructor(
    private readonly target: HTMLElement,
    private readonly onLockChange?: (locked: boolean) => void,
  ) {
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('mousemove', this.handleMouseMove)
    window.addEventListener('mousedown', this.handleMouseDown)
    window.addEventListener('mouseup', this.handleMouseUp)
    window.addEventListener('wheel', this.handleWheel, { passive: false })
    window.addEventListener('blur', this.handleBlur)
    document.addEventListener('pointerlockchange', this.handlePointerLock)
    target.addEventListener('click', this.handleCanvasClick)
  }

  get pointerLocked(): boolean {
    return this.locked
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('mousemove', this.handleMouseMove)
    window.removeEventListener('mousedown', this.handleMouseDown)
    window.removeEventListener('mouseup', this.handleMouseUp)
    window.removeEventListener('wheel', this.handleWheel)
    window.removeEventListener('blur', this.handleBlur)
    document.removeEventListener('pointerlockchange', this.handlePointerLock)
  }

  /** 一局开始时把视角设成服务端给的朝向，避免继承上一局的鼠标状态。 */
  reset(yaw: number, pitch: number): void {
    this.yaw = yaw
    this.pitch = pitch
    this.accumX = 0
    this.accumY = 0
    this.keys.clear()
    this.fireQueued = false
    this.reloadQueued = false
    this.jumpQueued = false
    this.slotQueued = null
  }

  /**
   * 每帧消费一次的切枪请求。
   *
   * 返回 0/1/2 是绝对槽位，SLOT_CYCLE_FORWARD / SLOT_CYCLE_BACK 是循环。
   * 切成边沿触发而不是"按住 Digit1 就一直发"：切枪在服务端是有耗时的
   * （switchMs），连发只会把玩家的操作排成一队、手感变成"按了没反应"。
   */
  takeSlotRequest(): number | null {
    const request = this.slotQueued
    this.slotQueued = null
    return request
  }

  /** 设置面板改动后立刻生效，不需要重开一局。 */
  applySettings(next: MenuSettings): void {
    this.settings = { ...next, keymap: { ...next.keymap } }
    this.keymap = this.settings.keymap
    this.keymapCodes = new Set(Object.values(this.keymap))
  }

  /**
   * 把这一帧攒下的鼠标位移落到视角上。
   *
   * 必须**每渲染帧**调一次，不能留在 sample() 里跟着模拟步走：模拟是固定
   * 60Hz 累加器，屏幕可能是 144Hz、也可能卡到 45fps，视角只在模拟步里更新
   * 就会"有的帧不动、有的帧一次转两下"，手感上就是枪跟不上手。
   * 视角是纯表现层的相机姿态，不需要与 tick 对齐 —— 服务端只认最后落在输入
   * 包里的那个角度。
   */
  consumeLook(): void {
    // 开镜灵敏度要按"这一帧"的右键状态算，不能等到下一个模拟步。
    this.ads = this.mouseRight && !this.meleeMode
    if (this.accumX === 0 && this.accumY === 0) return
    // 开镜时视野窄，同样的鼠标位移在屏幕上扫过的角度更大 —— 不按开镜倍率
    // 压一档的话，一开镜准星就像被甩出去，微调根本压不住。
    const scale = RADIANS_PER_PIXEL * this.settings.sensitivity * (this.ads ? this.settings.adsSensitivity : 1)
    const dy = this.settings.invertY ? -this.accumY : this.accumY
    this.yaw = wrapAngle(this.yaw - this.accumX * scale)
    this.pitch = clamp(this.pitch - dy * scale, -PITCH_LIMIT, PITCH_LIMIT)
    this.accumX = 0
    this.accumY = 0
  }

  private down(action: Action): boolean {
    return this.keys.has(this.keymap[action])
  }

  sample(): { yaw: number; pitch: number; buttons: number; forward: number; right: number } {
    const forward = (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0)
    const right = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0)
    this.crouching = this.down('crouch')
    this.sprinting = this.down('sprint')

    let buttons = 0
    if (this.jumpQueued || this.down('jump')) buttons |= Buttons.Jump
    if (this.sprinting) buttons |= Buttons.Sprint
    if (this.crouching) buttons |= Buttons.Crouch
    // 刀上右键骗过开镜判定，直接占 Ads 位当重刀；服务端按武器类型分流。
    if (this.meleeMode ? this.mouseRight : this.ads) buttons |= Buttons.Ads
    if (this.fireQueued || this.mouseLeft) buttons |= Buttons.Fire
    if (this.reloadQueued || this.down('reload')) buttons |= Buttons.Reload
    // 交互是**持续**语义而不是边沿：服务端按按住时长累积搜索进度，松开就清零。
    // 做成边沿的话"按住 1.4 秒"这件事在协议里根本表达不出来。
    if (this.down('interact')) buttons |= Buttons.Interact
    // 包扎：按住 F。和 E 分开是因为"站在箱子边上又想先止血"是完全正常的一步，
    // 复用同一个键会让两个动作互相抢。
    if (this.down('heal')) buttons |= Buttons.Heal

    // 边沿触发的按键只发一帧。持续按住 Space 会连跳，那是另一回事
    // （服务端只在 grounded 时接受跳跃，不会二段跳）。
    this.fireQueued = false
    this.reloadQueued = false
    this.jumpQueued = false

    return { yaw: this.yaw, pitch: this.pitch, buttons, forward, right }
  }

  private mouseLeft = false
  private mouseRight = false

  private handleKeyDown = (event: KeyboardEvent): void => {
    const code = event.code
    // 所有已绑定动作都拦浏览器默认行为：空格滚页、Ctrl 快捷键、F5 刷新
    // 都必须在游戏里让位给玩家自己绑的键。
    if (code === 'Tab' || this.keymapCodes.has(code)) event.preventDefault()
    if (event.repeat) return
    this.keys.add(code)
    if (code === this.keymap.jump) this.jumpQueued = true
    if (code === this.keymap.reload) this.reloadQueued = true
    if (code === this.keymap.slot1) this.slotQueued = SLOT_PRIMARY
    if (code === this.keymap.slot2) this.slotQueued = SLOT_SECONDARY
    if (code === this.keymap.slot3) this.slotQueued = SLOT_MELEE
    // Q 是射击游戏的肌肉记忆：切回上一把。这里只发"循环"，谁是谁由 game.ts 定。
    if (code === this.keymap.cycle) this.slotQueued = SLOT_CYCLE_BACK
  }

  private handleWheel = (event: WheelEvent): void => {
    if (!this.locked) return
    if (event.deltaY === 0) return
    // 只看符号：鼠标一格 deltaY 是 100，触控板是小数，用大小判方向会飘。
    this.slotQueued = event.deltaY > 0 ? SLOT_CYCLE_FORWARD : SLOT_CYCLE_BACK
    event.preventDefault()
  }

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code)
  }

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return
    // 锁刚拿到的那几毫秒里，Chrome 会补发一个"光标被挪到窗口中心"的位移，
    // 值可以上千像素 —— 落到视角上就是"一转进游戏，视角自己甩了大半圈"。
    // 它和 handleMouseDown 里吞掉的那一击是同一个理由、同一个时间窗。
    if (performance.now() - this.lockAt < LOOK_GRACE_MS) return
    // 单事件位移上限：真人甩鼠标一秒 4000px，60fps 下也就 66px/帧；而系统级
    // 光标跳变、驱动抽风、切换全屏时的一次重排能给出几千像素。夹住它，宁可
    // 丢这一帧的极端位移 —— 视角猛然翻转会让玩家之后几秒都找不回刚才瞄的人。
    this.accumX += clamp(event.movementX, -MAX_LOOK_DELTA, MAX_LOOK_DELTA)
    this.accumY += clamp(event.movementY, -MAX_LOOK_DELTA, MAX_LOOK_DELTA)
  }

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.locked) return
    // 锁生效与这次点击到达只差几毫秒：这次点击是「点画面拿锁定」的手势，
    // 不是开火指令。不吞掉它，进游戏就会凭空少一发子弹。
    if (performance.now() - this.lockAt < FIRE_GRACE_MS) return
    if (event.button === 0) {
      this.mouseLeft = true
      this.fireQueued = true
    }
    if (event.button === 2) this.mouseRight = true
  }

  private handleMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.mouseLeft = false
    if (event.button === 2) this.mouseRight = false
  }

  private handleBlur = (): void => {
    // 切走窗口时松开所有键，否则回来时人物会自己一直往前走。
    this.keys.clear()
    this.mouseLeft = false
    this.mouseRight = false
  }

  private handleCanvasClick = (): void => {
    if (this.locked) return
    void this.target.requestPointerLock?.()
  }

  private handlePointerLock = (): void => {
    this.locked = document.pointerLockElement === this.target
    if (this.locked) this.lockAt = performance.now()
    if (!this.locked) this.handleBlur()
    this.onLockChange?.(this.locked)
  }
}
