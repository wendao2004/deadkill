/**
 * 物品与网格容器：纯数据 + 纯函数。
 *
 * 两端共用（服务端裁决、客户端预览），所以这里**不许**出现 DOM、three、
 * 随机数或时间。所有操作都是"输入容器快照 → 返回新快照"，失败返回原对象 +
 * 原因字符串，方便服务端把原因回给客户端、也方便单测。
 *
 * 坐标约定：容器是一个 `cols × rows` 的格子；物品用左上角 `(x, y)` 与
 * `rotated` 表示占位。旋转只允许 90°，即 `w/h` 互换。
 */

export type ItemKind = 'weapon' | 'part' | 'ammo' | 'med' | 'valuable' | 'key' | 'material' | 'container'

export interface ItemDef {
  id: number
  key: string
  name: string
  kind: ItemKind
  /** 未旋转时的占格。 */
  w: number
  h: number
  /** 最大堆叠数；1 = 不可堆叠。 */
  stack: number
  /** 单件重量（kg）。 */
  weight: number
  /** 基准价：跳蚤市场的价格锚，也是撤离结算的身价。 */
  value: number
  /** 模型注册表键（客户端按它取几何）。 */
  model: string
  /** 容器类物品的内部格子；非容器为 undefined。 */
  grid?: { cols: number; rows: number }
  /** 使用效果：医疗类的治疗量与耗时。 */
  use?: { heal?: number; timeMs?: number }
}

export interface ItemInstance {
  /** 服务端发号的全局唯一 id：所有背包操作都以它为准，防复制。 */
  uid: number
  /** 指向 ITEM_DEFS 的 id。 */
  def: number
  count: number
  /** 武器实例的改装；其它物品为 undefined。 */
  build?: { weaponId: number; slots: Partial<Record<'sight' | 'muzzle' | 'magazine' | 'stock', number>> }
  /** 容器实例的内部（背包/箱子）。 */
  inside?: GridContainer
}

export interface PlacedItem {
  item: ItemInstance
  x: number
  y: number
  rotated: boolean
}

export interface GridContainer {
  cols: number
  rows: number
  items: PlacedItem[]
}

export class ItemError extends Error {}

/* ==========================================================================
 * 物品表
 * ========================================================================== */

export const ITEM_DEFS: readonly ItemDef[] = [
  { id: 1, key: 'ammo_45lc', name: '.45 长柯尔特', kind: 'ammo', w: 1, h: 1, stack: 30, weight: 0.02, value: 3, model: 'ammo-box' },
  { id: 2, key: 'ammo_12g', name: '12 号霰弹', kind: 'ammo', w: 1, h: 1, stack: 20, weight: 0.05, value: 5, model: 'ammo-box' },
  { id: 3, key: 'medkit_small', name: '小急救包', kind: 'med', w: 1, h: 2, stack: 1, weight: 0.4, value: 45, model: 'medkit', use: { heal: 35, timeMs: 2600 } },
  { id: 4, key: 'medkit_large', name: '战地医疗包', kind: 'med', w: 2, h: 2, stack: 1, weight: 1.1, value: 120, model: 'medkit', use: { heal: 90, timeMs: 5200 } },
  { id: 5, key: 'valuable_watch', name: '银怀表', kind: 'valuable', w: 1, h: 1, stack: 1, weight: 0.15, value: 180, model: 'valuable' },
  { id: 6, key: 'valuable_icon', name: '镀金圣像', kind: 'valuable', w: 1, h: 2, stack: 1, weight: 0.6, value: 320, model: 'valuable' },
  { id: 7, key: 'key_sawmill', name: '锯木厂钥匙', kind: 'key', w: 1, h: 1, stack: 1, weight: 0.02, value: 0, model: 'key' },
  { id: 8, key: 'material_gear', name: '黄铜齿轮', kind: 'material', w: 1, h: 1, stack: 8, weight: 0.2, value: 25, model: 'material' },
  { id: 9, key: 'part_scope4', name: '4× 镜', kind: 'part', w: 2, h: 1, stack: 1, weight: 0.5, value: 260, model: 'scope4' },
  { id: 10, key: 'part_brake', name: '制退器', kind: 'part', w: 1, h: 1, stack: 1, weight: 0.2, value: 90, model: 'brake' },
  { id: 11, key: 'bag_small', name: '帆布背包', kind: 'container', w: 3, h: 3, stack: 1, weight: 0.9, value: 80, model: 'bag', grid: { cols: 4, rows: 4 } },
  { id: 13, key: 'valuable_liquor', name: '私酿烈酒', kind: 'valuable', w: 1, h: 2, stack: 1, weight: 0.8, value: 90, model: 'valuable' },
  { id: 12, key: 'weapon_winfield', name: '温菲尔德杠杆步枪', kind: 'weapon', w: 4, h: 2, stack: 1, weight: 3.6, value: 400, model: 'rifle' },
]

