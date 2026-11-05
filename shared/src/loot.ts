/**
 * 搜刮点的战利品掷骰。
 *
 * **完全由点下标决定**，不用 Math.random：这是"搜打撤"的常识 —— 一个箱子
 * 里的东西在开局那一刻就定死了，而不是等谁去开的时候才掷骰子。做成确定性的
 * 好处是同一个点的战利品可以在两端独立重算（客户端画预览、测试断言、复盘
 * 录像回放都对得上），也不会因为服务端重启/换机而变。
 *
 * 放在 shared 而不是服务端：客户端要用同一份规则判断"这个点还值不值得跑一趟"，
 * 两端各写一遍迟早会在某次调数值时漂开。
 */

import { mulberry32 } from './hit.ts'
import type { SearchKind } from './level.ts'
import { LOOT_ITEM, type LootItem } from './protocol.ts'

export interface LootRoll {
  /** 必给的现金（美元）。 */
  cash: number
  /** 概率掉落的物品，按 LOOT_ITEM 的 id 排序。 */
  items: LootItem[]
}

/** 必给现金的区间（闭区间，美元）。尸体最肥：搜尸要先去把人打死。 */
const LOOT_CASH: Record<SearchKind, [number, number]> = {
  crate: [40, 120],
  sack: [25, 70],
  corpse: [60, 160],
}

/** 概率掉落表。一次搜刮里每项独立掷一次，可以同时出好几件。 */
const LOOT_DROPS: readonly { id: number; chance: number }[] = [
  { id: LOOT_ITEM.Bandage, chance: 0.45 },
  { id: LOOT_ITEM.Ammo, chance: 0.4 },
  { id: LOOT_ITEM.Liquor, chance: 0.2 },
  { id: LOOT_ITEM.Watch, chance: 0.1 },
]

/** 战利品种子的基址：和房间 id 的种子分开，才不会跟怪物游荡串在一起。 */
const LOOT_SEED_BASE = 0x9e37

/**
 * 算出某个点里有什么。
 *
 * 抽签顺序固定（现金 → 绷带 → 弹药 → 烈酒 → 怀表），所以同一个
 * (spotIndex, kind, seed) 永远得到同一份结果 —— 同一局里刷新页面看到的还是
 * 同一份，换一局才变。
 */
export function rollLoot(spotIndex: number, kind: SearchKind, seed = 0): LootRoll {
  // 种子混进**本局**的随机数：同一个点在不同局里不再是同一份东西。
  // 默认 0 让老测试保持"同参数同结果"，而世界自己每局传一个不同的值。
  const rand = mulberry32(LOOT_SEED_BASE + seed + spotIndex)
  const [low, high] = LOOT_CASH[kind]
  const cash = low + Math.floor(rand() * (high - low + 1))
  const items: LootItem[] = []
  for (const drop of LOOT_DROPS) {
    if (rand() < drop.chance) items.push({ id: drop.id, count: 1 })
  }
  return { cash, items }
}
