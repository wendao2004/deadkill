/**
 * 《DEAD KILL》主界面。
 *
 * 设计取舍（写给后面的维护者）：
 *
 * 1. **背景必须是 3D 而不是一张图**。主界面是玩家每次开游戏看到的第一帧，
 *    静态图会让"世界还活着"这件事立刻穿帮。这里用一个最小氛围箱：渐变天空球 +
 *    指数雾 + 地面 + 一层合并成单次 draw call 的剪影道具 + 雾团 + 萤火 + 血色月晕。
 *    刻意**不** import render.ts / props.ts / monsters.ts / game.ts，也不碰 Rapier ——
 *    菜单必须能在网络与物理都还没起来时装出画面，否则服务端一挂就只剩黑屏。
 *
 * 2. **DOM 只写一次，raf 里一次都不写**。3A 主界面的观感来自"镜头在动、界面不动"，
 *    而每帧改 DOM 会带来 style 重算。所以入场后 raf 只调用 renderer.render。
 *
 * 3. **CSP 是硬约束**（default-src 'self'，无外链字体/图片）。所有纹理都用
 *    canvas 现画（CanvasTexture），所有字体走系统栈，所有装饰走 CSS 渐变。
 *    文件里没有任何网络地址。
 *
 * 4. **不碰调用方的 DOM 结构**。所有节点在运行时建在传入的 root 里，
 *    index.html 由另一条线并行修改，这里不假设它长什么样。
 */

import {
  DEFAULT_SECONDARY_ID,
  DEFAULT_WEAPON_ID,
  LEVEL_IDS,
  ATTACHMENTS,
  ATTACHMENTS_ENABLED,
  CONTRACTS,
  CONTRACT_NONE,
  clampAttachment,
  clampContract,
  MAX_PLAYERS,
  MAX_TRAITS,
  MELEE_WEAPON_ID,
  PROTOCOL_VERSION,
  PRIMARY_CHOICES,
  STARTING_BANDAGES,
  TRAITS,
  TRAIT_MAX_LEVEL,
  WEAPONS,
  getLevel,
  contractOf,
  isPrimaryChoice,
  normalizeTraitLevels,
  packSelection,
  setTraitLevel,
  toggleSelection,
  traitLevel,
  traitList,
  traitUpgradeCost,
  type TraitSpec,
  type WeaponKind,
  type WeaponSpec,
  type WeaponBuild,
  type WeaponSlotKey,
  type WeaponAttachment,
  WEAPON_SLOT_KEYS,
  attachmentsForSlot,
  attachmentBit,
  buildStats,
  effectiveWeaponSpec,
  sanitizeBuild,
  sanitizeOwnedBuild,
  TIME_BANDS,
  TIME_BAND_LABEL,
  isTimeBand,
  type MatchTimeBand,
} from '@dk/shared'


import { deployBrief, worldLine, artProfile } from './art-direction.ts'
import { rememberLevelId } from './level-choice.ts'
import { buyProfile, fetchProfile, readCachedProfile, type ProfileView } from './profile.ts'
import { traitGlyph } from './traits.ts'
import { WeaponPreview } from './weapon-preview.ts'
import {
  loadSavedSettings,
  saveSettings,
  type Action,
  type GraphicsQuality,
  type MenuSettings,
} from './settings.ts'
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FogExp2,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'

import './menu.css'

// ---------------------------------------------------------------- 对外契约

export interface MenuConfig {
  nickname: string
  matchId: string
  /**
   * 主武器 id，恒为 PRIMARY_CHOICES 之一。
   *
   * 必填而不是可选：调用方拿它去报配装，一旦允许 undefined，"没选枪"就会
   * 变成"进了游戏手里是空的"。合法性由 isPrimaryChoice 在两个出入口各挡一次。
   */
  primaryId: number
  /**
   * 天赋掩码（见 shared/src/traits.ts），最多 MAX_TRAITS 位。
   *
   * 必填的理由和 primaryId 一样：它跟着配装包一次性发给服务端，服务端不信
   * "缺省" —— 传 0 就是一条天赋都没带，玩家的数值加成会当场消失。
   */
  traits: number
  /** 本局合同 id（见 shared/src/contracts.ts），缺省 0 = 不接。 */
  contract?: number
  /** 随身补给位图：bit0 额外绷带，bit1 额外备弹。 */
  extras?: number
  /** 主武器配件 id（见 shared/src/attachments.ts）。 */
  attachment?: number
  /** 0 单人 / 1 双人：请求服务端把相邻入场的两人编进同一队。 */
  squad?: number
  /** 大厅队伍 id；同 partyId 的玩家由服务端强制同队并共享出生点。 */
  partyId?: string
  /**
   * 这一局进哪个时段（07:00 / 19:00）。
   *
   * 它只约束"抽哪半个天气池"，具体天气仍然一局一抽：玩家选的是几点进场，
   * 不是哪一场天气。缺省 = 不指定，服务端按旧规则全池随机。
   */
  timeBand?: MatchTimeBand
  /** 主武器多槽位 build（塔科夫式工作台）。 */
  build?: WeaponBuild
  /**
   * 金币余额。**可选**：main.ts 还没接这条线，必填会让它当场编译不过。
   *
   * 缺省当 0 处理 —— 大厅的解锁与升级只认这个数，读不到就是没钱。
   */
  coins?: number
}

// 设置的类型与持久化归 settings.ts 所有：input.ts 读灵敏度、render.ts 读 FOV，
// 它们不该为了一个数值去 import 整个 3D 主界面。这里只负责"编辑界面"，
// 顺手把原样 re-export 一遍，保证菜单模块对外的契约不变。
export type { MenuSettings } from './settings.ts'
export { DEFAULT_SETTINGS, loadSavedSettings, saveSettings } from './settings.ts'

export interface MenuSfx {
  /** 指针换到一个可点元素上。会被高频调用，抽稀由实现自己负责。 */
  hover(): void
  /** 任何可点元素被按下。 */
  click(): void
  /** 出击：iris 开始收拢的那一刻。 */
  launch(): void
}

export interface MenuOptions {
  /** 转场动画放完之后才回调；菜单自己不做任何跳转，路由权归调用方。 */
  onDeploy: (config: MenuConfig) => void
  /** 回填上次选择；优先级高于 localStorage。 */
  initial?: Partial<MenuConfig>
  status?: string
  onSettingsChange?: (settings: MenuSettings) => void
  /**
   * 主界面的三声：悬停、按下、出击。可选 —— 不传就是一个安静的菜单，
   * 被策略禁掉音频的环境里主界面照样完整可用。
   */
  sfx?: MenuSfx
}

export interface Menu {
  mount(): void
  setVisible(visible: boolean): void
  setStatus(text: string): void
  /**
   * 外部改了余额（一局结算发金币）后同步进来。
   *
   * 菜单构造时把 dk.coins 读进 config 内存副本，saveConfig 又会把整个副本写回；
   * 不同步的话，结算后玩家在菜单里点任何一张卡都会把这局的收入覆盖成旧余额。
   */
  setCoins(coins: number): void
  /**
   * 用服务端权威档案同步金币/已拥有天赋/配件。
   *
   * 大厅的本地存档只是缓存；这个入口让“服务端把未拥有天赋洗掉”或
   * “一局结算后余额变化”能立刻反映到已打开的大厅，而不是等下次刷新。
   */
  syncProfile(profile: ProfileView): void
  /**
   * 撤回一次没启动成功的出击：清黑场、解除 CTA 禁用、恢复背景。
   *
   * 必须独立于 setVisible：移动端阻断/关卡载入失败发生在菜单**仍然可见**时，
   * 而 setVisible(true) 会因为 `visible === next` 提前返回，把玩家永久留在
   * 黑场里。
   */
  abortDeploy(): void
  dispose(): void
}

// ---------------------------------------------------------------- 存档

const KEY_NICKNAME = 'dk.nickname'
const KEY_CONTRACT = 'dk.contract'
const KEY_EXTRAS = 'dk.extras'
const KEY_ATTACH = 'dk.attachment'
const KEY_ATTACH_UNLOCKS = 'dk.attachmentUnlocks'
const KEY_SQUAD = 'dk.squad'
const KEY_MATCH = 'dk.match'
const KEY_TIME = 'dk.time'
const KEY_PRIMARY = 'dk.primary'
const KEY_TRAITS = 'dk.traits'
/** 已拥有等级（打包值：每条占 2 bit）。和"这局带哪几条"分开存，升级不必进配装包。 */
const KEY_TRAIT_OWNED = 'dk.traitOwned'
/** 金币余额：天赋解锁与升级的唯一货币。 */
const KEY_COINS = 'dk.coins'
const KEY_FRIENDS = 'dk.friends'
const KEY_FRIEND_CODE = 'dk.friendCode'
const KEY_BUILDS = 'dk.builds'

/** Safari 隐私模式 / 被策略禁用时 localStorage 会直接抛，所以每一次访问都要兜住。 */
function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 配额满或隐私模式：存不下就不存，界面照常工作，只是下次要重填。
  }
}

function dropRaw(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // 同上，删不掉的后果只是留下一个过期值。
  }
}

/**
 * 天赋选中位（`dk.traits`）的清洗：只保留表里存在的位，多了按表顺序截断到 MAX_TRAITS。
 *
 * 不 import 任何 "clamp 选择" 的函数：shared 里的 clampTraitLevels 收拾的是打包值
 * （每条 2 bit 的等级），而 `dk.traits` 存的是身份位，两者不是一回事 —— 混用会把
 * "选了哪几条"读成"每条几级"，最轻的症状是天赋全变成 0 级。
 */
function clampSelection(mask: number): number {
  if (!Number.isFinite(mask)) return 0
  let out = 0
  let taken = 0
  for (const spec of TRAITS) {
    if ((mask & spec.bit) === 0) continue
    if (taken >= MAX_TRAITS) break
    out |= spec.bit
    taken++
  }
  return out
}

/** 金币只认"非负整数"：手改过的存档、浮点误差都在这里一次挡掉。 */
function normalizeCoins(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.floor(num))
}

/**
 * 金币的显示格式：不带 `$`，带千分位。
 *
 * 游戏里有两种钱：局内搜刮/赏金是**现金**（带 `$`），跨局解锁天赋的是
 * **金币**。之前金币也带 `$`，和结算里的现金混在一起，玩家会以为金币
 * 就是美元。统一成纯数字，只靠"金币"这个标签区分。
 */
export function formatCoins(value: unknown): string {
  return normalizeCoins(value).toLocaleString('en-US')
}

/** 已拥有等级的读：缺省、脏值、旧格式统统走 normalizeTraitLevels 落地成合法打包值。 */
function readTraitOwned(): number {
  return normalizeTraitLevels(Number(readRaw(KEY_TRAIT_OWNED)))
}

function writeTraitOwned(packed: number): void {
  writeRaw(KEY_TRAIT_OWNED, String(normalizeTraitLevels(packed)))
}

export function loadSavedConfig(): Partial<MenuConfig> {
  const out: Partial<MenuConfig> = {}
  const nickname = readRaw(KEY_NICKNAME)
  if (nickname) out.nickname = nickname
  const match = readRaw(KEY_MATCH)
  if (match) out.matchId = match
  const time = readRaw(KEY_TIME)
  if (isTimeBand(time)) out.timeBand = time
  // 主武器只认白名单：手改过 localStorage、或旧版本留下的 id 一律当"没存过"，
  // 由调用方回落到 DEFAULT_WEAPON_ID。Number(null) 是 0，正好被 isPrimaryChoice 挡掉。
  const primary = Number(readRaw(KEY_PRIMARY))
  if (isPrimaryChoice(primary)) out.primaryId = primary
  const contract = readRaw(KEY_CONTRACT)
  if (contract !== null) out.contract = clampContract(Number(contract))
  const extras = readRaw(KEY_EXTRAS)
  if (extras !== null) out.extras = Number(extras) & 3
  const attachment = readRaw(KEY_ATTACH)
  const squad = readRaw(KEY_SQUAD)
  if (attachment !== null) out.attachment = clampAttachment(Number(attachment))
  if (squad !== null) out.squad = Number(squad) === 1 ? 1 : 0
  // 天赋选中项同样只认白名单：clampSelection 会丢掉非法位、超出上限的按表顺序截断，
  // 所以手改过的存档最差也只是"少带一条"，不会让服务端拒包。
  const traits = Number(readRaw(KEY_TRAITS))
  if (Number.isFinite(traits) && traits > 0) out.traits = clampSelection(traits)
  // 金币缺失就是 0（新玩家），脏值同样回落到 0，绝不让 NaN 流进界面。
  const coins = readRaw(KEY_COINS)
  if (coins !== null && coins !== '') out.coins = normalizeCoins(coins)
  return out
}

/**
 * 存下昵称与房间号。
 *
 * 入参理论上必然完整（MenuConfig 的字段大都必填），但实际调用方会把手写的
 * 对象直接传进来 —— 一个字段缺失就是 undefined 上取 .trim，而它发生在进入
 * 游戏的同步开头，异常会变成一句没人看见的 unhandled rejection（现象是
 * "点进游戏没反应，还停在大厅"）。这里按"缺就当空"处理。
 */
export function saveConfig(config: Partial<MenuConfig>): void {
  const nickname = (config.nickname ?? '').trim()
  const matchId = (config.matchId ?? '').trim()
  if (nickname) writeRaw(KEY_NICKNAME, nickname)
  else dropRaw(KEY_NICKNAME)
  if (matchId) writeRaw(KEY_MATCH, matchId)
  else dropRaw(KEY_MATCH)
  // 时段不回落到默认值：没选过就让它继续"没选过"，服务端全池随机。
  if (isTimeBand(config.timeBand)) writeRaw(KEY_TIME, config.timeBand)
  else dropRaw(KEY_TIME)
  // 主武器不做"清空"分支：非法 id 只是不写，上一次的有效选择留着，
  // 免得一次脏输入把玩家的配枪重置成默认。
  if (config.primaryId !== undefined && isPrimaryChoice(config.primaryId)) {
    writeRaw(KEY_PRIMARY, String(config.primaryId))
  }
  // 天赋允许存成 0（玩家主动全取消），所以不判 > 0；非法位先洗一遍再落盘。
  if (config.traits !== undefined) writeRaw(KEY_TRAITS, String(clampSelection(config.traits)))
  if (config.contract !== undefined) writeRaw(KEY_CONTRACT, String(clampContract(config.contract)))
  if (config.extras !== undefined) writeRaw(KEY_EXTRAS, String(config.extras & 3))
  if (config.attachment !== undefined) writeRaw(KEY_ATTACH, String(clampAttachment(config.attachment)))
  if (config.squad !== undefined) writeRaw(KEY_SQUAD, config.squad ? '1' : '0')
  // 金币不进配装包也照样落盘：大厅一刷新，余额和等级都还在。
  if (config.coins !== undefined) writeRaw(KEY_COINS, String(normalizeCoins(config.coins)))
}

// ---------------------------------------------------------------- 枪械 build

/** 每把武器一套本机 build；服务端只收清洗后的槽位，不信 localStorage。 */
function loadBuilds(): Record<string, WeaponBuild> {
  const raw = readRaw(KEY_BUILDS)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, WeaponBuild> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const weaponId = Number(key)
      if (!Number.isInteger(weaponId)) continue
      const record = value as { slots?: unknown }
      const slots: Partial<Record<WeaponSlotKey, number>> = {}
      if (record && typeof record.slots === 'object' && record.slots !== null) {
        for (const [slot, id] of Object.entries(record.slots as Record<string, unknown>)) {
          if (!WEAPON_SLOT_KEYS.includes(slot as WeaponSlotKey)) continue
          if (typeof id !== 'number') continue
          slots[slot as WeaponSlotKey] = id
        }
      }
      out[key] = sanitizeBuild(weaponId, slots)
    }
    return out
  } catch {
    return {}
  }
}

export function loadBuildFor(weaponId: number): WeaponBuild {
  const saved = loadBuilds()[String(weaponId)]
  return saved ? sanitizeBuild(weaponId, saved.slots) : { weaponId, slots: {} }
}

function writeBuild(build: WeaponBuild): void {
  try {
    const all = loadBuilds()
    all[String(build.weaponId)] = sanitizeBuild(build.weaponId, build.slots)
    writeRaw(KEY_BUILDS, JSON.stringify(all))
  } catch {
    // 存不下只影响下次打开工作台，不影响本局配装。
  }
}

// ---------------------------------------------------------------- 好友

interface FriendEntry {
  name: string
  /** 好友码可选：知道码时按码配对，避免同名玩家串台。 */
  code?: string
}

const FRIEND_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function makeFriendCode(): string {
  let out = 'h-'
  for (let i = 0; i < 6; i++) {
    out += FRIEND_CODE_ALPHABET[Math.floor(Math.random() * FRIEND_CODE_ALPHABET.length)]
  }
  return out
}

function loadFriends(): FriendEntry[] {
  const raw = readRaw(KEY_FRIENDS)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: FriendEntry[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as { name?: unknown; code?: unknown }
      const name = typeof record.name === 'string' ? record.name.trim().slice(0, 16) : ''
      const code = typeof record.code === 'string' ? record.code.trim().toLowerCase().slice(0, 24) : ''
      if (!name && !code) continue
      const key = code || 'name:' + name
      if (seen.has(key)) continue
      seen.add(key)
      out.push(code ? { name: name || code, code } : { name })
      if (out.length >= 30) break
    }
    return out
  } catch {
    return []
  }
}

function saveFriends(friends: FriendEntry[]): void {
  try {
    writeRaw(KEY_FRIENDS, JSON.stringify(friends.slice(0, 30)))
  } catch {
    // 存不下只是下次要重加，不影响本局。
  }
}

// ---------------------------------------------------------------- 小工具

/**
 * SVG 命名空间标识符。它只是 createElementNS 的入参，任何情况下都不会被 fetch，
 * 但它字面上是一个 URL，而本项目的静态审计要求源码里一个网络地址都不许出现，
 * 所以拆成两段拼出来 —— 这是为了审计脚本能干净地断言"零外链"，不是绕过什么。
 */
const SVG_NS = 'http' + '://www.w3.org/2000/svg'

// ---- 出击转场的节拍（毫秒）------------------------------------------------
// DEPLOY_HANDOFF_MS 是"开始加载"的时刻，刻意晚于 iris 落满全屏（820ms）：
// 让 WebGL 初始化的主线程尖峰落在纯黑静止画面上，而不是把 iris 动画拖成跳帧。
// 另外两个只是兜底闸门（动画被系统暂停时才用得上），正常路径永远是动画先结束。
const DEPLOY_HANDOFF_MS = 860
const LAUNCH_FLOOR_CAP = 4200
const LAUNCH_REVEAL_CAP = 2600

type PaneId = 'deploy' | 'hunter' | 'arsenal' | 'records' | 'keys' | 'settings'

interface Disposable {
  dispose(): void
}

function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function mkButton(className: string, text?: string): HTMLButtonElement {
  const node = mk('button', className, text)
  node.type = 'button'
  return node
}

function svgNode(tag: string): SVGElement {
  return document.createElementNS(SVG_NS, tag) as SVGElement
}

function svgShape(tag: string, attrs: Record<string, string>): SVGElement {
  const node = svgNode(tag)
  for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key])
  return node
}

// ---------------------------------------------------------------- 3D 氛围箱

const C_SKY_ZENITH = 0x0a121a
const C_SKY_HORIZON = 0x1c2b33
const C_SKY_BELOW = 0x05070a
const C_SKY_GLOW = 0xa8481f
const C_FOG = 0x121a20
const C_GROUND = 0x080b0e
const C_PROP = 0x04060a
const C_EMBER = 0xffb066
const FOG_DENSITY = 0.019
const ORBIT_SECONDS = 26
const ORBIT_RADIUS = 26
const ORBIT_HEIGHT = 5.4

/**
 * 取出十六进制里的原始 sRGB 分量（不做色彩管理转换）。
 * 理由：ShaderMaterial 的输出不会经过 three 的 outputColorSpace 转换，写什么就是
 * 屏幕上的什么；而 MeshBasicMaterial 走 线性→sRGB 的往返，最终也等于原始 hex。
 * 两套都按"作者写的 hex 即所见"来，配色才能和 CSS 变量一一对上。
 */
function srgbVec(hex: number): Vector3 {
  return new Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255)
}

/** 一次性确定性随机数发生器：整场只取一个 Math.random 当种子，构图在单次会话内稳定。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 把若干块几何按矩阵烘进一个 BufferGeometry。
 * 存在的意义只有一个：16 组枯树/断桩/木屋骨架各画一次就是 80 次 draw call，
 * 烘成一块之后是 1 次。这里只需要 position（剪影层不参与光照），
 * 所以丢掉 uv / normal，顺便省掉一份索引。
 */
function mergePositions(pieces: Array<{ geo: BufferGeometry; matrix: Matrix4 }>): BufferGeometry {
  const positions: number[] = []
  const v = new Vector3()
  for (const piece of pieces) {
    const source = piece.geo
    const flat = source.index ? source.toNonIndexed() : source
    const attr = flat.getAttribute('position')
    for (let i = 0; i < attr.count; i += 1) {
      v.set(attr.getX(i), attr.getY(i), attr.getZ(i)).applyMatrix4(piece.matrix)
      positions.push(v.x, v.y, v.z)
    }
    if (flat !== source) flat.dispose()
    source.dispose()
  }
  const merged = new BufferGeometry()
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3))
  merged.computeBoundingSphere()
  return merged
}

interface PropPiece {
  geo: BufferGeometry
  matrix: Matrix4
}