const DEF_BY_ID = new Map(ITEM_DEFS.map((def) => [def.id, def]))
const DEF_BY_KEY = new Map(ITEM_DEFS.map((def) => [def.key, def]))

export function itemDef(id: number): ItemDef | null {
  return DEF_BY_ID.get(id) ?? null
}

export function itemDefByKey(key: string): ItemDef | null {
  return DEF_BY_KEY.get(key) ?? null
}

/** 物品当前的占格（考虑旋转）。 */
export function footprint(def: ItemDef, rotated: boolean): { w: number; h: number } {
  return rotated ? { w: def.h, h: def.w } : { w: def.w, h: def.h }
}

/* ==========================================================================
 * 容器
 * ========================================================================== */

export function createGrid(cols: number, rows: number): GridContainer {
  return { cols, rows, items: [] }
}

/** 某格是否已被占用（`skipUid` 用于移动自己时忽略自身）。 */
export function occupiedAt(container: GridContainer, x: number, y: number, skipUid = -1): PlacedItem | null {
  for (const placed of container.items) {
    if (placed.item.uid === skipUid) continue
    const def = itemDef(placed.item.def)
    if (!def) continue
    const { w, h } = footprint(def, placed.rotated)
    if (x >= placed.x && x < placed.x + w && y >= placed.y && y < placed.y + h) return placed
  }
  return null
}

/** 这一件能不能在 `(x, y)` 放下。 */
export function canPlace(
  container: GridContainer,
  instance: ItemInstance,
  x: number,
  y: number,
  rotated = false,
  skipUid = -1,
): boolean {
  const def = itemDef(instance.def)
  if (!def) return false
  const { w, h } = footprint(def, rotated)
  if (x < 0 || y < 0 || x + w > container.cols || y + h > container.rows) return false
  for (let gy = y; gy < y + h; gy++) {
    for (let gx = x; gx < x + w; gx++) {
      if (occupiedAt(container, gx, gy, skipUid) !== null) return false
    }
  }
  return true
}

/** 找一个空位（先横放，再旋转一次）。返回 null 表示装不下。 */
export function findSlot(
  container: GridContainer,
  instance: ItemInstance,
  skipUid = -1,
): { x: number; y: number; rotated: boolean } | null {
  for (const rotated of [false, true]) {
    const def = itemDef(instance.def)
    if (!def) return null
    const { w, h } = footprint(def, rotated)
    for (let y = 0; y + h <= container.rows; y++) {
      for (let x = 0; x + w <= container.cols; x++) {
        if (canPlace(container, instance, x, y, rotated, skipUid)) return { x, y, rotated }
      }
    }
  }
  return null
}

/**
 * 放入一件物品：同 `def` 且未满的堆叠优先合并，否则找空位。
 *
 * 返回新的容器（不修改入参），并在放不下时抛 `ItemError`。
 */
export function addItem(container: GridContainer, instance: ItemInstance): GridContainer {
  const def = itemDef(instance.def)
  if (!def) throw new ItemError(`unknown def ${instance.def}`)

  let remaining = instance.count
  const items = container.items.map((placed) => ({ ...placed, item: { ...placed.item } }))

  if (def.stack > 1) {
    for (const placed of items) {
      if (remaining <= 0) break
      if (placed.item.def !== instance.def) continue
      const room = def.stack - placed.item.count
      if (room <= 0) continue
      const moved = Math.min(room, remaining)
      placed.item.count += moved
      remaining -= moved
    }
  }
  if (remaining <= 0) {
    if (def.stack === 1) throw new ItemError('stack of one: cannot merge')
    return { ...container, items }
  }

  const slot = findSlot(container, { ...instance, count: remaining })
  if (!slot) throw new ItemError('no space')
  items.push({ item: { ...instance, count: remaining }, x: slot.x, y: slot.y, rotated: slot.rotated })
  return { ...container, items }
}

