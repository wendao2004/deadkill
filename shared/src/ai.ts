/**
 * 怪物 AI：**只在服务端跑**，客户端只负责把收到的位姿画出来。
 *
 * 为什么这里必须是纯函数：怪物的每一次决策都要能按 (状态, 输入, rng, tick) 复现。
 * 只要本文件里出现 Date.now() 或 Math.random()，回放/录像里的怪就会走另一条路线，
 * "这只怪穿墙咬了我" 就变成无法复现的猜谜。所以时间由 tick 传入、随机数由 rng
 * 传入、单帧时长由 dtMs 传入 —— 本模块自己不持有任何状态，也不碰物理引擎。
 *
 * 为什么索敌要带滞回：两个玩家一左一右几乎等距时，"每 tick 选最近的" 会让
 * targetId 在两个 id 之间来回跳，怪物站在原地左右抽搐、一步也走不动。玩家
 * 看到的是卡帧而不是 AI。所以只有新目标明显更近（TARGET_SWITCH_RATIO）才换人。
 *
 * 位置不在这里推进：stepMonster 只写回 vx/vz，位移与"别穿墙"由调用方
 * （服务端拿着 Rapier 世界做 shape cast）负责。把几何塞进来会立刻毁掉上面
 * 说的可复现性，也会让这个文件没法被单元测试单独跑 600 tick。
 */

import { TICK_MS } from './constants.ts'

export type MonsterKind = 'grunt' | 'hound' | 'gunner' | 'boss' | 'bellkeeper' | 'golem' | 'conductor'

/** 四种 Boss 各自的叙事名字。客户端血条、击杀播报与出生提示共用这一份。 */
export const BOSS_NAMES: Record<MonsterKind, string> = {
  grunt: '沼泽行尸',
  hound: '沼泽猎犬',
  gunner: '持枪行尸',
  boss: '屠夫',
  bellkeeper: '敲钟人',
  golem: '石心巨像',
  conductor: '末班车长',
}

/** 线上种类码 → MonsterKind。数字与 protocol.ts 的 MonsterKindCode 一一对应。 */
const KIND_BY_CODE: Record<number, MonsterKind> = {
  0: 'grunt',
  1: 'hound',
  2: 'gunner',
  3: 'boss',
  4: 'bellkeeper',
  5: 'golem',
  6: 'conductor',
}

export function monsterKindFromCode(code: number): MonsterKind | null {
  return KIND_BY_CODE[code] ?? null
}

/** 这只怪是不是血巢 Boss。新 Boss 加进来时只改这里，别在业务代码里写 kind === 'boss'。 */
export function isBossKind(kind: MonsterKind): boolean {
  return kind === 'boss' || kind === 'bellkeeper' || kind === 'golem' || kind === 'conductor'
}

export function bossNameOf(kind: MonsterKind): string {
  return BOSS_NAMES[kind]
}

/** Boss 特殊技：锁定方向冲锋。 */
export interface BossChargeSpec {
  /** 玩家进入这个距离才考虑冲锋（太近会变成贴脸瞬移）。 */
  minRange: number
  /** 超过这个距离它不冲 —— 那不是冲锋，是跑图。 */
  maxRange: number
  /** 抬武器/压低身子的前摇。玩家看见它不动的那段时间就是闪避窗口。 */
  windupMs: number
  /** 冲出去持续多久。 */
  durationMs: number
  /** 冲锋速度相对 spec.speed 的倍数。 */
  speedScale: number
  /** 撞上玩家的一次性伤害。 */
  damage: number
  /** 两次冲锋之间的冷却。 */
  cooldownMs: number
}

/** Boss 特殊技：以自身为圆心的范围脉冲（敲钟 / 砸地）。 */
export interface BossPulseSpec {
  radius: number
  damage: number
  /** 蓄力时间：客户端用 special 状态播这个动作。 */
  windupMs: number
  cooldownMs: number
  /** 玩家进入这个距离它才开始蓄力。 */
  maxRange: number
}

/** Boss 特殊技：血量降到阈值时召唤小怪（只触发一次）。 */
export interface BossSummonSpec {
  /** 0..1，低于这个血量比例触发。 */
  healthPct: number
  kind: MonsterKind
  count: number
}

