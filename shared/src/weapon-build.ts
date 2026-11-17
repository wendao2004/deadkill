/**
 * 塔科夫式枪械 build：槽位 → 配件 → 有效属性。
 *
 * 这一层必须是**纯函数 + 纯数据**：客户端拿它画工作台和预测，服务端拿它
 * 算射速/弹匣/换弹/散布。两边读到的是同一份表与同一个组合顺序，否则会出现
 * “工作台显示 +2 弹、服务端按原厂弹匣拒绝换弹”。
 *
 * 首版只开四个槽：sight / muzzle / magazine / stock。没有库存系统：所有配件
 * 金币永久解锁，服务端只校验“槽位兼容 + 无冲突”，不校验拥有。
 */

import { WEAPONS, type WeaponSpec } from './constants.ts'

export type WeaponSlotKey = 'sight' | 'muzzle' | 'magazine' | 'stock'
export const WEAPON_SLOT_KEYS: readonly WeaponSlotKey[] = ['sight', 'muzzle', 'magazine', 'stock']

export const SLOT_CODE: Record<WeaponSlotKey, number> = {
  sight: 1,
  muzzle: 2,
  magazine: 3,
  stock: 4,
}

export function slotFromCode(code: number): WeaponSlotKey | null {
  for (const key of WEAPON_SLOT_KEYS) if (SLOT_CODE[key] === code) return key
  return null
}

/** 接口标签：武器声明自己有什么，配件声明自己要什么。 */
export type MountTag =
  | 'dovetail'
  | 'receiver-rail'
  | 'thread'
  | 'tube-band'
  | 'tube'
  | 'cylinder'
  | 'stock-screw'

export interface AttachmentStats {
  /** 开镜时间乘数。 */
  adsTimeScale: number
  /** 开镜倍率乘数。 */
  adsZoomScale: number
  /** 后坐乘数（视觉/弹道表现共用）。 */
  recoilScale: number
  /** 散布乘数。 */
  spreadScale: number
  /** 换弹时间乘数。 */
  reloadScale: number
  /** 弹匣/弹仓容量加成。 */
  magazineBonus: number
  /** 枪声响度乘数。 */
  loudnessScale: number
  /** 射击间隔乘数。 */
  cycleScale: number
  /** 初速乘数（保留给下一阶段的下坠/穿透）。 */
  velocityScale: number
  /** 人机：正收益，负代价。 */
  ergonomics: number
  /** 重量 kg。 */
  weightKg: number
}

export interface WeaponAttachment {
  id: number
  key: string
  name: string
  slot: WeaponSlotKey
  mounts: MountTag[]
  stats: Partial<AttachmentStats>
  /** 视觉变体：工作台/第一人称模型按它切零件。 */
  model?: 'iron' | 'scope2' | 'scope4' | 'suppressor' | 'brake' | 'extended' | 'quick' | 'heavy' | 'light'
  cost: number
  desc: string
}

export interface WeaponBuild {
  weaponId: number
  slots: Partial<Record<WeaponSlotKey, number>>
}

export interface BuildFlags {
  scope: boolean
  suppressor: boolean
  extendedMagazine: boolean
  heavyStock: boolean
}

const BASE_STATS: AttachmentStats = {
  adsTimeScale: 1,
  adsZoomScale: 1,
  recoilScale: 1,
  spreadScale: 1,
  reloadScale: 1,
  magazineBonus: 0,
  loudnessScale: 1,
  cycleScale: 1,
  velocityScale: 1,
  ergonomics: 0,
  weightKg: 0,
}

/**
 * 武器接口表。只声明接口，不写“哪些武器能用某件配件”的白名单 ——
 * 新增一把枪时只补这一行。
 */
export const WEAPON_MOUNTS: Record<number, Partial<Record<WeaponSlotKey, MountTag[]>>> = {
  1: { sight: ['dovetail'], muzzle: ['thread'], magazine: ['tube'], stock: ['stock-screw'] }, // 温菲尔德
  6: { sight: ['dovetail'], muzzle: ['thread'], magazine: ['tube'], stock: ['stock-screw'] }, // 消音卡宾
  4: { sight: ['dovetail'], muzzle: ['thread'], magazine: ['tube'], stock: ['stock-screw'] }, // 神射手
  2: { sight: ['dovetail'], muzzle: ['tube-band'], magazine: ['tube'], stock: ['stock-screw'] }, // 双管
  3: { sight: ['dovetail'], muzzle: ['tube-band'], magazine: ['tube'], stock: ['stock-screw'] }, // 短双管
  5: { sight: ['dovetail'], magazine: ['cylinder'] }, // 转轮
  10: {}, // 猎刀
}

