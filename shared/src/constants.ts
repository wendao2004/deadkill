/**
 * 全局常量：凡是两端都必须一致的值，只能写在这里。
 *
 * 任何一个数字如果客户端一份、服务端另一份，表现就是"预测的位置和真实位置
 * 慢慢错开"或者"我打中了不算"——这类 bug 极难定位，所以宁可在网络包体上
 * 多花几个字节，也不允许两边各写一份。
 */

/**
 * 协议版本。
 *
 * 连接握手时逐字比对，不一致直接拒绝。**不要**做"向下兼容"：
 * 二进制协议里字段错位的后果是静默解析出乱数据，比连不上难查得多。
 */
// 2 = 快照头加了 u16 怪物计数、玩家段之后多出 20 字节怪物记录，并新增两种事件。
// 旧客户端连着新服务端会把怪物头当成第一个玩家解析，读到一坨垃圾位置 —— 所以必须硬拒。
// 3 = 玩家段多了 1 字节 slot（33 → 34 字节），StateFlags 多了 Switching 位。
// v2 客户端若连上 v3 服务端，第 34 字节会被当成下一个玩家记录的 id 高字节，
// 整段玩家记录集体错位 —— 同样是"必须硬拒"而不是"凑合解析"。
// 4 = 目标包多了尾部的 clueMask（14 → 15 字节）。旧客户端读到的 secondsLeft 是对的，
// 但线索光柱会按 "前 N 条" 点亮，跟服务端"就近任意顺序"的规则对不上，所以一起硬拒。
// 5 = 新增怪物种类 Gunner(2) 与事件 MonsterShot(7)。旧客户端不认识事件 7，解码时
// 会把它当 Respawn 读 16 字节 —— 整包事件集体错位，所以同样硬拒。
// 6 = 配装包尾部多了 u32 天赋掩码（3 → 7 字节），战利品包尾部多了绷带数与包扎进度
// （9 → 11 字节）。旧客户端会按旧偏移读物品条数，把绷带数当成 amount 越界 —— 硬拒。
// 7 = 目标包尾部多了 modifier（15 → 16 字节），怪物种类多了 Boss(3)。旧客户端读到
// 的 modifier 位置是它自己的包尾之后，整包少一字节会直接 RangeError；而 Boss 会被
// 当成非法种类丢掉 —— 一个看不见的 Boss 比连不上更糟，所以硬拒。
// 8 = 战利品包的 spot id 从"只允许 -1"放宽到 -1..-64：-2..-64 是动态尸体缓存。
// 旧客户端会把 -2 当非法下标忽略，表现为"走到尸体上没有提示"，不会崩溃；但尸体
// 缓存是 P0 循环的一部分，两端语义必须一致，所以一起硬拒。
// 9 = Input 包尾部多了 aimYaw/aimPitch 两个 u16（15 → 19 字节）：移动朝向与
// 瞄准朝向拆开，后坐力只推弹道不推 WASD。旧客户端少 4 字节，整段后续输入全部错位。
// 10 = 玩家快照多了 reserve（34 → 35 字节）：换弹要从备弹池扣，HUD 要显示余量。
// 旧客户端会把 slot/ackSeq 整体读偏一字节 —— 必须硬拒。
// 11 = 四种地图 Boss（种类码 3..6）、怪物状态 Special(4) 与事件 BossPulse(8)。
// 旧客户端不认识种类 4..6 会直接丢掉 Boss（看不见的 Boss 比连不上更糟），
// 事件 8 还会被当成 Respawn 读 16 字节 —— 所以硬拒。
export const PROTOCOL_VERSION = 15

/**
 * 服务端模拟频率（Hz）。
 *
 * 60 而不是 30：移动的合法性判定、命中射线、延迟补偿都跑在这个频率上。
 * 30Hz 下高速横移的角色每帧走 0.2m，射线容易在两次采样之间"穿过去"。
 * Rapier 的角色控制器本质是 shape cast，不是完整刚体模拟，16 人的
 * 单次 tick 约 0.1ms —— 60Hz 的 CPU 代价可以忽略。
 */
export const TICK_RATE = 60
export const TICK_MS = 1000 / TICK_RATE
export const TICK_DT = 1 / TICK_RATE