export interface MonsterSpec {
  kind: MonsterKind
  maxHealth: number
  /** 米/秒 */
  speed: number
  /** 进入这个距离就开始攻击 */
  attackRange: number
  attackDamage: number
  /** 两次攻击之间的冷却（毫秒） */
  attackIntervalMs: number
  /** 能发现玩家的水平距离 */
  aggroRange: number
  /** 超过这个距离就放弃追击、回到巢穴 */
  leashRange: number
  radius: number
  height: number
  /**
   * 远程怪的开火参数。带这个字段的怪**站定开枪**，不再贴身咬人。
   *
   * 三个数决定了"它公平"还是"它作弊"：
   *  - `aimMs` 是从看见人到能打第一枪的瞄准时间。玩家的反应窗就在这里，
   *    低于 500ms 等于白送伤害。
   *  - `spreadRad` 是按弧度算的散布半径。0.035rad ≈ 2°，20m 上是 70cm 的
   *    偏移 —— 站着不动会被打，走两步就躲得掉。
   *  - `falloffNear/Far/Min` 让 30m 外的一枪只是擦伤，而不是远程狙击。
   *
   * 命中求解在服务端做（需要物理世界判墙与胶囊），本模块只决定"这一 tick 该
   * 不该扣扳机"，所以这里只有参数、没有射线。
   */
  ranged?: {
    /** 打中躯干的基础伤害（再乘距离衰减系数）。 */
    damage: number
    /** 散布半径（弧度）。 */
    spreadRad: number
    /** 从发现到能开第一枪的瞄准时间（毫秒）。 */
    aimMs: number
    /** 这个距离内不衰减。 */
    falloffNear: number
    /** 到这个距离伤害只剩 falloffMin。 */
    falloffFar: number
    /** 最远处的伤害系数（0~1）。 */
    falloffMin: number
    /** 曳光与枪声用的武器 id（客户端据此选音色）。 */
    weaponId: number
  }
  /**
   * 这个东西吃子弹的比例。石心巨像 0.72 = 三发抵两发：不是打不死，
   * 而是逼玩家换位/换枪，而不是站在原地点鼠标。
   */
  bulletResist?: number
  /** 远程怪被贴到多近时开始后撤（米）。不填 = 站桩对射。 */
  keepDistance?: number
  charge?: BossChargeSpec
  pulse?: BossPulseSpec
  summon?: BossSummonSpec
}

/**
 * 两种怪只差"耐打 / 快 / 咬得疼"三件事，其余全部由同一套状态机驱动。
 *
 * grunt 的数值是照着玩家的枪反推的，不是拍脑袋：
 *  - 血 120 < 温菲尔德躯干 75 × 2 = 150，所以两枪必死、一枪不死。玩家在
 *    两枪的间隔里必须能退开一步，这个血量就是"退不开就得吃第二口"的余量。
 *  - 速度 4.4 夹在走路 4.2 和冲刺 6.4 之间：走路甩不掉它，冲刺能。逼玩家
 *    在"站桩开枪"和"跑路"之间做选择，这是猎杀类的基本博弈。
 *  - 咬 22 / 1.1s ≈ 20 dps，150 血要挨 7 秒多，足够支援到场。
 * hound 是消耗品，数值往"快而脆"的方向压：
 *  - 血 70 < 单发躯干 75，一枪带走。它不该占用玩家两发子弹。
 *  - 速度 6.1 贴着冲刺 6.4：只差 0.3m/s 的拉开速度，追人时是真正的压迫感。
 *  - 咬 14 / 0.75s ≈ 18.7 dps，单次伤害低但更难甩，作用是把人从掩体后赶出来。
 *  - 身高 1.0、半径 0.34：贴地的四足胶囊，站着打要压枪。
 */
