/**
 * 猎人的天赋（trait）：一整局都生效的被动，局外在大厅里选、用金币升级。
 *
 * 为什么数字放 shared 而不是各写一份：服务端拿它做判定（刀伤、射速、散布、
 * 减伤、搜刮现金），客户端拿它画图标、算预测与文案。两边各写一份的下场是
 * "大厅写着 +50% 刀伤，实际判定没吃到"，而且没有任何一处代码看得出差别。
 *
 * 存储格式：每条天赋占 **2 bit**（0 = 未装备，1..3 = 等级），打包进一个 u32。
 * 十条天赋正好 20 bit，配装包尾部那 4 个字节既够用也不用再改长度。
 * 位掩码（1 << index）只用来当"身份"：DOM 的 data-trait-bit、存档里的选中项
 * 都用它，和等级分开，免得升一级就等于换了一条天赋。
 */

export const Trait = {
  /** 百臂巨人：近战伤害与挥刀间隔。 */
  HundredHands: 1 << 0,
  /** 左右开工：转轮射速与切枪。 */
  Ambidextrous: 1 << 1,
  /** 快手：搜刮与包扎用时。 */
  QuickHand: 1 << 2,
  /** 硬皮：受到伤害。 */
  Bulwark: 1 << 3,
  /** 铁腕：散布半径。 */
  IronGrip: 1 << 4,
  /** 拾荒者：搜刮现金。 */
  Scavenger: 1 << 5,
  /** 强健：生命上限。 */
  Vigor: 1 << 6,
  /** 处刑者：对残血目标的伤害。 */
  Executioner: 1 << 7,
  /** 铁石心肠：受到怪物的伤害。 */
  Stoic: 1 << 8,
  /** 食腐者：击杀怪物回血。 */
  Carrion: 1 << 9,
} as const

/** 每条天赋的等级上限。三级是"练满一条"与"再多一条"之间的取舍点。 */
export const TRAIT_MAX_LEVEL = 3

export interface TraitSpec {
  /** 身份位（不是数值位）。 */
  bit: number
  /** 在打包值里的槽位（0 起）。必须与 TRAITS 的下标一致。 */
  index: number
  name: string
  /** 英文名：大厅做成小字幕，和武器卡的排版一致。 */
  en: string
  /** 三个等级各自的一句话说明，必须自带数字。 */
  levels: readonly [string, string, string]
}

/**
 * 表顺序 = 大厅的展示顺序，也是"超选时先保留谁"的顺序。
 *
 * 顺序刻意让"能改变交战结果"的天赋排在前面（刀伤、射速、散布、血量），
 * 把"多拿钱"的拾荒者放中间：先手快的人先活着出去，才轮到算钱。
 */
export const TRAITS: readonly TraitSpec[] = [
  {
    bit: Trait.HundredHands,
    index: 0,
    name: '百臂巨人',
    en: 'HUNDRED HANDS',
    levels: ['近战伤害 +15%，挥刀间隔 -10%', '近战伤害 +30%，挥刀间隔 -20%', '近战伤害 +50%，挥刀间隔 -30%'],
  },
  {
    bit: Trait.Ambidextrous,
    index: 1,
    name: '左右开工',
    en: 'AMBIDEXTROUS',
    levels: ['转轮射速 +10%，切枪快 15%', '转轮射速 +20%，切枪快 28%', '转轮射速 +30%，切枪快 40%'],
  },
  {
    bit: Trait.IronGrip,
    index: 2,
    name: '铁腕',
    en: 'IRON GRIP',
    levels: ['所有枪械散布 -10%', '所有枪械散布 -18%', '所有枪械散布 -25%'],
  },
  {
    bit: Trait.Bulwark,
    index: 3,
    name: '硬皮',
    en: 'BULWARK',
    levels: ['受到的伤害 -6%', '受到的伤害 -11%', '受到的伤害 -15%'],
  },
  {
    bit: Trait.Vigor,
    index: 4,
    name: '强健',
    en: 'VIGOR',
    levels: ['生命上限 +20', '生命上限 +35', '生命上限 +50'],
  },
  {
    bit: Trait.Executioner,
    index: 5,
    name: '处刑者',
    en: 'EXECUTIONER',
    levels: ['对生命低于 40% 的目标伤害 +15%', '对生命低于 40% 的目标伤害 +25%', '对生命低于 40% 的目标伤害 +35%'],
  },
  {
    bit: Trait.QuickHand,
    index: 6,
    name: '快手',
    en: 'DEXTERITY',
    levels: ['搜刮与包扎用时 -10%', '搜刮与包扎用时 -20%', '搜刮与包扎用时 -30%'],
  },
  {
    bit: Trait.Stoic,
    index: 7,
    name: '铁石心肠',
    en: 'STOIC',
    levels: ['受到怪物伤害 -12%', '受到怪物伤害 -22%', '受到怪物伤害 -32%'],
  },
  {
    bit: Trait.Carrion,
    index: 8,
    name: '食腐者',
    en: 'CARRION',
    levels: ['击杀怪物回复 8 生命', '击杀怪物回复 14 生命', '击杀怪物回复 20 生命'],
  },
  {
    bit: Trait.Scavenger,
    index: 9,
    name: '拾荒者',
    en: 'SCAVENGER',
    levels: ['搜刮现金 +8%', '搜刮现金 +16%', '搜刮现金 +25%'],
  },
]