/** 取出整件（不拆分堆叠）。返回新容器与被取出的物品。 */
export function removeItem(container: GridContainer, uid: number): { container: GridContainer; item: ItemInstance } {
  const index = container.items.findIndex((placed) => placed.item.uid === uid)
  if (index === -1) throw new ItemError('uid not found')
  const items = container.items.slice()
  const [taken] = items.splice(index, 1)
  return { container: { ...container, items }, item: taken!.item }
}

/** 从一堆里拆出 `count` 个（弹药/材料），少于 1 或不合法时报错。 */
export function splitStack(
  container: GridContainer,
  uid: number,
  count: number,
): { container: GridContainer; item: ItemInstance } {
  const placed = container.items.find((entry) => entry.item.uid === uid)
  if (!placed) throw new ItemError('uid not found')
  if (!Number.isInteger(count) || count < 1 || count > placed.item.count) throw new ItemError('bad count')
  const items = container.items.map((entry) =>
    entry.item.uid === uid ? { ...entry, item: { ...entry.item, count: entry.item.count - count } } : entry,
  )
  const item: ItemInstance = { ...placed.item, uid: -1, count }
  return { container: { ...container, items: items.filter((entry) => entry.item.count > 0) }, item }
}

/**
 * 在同一个容器内移动（服务端与客户端预览共用）。
 *
 * 只处理"位置变化"，不处理跨容器与堆叠 —— 那两件事涉及两个容器，必须由
 * 调用方事务化处理（见 `moveBetween`）。
 */
export function reposition(
  container: GridContainer,
  uid: number,
  x: number,
  y: number,
  rotated: boolean,
): GridContainer {
  const placed = container.items.find((entry) => entry.item.uid === uid)
  if (!placed) throw new ItemError('uid not found')
  if (!canPlace(container, placed.item, x, y, rotated, uid)) throw new ItemError('blocked')
  return {
    ...container,
    items: container.items.map((entry) => (entry.item.uid === uid ? { ...entry, x, y, rotated } : entry)),
  }
}

/** 跨容器移动：先校验目标能放，再从源移除；任何一步失败都不改动输入。 */
export function moveBetween(
  from: GridContainer,
  to: GridContainer,
  uid: number,
): { from: GridContainer; to: GridContainer; item: ItemInstance } {
  const placed = from.items.find((entry) => entry.item.uid === uid)
  if (!placed) throw new ItemError('uid not found')
  const slot = findSlot(to, placed.item)
  if (!slot) throw new ItemError('no space')
  const removed = removeItem(from, uid)
  const nextTo: GridContainer = {
    ...to,
    items: [...to.items, { item: placed.item, x: slot.x, y: slot.y, rotated: slot.rotated }],
  }
  return { from: removed.container, to: nextTo, item: placed.item }
}

/* ==========================================================================
 * 汇总
 * ========================================================================== */

/** 容器（含子容器）的总重量：背包里装满弹药时的移动惩罚就靠它。 */
export function totalWeight(container: GridContainer): number {
  let weight = 0
  for (const placed of container.items) {
    const def = itemDef(placed.item.def)
    if (!def) continue
    weight += def.weight * placed.item.count
    if (placed.item.inside) weight += totalWeight(placed.item.inside)
  }
  return weight
}

/** 容器（含子容器）的总身价：撤离结算与跳蚤定价都用它。 */
export function totalValue(container: GridContainer): number {
  let value = 0
  for (const placed of container.items) {
    const def = itemDef(placed.item.def)
    if (!def) continue
    value += def.value * placed.item.count
    if (placed.item.inside) value += totalValue(placed.item.inside)
  }
  return value
}

/** 调试/日志用：把容器画成字符网格（`#` 占用，`.` 空）。 */
export function renderGrid(container: GridContainer): string[] {
  const rows: string[][] = Array.from({ length: container.rows }, () => Array.from({ length: container.cols }, () => '.'))
  for (const placed of container.items) {
    const def = itemDef(placed.item.def)
    if (!def) continue
    const { w, h } = footprint(def, placed.rotated)
    for (let y = placed.y; y < Math.min(placed.y + h, container.rows); y++) {
      for (let x = placed.x; x < Math.min(placed.x + w, container.cols); x++) {
        rows[y][x] = '#'
      }
    }
  }
  return rows.map((row) => row.join(''))
}
