/**
 * 每局环境修饰（modifier）。
 *
 * 一局打完最大的浪费不是死了，而是"下一局和这一局一模一样"：同样的雾、
 * 同样数量的怪、同样的开箱收益，第四把就会开始背地图。这里把三个最能被
 * 玩家感知到的旋钮（能见度、怪物密度、现金）交给每局的种子，服务端在
 * 建世界时抽一次，随手下发一个 u8 给客户端 —— 全队看到的是同一场天气，
 * 不会出现"我这边大雾你那边晴天"。
 *
 * 数值都刻意压在"能感觉到但不改变玩法"的区间：浓雾是 fogScale 2.2 而不是
 * 直接看不见 20m 外，虫潮是 1.6 倍怪量而不是把人埋了。差异化要让人换打法，
 * 不能让人换游戏。
 */
export type MatchModifierKey = 'calm' | 'fog' | 'storm' | 'swarm'

export interface MatchModifier {
  /** 线上传的 id，必须与数组下标一致。 */
  id: number
  key: MatchModifierKey
  name: string
  en: string
  /** 大厅/结算里给玩家看的一句话。 */
  desc: string
  /** 雾密度倍率，客户端乘到 level.fogDensity 上。 */
  fogScale: number
  /** 雾色覆盖（0 = 用关卡自带的雾色）。 */
  fogTint: number
  /** 怪物数量倍率。 */
  monsterScale: number
  /** 战利品现金倍率。 */
  cashScale: number
}

export const MODIFIERS: readonly MatchModifier[] = [
  {
    id: 0,
    key: 'calm',
    name: '死寂',
    en: 'DEAD CALM',
    desc: '风停了。雾散得开，也意味着别人老远就看得见你。',
    fogScale: 0.55,
    fogTint: 0x767f6d,
    monsterScale: 1,
    cashScale: 1,
  },
  {
    id: 1,
    key: 'fog',
    name: '浓雾',
    en: 'THICK FOG',
    desc: '三十步外只剩轮廓。枪声比人影先到。',
    fogScale: 2.3,
    fogTint: 0x9aa08c,
    monsterScale: 1,
    cashScale: 1.1,
  },
  {
    id: 2,
    key: 'storm',
    name: '骤雨',
    en: 'SQUALL',
    desc: '雨把脚步和枪声都糊成一片，谁都听不清谁在哪。',
    fogScale: 1.4,
    fogTint: 0x59645f,
    monsterScale: 1.15,
    cashScale: 1.15,
  },
  {
    id: 3,
    key: 'swarm',
    name: '虫潮',
    en: 'THE SWARM',
    desc: '沼泽里的东西今晚全出来了。钱也多。',
    fogScale: 0.85,
    fogTint: 0x6c7358,
    monsterScale: 1.6,
    cashScale: 1.3,
  },
]

/** 非法 id 一律回落到"死寂"，宁可没特色也不要一局凭空多 60% 的怪。 */
export function getModifier(id: number): MatchModifier {
  return MODIFIERS[id] ?? MODIFIERS[0]
}

/** 用世界的种子 rng 抽一个 —— 传进来的必须是每局固定的那个 rng，不能每 tick 调。 */
export function rollModifier(rand: () => number): number {
  return Math.floor(rand() * MODIFIERS.length) % MODIFIERS.length
}