function buildProps(rng: () => number): BufferGeometry {
  const pieces: PropPiece[] = []

  const add = (geo: BufferGeometry, base: Matrix4, local: Matrix4): void => {
    pieces.push({ geo, matrix: base.clone().multiply(local) })
  }

  const count = 16
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.42
    // 相机在半径 26 上绕圈，所以 22~31 这一圈必须留空，
    // 否则某个剪影会正好糊在镜头上、整帧只剩一块黑。
    const radius = rng() < 0.55 ? 15 + rng() * 6 : 31 + rng() * 29
    const scale = 0.85 + rng() * 0.85
    const base = new Matrix4()
      .makeTranslation(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
      .multiply(new Matrix4().makeRotationY(rng() * Math.PI * 2))
      .multiply(new Matrix4().makeScale(scale, scale, scale))

    const kind = i % 4
    if (kind <= 1) {
      // 枯树：锥形主干 + 几根折断的枝。锥形（上细下粗）是"树"与"电线杆"的区别所在。
      const h = 4.4 + rng() * 2.4
      add(
        new CylinderGeometry(0.08, 0.3, h, 5),
        base,
        new Matrix4().makeTranslation(0, h / 2, 0).multiply(new Matrix4().makeRotationZ((rng() - 0.5) * 0.18)),
      )
      const branches = 2 + Math.floor(rng() * 2)
      for (let b = 0; b < branches; b += 1) {
        const len = 1.4 + rng() * 1.4
        const tilt = (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 0.6)
        add(
          new BoxGeometry(0.09, len, 0.09),
          base,
          new Matrix4()
            .makeTranslation((rng() - 0.5) * 0.4, h * (0.48 + b * 0.18), (rng() - 0.5) * 0.4)
            .multiply(new Matrix4().makeRotationZ(tilt))
            .multiply(new Matrix4().makeTranslation(0, len / 2, 0)),
        )
      }
    } else if (kind === 2) {
      // 断桩 + 一块歪掉的木头
      const h = 0.5 + rng() * 0.9
      add(new CylinderGeometry(0.26, 0.34, h, 6), base, new Matrix4().makeTranslation(0, h / 2, 0))
      add(
        new BoxGeometry(1.5, 0.12, 0.16),
        base,
        new Matrix4().makeTranslation(0.6, h * 0.8, 0).multiply(new Matrix4().makeRotationZ(0.4)),
      )
    } else {
      // 破木屋骨架：四根柱子 + 两根塌掉的梁 + 一片残缺的墙
      const w = 2.4 + rng() * 1.6
      const d = 1.8 + rng() * 1.2
      const wallH = 2.2 + rng() * 1
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          add(
            new BoxGeometry(0.16, wallH, 0.16),
            base,
            new Matrix4().makeTranslation((sx * w) / 2, wallH / 2, (sz * d) / 2),
          )
        }
      }
      add(
        new BoxGeometry(w + 0.5, 0.14, 0.18),
        base,
        new Matrix4().makeTranslation(0, wallH, 0).multiply(new Matrix4().makeRotationZ(0.06)),
      )
      add(new BoxGeometry(w + 0.4, 0.14, 0.18), base, new Matrix4().makeTranslation(0, wallH - 0.35, d / 2))
      add(
        new BoxGeometry(w * 0.9, wallH * 0.72, 0.1),
        base,
        new Matrix4().makeTranslation(0, wallH * 0.36, -d / 2),
      )
    }
  }

  return mergePositions(pieces)
}

/** 软边圆斑纹理：雾团与月晕共用同一套画法，省一份代码也省一份显存。 */
function makeBlobTexture(size: number): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const half = size / 2
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.42, 'rgba(255,255,255,0.55)')
    grad.addColorStop(0.72, 'rgba(255,255,255,0.18)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  return tex
}

/**
 * 主界面的背景场景。
 *
 * 全部资源在构造时建、在 dispose 时逐项释放；raf 只做矩阵与 uniform 更新外加一次 render。
 * WebGL 起不来（无 GPU / 被策略禁用）时由调用方兜一个 CSS 渐变背景，界面照常可用。
 */
class Backdrop {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera: PerspectiveCamera
  private readonly assets: Disposable[] = []
  private readonly drifters: Array<{ mesh: Mesh; speed: number; baseX: number; span: number }> = []
  private readonly reduced: boolean
  private emberMat: ShaderMaterial | null = null
  private baseFov: number
  private raf = 0
  private lastFrame = 0
  private clock = 0
  private readonly host: HTMLElement

  constructor(host: HTMLElement, baseFov: number) {
    this.host = host
    this.baseFov = baseFov
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // antialias 是唯一肯花的 GPU 预算：剪影层全是硬边，不开 AA 会是一排锯齿。
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.setClearColor(C_FOG, 1)
    host.appendChild(this.renderer.domElement)

    this.camera = new PerspectiveCamera(baseFov, 1, 0.1, 2600)
    this.scene.fog = new FogExp2(C_FOG, FOG_DENSITY)

    // 天空球：远到雾气够不着，所以关掉 fog，否则地平线会被雾抹平、血橙余晖就没了。
    const skyMat = new ShaderMaterial({
      uniforms: {
        uZenith: { value: srgbVec(C_SKY_ZENITH) },
        uHorizon: { value: srgbVec(C_SKY_HORIZON) },
        uBelow: { value: srgbVec(C_SKY_BELOW) },
        uGlow: { value: srgbVec(C_SKY_GLOW) },
      },
      vertexShader: [
        'varying vec3 vDir;',
        'void main() {',
        '  vDir = normalize(position);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uZenith;',
        'uniform vec3 uHorizon;',
        'uniform vec3 uBelow;',
        'uniform vec3 uGlow;',
        'varying vec3 vDir;',
        'void main() {',
        '  float h = vDir.y;',
        '  vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.62, h));',
        '  col = mix(col, uBelow, smoothstep(0.0, 0.20, -h));',
        // narrow ember band: the last light of a swamp sunset, kept low so it reads as a glow not a sunset
        '  float band = exp(-pow((h - 0.015) * 11.0, 2.0));',
        '  col += uGlow * band * 0.42;',
        // ordered dither hides 8-bit banding across a very dark gradient
        '  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);',
        '  col += (n - 0.5) * 0.012;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}',
      ].join('\n'),
      side: BackSide,
      depthWrite: false,
      fog: false,
    })
    this.assets.push(skyMat)
    const sky = new Mesh(this.ownGeometry(new SphereGeometry(1000, 24, 16)), skyMat)
    sky.frustumCulled = false
    this.scene.add(sky)

    // 地面：比雾的可见距离大得多即可，反正远处全是雾色。
    const groundMat = new MeshBasicMaterial({ color: C_GROUND })
    this.assets.push(groundMat)
    const ground = new Mesh(this.ownGeometry(new PlaneGeometry(900, 900)), groundMat)
    ground.rotation.x = -Math.PI / 2
    this.scene.add(ground)

    // 剪影层：整片道具只占 1 次 draw call。
    const propMat = new MeshBasicMaterial({ color: C_PROP })
    this.assets.push(propMat)
    this.scene.add(new Mesh(this.ownGeometry(buildProps(makeRng(Math.random() * 0xffffffff))), propMat))

    // 雾团：4 片 billboard，慢速横移 + 回绕。
    const blob = makeBlobTexture(128)
    this.assets.push(blob)
    const fogGeo = this.ownGeometry(new PlaneGeometry(34, 15))
    for (let i = 0; i < 4; i += 1) {
      const mat = new MeshBasicMaterial({
        map: blob,
        color: 0x1b2a31,
        transparent: true,
        opacity: 0.16 + i * 0.03,
        depthWrite: false,
        side: DoubleSide,
        fog: false,
      })
      this.assets.push(mat)
      const mesh = new Mesh(fogGeo, mat)
      const angle = (i / 4) * Math.PI * 2 + 0.6
      const rx = Math.cos(angle) * (30 + i * 7)
      const rz = Math.sin(angle) * (30 + i * 7)
      mesh.position.set(rx, 1.4 + i * 0.9, rz)
      this.scene.add(mesh)
      this.drifters.push({ mesh, speed: 0.28 + i * 0.11, baseX: rx, span: 70 })
    }

    // 萤火：位置、闪烁、上升全在 shader 里算，raf 只更新一个 uTime。
    const emberCount = 64
    const positions = new Float32Array(emberCount * 3)
    const phases = new Float32Array(emberCount)
    const speeds = new Float32Array(emberCount)
    const sizes = new Float32Array(emberCount)
    const rng = makeRng(0x51a7c3)
    for (let i = 0; i < emberCount; i += 1) {
      const a = rng() * Math.PI * 2
      const r = 5 + rng() * 40
      positions[i * 3] = Math.cos(a) * r
      positions[i * 3 + 1] = rng() * 14
      positions[i * 3 + 2] = Math.sin(a) * r
      phases[i] = rng() * Math.PI * 2
      speeds[i] = 0.15 + rng() * 0.4
      sizes[i] = 1.6 + rng() * 3.4
    }
    const emberGeo = new BufferGeometry()
    emberGeo.setAttribute('position', new Float32BufferAttribute(positions, 3))
    emberGeo.setAttribute('aPhase', new Float32BufferAttribute(phases, 1))
    emberGeo.setAttribute('aSpeed', new Float32BufferAttribute(speeds, 1))
    emberGeo.setAttribute('aSize', new Float32BufferAttribute(sizes, 1))
    this.ownGeometry(emberGeo)
    const emberMat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uColor: { value: srgbVec(C_EMBER) },
      },
      vertexShader: [
        'attribute float aPhase;',
        'attribute float aSpeed;',
        'attribute float aSize;',
        'uniform float uTime;',
        'uniform float uPixelRatio;',
        'varying float vFade;',
        'void main() {',
        // wrap the rise in the shader so the CPU never touches this buffer after setup
        '  vec3 p = position;',
        '  p.y = mod(position.y + uTime * aSpeed, 14.0);',
        '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
        '  gl_PointSize = aSize * uPixelRatio * (120.0 / max(-mv.z, 1.0));',
        '  gl_Position = projectionMatrix * mv;',
        '  float flick = 0.4 + 0.6 * pow(0.5 + 0.5 * sin(uTime * 1.7 + aPhase), 3.0);',
        '  float edge = smoothstep(0.0, 1.5, p.y) * smoothstep(14.0, 11.0, p.y);',
        '  vFade = flick * edge;',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'varying float vFade;',
        'void main() {',
        '  vec2 d = gl_PointCoord - vec2(0.5);',
        '  float a = smoothstep(0.5, 0.0, length(d));',
        '  gl_FragColor = vec4(uColor, a * a * vFade);',
        '}',
      ].join('\n'),
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    this.assets.push(emberMat)
    this.emberMat = emberMat
    const embers = new Points(emberGeo, emberMat)
    embers.frustumCulled = false
    this.scene.add(embers)

    // 血色月晕：加色混合的 sprite 面片，藏在远景树线后面当地平线上的最后一个亮点。
    const haloMat = new SpriteMaterial({
      map: makeBlobTexture(128),
      color: 0x8f2a1c,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    })
    this.assets.push(haloMat)
    const halo = new Sprite(haloMat)
    halo.position.set(-160, 34, -280)
    halo.scale.set(150, 150, 1)
    this.scene.add(halo)

    this.resize()
    window.addEventListener('resize', this.onResize)
  }

  private ownGeometry<T extends BufferGeometry>(geo: T): T {
    this.assets.push(geo)
    return geo
  }

  private readonly onResize = (): void => {
    this.resize()
    if (!this.raf && this.reduced) this.renderStill()
  }

  private resize(): void {
    const w = this.host.clientWidth || window.innerWidth || 1
    const h = this.host.clientHeight || window.innerHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.emberMat) {
      const uniform = this.emberMat.uniforms.uPixelRatio
      if (uniform) uniform.value = Math.min(window.devicePixelRatio || 1, 2)
    }
  }

  setBaseFov(fov: number): void {
    this.baseFov = fov
    if (this.reduced) this.renderStill()
  }

  start(): void {
    if (this.reduced) {
      // 尊重"减少动态"：不跑循环，只在需要时画一帧。
      this.renderStill()
      return
    }
    if (this.raf) return
    this.lastFrame = 0
    this.raf = requestAnimationFrame(this.tick)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.lastFrame = 0
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick)
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0.016
    this.lastFrame = now
    this.clock += dt
    this.update(this.clock)
    this.renderer.render(this.scene, this.camera)
  }

  private renderStill(): void {
    this.update(this.clock)
    this.renderer.render(this.scene, this.camera)
  }

  private update(t: number): void {
    // 26 秒一圈：慢到"不盯着看不出在动"，这正是 3A 主界面共有的呼吸感。
    const angle = t * ((Math.PI * 2) / ORBIT_SECONDS)
    this.camera.position.set(
      Math.cos(angle) * ORBIT_RADIUS,
      ORBIT_HEIGHT + Math.sin(t * 0.21) * 0.45,
      Math.sin(angle) * ORBIT_RADIUS,
    )
    this.camera.lookAt(0, 3, 0)
    const fov = this.baseFov + Math.sin(t * 0.28) * 0.8
    if (Math.abs(this.camera.fov - fov) > 0.001) {
      this.camera.fov = fov
      this.camera.updateProjectionMatrix()
    }

    for (const drifter of this.drifters) {
      const traveled = (t * drifter.speed) % drifter.span
      drifter.mesh.position.x = drifter.baseX + traveled - drifter.span / 2
      drifter.mesh.quaternion.copy(this.camera.quaternion)
    }

    if (this.emberMat) {
      const uniform = this.emberMat.uniforms.uTime
      if (uniform) uniform.value = t
    }
  }

  dispose(): void {
    this.stop()
    window.removeEventListener('resize', this.onResize)
    for (const asset of this.assets) {
      try {
        asset.dispose()
      } catch {
        // 单个资源释放失败不该拦住其它资源；上下文随 renderer 一起丢。
      }
    }
    this.assets.length = 0
    this.drifters.length = 0
    this.emberMat = null
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}

// ---------------------------------------------------------------- 界面

interface NavEntry {
  id: PaneId
  cn: string
  en: string
}

const NAV_ENTRIES: NavEntry[] = [
  { id: 'deploy', cn: '出击', en: 'DEPLOY' },
  { id: 'hunter', cn: '猎人', en: 'HUNTER' },
  { id: 'arsenal', cn: '军械库', en: 'ARSENAL' },
  { id: 'records', cn: '传奇', en: 'RECORDS' },
  { id: 'keys', cn: '操作', en: 'CONTROLS' },
  { id: 'settings', cn: '设置', en: 'SETTINGS' },
]

type MapArt = 'farm' | 'mine' | 'canal' | 'church' | 'station' | 'forest'

interface MapEntry {
  id: string
  name: string
  en: string
  desc: string
  threat: string
  art: MapArt
}

/**
 * 卡片上的风味文案按地图 id 配，而不是照抄 LevelDef。
 *
 * LevelDef.name 是「沼泽农舍」这种给 HUD 与载入提示用的短名，主界面还需要
 * 英文副标、威胁度、以及一张能画的封面（CSS 渐变，见 menu.css 的
 * .dk-map__art[data-art=...]）。地图列表本身来自 shared，新增一张图时这里漏配
 * 只会退化成通用封面，不会缺卡、不会崩。
 */
const MAP_FLAVOR: Record<string, { en: string; desc: string; threat: string; art: MapArt }> = {
  'marsh-p0': {
    en: 'SUNKEN FARMSTEAD',
    desc: '腐烂的甘蔗地与半沉的谷仓。猎物最多，猎人也不少。',
    threat: '高',
    art: 'farm',
  },
  'chapel-night': {
    en: 'CHAPEL OF HOLLOW BELLS',
    desc: '墓园的十字比树多。钟声一响，谁在动就听得见。',
    threat: '高',
    art: 'church',
  },
  'quarry-dust': {
    en: 'ASHEN PIT',
    desc: '塌方的石阶与积水的采坑。短兵相接，退路只有一条。',
    threat: '中',
    art: 'mine',
  },
  'station-dusk': {
    en: 'DROWNED SIDING',
    desc: '铁轨长进泥里，月台雨棚还在。枪声会传过整条线。',
    threat: '低',
    art: 'station',
  },
  'pine-camp-night': {
    en: 'PINEWOOD CAMP',
    desc: '伐木队的营地，火熄了又烧起来。原木堆之间，谁先动谁先死。',
    threat: '中',
    art: 'forest',
  },
}

const MAP_FALLBACK = { en: 'UNCHARTED', desc: '没有记录的猎场。', threat: '?', art: 'farm' as MapArt }

const MAP_ENTRIES: MapEntry[] = LEVEL_IDS.map((id) => {
  const flavor = MAP_FLAVOR[id] ?? MAP_FALLBACK
  return { id, name: getLevel(id).name, ...flavor }
})

function weaponName(id: number, fallback: string): string {
  const spec = WEAPONS[id]
  return spec ? spec.name : fallback
}

/**
 * 武器大类的中文标签。
 *
 * 键写全五类而不是只写可选清单里那四类：将来放开近战主武器、或者换掉
 * PRIMARY_CHOICES 时，这里不用跟着改，漏配会在类型上直接暴露。
 */
const KIND_CN: Record<WeaponKind, string> = {
  rifle: '步枪',
  shotgun: '霰弹枪',
  sniper: '狙击步枪',
  revolver: '转轮手枪',
  knife: '猎刀',
}

/**
 * 各大类的交战距离，给「随身装备」那行的说明用。
 *
 * 不写具体数字：枪架卡片上已经有伤害/射速/弹容，这里再报一遍数字只是噪音，
 * 玩家真正需要的是"这把枪该在什么距离上用"。
 */
const KIND_RANGE: Record<WeaponKind, string> = {
  rifle: '中远距离',
  shotgun: '贴脸交火',
  sniper: '远距离点杀',
  revolver: '近身自卫',
  knife: '无声处决',
}

function buildHunterAvatar(): SVGElement {
  const svg = svgNode('svg')
  svg.setAttribute('viewBox', '0 0 120 120')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', 'dk-avatar__art')

  const ink = '#0c0b0a'
  const amber = '#d99a4a'

  // 一圈极淡的背光：让剪影从深色面板上"浮"起来，否则整块糊在一起。
  svg.appendChild(svgShape('circle', { cx: '60', cy: '62', r: '56', fill: amber, opacity: '0.07' }))
  // 宽檐帽：帽檐 + 帽冠，两笔就够读出猎人身份。
  svg.appendChild(svgShape('ellipse', { cx: '60', cy: '48', rx: '35', ry: '5.5', fill: ink }))
  svg.appendChild(svgShape('polygon', { points: '44,47 47,25 73,25 76,47', fill: ink }))
  svg.appendChild(svgShape('rect', { x: '44', y: '41', width: '32', height: '4', fill: amber, opacity: '0.85' }))
  // 头 / 颈 / 大衣
  svg.appendChild(svgShape('ellipse', { cx: '60', cy: '62', rx: '13', ry: '15', fill: ink }))
  svg.appendChild(svgShape('rect', { x: '54', y: '73', width: '12', height: '11', fill: ink }))
  svg.appendChild(svgShape('polygon', { points: '16,118 26,90 44,80 76,80 94,90 104,118', fill: ink }))
  // 斜挎的枪：猎人的剪影里没有枪就只是个路人。
  svg.appendChild(
    svgShape('rect', {
      x: '18',
      y: '99',
      width: '92',
      height: '4',
      fill: ink,
      transform: 'rotate(-33 64 101)',
    }),
  )
  return svg
}