export const MONSTER_SPECS: Record<MonsterKind, MonsterSpec> = {
  grunt: {
    kind: 'grunt',
    maxHealth: 120,
    speed: 4.4,
    attackRange: 1.8,
    attackDamage: 22,
    attackIntervalMs: 1100,
    aggroRange: 16,
    leashRange: 26,
    radius: 0.45,
    height: 1.85,
  },
  hound: {
    kind: 'hound',
    maxHealth: 70,
    speed: 6.1,
    attackRange: 1.5,
    attackDamage: 14,
    attackIntervalMs: 750,
    aggroRange: 24,
    leashRange: 36,
    radius: 0.34,
    height: 1.0,
  },
  /**
   * 屠夫（沼泽农舍）：线索集齐后在血巢刷出来的 Boss。
   *
   * 它不需要新机制，需要的是"必须正面处理"的体量 + 一次可躲的冲锋：
   *  - 血 1200：温菲尔德躯干 75，16 发身体命中；仍然逼你补弹/换枪，
   *    但不会因为无限备弹变成一场 20 发以上的站桩。
   *  - 速度 4.6 略快于玩家走路 4.2、慢于冲刺 6.4：正常后退会被它贴上，
   *    必须用冲刺换距离；逃跑的代价仍然是放逐时间。
   *  - 一刀 65 / 1.6s：站着对拼三刀就死，必须一边绕一边打。
   *  - 冲锋前摇 550ms、锁定方向而不是追踪：看见它停住就横移，能躲。
   *  - aggroRange 80 / leashRange 200：进了血巢就没有它看不见你的地方。
   *  - 身高 3.3、半径 0.9：剪影上就该和普通行尸完全不同，隔着雾也认得出。
   */
  boss: {
    kind: 'boss',
    maxHealth: 1200,
    speed: 4.6,
    attackRange: 3.8,
    attackDamage: 65,
    attackIntervalMs: 1600,
    aggroRange: 80,
    leashRange: 200,
    radius: 0.9,
    height: 3.3,
    charge: {
      minRange: 5,
      maxRange: 22,
      windupMs: 550,
      durationMs: 850,
      speedScale: 2.25,
      damage: 95,
      cooldownMs: 6500,
    },
  },
  /**
   * 敲钟人（教堂墓园）：慢、窄、高，靠钟声控制距离。
   *
   * 它不追人。玩家进 8m 就被钟声震一下 —— 这逼进攻方在"进圈打头"和
   * "在圈外磨血"之间做选择。钟声有 900ms 蓄力，看见它把钟举起来就能退。
   */
  bellkeeper: {
    kind: 'bellkeeper',
    maxHealth: 1500,
    speed: 3.6,
    attackRange: 3.6,
    attackDamage: 52,
    attackIntervalMs: 1500,
    aggroRange: 85,
    leashRange: 210,
    radius: 0.72,
    height: 3.4,
    pulse: {
      radius: 8,
      damage: 48,
      windupMs: 900,
      cooldownMs: 5600,
      maxRange: 9,
    },
  },
  /**
   * 石心巨像（采石场）：最慢、最硬、最重。
   *
   * 2200 血 + 0.72 子弹减伤，硬打要三十多发；但它的砸地前摇有 1.1 秒、
   * 半径 7m，玩家有足够时间跑出圈。它是"别站在它面前"的考试，不是 DPS 木桩。
   */
  golem: {
    kind: 'golem',
    maxHealth: 2200,
    speed: 3.1,
    attackRange: 4.4,
    attackDamage: 82,
    attackIntervalMs: 2000,
    aggroRange: 75,
    leashRange: 190,
    radius: 1.15,
    height: 3.9,
    bulletResist: 0.72,
    pulse: {
      radius: 7,
      damage: 60,
      windupMs: 1100,
      cooldownMs: 7200,
      maxRange: 8.5,
    },
  },
  /**
   * 末班车长（火车站废墟）：唯一会拉开距离、用信号枪点名的 Boss。
   *
   * 贴脸会被它后撤，躲远会被它一枪一枪点；半血时吹哨召来两只猎犬，
   * 把"绕圈磨血"的玩家逼回掩体。它血量最低（1400），因为枪线本身就是压力。
   */
  conductor: {
    kind: 'conductor',
    maxHealth: 1400,
    speed: 4.2,
    attackRange: 20,
    attackDamage: 42,
    attackIntervalMs: 1500,
    aggroRange: 95,
    leashRange: 230,
    radius: 0.78,
    height: 3.4,
    keepDistance: 8,
    ranged: {
      damage: 26,
      spreadRad: 0.022,
      aimMs: 850,
      falloffNear: 8,
      falloffFar: 26,
      falloffMin: 0.4,
      weaponId: 1,
    },
    summon: {
      healthPct: 0.55,
      kind: 'hound',
      count: 2,
    },
  },
  /**
   * 持枪行尸：会拿枪的那种"人"。它是**唯一**让玩家不能无视怪物的原因 ——
   * 近战怪可以绕着走，一个站在 20m 外打你的人不行。
   *
   * 数值仍然是照着玩家的枪反推的：
   *  - 血 110 < 温菲尔德躯干 75 × 2，两枪必死、一枪不死（和 grunt 同一节奏：
   *    你可以先还一枪再决定要不要断开视线）。
   *  - 速度 3.6 < 走路 4.2：**正常走路就能拉开距离**。它逼你动起来，但不追杀，
   *    因为一个跑得比你快的枪手等于没有选择。
   *  - 伤害 15 / 1.5s（满命中 ≈ 10 dps）：站着不动挨五枪才死，你有一整个
   *    换弹周期的时间决定要不要拆它。
   *  - aggroRange 30 但攻击距离 16：它要**走过来**才开枪，这一段路就是玩家
   *    听见脚步、看见剪影、绕到掩体后面的时间。
   *  - 瞄准 900ms、散布 2°：站在开阔地不动会被打，跑动/侧移基本打不中。
   */
  gunner: {
    kind: 'gunner',
    maxHealth: 110,
    speed: 3.6,
    attackRange: 16,
    // 贴到脸上时改用它：一把枪在 1m 内反而打不中，近身啃你更符合观感。
    attackDamage: 16,
    attackIntervalMs: 1500,
    aggroRange: 30,
    leashRange: 34,
    radius: 0.45,
    height: 1.85,
    ranged: {
      damage: 15,
      spreadRad: 0.035,
      aimMs: 900,
      falloffNear: 10,
      falloffFar: 30,
      falloffMin: 0.45,
      weaponId: 1,
    },
  },
}

/**
 * 发现目标到第一次能造成伤害之间的"愣神"窗口（毫秒）。
 *
 * 350ms 在 60Hz 下是 21 tick：够玩家看见它转向自己、做出后退或开枪的反应，
 * 又短到不会变成"它就是站着不动"。少于 300ms 就是贴脸白打一记，玩家会觉得
 * 这口伤害不是自己没躲开，而是游戏硬塞给他的。
 */
export const AGGRO_WINDUP_MS = 350

/**
 * 换目标需要的"更近比例"：新目标必须比当前目标近 20% 以上才换。
 *
 * 没有这个滞回，两个等距玩家会让怪物每 tick 掉头一次（见文件头注释）。
 */
export const TARGET_SWITCH_RATIO = 0.8

