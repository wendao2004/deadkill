/**
 * 玩家设置：唯一定义处。
 *
 * 放在 menu.ts 之外是刻意的 —— 主界面只是设置的**编辑界面**，真正消费它的
 * 是 input.ts（灵敏度）、render.ts（FOV）、game.ts（音量）。如果定义写在
 * menu.ts 里，game.ts 就得 import 整个 3D 主界面模块才能读一个音量值，
 * 等于把"菜单"变成"引擎依赖"。
 *
 * 存储用 localStorage 而不是服务端：这些是**设备偏好**（换台机器、换个鼠标
 * 本来就该不同），存到账号上反而会出现"在网吧调高了灵敏度，回家鼠标飞了"。
 */

export interface MenuSettings {
  /** 鼠标转身灵敏度倍率。1 = 默认。 */
  sensitivity: number
  /** 开镜时的灵敏度倍率（开镜视野小，同样的位移应该转得更少）。 */
  adsSensitivity: number
  /** 竖直视野角（度）。 */
  fov: number
  /** 主音量 0~1。 */
  volume: number
  /**
   * 画面亮度倍率（0.8~1.8，1 = 原样）。
   *
   * 这款游戏默认很暗；不同显示器/房间光线下，同一个"夜沼泽"可能完全看不清。
   * 只作用于 WebGL 画布，不抬 HUD/镜筒，避免把文字和分划一起洗白。
   */
  brightness: number
  /** 反转 Y 轴。 */
  invertY: boolean
  /** 键盘动作 → KeyboardEvent.code。开火/瞄准固定在鼠标，不进这张表。 */
  keymap: Keymap
  /** 准星颜色（#rrggbb 预设之一）。 */
  crosshairColor: string
  /** 准星缩放（0.7~1.6）。 */
  crosshairScale: number
  /** 准星不透明度（0.4~1）。 */
  crosshairOpacity: number
  /** 镜头运动：完整 / 减弱 / 关闭（晕动症）。 */
  cameraMotion: 'full' | 'reduced' | 'off'
  /** 3D 渲染分辨率倍率（0.6~1）；低端 GPU 的帧率旋钮。 */
  renderScale: number
}

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'crouch'
  | 'jump'
  | 'reload'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'cycle'
  | 'interact'
  | 'heal'

export type Keymap = Record<Action, string>

export const DEFAULT_KEYMAP: Keymap = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  crouch: 'ControlLeft',
  jump: 'Space',
  reload: 'KeyR',
  slot1: 'Digit1',
  slot2: 'Digit2',
  slot3: 'Digit3',
  cycle: 'KeyQ',
  interact: 'KeyE',
  heal: 'KeyF',
}

export const DEFAULT_SETTINGS: MenuSettings = {
  sensitivity: 1,
  adsSensitivity: 0.65,
  fov: 75,
  volume: 0.7,
  brightness: 1,
  invertY: false,
  keymap: { ...DEFAULT_KEYMAP },
  crosshairColor: '#d8cfba',
  crosshairScale: 1,
  crosshairOpacity: 1,
  cameraMotion: 'full',
  renderScale: 1,
}

/** 准星预设：骨白 / 琥珀 / 苔绿 / 青，覆盖常见色觉差异。 */
export const CROSSHAIR_COLORS = ['#d8cfba', '#f0c063', '#9bb36a', '#7fd4d0'] as const

const STORAGE_KEY = 'dk.settings'

function clampNumber(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(hi, Math.max(lo, value))
}

/**
 * 逐字段校验后合并，而不是直接 `{...DEFAULT_SETTINGS, ...parsed}`。
 *
 * 存档是用户（或旧版本代码）写进 localStorage 的，可能是 NaN、字符串、
 * 或者上个版本才有的字段。任一项非法就落回默认值 —— 否则一个越界的 fov
 * 会让透视矩阵退化成一团糊，而玩家只会说"游戏打不开"。
 */
export function normalizeSettings(raw: unknown): MenuSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS, keymap: { ...DEFAULT_KEYMAP } }
  const v = raw as Record<string, unknown>
  const d = DEFAULT_SETTINGS
  const keymapRaw = typeof v.keymap === 'object' && v.keymap !== null ? (v.keymap as Record<string, unknown>) : {}
  const keymap: Keymap = { ...DEFAULT_KEYMAP }
  for (const action of Object.keys(DEFAULT_KEYMAP) as Action[]) {
    const code = keymapRaw[action]
    if (typeof code === 'string' && code.length > 0 && code.length <= 32) keymap[action] = code
  }
  return {
    sensitivity: clampNumber(v.sensitivity, 0.2, 3, d.sensitivity),
    adsSensitivity: clampNumber(v.adsSensitivity, 0.2, 2, d.adsSensitivity),
    fov: clampNumber(v.fov, 60, 100, d.fov),
    volume: clampNumber(v.volume, 0, 1, d.volume),
    brightness: clampNumber(v.brightness, 0.8, 1.8, d.brightness),
    invertY: typeof v.invertY === 'boolean' ? v.invertY : d.invertY,
    keymap,
    crosshairColor:
      typeof v.crosshairColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.crosshairColor)
        ? v.crosshairColor
        : d.crosshairColor,
    crosshairScale: clampNumber(v.crosshairScale, 0.7, 1.6, d.crosshairScale),
    crosshairOpacity: clampNumber(v.crosshairOpacity, 0.4, 1, d.crosshairOpacity),
    cameraMotion:
      v.cameraMotion === 'reduced' || v.cameraMotion === 'off' || v.cameraMotion === 'full'
        ? v.cameraMotion
        : d.cameraMotion,
    renderScale: clampNumber(v.renderScale, 0.6, 1, d.renderScale),
  }
}

export function loadSavedSettings(): MenuSettings {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return { ...DEFAULT_SETTINGS }
    return normalizeSettings(JSON.parse(text))
  } catch {
    // 隐私模式下 localStorage 会抛，JSON 也可能被手动改坏。
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: MenuSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)))
  } catch {
    // 存不了就算了：设置仍然在本局生效，只是下次打开回到默认。
  }
}