export const WEAPON_ATTACHMENTS: readonly WeaponAttachment[] = [
  // ---- 瞄具 ----
  {
    id: 100,
    key: 'iron',
    name: '原厂机瞄',
    slot: 'sight',
    mounts: ['dovetail'],
    stats: {},
    model: 'iron',
    cost: 0,
    desc: '没有额外倍率，开镜最快。',
  },
  {
    id: 101,
    key: 'scope2',
    name: '2× 瞄准镜',
    slot: 'sight',
    mounts: ['dovetail'],
    stats: { adsZoomScale: 1.6, adsTimeScale: 1.18, ergonomics: -8, weightKg: 0.12 },
    model: 'scope2',
    cost: 600,
    desc: '中距离更好点；开镜更慢、更重。',
  },
  {
    id: 102,
    key: 'scope4',
    name: '4× 瞄准镜',
    slot: 'sight',
    mounts: ['dovetail'],
    stats: { adsZoomScale: 3.2, adsTimeScale: 1.38, ergonomics: -18, weightKg: 0.26 },
    model: 'scope4',
    cost: 1100,
    desc: '远距离点杀；近战几乎没有视野。',
  },
  // ---- 枪口 ----
  {
    id: 200,
    key: 'muzzle_none',
    name: '原厂枪口',
    slot: 'muzzle',
    mounts: ['thread', 'tube-band'],
    stats: {},
    model: 'brake',
    cost: 0,
    desc: '不改变枪声、后坐与初速。',
  },
  {
    id: 201,
    key: 'suppressor',
    name: '消音器',
    slot: 'muzzle',
    mounts: ['thread'],
    stats: {
      loudnessScale: 0.45,
      cycleScale: 1,
      adsTimeScale: 1.1,
      velocityScale: 0.96,
      weightKg: 0.35,
      ergonomics: -5,
    },
    model: 'suppressor',
    cost: 800,
    desc: '枪声传得更近；更重、开镜更慢、初速略降。',
  },
  {
    id: 202,
    key: 'brake',
    name: '制退器',
    slot: 'muzzle',
    mounts: ['thread', 'tube-band'],
    stats: { recoilScale: 0.86, spreadScale: 0.94, loudnessScale: 1.15, weightKg: 0.18, ergonomics: -3 },
    model: 'brake',
    cost: 450,
    desc: '后坐更小、散布更紧；枪声更响。',
  },
  // ---- 供弹 ----
  {
    id: 300,
    key: 'mag_none',
    name: '原厂供弹',
    slot: 'magazine',
    mounts: ['tube', 'cylinder'],
    stats: {},
    model: 'extended',
    cost: 0,
    desc: '不改变容量与换弹时间。',
  },
  {
    id: 301,
    key: 'extended',
    name: '加长弹仓',
    slot: 'magazine',
    mounts: ['tube', 'cylinder'],
    stats: { magazineBonus: 2, reloadScale: 1.15, weightKg: 0.2, ergonomics: -3 },
    model: 'extended',
    cost: 500,
    desc: '弹匣 +2；换弹更慢、更重。',
  },
  {
    id: 302,
    key: 'quick',
    name: '快装弹仓',
    slot: 'magazine',
    mounts: ['tube', 'cylinder'],
    stats: { magazineBonus: -1, reloadScale: 0.82, weightKg: 0.05, ergonomics: 4 },
    model: 'quick',
    cost: 550,
    desc: '换弹更快、更轻；弹匣 -1。',
  },
  // ---- 枪托 ----
  {
    id: 400,
    key: 'stock_none',
    name: '原厂枪托',
    slot: 'stock',
    mounts: ['stock-screw'],
    stats: {},
    model: 'heavy',
    cost: 0,
    desc: '不改变后坐与人机。',
  },
  {
    id: 401,
    key: 'heavy_stock',
    name: '加固枪托',
    slot: 'stock',
    mounts: ['stock-screw'],
    stats: { recoilScale: 0.82, ergonomics: -8, weightKg: 0.3, adsTimeScale: 1.04 },
    model: 'heavy',
    cost: 400,
    desc: '后坐明显更小；更重、开镜略慢。',
  },
  {
    id: 402,
    key: 'light_stock',
    name: '轻量枪托',
    slot: 'stock',
    mounts: ['stock-screw'],
    stats: { ergonomics: 10, adsTimeScale: 0.92, recoilScale: 1.15, weightKg: 0 },
    model: 'light',
    cost: 520,
    desc: '更轻、开镜更快；后坐更大。',
  },
]

export function attachmentById(id: number): WeaponAttachment | null {
  for (const attachment of WEAPON_ATTACHMENTS) if (attachment.id === id) return attachment
  return null
}

/** 槽位可用的全部配件（第一件永远是“原厂”）。 */
export function attachmentsForSlot(weaponId: number, slot: WeaponSlotKey): WeaponAttachment[] {
  const out: WeaponAttachment[] = []
  for (const attachment of WEAPON_ATTACHMENTS) {
    if (attachment.slot !== slot) continue
    if (!isCompatible(weaponId, attachment)) continue
    out.push(attachment)
  }
  return out
}

export function isCompatible(weaponId: number, attachment: WeaponAttachment): boolean {
  const mounts = WEAPON_MOUNTS[weaponId]?.[attachment.slot]
  if (!mounts) return false
  return attachment.mounts.some((tag) => mounts.includes(tag))
}