/** 一个人能带几条天赋。三条是"有取舍"与"能全拿"之间的分界。 */
export const MAX_TRAITS = 3

/**
 * 天赋的实际数值，按等级排（下标 0 = 一级）。
 *
 * 为什么要三级而不是"有/没有"：金币要有地方花，而且"这条我已经练满"本身就是
 * 一种局外进度感 —— 只做开关的话，攒够钱之后经济系统就死了。
 */
export const TRAIT_FX = {
  meleeDamage: [1.15, 1.3, 1.5],
  meleeInterval: [0.9, 0.8, 0.7],
  revolverInterval: [0.9, 0.8, 0.7],
  switchTime: [0.85, 0.72, 0.6],
  actionTime: [0.9, 0.8, 0.7],
  damageTaken: [0.94, 0.89, 0.85],
  spread: [0.9, 0.82, 0.75],
  lootCash: [1.08, 1.16, 1.25],
  maxHealth: [20, 35, 50],
  executeBonus: [1.15, 1.25, 1.35],
  monsterDamage: [0.88, 0.78, 0.68],
  carrionHeal: [8, 14, 20],
} as const

/** 处刑者的触发线：目标生命低于四成。 */
export const EXECUTE_BELOW = 0.4

/** 解锁与升级价目：一级免费（解锁价），二级 / 三级逐级更贵。 */
export const TRAIT_COST = [120, 320, 760] as const

function valueAt(table: readonly [number, number, number], level: number): number {
  return table[normalizeLevel(level) - 1] ?? 1
}

function normalizeLevel(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.max(0, Math.min(TRAIT_MAX_LEVEL, Math.trunc(level)))
}

/** 取某条天赋的等级（0 = 没装备）。 */
export function traitLevel(packed: number, bit: number): number {
  const spec = TRAITS.find((entry) => entry.bit === bit)
  if (spec === undefined) return 0
  return (packed >>> (spec.index * 2)) & 0b11
}

/** 写入某条天赋的等级，返回新的打包值。 */
export function setTraitLevel(packed: number, bit: number, level: number): number {
  const spec = TRAITS.find((entry) => entry.bit === bit)
  if (spec === undefined) return packed
  const shift = spec.index * 2
  const cleared = packed & ~(0b11 << shift)
  return cleared | (normalizeLevel(level) << shift)
}

/** 丢掉表里不存在的高位与非法等级（旧存档、改过的 localStorage）。 */
export function normalizeTraitLevels(packed: number): number {
  if (!Number.isFinite(packed)) return 0
  let out = 0
  for (const spec of TRAITS) {
    const level = (packed >>> (spec.index * 2)) & 0b11
    if (level > 0) out = setTraitLevel(out, spec.bit, level)
  }
  return out >>> 0
}

/** 装备了几条（等级 > 0）。 */
export function traitCount(packed: number): number {
  let count = 0
  for (const spec of TRAITS) if (traitLevel(packed, spec.bit) > 0) count++
  return count
}

/** 按表顺序只留前 limit 条：多出来的直接丢掉，而不是让越界值带出隐形天赋。 */
export function clampTraitLevels(packed: number, limit: number = MAX_TRAITS): number {
  const valid = normalizeTraitLevels(packed)
  let out = 0
  let taken = 0
  for (const spec of TRAITS) {
    const level = traitLevel(valid, spec.bit)
    if (level === 0) continue
    if (taken >= limit) break
    out = setTraitLevel(out, spec.bit, level)
    taken++
  }
  return out
}

/** 已装备的条目，按表顺序（HUD 徽记条与大厅摘要共用）。 */
export function traitList(packed: number): { spec: TraitSpec; level: number }[] {
  const valid = normalizeTraitLevels(packed)
  const out: { spec: TraitSpec; level: number }[] = []
  for (const spec of TRAITS) {
    const level = traitLevel(valid, spec.bit)
    if (level > 0) out.push({ spec, level })
  }
  return out
}