/**
 * 快照下发频率（Hz）。
 *
 * 20Hz 远低于模拟频率：客户端用插值（interpolation）把 20Hz 的快照
 * 平滑成 60fps 的画面。这是所有现代射击游戏的通行做法 —— 提高快照频率
 * 的带宽/CPU 收益远小于它的成本，而插值带来的额外 50ms 视觉延迟
 * 由客户端预测（自己）和延迟补偿（打别人）抵消掉。
 */
export const SNAPSHOT_RATE = 20
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_RATE
export const SNAPSHOT_HISTORY = 32

/** 单个包最多携带多少个输入（客户端掉帧/丢包后的补发上限）。 */
export const MAX_INPUTS_PER_PACKET = 8

/** 服务端为延迟补偿保留的历史时长上限。 */
export const MAX_REWIND_MS = 250

/**
 * 客户端把远端角色"延后多少毫秒"播放（插值延迟）。
 *
 * 这个数字**两端都必须知道**：客户端拿它决定画谁在哪，服务端拿它决定
 * 射线该回到哪个时刻的靶子。少了这一项，玩家瞄准的是 90ms 前的位置，
 * 而服务端拿的是"最新一帧"，横向跑动的人在 90ms 里能挪 0.5m —— 正好是
 * 一个身位，表现就是"明明打在胸口却没中"。
 */
export const INTERP_DELAY_MS = 90

/**
 * 怪物 id 从这里起编号，玩家 id 从 1 起。
 *
 * 共用一个 u16 id 空间是刻意的：`DeathEvent.killerId` 只有一个字段，
 * 如果玩家和怪物各占一套编号，"被怪咬死"就必须多一种事件，否则客户端
 * 拿到 killerId 无从判断该显示谁。分界线在 16384，玩家上限 16、
 * 怪物上限 60，两边都碰不到对方。
 */
export const MONSTER_ID_BASE = 0x4000

/**
 * 旧版怪物重生间隔（毫秒）。
 *
 * 当前规则是**本局怪物不重生**（死亡永久，巢穴可以被真正清空），服务端不再
 * 使用这个常量；保留导出是给自定义模式/回滚留一个明确的时间基准。
 */
export const MONSTER_RESPAWN_MS = 12_000

// ---------------------------------------------------------------- 角色

/** 胶囊体半高（圆柱部分的一半）。加上半径后总高 = 0.6*2 + 0.35*2 = 1.9m */
export const PLAYER_HALF_HEIGHT = 0.6
export const PLAYER_RADIUS = 0.35
/** 眼睛相对脚底的高度 —— 射线起点。 */
export const PLAYER_EYE_HEIGHT = 1.62
export const PLAYER_CROUCH_EYE_HEIGHT = 1.15
/** 蹲下时的胶囊半高。 */
export const PLAYER_CROUCH_HALF_HEIGHT = 0.35

/** 角色控制器胶囊与地面之间保留的间隙，防止贴面抖动。 */
export const CHARACTER_OFFSET = 0.02

/**
 * 重力与跳跃：-9.81 × 2.1，跳跃顶点 0.60m。
 *
 * 数值来自源码的 120Hz 手感调校；在 60Hz 下用同一组 dt 积分，顶点与滞空
 * 时间不变（只取决于 v²/2g 与 2v/g），所以不需要按 tick 频率重调。
 */
export const GRAVITY = -20.601
export const JUMP_SPEED = 4.972

/** 站立 / 冲刺 / 蹲 / 开镜速度。ADS 是走速的 0.5 倍。 */
export const SPEED_WALK = 4.57
export const SPEED_SPRINT = 7.01
export const SPEED_CROUCH = 2.44
export const SPEED_ADS = 2.285

/** 方向权重：横移慢 8%，倒退慢 20%。斜向不能比直向快。 */
export const STRAFE_SCALE = 0.92
export const BACK_SCALE = 0.8

/**
 * 地面响应（m/s²）。加速 92：0→走速约 50ms，这是"跟手"的来源；
 * 减速 52 留一小段滑行尾巴；完全松手时用 30 的停止减速度。
 */