/** 清掉缺失/不兼容/未知的槽位；永远返回合法 build。 */
export function sanitizeBuild(weaponId: number, slots: Partial<Record<WeaponSlotKey, number>> | undefined): WeaponBuild {
  const out: WeaponBuild = { weaponId, slots: {} }
  if (!WEAPONS[weaponId] || !slots) return out
  for (const slot of WEAPON_SLOT_KEYS) {
    const id = slots[slot]
    if (!Number.isInteger(id) || !id || id <= 0) continue
    const attachment = attachmentById(id)
    if (!attachment || attachment.slot !== slot) continue
    if (!isCompatible(weaponId, attachment)) continue
    out.slots[slot] = id
  }
  return out
}

/** 当前 build 的视觉开关；第一人称与工作台共用。 */
export function buildFlags(build: WeaponBuild | null | undefined): BuildFlags {
  const slots = build?.slots ?? {}
  const sight = slots.sight ? attachmentById(slots.sight) : null
  const muzzle = slots.muzzle ? attachmentById(slots.muzzle) : null
  const magazine = slots.magazine ? attachmentById(slots.magazine) : null
  const stock = slots.stock ? attachmentById(slots.stock) : null
  return {
    scope: sight?.model === 'scope2' || sight?.model === 'scope4',
    suppressor: muzzle?.model === 'suppressor',
    extendedMagazine: magazine?.model === 'extended',
    heavyStock: stock?.model === 'heavy',
  }
}

/** 组合顺序：先加法，再逐个乘，最后夹硬上限。 */
export function buildStats(build: WeaponBuild | null | undefined): AttachmentStats {
  const stats: AttachmentStats = { ...BASE_STATS }
  if (!build) return stats
  const additive: Partial<AttachmentStats> = {}
  const products: AttachmentStats = { ...BASE_STATS }
  for (const slot of WEAPON_SLOT_KEYS) {
    const id = build.slots[slot]
    const attachment = id ? attachmentById(id) : null
    if (!attachment) continue
    for (const key of Object.keys(attachment.stats) as (keyof AttachmentStats)[]) {
      const value = attachment.stats[key]
      if (value === undefined) continue
      if (key === 'magazineBonus' || key === 'ergonomics' || key === 'weightKg') {
        additive[key] = (additive[key] ?? 0) + value
      } else {
        products[key] *= value
      }
    }
  }
  stats.magazineBonus = clamp(additive.magazineBonus ?? 0, -2, 4)
  stats.ergonomics = clamp(additive.ergonomics ?? 0, -40, 40)
  stats.weightKg = Math.max(0, additive.weightKg ?? 0)
  stats.adsTimeScale = clamp(products.adsTimeScale, 0.7, 1.8)
  stats.adsZoomScale = clamp(products.adsZoomScale, 1, 4)
  stats.recoilScale = clamp(products.recoilScale, 0.55, 1.35)
  stats.spreadScale = clamp(products.spreadScale, 0.6, 1.5)
  stats.reloadScale = clamp(products.reloadScale, 0.65, 1.6)
  stats.loudnessScale = clamp(products.loudnessScale, 0.25, 1.4)
  stats.cycleScale = clamp(products.cycleScale, 0.85, 1.2)
  stats.velocityScale = clamp(products.velocityScale, 0.85, 1.1)
  return stats
}

/** 有效武器数值。返回新对象，绝不改 WEAPONS 里的静态表。 */
export function effectiveWeaponSpec(base: WeaponSpec, build: WeaponBuild | null | undefined): WeaponSpec {
  const stats = buildStats(build)
  return {
    ...base,
    magazine: Math.max(1, base.magazine + stats.magazineBonus),
    reloadMs: Math.round(base.reloadMs * stats.reloadScale),
    spread: base.spread * stats.spreadScale,
    adsSpread: base.adsSpread * stats.spreadScale,
    fireIntervalMs: Math.round(base.fireIntervalMs * stats.cycleScale),
    switchMs: Math.round(base.switchMs * stats.adsTimeScale),
    adsZoom: (base.adsZoom ?? 1) * stats.adsZoomScale,
    loudness: (base.loudness ?? 1) * stats.loudnessScale,
  }
}

/** 协议/存档用的紧凑槽位条目（只保留非 0 槽）。 */
export function buildEntries(build: WeaponBuild | null | undefined): Array<{ slot: WeaponSlotKey; id: number }> {
  if (!build) return []
  const out: Array<{ slot: WeaponSlotKey; id: number }> = []
  for (const slot of WEAPON_SLOT_KEYS) {
    const id = build.slots[slot]
    if (id && id > 0) out.push({ slot, id })
  }
  return out
}

export function buildFromEntries(weaponId: number, entries: Iterable<{ slot: WeaponSlotKey; id: number }>): WeaponBuild {
  const slots: Partial<Record<WeaponSlotKey, number>> = {}
  for (const entry of entries) slots[entry.slot] = entry.id
  return sanitizeBuild(weaponId, slots)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