/** 选中项（位掩码）→ 打包等级值：选中的那条取"已拥有等级"。 */
export function packSelection(mask: number, owned: number): number {
  let out = 0
  for (const spec of TRAITS) {
    if ((mask & spec.bit) === 0) continue
    const ownedLevel = traitLevel(owned, spec.bit)
    const level = ownedLevel > 0 ? ownedLevel : 0
    if (level === 0) continue
    out = setTraitLevel(out, spec.bit, level)
  }
  return out
}

/** 打包等级值 → 选中项（位掩码）：大厅卡片的选中态用这个。 */
export function selectionOf(packed: number): number {
  let mask = 0
  for (const spec of TRAITS) if (traitLevel(packed, spec.bit) > 0) mask |= spec.bit
  return mask
}

/** 点一下天赋卡：已选则取消；未选且没满则选上（等级由已拥有等级决定）。 */
export function toggleSelection(mask: number, bit: number): number {
  const valid = mask & TRAITS.reduce((all, spec) => all | spec.bit, 0)
  if ((valid & bit) !== 0) return valid & ~bit
  let count = 0
  for (const spec of TRAITS) if ((valid & spec.bit) !== 0) count++
  if (count >= MAX_TRAITS) return valid
  return valid | bit
}

/** 下一级要花多少金币；已满级返回 0。 */
export function traitUpgradeCost(level: number): number {
  const next = normalizeLevel(level)
  if (next >= TRAIT_MAX_LEVEL) return 0
  return TRAIT_COST[next] ?? 0
}

/** 切枪用时倍率（左右开工）。 */
export function switchScale(packed: number): number {
  const level = traitLevel(packed, Trait.Ambidextrous)
  return level > 0 ? valueAt(TRAIT_FX.switchTime, level) : 1
}

/** 散布倍率（铁腕）。 */
export function spreadScale(packed: number): number {
  const level = traitLevel(packed, Trait.IronGrip)
  return level > 0 ? valueAt(TRAIT_FX.spread, level) : 1
}

/** 受到伤害倍率（硬皮）。 */
export function damageTakenScale(packed: number): number {
  const level = traitLevel(packed, Trait.Bulwark)
  return level > 0 ? valueAt(TRAIT_FX.damageTaken, level) : 1
}

/** 受到怪物伤害倍率（铁石心肠）。 */
export function monsterDamageScale(packed: number): number {
  const level = traitLevel(packed, Trait.Stoic)
  return level > 0 ? valueAt(TRAIT_FX.monsterDamage, level) : 1
}

/** 搜刮 / 包扎用时倍率（快手）。 */
export function actionScale(packed: number): number {
  const level = traitLevel(packed, Trait.QuickHand)
  return level > 0 ? valueAt(TRAIT_FX.actionTime, level) : 1
}

/** 搜刮现金倍率（拾荒者）。 */
export function lootCashScale(packed: number): number {
  const level = traitLevel(packed, Trait.Scavenger)
  return level > 0 ? valueAt(TRAIT_FX.lootCash, level) : 1
}

/** 近战伤害倍率（百臂巨人）。 */
export function meleeDamageScale(packed: number): number {
  const level = traitLevel(packed, Trait.HundredHands)
  return level > 0 ? valueAt(TRAIT_FX.meleeDamage, level) : 1
}

/** 生命上限加成（强健）。 */
export function maxHealthBonus(packed: number): number {
  const level = traitLevel(packed, Trait.Vigor)
  return level > 0 ? valueAt(TRAIT_FX.maxHealth, level) : 0
}

/** 对残血目标的伤害倍率（处刑者）。 */
export function executeScale(packed: number): number {
  const level = traitLevel(packed, Trait.Executioner)
  return level > 0 ? valueAt(TRAIT_FX.executeBonus, level) : 1
}

/** 击杀怪物回血（食腐者）。 */
export function carrionHeal(packed: number): number {
  const level = traitLevel(packed, Trait.Carrion)
  return level > 0 ? valueAt(TRAIT_FX.carrionHeal, level) : 0
}

/**
 * 射击间隔倍率：转轮吃左右开工，近战刀吃百臂巨人，其余为 1。
 *
 * 传入武器的 kind 而不是武器 id：将来加第二把转轮时这里不用改。
 */
export function fireIntervalScale(kind: string, packed: number): number {
  if (kind === 'knife') {
    const level = traitLevel(packed, Trait.HundredHands)
    return level > 0 ? valueAt(TRAIT_FX.meleeInterval, level) : 1
  }
  if (kind === 'revolver') {
    const level = traitLevel(packed, Trait.Ambidextrous)
    return level > 0 ? valueAt(TRAIT_FX.revolverInterval, level) : 1
  }
  return 1
}