/**
 * 巢穴到达半径（米）。脱战后走到这个范围内就算"到家"，才开始重新索敌。
 *
 * 它同时是 idle 游荡的活动范围：游荡推力被限制在这个圈里，怪不会自己走丢。
 */
export const HOME_ARRIVE_RADIUS = 1.2

/** 回巢时的速度比例：它已经放弃你了，不该用扑人的全速往家跑。 */
const RETURN_SPEED_FACTOR = 0.55

/** 巢穴内游荡：阻尼（1/秒）与随机推力加速度（米/秒²），单位都按秒算，与帧率无关。 */
const WANDER_DAMPING = 4
const WANDER_ACCEL = 6
/** 游荡速度上限相对 spec.speed 的比例。 */
const WANDER_SPEED_FACTOR = 0.25

/** 出生时在巢穴半径内散开的距离（米）。必须 < HOME_ARRIVE_RADIUS。 */
const SPAWN_SCATTER = 0.7

/**
 * 远程怪"看不见人就往前挪"时的速度比例。
 *
 * 比全速慢：它不是冲锋，是端着枪慢慢找角度。玩家由此能从脚步判断出
 * "它绕过来了"，而不是被一只全速冲脸的枪手直接顶到脸上。
 */
export const REPOSITION_SPEED_FACTOR = 0.7

/**
 * 远程怪的近战接管距离（米）。
 *
 * 枪在 1~2m 内既不好看也打不中（胶囊可能就在枪口里），而"被枪手逼到墙角
 * 反而安全"是这类游戏里最经典的漏洞之一 —— 所以贴脸改成啃。
 */
const MELEE_PANIC_RANGE = 2.2

export type MonsterState = 'idle' | 'chase' | 'attack' | 'special' | 'dead'

export interface Monster {
  id: number
  kind: MonsterKind
  state: MonsterState
  /** 当前位置（脚底）。 */
  x: number
  y: number
  z: number
  /** 水平速度，由 stepMonster 写回。 */
  vx: number
  vz: number
  health: number
  /** 巢穴位置，脱战后往这里走。 */
  homeX: number
  homeZ: number
  /** 下一次可攻击的 tick。 */
  nextAttackTick: number
  /** 当前锁定目标，0 表示无。 */
  targetId: number
  /** 从发现到现在的累计时间，用于让怪物"先愣一下"而不是贴脸即打。 */
  aggroMs: number
  /** Boss 特殊技进行到第几 tick（0 = 不在特殊技中）。 */
  specialUntilTick?: number
  /** 特殊技的"生效点"：冲锋开始 / 脉冲落地。 */
  specialFireTick?: number
  /** 冲锋锁定的方向（单位向量），冲锋期间不再追踪，给玩家闪避窗口。 */
  specialDirX?: number
  specialDirZ?: number
  /** 特殊技的一次性结算是否已经做过（冲锋命中 / 脉冲已放）。 */
  specialFired?: boolean
  /** 下一次可以起手的 tick。 */
  nextSpecialTick?: number
  /** 召唤是否已经用过（车长半血只吹一次哨）。 */
  summonUsed?: boolean
}

export interface MonsterSenses {
  /** 目标玩家。 */
  x: number; z: number; alive: boolean; id: number
}

export interface BossPulse {
  /** 脉冲圆心（怪物脚下）。 */
  x: number
  y: number
  z: number
  radius: number
  damage: number
}

export interface BossSummon {
  kind: MonsterKind
  count: number
}

/** 返回本 tick 想施加给玩家的伤害（0 表示没打到）。 */
export interface MonsterStepResult {
  /** 本 tick 的**近战**伤害，null = 没咬到。远程怪恒为 null。 */
  hit: { playerId: number; damage: number } | null
  /**
   * 本 tick 该扣扳机了：由服务端拿物理世界解算命中（墙、胶囊、散布），
   * AI 这边只报"对谁开火"。远程怪之外恒为 null。
   */
  shot: { playerId: number } | null
  /** 本 tick Boss 的范围脉冲。 */
  pulse: BossPulse | null
  /** 本 tick Boss 召唤小怪。 */
  summon: BossSummon | null
  /** 攻击动作发生了（用于广播挥击事件/音效），与 hit 独立。 */
  attacked: boolean
  /** 状态是否刚刚从非 chase 变为 chase（用于播叫声）。 */
  aggroed: boolean
}

/**
 * 攻击间隔换算成 tick 数，**向上取整**。
 *
 * 向下取整或四舍五入会让实际冷却比设计值短一两个 tick，几个怪叠在一起时
 * 就是玩家凭空多挨的伤害。宁可多等一 tick。
 */
function cooldownTicks(spec: MonsterSpec): number {
  return Math.max(1, Math.ceil(spec.attackIntervalMs / TICK_MS))
}

/**
 * 推进一个怪物的一个 tick：只决定状态、目标与**期望速度**，不移动位置。
 *
 * 调用顺序约定：先在这里算完 vx/vz，再由调用方积分 x/z，并用 Rapier 的
 * shape cast 做几何分离（撞墙就归零那一维速度）。垂直方向（台阶、坠落）
 * 也归调用方 —— 怪物本身不会飞。
 *
 * 所有分支只写局部变量，唯一的一次速度归一化与夹紧放在出口：将来加分支
 * 时不可能漏掉"不超过 spec.speed"这条铁律。
 */