export const GROUND_ACCEL = 92
export const GROUND_DECEL = 52
export const STOP_DECEL = 30

/** 空中控制：四分之一的权限，且只能把沿 wish 方向的速度补到 3.4 m/s。 */
export const AIR_ACCEL_SCALE = 0.25
export const AIR_SPEED_CAP = 3.4

/** 终端下落速度。 */
export const TERMINAL_SPEED = 55

/** 冲刺：前向意图超过 0.55 才成立，按住 0.05s 后达到冲刺速度。 */
export const SPRINT_FORWARD_DOT = 0.55
export const SPRINT_START_DELAY = 0.05
/**
 * 松开 Shift 后冲刺速度回落到步行的时间（秒）。
 *
 * 之前松手当帧就切回 SPEED_WALK，速度目标骤降 2.4m/s，50 多的减速度
 * 让角色像"撞了一下空气"。0.34s 的渐变让收步是"滑停"而不是"急刹"。
 */
export const SPRINT_FADE_TIME = 0.34

/** 跳跃的容错窗口：离地后仍可起跳 / 落地前预输入 / 两次跳跃间隔。 */
export const COYOTE_TIME = 0.09
export const JUMP_BUFFER = 0.13
export const JUMP_COOLDOWN = 0.28

/**
 * 滑铲：冲刺中按下蹲触发。
 *
 * 手感的关键是**两段阻力**而不是一条曲线：前 0.22s 几乎不减速（人还在
 * 惯性里），之后才明显刹车。把两段压成一段，要么"滑不远"，要么"一直是
 * 全速"，两种都不像滑铲。
 */
export const SLIDE_ENTRY_SPEED = 9.2
export const SLIDE_MIN_ENTRY = 6.4
export const SLIDE_EXIT_SPEED = 2.4
export const SLIDE_DURATION = 1.15
/** 爆发段时长：这之前只受很小的阻力。 */
export const SLIDE_BOOST_TIME = 0.22
/** 爆发段的阻力系数。 */
export const SLIDE_DRAG_LOW = 0.18
/** 刹车段的指数阻力。 */
export const SLIDE_DRAG = 1.05
/** 刹车段的线性制动（m/s²）。 */
export const SLIDE_BRAKE = 0.55
export const SLIDE_COOLDOWN = 0.42
export const SLIDE_MIN_SPEED_TO_START = 5.4
export const SLIDE_STEER = 3.4
/** 滑铲取消（早松蹲）时补的一小口速度：给"站得起来"一点回报。 */
export const SLIDE_CANCEL_BOOST = 0.8

// ---------------------------------------------------------------- 翻越

/**
 * 自动翻越：跳向一个 0.5~1.3m 的台面时，不再"撞墙 + 原地跳"，而是
 * 撑上去。下界高于自动台阶（0.4m），上界低于一堵必须绕的墙。
 */
export const VAULT_MIN_HEIGHT = 0.5
export const VAULT_MAX_HEIGHT = 1.3
/** 从胸口向前的探测距离（米）。 */
export const VAULT_REACH = 0.95
/** 翻越过程时长（秒）。 */
export const VAULT_TIME = 0.34
/** 翻越时的水平推进速度（米/秒）。0.34s × 4.2 ≈ 1.4m，正好越过一个台面。 */
export const VAULT_SPEED = 4.2

// ---------------------------------------------------------------- 攀爬 / 蹬墙跳

/** 贴墙后的爬升速度（米/秒）。 */
export const CLIMB_SPEED = 2.4
/**
 * 一次攀爬的持续时间。
 *
 * 2.4 × 0.55 ≈ 1.3m：够完成"扒墙 → 蹬墙跳"，但爬不到 3m 高的房顶。
 * 之前 1.1s（2.6m）+ 顶部自动翻越，配合普通箱子就能直接上楼顶。
 */
export const CLIMB_TIME = 0.55
/** 从胸口到墙面的探测距离。 */
export const CLIMB_REACH = 0.62
/** 松手/蹬墙跳后的再抓取冷却。 */
export const CLIMB_COOLDOWN = 0.4
/** 贴墙时朝墙里按的速度（米/秒），避免爬升途中脱离墙面。 */
export const CLIMB_STICK = 0.25
/** 蹬墙跳：水平推力与向上速度。 */
export const WALL_JUMP_PUSH = 5.4
export const WALL_JUMP_UP = 4.7