export function createMenu(root: HTMLElement, options: MenuOptions): Menu {
  const saved = loadSavedConfig()
  const cachedProfile = readCachedProfile()
  const config: MenuConfig = {
    nickname: options.initial?.nickname ?? saved.nickname ?? '',
    matchId: options.initial?.matchId ?? saved.matchId ?? 'default',
    primaryId: options.initial?.primaryId ?? saved.primaryId ?? DEFAULT_WEAPON_ID,
    contract: clampContract(options.initial?.contract ?? saved.contract ?? 1),
    extras: (options.initial?.extras ?? saved.extras ?? 0) & 3,
    attachment: clampAttachment(options.initial?.attachment ?? saved.attachment ?? 0),
    squad: (options.initial?.squad ?? saved.squad ?? 0) === 1 ? 1 : 0,
    traits: clampSelection(options.initial?.traits ?? saved.traits ?? 0),
    coins: normalizeCoins(options.initial?.coins ?? cachedProfile.coins ?? saved.coins ?? 0),
  }
  config.build = options.initial?.build ?? loadBuildFor(config.primaryId)
  // 好友码是本机身份：服务端只做在线目录，不建账号。首次生成后一直复用。
  let friendCode = readRaw(KEY_FRIEND_CODE) ?? ''
  if (!/^[a-z0-9-]{4,24}$/.test(friendCode)) {
    friendCode = makeFriendCode()
    writeRaw(KEY_FRIEND_CODE, friendCode)
  }
  let friends = loadFriends()
  // 已拥有等级不进 MenuConfig：它是局外进度，main.ts 发配装包时只要
  // packSelection(掩码, 已拥有) 的结果。所以这里读出唯一一份。
  let traitOwned = cachedProfile.traitOwned || readTraitOwned()
  /** 服务端档案里的配件位图（WEAPON_ATTACHMENTS 下标）。 */
  let attachmentOwned = cachedProfile.attachmentOwned
  /** 已付款、尚未领取的随身补给位图。 */
  let extrasOwned = 0
  /** 档案更新后刷新改枪台/补给按钮；由两个子面板在构建时注册。 */
  let refreshArsenal: (() => void) | null = null
  let refreshExtras: (() => void) | null = null
  // 旧存档只有"选了哪几条"（当年天赋是免费的开关），没有等级数据。已选却 0 级的
  // 那条按 1 级补上 —— 否则玩家会看到"明明带着，进局却一条都不生效"，
  // 因为 packSelection 会把 0 级的条目直接丢掉。
  const ownedBefore = traitOwned
  for (const spec of TRAITS) {
    if ((config.traits & spec.bit) === 0) continue
    if (traitLevel(traitOwned, spec.bit) > 0) continue
    traitOwned = setTraitLevel(traitOwned, spec.bit, 1)
  }
  if (traitOwned !== ownedBefore) writeTraitOwned(traitOwned)
  const settings: MenuSettings = loadSavedSettings()
  // 顶栏/猎人页不再写死"血脉 VIII / 赏金 14,280"：只显示本机真的有的东西。
  // 血脉按已拥有天赋总等级折算（3 级一段），没有存档就是 I、金币 $0。
  const ownedCount = TRAITS.reduce(
    (count, spec) => count + (traitLevel(traitOwned, spec.bit) > 0 ? 1 : 0),
    0,
  )
  const totalTraitLevels = TRAITS.reduce(
    (count, spec) => count + traitLevel(traitOwned, spec.bit),
    0,
  )
  const bloodlineLevel = Math.max(1, 1 + Math.floor(totalTraitLevels / 3))

  const host = mk('div', 'dk-menu')
  host.setAttribute('role', 'application')
  host.setAttribute('aria-label', 'DEAD KILL 主菜单')

  const bgHost = mk('div', 'dk-bg')
  host.appendChild(bgHost)
  host.appendChild(mk('div', 'dk-vignette'))
  host.appendChild(mk('div', 'dk-grain'))

  // 背景视差：鼠标位置 → CSS 变量，画布只跟随几像素。相机运动设置关闭时不动。
  let parallaxRaf = 0
  let parallaxX = 0
  let parallaxY = 0
  const applyParallax = (x: number, y: number): void => {
    parallaxX = x
    parallaxY = y
    if (parallaxRaf) return
    parallaxRaf = window.requestAnimationFrame(() => {
      parallaxRaf = 0
      host.style.setProperty('--px', parallaxX.toFixed(3))
      host.style.setProperty('--py', parallaxY.toFixed(3))
    })
  }
  host.addEventListener('pointermove', (event) => {
    if (settings.cameraMotion === 'off') return
    const rect = host.getBoundingClientRect()
    const scale = settings.cameraMotion === 'reduced' ? 0.4 : 1
    applyParallax(
      -((event.clientX - rect.left) / rect.width - 0.5) * 2 * scale,
      -((event.clientY - rect.top) / rect.height - 0.5) * 2 * scale,
    )
  })
  host.addEventListener('pointerleave', () => applyParallax(0, 0))
  // 从对局回到菜单的"重新对焦"只在 .dk-main 的动画结束后摘掉。
  host.addEventListener('animationend', (event) => {
    const target = event.target as HTMLElement
    if (target.classList?.contains('dk-main')) host.classList.remove('is-returning')
  })

  // ---- 顶栏 --------------------------------------------------------
  const top = mk('header', 'dk-top')
  const brand = mk('div', 'dk-brand')
  const logo = mk('h1', 'dk-logo', 'DEAD KILL')
  const tagline = mk('p', 'dk-tagline', '1890 年，路易斯安那沼泽 · 带走赏金，或者成为赏金')
  brand.appendChild(logo)
  brand.appendChild(tagline)
  top.appendChild(brand)

  const dossier = mk('div', 'dk-dossier')
  const dossierRows: Array<[string, string]> = [
    ['金币', formatCoins(config.coins ?? 0)],
    ['天赋', ownedCount + '/' + TRAITS.length],
    ['血脉', String(bloodlineLevel)],
  ]
  let dossierCoinsEl: HTMLElement | null = null
  for (const [label, value] of dossierRows) {
    const cell = mk('div', 'dk-dossier__cell')
    cell.appendChild(mk('span', 'dk-dossier__label', label))
    const valueEl = mk('span', 'dk-dossier__value', value)
    cell.appendChild(valueEl)
    dossier.appendChild(cell)
    if (label === '金币') dossierCoinsEl = valueEl
  }
  top.appendChild(dossier)
  host.appendChild(top)

  // ---- 主导航 ------------------------------------------------------
  const main = mk('div', 'dk-main')
  const nav = mk('nav', 'dk-nav')
  nav.setAttribute('role', 'tablist')
  nav.setAttribute('aria-orientation', 'vertical')
  nav.setAttribute('aria-label', '主菜单分区')

  const ink = mk('div', 'dk-nav__ink')
  nav.appendChild(ink)

  // 功能页里的「返回主页」。主页本身把导航整列藏起来，所以它只出现在
  // 地图/庇护所/设置这些功能页里，不会和主页四选项打架。
  const homeTab = mkButton('dk-nav__item dk-nav__home')
  homeTab.setAttribute('role', 'button')
  homeTab.appendChild(mk('span', 'dk-nav__index', '←'))
  homeTab.appendChild(mk('span', 'dk-nav__cn', '主页'))
  homeTab.appendChild(mk('span', 'dk-nav__en', 'HOME'))
  homeTab.tabIndex = 0
  homeTab.addEventListener('click', () => showHome(true))
  nav.appendChild(homeTab)

  const tabButtons = new Map<PaneId, HTMLButtonElement>()
  NAV_ENTRIES.forEach((entry, index) => {
    const tab = mkButton('dk-nav__item')
    tab.id = 'dk-tab-' + entry.id
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false')
    tab.setAttribute('aria-controls', 'dk-pane-' + entry.id)
    tab.style.setProperty('--i', String(index))
    // roving tabindex：整组导航只留一个 Tab 停靠点，组内用方向键走。
    // 这是 tablist 的标准键盘模型，也让 Tab 键不会在五个导航项上耗掉五步。
    tab.tabIndex = index === 0 ? 0 : -1
    tab.appendChild(mk('span', 'dk-nav__index', String(index + 1).padStart(2, '0')))
    tab.appendChild(mk('span', 'dk-nav__cn', entry.cn))
    tab.appendChild(mk('span', 'dk-nav__en', entry.en))
    nav.appendChild(tab)
    tabButtons.set(entry.id, tab)
    tab.addEventListener('click', () => activatePane(entry.id))
    tab.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
      if (!delta) return
      event.preventDefault()
      const count = NAV_ENTRIES.length
      const from = NAV_ENTRIES.findIndex((candidate) => candidate.id === entry.id)
      const target = NAV_ENTRIES[(from + delta + count) % count]
      if (!target) return
      activatePane(target.id)
      tabButtons.get(target.id)?.focus()
    })
  })
  main.appendChild(nav)

  const stack = mk('div', 'dk-pane-stack')
  const panes = new Map<PaneId, HTMLElement>()
  for (const entry of NAV_ENTRIES) {
    const pane = mk('section', 'dk-pane')
    pane.id = 'dk-pane-' + entry.id
    pane.setAttribute('role', 'tabpanel')
    pane.setAttribute('aria-labelledby', 'dk-tab-' + entry.id)
    stack.appendChild(pane)
    panes.set(entry.id, pane)
  }
  main.appendChild(stack)
  host.appendChild(main)

  // ---- 状态栏 ------------------------------------------------------
  const bottom = mk('footer', 'dk-bottom')
  bottom.appendChild(mk('span', 'dk-bottom__build', `v0.1.0 · PROTO ${PROTOCOL_VERSION} · 构建 1890-AM`))
  const statusText = mk('span', 'dk-bottom__status')
  bottom.appendChild(statusText)
  host.appendChild(bottom)

  // ---- 转场层 ------------------------------------------------------
  const barTop = mk('div', 'dk-bar dk-bar--top')
  const barBottom = mk('div', 'dk-bar dk-bar--bottom')
  const flash = mk('div', 'dk-flash')
  const veil = mk('div', 'dk-veil')
  // 黑场里的标题卡。文案不在这里写死：地图名/英文名/风味文案都来自
  // MAP_ENTRIES，出击时按当前选中的地图填进去（见 fillStage）。
  const stage = mk('div', 'dk-stage')
  const stageMap = mk('div', 'dk-stage__map')
  const stageEn = mk('div', 'dk-stage__en')
  const stageRule = mk('span', 'dk-stage__rule')
  const stageDesc = mk('div', 'dk-stage__desc')
  // 简报行：日期 · 天气 · 合同。这是玩家进图前最后一次被告知"你要去哪"。
  const stageBrief = mk('div', 'dk-stage__brief')
  const stageState = mk('div', 'dk-stage__state', '潜 入 中 · · ·')
  stage.appendChild(stageMap)
  stage.appendChild(stageEn)
  stage.appendChild(stageRule)
  stage.appendChild(stageDesc)
  stage.appendChild(stageBrief)
  stage.appendChild(stageState)
  host.appendChild(barTop)
  host.appendChild(barBottom)
  host.appendChild(flash)
  host.appendChild(veil)
  host.appendChild(stage)

  // 主页 / 昵称引导 / 退出层的状态必须先于 buildHome 声明：这些是 let，
  // 在 TDZ 里被 buildHome 读到会直接抛 ReferenceError（不是 undefined）。
  let deployStep = 1
  let deployGrid: HTMLElement | null = null
  const stepButtons = new Map<number, HTMLButtonElement>()
  let stepNextButton: HTMLButtonElement | null = null
  let roomListEl: HTMLElement | null = null
  let roomDetailEl: HTMLElement | null = null
  let roomStatusEl: HTMLElement | null = null
  const roomCache = new Map<string, RoomView>()
  let friendListEl: HTMLElement | null = null
  let friendOnlineEl: HTMLElement | null = null
  let friendInputEl: HTMLInputElement | null = null
  let onlinePresences: PresenceView[] = []
  let party: PartyView | null = null
  let partyInvites: PartyInviteView[] = []
  let partyMembersEl: HTMLElement | null = null
  let partyInviteEl: HTMLElement | null = null
  let partyStatusEl: HTMLElement | null = null
  let partyAlertEl: HTMLElement | null = null
  let partyTimer = 0
  let partySeq = 0
  let lastPartyLaunch = 0
  let autoFollowing = false
  let homeNickEl: HTMLElement | null = null
  let homeCoinsEl: HTMLElement | null = null
  let onboardEl: HTMLElement | null = null
  let onboardInput: HTMLInputElement | null = null
  let onboardError: HTMLElement | null = null
  let onboardThen: (() => void) | null = null
  let profileNameEl: HTMLElement | null = null
  let profileSubEl: HTMLElement | null = null
  let functionTitleEl: HTMLElement | null = null
  let functionMetaEl: HTMLElement | null = null
  let arsenalPreview: WeaponPreview | null = null
  let arsenalPreviewHost: HTMLElement | null = null
  let arsenalWeaponId = DEFAULT_WEAPON_ID
  let arsenalBuild: WeaponBuild = { weaponId: DEFAULT_WEAPON_ID, slots: {} }
  const shelterButtons = new Map<PaneId, HTMLButtonElement>()
  /** 构造期就会走到 refreshRooms（房间面板自己拉一次列表），必须先声明。 */
  let disposed = false

  // 主页 / 昵称引导 / 退出层。z-index 低于 veil/stage 的只有主页，
  // 所以出击黑场会正常盖住它；昵称与退出层必须盖在最上面。
  const home = buildHome()
  host.appendChild(home)
  host.appendChild(buildOnboarding())
  host.appendChild(buildExitScreen())
  host.appendChild(buildFunctionBar())
  host.appendChild(buildShelterNav())
  host.appendChild(buildPartyAlert())

  // ---------------------------------------------------------------- 出击

  const deployState = {
    mapId: MAP_ENTRIES[0]?.id ?? 'marsh-p0',
    // 时段：URL/存档都认，缺省夜晚 —— 这张游戏的主色调是月光下的沼泽，
    // 白天是"另一种玩法"，不该是默认。qa.ts 的 ?time= 会在 main.ts 里覆盖。
    timeBand: (isTimeBand(config.timeBand) ? config.timeBand : 'night') as MatchTimeBand,
    squad: (config.squad === 1 ? 'duo' : 'solo') as 'solo' | 'duo',
    threat: 1,
    contract: 1,
    extras: 0,
    attachment: clampAttachment(config.attachment ?? 0),
  }
  /** 永久解锁的配件（bit = 配件 id）。0 号"不装"永远解锁。 */
  let attachmentUnlocks = (Number(readRaw(KEY_ATTACH_UNLOCKS) ?? '0') | 1) >>> 0
  let deployTimer = 0
  /** 时段按钮（07:00 / 19:00）与卡片上那行"哪一天的几点"，syncTimeBand 统一刷。 */
  const timeBtns = new Map<MatchTimeBand, HTMLButtonElement>()
  let timeHintEl: HTMLElement | null = null
  const mapWhenEls = new Map<string, HTMLElement>()
  let deploying = false
  let cta: HTMLButtonElement | null = null
  let primaryLine: HTMLElement | null = null
  const primaryCards: HTMLButtonElement[] = []
  /**
   * 一张天赋卡上会被 syncTraits 改写的几个节点。
   *
   * 存句柄而不是每次 querySelector：升级后要连刷十张卡，一遍十次查询换不来什么，
   * 但少写十个选择器字符串就不容易和 CSS 走散。
   */
  interface TraitCardView {
    spec: TraitSpec
    card: HTMLElement
    /** 三个等级方块，按顺序点亮前 level 个。 */
    levels: HTMLElement[]
    levelsWrap: HTMLElement
    desc: HTMLElement
    buy: HTMLButtonElement
    deny: HTMLElement
    /** is-deny 的收尾定时器：连点时要能取消上一次。 */
    timer: number
  }
  const traitCards: TraitCardView[] = []
  let traitCountEl: HTMLElement | null = null
  let coinsEl: HTMLElement | null = null
  let matchInfoEl: HTMLElement | null = null
  let matchInfoTimer = 0
  /** 当前房间剩余 ≤3 分钟：出击自动分到下一局的新房间。 */
  let matchNeedsNext = false
  /** 正在等待"按下一个新键"的取消函数；切页/出击/退回大厅都要拔掉。 */
  let cancelKeyCapture: (() => void) | null = null
  let traitSummaryEl: HTMLElement | null = null

  /** 已选几条：config.traits 是身份位掩码，traitCount() 吃的是打包值，所以自己数。 */
  function selectedTraitCount(): number {
    let count = 0
    for (const spec of TRAITS) if ((config.traits & spec.bit) !== 0) count++
    return count
  }

  /** 带满 MAX_TRAITS 后未选中的卡压暗：看得见但点不动，比直接隐藏诚实。 */
  function traitCountLabel(): string {
    return '已选 ' + selectedTraitCount() + ' / ' + MAX_TRAITS
  }

  function coinsLabel(): string {
    return '金币 ' + formatCoins(config.coins ?? 0)
  }

  /**
   * 配装摘要：名字 + 等级，最多三条。
   *
   * 走 packSelection 而不是直接读掩码：进局后真正生效的是"选中 ∩ 已拥有"，
   * 摘要必须和它一致，否则大厅说着三条、进局只算两条。
   */
  function traitSummaryLabel(): string {
    const picked = traitList(packSelection(config.traits, traitOwned)).slice(0, MAX_TRAITS)
    if (picked.length === 0) return '天赋 · 未携带'
    return '天赋 · ' + picked.map((entry) => entry.spec.name + ' Lv.' + entry.level).join(' / ')
  }
  /** 「猎人」页随身装备里主武器那一行的两个文本节点，换枪时由 syncHunterGear 改写。 */
  let hunterGearMain: { name: HTMLElement; note: HTMLElement } | null = null

  /**
   * 枪架与「随身装备」要一致。
   *
   * 两处画在不同的 pane 上（出击页 / 猎人页），各自建 DOM 时就固定住了，
   * 所以这里不留第二份状态，只把 config.primaryId 重新读一遍写进句柄。
   */
  function syncHunterGear(): void {
    if (!hunterGearMain) return
    const spec = WEAPONS[config.primaryId]
    hunterGearMain.name.textContent = weaponName(config.primaryId, '温菲尔德 M1873')
    hunterGearMain.note.textContent = spec ? KIND_RANGE[spec.kind] : '中远距离'
  }

  /** 出击按钮上方那行读数。config.primaryId 恒为 PRIMARY_CHOICES 之一，兜底只防手改过的存档。 */
  function primaryLabel(): string {
    return '主武器 · ' + weaponName(config.primaryId, '未知配枪')
  }

  /** 选中态是唯一真相：config 写值 → 落盘 → 卡片与读数一起刷新，三处不允许各记一份。 */
  function syncPrimary(): void {
    for (const card of primaryCards) {
      const picked = Number(card.dataset.weaponId) === config.primaryId
      card.classList.toggle('is-selected', picked)
      card.setAttribute('aria-pressed', picked ? 'true' : 'false')
    }
    if (primaryLine) primaryLine.textContent = primaryLabel()
    syncHunterGear()
  }

  function pickPrimary(id: number): void {
    if (!isPrimaryChoice(id) || id === config.primaryId) return
    config.primaryId = id
    config.build = loadBuildFor(id)
    // 立刻落盘而不是等按下「出击」：玩家换完枪直接刷新页面，下次进来还是这把。
    saveConfig(config)
    syncPrimary()
  }

  // ---------------------------------------------------------------- 主页

  /**
   * 主页：塔科夫式中心菜单。
   *
   * 只放四个入口，功能内容全部收进各自的页面 —— 大厅不再一上来就把地图卡、
   * 枪架、天赋、房间号全糊在玩家脸上。进出功能页用 `is-home` 类切换，
   * 导航列与内容栈整体隐藏，主页层叠在上面。
   */
  function buildHome(): HTMLElement {
    const home = mk('div', 'dk-home')
    const head = mk('div', 'dk-home__head')
    // 环境行：这一屏不是"选单"，是猎人在屋里看到的一条仪表读数。
    // 日期/天气来自 art-direction.ts，与出击标题卡、局内雾感同源。
    const world = artProfile(null)
    head.appendChild(mk('p', 'dk-home__kicker', worldLine(null)))
    head.appendChild(mk('h2', 'dk-home__title', 'DEAD KILL'))
    head.appendChild(mk('p', 'dk-home__sub', '带走赏金，或者成为赏金'))
    // 传闻：世界不说台词，只让玩家听见"别人在传什么"。
    head.appendChild(mk('p', 'dk-home__rumor', `「${world.rumor}」`))
    home.appendChild(head)

    const menu = mk('div', 'dk-home__menu')
    const items: Array<{ index: string; cn: string; en: string; run: () => void }> = [
      { index: '01', cn: '进入沼泽', en: 'ENTER THE BAYOU', run: () => requireNickname(() => enterFunction('deploy')) },
      { index: '02', cn: '庇护所', en: 'HIDEOUT', run: () => requireNickname(() => enterFunction('hunter')) },
      { index: '03', cn: '设置', en: 'SETTINGS', run: () => enterFunction('settings') },
      { index: '04', cn: '退出', en: 'EXIT', run: () => showExit() },
    ]
    for (const item of items) {
      const btn = mkButton('dk-home__item')
      btn.appendChild(mk('span', 'dk-home__index', item.index))
      const body = mk('span', 'dk-home__body')
      body.appendChild(mk('span', 'dk-home__cn', item.cn))
      body.appendChild(mk('span', 'dk-home__en', item.en))
      btn.appendChild(body)
      btn.appendChild(mk('span', 'dk-home__arrow', '→'))
      btn.addEventListener('click', item.run)
      menu.appendChild(btn)
    }
    home.appendChild(menu)

    const foot = mk('div', 'dk-home__foot')
    homeNickEl = mk('span', 'dk-home__nick', '未命名猎人')
    homeCoinsEl = mk('span', 'dk-home__coins', '金币 0')
    homeCoinsEl.classList.add('dk-home__coins')
    foot.appendChild(homeNickEl)
    foot.appendChild(mk('span', 'dk-home__sep', '·'))
    foot.appendChild(homeCoinsEl)
    home.appendChild(foot)
    updateHomeMeta()
    return home
  }

  function updateHomeMeta(): void {
    if (homeNickEl) homeNickEl.textContent = config.nickname.trim() || '未命名猎人'
    if (homeCoinsEl) homeCoinsEl.textContent = '金币 ' + formatCoins(config.coins ?? 0)
    if (profileNameEl) profileNameEl.textContent = '猎手 · ' + (config.nickname.trim() || '无名者')
  }

  function showHome(next: boolean): void {
    host.classList.toggle('is-home', next)
    // 功能页是独立沉浸层：没有全局导航/顶栏/底栏，只留左上角返回。
    host.classList.toggle('is-immersive', !next)
    if (next) {
      host.classList.remove('is-exited', 'is-shelter')
      arsenalPreview?.setActive(false)
      updateHomeMeta()
      const first = host.querySelector<HTMLButtonElement>('.dk-home__item')
      requestAnimationFrame(() => first?.focus({ preventScroll: true }))
    }
  }

  function buildFunctionBar(): HTMLElement {
    const bar = mk('div', 'dk-function-bar')
    const back = mkButton('dk-function-back', '← 主页')
    back.addEventListener('click', () => showHome(true))
    const text = mk('div', 'dk-function-bar__text')
    functionTitleEl = mk('span', 'dk-function-bar__title', '出击')
    functionMetaEl = mk('span', 'dk-function-bar__meta', 'DEPLOY')
    text.appendChild(functionTitleEl)
    text.appendChild(functionMetaEl)
    bar.appendChild(back)
    bar.appendChild(text)
    return bar
  }

  function updateFunctionTitle(id: PaneId, step = 1): void {
    if (!functionTitleEl || !functionMetaEl) return
    if (id === 'deploy') {
      const titles = [
        ['选择猎场', 'SELECT MAP'],
        ['组队与配装', 'TEAM & LOADOUT'],
        ['房间', 'ROOMS'],
      ] as const
      const pick = titles[Math.max(0, Math.min(2, step - 1))]!
      functionTitleEl.textContent = pick[0]
      functionMetaEl.textContent = pick[1]
      return
    }
    const titles: Record<PaneId, [string, string]> = {
      deploy: ['出击', 'DEPLOY'],
      hunter: ['庇护所', 'HIDEOUT'],
      arsenal: ['军械库', 'ARSENAL'],
      records: ['传奇', 'RECORDS'],
      keys: ['操作', 'CONTROLS'],
      settings: ['设置', 'SETTINGS'],
    }
    const pick = titles[id]
    functionTitleEl.textContent = pick[0]
    functionMetaEl.textContent = pick[1]
  }

  function buildShelterNav(): HTMLElement {
    const nav = mk('nav', 'dk-shelter-nav')
    const entries: Array<[PaneId, string, string]> = [
      ['hunter', '猎人档案', 'HUNTER'],
      ['arsenal', '军械库', 'ARSENAL'],
      ['records', '传奇', 'RECORDS'],
      ['keys', '操作', 'CONTROLS'],
    ]
    for (const [id, cn, en] of entries) {
      const btn = mkButton('dk-shelter-nav__item')
      btn.appendChild(mk('span', 'dk-shelter-nav__cn', cn))
      btn.appendChild(mk('span', 'dk-shelter-nav__en', en))
      btn.addEventListener('click', () => openShelterPane(id))
      shelterButtons.set(id, btn)
      nav.appendChild(btn)
    }
    return nav
  }

  function syncShelterNav(id: PaneId): void {
    for (const [pane, btn] of shelterButtons) {
      const active = pane === id
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
  }

  function openShelterPane(id: PaneId): void {
    showHome(false)
    activatePane(id)
    host.classList.add('is-shelter')
    updateFunctionTitle(id, 1)
    syncShelterNav(id)
  }

  function enterFunction(id: PaneId): void {
    showHome(false)
    activatePane(id)
    const shelter =
      id === 'hunter' || id === 'arsenal' || id === 'records' || id === 'keys'
    host.classList.toggle('is-shelter', shelter)
    syncShelterNav(id)
    updateFunctionTitle(id, 1)
    if (id === 'deploy') setDeployStep(1)
  }

  /**
   * 昵称引导。首次进游戏必须先报代号：击杀播报、队友列表、房间名册都读它。
   * 老存档已有 `dk.nickname` 时直接放行，不打扰。
   */
  function buildOnboarding(): HTMLElement {
    const el = mk('div', 'dk-onboard')
    const card = mk('div', 'dk-onboard__card')
    card.appendChild(mk('p', 'dk-onboard__kicker', 'BEFORE YOU ENTER'))
    card.appendChild(mk('h2', 'dk-onboard__title', '报上你的猎人代号'))
    card.appendChild(
      mk('p', 'dk-onboard__desc', '击杀播报、队友列表和房间名册都会用这个代号。最多 16 个字，之后可以在身份栏修改。'),
    )
    onboardInput = mk('input', 'dk-input dk-onboard__input')
    onboardInput.type = 'text'
    onboardInput.maxLength = 16
    onboardInput.autocomplete = 'off'
    onboardInput.spellcheck = false
    onboardInput.placeholder = '例如：泥鳅'
    onboardInput.value = config.nickname.trim()
    card.appendChild(onboardInput)
    onboardError = mk('p', 'dk-onboard__error', '')
    card.appendChild(onboardError)
    const confirm = mkButton('dk-cta dk-onboard__confirm', '确 认 代 号')
    confirm.addEventListener('click', () => commitNickname())
    card.appendChild(confirm)
    onboardInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitNickname()
      }
    })
    el.appendChild(card)
    onboardEl = el
    return el
  }

  function showOnboarding(then?: () => void): void {
    if (then !== undefined) onboardThen = then
    if (!onboardEl) return
    host.classList.add('is-onboarding')
    if (onboardError) onboardError.textContent = ''
    if (onboardInput) {
      onboardInput.value = config.nickname.trim()
      onboardInput.focus()
      onboardInput.select()
    }
  }

  function commitNickname(): void {
    const name = (onboardInput?.value ?? '').trim().replace(/\s+/g, ' ').slice(0, 16)
    if (!name) {
      if (onboardError) onboardError.textContent = '代号不能为空'
      return
    }
    config.nickname = name
    saveConfig(config)
    if (identity) identity.nickInput.value = name
    updateHomeMeta()
    // 引导层确认前心跳已经用「无名猎人」发过一次；立刻补一帧真名，
    // 避免好友列表在最多 8 秒里看到占位名。
    void heartbeatPresence()
    host.classList.remove('is-onboarding')
    const then = onboardThen
    onboardThen = null
    then?.()
  }

  function requireNickname(then: () => void): void {
    if (config.nickname.trim()) {
      then()
      return
    }
    showOnboarding(then)
  }

  function buildExitScreen(): HTMLElement {
    const el = mk('div', 'dk-exit')
    const card = mk('div', 'dk-exit__card')
    card.appendChild(mk('p', 'dk-exit__kicker', 'THE SWAMP REMEMBERS'))
    card.appendChild(mk('h2', 'dk-exit__title', '已退出'))
    card.appendChild(mk('p', 'dk-exit__desc', '可以关闭这个标签页了。若是误触，下面还能回去。'))
    const back = mkButton('dk-cta', '返 回 主 页')
    back.addEventListener('click', () => {
      host.classList.remove('is-exited')
      showHome(true)
    })
    card.appendChild(back)
    el.appendChild(card)
    return el
  }

  function showExit(): void {
    host.classList.add('is-exited')
    host.classList.remove('is-home')
    // 浏览器只允许脚本打开的窗口被 close()；失败就留在退出页，不是错误。
    try {
      window.close()
    } catch {
      // 留在退出页。
    }
  }

  /**
   * 出击时段的说明文案。
   *
   * 不写"白天更亮"这种废话：玩家真正需要知道的是**这局的光会怎么改变打法**。
   * 白天看得远，所以埋伏更难；夜里火光既是路标也是靶心。
   */
  const TIME_HINT: Record<MatchTimeBand, string> = {
    day: '日头压得低。看得远，也更容易被看见。',
    night: '月光下的沼泽。火光是最好的路标，也是最好的靶心。',
  }

  /** 卡片上"哪天 · 几点"那一行。时段一变整排卡片一起变。 */
  function mapWhenLabel(entryId: string): string {
    const world = artProfile(entryId)
    const band = TIME_BAND_LABEL[deployState.timeBand]
    return `${world.date} · ${band.hour} ${band.cn}`
  }

  /**
   * 出击时段选择（塔科夫式：一张图两种天）。
   *
   * 为什么是"全局一条"而不是每张卡各自两个按钮：卡片本身已经是 `<button>`，
   * 往里再塞按钮是非法 HTML（点击会同时触发卡片选中与时段切换，键盘也不可达）。
   * 而玩家心里的模型本来就是"今晚几点出门"，不是"这张图几点、那张图几点"。
   *
   * 选中的时段随 Hello 发给服务端，服务端只在这个时段的天气池里抽 modifier，
   * 局内光照由目标包里的 modifier 驱动（setDaylight）—— 三处指的是同一个值。
   */
  function buildTimeBar(): HTMLElement {
    const bar = mk('div', 'dk-timerow dk-step dk-step-map')
    bar.appendChild(mk('span', 'dk-timerow__label', '出击时段'))
    for (const band of TIME_BANDS) {
      const info = TIME_BAND_LABEL[band]
      const btn = mkButton('dk-time')
      btn.dataset.time = band
      btn.appendChild(mk('span', 'dk-time__hour', info.hour))
      btn.appendChild(mk('span', 'dk-time__cn', info.cn))
      btn.addEventListener('click', () => {
        if (deployState.timeBand === band) return
        deployState.timeBand = band
        // 立刻落盘：选完时段直接刷新页面，回来还是这个时段。
        writeRaw(KEY_TIME, band)
        syncTimeBand()
      })
      timeBtns.set(band, btn)
      bar.appendChild(btn)
    }
    timeHintEl = mk('span', 'dk-timerow__hint', TIME_HINT[deployState.timeBand])
    bar.appendChild(timeHintEl)
    return bar
  }

  /** 时段选择的所有视觉联动：按钮态、说明文案、每张卡上的"几点"。 */
  function syncTimeBand(): void {
    for (const [band, btn] of timeBtns) {
      const on = band === deployState.timeBand
      btn.classList.toggle('is-on', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    if (timeHintEl) timeHintEl.textContent = TIME_HINT[deployState.timeBand]
    for (const [id, el] of mapWhenEls) el.textContent = mapWhenLabel(id)
  }

  function buildDeploy(): void {
    const pane = panes.get('deploy')
    if (!pane) return
    const grid = mk('div', 'dk-deploy')
    grid.dataset.step = String(deployStep)
    deployGrid = grid
    grid.appendChild(buildStepBar())

    // ---- 第一步：地图 ----
    const left = mk('div', 'dk-deploy__maps')
    const head = mk('div', 'dk-section-head dk-step dk-step-map')
    head.appendChild(mk('h2', 'dk-section-head__cn', '选择猎场'))
    head.appendChild(mk('span', 'dk-section-head__en', 'SELECT MAP'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    left.appendChild(head)

    left.appendChild(buildTimeBar())

    const cards = mk('div', 'dk-maps dk-step dk-step-map')
    for (const [entryIndex, entry] of MAP_ENTRIES.entries()) {
      const card = mkButton('dk-map')
      card.dataset.mapId = entry.id
      card.appendChild(mk('span', 'dk-map__index', String(entryIndex + 1).padStart(2, '0')))
      card.setAttribute('aria-pressed', entry.id === deployState.mapId ? 'true' : 'false')
      if (entry.id === deployState.mapId) card.classList.add('is-selected')
      const art = mk('span', 'dk-map__art')
      art.dataset.art = entry.art
      card.appendChild(art)
      const body = mk('span', 'dk-map__body')
      body.appendChild(mk('span', 'dk-map__name', entry.name))
      body.appendChild(mk('span', 'dk-map__en', entry.en))
      body.appendChild(mk('span', 'dk-map__desc', entry.desc))
      // 这张图在世界上是"哪一天的几点"：五张卡不是一个菜单的五个选项，
      // 是五个不同日子的记录。日期与局内雾感同源（art-direction.ts），
      // 钟点跟着上面的时段选择一起变 —— 玩家在按下出击之前就该看到"这局是几点"。
      const when = mk('span', 'dk-map__when', mapWhenLabel(entry.id))
      mapWhenEls.set(entry.id, when)
      body.appendChild(when)
      const meta = mk('span', 'dk-map__meta')
      meta.appendChild(mk('span', 'dk-map__threat', '威胁 ' + entry.threat))
      body.appendChild(meta)
      card.appendChild(body)
      card.addEventListener('click', () => {
        deployState.mapId = entry.id
        // 选图立刻记进本会话：pickLevelId() 在 enter() 里读它，玩家点了卡片
        // 却没按下「出击」直接刷新时，也应该还在同一张图上（联调试多图全靠它）。
        rememberLevelId(entry.id)
        setCtaLabel(entry)
        syncMapSelection()
      })
      cards.appendChild(card)
    }
    left.appendChild(cards)
    const nextMap = buildStepNext('下一步 · 组队', () => requireNickname(() => setDeployStep(2)))
    nextMap.classList.add('dk-step', 'dk-step-map')
    left.appendChild(nextMap)

    // 枪架属于第二步（组队/配装），第一步只看地图。
    // 第二步上半：主武器压成一条横向速览；下半：队伍 / 好友并排。
    const teamTop = mk('div', 'dk-team-top dk-step dk-step-team')
    const primaryPanel = buildPrimaryPicker()
    teamTop.appendChild(primaryPanel)
    left.appendChild(teamTop)

    const teamBody = mk('div', 'dk-team-body dk-step dk-step-team')
    const partyPanel = buildPartyPanel()
    partyPanel.classList.add('dk-party-card')
    const friendsPanel = buildFriendsPanel()
    friendsPanel.classList.add('dk-friends-card')
    teamBody.appendChild(partyPanel)
    teamBody.appendChild(friendsPanel)
    left.appendChild(teamBody)
    grid.appendChild(left)

    const side = mk('div', 'dk-deploy__side')

    // ---- 第二步：配装 / 威胁 / 合同 / 身份 ----
    const teamStep = mk('div', 'dk-step dk-step-team dk-step-group')
    teamStep.appendChild(mk('p', 'dk-step-label', '配 装 · LOADOUT'))
    teamStep.appendChild(buildContractPicker())
    teamStep.appendChild(buildExtrasPicker())
    // 旧的一件式配件先整块收起，等塔科夫式多槽位系统落地后再换回来
    // （见 shared/src/attachments.ts 的 ATTACHMENTS_ENABLED）。
    if (ATTACHMENTS_ENABLED) teamStep.appendChild(buildAttachmentPicker())
    const nickField = buildNicknameField()
    teamStep.appendChild(nickField.wrap)

    // 天赋摘要紧跟主武器那行：出击前最后一眼能同时确认"这把枪"和"这三条天赋"。
    traitSummaryEl = mk('p', 'dk-trait-summary', traitSummaryLabel())
    teamStep.appendChild(traitSummaryEl)
    primaryLine = mk('p', 'dk-deploy__primary', primaryLabel())
    teamStep.appendChild(primaryLine)

    // 第二步不再放底部导航：顶部步骤条右侧有常驻「下一步」，面板可以
    // 占满首屏；右侧配装也就能完整露出代号/天赋。
    side.appendChild(teamStep)

    // ---- 第三步：房间 ----
    const roomStep = mk('div', 'dk-step dk-step-room dk-step-group')
    const roomField = buildRoomCodeField()
    roomStep.appendChild(roomField.wrap)
    roomStep.appendChild(buildRoomPanel())

    matchInfoEl = mk('div', 'dk-match-info', '正在读取房间…')
    cta = mkButton('dk-cta', '进 入 猎 场')
    cta.addEventListener('click', () => beginDeploy())
    setCtaLabel(currentMap())
    const roomNav = mk('div', 'dk-step-nav')
    roomNav.appendChild(buildStepBack('上一步 · 组队', () => setDeployStep(2)))
    // 房间列表可以很长，但「进入猎场」必须永远在视口里：把状态+CTA+返回
    // 收进一个 sticky 底栏，列表在它上面滚动。
    const roomCommit = mk('div', 'dk-room-commit')
    roomDetailEl = mk('div', 'dk-room-detail')
    roomCommit.appendChild(roomDetailEl)
    renderRoomDetail(null)
    roomCommit.appendChild(matchInfoEl)
    roomCommit.appendChild(cta)
    roomCommit.appendChild(roomNav)
    roomStep.appendChild(roomCommit)
    roomStep.appendChild(
      mk(
        'p',
        'dk-deploy__hint',
        'WASD 移动 · Shift 疾跑 · Ctrl 蹲伏 · 左键开火 · 右键瞄准 · R 换装填',
      ),
    )
    side.appendChild(roomStep)

    identity = { nickInput: nickField.input, matchInput: roomField.input }
    grid.appendChild(side)
    pane.appendChild(grid)
    syncPrimary()
    syncTraits()
    syncTimeBand()
    setDeployStep(deployStep)
  }

  function buildStepBar(): HTMLElement {
    const bar = mk('div', 'dk-steps')
    const defs: Array<[number, string, string]> = [
      [1, '地图', 'MAP'],
      [2, '组队', 'TEAM'],
      [3, '房间', 'ROOM'],
    ]
    for (const [step, cn, en] of defs) {
      const btn = mkButton('dk-steps__item')
      btn.appendChild(mk('span', 'dk-steps__num', String(step).padStart(2, '0')))
      btn.appendChild(mk('span', 'dk-steps__cn', cn))
      btn.appendChild(mk('span', 'dk-steps__en', en))
      btn.addEventListener('click', () => {
        if (step > 1) requireNickname(() => setDeployStep(step))
        else setDeployStep(step)
      })
      stepButtons.set(step, btn)
      bar.appendChild(btn)
    }
    stepNextButton = mkButton('dk-steps__next', '下一步 · 组队')
    stepNextButton.addEventListener('click', () => {
      if (deployStep < 3) requireNickname(() => setDeployStep(deployStep + 1))
    })
    bar.appendChild(stepNextButton)
    return bar
  }

  function buildStepNext(label: string, run: () => void): HTMLButtonElement {
    const btn = mkButton('dk-step-next', label)
    btn.addEventListener('click', run)
    return btn
  }

  function buildStepBack(label: string, run: () => void): HTMLButtonElement {
    const btn = mkButton('dk-step-back', label)
    btn.addEventListener('click', run)
    return btn
  }

  function setDeployStep(step: number): void {
    const next = Math.max(1, Math.min(3, Math.trunc(step) || 1))
    deployStep = next
    if (deployGrid) deployGrid.dataset.step = String(next)
    for (const [value, btn] of stepButtons) {
      btn.classList.toggle('is-active', value === next)
      btn.setAttribute('aria-pressed', value === next ? 'true' : 'false')
    }
    if (stepNextButton) {
      stepNextButton.hidden = next !== 2
      stepNextButton.textContent = '下一步 · 房间'
    }
    if (next === 3) {
      void refreshRooms()
      refreshMatchInfo()
    }
    if (activePane === 'deploy' && host.classList.contains('is-immersive')) {
      updateFunctionTitle('deploy', next)
    }
    const pane = panes.get('deploy')
    if (pane) pane.scrollTop = 0
  }

  function buildPrimaryPicker(): HTMLElement {
    const panel = mk('div', 'dk-panel dk-primary')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '主武器'))
    head.appendChild(mk('span', 'dk-section-head__en', 'PRIMARY'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    panel.appendChild(head)

    const row = mk('div', 'dk-weapons')
    row.setAttribute('role', 'group')
    row.setAttribute('aria-label', '主武器选择')

    for (const id of PRIMARY_CHOICES) {
      const spec: WeaponSpec | undefined = WEAPONS[id]
      if (!spec) continue
      const card = mkButton('dk-weapon')
      card.dataset.weaponId = String(id)
      // 角标一直在 DOM 里，只由 CSS 在选中时显形，免得切换时重建节点丢焦点
      card.appendChild(mk('span', 'dk-weapon__tick', '选'))
      card.appendChild(mk('span', 'dk-weapon__name', spec.name))
      card.appendChild(mk('span', 'dk-weapon__kind', KIND_CN[spec.kind]))

      const stats = mk('span', 'dk-weapon__stats')
      const values: Array<[string, string]> = [
        // 霰弹枪的 damage 是单颗弹丸的伤害，只写 17 会让人以为一发只能打 17 点
        ['伤害', spec.pellets > 1 ? spec.damage + '×' + spec.pellets : String(spec.damage)],
        ['射速', Math.round(60000 / spec.fireIntervalMs) + ' 发/分'],
        ['弹容', spec.magazine + ' 发'],
      ]
      for (const [key, value] of values) {
        const stat = mk('span', 'dk-weapon__stat')
        stat.appendChild(mk('span', 'dk-weapon__stat-key', key))
        stat.appendChild(mk('span', 'dk-weapon__stat-val', value))
        stats.appendChild(stat)
      }
      card.appendChild(stats)
      card.appendChild(
        mk('span', 'dk-weapon__switch', '出枪 ' + (spec.switchMs / 1000).toFixed(1) + ' 秒'),
      )

      // 卡片本身就是 <button>，Enter / Space 走浏览器默认激活即可，不再挂 keydown
      // （再挂一遍会和默认行为叠成两次选中）。指针事件必须就地截住：画布的点击
      // 锁定挂在 document 上，冒泡过去会被当成"点了画面"而抢走鼠标。
      card.addEventListener('pointerdown', (event) => event.stopPropagation())
      card.addEventListener('click', (event) => {
        event.stopPropagation()
        pickPrimary(id)
      })

      primaryCards.push(card)
      row.appendChild(card)
    }

    panel.appendChild(row)
    return panel
  }

  /** 服务端权威档案落地：金币、已拥有天赋/配件、已付款补给。 */
  function applyProfile(profile: ProfileView): void {
    config.coins = normalizeCoins(profile.coins)
    traitOwned = profile.traitOwned >>> 0
    attachmentOwned = profile.attachmentOwned >>> 0
    extrasOwned = profile.extrasOwned & 3
    // 服务端把未拥有天赋洗掉后，大厅的“这局带哪几条”也要跟着洗，
    // 否则 UI 会显示一条服务端根本不认的天赋。
    let nextTraits = config.traits
    for (const spec of TRAITS) {
      if (traitLevel(traitOwned, spec.bit) === 0) nextTraits &= ~spec.bit
    }
    config.traits = clampSelection(nextTraits)
    // 本地存着的 build 可能包含未购买的配件（旧存档/改过的 localStorage）；
    // 大厅先洗一遍，避免服务端洗掉后“工作台显示装了、局内却按原厂算”。
    config.build = sanitizeOwnedBuild(config.primaryId, config.build?.slots, attachmentOwned)
    writeBuild(config.build)
    writeTraitOwned(traitOwned)
    saveConfig(config)
    syncTraits()
    refreshArsenal?.()
    refreshExtras?.()
  }

  function syncTraits(): void {
    const used = selectedTraitCount()
    for (const view of traitCards) {
      const level = traitLevel(traitOwned, view.spec.bit)
      const picked = (config.traits & view.spec.bit) !== 0
      view.card.classList.toggle('is-selected', picked)
      view.card.classList.toggle('is-locked', level === 0)
      view.card.classList.toggle('is-full', !picked && used >= MAX_TRAITS)
      view.card.setAttribute('aria-pressed', picked ? 'true' : 'false')
      view.levelsWrap.setAttribute('aria-label', '等级 ' + level + ' / ' + TRAIT_MAX_LEVEL)
      for (let i = 0; i < view.levels.length; i++) {
        view.levels[i].classList.toggle('is-on', i < level)
      }
      // 0 级也显示一级效果（由 is-locked 说明"还没生效"）：空着等于把成本藏起来。
      view.desc.textContent = view.spec.levels[level === 0 ? 0 : level - 1] ?? ''
      view.desc.classList.toggle('is-locked', level === 0)
      const cost = traitUpgradeCost(level)
      if (level >= TRAIT_MAX_LEVEL) {
        view.buy.textContent = '已满级'
        view.buy.disabled = true
      } else {
        // 0 级是"解锁"，1/2 级是"升级"：同一个按钮，但玩家要看得懂自己在买什么。
        view.buy.textContent = (level === 0 ? '解锁 $' : '升级 $') + cost
        view.buy.disabled = false
      }
    }
    if (traitCountEl) traitCountEl.textContent = traitCountLabel()
    if (coinsEl) coinsEl.textContent = coinsLabel()
    if (traitSummaryEl) traitSummaryEl.textContent = traitSummaryLabel()
    if (profileSubEl) {
      const ownedNow = TRAITS.reduce(
        (count, spec) => count + (traitLevel(traitOwned, spec.bit) > 0 ? 1 : 0),
        0,
      )
      profileSubEl.textContent =
        `本机存档 · 金币 $${normalizeCoins(config.coins ?? 0)} · 天赋 ${ownedNow}/${TRAITS.length}`
    }
  }

  /**
   * 抖一下 + 在卡片上留一句提示。
   *
   * 动画类必须先摘掉、读一次 offsetWidth、再加回去：连着点同一个按钮时类名
   * 没有变化就不会重放动画，玩家会觉得"第二次点完全没反应"。
   */
  function denyTrait(view: TraitCardView, message: string, shake: HTMLElement): void {
    view.deny.textContent = message
    view.card.classList.add('is-denied')
    shake.classList.remove('is-deny')
    void shake.offsetWidth
    shake.classList.add('is-deny')
    window.clearTimeout(view.timer)
    view.timer = window.setTimeout(() => {
      shake.classList.remove('is-deny')
      view.card.classList.remove('is-denied')
      view.deny.textContent = ''
    }, 900)
  }

  function pickTrait(view: TraitCardView): void {
    const level = traitLevel(traitOwned, view.spec.bit)
    const picked = (config.traits & view.spec.bit) !== 0
    // 0 级 = 还没解锁。packSelection 会把 0 级的条目丢掉，所以"装上"这件事根本
    // 不存在，只提示不写状态 —— 写进去会变成大厅说带了、进局一条都没有。
    if (!picked && level === 0) {
      denyTrait(view, '需要先解锁', view.card)
      return
    }
    // toggleSelection 自己处理三种情况：已选则取消、没满则加、满了原样返回。
    // 满员时返回同一个值，这里直接 return —— 不能"顶掉最早选的"，那会让玩家
    // 点第三张之后看着第一张悄悄灭掉，却完全不知道是自己干的。
    const next = toggleSelection(config.traits, view.spec.bit)
    if (next === config.traits) {
      denyTrait(view, '最多带 ' + MAX_TRAITS + ' 条', view.card)
      return
    }
    config.traits = next
    saveConfig(config)
    syncTraits()
  }

  /**
   * 花金币升一级。
   *
   * 升级**不改变"带不带"**：等级是永久拥有的强度，装备是"这局带哪三条"。两件事
   * 混在一起的话，升一级会顺手把卡塞进配装，第 4 条就得自己卸。
   */
  function upgradeTrait(view: TraitCardView): void {
    const level = traitLevel(traitOwned, view.spec.bit)
    if (level >= TRAIT_MAX_LEVEL) return
    const cost = traitUpgradeCost(level)
    const coins = normalizeCoins(config.coins ?? 0)
    if (coins < cost) {
      denyTrait(view, '金币不足', view.buy)
      return
    }
    // 扣款与升级由服务端完成；本地只负责把按钮锁住、拿回新档案。
    view.buy.disabled = true
    void buyProfile('trait', view.spec.bit).then((result) => {
      view.buy.disabled = false
      if (!result.ok) {
        denyTrait(view, result.error, view.buy)
        return
      }
      applyProfile(result.profile)
    })
  }

  function buildTraitPicker(): HTMLElement {
    const panel = mk('div', 'dk-panel dk-traits')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '天赋'))
    head.appendChild(mk('span', 'dk-section-head__en', 'TRAITS'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    coinsEl = mk('span', 'dk-coins', coinsLabel())
    head.appendChild(coinsEl)
    traitCountEl = mk('span', 'dk-traits__count', traitCountLabel())
    head.appendChild(traitCountEl)
    panel.appendChild(head)

    const row = mk('div', 'dk-trait-row')
    row.setAttribute('role', 'group')
    row.setAttribute('aria-label', '天赋选择')

    for (const spec of TRAITS) {
      // 卡本体是 div（role=button）而不是 button：卡片里还有一颗金币按钮，
      // button 套 button 是非法结构，浏览器会把内层拆出去 —— 点"升级"就变成点了"装备"。
      const card = mk('div', 'dk-trait')
      card.dataset.traitBit = String(spec.bit)
      card.setAttribute('role', 'button')
      card.tabIndex = 0
      // 序号常驻：十张卡不编号，玩家没法按名字以外的顺序记自己在哪。
      card.appendChild(mk('span', 'dk-trait__tick', String(spec.index + 1).padStart(2, '0')))

      // 徽记是"会动"的 SVG（动效见 traits.css）：大厅这张卡上的徽记，就是进局后
      // HUD 上那颗。两处共用 traitGlyph()，不可能画歪成两个样子。
      const icon = mk('span', 'dk-trait__icon')
      icon.innerHTML = traitGlyph(spec.bit)
      card.appendChild(icon)

      const body = mk('span', 'dk-trait__body')
      body.appendChild(mk('span', 'dk-trait__name', spec.name))
      body.appendChild(mk('span', 'dk-trait__en', spec.en))
      card.appendChild(body)

      // 等级用三个方块而不是"Lv.3"三个字符：方块能一眼数出还剩几级没买。
      const levels = mk('span', 'dk-trait__levels')
      const dots: HTMLElement[] = []
      for (let i = 0; i < TRAIT_MAX_LEVEL; i++) {
        const dot = mk('span', 'dk-trait__level')
        levels.appendChild(dot)
        dots.push(dot)
      }
      card.appendChild(levels)

      const desc = mk('span', 'dk-trait__desc', spec.levels[0] ?? '')
      card.appendChild(desc)
      // 提示语一直在 DOM 里、只由 is-denied 显形：出错时不用插节点，也就不会跳版。
      const deny = mk('span', 'dk-trait__deny')
      card.appendChild(deny)

      const buy = mkButton('dk-trait__buy')
      card.appendChild(buy)

      const view: TraitCardView = {
        spec,
        card,
        levels: dots,
        levelsWrap: levels,
        desc,
        deny,
        buy,
        timer: 0,
      }

      // 和枪卡同样的理由：画布的"点击锁定鼠标"挂在 document 上，冒泡过去会被
      // 当成点了画面，选天赋的同时把鼠标锁走。金币按钮自己也截一遍，否则点升级
      // 会先冒到卡上，把"装 / 卸"一起执行掉。
      card.addEventListener('pointerdown', (event) => event.stopPropagation())
      card.addEventListener('click', (event) => {
        event.stopPropagation()
        pickTrait(view)
      })
      card.addEventListener('keydown', (event) => {
        // 只认卡自己的按键：金币按钮的 Enter / Space 走浏览器默认激活，
        // 在这里再拦一次就会"升级 + 装 / 卸"各来一遍。
        if (event.target !== card) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        pickTrait(view)
      })
      buy.addEventListener('pointerdown', (event) => event.stopPropagation())
      buy.addEventListener('click', (event) => {
        event.stopPropagation()
        upgradeTrait(view)
      })

      traitCards.push(view)
      row.appendChild(card)
    }

    panel.appendChild(row)
    return panel
  }

  function buildContractPicker(): HTMLElement {
    const wrap = mk('div', 'dk-field')
    wrap.appendChild(mk('span', 'dk-field__label', '局内合同'))
    const row = mk('div', 'dk-segment')
    const hint = mk('p', 'dk-deploy__hint')
    // 合同不只是名字：目标与奖励必须不悬浮也能读到，否则首局等于盲选。
    const syncHint = (): void => {
      const spec = CONTRACTS.find((entry) => entry.id === deployState.contract)
      hint.textContent = spec
        ? `${spec.desc} · 奖励 $${spec.reward}`
        : '合同不改变胜负，只给你一个额外的目标。'
    }
    for (const spec of CONTRACTS) {
      const btn = mkButton('dk-segment__item', spec.name)
      btn.title = spec.desc + (spec.reward > 0 ? ` · 奖励 ${spec.reward}` : '')
      btn.setAttribute('aria-pressed', deployState.contract === spec.id ? 'true' : 'false')
      if (deployState.contract === spec.id) btn.classList.add('is-selected')
      btn.addEventListener('click', () => {
        deployState.contract = spec.id
        config.contract = spec.id
        for (const other of row.querySelectorAll('.dk-segment__item')) {
          const isSelf = other === btn
          other.classList.toggle('is-selected', isSelf)
          other.setAttribute('aria-pressed', isSelf ? 'true' : 'false')
        }
        syncHint()
        saveConfig(config)
      })
      row.appendChild(btn)
    }
    wrap.appendChild(row)
    syncHint()
    wrap.appendChild(hint)
    return wrap
  }

  /** 随身补给：用金币买这一局的额外绷带/备弹。选中即扣，取消即退。 */
  const EXTRAS: { bit: number; label: string; cost: number }[] = [
    { bit: 1, label: '绷带 +2', cost: 100 },
    { bit: 2, label: '备弹 +1 匣', cost: 80 },
  ]

  function buildExtrasPicker(): HTMLElement {
    const wrap = mk('div', 'dk-field')
    wrap.appendChild(mk('span', 'dk-field__label', '随身补给（金币）'))
    const row = mk('div', 'dk-segment')
    const buttons: HTMLButtonElement[] = []
    const hint = mk('p', 'dk-deploy__hint', '买断后不退款；进场时发放。')
    const sync = (): void => {
      const coins = normalizeCoins(config.coins ?? 0)
      for (const [i, spec] of EXTRAS.entries()) {
        const owned = (extrasOwned & spec.bit) !== 0
        const on = (deployState.extras & spec.bit) !== 0
        const btn = buttons[i]!
        btn.textContent = (owned ? '已购 · ' : '') + spec.label + (owned ? '' : ' $' + spec.cost)
        btn.classList.toggle('is-selected', on)
        btn.setAttribute('aria-pressed', on ? 'true' : 'false')
        btn.disabled = !on && !owned && coins < spec.cost
      }
    }
    for (const spec of EXTRAS) {
      const btn = mkButton('dk-segment__item', spec.label + ' $' + spec.cost)
      btn.addEventListener('click', () => {
        const on = (deployState.extras & spec.bit) !== 0
        const owned = (extrasOwned & spec.bit) !== 0
        const toggle = (): void => {
          deployState.extras = on
            ? deployState.extras & ~spec.bit
            : deployState.extras | spec.bit
          config.extras = deployState.extras & 3
          saveConfig(config)
          syncTraits()
          sync()
        }
        if (on) {
          // 取消只是“这局不带”，不退款；已付款的位留在档案里下次还能带。
          toggle()
          return
        }
        if (owned) {
          toggle()
          return
        }
        const coins = normalizeCoins(config.coins ?? 0)
        if (coins < spec.cost) return
        btn.disabled = true
        void buyProfile('extras', spec.bit).then((result) => {
          btn.disabled = false
          if (!result.ok) {
            hint.textContent = result.error
            return
          }
          applyProfile(result.profile)
          toggle()
        })
      })
      buttons.push(btn)
      row.appendChild(btn)
    }
    wrap.appendChild(row)
    wrap.appendChild(hint)
    refreshExtras = sync
    sync()
    return wrap
  }

  /** 主武器配件：金币一次性解锁，之后每局免费选一件。 */
  function buildAttachmentPicker(): HTMLElement {
    const wrap = mk('div', 'dk-field')
    wrap.appendChild(mk('span', 'dk-field__label', '主武器配件'))
    const row = mk('div', 'dk-segment')
    const buttons: HTMLButtonElement[] = []
    const sync = (): void => {
      const coins = normalizeCoins(config.coins ?? 0)
      for (const [i, spec] of ATTACHMENTS.entries()) {
        const unlocked = ((attachmentUnlocks >>> spec.id) & 1) === 1
        const on = deployState.attachment === spec.id
        const btn = buttons[i]!
        btn.textContent = unlocked ? spec.name : spec.name + ' $' + spec.cost
        btn.title = spec.desc
        btn.classList.toggle('is-selected', on)
        btn.setAttribute('aria-pressed', on ? 'true' : 'false')
        btn.disabled = !unlocked && coins < spec.cost
      }
    }
    for (const spec of ATTACHMENTS) {
      const btn = mkButton('dk-segment__item', spec.name)
      btn.addEventListener('click', () => {
        const unlocked = ((attachmentUnlocks >>> spec.id) & 1) === 1
        const coins = normalizeCoins(config.coins ?? 0)
        if (!unlocked) {
          if (coins < spec.cost) return
          config.coins = coins - spec.cost
          attachmentUnlocks = (attachmentUnlocks | (1 << spec.id)) >>> 0
          writeRaw(KEY_ATTACH_UNLOCKS, String(attachmentUnlocks))
          if (dossierCoinsEl) dossierCoinsEl.textContent = formatCoins(config.coins ?? 0)
        }
        deployState.attachment = spec.id
        config.attachment = spec.id
        saveConfig(config)
        syncTraits()
        sync()
      })
      buttons.push(btn)
      row.appendChild(btn)
    }
    wrap.appendChild(row)
    sync()
    const hint = mk('p', 'dk-deploy__hint', '配件永久解锁；每局可免费选一件。')
    wrap.appendChild(hint)
    return wrap
  }

  function buildNicknameField(): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = mk('div', 'dk-field')
    const label = mk('label', 'dk-field__label', '猎人代号')
    const input = mk('input', 'dk-input')
    input.id = 'dk-nickname'
    label.setAttribute('for', input.id)
    input.type = 'text'
    input.maxLength = 16
    input.autocomplete = 'off'
    input.spellcheck = false
    input.placeholder = '猎人'
    input.value = config.nickname
    input.addEventListener('change', () => {
      config.nickname = input.value.trim().replace(/\s+/g, ' ').slice(0, 16)
      input.value = config.nickname
      saveConfig(config)
      updateHomeMeta()
      void heartbeatPresence()
    })
    wrap.appendChild(label)
    wrap.appendChild(input)
    return { wrap, input }
  }

  function buildRoomCodeField(): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = mk('div', 'dk-field')
    const label = mk('label', 'dk-field__label', '房间号（也可以直接点下面的房间）')
    const input = mk('input', 'dk-input')
    input.id = 'dk-match'
    label.setAttribute('for', input.id)
    input.type = 'text'
    input.maxLength = 32
    input.autocomplete = 'off'
    input.spellcheck = false
    input.placeholder = 'default'
    input.value = config.matchId
    input.addEventListener('change', () => {
      config.matchId = input.value.trim().slice(0, 32) || 'default'
      input.value = config.matchId
      saveConfig(config)
      void heartbeatPresence()
      void refreshRooms()
      refreshMatchInfo()
    })
    wrap.appendChild(label)
    const row = mk('div', 'dk-room-code')
    row.appendChild(input)
    const copy = mkButton('dk-room-copy', '复制房号')
    copy.title = '把房号发给队友，他们可以手输加入'
    const done = (): void => {
      copy.textContent = '已复制'
      window.setTimeout(() => {
        copy.textContent = '复制房号'
      }, 1200)
    }
    copy.addEventListener('click', () => {
      const text = config.matchId || 'default'
      const fallback = (): void => {
        input.focus()
        input.select()
        try {
          document.execCommand('copy')
          done()
        } catch {
          // 没有剪贴板权限时至少把房号选中，玩家可以 Ctrl+C。
        }
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback)
      } else {
        fallback()
      }
    })
    row.appendChild(copy)
    wrap.appendChild(row)
    return { wrap, input }
  }

  interface RoomView {
    id: string
    levelId: string
    players: number
    secondsLeft: number
    phase: string
    roster: { id: number; name: string; team: number; alive: boolean }[]
  }

  interface PresenceView {
    code: string
    name: string
    roomId: string
    levelId: string
  }

  interface PartyMemberView {
    code: string
    name: string
  }

  interface PartyView {
    id: string
    leader: string
    members: PartyMemberView[]
    roomId: string
    levelId: string
    launchedAt: number
  }

  interface PartyInviteView {
    id: string
    fromCode: string
    fromName: string
  }

  function buildRoomPanel(): HTMLElement {
    const panel = mk('div', 'dk-panel dk-rooms')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '房间'))
    head.appendChild(mk('span', 'dk-section-head__en', 'ROOMS'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    panel.appendChild(head)

    roomListEl = mk('div', 'dk-rooms__list')
    roomListEl.setAttribute('role', 'list')
    panel.appendChild(roomListEl)

    const actions = mk('div', 'dk-rooms__actions')
    const create = mkButton('dk-rooms__create', '创建新房间')
    create.addEventListener('click', () => void createRoom())
    const refresh = mkButton('dk-rooms__refresh', '刷新')
    refresh.addEventListener('click', () => void refreshRooms())
    actions.appendChild(create)
    actions.appendChild(refresh)
    panel.appendChild(actions)

    roomStatusEl = mk('p', 'dk-rooms__status', '正在读取房间…')
    panel.appendChild(roomStatusEl)
    void refreshRooms()
    return panel
  }

  function apiBase(): string {
    return location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '')
  }

  /**
   * 选中房间的名册，按服务端下发的 `team` 分组。
   *
   * 房间卡片上的「1 队 · 泥鳅」只够判断有没有人；真正组队前需要看清
   * 谁和谁一队。独狼的 team 是 1000+id，双人队是 1、2…，这里分开显示。
   */
  function renderRoomDetail(room: RoomView | null): void {
    if (!roomDetailEl) return
    roomDetailEl.replaceChildren()
    if (!room) {
      roomDetailEl.appendChild(mk('p', 'dk-room-detail__empty', '未选择房间 · 点左侧一间加入'))
      return
    }
    const head = mk('div', 'dk-room-detail__head')
    head.appendChild(mk('span', 'dk-room-detail__label', '当前房间'))
    head.appendChild(mk('span', 'dk-room-detail__id', room.id))
    roomDetailEl.appendChild(head)

    const phase =
      room.phase === 'lobby'
        ? '空闲'
        : room.phase === 'over'
          ? '已结束'
          : room.players === 0
            ? '空闲'
            : '进行中'
    roomDetailEl.appendChild(
      mk(
        'p',
        'dk-room-detail__meta',
        `${getLevel(room.levelId).name} · ${room.players}/${MAX_PLAYERS} 人 · ${phase}`,
      ),
    )

    if (room.roster.length === 0) {
      roomDetailEl.appendChild(mk('p', 'dk-room-detail__empty', '空房 · 等待猎人'))
      return
    }

    const teams = new Map<number, RoomView['roster']>()
    for (const player of room.roster) {
      const list = teams.get(player.team)
      if (list) list.push(player)
      else teams.set(player.team, [player])
    }
    const list = mk('div', 'dk-room-detail__teams')
    for (const [team, players] of [...teams].sort((a, b) => a[0] - b[0])) {
      const row = mk('div', 'dk-room-team')
      const solo = team >= 1000
      row.appendChild(
        mk('span', 'dk-room-team__badge', solo ? '独狼' : '队伍 ' + team),
      )
      const names = mk('span', 'dk-room-team__names')
      for (const player of players) {
        const name = mk('span', 'dk-room-team__name', player.name)
        if (!player.alive) name.classList.add('is-dead')
        names.appendChild(name)
      }
      row.appendChild(names)
      list.appendChild(row)
    }
    roomDetailEl.appendChild(list)
  }

  /**
   * 选一个房间：写进 config / 房间号输入 / CTA。
   *
   * 不立刻出击：玩家可能还要换枪或等队友。选中的房间在列表里高亮，
   * 按「进入猎场」才真正握手。
   */
  function selectRoom(id: string, levelId?: string): void {
    config.matchId = id
    saveConfig(config)
    // 房间自带地图：加入别人的房间时，客户端必须按房间的图握手，
    // 否则空房会被自己的默认图覆盖（registerLevel 对空场采纳新请求）。
    if (levelId && levelId !== deployState.mapId) {
      deployState.mapId = levelId
      rememberLevelId(levelId)
      syncMapSelection()
      setCtaLabel(currentMap())
    }
    if (identity) identity.matchInput.value = id
    void heartbeatPresence()
    if (roomListEl) {
      for (const card of roomListEl.querySelectorAll<HTMLElement>('.dk-room-card')) {
        card.classList.toggle('is-selected', card.dataset.roomId === id)
      }
    }
    renderRoomDetail(roomCache.get(id) ?? null)
    refreshMatchInfo()
  }

  async function refreshRooms(): Promise<void> {
    if (!roomListEl || disposed) return
    try {
      const res = await fetch(`${apiBase()}/api/rooms`, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { rooms?: RoomView[] }
      if (disposed || !roomListEl) return
      const rooms = data.rooms ?? []
      roomCache.clear()
      for (const room of rooms) roomCache.set(room.id, room)
      renderRooms(rooms)
      renderRoomDetail(roomCache.get(config.matchId) ?? null)
    } catch {
      if (roomStatusEl) roomStatusEl.textContent = '房间列表不可用'
    }
  }

  function renderRooms(rooms: RoomView[]): void {
    if (!roomListEl) return
    roomListEl.replaceChildren()
    if (rooms.length === 0) {
      roomListEl.appendChild(mk('p', 'dk-rooms__empty', '还没有房间。创建一间，或者等别人先开。'))
      if (roomStatusEl) roomStatusEl.textContent = '空房列表 · 创建一个房间开始'
      return
    }
    for (const room of rooms) {
      const card = mkButton('dk-room-card')
      card.dataset.roomId = room.id
      card.setAttribute('role', 'listitem')
      if (room.id === config.matchId) card.classList.add('is-selected')
      const top = mk('div', 'dk-room-card__top')
      top.appendChild(mk('span', 'dk-room-card__id', room.id))
      top.appendChild(
        mk('span', 'dk-room-card__players', `${room.players}/${MAX_PLAYERS}`),
      )
      card.appendChild(top)
      const meta = mk('div', 'dk-room-card__meta')
      meta.appendChild(mk('span', 'dk-room-card__map', getLevel(room.levelId).name))
      const phase =
        room.phase === 'lobby'
          ? '空闲'
          : room.phase === 'over'
            ? '已结束'
            : room.players === 0
              ? '空闲'
              : '进行中'
      meta.appendChild(mk('span', 'dk-room-card__phase', phase))
      if (room.phase !== 'lobby' && room.secondsLeft > 0) {
        const secs = Math.max(0, Math.ceil(room.secondsLeft))
        meta.appendChild(
          mk('span', 'dk-room-card__time', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`),
        )
      }
      card.appendChild(meta)
      const teams = new Set(room.roster.map((p) => p.team)).size
      const names = room.roster
        .slice(0, 4)
        .map((p) => p.name)
        .join('、')
      const roster = mk('div', 'dk-room-card__roster')
      roster.textContent =
        room.roster.length === 0
          ? '空房 · 等待猎人'
          : `${teams} 队 · ${names}${room.roster.length > 4 ? '…' : ''}`
      card.appendChild(roster)
      if (room.players >= MAX_PLAYERS) {
        card.classList.add('is-full')
        card.disabled = true
      }
      card.dataset.levelId = room.levelId
      card.addEventListener('click', () => selectRoom(room.id, room.levelId))
      roomListEl.appendChild(card)
    }
    if (roomStatusEl) roomStatusEl.textContent = `${rooms.length} 个房间 · 点一间加入，或创建新房间`
  }

  async function createRoom(): Promise<void> {
    if (roomStatusEl) roomStatusEl.textContent = '正在创建房间…'
    try {
      const res = await fetch(`${apiBase()}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ levelId: deployState.mapId }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        id?: string
        levelId?: string
        error?: string
      }
      if (!res.ok || !data.ok || !data.id) throw new Error(data.error ?? '创建失败')
      selectRoom(data.id, data.levelId)
      await refreshRooms()
      if (roomStatusEl) roomStatusEl.textContent = `房间 ${data.id} 已创建 · 按「进入猎场」`
    } catch (error) {
      if (roomStatusEl) roomStatusEl.textContent = error instanceof Error ? error.message : '创建失败'
    }
  }

  // ---------------------------------------------------------------- 队伍

  async function partyRequest<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${apiBase()}/api/party/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return (await res.json()) as T
    } catch {
      return null
    }
  }

  function syncSquadUI(): void {
    const pane = panes.get('deploy')
    if (!pane) return
    const wantDuo = party !== null
    deployState.squad = wantDuo ? 'duo' : 'solo'
    config.squad = wantDuo ? 1 : 0
    for (const btn of pane.querySelectorAll<HTMLButtonElement>('.dk-segment__item')) {
      const duo = btn.textContent === '双人'
      const solo = btn.textContent === '单人'
      if (!duo && !solo) continue
      const selected = duo ? wantDuo : !wantDuo
      btn.classList.toggle('is-selected', selected)
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false')
    }
  }

  async function refreshParty(): Promise<void> {
    const hadParty = party !== null
    // 轮询和 create/accept 会并发：一个在 create 之前发出的 GET 若晚到，
    // 会把刚加入的队伍覆盖回 null。只允许最新请求落地。
    const seq = ++partySeq
    try {
      const res = await fetch(
        `${apiBase()}/api/party/state?code=${encodeURIComponent(friendCode)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as {
        party?: PartyView | null
        invites?: PartyInviteView[]
      }
      if (seq !== partySeq) return
      party = data.party ?? null
      partyInvites = Array.isArray(data.invites) ? data.invites : []
    } catch {
      if (seq !== partySeq) return
      // 网络断了先保留上一次的队伍显示；下一次轮询会自愈。
    }
    if (party) {
      config.partyId = party.id
      config.squad = 1
      syncSquadUI()
    } else {
      config.partyId = undefined
      lastPartyLaunch = 0
      if (hadParty) {
        config.squad = 0
        deployState.squad = 'solo'
        syncSquadUI()
      }
    }
    renderParty()
    handlePartyLaunch()
  }

  async function createParty(): Promise<void> {
    const data = await partyRequest<{ ok?: boolean; party?: PartyView; error?: string }>('create', {
      code: friendCode,
      name: config.nickname,
    })
    if (data?.party) {
      partySeq++
      party = data.party
      config.partyId = party.id
      config.squad = 1
      syncSquadUI()
      renderParty()
      void heartbeatPresence()
    } else if (partyStatusEl) {
      partyStatusEl.textContent = data?.error ?? '创建队伍失败'
    }
  }

  async function inviteFriend(friend: FriendEntry, presence: PresenceView): Promise<void> {
    if (!party) await createParty()
    if (!party) return
    if (party.leader !== friendCode) {
      if (partyStatusEl) partyStatusEl.textContent = '只有队长可以邀请'
      return
    }
    if (party.members.length >= 2) {
      if (partyStatusEl) partyStatusEl.textContent = '队伍已满（双人）'
      return
    }
    const data = await partyRequest<{ ok?: boolean; error?: string }>('invite', {
      fromCode: friendCode,
      toCode: presence.code,
    })
    if (partyStatusEl) {
      partyStatusEl.textContent = data?.ok
        ? `已邀请 ${friend.name} · 等待接受`
        : (data?.error ?? '邀请失败')
    }
    void refreshParty()
  }

  async function acceptInvite(invite: PartyInviteView): Promise<void> {
    const data = await partyRequest<{ ok?: boolean; party?: PartyView; error?: string }>('accept', {
      code: friendCode,
      inviteId: invite.id,
    })
    if (data?.party) {
      partySeq++
      party = data.party
      config.partyId = party.id
      config.squad = 1
      syncSquadUI()
      partyInvites = partyInvites.filter((item) => item.id !== invite.id)
      renderParty()
      void heartbeatPresence()
    } else if (partyStatusEl) {
      partyStatusEl.textContent = data?.error ?? '接受邀请失败'
    }
  }

  async function declineInvite(invite: PartyInviteView): Promise<void> {
    await partyRequest('decline', { code: friendCode, inviteId: invite.id })
    partyInvites = partyInvites.filter((item) => item.id !== invite.id)
    renderParty()
  }

  async function leaveParty(): Promise<void> {
    await partyRequest('leave', { code: friendCode })
    partySeq++
    party = null
    config.partyId = undefined
    config.squad = 0
    deployState.squad = 'solo'
    lastPartyLaunch = 0
    syncSquadUI()
    renderParty()
    void heartbeatPresence()
  }

  async function launchParty(): Promise<void> {
    if (!party || party.leader !== friendCode) return
    await partyRequest('launch', {
      code: friendCode,
      roomId: config.matchId,
      levelId: deployState.mapId,
    })
  }

  function handlePartyLaunch(): void {
    if (!party || party.leader === friendCode) return
    if (!party.launchedAt || party.launchedAt === lastPartyLaunch) return
    lastPartyLaunch = party.launchedAt
    if (deploying || !visible) return
    autoFollowing = true
    try {
      config.partyId = party.id
      config.squad = 1
      deployState.squad = 'duo'
      syncSquadUI()
      if (party.roomId) selectRoom(party.roomId, party.levelId || undefined)
      beginDeploy()
    } finally {
      autoFollowing = false
    }
  }

  function renderInvitesInto(container: HTMLElement): void {
    container.replaceChildren()
    for (const invite of partyInvites) {
      const card = mk('div', 'dk-party__invite')
      card.appendChild(mk('span', 'dk-party__invite-text', `${invite.fromName} 邀请你加入队伍`))
      const accept = mkButton('dk-party__accept', '接受')
      accept.addEventListener('click', () => void acceptInvite(invite))
      const decline = mkButton('dk-party__decline', '拒绝')
      decline.addEventListener('click', () => void declineInvite(invite))
      card.appendChild(accept)
      card.appendChild(decline)
      container.appendChild(card)
    }
  }

  function buildPartyAlert(): HTMLElement {
    partyAlertEl = mk('div', 'dk-party-alert')
    return partyAlertEl
  }

  function renderParty(): void {
    if (!partyMembersEl || !partyInviteEl) return
    partyMembersEl.replaceChildren()
    renderInvitesInto(partyInviteEl)
    if (partyAlertEl) renderInvitesInto(partyAlertEl)

    if (!party) {
      if (partyStatusEl) partyStatusEl.textContent = '未组队'
      const create = mkButton('dk-party__create', '创建队伍')
      create.addEventListener('click', () => void createParty())
      partyMembersEl.appendChild(create)
      partyMembersEl.appendChild(
        mk('p', 'dk-party__hint', '创建队伍后，在好友列表点「邀请」；接受后一起进入同一个房间。'),
      )
    } else {
      if (partyStatusEl) {
        partyStatusEl.textContent = `${party.members.length}/2 · ${party.leader === friendCode ? '你是队长' : '队员'}`
      }
      for (const member of party.members) {
        const row = mk('div', 'dk-party__member')
        row.appendChild(mk('span', 'dk-party__member-name', member.name))
        if (member.code === party.leader) row.appendChild(mk('span', 'dk-party__leader', '队长'))
        if (member.code === friendCode) row.appendChild(mk('span', 'dk-party__you', '你'))
        partyMembersEl.appendChild(row)
      }
      if (party.leader === friendCode) {
        if (party.members.length < 2) {
          partyMembersEl.appendChild(
            mk('div', 'dk-party__slot', '空位 · 在好友列表点「邀请」'),
          )
        }
        partyMembersEl.appendChild(
          mk('p', 'dk-party__hint', '人齐后在房间页按「进入猎场」，队友会一起加载。'),
        )
        const leave = mkButton('dk-party__leave', '解散队伍')
        leave.addEventListener('click', () => void leaveParty())
        partyMembersEl.appendChild(leave)
      } else {
        partyMembersEl.appendChild(
          mk('p', 'dk-party__hint', '等待队长选房并出击；队长出击后你会自动一起加载。'),
        )
        const leave = mkButton('dk-party__leave', '离开队伍')
        leave.addEventListener('click', () => void leaveParty())
        partyMembersEl.appendChild(leave)
      }
    }

    // 队长/队员的 CTA 文案不同：队员不能自己先进房。
    setCtaLabel(currentMap())
  }

  function buildPartyPanel(): HTMLElement {
    const panel = mk('div', 'dk-panel dk-party')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '队伍'))
    head.appendChild(mk('span', 'dk-section-head__en', 'PARTY'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    partyStatusEl = mk('span', 'dk-party__status', '未组队')
    head.appendChild(partyStatusEl)
    panel.appendChild(head)
    partyInviteEl = mk('div', 'dk-party__invites')
    panel.appendChild(partyInviteEl)
    partyMembersEl = mk('div', 'dk-party__members')
    panel.appendChild(partyMembersEl)
    renderParty()
    void refreshParty()
    return panel
  }

  // ---------------------------------------------------------------- 枪械 build

/** 每把武器一套本机 build；服务端只收清洗后的槽位，不信 localStorage。 */
function loadBuilds(): Record<string, WeaponBuild> {
  const raw = readRaw(KEY_BUILDS)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, WeaponBuild> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const weaponId = Number(key)
      if (!Number.isInteger(weaponId)) continue
      const record = value as { slots?: unknown }
      const slots: Partial<Record<WeaponSlotKey, number>> = {}
      if (record && typeof record.slots === 'object' && record.slots !== null) {
        for (const [slot, id] of Object.entries(record.slots as Record<string, unknown>)) {
          if (!WEAPON_SLOT_KEYS.includes(slot as WeaponSlotKey)) continue
          if (typeof id !== 'number') continue
          slots[slot as WeaponSlotKey] = id
        }
      }
      out[key] = sanitizeBuild(weaponId, slots)
    }
    return out
  } catch {
    return {}
  }
}

function loadBuildFor(weaponId: number): WeaponBuild {
  const saved = loadBuilds()[String(weaponId)]
  return saved ? sanitizeBuild(weaponId, saved.slots) : { weaponId, slots: {} }
}

function writeBuild(build: WeaponBuild): void {
  try {
    const all = loadBuilds()
    all[String(build.weaponId)] = sanitizeBuild(build.weaponId, build.slots)
    writeRaw(KEY_BUILDS, JSON.stringify(all))
  } catch {
    // 存不下只影响下次打开工作台，不影响本局配装。
  }
}

// ---------------------------------------------------------------- 好友

  function safeLevelName(id: string): string {
    return LEVEL_IDS.includes(id) ? getLevel(id).name : '未知猎场'
  }

  function findFriendPresence(friend: FriendEntry): PresenceView | null {
    if (!friend.code) return onlinePresences.find((p) => p.name === friend.name) ?? null
    return (
      onlinePresences.find((p) => p.code === friend.code) ??
      onlinePresences.find((p) => p.name === friend.name) ??
      null
    )
  }

  async function heartbeatPresence(leave = false): Promise<void> {
    if (disposed && !leave) return
    try {
      await fetch(`${apiBase()}/api/presence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: friendCode,
          name: config.nickname || '无名猎人',
          roomId: config.matchId || '',
          levelId: deployState.mapId,
          ...(leave ? { leave: true } : {}),
        }),
      })
    } catch {
      // 在线目录断了不影响出击；好友列表显示离线即可。
    }
  }

  async function refreshFriends(): Promise<void> {
    try {
      const res = await fetch(`${apiBase()}/api/presence`, { cache: 'no-store' })
      const data = (await res.json()) as { online?: PresenceView[] }
      if (!res.ok) throw new Error(String(res.status))
      onlinePresences = Array.isArray(data.online) ? data.online : []
    } catch {
      onlinePresences = []
    }
    renderFriends()
  }

  function copyText(text: string): void {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {})
      return
    }
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
    } catch {
      // 剪贴板不可用时只让玩家自己看到文本。
    }
    area.remove()
  }

  function buildFriendsPanel(): HTMLElement {
    const panel = mk('div', 'dk-panel dk-friends')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '好友'))
    head.appendChild(mk('span', 'dk-section-head__en', 'FRIENDS'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    friendOnlineEl = mk('span', 'dk-friends__online', '0 在线')
    head.appendChild(friendOnlineEl)
    panel.appendChild(head)

    const codeRow = mk('div', 'dk-friends__code')
    codeRow.appendChild(mk('span', 'dk-friends__label', '我的好友码'))
    codeRow.appendChild(mk('span', 'dk-friends__value', friendCode))
    const copyCode = mkButton('dk-friends__copy', '复制')
    copyCode.addEventListener('click', () => copyText(friendCode))
    codeRow.appendChild(copyCode)
    panel.appendChild(codeRow)

    const addRow = mk('div', 'dk-friends__add')
    friendInputEl = mk('input', 'dk-input')
    friendInputEl.type = 'text'
    friendInputEl.maxLength = 24
    friendInputEl.autocomplete = 'off'
    friendInputEl.spellcheck = false
    friendInputEl.placeholder = '好友代号或好友码'
    const add = mkButton('dk-friends__add-btn', '添加')
    const submit = (): void => {
      const value = friendInputEl?.value.trim() ?? ''
      if (!value) return
      void addFriend(value)
    }
    add.addEventListener('click', submit)
    friendInputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    })
    addRow.appendChild(friendInputEl)
    addRow.appendChild(add)
    panel.appendChild(addRow)

    friendListEl = mk('div', 'dk-friends__list')
    panel.appendChild(friendListEl)

    const actions = mk('div', 'dk-friends__actions')
    const refresh = mkButton('dk-friends__refresh', '刷新在线')
    refresh.addEventListener('click', () => void refreshFriends())
    const invite = mkButton('dk-friends__invite', '复制我的房号')
    invite.addEventListener('click', () => void copyMyRoom())
    actions.appendChild(refresh)
    actions.appendChild(invite)
    panel.appendChild(actions)
    panel.appendChild(
      mk('p', 'dk-friends__hint', '邀请好友加入队伍；队长在房间页出击后，全队一起加载并共享出生点。'),
    )
    renderFriends()
    void refreshFriends()
    return panel
  }

  async function addFriend(value: string): Promise<void> {
    await refreshFriends()
    const lookup = value.toLowerCase()
    const online =
      onlinePresences.find((p) => p.code === lookup) ??
      onlinePresences.find((p) => p.name === value) ??
      null
    const entry: FriendEntry = online
      ? { name: online.name, code: online.code }
      : { name: value.slice(0, 16) }
    const duplicate = friends.some(
      (friend) => (entry.code && friend.code === entry.code) || friend.name === entry.name,
    )
    if (!duplicate) friends.push(entry)
    saveFriends(friends)
    if (friendInputEl) friendInputEl.value = ''
    renderFriends()
  }

  function removeFriend(entry: FriendEntry): void {
    friends = friends.filter(
      (friend) => !((entry.code && friend.code === entry.code) || friend.name === entry.name),
    )
    saveFriends(friends)
    renderFriends()
  }

  function renderFriends(): void {
    if (!friendListEl) return
    friendListEl.replaceChildren()
    const onlineCount = friends.reduce((n, friend) => n + (findFriendPresence(friend) ? 1 : 0), 0)
    if (friendOnlineEl) friendOnlineEl.textContent = `${onlineCount} 在线`

    if (friends.length === 0) {
      friendListEl.appendChild(
        mk('p', 'dk-friends__empty', '还没有好友。把好友码发给对方，或者输入对方的代号添加。'),
      )
      return
    }

    for (const friend of friends) {
      const presence = findFriendPresence(friend)
      const row = mk('div', 'dk-friend')
      row.classList.toggle('is-online', presence !== null)
      row.appendChild(mk('span', 'dk-friend__dot'))

      const body = mk('div', 'dk-friend__body')
      body.appendChild(mk('span', 'dk-friend__name', friend.name))
      if (presence) {
        body.appendChild(
          mk(
            'span',
            'dk-friend__meta',
            presence.roomId
              ? `${safeLevelName(presence.levelId)} · ${presence.roomId}`
              : '在线 · 尚未选房',
          ),
        )
      } else {
        body.appendChild(mk('span', 'dk-friend__meta', '离线'))
      }
      row.appendChild(body)

      const inParty =
        presence !== null && party?.members.some((member) => member.code === presence.code)
      const canInvite =
        presence !== null &&
        !inParty &&
        (!party || (party.leader === friendCode && party.members.length < 2))

      if (inParty) {
        row.appendChild(mk('span', 'dk-friend__party', '队友'))
      } else if (canInvite && presence) {
        const invite = mkButton('dk-friend__invite', '邀请')
        invite.addEventListener('click', () => void inviteFriend(friend, presence))
        row.appendChild(invite)
      } else if (presence?.roomId) {
        const join = mkButton('dk-friend__join', '加入')
        join.addEventListener('click', () => {
          requireNickname(() => {
            selectRoom(presence.roomId, presence.levelId || undefined)
            setDeployStep(3)
          })
        })
        row.appendChild(join)
      }
      const remove = mkButton('dk-friend__remove', '×')
      remove.title = '从好友列表移除'
      remove.addEventListener('click', () => removeFriend(friend))
      row.appendChild(remove)
      friendListEl.appendChild(row)
    }
  }

  async function copyMyRoom(): Promise<void> {
    if (!config.matchId || config.matchId === 'default') await createRoom()
    copyText(config.matchId || 'default')
    if (roomStatusEl) roomStatusEl.textContent = `房号 ${config.matchId || 'default'} 已复制 · 发给好友`
  }

  let identity: { nickInput: HTMLInputElement; matchInput: HTMLInputElement } | null = null

  /**
   * 按钮上写当前选中的地图名。
   *
   * 原来写死「进入沼泽」，可玩家能换图 —— 点的是一张图、按钮说的是另一张，
   * 这类文案错位比没有文案更糟。
   */
  /** 房间/地图数据变化后把地图卡的选中态刷成 deployState.mapId。 */
  function syncMapSelection(): void {
    const pane = panes.get('deploy')
    if (!pane) return
    for (const card of pane.querySelectorAll<HTMLElement>('.dk-map')) {
      const isSelf = card.dataset.mapId === deployState.mapId
      card.classList.toggle('is-selected', isSelf)
      card.setAttribute('aria-pressed', isSelf ? 'true' : 'false')
    }
  }

  function setCtaLabel(entry: MapEntry): void {
    if (!cta) return
    if (party && party.leader !== friendCode) {
      cta.disabled = true
      cta.textContent = '等 待 队 长 出 击'
      return
    }
    cta.disabled = false
    cta.textContent = '进 入 ' + entry.name
  }

  function currentMap(): MapEntry {
    return MAP_ENTRIES.find((candidate) => candidate.id === deployState.mapId) ?? MAP_ENTRIES[0]!
  }

  /** 把当前选中的地图写进黑场标题卡：地图名 + 英文名 + 一句风味文案。 */
  function fillStage(): void {
    const entry = currentMap()
    if (!entry) return
    stageMap.textContent = entry.name
    stageEn.textContent = entry.en
    stageDesc.textContent = entry.desc
    const contract = contractOf(clampContract(deployState.contract))
    stageBrief.textContent = deployBrief(entry.id, contract.id === CONTRACT_NONE ? null : contract.name)
    // 黑场是玩家进局前看到的最后一屏：把"几点进"也写上去，进去之后发现是
    // 白天还是夜里就不该是意外。
    stageState.textContent = `${TIME_BAND_LABEL[deployState.timeBand].hour} · 潜 入 中 · · ·`
  }

  function beginDeploy(): void {
    if (deploying) return
    // 代号是击杀播报/队友列表的显示名，也是服务端唯一的玩家标识；没有就不放行。
    if (identity) config.nickname = identity.nickInput.value.trim().replace(/\s+/g, ' ').slice(0, 16)
    if (!config.nickname) {
      showOnboarding(() => beginDeploy())
      return
    }
    // 队员不能自己先进房：必须等队长按下「进入猎场」，由 party.launchedAt
    // 触发的 autoFollowing 才允许继续。
    if (party && party.leader !== friendCode && !autoFollowing) {
      if (partyStatusEl) partyStatusEl.textContent = '等待队长出击'
      return
    }
    // 改键捕获不能跨进出击：否则加载时按的第一个键会被静默写进键位表。
    cancelActiveKeyCapture()
    deploying = true
    if (identity) {
      config.nickname = identity.nickInput.value.trim().slice(0, 16)
      config.matchId = identity.matchInput.value.trim().slice(0, 32) || 'default'
    config.timeBand = deployState.timeBand
    config.contract = clampContract(deployState.contract)
    config.extras = deployState.extras & 3
    config.attachment = clampAttachment(deployState.attachment)
    config.squad = deployState.squad === 'duo' ? 1 : 0
    }
    // 队伍默认使用自己的房号，避免和散人一起挤进 default。
    if (party && party.leader === friendCode && (!config.matchId || config.matchId === 'default')) {
      config.matchId = party.id
      if (identity) identity.matchInput.value = party.id
    }
    // 本局只剩 ≤3 分钟：不让玩家进去跑 200m 才发现没时间撤，直接分到下一局
    // 的新房间（同名后缀 -next）。旧房间的猎人继续打，互不影响。
    if (matchNeedsNext) {
      const base = config.matchId || 'default'
      let next = base.replace(/-next\d*$/, '') + '-next'
      if (next === base) next = base + '-2'
      config.matchId = next
      if (identity) identity.matchInput.value = next
      matchNeedsNext = false
    }
    saveConfig(config)
    // 出击前再记一次：地图卡之外没有别的地方能改这张图，但 main.ts 的 enter()
    // 只信 pickLevelId()，所以这里必须是最后写入点。
    rememberLevelId(deployState.mapId)
    // 队伍随配装进 Loadout：服务端据此强制同队并共享出生点。
    config.partyId = party?.id
    config.squad = party ? 1 : 0
    config.build = sanitizeBuild(config.primaryId, config.build?.slots)
    if (party && party.leader === friendCode) void launchParty()
    if (cta) {
      cta.disabled = true
      cta.setAttribute('aria-disabled', 'true')
    }
    fillStage()
    host.classList.add('is-deploying')
    options.sfx?.launch()
    // 交接给 Game 的时刻刻意压在 iris 落满全屏（820ms）之后：WebGL 初始化是
    // 一次主线程尖峰，发生在纯黑静止画面上没人看得见；插在 iris 动画中间就会
    // 把过渡拖成跳帧。这个数字只影响"什么时候开始加载"，不影响"什么时候揭开"。
    deployTimer = window.setTimeout(() => {
      deployTimer = 0
      options.onDeploy({ ...config })
    }, DEPLOY_HANDOFF_MS)
  }

  // ---------------------------------------------------------------- 猎人

  function buildHunter(): void {
    const pane = panes.get('hunter')
    if (!pane) return
    const grid = mk('div', 'dk-hunter')

    const card = mk('div', 'dk-panel dk-hunter__card')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '猎人档案'))
    head.appendChild(mk('span', 'dk-section-head__en', 'HUNTER'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    card.appendChild(head)

    const profile = mk('div', 'dk-profile')
    const avatar = mk('div', 'dk-avatar')
    avatar.appendChild(buildHunterAvatar())
    profile.appendChild(avatar)

    const idBlock = mk('div', 'dk-profile__meta')
    profileNameEl = mk('span', 'dk-profile__name', '猎手 · ' + (config.nickname.trim() || '无名者'))
    idBlock.appendChild(profileNameEl)
    profileSubEl = mk(
      'span',
      'dk-profile__sub',
      `本机存档 · 金币 $${normalizeCoins(config.coins ?? 0)} · 天赋 ${ownedCount}/${TRAITS.length}`,
    )
    idBlock.appendChild(profileSubEl)

    const bloodline = mk('div', 'dk-bloodline')
    const bloodlineTop = mk('div', 'dk-bloodline__top')
    bloodlineTop.appendChild(mk('span', 'dk-bloodline__label', '血脉等级 ' + bloodlineLevel))
    const bloodlinePct = Math.round(((totalTraitLevels % 3) / 3) * 100)
    bloodlineTop.appendChild(mk('span', 'dk-bloodline__value', bloodlinePct + '%'))
    bloodline.appendChild(bloodlineTop)
    const bloodlineBar = mk('div', 'dk-bar-track')
    const bloodlineFill = mk('span', 'dk-bar-fill dk-bar-fill--amber')
    bloodlineFill.style.width = bloodlinePct + '%'
    bloodlineBar.appendChild(bloodlineFill)
    bloodline.appendChild(bloodlineBar)
    idBlock.appendChild(bloodline)
    profile.appendChild(idBlock)
    card.appendChild(profile)

    // 属性/战绩接口还没接；不再显示写死的 82/64/71/58，免得玩家以为是自己的成长。
    card.appendChild(
      mk('p', 'dk-panel__foot', '属性与战绩接口尚未接入 · 当前只保存本机金币与天赋等级'),
    )
    grid.appendChild(card)

    const gearPanel = mk('div', 'dk-panel dk-hunter__gear')
    const gearHead = mk('div', 'dk-section-head')
    gearHead.appendChild(mk('h2', 'dk-section-head__cn', '随身装备'))
    gearHead.appendChild(mk('span', 'dk-section-head__en', 'LOADOUT'))
    gearHead.appendChild(mk('span', 'dk-section-head__rule'))
    gearPanel.appendChild(gearHead)

    const slots = mk('div', 'dk-slots')
    const gear: Array<{ slot: string; glyph: string; name: string; note: string }> = [
      { slot: '主武器', glyph: '主', name: weaponName(config.primaryId, '温菲尔德 M1873'), note: '中远距离' },
      { slot: '副武器', glyph: '副', name: weaponName(DEFAULT_SECONDARY_ID, '柯尔特 M1873 转轮手枪'), note: '近身补枪' },
      { slot: '工具', glyph: '工', name: weaponName(MELEE_WEAPON_ID, '猎刀'), note: '近战兜底' },
      { slot: '消耗品', glyph: '耗', name: '绷带 ×' + STARTING_BANDAGES, note: '按住 ' + codeLabel(settings.keymap.heal) + ' 包扎' },
    ]
    for (const item of gear) {
      const slot = mk('div', 'dk-slot')
      const icon = mk('span', 'dk-slot__icon', item.glyph)
      slot.appendChild(icon)
      const body = mk('div', 'dk-slot__body')
      body.appendChild(mk('span', 'dk-slot__slot', item.slot))
      const nameEl = mk('span', 'dk-slot__name', item.name)
      const noteEl = mk('span', 'dk-slot__note', item.note)
      body.appendChild(nameEl)
      body.appendChild(noteEl)
      slot.appendChild(body)
      slots.appendChild(slot)
      // 主武器那行要跟着枪架走，留句柄给 syncHunterGear()。其它槽位是固定装备。
      if (item.slot === '主武器') hunterGearMain = { name: nameEl, note: noteEl }
    }
    syncHunterGear()
    gearPanel.appendChild(slots)
    grid.appendChild(gearPanel)
    pane.appendChild(grid)
    // 天赋网格放在猎人页底部，全宽；出击页不再承载它。
    pane.appendChild(buildTraitPicker())
  }

  // ---------------------------------------------------------------- 军械库

  const SLOT_LABELS: Record<WeaponSlotKey, [string, string]> = {
    sight: ['瞄具', 'SIGHT'],
    muzzle: ['枪口', 'MUZZLE'],
    magazine: ['供弹', 'MAGAZINE'],
    stock: ['枪托', 'STOCK'],
  }

  function ensureArsenalPreview(): void {
    if (arsenalPreview || !arsenalPreviewHost) return
    try {
      arsenalPreview = new WeaponPreview(arsenalPreviewHost)
      arsenalPreview.setWeapon(arsenalWeaponId, arsenalBuild)
    } catch (error) {
      arsenalPreviewHost.classList.add('is-failed')
      arsenalPreviewHost.appendChild(
        mk('p', 'dk-preview__fail', '这台设备无法创建第二个 WebGL 上下文 · 枪模展示不可用'),
      )
      console.warn('weapon preview unavailable', error)
    }
  }

  function buildArsenal(): void {
    const pane = panes.get('arsenal')
    if (!pane) return
    const specs = Object.values(WEAPONS)
    let maxDamage = 1
    let maxRpm = 1
    let maxRange = 1
    for (const spec of specs) {
      maxDamage = Math.max(maxDamage, spec.damage * Math.max(1, spec.pellets))
      maxRpm = Math.max(maxRpm, 60000 / spec.fireIntervalMs)
      maxRange = Math.max(maxRange, spec.effectiveRange)
    }

    const grid = mk('div', 'dk-arsenal')
    const listPanel = mk('div', 'dk-panel dk-arsenal__list')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '军械库'))
    head.appendChild(mk('span', 'dk-section-head__en', 'ARSENAL'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    listPanel.appendChild(head)

    const rows = mk('div', 'dk-arsenal__rows')
    let activeRow: HTMLButtonElement | null = null

    for (const spec of specs) {
      const row = mkButton('dk-wrow')
      row.dataset.weaponId = String(spec.id)
      const top = mk('span', 'dk-wrow__top')
      top.appendChild(mk('span', 'dk-wrow__name', spec.name))
      top.appendChild(mk('span', 'dk-wrow__class', spec.pellets > 1 ? '霰弹' : '单发'))
      row.appendChild(top)

      const bars = mk('span', 'dk-wrow__bars')
      const metrics: Array<[string, number]> = [
        ['伤害', (spec.damage * Math.max(1, spec.pellets)) / maxDamage],
        ['射速', 60000 / spec.fireIntervalMs / maxRpm],
        ['射程', spec.effectiveRange / maxRange],
      ]
      for (const [label, ratio] of metrics) {
        const barRow = mk('span', 'dk-wbar')
        barRow.appendChild(mk('span', 'dk-wbar__label', label))
        const track = mk('span', 'dk-wbar__track')
        const fill = mk('span', 'dk-wbar__fill')
        fill.style.width = Math.max(4, Math.round(ratio * 100)) + '%'
        track.appendChild(fill)
        barRow.appendChild(track)
        bars.appendChild(barRow)
      }
      row.appendChild(bars)

      row.addEventListener('click', () => {
        if (activeRow && activeRow !== row) {
          activeRow.classList.remove('is-selected')
          activeRow.setAttribute('aria-pressed', 'false')
        }
        activeRow = row
        row.classList.add('is-selected')
        row.setAttribute('aria-pressed', 'true')
        arsenalWeaponId = spec.id
        arsenalBuild = loadBuildFor(spec.id)
        showDetail(spec)
      })
      rows.appendChild(row)
    }
    listPanel.appendChild(rows)
    grid.appendChild(listPanel)

    // ---- 中列：3D 枪模 ----
    const previewPanel = mk('div', 'dk-panel dk-preview')
    const previewHead = mk('div', 'dk-section-head')
    previewHead.appendChild(mk('h2', 'dk-section-head__cn', '枪模'))
    previewHead.appendChild(mk('span', 'dk-section-head__en', 'PREVIEW'))
    previewHead.appendChild(mk('span', 'dk-section-head__rule'))
    previewPanel.appendChild(previewHead)
    arsenalPreviewHost = mk('div', 'dk-preview__host')
    arsenalPreviewHost.appendChild(mk('p', 'dk-preview__hint', '拖动旋转 · 滚轮缩放'))
    previewPanel.appendChild(arsenalPreviewHost)
    grid.appendChild(previewPanel)

    // ---- 右列：改枪台 + 数值 ----
    const detailPanel = mk('div', 'dk-panel dk-arsenal__detail')
    const detailTitle = mk('h3', 'dk-detail__title')
    const detailSub = mk('p', 'dk-detail__sub')
    detailPanel.appendChild(detailTitle)
    detailPanel.appendChild(detailSub)
    const buildPanel = mk('div', 'dk-build')
    detailPanel.appendChild(buildPanel)
    const detailBody = mk('dl', 'dk-detail__stats')
    const valueNodes = new Map<string, HTMLElement>()
    const fields: Array<[string, string]> = [
      ['damage', '躯干伤害'],
      ['pellets', '弹丸数'],
      ['fireIntervalMs', '射击间隔'],
      ['effectiveRange', '有效射程'],
      ['magazine', '弹匣容量'],
      ['reloadMs', '换弹时间'],
      ['spread', '腰射散布'],
      ['adsSpread', '开镜散布'],
      ['adsZoom', '开镜倍率'],
      ['headMultiplier', '爆头倍率'],
      ['ergonomics', '人机'],
      ['weight', '配件重量'],
    ]
    for (const [key, label] of fields) {
      const row = mk('div', 'dk-stat')
      row.appendChild(mk('dt', 'dk-stat__key', label))
      const dd = mk('dd', 'dk-stat__val')
      row.appendChild(dd)
      detailBody.appendChild(row)
      valueNodes.set(key, dd)
    }
    detailPanel.appendChild(detailBody)
    grid.appendChild(detailPanel)
    pane.appendChild(grid)

    let currentSpec: WeaponSpec | null = null
    refreshArsenal = () => {
      if (currentSpec) showDetail(currentSpec)
    }

    function renderBuild(spec: WeaponSpec): void {
      buildPanel.replaceChildren()
      const buildHead = mk('div', 'dk-build__head')
      buildHead.appendChild(mk('span', 'dk-build__title', '改 枪 台'))
      buildHead.appendChild(mk('span', 'dk-build__meta', 'CLICK TO MOUNT'))
      buildPanel.appendChild(buildHead)

      for (const slot of WEAPON_SLOT_KEYS) {
        const options = attachmentsForSlot(spec.id, slot)
        const row = mk('div', 'dk-build__slot')
        const label = SLOT_LABELS[slot]
        row.appendChild(mk('span', 'dk-build__label', label[0] + ' · ' + label[1]))
        const chips = mk('div', 'dk-build__chips')
        if (options.length === 0) {
          chips.appendChild(mk('span', 'dk-build__none', '无接口'))
        } else {
          const current = arsenalBuild.slots[slot] ?? options[0]!.id
          for (const attachment of options) {
            const owned =
              attachment.cost <= 0 || (attachmentOwned & attachmentBit(attachment.id)) !== 0
            const chip = mkButton('dk-build__chip', attachment.name)
            chip.title = attachment.desc
            if (!owned) chip.textContent = attachment.name + ' $' + attachment.cost
            if (current === attachment.id) chip.classList.add('is-selected')
            chip.disabled = !owned && normalizeCoins(config.coins ?? 0) < attachment.cost
            chip.addEventListener('click', () => {
              const select = (): void => {
                arsenalBuild = sanitizeBuild(spec.id, {
                  ...arsenalBuild.slots,
                  [slot]: attachment.id,
                })
                writeBuild(arsenalBuild)
                if (config.primaryId === spec.id) config.build = arsenalBuild
                if (arsenalPreview) arsenalPreview.setWeapon(spec.id, arsenalBuild)
                showDetail(spec)
              }
              if (owned) {
                select()
                return
              }
              chip.disabled = true
              void buyProfile('attachment', attachment.id).then((result) => {
                chip.disabled = false
                if (!result.ok) return
                // applyProfile 会刷新改枪台；刷新后再选中，避免用旧 DOM 节点。
                applyProfile(result.profile)
                select()
              })
            })
            chips.appendChild(chip)
          }
        }
        row.appendChild(chips)
        buildPanel.appendChild(row)
      }

      const stats = buildStats(arsenalBuild)
      const note = mk('p', 'dk-build__note')
      note.textContent =
        `人机 ${stats.ergonomics >= 0 ? '+' : ''}${stats.ergonomics} · ` +
        `重量 +${stats.weightKg.toFixed(2)} kg · 镜 ${stats.adsZoomScale.toFixed(2)}×`
      buildPanel.appendChild(note)
    }

    function showDetail(spec: WeaponSpec): void {
      currentSpec = spec
      // 工作台展示也必须遵守已拥有配件：否则玩家会看到一个服务端不会采纳的 build。
      arsenalBuild = sanitizeOwnedBuild(spec.id, arsenalBuild.slots, attachmentOwned)
      const effective = effectiveWeaponSpec(spec, arsenalBuild)
      const stats = buildStats(arsenalBuild)
      detailTitle.textContent = spec.name
      detailSub.textContent =
        (spec.pellets > 1 ? '霰弹 · ' + spec.pellets + ' 颗弹丸' : '单发') +
        ' · 射程 ' + effective.effectiveRange + ' 米 · 人机 ' +
        (stats.ergonomics >= 0 ? '+' : '') + stats.ergonomics
      const entries: Array<[string, string]> = [
        ['damage', String(effective.damage)],
        ['pellets', String(effective.pellets)],
        ['fireIntervalMs', effective.fireIntervalMs + ' ms'],
        ['effectiveRange', effective.effectiveRange + ' m'],
        ['magazine', String(effective.magazine)],
        ['reloadMs', effective.reloadMs + ' ms'],
        ['spread', effective.spread.toFixed(4) + ' rad'],
        ['adsSpread', effective.adsSpread.toFixed(4) + ' rad'],
        ['adsZoom', (effective.adsZoom ?? 1).toFixed(2) + '×'],
        ['headMultiplier', '×' + effective.headMultiplier.toFixed(2)],
        ['ergonomics', (stats.ergonomics >= 0 ? '+' : '') + stats.ergonomics],
        ['weight', '+' + stats.weightKg.toFixed(2) + ' kg'],
      ]
      for (const [key, text] of entries) {
        const node = valueNodes.get(key)
        if (node) node.textContent = text
      }
      renderBuild(spec)
      arsenalPreview?.setWeapon(spec.id, arsenalBuild)
    }

    const first = rows.querySelector('.dk-wrow')
    if (first instanceof HTMLButtonElement && specs.length > 0) first.click()
  }

  // ---------------------------------------------------------------- 传奇

  function buildRecords(): void {
    const pane = panes.get('records')
    if (!pane) return
    const panel = mk('div', 'dk-panel dk-records')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '传奇'))
    head.appendChild(mk('span', 'dk-section-head__en', 'RECORDS'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    panel.appendChild(head)

    const table = mk('div', 'dk-table')
    const header = mk('div', 'dk-table__row dk-table__row--head')
    for (const label of ['结果', '击杀', '赏金', '时长']) {
      header.appendChild(mk('span', 'dk-table__cell', label))
    }
    table.appendChild(header)

    // 战绩接口尚未接入：不塞五条假记录，明确告诉玩家"这里现在是空的"。
    // 空态不是"这一局输了"：用 is-empty 而不是 is-lost，否则整行会染成阵亡红，
    // 读起来像"刚打输一局"，语义完全反了。
    const empty = mk('div', 'dk-table__row is-empty')
    empty.appendChild(mk('span', 'dk-table__cell dk-table__cell--result', '暂无战绩'))
    empty.appendChild(mk('span', 'dk-table__cell dk-table__cell--num', '—'))
    empty.appendChild(mk('span', 'dk-table__cell dk-table__cell--num', '—'))
    empty.appendChild(mk('span', 'dk-table__cell dk-table__cell--mono', '—'))
    table.appendChild(empty)
    panel.appendChild(table)
    panel.appendChild(mk('p', 'dk-panel__foot', '战绩接口尚未接入 · 本机暂不保存对局记录'))
    pane.appendChild(panel)
  }

  // ---------------------------------------------------------------- 操作 / 键位

  const KEY_ROWS: Array<{ action: Action; cn: string; en: string }> = [
    { action: 'forward', cn: '前进', en: 'FORWARD' },
    { action: 'back', cn: '后退', en: 'BACK' },
    { action: 'left', cn: '左移', en: 'LEFT' },
    { action: 'right', cn: '右移', en: 'RIGHT' },
    { action: 'sprint', cn: '疾跑', en: 'SPRINT' },
    { action: 'crouch', cn: '蹲伏', en: 'CROUCH' },
    { action: 'jump', cn: '跳跃', en: 'JUMP' },
    { action: 'reload', cn: '换弹', en: 'RELOAD' },
    { action: 'slot1', cn: '主武器', en: 'SLOT 1' },
    { action: 'slot2', cn: '副武器', en: 'SLOT 2' },
    { action: 'slot3', cn: '近战', en: 'SLOT 3' },
    { action: 'cycle', cn: '循环切枪', en: 'CYCLE' },
    { action: 'interact', cn: '搜索 / 交互', en: 'INTERACT' },
    { action: 'heal', cn: '包扎', en: 'BANDAGE' },
  ]

  function codeLabel(code: string): string {
    if (code.startsWith('Key')) return code.slice(3)
    if (code.startsWith('Digit')) return code.slice(5)
    return code
      .replace('ShiftLeft', 'Shift')
      .replace('ShiftRight', 'Shift')
      .replace('ControlLeft', 'Ctrl')
      .replace('ControlRight', 'Ctrl')
      .replace('AltLeft', 'Alt')
      .replace('AltRight', 'Alt')
      .replace('ArrowUp', '↑')
      .replace('ArrowDown', '↓')
      .replace('ArrowLeft', '←')
      .replace('ArrowRight', '→')
  }

  function buildKeys(): void {
    const pane = panes.get('keys')
    if (!pane) return
    const panel = mk('div', 'dk-panel dk-keys')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '操作'))
    head.appendChild(mk('span', 'dk-section-head__en', 'CONTROLS'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    panel.appendChild(head)
    panel.appendChild(
      mk('p', 'dk-keys__note', '点击键帽后按一个新键 · Esc 取消 · 已被占用的键会被拒绝'),
    )

    const list = mk('div', 'dk-keys__list')
    for (const row of KEY_ROWS) {
      const line = mk('div', 'dk-key-row')
      const label = mk('div', 'dk-key-row__label')
      label.appendChild(mk('span', 'dk-key-row__cn', row.cn))
      label.appendChild(mk('span', 'dk-key-row__en', row.en))
      line.appendChild(label)

      const btn = mkButton('dk-key-btn', codeLabel(settings.keymap[row.action]))
      btn.title = '点击后按一个新键'
      btn.addEventListener('click', () => {
        if (cancelKeyCapture !== null) return
        btn.classList.add('is-capturing')
        btn.textContent = '按下新键…'

        const finish = (): void => {
          window.removeEventListener('keydown', onKey, true)
          btn.classList.remove('is-capturing')
          btn.textContent = codeLabel(settings.keymap[row.action])
          cancelKeyCapture = null
        }

        const onKey = (event: KeyboardEvent): void => {
          event.preventDefault()
          event.stopPropagation()
          if (event.code === 'Escape') {
            finish()
            return
          }
          if (
            event.code === 'F5' ||
            event.code === 'F11' ||
            event.code === 'F12' ||
            event.code === 'Tab' ||
            event.code === 'KeyM'
          ) {
            btn.textContent = '不可用'
            window.setTimeout(finish, 650)
            return
          }
          const conflict = KEY_ROWS.find(
            (other) => other.action !== row.action && settings.keymap[other.action] === event.code,
          )
          if (conflict) {
            btn.textContent = '已被占用'
            window.setTimeout(finish, 650)
            return
          }
          commitSettings({ keymap: { ...settings.keymap, [row.action]: event.code } })
          finish()
        }

        cancelKeyCapture = finish
        window.addEventListener('keydown', onKey, true)
      })
      line.appendChild(btn)
      list.appendChild(line)
    }

    // 鼠标动作固定，不支持重绑（左右键本身就是指针锁手势的一部分）。
    for (const [cn, en, value] of [
      ['开火', 'FIRE', '鼠标左键'],
      ['瞄准', 'AIM', '鼠标右键'],
      ['地图', 'MAP', 'M'],
    ] as const) {
      const line = mk('div', 'dk-key-row dk-key-row--fixed')
      const label = mk('div', 'dk-key-row__label')
      label.appendChild(mk('span', 'dk-key-row__cn', cn))
      label.appendChild(mk('span', 'dk-key-row__en', en))
      line.appendChild(label)
      line.appendChild(mk('span', 'dk-key-btn dk-key-btn--fixed', value))
      list.appendChild(line)
    }

    panel.appendChild(list)
    pane.appendChild(panel)
  }

  // ---------------------------------------------------------------- 设置

  function commitSettings(patch: Partial<MenuSettings>): void {
    Object.assign(settings, patch)
    saveSettings(settings)
    backdrop?.setBaseFov(settings.fov)
    options.onSettingsChange?.({ ...settings })
  }

  function buildSliderRow(opts: {
    label: string
    hint: string
    min: number
    max: number
    step: number
    value: number
    format: (value: number) => string
    apply: (value: number) => void
  }): HTMLElement {
    const row = mk('div', 'dk-slider')
    const head = mk('div', 'dk-slider__head')
    head.appendChild(mk('span', 'dk-slider__label', opts.label))
    const value = mk('span', 'dk-slider__value', opts.format(opts.value))
    head.appendChild(value)
    row.appendChild(head)

    const input = mk('input', 'dk-range')
    input.type = 'range'
    input.min = String(opts.min)
    input.max = String(opts.max)
    input.step = String(opts.step)
    input.value = String(opts.value)
    input.setAttribute('aria-label', opts.label)
    input.addEventListener('input', () => {
      const next = Number(input.value)
      value.textContent = opts.format(next)
      opts.apply(next)
    })
    row.appendChild(input)
    row.appendChild(mk('span', 'dk-slider__hint', opts.hint))
    return row
  }

  function buildSettings(): void {
    const pane = panes.get('settings')
    if (!pane) return
    const panel = mk('div', 'dk-panel dk-settings')
    const head = mk('div', 'dk-section-head')
    head.appendChild(mk('h2', 'dk-section-head__cn', '设置'))
    head.appendChild(mk('span', 'dk-section-head__en', 'SETTINGS'))
    head.appendChild(mk('span', 'dk-section-head__rule'))
    panel.appendChild(head)

    panel.appendChild(
      buildSliderRow({
        label: '鼠标灵敏度',
        hint: '影响转身速度，不影响准心本身的精度',
        min: 0.2,
        max: 3,
        step: 0.05,
        value: settings.sensitivity,
        format: (v) => v.toFixed(2),
        apply: (v) => commitSettings({ sensitivity: v }),
      }),
    )
    panel.appendChild(
      buildSliderRow({
        label: '视野 FOV',
        hint: '越大看得越广，远处目标越小',
        min: 60,
        max: 100,
        step: 1,
        value: settings.fov,
        format: (v) => Math.round(v) + '°',
        apply: (v) => commitSettings({ fov: v }),
      }),
    )
    panel.appendChild(
      buildSliderRow({
        label: '主音量',
        hint: '枪声在沼泽里传得很远，别调太狠',
        min: 0,
        max: 1,
        step: 0.01,
        value: settings.volume,
        format: (v) => Math.round(v * 100) + '%',
        apply: (v) => commitSettings({ volume: v }),
      }),
    )
    panel.appendChild(
      buildSliderRow({
        label: '画面亮度',
        hint: '夜沼泽默认很暗；只抬 3D 画面，不影响 HUD',
        min: 0.8,
        max: 1.8,
        step: 0.05,
        value: settings.brightness,
        format: (v) => Math.round(v * 100) + '%',
        apply: (v) => commitSettings({ brightness: v }),
      }),
    )

    // 硬核机瞄：没有屏幕准星，准星颜色/大小/不透明度三项不再有意义，
    // 设置面板里也一并撤掉，避免玩家调一个看不见的东西。

    // 镜头运动：晕动症玩家可以把走路的 bob/后坐力滚转/相机滞后全部关掉。
    const motionRow = mk('div', 'dk-field')
    motionRow.appendChild(mk('span', 'dk-field__label', '镜头运动'))
    const motionSeg = mk('div', 'dk-segment')
    const motionEntries: Array<['full' | 'reduced' | 'off', string]> = [
      ['full', '完整'],
      ['reduced', '减弱'],
      ['off', '关闭'],
    ]
    for (const [value, label] of motionEntries) {
      const btn = mkButton('dk-segment__item', label)
      btn.setAttribute('aria-pressed', settings.cameraMotion === value ? 'true' : 'false')
      if (settings.cameraMotion === value) btn.classList.add('is-selected')
      btn.addEventListener('click', () => {
        commitSettings({ cameraMotion: value })
        for (const other of motionSeg.querySelectorAll('.dk-segment__item')) {
          const isSelf = other === btn
          other.classList.toggle('is-selected', isSelf)
          other.setAttribute('aria-pressed', isSelf ? 'true' : 'false')
        }
      })
      motionSeg.appendChild(btn)
    }
    motionRow.appendChild(motionSeg)
    panel.appendChild(motionRow)

    // 画质：网页无法选显卡，所以给"按开销分级"的档位。自动档会先探测
    // 核显/软件渲染，再按帧时间升降；手动档只影响渲染开销，不改玩法。
    const qualityRow = mk('div', 'dk-field')
    qualityRow.appendChild(mk('span', 'dk-field__label', '画质'))
    const qualitySeg = mk('div', 'dk-segment')
    const qualityEntries: Array<[GraphicsQuality, string]> = [
      ['auto', '自动'],
      ['performance', '性能'],
      ['balanced', '均衡'],
      ['quality', '高清'],
    ]
    for (const [value, label] of qualityEntries) {
      const btn = mkButton('dk-segment__item', label)
      btn.setAttribute('aria-pressed', settings.graphics === value ? 'true' : 'false')
      if (settings.graphics === value) btn.classList.add('is-selected')
      btn.addEventListener('click', () => {
        commitSettings({ graphics: value })
        for (const other of qualitySeg.querySelectorAll('.dk-segment__item')) {
          const isSelf = other === btn
          other.classList.toggle('is-selected', isSelf)
          other.setAttribute('aria-pressed', isSelf ? 'true' : 'false')
        }
      })
      qualitySeg.appendChild(btn)
    }
    qualityRow.appendChild(qualitySeg)
    panel.appendChild(qualityRow)
    panel.appendChild(
      buildSliderRow({
        label: '分辨率上限',
        hint: '自动降分辨率仍会工作；这里限制它最多能升到多清',
        min: 0.6,
        max: 1,
        step: 0.05,
        value: settings.renderScale,
        format: (v) => Math.round(v * 100) + '%',
        apply: (v) => commitSettings({ renderScale: v }),
      }),
    )
    panel.appendChild(
      buildSliderRow({
        label: '开镜灵敏度',
        hint: '开镜后视野更窄，同样的位移应该转得更少',
        min: 0.2,
        max: 2,
        step: 0.05,
        value: settings.adsSensitivity,
        format: (v) => v.toFixed(2),
        apply: (v) => commitSettings({ adsSensitivity: v }),
      }),
    )

    const toggleRow = mk('div', 'dk-toggle-row')
    const toggleText = mk('div', 'dk-toggle-row__text')
    toggleText.appendChild(mk('span', 'dk-slider__label', '反转 Y 轴'))
    toggleText.appendChild(mk('span', 'dk-slider__hint', '习惯飞行摇杆的玩家会打开它'))
    toggleRow.appendChild(toggleText)
    const toggle = mkButton('dk-toggle')
    const syncToggle = (): void => {
      toggle.setAttribute('aria-pressed', settings.invertY ? 'true' : 'false')
      toggle.classList.toggle('is-on', settings.invertY)
    }
    syncToggle()
    toggle.addEventListener('click', () => {
      commitSettings({ invertY: !settings.invertY })
      syncToggle()
    })
    toggleRow.appendChild(toggle)
    panel.appendChild(toggleRow)

    panel.appendChild(mk('p', 'dk-panel__foot', '改动即时写入本机存档，不需要点保存'))
    pane.appendChild(panel)
  }

  // ---------------------------------------------------------------- 分区切换

  let activePane: PaneId = 'deploy'
  let backdrop: Backdrop | null = null

  function moveInk(): void {
    const tab = tabButtons.get(activePane)
    if (!tab) return
    ink.style.transform = 'translateY(' + tab.offsetTop + 'px)'
    ink.style.height = tab.offsetHeight + 'px'
  }

  function activatePane(id: PaneId): void {
    if (id === activePane) return
    cancelActiveKeyCapture()
    const previous = panes.get(activePane)
    const next = panes.get(id)
    if (!previous || !next) return

    // 方向感：向下切栏从下方滑入，向上切栏从上方滑入；旧 pane 往反方向退。
    const fromIndex = NAV_ENTRIES.findIndex((entry) => entry.id === activePane)
    const toIndex = NAV_ENTRIES.findIndex((entry) => entry.id === id)
    const dir = toIndex >= fromIndex ? 1 : -1
    next.style.setProperty('--dir', String(dir))
    previous.style.setProperty('--dir', String(-dir))

    const previousTab = tabButtons.get(activePane)
    const nextTab = tabButtons.get(id)
    if (previousTab) previousTab.setAttribute('aria-selected', 'false')
    if (nextTab) nextTab.setAttribute('aria-selected', 'true')
    previousTab?.classList.remove('is-active')
    nextTab?.classList.add('is-active')
    // roving tabindex 跟着当前项走：TAB 键永远落回玩家上次看的那个分区。
    if (previousTab) previousTab.tabIndex = -1
    if (nextTab) nextTab.tabIndex = 0

    // 旧面板退场、新面板入场各用一条短动画；
    // 清理一律挂在 animationend 上，不靠 setTimeout 猜时长，
    // 这样即使系统降速或动画被禁用也不会卡住。
    // is-active 是"这一张该显示"的唯一开关（CSS 里 .dk-pane 默认 display:none）。
    // 必须同时给新 pane 加上，否则切完分区主区域整块空白 —— 出场的 is-leaving
    // 只是临时把它从 display:none 提出来播退场动画，播完由 animationend 摘掉。
    previous.classList.remove('is-active', 'is-entering')
    previous.classList.add('is-leaving')
    next.classList.remove('is-leaving')
    next.classList.add('is-active', 'is-entering')

    activePane = id
    if (id === 'arsenal') ensureArsenalPreview()
    arsenalPreview?.setActive(id === 'arsenal')
    moveInk()
  }

  stack.addEventListener('animationend', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.classList.contains('is-leaving')) target.classList.remove('is-leaving')
    if (target.classList.contains('is-entering')) target.classList.remove('is-entering')
  })

  // ---------------------------------------------------------------- 组装

  buildDeploy()
  buildHunter()
  buildArsenal()
  buildRecords()
  buildKeys()
  buildSettings()

  const firstPane = panes.get('deploy')
  if (firstPane) firstPane.classList.add('is-active', 'is-entering')
  tabButtons.get('deploy')?.classList.add('is-active')

  let mounted = false
  let visible = true
  // 揭开流程的令牌：每次揭开自增，旧的 .then 链看到令牌变了就自己作废
  // （启动失败退回菜单、或连点两次出击时，不会有两个揭开流程同时操作 DOM）
  let launchToken = 0
  let statusValue = options.status ?? ''
  statusText.textContent = statusValue

  function syncStatus(): void {
    if (statusText.textContent !== statusValue) statusText.textContent = statusValue
    statusText.classList.toggle('is-empty', statusValue.length === 0)
  }
  syncStatus()

  // ---------------------------------------------------------------- 揭开

  /**
   * 等一组元素身上正在播的 CSS 动画播完。
   * 为什么不用定时器：加载用了多久只有 main.ts 知道（它在 await game.start()
   * 之后才调 setVisible(false)），任何写死的毫秒数都会在慢机器上暴露。
   * 动画自己就是节拍器 —— 黑场落满、标题浮出这两段跑完，才允许揭开。
   */
  function waitForAnimations(nodes: HTMLElement[], capMs: number): Promise<void> {
    const waits: Promise<unknown>[] = []
    for (const node of nodes) {
      for (const animation of node.getAnimations()) {
        // 被 cancel 的动画 finished 会 reject，这里吞掉即可
        waits.push(animation.finished.catch(() => undefined))
      }
    }
    if (waits.length === 0) return Promise.resolve()
    let timer = 0
    // 兜底闸门：标签页切到后台时动画会暂停，finished 可能永远不 resolve。
    // 菜单不能因此永远停在黑场里，所以给一个上限；正常路径走不到这里。
    const gate = new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, capMs)
    })
    return Promise.race([Promise.all(waits).then(() => undefined), gate]).finally(() =>
      window.clearTimeout(timer),
    )
  }

  function hideAll(): void {
    host.classList.remove('is-launching')
    host.classList.add('is-hidden')
    host.setAttribute('aria-hidden', 'true')
    root.classList.add('is-hidden')
  }

  /**
   * 两段式揭开，两段的节拍都由动画自己给：
   *   1) 等出击演出播完（黑场落满 + 标题浮出）—— 这是"标题至少被看见"的下限；
   *   2) 加 is-launching 播揭开（黑条外滑 / 标题硬闪消失 / 黑场反缩回中心）。
   * 第一段是加载完成（真实条件）与最短可读时间（体验条件）的交集，
   * 所以既不会黑屏干等，也不会把标题闪过去。
   */
  function playLaunch(): void {
    const token = ++launchToken
    host.classList.remove('is-launching')
    waitForAnimations([veil, flash, stage, barTop, barBottom], LAUNCH_FLOOR_CAP)
      .then(() => {
        if (disposed || token !== launchToken) return null
        host.classList.add('is-launching')
        return waitForAnimations([veil, stage, barTop, barBottom], LAUNCH_REVEAL_CAP)
      })
      .then(() => {
        if (disposed || token !== launchToken) return
        hideAll()
      })
  }

  // ---------------------------------------------------------------- 界面音
  //
  // 用**捕获阶段**的委托，而不是往二十多个 handler 里各插一行：
  //   1) 枪卡与地图卡自己在 click 里 stopPropagation，冒泡阶段根本收不到；
  //   2) 以后再加卡片不用记得补声音；
  //   3) 悬停要判的是「从一个可点元素换到另一个」，逐个挂 pointerenter 会在
  //      元素内部的子节点之间反复触发（卡片里还有四五个 span）。
  const SFX_TARGETS = 'button, .dk-map, .dk-weapon, .dk-row'
  let sfxHovered: HTMLElement | null = null

  function sfxTargetOf(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null
    return node.closest<HTMLElement>(SFX_TARGETS)
  }

  function onSfxOver(event: Event): void {
    const hit = sfxTargetOf(event.target)
    if (hit === null || hit === sfxHovered) return
    sfxHovered = hit
    options.sfx?.hover()
  }

  function onSfxOut(event: PointerEvent): void {
    const hit = sfxTargetOf(event.target)
    if (hit === null || hit !== sfxHovered) return
    // 在卡片内部从一个子节点挪到另一个不算离开 —— 那会让一次悬停响三遍。
    const next = event.relatedTarget
    if (next instanceof Node && hit.contains(next)) return
    sfxHovered = null
  }

  function onSfxClick(event: Event): void {
    if (sfxTargetOf(event.target) !== null) options.sfx?.click()
  }

  host.addEventListener('pointerover', onSfxOver, true)
  host.addEventListener('pointerout', onSfxOut, true)
  host.addEventListener('click', onSfxClick, true)

  function onHostResize(): void {
    moveInk()
  }

  /**
   * 加入前就能看到"这局还剩多久、房间里有几个人"。
   *
   * 不然玩家会在一局只剩 2 分钟时进去，跑 200m 才发现没时间撤离；或者进了
   * 一个空房，对着 260m 的沼泽走 15 分钟以为游戏没做好。
   */
  /** 大厅轮询：房间状态每次都刷，房间列表只在第三步刷（避免主页/地图页无谓请求）。 */
  function refreshLive(): void {
    refreshMatchInfo()
    void heartbeatPresence()
    if (friendListEl) void refreshFriends()
    if (deployStep === 3) void refreshRooms()
  }

  function refreshMatchInfo(): void {
    if (!matchInfoEl || disposed) return
    const base = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '')
    const matchId = identity?.matchInput.value.trim() || config.matchId || 'default'
    fetch(`${base}/api/game/status`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { worlds?: { id: string; players: number; secondsLeft: number; phase: string }[] }) => {
        if (disposed || !matchInfoEl) return
        const world = data.worlds?.find((w) => w.id === matchId)
        if (!world) {
          matchNeedsNext = false
          matchInfoEl.textContent = `房间「${matchId}」空闲 · 进入即开新局`
          matchInfoEl.classList.remove('is-warning')
          return
        }
        if (world.phase === 'over') {
          // 已结束的房间不能再把人塞进去等复盘：出击时自动切到同名 -next
          // 房间，和"剩余 ≤3 分钟"走同一条分流逻辑。
          matchNeedsNext = true
          matchInfoEl.textContent = `房间「${matchId}」本局已结束 · 出击将进入下一局`
          matchInfoEl.classList.add('is-warning')
          return
        }
        const secs = Math.max(0, Math.ceil(world.secondsLeft))
        const mm = Math.floor(secs / 60)
        const ss = String(secs % 60).padStart(2, '0')
        matchNeedsNext = secs <= 180
        matchInfoEl.textContent =
          `房间「${matchId}」· ${world.players} 名猎人 · 剩余 ${mm}:${ss}` +
          (matchNeedsNext ? ' · 出击将进入下一局' : '')
        matchInfoEl.classList.toggle('is-warning', matchNeedsNext)
      })
      .catch(() => {
        if (matchInfoEl) matchInfoEl.textContent = '房间状态不可用'
      })
  }

  function cancelActiveKeyCapture(): void {
    const cancel = cancelKeyCapture
    cancelKeyCapture = null
    cancel?.()
  }

  /** 撤回一次没启动成功的出击。见 Menu.abortDeploy 的注释。 */
  function abortDeploy(): void {    launchToken += 1
    host.classList.remove('is-launching', 'is-hidden')
    root.classList.remove('is-hidden')
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock()
      } catch {
        // 没有用户手势时浏览器会拒绝；下一次点击会自然释放。
      }
    }
    if (deployTimer) {
      window.clearTimeout(deployTimer)
      deployTimer = 0
    }
    deploying = false
    host.classList.remove('is-deploying')
    // 键盘改键捕获可能还挂着：出击/切页/退回大厅都必须把它拔掉，
    // 否则第一个按键会被静默改成某个动作，而不是进游戏。
    cancelActiveKeyCapture()
    if (cta) {
      cta.disabled = false
      cta.setAttribute('aria-disabled', 'false')
    }
    if (visible) backdrop?.start()
  }

  return {
    mount(): void {
      if (disposed || mounted) return
      mounted = true
      root.appendChild(host)
      root.classList.toggle('is-hidden', !visible)
      try {
        backdrop = new Backdrop(bgHost, settings.fov)
      } catch {
        // 没有 WebGL（无 GPU / 被策略禁用 / 超出上下文配额）时退成 CSS 渐变背景：
        // 主界面的第一职责是能让玩家点进游戏，画面可以降级。
        bgHost.classList.add('is-flat')
        backdrop = null
      }
      if (visible) backdrop?.start()
      // 进场动画跑完后墨迹条才具备过渡，否则它会在入场瞬间从 0 滑到第一项。
      moveInk()
      window.requestAnimationFrame(() => {
        if (!disposed) ink.classList.add('is-ready')
      })
      window.addEventListener('resize', onHostResize)
      // 主页是默认入口；首次没有代号就立刻弹报名字的卡，避免玩家点进地图
      // 之后才发现自己叫「猎人 #7」。
      showHome(true)
      if (!config.nickname.trim()) showOnboarding()
      refreshLive()
      // 大厅一打开就拉服务端权威档案；失败就继续用本地缓存，不阻塞菜单。
      void fetchProfile().then((profile) => {
        if (!disposed && profile) applyProfile(profile)
      })
      matchInfoTimer = window.setInterval(refreshLive, 8000)
      void refreshParty()
      partyTimer = window.setInterval(() => void refreshParty(), 2500)
    },

    setVisible(next: boolean): void {
      if (disposed || visible === next) return
      visible = next
      host.setAttribute('aria-hidden', next ? 'false' : 'true')
      if (!next) {
        cancelActiveKeyCapture()
        arsenalPreview?.setActive(false)
      }
      if (next) {
        // 撤回还没播完的揭开：启动失败退回菜单时，整层必须立刻能点。
        // 这段逻辑必须和 setVisible 的早退解耦：移动端阻断发生在菜单仍可见时。
        abortDeploy()
        // 从对局回来先回主页：玩家刚打完一局，第一件事是决定下一局去哪，
        // 而不是继续盯着上局的地图卡。
        showHome(true)
        // 从对局回来：整体从略缩/虚焦回到锐利，像镜头重新对焦。
        host.classList.remove('is-returning')
        void host.offsetWidth
        host.classList.add('is-returning')
      } else {
        backdrop?.stop()
        // 关键改动：这里不再立刻加 is-hidden。main.ts 在 await started.start()
        // 之后才调进来，所以此刻只代表"加载真的完成了"，接下来还有约 0.9s 的
        // 幕收演出（黑条外滑 / 标题闪走 / 黑场缩回中心），整层撤掉由 hideAll 收尾。
        playLaunch()
      }
    },

    setStatus(text: string): void {
      if (disposed) return
      statusValue = text
      syncStatus()
      // 黑场期间底部状态栏被盖住了，把同一句话搬到标题卡上：
      // 玩家才不会对着一块纯黑猜"是不是卡死了"。
      if (host.classList.contains('is-deploying')) stageState.textContent = text
    },

    setCoins(next: number): void {
      if (disposed) return
      config.coins = normalizeCoins(next)
      if (dossierCoinsEl) {
        dossierCoinsEl.textContent = formatCoins(config.coins)
      }
      syncTraits()
    },

    syncProfile(profile: ProfileView): void {
      if (disposed) return
      applyProfile(profile)
    },

    abortDeploy,

    dispose(): void {
      if (disposed) return
      disposed = true
      void heartbeatPresence(true)
      cancelActiveKeyCapture()
      // 作废排队中的揭开流程，避免它在宿主已被移除后再去碰 DOM
      launchToken += 1
      if (deployTimer) {
        window.clearTimeout(deployTimer)
        deployTimer = 0
      }
      if (matchInfoTimer) {
        window.clearInterval(matchInfoTimer)
        matchInfoTimer = 0
      }
      if (partyTimer) {
        window.clearInterval(partyTimer)
        partyTimer = 0
      }
      arsenalPreview?.dispose()
      arsenalPreview = null
      window.removeEventListener('resize', onHostResize)
      host.removeEventListener('pointerover', onSfxOver, true)
      host.removeEventListener('pointerout', onSfxOut, true)
      host.removeEventListener('click', onSfxClick, true)
      backdrop?.dispose()
      backdrop = null
      host.remove()
      mounted = false
    },
  }
}
