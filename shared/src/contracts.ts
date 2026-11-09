/**
 * 局内合同：出发前选一条，局内完成给现金。
 *
 * 为什么需要它：核心循环只有"找线索 → 放逐 → 撤离"一条主线，玩家在等线索
 * 刷完的时间段里没有第二个目标。合同给了一个**自己去做的理由**——它不改变
 * 胜负条件，只改变"这一局我往哪走"。
 *
 * 三条合同刻意对应三种玩法：
 * - 猎杀：逼你去找怪，而不是绕开怪；
 * - 搜刮：逼你进建筑/去边缘，而不是只走主路；
 * - 撤离：逼你活着把东西带出去，而不是死了重来。
 */

export const CONTRACT_NONE = 0
export const CONTRACT_HUNT = 1
export const CONTRACT_SEARCH = 2
export const CONTRACT_EXTRACT = 3
export const CONTRACT_BOSS = 4
export const CONTRACT_KNIFE = 5

export type ContractKey = 'none' | 'hunt' | 'search' | 'extract' | 'boss' | 'knife'

export interface ContractSpec {
  id: number
  key: ContractKey
  name: string
  /** 节点目标数。 */
  target: number
  /** 完成奖励（美元，直接进 carriedValue）。 */
  reward: number
  desc: string
}

export const CONTRACTS: readonly ContractSpec[] = [
  {
    id: CONTRACT_NONE,
    key: 'none',
    name: '不接合同',
    target: 0,
    reward: 0,
    desc: '轻装上阵，不给自己加目标。',
  },
  {
    id: CONTRACT_HUNT,
    key: 'hunt',
    name: '清剿',
    target: 2,
    reward: 150,
    desc: '猎杀 2 只怪物。逼你迎上去，而不是绕开。',
  },
  {
    id: CONTRACT_SEARCH,
    key: 'search',
    name: '搜刮',
    target: 2,
    reward: 120,
    desc: '搜完 2 个点。逼你进建筑、去边缘。',
  },
  {
    id: CONTRACT_EXTRACT,
    key: 'extract',
    name: '押运',
    target: 1,
    reward: 200,
    desc: '带着赏金成功撤离一次。逼你活着把东西带出去。',
  },
  {
    id: CONTRACT_BOSS,
    key: 'boss',
    name: '屠夫',
    target: 1,
    reward: 300,
    desc: '亲手打死血巢的 Boss。全图最硬的骨头，也最值钱。',
  },
  {
    id: CONTRACT_KNIFE,
    key: 'knife',
    name: '刀锋',
    target: 1,
    reward: 250,
    desc: '用猎刀击杀一名猎人。安静、近身、没有第二次机会。',
  },
]

export function contractOf(id: number): ContractSpec {
  return CONTRACTS[id] ?? CONTRACTS[0]!
}

/** 把线上/存档里的 id 夹到合法范围。 */
export function clampContract(id: number): number {
  return Number.isFinite(id) && id >= 0 && id < CONTRACTS.length ? Math.floor(id) : CONTRACT_NONE
}