/** 最大生命值。两枪躯干或一枪头致死 —— 猎杀类的核心节奏。 */
export const MAX_HEALTH = 150

/** 死亡到复活的等待时间。15 秒：比 30 秒更快回到战场，但不至于死亡没有代价。 */
export const RESPAWN_DELAY_MS = 15_000

/**
 * 击杀一名玩家直接进击杀者携带价值的现金。
 *
 * 50 美元：不够改变经济曲线，但足以让"我看到人了，要不要打"多一个正向答案。
 * 更大的收益仍然在尸体缓存里（死者的现金/物品/赏金），必须走过去拿。
 */
export const KILL_REWARD = 50

/**
 * 出生自带的绷带数。
 *
 * 1 条不是"补给充足"，而是安全网：3/4 的地图在补齐搜刮点前可能搜不到绷带，
 * 玩家至少有一次止血机会；同时它让"什么时候扎"从开局起就是一个决策。
 */
export const STARTING_BANDAGES = 1

/** 尸体缓存的保留时长（毫秒）。120 秒够打完一场遭遇战再回来摸尸体。 */
export const BODY_CACHE_TTL_MS = 120_000

/**
 * 断线后角色保留时长（毫秒）。
 *
 * 20 秒足够客户端完成 3 次指数退避重连；超过这个时间还没回来，角色按正常
 * 退出移除，避免半开连接/坏掉的标签页永久占一个玩家槽位和碰撞体。
 */
export const DISCONNECT_GRACE_MS = 20_000

/**
 * 头部命中判定带：以脚底为原点，超过这个高度算爆头。
 *
 * P0 用"命中点高度"近似，而不是给每个玩家加一个独立的头部碰撞球：
 * 后者会让碰撞体数量翻倍，且两端的胶囊/球组合必须在服务端和客户端
 * 完全一致才不出现"看到打中头却不算"。近似法不会更好，但不会有
 * 两端不一致的风险，等地图有了掩体和斜坡再换。
 */
export const HEAD_MIN_HEIGHT = 1.45

// ---------------------------------------------------------------- 世界

/** 一个世界（房间）最多容纳多少人。 */
export const MAX_PLAYERS = 16

/** 世界里一个玩家都没有多久之后回收 —— Rapier World 占 8~20MB，
 *  512MB 的容器不能无限累积空房间。 */
export const WORLD_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** 单次 tick 最多消费多少条排队输入，防止恶意客户端一次灌爆。 */
export const MAX_INPUTS_PER_TICK = MAX_INPUTS_PER_PACKET

/** 输入 dt 的合法区间（毫秒）。超出直接钳制，不采信客户端声称的"我这一帧过了 3 秒"。 */
export const INPUT_DT_MIN_MS = 1
export const INPUT_DT_MAX_MS = 50

/** 服务端追帧上限：落后太多时一次性最多补多少 tick，避免"补到永远追不上"。 */
export const MAX_CATCHUP_TICKS = 5

// ---------------------------------------------------------------- 输入位

export const Buttons = {
  Jump: 1 << 0,
  Sprint: 1 << 1,
  Crouch: 1 << 2,
  Ads: 1 << 3,
  Fire: 1 << 4,
  Reload: 1 << 5,
  /**
   * 交互（搜刮/拾取）。按下期间持续置位，服务端按持续时间累积搜索进度。
   *
   * 与 Fire 分开是必须的：搜刮时手上还端着枪（heldSlot 不参与判定），
   * 如果复用 Fire，"边搜边开枪"就得靠额外状态位来表达，而这个位天然
   * 是"持续按住"的语义 —— 松开即中断。
   */
  Interact: 1 << 6,
  /**
   * 包扎（打药）。同样按住语义：松开即中断，进度不保留。
   *
   * 独立成一位而不是复用 Interact：一个玩家完全可能同时站在木箱边上又需要先
   * 止血 —— 复用会让"搜刮到一半顺手包扎"变成两个动作抢同一个位。
   */
  Heal: 1 << 7,
} as const