export function stepMonster(
  monster: Monster,
  senses: {
    players: MonsterSenses[]
    tick: number
    dtMs: number
    /**
     * 视线判定，**只有远程怪会调用**（近战怪不关心你能不能看见它）。
     *
     * 由调用方用物理世界打一条射线实现；本模块保持纯函数，所以只能拿回调。
     * 不传就当作"全都看得见" —— 单元测试和单机调试不必为了开一枪去建一个
     * 物理世界。
     */
    visible?: (player: MonsterSenses) => boolean
  },
  rng: () => number,
): MonsterStepResult {
  const spec = MONSTER_SPECS[monster.kind]
  const players = senses.players
  const tick = senses.tick
  const dtMs = senses.dtMs

  // 死亡放在最前面短路：尸体不决策、不移动、不咬人。
  if (monster.state === 'dead' || monster.health <= 0) {
    monster.state = 'dead'
    monster.health = 0
    monster.vx = 0
    monster.vz = 0
    monster.targetId = 0
    monster.aggroMs = 0
    return { hit: null, shot: null, pulse: null, summon: null, attacked: false, aggroed: false }
  }

  const wasAggro = monster.targetId !== 0
  const homeDist = Math.hypot(monster.x - monster.homeX, monster.z - monster.homeZ)

  // 远程怪只能对"看得见的人"开火。近战怪不走这条路：它们循声/循味扑过来，
  // 隔着一堵墙朝你那边挪是完全合理的行为，而隔着一堵墙开枪不是。
  const ranged = spec.ranged
  const see = ranged && senses.visible ? senses.visible : null
  const canSee = (p: MonsterSenses): boolean => (see === null ? true : see(p))

  // 已经脱战（idle）且不在巢穴里：它现在只想回家，到家之前不再索敌。
  // 不这样做的话，怪物会在 leash 边界上"追出去 → 被拉回 → 再追出去"地
  // 无限往返，玩家看到的就是一只抽搐的狗。
  const returningHome = monster.state === 'idle' && homeDist > HOME_ARRIVE_RADIUS

  // ---------------------------------------------------------------- 选目标
  // 当前目标还有效吗？只扫一遍数组，不建任何中间集合（每 tick 每怪都要跑）。
  let curDist = -1
  let curX = 0
  let curZ = 0
  if (monster.targetId !== 0) {
    for (let i = 0; i < players.length; i++) {
      const p = players[i]
      if (p.id !== monster.targetId) continue
      if (p.alive) {
        const d = Math.hypot(p.x - monster.x, p.z - monster.z)
        // 目标跑得比牵引绳还远，等于跟丢了 —— 追下去只会把怪带离巢穴。
        if (d <= spec.leashRange) {
          curDist = d
          curX = p.x
          curZ = p.z
        }
      }
      break
    }
  }

  // 最近的活人（纯水平距离；视线/掩体由调用方判，这里不打射线）。
  let bestId = 0
  let bestDist = Infinity
  let bestX = 0
  let bestZ = 0
  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    if (!p.alive) continue
    // 远程怪开火前必须看得见人；近战怪照旧（它们循声扑过来，隔墙也合理）。
    if (see !== null && !canSee(p)) continue
    const d = Math.hypot(p.x - monster.x, p.z - monster.z)
    if (d > spec.aggroRange) continue
    if (d < bestDist) {
      bestDist = d
      bestId = p.id
      bestX = p.x
      bestZ = p.z
    }
  }

  let targetId = 0
  let targetX = 0
  let targetZ = 0
  let targetDist = 0
  if (curDist >= 0) {
    // 有滞回：只有新目标近 20% 以上才换人，否则保持原目标。
    // 这一条判断就是"怪物别在原地左右抽搐"的全部实现。
    if (bestId !== 0 && bestId !== monster.targetId && bestDist < curDist * TARGET_SWITCH_RATIO) {
      targetId = bestId
      targetX = bestX
      targetZ = bestZ
      targetDist = bestDist
    } else {
      targetId = monster.targetId
      targetX = curX
      targetZ = curZ
      targetDist = curDist
    }
  } else if (!returningHome) {
    targetId = bestId
    targetX = bestX
    targetZ = bestZ
    targetDist = bestDist
  }

  if (targetId === 0) {
    // 跟丢：愣神计时归零，下次再看见人还要重新愣满 AGGRO_WINDUP_MS。
    monster.targetId = 0
    monster.aggroMs = 0
  } else {
    // 换人（而不是跟丢）也重置愣神计时：对新受害者它同样是"刚发现"。
    if (targetId !== monster.targetId) monster.aggroMs = 0
    monster.targetId = targetId
    monster.aggroMs += dtMs
  }

  // 目标此刻看得见吗？只对远程怪算：近战怪的决策里根本没有"视线"这回事。
  // 锁定的目标**掉出视线也不立刻放弃**（上面选目标那一段不看视线），
  // 它会走到你最后露头的位置再重新找 —— 蹲在石头后面能拖时间，但拖不掉它。
  let targetVisible = false
  if (ranged !== undefined && targetId !== 0) {
    for (let i = 0; i < players.length; i++) {
      const p = players[i]
      if (p.id !== targetId) continue
      targetVisible = p.alive && canSee(p)
      break
    }
  }

  // ------------------------------------------------------- 决策：只定"想去哪"
  let goalX = monster.x
  let goalZ = monster.z
  let goalSpeed = 0
  /** 这一 tick 允许的速度上限。冲锋会临时抬高它，普通分支仍受 spec.speed 限制。 */
  let speedCap = spec.speed
  let wander = false
  let attacked = false
  let hit: MonsterStepResult['hit'] = null
  let shot: MonsterStepResult['shot'] = null
  let pulse: MonsterStepResult['pulse'] = null
  let summon: MonsterStepResult['summon'] = null

  if (homeDist > spec.leashRange) {
    // 牵引绳拉满：无条件脱战。即便玩家就在咬合范围内也照样回家 ——
    // 这正是"把怪拖回巢穴"对玩家的意义。
    monster.state = 'idle'
    monster.targetId = 0
    monster.aggroMs = 0
    goalX = monster.homeX
    goalZ = monster.homeZ
    goalSpeed = spec.speed
  } else if (monster.targetId === 0) {
    monster.state = 'idle'
    if (returningHome) {
      goalX = monster.homeX
      goalZ = monster.homeZ
      goalSpeed = spec.speed * RETURN_SPEED_FACTOR
    } else {
      // 到家的怪不能是雕像：用 rng 做一点缓慢游荡（全文件只有这里用 rng）。
      wander = true
    }
  } else {
    // 召唤只结算一次：车长半血吹哨，两只猎犬从它身边站起来。
    if (
      spec.summon !== undefined &&
      monster.summonUsed !== true &&
      monster.health <= spec.maxHealth * spec.summon.healthPct
    ) {
      monster.summonUsed = true
      summon = { kind: spec.summon.kind, count: spec.summon.count }
      attacked = true
      // 吹哨的 700ms 里站定：这是玩家看见"它在叫帮手"的窗口。
      if (tick >= (monster.specialUntilTick ?? 0)) {
        monster.specialUntilTick = tick + Math.ceil(700 / TICK_MS)
        monster.specialFireTick = tick
        monster.specialFired = true
      }
    }

    const specialUntil = monster.specialUntilTick ?? 0
    if (tick < specialUntil) {
      // ---------------------------------------------------------- 特殊技进行中
      monster.state = 'special'
      const fireTick = monster.specialFireTick ?? 0
      if (spec.charge !== undefined) {
        if (tick < fireTick) {
          // 前摇：站定、抬武器。玩家看见它不动了，就该横移。
          goalSpeed = 0
        } else {
          speedCap = spec.speed * spec.charge.speedScale
          goalSpeed = speedCap
          const dirX = monster.specialDirX ?? 0
          const dirZ = monster.specialDirZ ?? 0
          goalX = monster.x + dirX * 50
          goalZ = monster.z + dirZ * 50
          if (
            monster.specialFired !== true &&
            targetDist <= spec.attackRange + 0.6 &&
            tick >= monster.nextAttackTick
          ) {
            monster.specialFired = true
            attacked = true
            hit = { playerId: monster.targetId, damage: spec.charge.damage }
            monster.nextAttackTick = tick + cooldownTicks(spec)
            // 撞上就停：冲过去之后继续往前滑会把玩家推走。
            monster.specialUntilTick = tick + 1
          }
        }
      } else if (spec.pulse !== undefined) {
        goalSpeed = 0
        if (monster.specialFired !== true && tick >= fireTick) {
          monster.specialFired = true
          attacked = true
          pulse = {
            x: monster.x,
            y: monster.y,
            z: monster.z,
            radius: spec.pulse.radius,
            damage: spec.pulse.damage,
          }
        }
      }
    } else {
      // ------------------------------------------------------------ 特殊技起手
      let started = false
      if (
        spec.charge !== undefined &&
        tick >= (monster.nextSpecialTick ?? 0) &&
        monster.aggroMs >= AGGRO_WINDUP_MS &&
        targetDist >= spec.charge.minRange &&
        targetDist <= spec.charge.maxRange
      ) {
        const dx = targetX - monster.x
        const dz = targetZ - monster.z
        const len = Math.hypot(dx, dz) || 1
        const windupTicks = Math.max(1, Math.ceil(spec.charge.windupMs / TICK_MS))
        const durationTicks = Math.max(1, Math.ceil(spec.charge.durationMs / TICK_MS))
        monster.specialDirX = dx / len
        monster.specialDirZ = dz / len
        monster.specialFireTick = tick + windupTicks
        monster.specialUntilTick = tick + windupTicks + durationTicks
        monster.nextSpecialTick = tick + Math.ceil(spec.charge.cooldownMs / TICK_MS)
        // 冲锋落空后不要立刻接一记普通挥击：那会让"躲开了"反而吃两下。
        monster.nextAttackTick = tick + windupTicks + durationTicks + Math.ceil(350 / TICK_MS)
        monster.specialFired = false
        monster.state = 'special'
        goalSpeed = 0
        started = true
      } else if (
        spec.pulse !== undefined &&
        tick >= (monster.nextSpecialTick ?? 0) &&
        monster.aggroMs >= AGGRO_WINDUP_MS &&
        targetDist <= spec.pulse.maxRange
      ) {
        const windupTicks = Math.max(1, Math.ceil(spec.pulse.windupMs / TICK_MS))
        // 落地后多留 250ms 收势，客户端才有时间把砸地/钟摆动作播完。
        monster.specialFireTick = tick + windupTicks
        monster.specialUntilTick = tick + windupTicks + Math.ceil(250 / TICK_MS)
        monster.nextSpecialTick = tick + Math.ceil(spec.pulse.cooldownMs / TICK_MS)
        // 钟声/砸地落地后给 350ms 的收势，别让脉冲和普通挥击同一 tick 叠伤害。
        monster.nextAttackTick = tick + windupTicks + Math.ceil(350 / TICK_MS)
        monster.specialFired = false
        monster.state = 'special'
        goalSpeed = 0
        started = true
      }

      if (!started) {
        if (ranged !== undefined && !targetVisible) {
          // 看不见人：往前走，去最后看见他的地方。开不了火就不假装能开火。
          monster.state = 'chase'
          goalX = targetX
          goalZ = targetZ
          goalSpeed = spec.speed * REPOSITION_SPEED_FACTOR
        } else if (
          ranged !== undefined &&
          spec.keepDistance !== undefined &&
          targetDist < spec.keepDistance
        ) {
          // 贴太近：一边后撤一边重新找枪线。它不是逃，是把距离还给枪。
          monster.state = 'chase'
          const dx = monster.x - targetX
          const dz = monster.z - targetZ
          const len = Math.hypot(dx, dz) || 1
          goalX = monster.x + (dx / len) * 8
          goalZ = monster.z + (dz / len) * 8
          goalSpeed = spec.speed * 0.65
        } else if (ranged !== undefined && targetDist > spec.attackRange) {
          // 还在射程外：贴到射程边缘。16m 的射程是打出来的，不是站着够到的。
          monster.state = 'chase'
          goalX = targetX
          goalZ = targetZ
          goalSpeed = spec.speed
        } else if (ranged !== undefined) {
          // 站定开枪。瞄准时间与愣神窗口取大者：900ms 的抬枪动作就是玩家能看见、
          // 能躲开的那段时间，低于它这一枪就变成"无故掉血"。
          monster.state = 'attack'
          goalSpeed = 0
          const aimMs = Math.max(AGGRO_WINDUP_MS, ranged.aimMs)
          if (monster.aggroMs >= aimMs && tick >= monster.nextAttackTick) {
            attacked = true
            // 贴到脸上还开枪很难看，也打不中（胶囊在枪口内），改用啃的。
            if (targetDist <= MELEE_PANIC_RANGE) {
              hit = { playerId: monster.targetId, damage: spec.attackDamage }
            } else {
              shot = { playerId: monster.targetId }
            }
            monster.nextAttackTick = tick + cooldownTicks(spec)
          }
        } else if (targetDist > spec.attackRange) {
          monster.state = 'chase'
          goalX = targetX
          goalZ = targetZ
          goalSpeed = spec.speed
        } else {
          // 站定挥击，而不是继续顶着玩家往前挤 —— 否则它会把玩家从掩体后推走。
          monster.state = 'attack'
          goalSpeed = 0
          // 两道闸门：愣神窗口（针对"刚发现你"）与冷却（针对"已经打过一次"）。
          // 伤害就落在这一 tick 上，不做延迟结算的"前摇帧"：前摇已经由
          // AGGRO_WINDUP_MS 表达了，再加一层只会让命中判定和动画对不上。
          if (monster.aggroMs >= AGGRO_WINDUP_MS && tick >= monster.nextAttackTick) {
            attacked = true
            hit = { playerId: monster.targetId, damage: spec.attackDamage }
            monster.nextAttackTick = tick + cooldownTicks(spec)
          }
        }
      }
    }
  }

  // ------------------------------------------------------------- 写回速度
  if (wander) {
    // 先阻尼衰减再加一点随机推力：阻尼保证它不会越游越远、最终会停下来，
    // 随机推力保证它不是在原地当雕像。公式按秒计算，与帧率无关。
    const dtSec = dtMs / 1000
    const damp = Math.max(0, 1 - WANDER_DAMPING * dtSec)
    monster.vx *= damp
    monster.vz *= damp
    const angle = rng() * Math.PI * 2
    monster.vx += Math.cos(angle) * WANDER_ACCEL * dtSec
    monster.vz += Math.sin(angle) * WANDER_ACCEL * dtSec
    const maxWander = spec.speed * WANDER_SPEED_FACTOR
    const len = Math.hypot(monster.vx, monster.vz)
    if (len > maxWander) {
      const s = maxWander / len
      monster.vx *= s
      monster.vz *= s
    }
  } else if (goalSpeed <= 0) {
    monster.vx = 0
    monster.vz = 0
  } else {
    const dx = goalX - monster.x
    const dz = goalZ - monster.z
    const dist = Math.hypot(dx, dz)
    if (dist < 1e-4) {
      monster.vx = 0
      monster.vz = 0
    } else {
      // 唯一的夹紧点：普通分支不可能让怪物跑得比 spec.speed 更快；只有冲锋
      // 通过 speedCap 临时抬高上限（而且仍有 windup 与冷却两道闸）。
      const speed = goalSpeed < speedCap ? goalSpeed : speedCap
      monster.vx = (dx / dist) * speed
      monster.vz = (dz / dist) * speed
    }
  }

  return {
    hit,
    shot,
    pulse,
    summon,
    attacked,
    // 从"没有目标"变成"有目标"就算 aggro：包括一进范围就贴脸、
    // 直接跳过 chase 落到 attack 的情况，玩家同样该听到那声叫。
    aggroed: !wasAggro && monster.targetId !== 0,
  }
}