/** 快照里的状态位。 */
export const StateFlags = {
  Grounded: 1 << 0,
  Crouching: 1 << 1,
  Ads: 1 << 2,
  Alive: 1 << 3,
  Reloading: 1 << 4,
  /** 切枪动作还没做完：枪还没举好，开火与换弹都会被服务端拒绝。 */
  Switching: 1 << 5,
  /** 滑铲中：客户端用它做镜头滚转与枪模压低。 */
  Sliding: 1 << 6,
  /** 翻越中：客户端用它播翻越姿势（撑手、收腿、越过台面）。 */
  Vaulting: 1 << 7,
  /** 攀爬中：贴着墙向上爬。flags 从 u8 扩到 u16 就是为了它。 */
  Climbing: 1 << 8,
} as const

// ---------------------------------------------------------------- 搜刮

/**
 * 站在多近才能搜一个点（米，水平距离）。
 *
 * 2.2 米：比一个身位(0.7m)宽得多，容得下"绕着木箱蹭过去"的容错；
 * 又明显小于两个搜刮点之间的最小间距(8m)，保证任何时刻最多只有一个
 * 点落在判定半径里，不会出现"我想搜箱子弹出来的是隔壁袋子"。
 */
export const SEARCH_RADIUS = 2.2

/**
 * 搜完一个点要按住多久（毫秒）。
 *
 * 1.4 秒：足够让"停下来搜"成为一个有风险的决策（对面枪口就指着这个窗口），
 * 又不至于长到让人放弃搜刮 —— 搜打撤的节奏不能被一次翻箱子拖垮。
 * 进度按毫秒累积而不是"按帧计数"：帧率/tick 频率变化时手感不变。
 */
export const SEARCH_MS = 1400

/**
 * 包扎一次要按住多久（毫秒）。
 *
 * 1.8 秒比搜箱子的 1.4 秒更长：包扎是"在战斗间隙赌对面不会这时候冲过来"，
 * 搜刮是"贴着掩体顺手摸一把"。两者节奏必须不同，否则会不会被打断就没有意义。
 */
export const HEAL_MS = 1800

/**
 * 一条绷带恢复多少血。
 *
 * 50 点：满血 150，也就是"从残血回到能再吃一枪"要两条绷带。定得太高（比如
 * 一次回满）会让止血变成免费复活，定得太低就没人愿意站着不动 1.8 秒。
 */
export const HEAL_AMOUNT = 50

/**
 * 带着赏金撤离的额外价值（美元），结算时由服务端加上去。
 *
 * 只在"撤离成功"这一条路径上加：死在半路就一分拿不到，这样"要不要再
 * 多搜一个点"才是个真正的赌注。
 */
export const BOUNTY_VALUE = 500

// ---------------------------------------------------------------- 武器

/**
 * 武器大类。
 *
 * 近战单独一类而不是"magazine 为 0 的枪"：刀不消耗弹药、不走射线、伤害不随
 * 距离衰减，靠 magazine === 0 去反推这三条差异会让每个读代码的人各猜一次。
 */
export type WeaponKind = 'rifle' | 'shotgun' | 'sniper' | 'revolver' | 'knife'

/** 装备槽：0 主武器、1 副武器、2 近战。切枪与默认配装都按槽位编号说话。 */
export type WeaponSlot = 0 | 1 | 2

export interface WeaponSpec {
  id: number
  name: string
  kind: WeaponKind
  slot: WeaponSlot
  /** 躯干基础伤害。 */
  damage: number
  /** 爆头倍率。 */
  headMultiplier: number
  /** 两发之间的最短间隔（毫秒）。 */
  fireIntervalMs: number
  /** 弹匣容量。 */
  magazine: number
  /**
   * 出生时的备弹总数（不含弹匣内）。缺省 = magazine * 4。
   * 0 表示没有备弹（刀）。
   */
  reserve?: number
  /** 换弹时长（毫秒）。 */
  reloadMs: number
  /** 有效射程（米），超出后伤害线性衰减到 40%。 */
  effectiveRange: number
  /** 一次射击射出多少颗弹丸（霰弹枪 > 1）。 */
  pellets: number
  /** 弹丸散布角（弧度）。 */
  spread: number
  /** 开镜后的散布角。 */
  adsSpread: number
  /**
   * 开镜时的额外放大倍数（1 = 只有常规 ADS 收束，不装镜）。
   *
   * 装镜的枪在常规 ADS 收束之上再除一次 FOV：3.8 倍把 55° 压到 14.5°，
   * 才看得清 90 米外那个人的头肩线；不带镜的枪留 1，表现与原来完全一致。
   * 渲染侧只读这一个数，"镜"的第二种含义（镜筒几何）在 viewmodel 里。
   */
  adsZoom?: number
  /**
   * 从别的槽切到这把武器，要多久才算"举好"（毫秒）。
   *
   * 这个值只表达枪的长度、重量和握持姿势，不表达射速：栓动狙击枪从背后
   * 抡到肩上的时间比从枪套里拔一支转轮手枪长一倍，所以它是"枪越长越慢"，
   * 而不是"伤害越高越慢"。
   */
  switchMs: number
  /** 近战攻击距离（米，眼睛到目标皮肤）。只有 kind === 'knife' 用。 */
  meleeRange?: number
  /** 近战扇形判定的半角（弧度）：目标必须落在视线 ±meleeArc 之内。 */
  meleeArc?: number
  /**
   * 枪声的响度：0 = 几乎无声，1 = 全装药枪声（默认 1）。
   *
   * 它同时表达两件事 —— 这声枪响能传多远、以及它有多能招来关注。音频子系统
   * 据此决定衰减半径，将来的 PvE 仇恨系统据此决定多远开始循声摸过来。
   *
   * 目前 **没有任何代码读这个字段**（见 docs/武器表.md 的"惰性字段"一节）：
   * 加它是为了让消音武器的"安静"是一个可调数值，而不是散落在音频代码里的
   * 特判 —— 等音频/仇恨接上时不必回头改武器表。
   */
  loudness?: number
}

/**
 * 从多少倍起算"装了真镜"。
 *
 * 3.0：只有 3.8 倍神射手进镜筒。1.7 倍的温菲尔德与 1.3 倍消音卡宾都用机械
 * 瞄具 —— 把 1.7 倍套进 25vh 的固定镜圈，实际可视角只剩约 16.5°，等于把
 * 玩家的第一次右键变成黑屏。低倍镜的"看得清一点"交给 ADS 的 20° 收束。
 */
export const SCOPE_MIN_ZOOM = 3.0