/**
 * 在指定位置精确摆一只怪（不带任何随机）。
 *
 * 关卡里手工摆放的怪、以及单元测试都必须走这个：它给出的是一个逐位可复现的
 * 初始状态。要"活"一点的出生请用 spawnMonster。
 */
export function monsterAtPosition(
  kind: MonsterKind,
  home: { x: number; y: number; z: number },
  id: number,
): Monster {
  const spec = MONSTER_SPECS[kind]
  return {
    id,
    kind,
    state: 'idle',
    x: home.x,
    y: home.y,
    z: home.z,
    vx: 0,
    vz: 0,
    health: spec.maxHealth,
    homeX: home.x,
    homeZ: home.z,
    // 0 = "冷却早就好了"。第一次攻击的真实延迟由 aggroMs 的愣神窗口负责，
    // 别在这里再叠一层等待，否则新刷的怪会站着发呆整整一个攻击间隔。
    nextAttackTick: 0,
    targetId: 0,
    aggroMs: 0,
    specialUntilTick: 0,
    specialFireTick: 0,
    specialDirX: 0,
    specialDirZ: 0,
    specialFired: false,
    nextSpecialTick: 0,
    summonUsed: false,
  }
}

/**
 * 生成一只怪：位置在巢穴半径内散开，并错开第一次挥击的节拍。
 *
 * 位置和 home 一起抖动是关键 —— 只抖位置会让怪物一出生就落进"回家"分支，
 * 先退回巢心才开始索敌，看起来像刚睡醒；而一群同时刷出的怪如果节拍一致，
 * 就会整齐划一地同时咬人，那份伤害是设计之外的。
 */