export const WEAPONS: Record<number, WeaponSpec> = {
  1: {
    id: 1,
    name: '温菲尔德 M1873',
    kind: 'rifle',
    slot: 0,
    damage: 75,
    headMultiplier: 2.2,
    fireIntervalMs: 900,
    magazine: 8,
    reserve: 32,
    reloadMs: 2600,
    effectiveRange: 60,
    pellets: 1,
    spread: 0.012,
    adsSpread: 0.0015,
    // 温菲尔德用燕尾槽机械瞄具：ADS 只做 20° 收束，不进镜筒。
    // （3.8 倍神射手才走 SCOPE_MIN_ZOOM 的镜筒/FOV 倍率。）
    // 全长步枪抵肩要跨过一个身位，但杠杆行程短、握持没有额外动作。
    switchMs: 900,
  },
  2: {
    id: 2,
    name: '双管霰弹枪',
    kind: 'shotgun',
    slot: 0,
    // 加强：贴脸一枪必须能带走一个人。10 颗 × 16 = 160 > 满血 150；
    // 旧的 13 打满也只有 130，胸口零距离还要补一下，霰弹枪的威慑就没了。
    damage: 16,
    headMultiplier: 1.5,
    fireIntervalMs: 300,
    magazine: 2,
    reserve: 20,
    reloadMs: 3200,
    // 16 米内满伤害，超出后线性衰减到 40%，再远只剩心理作用。
    effectiveRange: 16,
    pellets: 10,
    // 腰射 0.09 的锥角在 10 米外已有半人宽，十颗能中三颗就算运气。
    // 收到 0.078，开镜压到 0.042：抬枪瞄准真的能把九颗打在身上 —— 这是"加强"
    // 里最有效的一条，玩家能感到自己练会了这把枪，而不是被随机数支配。
    spread: 0.078,
    adsSpread: 0.042,
    // 全尺寸霰弹枪最沉、重心最偏前，抡起来的惯量比步枪还大。
    switchMs: 1000,
  },
  // 柯尔特 1878 短管双管霰弹枪：把"一枪定生死"做到极致 —— 10 米内满弹丸
  // 一发 180 伤害直接带走，再远衰减断崖式下跌，两发打完就得硬着头皮换弹。
  3: {
    id: 3,
    name: '柯尔特 1878 双管霰弹枪',
    kind: 'shotgun',
    slot: 0,
    damage: 20,
    headMultiplier: 1.4,
    fireIntervalMs: 220,
    magazine: 2,
    reserve: 20,
    reloadMs: 3400,
    effectiveRange: 10,
    pellets: 9,
    spread: 0.07,
    adsSpread: 0.042,
    // 短管是这一把唯一的优势：同样的霰弹，抡起来的半径小一圈。
    switchMs: 850,
    // 注：上面的 damage/range 也随"加强喷子"一起调过（20 × 9 = 180，10 米满伤）。
  },
  // 夏普斯 1874 神射手步枪：栓动 + 光学镜，射速与弹容都极差，
  // 换来的是一发爆头必杀(105×3.6×0.4 的射程下限仍 ≥150)和极高的精度。
  4: {
    id: 4,
    name: '夏普斯 1874 神射手步枪',
    kind: 'sniper',
    slot: 0,
    damage: 105,
    headMultiplier: 3.6,
    // 栓动节奏从 1400 收到 1150：旧值在实战里是"开一枪站着看对面跑掉"，
    // 拉栓的等待比瞄准本身还长。仍比所有连发枪慢，但给第二次机会。
    fireIntervalMs: 1150,
    magazine: 3,
    reserve: 18,
    // 3 发弹仓逐发压弹，3800 太长；3200 让"打空后撤回来再战"仍然有代价。
    reloadMs: 3200,
    effectiveRange: 90,
    pellets: 1,
    spread: 0.009,
    adsSpread: 0.0009,
    // 3.8 倍把 55° 压到 14.5°：90 米外的人头还有 30 像素，这一枪才"能瞄"。
    adsZoom: 3.8,
    // 全长 1.2m 的靶枪 + 光学镜：举起来最慢，切它就是主动放弃这几秒的输出。
    switchMs: 1000,
  },
  // 柯尔特 M1873 转轮手枪：副武器定位 —— 掏枪快、换弹快、散布一般，
  // 中距离三枪躯干才能放倒人，逼你在没子弹时也要贴近到 25 米内。
  5: {
    id: 5,
    name: '柯尔特 M1873 转轮手枪',
    kind: 'revolver',
    slot: 1,
    damage: 62,
    headMultiplier: 2,
    fireIntervalMs: 260,
    magazine: 6,
    reserve: 30,
    reloadMs: 1800,
    effectiveRange: 25,
    pellets: 1,
    spread: 0.02,
    adsSpread: 0.006,
    // 单手从枪套里抽出来就是全部动作，所以切手枪最快 —— 这是它存在的理由。
    switchMs: 600,
  },
  // 温菲尔德 M1873 消音卡宾枪：腰射散布全武器最低 + 响度最低(0.15)，
  // 单发伤害低到要 4 枪，属于"偷袭换命"而不是"对枪"的工具。
  6: {
    id: 6,
    name: '温菲尔德 M1873 消音卡宾枪',
    kind: 'rifle',
    slot: 0,
    damage: 42,
    headMultiplier: 2.4,
    fireIntervalMs: 200,
    magazine: 10,
    reserve: 40,
    reloadMs: 2200,
    effectiveRange: 45,
    pellets: 1,
    spread: 0.005,
    adsSpread: 0.0016,
    // 消音卡宾也走机械瞄具：低倍镜不进镜筒，ADS 的 20° 收束足够看清中距离。
    loudness: 0.15,
    // 比全尺寸步枪短一截、也更轻，但消音器把重心推到前头，抵消了大部分优势。
    switchMs: 850,
  },
  /**
   * 猎刀：近战的兜底手段，不是"第三种枪"。
   *
   * magazine 0 表示**近战不消耗弹药**（不是"没开发第二弹匣机制"）：
   * 刀没有弹匣、不换弹、reloadMs 0，服务端的开火门槛对它直接跳过弹药判断。
   * 伤害 70 意味着两下挥砍带走一个满血人（150），一刀爆头 112 仍需两刀 ——
   * 想靠刀赢必须先把对手打残，否则端着枪的人永远有还手机会。
   */
  10: {
    id: 10,
    name: '猎刀',
    kind: 'knife',
    slot: 2,
    damage: 70,
    headMultiplier: 1.6,
    // 380ms 一次挥砍：比转轮手枪(260)慢，比步枪(900)快得多。
    fireIntervalMs: 380,
    magazine: 0,
    reserve: 0,
    reloadMs: 0,
    effectiveRange: 2.2,
    pellets: 1,
    spread: 0,
    adsSpread: 0,
    // 从腰间抽刀只要 400ms，所以它也是"主武器打空时的最后一招"。
    switchMs: 400,
    meleeRange: 2.4,
    meleeArc: 0.9,
  },
}