export function spawnMonster(
  kind: MonsterKind,
  id: number,
  home: { x: number; y: number; z: number },
  rng: () => number,
): Monster {
  const spec = MONSTER_SPECS[kind]
  const angle = rng() * Math.PI * 2
  // sqrt 让落点在整个圆面上均匀，而不是挤在圆心。
  const r = Math.sqrt(rng()) * SPAWN_SCATTER
  const x = home.x + Math.cos(angle) * r
  const z = home.z + Math.sin(angle) * r
  const monster = monsterAtPosition(kind, { x, y: home.y, z }, id)
  monster.nextAttackTick = Math.floor(rng() * cooldownTicks(spec))
  return monster
}

/**
 * 对怪物施加伤害，返回**这次伤害是否打死了它**。
 *
 * 已经死掉的怪再挨枪返回 false（不重复触发死亡事件/掉落）。
 */
export function damageMonster(monster: Monster, damage: number, tick: number): boolean {
  if (monster.state === 'dead' || monster.health <= 0) return false
  // 负伤害当成 0：治疗走别的路径，绝不能让"负伤害"变成回血的后门。
  monster.health -= damage > 0 ? damage : 0
  if (monster.health > 0) return false

  monster.health = 0
  monster.state = 'dead'
  monster.vx = 0
  monster.vz = 0
  monster.targetId = 0
  monster.aggroMs = 0
  // 把冷却结算到"现在"：将来接复活机制时，尸体站起来也不会白打一记。
  monster.nextAttackTick = tick
  return true
}

/**
 * 怪物的受击胶囊参数，**全部由 spec 推导**。
 *
 * 服务端拿它建 Rapier 的 ColliderDesc.capsule(halfHeight, radius)，
 * 所以 halfHeight 是圆柱段的一半（不是总高的一半），总高恒等于 spec.height：
 * 改了尺寸表，模型和判定一起变，不存在"看得见打不到"的那道缝。
 * y 是胶囊**中心**高度，约定与 Character 一致（脚底 + halfHeight + radius）。
 */
export function monsterHurtbox(monster: Monster): {
  x: number
  y: number
  z: number
  radius: number
  halfHeight: number
} {
  const spec = MONSTER_SPECS[monster.kind]
  // 半径吃掉整个高度时（矮的四足胶囊）圆柱段退化成 0，仍是一个合法胶囊。
  const halfHeight = Math.max(0, spec.height / 2 - spec.radius)
  return {
    x: monster.x,
    y: monster.y + halfHeight + spec.radius,
    z: monster.z,
    radius: spec.radius,
    halfHeight,
  }
}