export const DEFAULT_WEAPON_ID = 1

/** 近战武器 id。Fire 的分支靠它（或 spec.kind）分流，而不是靠 magazine === 0 猜。 */
export const MELEE_WEAPON_ID = 10

/**
 * 重刀（刀上右键）。
 *
 * 轻刀 70 伤害、300ms 一刀；重刀 2.2 倍伤害、800ms 一次，刀程与扇形都放大。
 * 躯干一刀 154 > 满血 150，所以重刀是"贴脸一击必杀"，代价是挥空后近 1 秒
 * 没有第二次机会。数值放 shared 里，客户端预测动画与服务端判定必须同源。
 */
export const KNIFE_HEAVY_INTERVAL_MS = 800
export const KNIFE_HEAVY_DAMAGE_SCALE = 2.2
export const KNIFE_HEAVY_RANGE = 2.9
export const KNIFE_HEAVY_ARC = 1.15

/** 默认副武器：转轮手枪掏枪最快、弹容最小，正好承担"主武器打空时的保险"。 */
export const DEFAULT_SECONDARY_ID = 5

/**
 * 默认配装：主 / 副 / 刀。
 *
 * 下标就是槽位号，主武器可被玩家选择覆盖（见 weaponForSlot），副武器与刀
 * 目前固定 —— 先让"切枪"这条链路跑通，把可选副武器留给之后的配装系统。
 */
export const DEFAULT_SLOT_ORDER: readonly [number, number, number] = [
  DEFAULT_WEAPON_ID,
  DEFAULT_SECONDARY_ID,
  MELEE_WEAPON_ID,
]

/**
 * 槽位 → 武器 id。主武器吃玩家选的那把，其余槽位走默认配装。
 *
 * 主武器 id 由客户端在握手后自选，服务端不能假设它一定在表里、也一定
 * 是 slot 0 的枪：传个 10（刀）或 999 过来会让开火路径上的 WEAPONS[...]!
 * 变成 undefined.damage。非法输入一律回落到默认主武器，是这里唯一的防线。
 */
export function weaponForSlot(primaryId: number, slot: number): number {
  const primary = WEAPONS[primaryId]?.slot === 0 ? primaryId : DEFAULT_WEAPON_ID
  if (slot === 1) return DEFAULT_SECONDARY_ID
  if (slot === 2) return MELEE_WEAPON_ID
  return primary
}

/**
 * 大厅里能选的主武器，**顺序就是卡片的顺序**。
 *
 * 用白名单而不是"遍历 WEAPONS 里 slot === 0 的全都要"：表里将来会加
 * 训练用/活动用的枪（例如只给 NPC 的型号），那类东西不该出现在选枪界面。
 * 也顺带决定默认值 —— 第一项就是没存过配置时的手里这把。
 */
export const PRIMARY_CHOICES: readonly number[] = [1, 6, 3, 2, 4]

/** 这个 id 是否是可选主武器。UI 与协议解析共用同一条判据。 */
export function isPrimaryChoice(id: number): boolean {
  return PRIMARY_CHOICES.includes(id)
}
