/**
 * 一个 World = 一局对战：一份 Rapier 物理世界 + 一个固定步长的 tick 循环。
 *
 * 四条设计约束，全部为了让"我明明打中了却不算"这类问题不出现：
 *
 * 1. **服务端权威**。客户端发上来的是意图（前后左右、视角、按键），位置在这里算、
 *    伤害在这里判。客户端自己算的那份只用于预测显示。
 * 2. **固定步长**。每 tick 用 `TICK_DT` 推进，不采信客户端声称的 `dtMs`，
 *    否则改一下 dtMs 就能让人物加速。
 * 3. **每 tick 只调一次 `world.step()`**。见 `Character.step` 的注释：
 *    每个角色各 step 一次会把物理时间乘上玩家数。
 * 4. **延迟补偿**。开火时按其他玩家"射击者屏幕上那一刻"的位姿判射线。
 *    不做这件事，200ms 延迟的玩家打横向跑动的目标必然全部空枪；
 *    而"把刚体挪回去"在 Rapier 0.21 里不可行（broad-phase 的 AABB 只在 step() 里
 *    刷新，剪枝会让回滚后的位置打不到），所以玩家胶囊走解析求交，见 tryFire。
 *
 * 时间基准用 `tick * TICK_MS`（单调、可复现），不用 `Date.now()`：
 * 后者会被系统对时、NTP 校正拉一下，导致换弹/复活计时偶尔跳变。
 */

import type { WebSocket } from 'ws'
import {
  Buttons,
  Character,
  DEFAULT_LEVEL,
  DEFAULT_WEAPON_ID,
  EventKind,
  FixedClock,
  INTERP_DELAY_MS,
  BODY_CACHE_TTL_MS,
  DISCONNECT_GRACE_MS,
  KILL_REWARD,
  SPOT_ID_MIN,
  SPOT_ID_NONE,
  STARTING_BANDAGES,
  LOOT_ITEM,
  LOOT_ITEM_NAME,
  MAX_CATCHUP_TICKS,
  MONSTER_ID_BASE,
  MONSTER_RESPAWN_MS,
  MonsterKindCode,
  MonsterStateCode,
  damageMonster,
  MONSTER_SPECS,
  monsterAtPosition,
  monsterHurtbox,
  spawnMonster,
  stepMonster,
  isBossKind,
  bossNameOf,
  HEAD_MIN_HEIGHT,
  MAX_HEALTH,
  MAX_INPUTS_PER_TICK,
  MAX_PLAYERS,
  HEAL_AMOUNT,
  HEAL_MS,
  MAX_REWIND_MS,
  SEARCH_MS,
  SEARCH_RADIUS,
  PLAYER_CROUCH_HALF_HEIGHT,
  PLAYER_HALF_HEIGHT,
  PLAYER_RADIUS,
  RESPAWN_DELAY_MS,
  SNAPSHOT_HISTORY,
  SNAPSHOT_RATE,
  StateFlags,
  SystemRegistry,
  TICK_DT,
  TICK_MS,
  TICK_RATE,
  aimDirection,
  boxFootprintDistance,
  canFire,
  canReload,
  addReserve,
  consumeAmmo,
  createLoadout,
  damageAt,
  heldAmmo,
  heldWeapon,
  isKnife,
  isPrimaryChoice,
  isSwitching,
  actionScale,
  clampTraitLevels,
  damageTakenScale,
  fireIntervalScale,
  lootCashScale,
  meleeDamageScale,
  spreadScale,
  switchScale,
  carrionHeal,
  executeScale,
  EXECUTE_BELOW,
  getModifier,
  maxHealthBonus,
  MODIFIERS,
  monsterDamageScale,
  rollModifier,
  rollLoot,
  meleeStrike,
  rayCapsule,
  refillSlot,
  requestSwitch,
  resetLoadout,
  encodeEvents,
  encodeLoot,
  encodeObjective,
  encodeSnapshot,
  encodeText,
  mulberry32,
  stateFlagsOf,
  traceShot,
  vecAdd,
  vecCross,
  vecNormalize,
  vecScale,
  waterDistance,
  type LevelDef,
  type LoadoutState,
  type LootItem,
  type SearchKind,
  type SearchSpot,
  type MeleeCandidate,
  type PlayerInput,
  type GameEvent,
  type FrameTime,
  type PlayerSnapshot,
  type MonsterSnapshot,
  type Monster,
  type MonsterKind,
  type MonsterState,
  type MonsterSenses,
  type Vec3,
  type WeaponSpec,
} from '@dk/shared'
import type { Collider, RigidBody, World as PhysicsWorld } from '@dimforge/rapier3d-compat'
import { Capsule, ColliderDesc, Ray, RigidBodyDesc } from '@dimforge/rapier3d-compat'

import { MatchDriver } from './match.ts'
import { addBounds, createLevelWorld } from './physics.ts'

/**
 * 服务端内核上下文。
 *
 * 与客户端同形：时间 + 世界入口。服务端没有 update/lateUpdate/render 相位，
 * 所以不套 `Kernel` 的帧外壳，只用它的 `SystemRegistry` + `FixedClock` ——
 * 共享的是"固定步怎么换算、阶段按什么顺序跑"，不是"服务端也要画一帧"。
 */
interface WorldContext {
  readonly time: FrameTime
  readonly world: World
}

/** 历史帧里某个玩家的位姿，回滚用。 */
interface HistoryEntry {
  playerId: number
  /** 刚体中心（回滚时写回刚体）。 */
  bx: number
  by: number
  bz: number
}

interface HistoryFrame {
  tick: number
  entries: HistoryEntry[]
}

/**
 * 怪物实体：AI 数据 + 一个只为"被子弹打到"而存在的固定碰撞体。
 *
 * 位置不由物理引擎推，而是本文件按 AI 给的速度搬（然后 propagate）：
 * 怪物要撞墙就停、要能上 0.4m 台阶但不能被一级台阶永久卡死，这类规则
 * 用 Rapier 的动力学去表达反而绕（要么爬不上去，要么浮空抖），
 * 而四级台阶的高度差是我们自己在关卡里定的，逐轴判矩形更直接。
 */
interface MonsterEntity {
  /** AI 数据。shared/src/ai.ts 的纯函数完全围绕它做决策。 */
  data: Monster
  /** 线上种类码（MonsterKindCode）。快照每 tick 都要发，算一次就存着。 */
  kindCode: number
  body: RigidBody
  collider: Collider
  /** 与 collider 同尺寸的胶囊，撞墙检测直接拿它当移动探针。 */
  shape: Capsule
  radius: number
  halfHeight: number
  /** 朝向。由实际移动方向反推；停下来时保留上一次的值，否则尸体会突然转向。 */
  yaw: number
  /** 死亡后到这一 tick 复活；0 表示活着。 */
  respawnTick: number
  /**
   * Boss 的绕障状态。
   *
   * 大型 Boss 半径接近 1m，门洞/箱角经常把它的"直线追人"卡死。没有寻路时
   * 最低成本的补救是：连续撞墙半秒就沿墙横向滑一段时间，再换另一侧。
   * 这项只对 Boss 生效，杂兵保持原来的直线行为（它们体积小，能钻过去）。
   */
  stuckTicks: number
  detourUntilTick: number
  detourSign: number
}

/** 状态字符串 → 线上 1 字节码。放在模块级：每个世界都建一份表纯属浪费。 */
const STATE_CODES: Record<MonsterState, number> = {
  idle: MonsterStateCode.Idle,
  chase: MonsterStateCode.Chase,
  attack: MonsterStateCode.Attack,
  special: MonsterStateCode.Special,
  dead: MonsterStateCode.Dead,
}

const KIND_CODES: Record<MonsterKind, number> = {
  grunt: MonsterKindCode.Grunt,
  hound: MonsterKindCode.Hound,
  gunner: MonsterKindCode.Gunner,
  boss: MonsterKindCode.Boss,
  bellkeeper: MonsterKindCode.Bellkeeper,
  golem: MonsterKindCode.Golem,
  conductor: MonsterKindCode.Conductor,
}

/**
 * 枪手的眼睛高度 = 身高 × 这个系数。
 *
 * 视线与枪口都用它：0.84 大约是真人眼高占身高的比例（1.85m 的怪 → 1.55m），
 * 这样枪口火焰从"肩膀以上、头顶以下"冒出来，而不是从胸口或头顶射出来。
 */
const MONSTER_EYE_RATIO = 0.84

/** 开火命中目标：玩家和怪物走同一套射线，结算时才分开。 */
type ShotTarget =
  | { kind: 'player'; player: Player }
  | { kind: 'monster'; monster: MonsterEntity }

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 }

/**
 * 房间 id → 随机种子（FNV-1a）。
 *
 * 只是为了"同一个房间、同样的怪物、同样的游荡轨迹"，出了问题能原样复现；
 * 不需要密码学强度。
 */
function hashSeed(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ------------------------------------------------------------ 搜刮

/**
 * 掷骰实现已搬到 `@dk/shared`：客户端也要用同一份规则（见 shared/src/loot.ts）。
 * 这里保留旧的导出路径，单测与 world.ts 内部都还在用 `rollLoot` 这个名字。
 */
export { rollLoot, type LootRoll } from '@dk/shared'

/**
 * 走开多远算"边搜边跑"。比 SEARCH_RADIUS 小得多：站着不动的手抖不该清零。
 *
 * 也不能太小：按住 E 的同时松开 W，角色还有一段减速滑行（冲刺进去时能有
 * 0.6~0.9m），第一次实测就因此把 57% 的进度清零过一次 —— 玩家看到的是
 * "搜索条突然归零"，会以为按键没生效。1.1m 仍然远小于 SEARCH_RADIUS 2.2，
 * 绕圈跑动一定会被抓住。
 */
const SEARCH_MOVE_TOLERANCE = 1.1

/** 战利品包的下发频率（Hz）。见 publishLoot 里为什么不是 20Hz。 */
const LOOT_RATE = 10

/**
 * Boss 的 id 偏移。
 *
 * 与普通怪的 0..15 拉开一段：Boss 一局只有一个，但普通怪的数量随 modifier
 * 变化，写死 "+ n" 迟早撞号；而撞号的后果是客户端把屠夫画成一只行尸。
 */
const BOSS_ID_OFFSET = 0x0800

interface Player {
  id: number
  nickname: string
  socket: WebSocket
  /** 稳定账号标识（宿主 userId 或匿名 IP）；断线重连按它找回角色。 */
  userId: string
  /** 0 = 在线；>0 = 断线保留开始的 Date.now()。 */
  detachedAt: number
  character: Character
  /** 最近一次输入里的视角，快照与射击都用它。 */
  yaw: number
  pitch: number
  /** 最近一次输入，没有新输入时复用它推进物理，避免视角被重置成 0。 */
  lastInput: PlayerInput
  health: number
  alive: boolean
  respawnTick: number
  ads: boolean
  reloading: boolean
  reloadDoneTick: number
  /**
   * 槽位 / 按槽弹药 / 切枪计时，规则在 shared/src/loadout.ts。
   *
   * 弹药按槽存而不是按枪存：切走再切回不能白送子弹，所以数的是"这个槽里
   * 还剩多少"，而不是"手上这把枪还剩多少"。
   */
  loadout: LoadoutState
  /** 已应用到的最新输入序号，快照回给客户端做预测校正。 */
  ackSeq: number
  /** 客户端最近一次收到的快照 tick，延迟补偿据此回滚。 */
  ackedTick: number
  /** 待消费输入队列（客户端会小批量补发）。 */
  queue: PlayerInput[]
  /** 本 tick 内累计的发弹计数，保证同一 tick 内多发弹的散布不重复。 */
  shotCounter: number
  /**
   * 身上带着的赏金（美元）。
   *
   * 只统计搜刮到的现金：撤离后这块就是本局的收益，死了直接归零 —— 这就是
   * "搜打撤"的风险面，收益一直挂在身上，没撤出去就等于没搜过。
   */
  carriedValue: number
  /** 背包：搜到的物品（同 id 合并计数）。现在只用于显示与结算，不占负重。 */
  loot: LootItem[]
  /** 正在搜的点下标（按着交互且进度 > 0），-1 = 没在搜。 */
  searchSpotId: number
  /** 当前这轮搜索已累积的毫秒数。松手 / 走开立刻清零，不能"存着"。 */
  searchMs: number
  /** 这轮搜索的起始锚点：位移超过 SEARCH_MOVE_TOLERANCE 就把进度作废。 */
  searchAnchor: { x: number; z: number } | null
  /**
   * 身边最近的可搜点，-1 = 附近没有。
   *
   * 与"是否按着交互键"无关，每 tick 都算：客户端要靠它画"按住 F 搜刮"的提示，
   * 按了才提示等于让人猜。
   */
  nearSpotId: number
  /** 交互键是否按着。按住语义，取最近一次输入里的那一位。 */
  interact: boolean
  /**
   * 天赋等级包（见 shared/src/traits.ts）：每 2 bit 一条，0 = 没装备。
   *
   * 存打包值而不是数组：判定时只做位移与查表，一局里最多 10 条，
   * 数组要额外处理"重复天赋""顺序不同"这些与玩法无关的麻烦。
   */
  traits: number
  /**
   * 生命上限。默认 MAX_HEALTH，带"强健"时更高。
   *
   * 每个玩家一份而不是全局常量：天赋是按人选的，两个人同局可以有不同上限；
   * 血条/结算都读这里，否则"上限 200 却回不到 200"会当场露馅。
   */
  maxHealth: number
  /** 包扎键是否按着。语义同 interact，松开即中断。 */
  heal: boolean
  /** 这一轮包扎已累积的毫秒数。松手 / 走动 / 开枪立刻清零。 */
  healMs: number
  /** 这一轮包扎的起始锚点：位移超过 SEARCH_MOVE_TOLERANCE 就作废。 */
  healAnchor: { x: number; z: number } | null
  /** 上次发出去的战利品包字节，用来"只在内容变化时发"（见 publishLoot）。 */
  lastLoot: Uint8Array | null
}

export interface WorldOptions {
  id: string
  level?: LevelDef
  /** 最后一名玩家离开时通知注册表，用来决定何时销毁本世界。 */
  onEmpty?: (id: string) => void
}

/**
 * 玩家死亡后留在原地的可搜缓存。
 *
 * 只存位置、现金、物品和"是否带着赏金"：渲染用的是客户端已有的死亡特效/
 * 尸体位置，服务端不需要知道外观。`id` 用负数（-2..-64），与静态搜刮点
 * 0..N 共用 LootPacket 的 int16 字段，客户端据此显示"搜刮尸体"。
 */
export interface BodyCache {
  id: number
  x: number
  z: number
  value: number
  items: LootItem[]
  bounty: boolean
  expiresTick: number
}

export class World {
  readonly id: string
  readonly level: LevelDef

  private readonly physics: PhysicsWorld
  private readonly players = new Map<number, Player>()
  /** 碰撞体 handle → 玩家，射线打中之后要知道打的是谁。 */
  private readonly byCollider = new Map<number, Player>()
  private readonly monsters: MonsterEntity[] = []
  private readonly monstersByCollider = new Map<number, MonsterEntity>()
  /** 怪物决策用的"能看到谁"列表，每 tick 复用同一个数组避免 GC。 */
  private readonly senses: MonsterSenses[] = []
  /**
   * 传给 stepMonster 的入参对象，同样每 tick 复用。
   *
   * visible 回调只对枪手生效（近战怪不关心视线），它读 sightX/Y/Z 这三个
   * 每只怪开跑前刷新的字段 —— 用一个闭包而不是每只怪造一个对象，
   * 是为了让最热的怪物循环保持零分配。
   */
  private readonly aiInput: {
    players: MonsterSenses[]
    tick: number
    dtMs: number
    visible?: (player: MonsterSenses) => boolean
  } = {
    players: this.senses,
    tick: 0,
    dtMs: TICK_MS,
    visible: (player: MonsterSenses) => this.gunnerSees(player),
  }
  /** 当前正在决策的枪手的眼睛位置（由 stepMonsters 填，见 aiInput）。 */
  private sightX = 0
  private sightY = 0
  private sightZ = 0
  /**
   * 怪物用的随机源。
   *
   * 只有"在家待机时缓慢游荡"会用它，绝不参与命中判定 —— 所以它不参与
   * 延迟补偿的重放也能保持一致性。种子来自房间 id，同一房间重放同一条轨迹。
   */
  private readonly rng: () => number
  /**
   * 线索 / 放逐 / 撤离的状态机。
   *
   * 单独一个类而不是散在 World 的字段里：这段逻辑两端都要用（客户端拿同一份
   * 常量画 HUD），写在一处才好对照。World 只负责"把玩家位置喂进去、把包发出去"。
   */
  private readonly match: MatchDriver
  /**
   * 本局的环境修饰 id（见 shared/src/modifiers.ts）。建世界时抽一次，整局不变。
   *
   * 抽签用的是世界自己的 rng，而不是 Math.random：同一个房间 id 重开一局应该
   * 还是同一场天气（"这个房还是那个雾夜"），换房才是另一局。
   */
  readonly modifier: number
  /** 本局战利品骰子的偏移。测试要复现同一个点掉什么，就得拿着它去算。 */
  readonly lootSeed: number
  /** 血巢的 Boss 是否已经刷过。一局只刷一次，死了就不再刷。 */
  private bossSpawned = false
  /** Boss 是否已经被打死 —— 放逐进度的门禁（见 server/src/match.ts 的 stepBanish）。 */
  private bossDefeated = false
  /** 场上的 Boss 实体，用来在重开一局时清场。 */
  private bossEntity: MonsterEntity | null = null
  /** 本局血巢 Boss 的种类（由地图决定，见 LevelDef.bossKind）。 */
  private readonly bossKind: MonsterKind
  /** 召唤怪的 id 游标，从 Boss id 之后顺延，避免和普通怪撞号。 */
  private nextSummonId = BOSS_ID_OFFSET + 1
  /** 上次广播出去的目标包字节，用来判断要不要重发（见 publishObjective）。 */
  private lastObjective: Uint8Array | null = null
  private readonly history: HistoryFrame[] = []
  /**
   * 已经被搜过的点（下标）。**全场共享**：一个箱子只能被开一次，谁先搜到谁拿，
   * 别人再去就是空的 —— 这是让 16 个点值得抢的原因。
   */
  private readonly searchedSpots = new Set<number>()
  /** 动态尸体缓存：静态搜刮点之外，玩家死亡留下的可搜物。 */
  private bodyCaches: BodyCache[] = []
  /** 下一个尸体缓存 id；-1 是"没有"，所以从 -2 开始。 */
  private nextBodyId = -2
  /** 上一 tick 的比赛阶段，用来识别 over → hunt 的重开并清掉上一局的尸体。 */
  private lastMatchPhase = 'hunt'
  private pendingEvents: GameEvent[] = []
  private readonly onEmpty?: (id: string) => void

  private nextPlayerId = 1
  private tick = 0
  private timer: NodeJS.Timeout | null = null
  private lastPumpAt = 0
  /**
   * 固定步长换算。与客户端共用 `shared/kernel` 的同一个类，只是各用各的策略：
   * 服务端一次最多补 `MAX_CATCHUP_TICKS` 步（追不上就丢积压），客户端上限是
   * 一包输入能装下的步数。共享的只有算术，策略仍然是两端各自的。
   */
  private readonly clock = new FixedClock({
    hz: TICK_RATE,
    maxSubsteps: MAX_CATCHUP_TICKS,
    maxFrameDt: 0.1,
  })
  /**
   * 一个 tick 内的阶段顺序。
   *
   * 以前这九段是 `step()` 里从上到下的一串调用，顺序只写在注释里：
   * 谁都不能看出"怪必须在玩家输入之前动"，只有改错一次、看见命中差一 tick 才知道。
   * 现在顺序是数据（deps 决定），`with('fixedUpdate')` 缓存后每 tick 只做一次数组遍历。
   */
  private readonly phases = new SystemRegistry<WorldContext>()
  private readonly ctx: WorldContext
  private emptySince = 0
  private stopped = false

  constructor(options: WorldOptions) {
    this.id = options.id
    this.level = options.level ?? DEFAULT_LEVEL
    this.bossKind = this.level.bossKind ?? 'boss'
    this.onEmpty = options.onEmpty
    this.physics = createLevelWorld(this.level)
    addBounds(this.physics, this.level)
    this.rng = mulberry32(hashSeed(this.id))
    // 先抽天气、再刷怪：刷怪数量与种类都要吃 modifier（虫潮 1.6 倍怪量），
    // 反过来先刷怪就得把整批怪重算一遍。
    this.modifier = rollModifier(this.rng)
    this.lootSeed = Math.floor(this.rng() * 0x7fffffff)
    // 目标状态机读玩家位置时**必须过滤掉死人**：尸体停在撤离点里不该继续推进度。
    this.match = new MatchDriver(this.level, {
      players: () => this.aliveActors(),
      bossDown: () => this.bossDefeated,
      bountyOnGround: () => this.bodyCaches.some((cache) => cache.bounty),
    })
    // modifier 由 World 抽、由目标包下发；MatchDriver 只持有它，一局不变。
    this.match.state.modifier = this.modifier
    this.spawnMonsters()

    this.ctx = { time: this.clock.time, world: this }
    // 顺序即玩法。九段全部显式命名，依赖关系写在 deps 里：
    // 想插一段"在物理之前"，只要声明 deps，不必猜自己该插在哪一行。
    this.phases
      .add('lifecycle', { fixedUpdate: () => this.beginTick() })
      .add('monsters', { fixedUpdate: () => this.stepMonsters() }, ['lifecycle'])
      .add('inputs', { fixedUpdate: () => this.stepInputs() }, ['monsters'])
      // physics.step 是唯一屏障：所有角色都提交完 next kinematic translation 才能推进。
      .add('physics', { fixedUpdate: () => this.physics.step() }, ['inputs'])
      .add('interactions', { fixedUpdate: () => this.stepInteractions() }, ['physics'])
      .add('history', { fixedUpdate: () => this.pushHistory() }, ['interactions'])
      .add('match', { fixedUpdate: () => this.stepMatch() }, ['history'])
      .add('objective', { fixedUpdate: () => this.stepObjective() }, ['match'])
      .add('broadcast', { fixedUpdate: () => this.stepBroadcast() }, ['objective'])
  }

  // ------------------------------------------------------------ 生命周期

  start(): void {
    if (this.timer || this.stopped) return
    this.lastPumpAt = performance.now()
    this.clock.reset()
    // 用 1ms 的轮询器 + 累加器，而不是 setInterval(TICK_MS)：
    // setInterval 在 Node 上会漂移，跑几十分钟后 tick 号与实际时间脱节，
    // 而延迟补偿是按 tick 换算回滚窗口的，算错就是"打中了不算"。
    this.timer = setInterval(() => this.pump(), 1)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 空置了多久（毫秒）；非空返回 0。注册表用它回收没人玩的房间。 */
  idleFor(nowMs: number): number {
    if (this.players.size > 0) return 0
    return nowMs - this.emptySince
  }

  get playerCount(): number {
    return this.players.size
  }

  get tickCount(): number {
    return this.tick
  }

  private pump(): void {
    const now = performance.now()
    const steps = this.clock.advance((now - this.lastPumpAt) / 1000)
    this.lastPumpAt = now

    // 追不上就扔掉积压（FixedClock 在超过 maxSubsteps 时已经清零）：
    // 否则一次 GC 停顿后会连补几百 tick，玩家看到的是瞬移，比慢一点更糟。
    for (let i = 0; i < steps; i++) this.step()
  }

  // ------------------------------------------------------------ 怪物

  /**
   * 刷怪：巢穴从"每处固定一只"改成**候选点池**。
   *
   * 以前是 for 一遍 nests，一个巢穴一只、种类照关卡写死 —— 打过两把的人一进门
   * 就知道东边走廊里蹲着枪手。现在每个点都从池里抽，位置带 ±9m 抖动、种类按权重
   * 抽（grunt 52% / hound 26% / gunner 22%），总数按本局 modifier 缩放，并且**不刷
   * 在出生点 22m 内**：随机不等于把怪丢在人脸上。
   *
   * id 从 `MONSTER_ID_BASE` 起算，和玩家 id 共用 u16 空间但两段互不重叠：
   * `DeathEvent.killerId` 只有一个字段，各占一套编号就得为"被怪咬死"多造一种事件。
   */
  private spawnMonsters(): void {
    const nests = this.level.nests ?? []
    if (nests.length === 0) return
    const modifier = getModifier(this.modifier)
    const total = Math.max(3, Math.min(16, Math.round(nests.length * 3 * modifier.monsterScale)))
    for (let i = 0; i < total; i++) {
      const spot = this.rollNestSpot(nests)
      const home = { x: spot.x, y: this.level.groundY, z: spot.z }
      const data = spawnMonster(this.rollNestKind(), MONSTER_ID_BASE + i, home, this.rng)
      this.monsters.push(this.createMonsterEntity(data))
    }
    // 新碰撞体要进 broad phase，否则第一 tick 的射线打不到它们。
    this.physics.propagateModifiedBodyPositionsToColliders()
  }

  /** 抽一个巢穴点并加抖动，最多试 6 次避开出生点。 */
  private rollNestSpot(nests: { kind: string; x: number; z: number }[]): { x: number; z: number } {
    const spawns = this.level.spawns
    const half = this.level.boundsHalf - 4
    let best = { x: nests[0]!.x, z: nests[0]!.z }
    for (let attempt = 0; attempt < 6; attempt++) {
      const nest = nests[Math.floor(this.rng() * nests.length)] ?? nests[0]!
      const x = Math.max(-half, Math.min(half, nest.x + (this.rng() - 0.5) * 18))
      const z = Math.max(-half, Math.min(half, nest.z + (this.rng() - 0.5) * 18))
      best = { x, z }
      let tooClose = false
      for (const spawn of spawns) {
        if (Math.hypot(spawn.x - x, spawn.z - z) < 22) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue
      // 抖动可能把怪物塞进实心盒/水里；18m 的随机半径在树带附近尤其容易。
      // 只检查会挡住怪物躯干的盒子（头顶横梁不算）。
      const bandLow = this.level.groundY + 0.05
      const bandHigh = this.level.groundY + PLAYER_HALF_HEIGHT * 2 + PLAYER_RADIUS * 2
      let blocked = false
      for (const box of this.level.boxes) {
        if (box.noCollide) continue
        if (box.y + box.hy <= bandLow || box.y - box.hy >= bandHigh) continue
        if (boxFootprintDistance(box, x, z) < 1.2) {
          blocked = true
          break
        }
      }
      if (blocked) continue
      for (const water of this.level.water ?? []) {
        if (waterDistance(water, x, z) < 0.4) {
          blocked = true
          break
        }
      }
      if (!blocked) return best
    }
    return best
  }

  /** 种类权重：行尸是基本盘，猎犬逼人换位，枪手负责"不能无视"。 */
  private rollNestKind(): 'grunt' | 'hound' | 'gunner' {
    const roll = this.rng()
    if (roll < 0.52) return 'grunt'
    if (roll < 0.78) return 'hound'
    return 'gunner'
  }

  private createMonsterEntity(data: Monster): MonsterEntity {
    const hurt = monsterHurtbox(data)
    const body = this.physics.createRigidBody(
      RigidBodyDesc.fixed().setTranslation(hurt.x, hurt.y, hurt.z),
    )
    const collider = this.physics.createCollider(
      ColliderDesc.capsule(hurt.halfHeight, hurt.radius),
      body,
    )
    const entity: MonsterEntity = {
      data,
      kindCode: KIND_CODES[data.kind],
      body,
      collider,
      // 胶囊实例复用：每 tick 都拿它做一次 shape cast，新建对象会一直喂 GC。
      shape: new Capsule(hurt.halfHeight, hurt.radius),
      radius: hurt.radius,
      halfHeight: hurt.halfHeight,
      yaw: 0,
      respawnTick: 0,
      stuckTicks: 0,
      detourUntilTick: 0,
      detourSign: 1,
    }
    this.monstersByCollider.set(collider.handle, entity)
    return entity
  }

  private stepMonsters(): void {
    // 感知列表每 tick 复用同一个数组：16 个人 × 60 tick × 房间数，
    // 每 tick 新建数组是纯浪费，而这里是全服务端最热的循环之一。
    this.senses.length = 0
    for (const player of this.players.values()) {
      if (!player.alive) continue
      const feet = player.character.feet
      this.senses.push({ id: player.id, x: feet.x, z: feet.z, alive: true })
    }
    this.aiInput.tick = this.tick

    let moved = false
    for (const entity of this.monsters) {
      const data = entity.data
      if (data.state === 'dead') {
        if (entity.respawnTick !== 0 && this.tick >= entity.respawnTick) {
          this.reviveMonster(entity)
          moved = true
        }
        continue
      }

      // 枪手的视线起点：每只怪开跑前刷新这三个复用字段（见 aiInput 的注释）。
      // 近战怪用不到，改成一行也没有意义 —— 一次减法比一次分支便宜。
      const spec = MONSTER_SPECS[data.kind]
      this.sightX = data.x
      this.sightY = data.y + spec.height * MONSTER_EYE_RATIO
      this.sightZ = data.z

      const result = stepMonster(data, this.aiInput, this.rng)

      // 大型 Boss 的绕障：把 AI 的"直线奔目标"临时旋转 90°，贴着墙滑出去。
      // 只在上一轮连续撞墙后才启动，正常追击时完全不干预。
      if (isBossKind(data.kind) && data.state !== 'special') this.applyBossSteering(entity)

      // AI 只写速度，位移在这里做（见 MonsterEntity 的注释）。
      const dx = data.vx * TICK_DT
      const dz = data.vz * TICK_DT
      let blocked = { x: false, z: false }
      if (dx !== 0 || dz !== 0) {
        blocked = this.slideMonster(entity, dx, dz)
        if (blocked.x) data.vx = 0
        if (blocked.z) data.vz = 0
        // 朝向跟实际位移走（不是意图速度）：贴着墙蹭的时候身体该顺着墙滑，
        // 而不是一直对着墙里顶。完全没动时保留上一次朝向。
        const realX = blocked.x ? 0 : dx
        const realZ = blocked.z ? 0 : dz
        if (realX !== 0 || realZ !== 0) entity.yaw = Math.atan2(-realX, -realZ)
        moved = true
      }
      if (isBossKind(data.kind)) this.trackBossStuck(entity, blocked, dx, dz)
      // 地面跟随：怪物以前只在出生点取一次 y，走上台阶/月台后碰撞体留在原地，
      // 视觉上就是"脚陷进地里 / 飘在半空"。每 tick 向下探一次地面，只允许
      // 0.45m 的抬升（不可能因此爬墙），下降则直接贴地。
      if (this.snapMonsterGround(entity)) moved = true
      this.syncMonsterBody(entity)

      // 站定开枪的枪手不会位移，朝向得单独跟目标走：否则它一直朝着
      // "上一步走来的方向"开枪，看着像在对空气放枪。
      if (data.state === 'attack' && data.targetId !== 0) {
        const aim = this.players.get(data.targetId)
        if (aim && aim.alive) {
          const fx = aim.character.feet
          entity.yaw = Math.atan2(-(fx.x - data.x), -(fx.z - data.z))
        }
      }

      if (result.hit) {
        const victim = this.players.get(result.hit.playerId)
        if (victim) {
          const feet = victim.character.feet
          this.damagePlayerByMonster(
            entity,
            result.hit.playerId,
            result.hit.damage,
            { x: feet.x, y: feet.y + 1, z: feet.z },
          )
        }
      }
      if (result.shot) this.monsterShot(entity, result.shot.playerId)
      if (result.pulse) this.bossPulse(entity, result.pulse)
      if (result.summon) this.summonMonsters(entity, result.summon.kind, result.summon.count)
    }

    if (moved) this.physics.propagateModifiedBodyPositionsToColliders()
  }

  /** 枪手的眼睛/枪口位置。见 MONSTER_EYE_RATIO。 */
  private monsterEye(entity: MonsterEntity): Vec3 {
    const spec = MONSTER_SPECS[entity.data.kind]
    return {
      x: entity.data.x,
      y: entity.data.y + spec.height * MONSTER_EYE_RATIO,
      z: entity.data.z,
    }
  }

  /**
   * 枪手此刻能不能看见这个玩家。
   *
   * 只判**静态几何**遮挡：玩家与怪物自己的碰撞体一律不算遮挡物 —— 队友站在
   * 中间不该替人挡枪，怪物之间互相遮挡更会变成一堵看不见的墙。这和 tryFire
   * 里那条 filter 是同一套约定，两边不能各写一套。
   */
  private gunnerSees(player: MonsterSenses): boolean {
    const target = this.players.get(player.id)
    if (!target || !target.alive) return false
    const eye = target.character.eye
    const dx = eye.x - this.sightX
    const dy = eye.y - this.sightY
    const dz = eye.z - this.sightZ
    const dist = Math.hypot(dx, dy, dz)
    if (dist < 1e-3) return true
    // 末端留 12cm：射线的终点正落在对方眼睛上，别让它扫到自己那一层皮。
    const blocked = traceShot(this.physics, {
      origin: { x: this.sightX, y: this.sightY, z: this.sightZ },
      dir: { x: dx / dist, y: dy / dist, z: dz / dist },
      maxDistance: dist - 0.12,
      classify: () => null,
      filter: (collider: Collider) => this.targetOf(collider) === null,
    })
    return !blocked.hit
  }

  /**
   * 枪手开一枪：散布 → 打墙 → 打胶囊 → 事件 → 扣血。
   *
   * 判定顺序与玩家开火一致（先拿遮挡距离，再比胶囊），但**不做延迟补偿**：
   * 怪物的每一枪都是"现在"打出的，且它瞄的是玩家此刻的位置 —— 给 AI 加
   * 延迟补偿只会让 200ms 延迟的玩家被一段看不见的历史位置打中。
   */
  private monsterShot(entity: MonsterEntity, playerId: number): void {
    const ranged = MONSTER_SPECS[entity.data.kind].ranged
    if (ranged === undefined) return
    const eye = this.monsterEye(entity)
    const victim = this.players.get(playerId)
    const aim = victim && victim.alive ? victim.character.eye : null

    // 基准方向：有人就打人；这一 tick 刚好死了/退了就朝自己面朝的方向放一枪空枪
    // —— 空枪也要有曳光和枪声，那才是"这里有人在交火"的情报。
    let dir: Vec3
    if (aim) {
      dir = vecNormalize({ x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z })
    } else {
      dir = { x: -Math.sin(entity.yaw), y: 0, z: -Math.cos(entity.yaw) }
    }

    // 散布：均匀圆盘里取一点，再合并进方向。sqrt 让落点铺满圆面而不是挤在圆心。
    const angle = this.rng() * Math.PI * 2
    const spread = Math.sqrt(this.rng()) * Math.tan(ranged.spreadRad)
    const up = Math.abs(dir.y) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
    const right = vecNormalize(vecCross(dir, up))
    const realUp = vecCross(right, dir)
    dir = vecNormalize(
      vecAdd(
        dir,
        vecAdd(
          vecScale(right, Math.cos(angle) * spread),
          vecScale(realUp, Math.sin(angle) * spread),
        ),
      ),
    )

    const maxDistance = ranged.falloffFar + 8
    const wall = traceShot(this.physics, {
      origin: eye,
      dir,
      maxDistance,
      classify: () => null,
      filter: (collider: Collider) => this.targetOf(collider) === null,
    })

    let distance = wall.hit ? wall.distance : maxDistance
    let hitDistance: number | null = null
    if (victim && victim.alive) {
      const feet = victim.character.feet
      const lower = { x: feet.x, y: feet.y + PLAYER_RADIUS, z: feet.z }
      const upper = {
        x: feet.x,
        y: feet.y + PLAYER_RADIUS + PLAYER_HALF_HEIGHT * 2,
        z: feet.z,
      }
      const d = rayCapsule(eye, dir, lower, upper, PLAYER_RADIUS)
      if (d !== null && d < distance) {
        hitDistance = d
        distance = d
      }
    }

    this.pendingEvents.push({
      kind: EventKind.MonsterShot,
      monsterId: entity.data.id,
      origin: eye,
      dir,
      distance,
      hit: hitDistance !== null,
    })

    if (hitDistance === null || !victim) return
    // 距离衰减：falloffNear 内满伤害，falloffFar 处只剩 falloffMin。
    const over = Math.max(0, hitDistance - ranged.falloffNear)
    const span = Math.max(1e-3, ranged.falloffFar - ranged.falloffNear)
    const falloff = Math.max(ranged.falloffMin, 1 - (over / span) * (1 - ranged.falloffMin))
    this.damagePlayerByMonster(entity, victim.id, ranged.damage * falloff, {
      x: eye.x + dir.x * hitDistance,
      y: eye.y + dir.y * hitDistance,
      z: eye.z + dir.z * hitDistance,
    })
  }

  /**
   * Boss 的范围脉冲：钟声/砸地。
   *
   * 先广播事件（客户端画冲击环），再逐人判距离与遮挡。遮挡用怪物中心到
   * 玩家胸口的一条射线：隔着墙被震掉半管血是玩家无法从画面里读出来的伤害。
   */
  private bossPulse(
    entity: MonsterEntity,
    pulse: { x: number; y: number; z: number; radius: number; damage: number },
  ): void {
    this.pendingEvents.push({
      kind: EventKind.BossPulse,
      monsterId: entity.data.id,
      x: pulse.x,
      y: pulse.y,
      z: pulse.z,
      radius: pulse.radius,
    })
    const origin = { x: pulse.x, y: pulse.y + 1.4, z: pulse.z }
    for (const victim of this.players.values()) {
      if (!victim.alive) continue
      const feet = victim.character.feet
      const dx = feet.x - pulse.x
      const dz = feet.z - pulse.z
      const distance = Math.hypot(dx, dz)
      if (distance > pulse.radius) continue
      const chest = { x: feet.x, y: feet.y + 1, z: feet.z }
      const wall = traceShot(this.physics, {
        origin,
        dir: vecNormalize({ x: chest.x - origin.x, y: chest.y - origin.y, z: chest.z - origin.z }),
        maxDistance: Math.max(0.1, distance),
        classify: () => null,
        filter: (collider: Collider) => this.targetOf(collider) === null,
      })
      if (wall.hit) continue
      // 圆心满伤，边缘 45%：站在圈边的人有活路，但继续站着不动没有。
      const falloff = Math.max(0.45, 1 - 0.55 * (distance / Math.max(1e-3, pulse.radius)))
      this.damagePlayerByMonster(entity, victim.id, pulse.damage * falloff, {
        x: feet.x,
        y: feet.y + 0.8,
        z: feet.z,
      })
    }
  }

  /** Boss 召唤：在它周围 2.4m 的圆上站起来，落点仍然要过一遍地形检查。 */
  private summonMonsters(entity: MonsterEntity, kind: MonsterKind, count: number): void {
    if (count <= 0) return
    const baseAngle = this.rng() * Math.PI * 2
    for (let i = 0; i < count; i++) {
      const angle = baseAngle + (i / count) * Math.PI * 2
      const x = entity.data.x + Math.cos(angle) * 2.4
      const z = entity.data.z + Math.sin(angle) * 2.4
      const data = spawnMonster(
        kind,
        MONSTER_ID_BASE + this.nextSummonId++,
        { x, y: entity.data.y, z },
        this.rng,
      )
      this.monsters.push(this.createMonsterEntity(data))
    }
    this.physics.propagateModifiedBodyPositionsToColliders()
    this.broadcastText(`${bossNameOf(entity.data.kind)}吹响了哨子 · 猎犬应声而来`)
  }

  private broadcastText(text: string): void {
    for (const player of this.players.values()) this.sendText(player, text)
  }

  /**
   * 怪物扣玩家血：近战与子弹共用这一个入口。
   *
   * 以前近战咬人只减血、不发事件，被打的人既没有受伤方向也没有命中点血花 ——
   * 客户端根本不知道是谁从背后咬的。现在两种伤害都发一条 Hit：attackerId 填
   * 怪物的 id（它和玩家共用一套 id 空间，客户端只拿它做归属判断，不查名字）。
   */
  private damagePlayerByMonster(
    entity: MonsterEntity,
    playerId: number,
    damage: number,
    point: Vec3,
  ): void {
    const victim = this.players.get(playerId)
    if (!victim || !victim.alive) return
    // 两道减伤相乘：硬皮（所有伤害）与铁石心肠（只减怪物伤害）。
    const dmg = Math.round(damage * damageTakenScale(victim.traits) * monsterDamageScale(victim.traits))
    if (dmg <= 0) return
    victim.health -= dmg
    this.pendingEvents.push({
      kind: EventKind.Hit,
      attackerId: entity.data.id,
      victimId: victim.id,
      damage: dmg,
      headshot: false,
      point,
    })
    if (victim.health <= 0) {
      victim.health = 0
      this.kill(victim, entity.data.id, false)
    }
  }

  /**
   * 怪物踩到的地面高度。每 tick 从脚上方 1m 向下打一条射线。
   *
   * 只允许 0.45m 的抬升：这是"能上台阶、不能爬墙"的分界。下降不设限
   * （从月台/栈桥走下来应当直接落地），但也不会追随到地面以下的虚空：
   * 射线没打中就不改 y，其余交给关卡边界。
   */
  private snapMonsterGround(entity: MonsterEntity): boolean {
    const data = entity.data
    const fromY = data.y + 1
    const ray = new Ray({ x: data.x, y: fromY, z: data.z }, { x: 0, y: -1, z: 0 })
    const surface = this.physics.castRay(
      ray,
      4,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (collider) => !this.byCollider.has(collider.handle) && !this.monstersByCollider.has(collider.handle),
    )
    if (!surface) return false
    const floor = fromY - surface.timeOfImpact + 0.01
    if (floor > data.y + 0.45) return false
    if (Math.abs(floor - data.y) < 1e-3) return false
    data.y = floor
    return true
  }

  /**
   * Boss 绕障：连续撞墙 20 tick（约 0.33s）后，把下一次追击方向旋转 90°，
   * 贴着墙滑出去；40 tick 后恢复直线。左右方向交替，卡在凹角里也能自己出来。
   *
   * 这是"没有寻路"的最低成本补救，不是真正的导航：它只解决门口/箱角这类
   * 单块凸起，解决不了整栋建筑的内外门。那需要导航网格，超出这次改动的范围。
   */
  private applyBossSteering(entity: MonsterEntity): void {
    if (this.tick >= entity.detourUntilTick) return
    const vx = entity.data.vx
    const vz = entity.data.vz
    if (vx === 0 && vz === 0) return
    entity.data.vx = -vz * entity.detourSign
    entity.data.vz = vx * entity.detourSign
  }

  private trackBossStuck(
    entity: MonsterEntity,
    blocked: { x: boolean; z: boolean },
    dx: number,
    dz: number,
  ): void {
    // 只把"本来想走、但两个轴都撞上"算作卡住。站定攻击时速度是 0，不算。
    const wanted = (dx !== 0 || dz !== 0) && blocked.x && blocked.z
    if (!wanted) {
      entity.stuckTicks = 0
      return
    }
    entity.stuckTicks++
    if (entity.stuckTicks < 20 || this.tick < entity.detourUntilTick) return
    entity.stuckTicks = 0
    entity.detourSign = -entity.detourSign
    entity.detourUntilTick = this.tick + 40
  }

  /**
   * 逐轴移动，撞上就归零那一维（和 `Character.step` 撞墙的处理一致）。
   *
   * 用 `castShape` 而不是 `intersectionWithShape`：需要知道"这一小步会不会撞上"，
   * 而在目标位置做重叠检测的话，贴着墙站着会被判成撞、于是永远走不了。
   * `stopAtPenetration` 传 false —— 胶囊底正好贴着地面，传 true 会让起步瞬间
   * 就因为与地面的初始接触被判定成撞墙，怪物原地不动。
   *
   * 水平的低台阶（<=0.45m）先抬高探针再试一次：Boss 的胶囊半径 0.9~1.15m，
   * 不这么做连月台边都上不去，只会贴着台阶原地推。
   */
  private slideMonster(entity: MonsterEntity, dx: number, dz: number): { x: boolean; z: boolean } {
    return {
      x: dx !== 0 ? !this.moveMonsterAxis(entity, dx, 0) : false,
      z: dz !== 0 ? !this.moveMonsterAxis(entity, 0, dz) : false,
    }
  }

  /** 尝试移动一轴；返回 true = 真的移动了。 */
  private moveMonsterAxis(entity: MonsterEntity, dx: number, dz: number): boolean {
    const data = entity.data
    const centerY = data.y + entity.halfHeight + entity.radius
    const move = { x: dx, y: 0, z: dz }
    const hit = this.physics.castShape(
      { x: data.x, y: centerY, z: data.z },
      IDENTITY_ROTATION,
      move,
      entity.shape,
      0,
      1,
      false,
      undefined,
      undefined,
      entity.collider,
    )
    if (!hit) {
      data.x += dx
      data.z += dz
      return true
    }
    // 抬 0.45m 再试：能过就是一段台阶，过不了才是墙。
    const stepUp = 0.45
    const stepHit = this.physics.castShape(
      { x: data.x, y: centerY + stepUp, z: data.z },
      IDENTITY_ROTATION,
      move,
      entity.shape,
      0,
      1,
      false,
      undefined,
      undefined,
      entity.collider,
    )
    if (stepHit) return false
    data.y += stepUp
    data.x += dx
    data.z += dz
    return true
  }

  /** 把 AI 给的坐标写到碰撞体上。y 是脚底，胶囊中心要加半高 + 半径。 */
  private syncMonsterBody(entity: MonsterEntity): void {
    const data = entity.data
    entity.body.setTranslation(
      { x: data.x, y: data.y + entity.halfHeight + entity.radius, z: data.z },
      false,
    )
  }

  private killMonster(entity: MonsterEntity, killerId: number): void {
    const isBoss = isBossKind(entity.data.kind)
    // Boss 不复活：它是"一局一次"的关卡事件，12 秒后原地再站起来等于不许玩家
    // 继续放逐。respawnTick 留 0，stepMonsters 会一直跳过它。
    entity.respawnTick = isBoss ? 0 : this.tick + Math.ceil(MONSTER_RESPAWN_MS / TICK_MS)
    // 和玩家尸体同理：死掉的怪不该继续吃子弹。
    entity.collider.setEnabled(false)
    this.pendingEvents.push({
      kind: EventKind.MonsterDeath,
      monsterId: entity.data.id,
      killerId,
      monsterKind: entity.kindCode,
    })
    if (isBoss) {
      this.bossDefeated = true
      for (const player of this.players.values()) {
        this.sendText(player, `${bossNameOf(entity.data.kind)}倒下 · 血巢可以放逐`)
      }
      return
    }
    // 食腐者：亲手打死怪才回血。用 killerId 查而不是查"最近的玩家"——
    // 队友补的最后一枪不该给别人回血。
    const killer = this.players.get(killerId)
    const heal = killer === undefined ? 0 : carrionHeal(killer.traits)
    if (killer !== undefined && killer.alive && heal > 0) {
      killer.health = Math.min(killer.maxHealth, killer.health + heal)
      this.sendText(killer, `食腐 +${heal}`)
    }
  }

  /**
   * 血巢的 Boss：线索集齐后刷在**血巢质心**。
   *
   * 放在质心而不是另设一个 bossSpawn 点：玩家已经被三条线索引导着算出了这个
   * 位置（光柱也在那），Boss 从"你刚算出来的地方"站起来，比从地图另一头冲过来
   * 更有"你把它挖出来了"的因果感。
   */
  private spawnBoss(): void {
    if (this.bossSpawned) return
    this.bossSpawned = true
    const lair = this.match.lairPosition
    // 血巢是三条线索的质心，可能正好落在月台/台阶/墙里。先在质心周围找一块
    // 足够 Boss 站下的空地，再从上方打射线取那块地的实际高度。
    const home = this.findBossSpawn(lair, MONSTER_SPECS[this.bossKind].radius)
    const data = spawnMonster(this.bossKind, MONSTER_ID_BASE + BOSS_ID_OFFSET, home, this.rng)
    const entity = this.createMonsterEntity(data)
    this.monsters.push(entity)
    this.bossEntity = entity
    // 新碰撞体要进 broad phase，否则玩家第一枪会穿过去。
    this.physics.propagateModifiedBodyPositionsToColliders()
    const name = bossNameOf(this.bossKind)
    for (const player of this.players.values()) this.sendText(player, `血巢苏醒 · ${name}出笼`)
    // Boss 的体型/出生点可能落在一堆箱子之间：先把它能站的地面找对，
    // 再让它开始 tick。否则大块头会半截埋在月台/石阶里。
    this.snapMonsterGround(entity)
    this.syncMonsterBody(entity)
  }

  /**
   * 给 Boss 找一块能站的地面。
   *
   * 从质心开始按 2m 一圈向外找：射线取地面高度，再查"站在这个高度上会不会
   * 撞到墙"。只拒绝与 Boss 躯干相交的盒子（台面本身不算障碍），因此月台、
   * 石阶顶面仍然可以站。找不到就退回质心 —— 至少不会因为搜索失败而不刷 Boss。
   */
  private findBossSpawn(
    lair: { x: number; z: number },
    radius: number,
  ): { x: number; y: number; z: number } {
    const spec = MONSTER_SPECS[this.bossKind]
    const candidates: { x: number; z: number }[] = [lair]
    for (let ring = 1; ring <= 4; ring++) {
      const d = ring * 2
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2
        candidates.push({ x: lair.x + Math.cos(a) * d, z: lair.z + Math.sin(a) * d })
      }
    }
    for (const c of candidates) {
      if (Math.abs(c.x) > this.level.boundsHalf - radius || Math.abs(c.z) > this.level.boundsHalf - radius) {
        continue
      }
      const floor = this.floorAt(c.x, c.z)
      const low = floor + 0.15
      const high = floor + spec.height * 0.82
      let blocked = false
      for (const box of this.level.boxes) {
        if (box.noCollide) continue
        const top = box.y + box.hy
        const bottom = box.y - box.hy
        if (top <= low || bottom >= high) continue
        if (boxFootprintDistance(box, c.x, c.z) < radius + 0.25) {
          blocked = true
          break
        }
      }
      if (!blocked) return { x: c.x, y: floor, z: c.z }
    }
    return { x: lair.x, y: this.level.groundY, z: lair.z }
  }

  /** 从上方打一条垂直射线取地面；没有实体地面就用关卡的地面高度。 */
  private floorAt(x: number, z: number): number {
    const fromY = this.level.groundY + 4
    const ray = new Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 })
    const surface = this.physics.castRay(
      ray,
      14,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (collider) => !this.byCollider.has(collider.handle) && !this.monstersByCollider.has(collider.handle),
    )
    return surface ? fromY - surface.timeOfImpact + 0.02 : this.level.groundY
  }

  /** 一局结束、匹配重置时把 Boss 清场：下一局是新一轮的线索。 */
  private despawnBoss(): void {
    const entity = this.bossEntity
    this.bossEntity = null
    this.bossSpawned = false
    this.bossDefeated = false
    this.nextSummonId = BOSS_ID_OFFSET + 1
    if (entity === null) return
    const index = this.monsters.indexOf(entity)
    if (index >= 0) this.monsters.splice(index, 1)
    this.monstersByCollider.delete(entity.collider.handle)
    this.physics.removeRigidBody(entity.body)
  }

  private reviveMonster(entity: MonsterEntity): void {
    const old = entity.data
    // 用 monsterAtPosition 而不是 spawnMonster：复活要回到巢穴原处，
    // 不能让 12 秒后重刷的怪从 0.7m 外冒出来（那看起来像瞬移）。
    entity.data = monsterAtPosition(
      old.kind,
      { x: old.homeX, y: this.level.groundY, z: old.homeZ },
      old.id,
    )
    entity.respawnTick = 0
    entity.yaw = 0
    entity.stuckTicks = 0
    entity.detourUntilTick = 0
    entity.detourSign = 1
    entity.collider.setEnabled(true)
    this.syncMonsterBody(entity)
  }

  /** 射线打中的碰撞体属于谁。死掉的不算目标 —— 尸体不挡子弹这条对怪也一样。 */
  private targetOf(collider: Collider): ShotTarget | null {
    const player = this.byCollider.get(collider.handle)
    if (player) return player.alive ? { kind: 'player', player } : null
    const monster = this.monstersByCollider.get(collider.handle)
    if (monster && monster.data.state !== 'dead') return { kind: 'monster', monster }
    return null
  }

  // ------------------------------------------------------------ 玩家进出

  addPlayer(
    socket: WebSocket,
    nickname: string,
    userId = '',
  ): { id: number; spawn: Vec3; resumed: boolean } | null {
    // 断线保留期内，同一个账号回来就接管原角色：位置、血量、弹药、战利品、
    // 赏金全部还在。这是 15 分钟一局里"掉线不等于这趟白打"的最低保障。
    if (userId !== '') {
      for (const existing of this.players.values()) {
        if (existing.userId !== userId || existing.detachedAt === 0) continue
        existing.socket = socket
        existing.detachedAt = 0
        existing.nickname = nickname
        existing.queue.length = 0
        existing.lastInput = {
          ...existing.lastInput,
          forward: 0,
          right: 0,
          buttons: 0,
        }
        existing.interact = false
        existing.heal = false
        existing.ads = false
        // 新连接要从零接收一次完整战利品/绷带/进度状态；旧的 lastLoot 缓存
        // 会让 publishLoot 认为"没变化"，客户端重连后一直显示空背包。
        existing.lastLoot = null
        this.emptySince = 0
        return { id: existing.id, spawn: existing.character.feet, resumed: true }
      }
    }
    if (this.players.size >= MAX_PLAYERS) return null
    const spawn = this.pickSpawn()
    const player: Player = {
      id: this.nextPlayerId++,
      nickname,
      socket,
      userId,
      detachedAt: 0,
      character: new Character(this.physics, spawn),
      yaw: 0,
      pitch: 0,
      lastInput: {
        seq: 0,
        dtMs: TICK_MS,
        forward: 0,
        right: 0,
        yaw: 0,
        pitch: 0,
        buttons: 0,
      },
      health: MAX_HEALTH,
      alive: true,
      respawnTick: 0,
      ads: false,
      reloading: false,
      reloadDoneTick: 0,
      loadout: createLoadout(DEFAULT_WEAPON_ID),
      ackSeq: 0,
      ackedTick: 0,
      queue: [],
      shotCounter: 0,
      carriedValue: 0,
      loot: STARTING_BANDAGES > 0 ? [{ id: LOOT_ITEM.Bandage, count: STARTING_BANDAGES }] : [],
      searchSpotId: -1,
      searchMs: 0,
      searchAnchor: null,
      nearSpotId: -1,
      interact: false,
      traits: 0,
      maxHealth: MAX_HEALTH,
      heal: false,
      healMs: 0,
      healAnchor: null,
      lastLoot: null,
    }
    this.players.set(player.id, player)
    this.byCollider.set(player.character.collider.handle, player)
    // 先让新角色的碰撞体进入物理世界，否则它第一 tick 会被射线/角色控制器忽略。
    this.physics.step()
    this.emptySince = 0
    return { id: player.id, spawn, resumed: false }
  }

  removePlayer(playerId: number): void {
    const player = this.players.get(playerId)
    if (!player) return
    this.byCollider.delete(player.character.collider.handle)
    this.physics.removeCharacterController(player.character.controller)
    this.physics.removeRigidBody(player.character.body)
    this.players.delete(playerId)
    if (this.players.size === 0) {
      this.emptySince = Date.now()
      this.onEmpty?.(this.id)
    }
  }

  /**
   * 异常断开：不立刻删角色，保留 DISCONNECT_GRACE_MS 等待同一账号回来。
   *
   * 保留期间清空输入队列并松开所有按键，否则掉线那一刻按住的 W/左键会让角色
   * 继续跑、继续开枪。角色仍留在物理世界里，可能被怪/别人打死 —— 这是合理的，
   * 掉线不是无敌。
   */
  detachPlayer(playerId: number): void {
    const player = this.players.get(playerId)
    if (!player) return
    player.detachedAt = Date.now()
    player.queue.length = 0
    player.lastInput = { ...player.lastInput, forward: 0, right: 0, buttons: 0 }
    player.interact = false
    player.heal = false
    player.ads = false
  }

  /**
   * 收到切槽请求。
   *
   * 限制在"活着且不在换弹"：换弹途中抽刀，现实中等于把通条丢在地上，
   * 代码里等于换弹计时器与切枪计时器互相覆盖 —— 两个都不做才是对的。
   */
  receiveSwitchSlot(playerId: number, slot: number): void {
    const player = this.players.get(playerId)
    if (!player || !player.alive) return
    if (player.reloading) return
    // currentSlot 立刻生效，只有"举好"要等到 switchDoneTick。
    // 天赋"左右开工"把切枪用时打 6 折：倍率必须传进来，否则客户端动画会和服务端的
    // "能不能开火"错开半秒，表现为按了左键没反应。
    if (requestSwitch(player.loadout, slot, this.tick, switchScale(player.traits))) this.abortHeal(player)
  }

  /**
   * 收到玩家的主武器选择。
   *
   * 只在"还没开过枪"时接受：打到一半换成狙击枪，等于白送一次满弹配装 ——
   * `lastFireTick` 恰好就是这个事实（createLoadout 把它设成 -1e9，第一次
   * 真正开火之后才变成当前 tick）。重生时 resetLoadout 会把它还原，所以
   * 死了之后仍然可以在菜单外重新挑，只是那一局已经打出去的枪作数。
   */
  receiveLoadout(playerId: number, weaponId: number, traits = 0): void {
    const player = this.players.get(playerId)
    if (!player) return
    if (player.loadout.lastFireTick > 0) {
      this.sendText(player, '已经开过枪 · 配装锁定')
      return
    }
    // 天赋先落：即使武器没变（大厅里只改天赋），这一句也必须生效。
    // clampTraitLevels 顺手挡掉改过的 localStorage、越界等级与超过三条的选择。
    player.traits = clampTraitLevels(traits)
    // 强健：生命上限跟着天赋走。回血上限、出生血量、血条都得读同一个数。
    player.maxHealth = MAX_HEALTH + maxHealthBonus(player.traits)
    player.health = Math.min(player.health, player.maxHealth)
    const primary = isPrimaryChoice(weaponId) ? weaponId : DEFAULT_WEAPON_ID
    if (primary === player.loadout.primaryId) return
    player.loadout = createLoadout(primary)
    player.reloading = false
  }

  /** 收到一个输入包。只入队，真正的模拟在 tick 里做。 */
  receiveInput(playerId: number, inputs: PlayerInput[], ackedTick: number): void {
    const player = this.players.get(playerId)
    if (!player) return
    player.ackedTick = ackedTick
    for (const input of inputs) {
      // 重发/乱序的旧包直接丢，否则会把人往旧位置拽。
      if (input.seq <= player.ackSeq) continue
      player.queue.push(input)
    }
    // 队列太长说明客户端发得比我们消费得快（或它在补发一堆旧输入）。
    // 只留最新的一批：旧输入早就没意义了，留着只会放大操作延迟。
    if (player.queue.length > MAX_INPUTS_PER_TICK * 2) {
      player.queue.splice(0, player.queue.length - MAX_INPUTS_PER_TICK)
    }
  }

  // ------------------------------------------------------------ tick

  /**
   * 前进恰好一个 tick：按注册顺序跑完九个固定步阶段。
   *
   * 这里不读时钟 —— 一个 tick 就是一个 tick，"真实时间够不够"是 pump 的事。
   * 测试直接调它推进，所以它可以被跑得比墙钟快得多。
   */
  private step(): void {
    const phases = this.phases.with('fixedUpdate')
    for (let i = 0; i < phases.length; i++) phases[i]!.system.fixedUpdate?.(TICK_DT, this.ctx)
  }

  /** 阶段 1：tick 计数、尸体过期、断线超时。 */
  private beginTick(): void {
    this.tick++
    // 尸体缓存到期就消失；如果它带着赏金，下一次 match.step 会看到
    // bountyOnGround()=false，把阶段退回 banish（赏金回到血巢）。
    if (this.bodyCaches.length > 0) {
      this.bodyCaches = this.bodyCaches.filter((cache) => cache.expiresTick > this.tick)
    }
    // 断线保留超时：每 30 tick（0.5s）查一次，避免每 tick 对每个玩家调 Date.now。
    if (this.tick % 30 === 0) {
      const now = Date.now()
      for (const player of this.players.values()) {
        if (player.detachedAt > 0 && now - player.detachedAt >= DISCONNECT_GRACE_MS) {
          this.removePlayer(player.id)
        }
      }
    }
  }

  /**
   * 阶段 3：消费玩家输入与复活。
   *
   * 排在怪物之后：这样同一 tick 里玩家的射线看到的是本 tick 的怪，反过来会
   * 永远差一 tick，表现为"明明擦着边打过去却判定命中"。
   */
  private stepInputs(): void {
    for (const player of this.players.values()) {
      if (!player.alive) {
        if (this.tick >= player.respawnTick) this.respawn(player)
        continue
      }
      let consumed = 0
      while (player.queue.length > 0 && consumed < MAX_INPUTS_PER_TICK) {
        const input = player.queue.shift()!
        consumed++
        this.applyInput(player, input)
        player.ackSeq = input.seq
      }
      if (consumed === 0) {
        // 没有新输入也要推进物理，否则玩家会悬在空中。
        // 复用上一次的输入（速度继续、重力继续），而不是清零。
        this.characterStep(player, player.lastInput)
      }
      this.tickTimers(player)
    }
  }

  /** 阶段 5：搜刮与包扎进度。都用物理推进后的落点算，理由见各自动机。 */
  private stepInteractions(): void {
    // 搜索进度用**物理推进后**的落点算：放前面会拿到上一 tick 的脚底位置，
    // 在人贴着木板边缘时表现为"明明没动却判成走开了"。
    for (const player of this.players.values()) this.stepSearch(player)
    // 包扎进度也放在物理推进之后：脚底位置是"这一 tick 真的走到了哪"，
    // 放前面会把上一 tick 的位移当成"走开了"，边退边打药会被判成原地不动。
    for (const player of this.players.values()) if (player.heal) this.stepHeal(player)
  }

  /** 阶段 7：目标状态机推进 + 上一局收尾清理。 */
  private stepMatch(): void {
    // 目标状态放在快照之前推进：本 tick 的线索/放逐进度要跟着这一帧的位置走，
    // 放到快照之后会让 HUD 永远比画面慢一帧。
    this.match.step()
    // 上一局结束、match.reset() 回到 hunt 的那一 tick：上一局的尸体缓存不能
    // 跟着进新一局（赏金/现金已经结算过，再留在地上就是白送第二次）。
    const matchPhase = this.match.state.phase
    if (this.lastMatchPhase === 'over' && matchPhase === 'hunt') {
      // 上一局已经结算完：尸体、箱子、玩家身上的现金/物品都必须清掉，
      // 否则下一局可以再结算一次，或者一进场就是一地空箱子。
      this.bodyCaches.length = 0
      // 计数器必须跟着清：否则累计 63 次死亡后池子只剩 1 个可复用 id，
      // 下一次死亡会把带赏金/战利品的尸体顶掉。
      this.nextBodyId = -2
      this.searchedSpots.clear()
      for (const player of this.players.values()) {
        player.carriedValue = 0
        player.loot = STARTING_BANDAGES > 0 ? [{ id: LOOT_ITEM.Bandage, count: STARTING_BANDAGES }] : []
        player.lastLoot = null
        this.abortSearch(player)
        this.abortHeal(player)
        // 新一局必须是干净的开局：满血、满弹、拿回出生绷带、活人/死人都回到出生点。
        player.health = player.maxHealth
        player.reloading = false
        player.ads = false
        resetLoadout(player.loadout)
        player.respawnTick = 0
        if (!player.alive) {
          this.respawn(player)
        } else {
          player.character.teleport(this.pickSpawn())
        }
      }
    }
    this.lastMatchPhase = matchPhase
  }

  /** 阶段 8：Boss 生命周期与目标广播。 */
  private stepObjective(): void {
    // Boss 跟着线索走：集齐就刷、一局结束就清场。放在 match.step 之后是因为
    // 刷 Boss 的时机就是"lairRevealed 变 true 的那一 tick"。
    if (this.match.state.phase === 'hunt' && this.bossSpawned) this.despawnBoss()
    else if (this.match.state.lairRevealed && !this.bossSpawned) this.spawnBoss()
    this.publishObjective()
  }

  /** 阶段 9：出网节奏 —— 快照 / 战利品 / 事件。 */
  private stepBroadcast(): void {
    if (this.tick % Math.round(TICK_RATE / SNAPSHOT_RATE) === 0) this.broadcastSnapshot()
    if (this.tick % Math.round(TICK_RATE / LOOT_RATE) === 0) this.publishLoot()
    if (this.pendingEvents.length > 0) this.flushEvents()
  }

  private applyInput(player: Player, input: PlayerInput): void {
    // 快照/开火用"带后坐的瞄准朝向"；移动仍然用 input.yaw/pitch（鼠标原始朝向），
    // 否则按住 W 时枪口上跳会把角色也带得斜着走。
    player.yaw = input.aimYaw ?? input.yaw
    player.pitch = input.aimPitch ?? input.pitch
    player.ads = (input.buttons & Buttons.Ads) !== 0
    // 按住语义，和 ads 一样取"最近一次输入里的这一位"，而不是只在这一 tick 有效：
    // 客户端按 20~30Hz 发输入，若某一 tick 没收到包就当松开，30Hz 的客户端永远搜不完。
    player.interact = (input.buttons & Buttons.Interact) !== 0
    player.heal = (input.buttons & Buttons.Heal) !== 0
    player.lastInput = input

    this.characterStep(player, input)

    // 切枪途中不接受换弹：手上这把还没举稳，谈换弹没有意义；更实际的理由是
    // 换弹计时器只有一个，允许就能"切枪刷新换弹"，两套计时器互相覆盖。
    if (
      !player.reloading &&
      !isSwitching(player.loadout, this.tick) &&
      (input.buttons & Buttons.Reload) !== 0
    ) {
      const spec = heldWeapon(player.loadout)
      // 刀没有弹匣；满弹或备弹为 0 也不该起换弹动作。
      if (canReload(player.loadout)) {
        player.reloading = true
        player.reloadDoneTick = this.tick + Math.ceil(spec.reloadMs / TICK_MS)
      }
    }

    if ((input.buttons & Buttons.Fire) !== 0) this.tryFire(player)
  }

  private characterStep(player: Player, input: PlayerInput): void {
    player.character.step(this.physics, input, TICK_DT)
  }

  private tickTimers(player: Player): void {
    if (player.reloading && this.tick >= player.reloadDoneTick) {
      player.reloading = false
      refillSlot(player.loadout)
    }
  }

  // ------------------------------------------------------------ 搜刮

  /**
   * 附近最近的可搜目标：静态点 0..N，或尸体缓存 -2..-64；没有返回 -1。
   *
   * 两类共用一整套搜索状态机：按住、站住、1.4 秒。尸体没有"已搜过"集合，
   * 拿走即从 bodyCaches 里删除。
   */
  private nearestSpot(x: number, z: number): number {
    let best = SPOT_ID_NONE
    // 半径当初始上界：<= SEARCH_RADIUS 才算"够得着"。
    let bestDist = SEARCH_RADIUS
    const spots = this.level.searchSpots
    if (spots) {
      for (let i = 0; i < spots.length; i++) {
        if (this.searchedSpots.has(i)) continue
        const spot = spots[i]!
        const dist = Math.hypot(spot.x - x, spot.z - z)
        if (dist <= bestDist) {
          bestDist = dist
          best = i
        }
      }
    }
    for (const cache of this.bodyCaches) {
      const dist = Math.hypot(cache.x - x, cache.z - z)
      if (dist <= bestDist) {
        bestDist = dist
        best = cache.id
      }
    }
    return best
  }

  /**
   * 推进一个玩家的搜索状态机。每 tick 一次，读的是物理推进后的真实落点。
   *
   * 三件事同时成立才算在搜：按着交互键、站在 SEARCH_RADIUS 内、没挪窝。
   * 任何一条断了进度就归零 —— 进度不允许"存着"，否则可以搜一半跑去打枪再回来
   * 接着搜，1.4 秒的风险窗口就形同虚设。
   */
  private stepSearch(player: Player): void {
    const feet = player.character.feet
    // 提示用的"身边有点"和是否按着键无关，先算出来（死了也照算，客户端好画尸体旁的箱子）。
    player.nearSpotId = this.nearestSpot(feet.x, feet.z)

    if (!player.alive || !player.interact || player.nearSpotId === SPOT_ID_NONE) {
      this.abortSearch(player)
      return
    }

    const anchor = player.searchAnchor
    if (anchor === null) {
      player.searchAnchor = { x: feet.x, z: feet.z }
    } else if (Math.hypot(feet.x - anchor.x, feet.z - anchor.z) > SEARCH_MOVE_TOLERANCE) {
      // 边搜边跑无效：重新起锚并从 0 开始。这里不保留任何进度，
      // 否则"按一下走两步"就能把 1.4 秒摊成几十次小位移，等于可以在跑动中搜完。
      player.searchAnchor = { x: feet.x, z: feet.z }
      player.searchMs = 0
      player.searchSpotId = SPOT_ID_NONE
      return
    }

    player.searchSpotId = player.nearSpotId
    player.searchMs += TICK_MS
    if (player.searchMs < this.searchNeed(player)) return
    this.completeSearch(player, player.nearSpotId)
  }

  /** 结算一个点：标记已搜、发奖、给本人一句中文提示。 */
  private completeSearch(player: Player, spotId: number): void {
    if (spotId < SPOT_ID_NONE) {
      this.completeBodySearch(player, spotId)
      return
    }
    const spot = this.level.searchSpots?.[spotId]
    if (!spot) {
      this.abortSearch(player)
      return
    }
    // 先落"已搜"，再做奖励：中途抛异常也不会留下一个还能再搜的点。
    this.searchedSpots.add(spotId)
    const roll = rollLoot(spotId, spot.kind, this.lootSeed)
    // 拾荒者：搜刮现金 +25%。乘在"这一点的原始现金"上，所以同一个点对带与不带
    // 这个天赋的人给出的数字不同 —— 这正是"天赋改变了你的收益曲线"。
    // 再乘本局 modifier 的现金倍率：虫潮那种"怪多钱多"的局，收益曲线整条上移。
    const modifier = getModifier(this.modifier)
    let cash = Math.round(roll.cash * lootCashScale(player.traits) * modifier.cashScale)
    const gains: string[] = [`$${roll.cash}`]

    for (const item of roll.items) {
      // 物品立刻生效，不做背包操作：现在还不需要"从背包里拿绷带包扎"这层延迟，
      // 多一层只会让"搜到东西"这件事在体感上变钝。
      if (item.id === LOOT_ITEM.Bandage) {
        // 绷带只进背包，不再顺手把血补上。
        //
        // 立刻回血会让"打药"这个动作永远不可能存在：搜到东西的瞬间血就满了，
        // 谁还会站在原地按住 F 一秒八？现在绷带是**要在交战间隙主动用的资源**，
        // 用完就少一条，所以"什么时候扎"才是一个决策。
      } else if (item.id === LOOT_ITEM.Ammo) {
        // 弹药进备弹池，而不是凭空塞满弹匣：换弹仍然要花时间。
        addReserve(player.loadout, Math.max(1, heldWeapon(player.loadout).magazine))
      } else if (item.id === LOOT_ITEM.Liquor) {
        // 没有体力系统，所以烈酒只按价值算（+30 一瓶）。
        cash += 30 * item.count
      } else if (item.id === LOOT_ITEM.Watch) {
        cash += 90 * item.count
      }
      const owned = player.loot.find((entry) => entry.id === item.id)
      if (owned) owned.count = Math.min(255, owned.count + item.count)
      else player.loot.push({ id: item.id, count: item.count })
      gains.push(`${LOOT_ITEM_NAME[item.id]} ×${item.count}`)
    }

    player.carriedValue += cash
    // 提示走已有的事件/文本通道发给本人：搜到东西必须有反馈，否则玩家不知道自己拿到了什么。
    this.sendText(player, `搜到 ${gains.join('、')}`)
    this.abortSearch(player)
  }

  /**
   * 搜完一具尸体：现金/物品直接进背包；如果它带着赏金，搜的人立刻成为携带者。
   *
   * 赏金不刷新 `banishProgress`，因为 Boss 已经死了；直接把阶段拉回 extract，
   * 让"杀掉携带者 → 摸尸体 → 跑路"成为一条完整链路，而不是回血巢再站 25 秒。
   */
  private completeBodySearch(player: Player, cacheId: number): void {
    const index = this.bodyCaches.findIndex((cache) => cache.id === cacheId)
    if (index < 0) {
      this.abortSearch(player)
      return
    }
    const cache = this.bodyCaches[index]!
    this.bodyCaches.splice(index, 1)
    player.carriedValue = Math.min(0xffff, player.carriedValue + cache.value)
    for (const item of cache.items) {
      const owned = player.loot.find((entry) => entry.id === item.id)
      if (owned) owned.count = Math.min(255, owned.count + item.count)
      else player.loot.push({ id: item.id, count: item.count })
    }

    const gains = cache.items.map((item) => `${LOOT_ITEM_NAME[item.id]} ×${item.count}`)
    this.sendText(player, `尸体搜刮 $${cache.value}${gains.length ? ' · ' + gains.join('、') : ''}`)

    if (cache.bounty && this.match.state.phase !== 'over') {
      this.match.state.bountyCarrier = player.id
      this.match.state.phase = 'extract'
      this.match.state.extractIndex = -1
      this.match.state.extractProgress = 0
      this.sendText(player, '拿到赏金 · 带它去撤离')
      for (const other of this.players.values()) {
        if (other.id !== player.id) this.sendText(other, `${player.nickname} 夺走了赏金`)
      }
    }
    this.abortSearch(player)
  }

  /** 丢掉这一轮进度。松手、走开、死亡、搜完都走这里，保证不会漏清某个字段。 */
  private abortSearch(player: Player): void {
    player.searchMs = 0
    player.searchSpotId = SPOT_ID_NONE
    player.searchAnchor = null
  }

  // ------------------------------------------------------------ 包扎（打药）

  /** 搜完一个点要多久。快手把 1.4 秒打成 0.98 秒。 */
  private searchNeed(player: Player): number {
    return SEARCH_MS * actionScale(player.traits)
  }

  /** 扎一条绷带要多久。 */
  private healNeed(player: Player): number {
    return HEAL_MS * actionScale(player.traits)
  }

  /** 背包里某件物品还有几个。没有就是 0 —— 调用方不用先判 undefined。 */
  private itemCount(player: Player, id: number): number {
    return player.loot.find((entry) => entry.id === id)?.count ?? 0
  }

  /** 扣掉一件物品，扣到 0 就从背包里删掉（结算列表不该出现 ×0）。 */
  private consumeItem(player: Player, id: number, count: number): void {
    const entry = player.loot.find((item) => item.id === id)
    if (!entry) return
    entry.count -= count
    if (entry.count <= 0) player.loot = player.loot.filter((item) => item !== entry)
  }

  /**
   * 推进包扎进度：按住、站着、身上有绷带、血没满，四条缺一不可。
   *
   * 判定结构与 stepSearch 完全一致（锚点 + 位移容差 + 累积毫秒），刻意不合并成
   * 一个"通用进度"函数：两者在完成时的后果差得太远（一个给钱，一个改血），
   * 合并之后每处都要 if (kind === 'search')，比重复二十行更难读。
   */
  private stepHeal(player: Player): void {
    if (!player.alive) {
      this.abortHeal(player)
      return
    }
    // 边搜边扎等于两件事都不花时间，两边共用同一条时间轴反而更好理解：
    // 手上有活就先把包扎停掉。
    if (player.searchMs > 0 || player.reloading) {
      this.abortHeal(player)
      return
    }
    if (this.itemCount(player, LOOT_ITEM.Bandage) <= 0 || player.health >= player.maxHealth) {
      this.abortHeal(player)
      return
    }

    const feet = player.character.feet
    const anchor = player.healAnchor
    if (anchor === null) {
      player.healAnchor = { x: feet.x, z: feet.z }
    } else if (Math.hypot(feet.x - anchor.x, feet.z - anchor.z) > SEARCH_MOVE_TOLERANCE) {
      // 边走边扎无效，理由同搜刮：否则"按住 F 边跑边蹭"能把 1.8 秒摊进位移里。
      player.healAnchor = { x: feet.x, z: feet.z }
      player.healMs = 0
      return
    }

    player.healMs += TICK_MS
    if (player.healMs < this.healNeed(player)) return

    this.consumeItem(player, LOOT_ITEM.Bandage, 1)
    player.health = Math.min(player.maxHealth, player.health + HEAL_AMOUNT)
    this.sendText(player, `包扎完成 +${HEAL_AMOUNT}`)
    this.abortHeal(player)
  }

  /** 丢掉这一轮包扎。松手、走开、开枪、换枪、死亡都走这里。 */
  private abortHeal(player: Player): void {
    player.healMs = 0
    player.healAnchor = null
  }

  /**
   * 把战利品状态发给每个玩家本人。
   *
   * **10Hz 且只在内容变化时发**，理由和 publishObjective 一样但更强：
   * 这个包是 per-player 的（300 字节上限、每人一份），20Hz 全量推等于拿
   * 带宽换"什么也没变"；而搜索进度只在按住交互时变，物品只在一瞬间变，
   * 携带价值更是几分钟不动。10Hz 已经比人眼需要的（进度条）更快了。
   */
  private publishLoot(): void {
    for (const player of this.players.values()) {
      const buffer = encodeLoot({
        value: player.carriedValue,
        searchPct: Math.min(100, Math.floor((player.searchMs / this.searchNeed(player)) * 100)),
        searchSpotId: player.searchSpotId,
        nearSpotId: player.nearSpotId,
        items: player.loot,
        bandages: this.itemCount(player, LOOT_ITEM.Bandage),
        healPct: Math.min(100, Math.floor((player.healMs / this.healNeed(player)) * 100)),
      })
      // 比对编码后的字节而不是逐字段：items 是数组，逐字段比较要单独处理长度和顺序，
      // 而包本身就 9 + 2N 字节，比一遍几乎不要钱。
      const bytes = new Uint8Array(buffer)
      const last = player.lastLoot
      if (last !== null && last.length === bytes.length && last.every((b, i) => b === bytes[i])) continue
      player.lastLoot = bytes
      this.send(player, buffer)
    }
  }

  /** 给单个玩家的系统提示（复用 Msg.Text，不并进广播快照）。 */
  private sendText(player: Player, text: string): void {
    this.send(player, encodeText(text))
  }

  // ------------------------------------------------------------ 射击

  private tryFire(player: Player): void {
    const spec = heldWeapon(player.loadout)
    // 换弹与切枪都是"手上的动作还没做完"：这时候的左键直接丢弃，不排队。
    // 排队会让玩家在切枪结束的那一 tick 连喷好几发 —— 那不是手感，是外挂。
    if (player.reloading) return
    if (!canFire(player.loadout, this.tick, fireIntervalScale(spec.kind, player.traits))) return
    // 开枪即中止包扎：手上既然已经抬枪，那条绷带就没扎完，进度不给保留。
    this.abortHeal(player)
    player.loadout.lastFireTick = this.tick

    // 刀不走弹道：不消耗弹药、不逐颗弹丸、不判距离衰减。
    if (isKnife(spec)) {
      this.meleeSwing(player, spec)
      return
    }

    consumeAmmo(player.loadout)
    player.shotCounter++

    const eye = player.character.eye
    // 延迟补偿：不改刚体，按历史帧做解析求交。
    //
    // 原本的写法是把所有人 setTranslation 回历史帧再 propagateModifiedBodyPositions，
    // 但 Rapier 0.21 的 castRay 先过 broad-phase 的 AABB 剪枝，而那些 AABB 只在
    // step() 里刷新：碰撞体的变换跟上了、剪枝用的还是旧位置，结果回滚后的位置反而
    // 打不到（探针实测 0/5），瞄旧位置也 0/5（窄相位已经用新变换，两头都堵死）。
    // 所以现在：静态几何与怪仍交给引擎判遮挡，玩家胶囊用 rayCapsule 按历史位姿求交。
    const rewindTo = this.rewindTickFor(player)
    const rewindTargets = this.rewindTargets(player, rewindTo)

    const seed = ((player.id << 16) ^ this.tick ^ player.shotCounter) >>> 0
    const rand = mulberry32(seed)

    // 每个弹丸单独判定。霰弹枪 10 颗弹、每颗都可能命中不同的人，
    // 所以先把结果收集起来，恢复完位姿再结算伤害。
    const hits: {
      distance: number
      headshot: boolean
      point: Vec3
      target: ShotTarget
    }[] = []
    let firstDir: Vec3 | null = null

    for (let pellet = 0; pellet < spec.pellets; pellet++) {
      const dir = aimDirection(
        player.yaw,
        player.pitch,
        spec,
        player.ads,
        (rand() * 0x100000000) >>> 0,
        spreadScale(player.traits),
      )
      if (pellet === 0) firstDir = dir
      const result = traceShot(this.physics, {
        origin: eye,
        dir,
        maxDistance: spec.effectiveRange * 3,
        exclude: player.character.collider,
        // 玩家胶囊交给下面的解析求交，引擎只负责墙与怪。
        filter: (collider) => {
          const hit = this.targetOf(collider)
          return hit === null || hit.kind !== 'player'
        },
        classify: (collider) => {
          const target = this.targetOf(collider)
          if (!target) return null
          // 怪的"脚底"就是 AI 的 y，交出去就能复用同一套爆头判定：
          // 猎犬只有 1m 高，永远够不到 HEAD_MIN_HEIGHT(1.45)，天然只能打躯干。
          return target.kind === 'player'
            ? { playerId: target.player.id, feetY: target.player.character.feet.y }
            : {
                playerId: target.monster.data.id,
                feetY: target.monster.data.y,
                // 屠夫 3.3m 高：绝对 1.45m 的头部带会把整个胸腹都算爆头，
                // 1200 血 8 枪就没了。按自身身高给头部下沿。
                headMinHeight:
                  target.monster.data.y + MONSTER_SPECS[target.monster.data.kind].height * 0.78,
              }
        },
      })
      // 引擎这一发只可能打到静态几何或怪（玩家胶囊已被 filter 排除）。
      const maxDistance = spec.effectiveRange * 3
      let bestDistance = result.hit ? result.distance : maxDistance
      let point = result.hit ? result.point : vecAdd(eye, vecScale(dir, maxDistance))
      let target = result.hit && result.collider ? this.targetOf(result.collider) : null
      let feetY = target && target.kind === 'monster' ? target.monster.data.y : 0
      // 蹲姿的头部带下沿来自 rewindTargets；怪按自身身高，静态保持全局值。
      let headMinHeight =
        target && target.kind === 'monster'
          ? target.monster.data.y + MONSTER_SPECS[target.monster.data.kind].height * 0.78
          : HEAD_MIN_HEIGHT

      // 玩家按历史位姿单独求交：只有比遮挡物更近才算打中。
      for (const other of rewindTargets) {
        const d = rayCapsule(eye, dir, other.a, other.b, PLAYER_RADIUS)
        if (d === null || d >= bestDistance) continue
        bestDistance = d
        point = vecAdd(eye, vecScale(dir, d))
        target = { kind: 'player', player: this.players.get(other.playerId)! }
        feetY = other.feetY
        headMinHeight = other.headMinHeight
      }

      if (!target) continue
      hits.push({
        distance: bestDistance,
        headshot: point.y - feetY >= headMinHeight,
        point,
        target,
      })
    }

    // 开枪事件发给所有人（枪声是情报，本作的核心玩法之一）。
    this.pendingEvents.push({
      kind: EventKind.Shot,
      playerId: player.id,
      origin: eye,
      dir: firstDir ?? { x: 0, y: 0, z: -1 },
      weaponId: spec.id,
    })

    for (const hit of hits) {
      this.applyHit(
        player,
        hit.target,
        damageAt(spec, hit.distance, hit.headshot),
        hit.headshot,
        hit.point,
      )
    }
  }

  /**
   * 近战挥砍：扇形判定挑最近的目标，伤害不随距离衰减（刀没有"有效射程"）。
   *
   * 照样发一个 ShotEvent：客户端要靠它播挥刀音效与刀光，否则近战完全没有
   * 反馈；weaponId 是刀的 id，客户端据此知道该放刀声而不是枪声。
   */
  private meleeSwing(player: Player, spec: WeaponSpec): void {
    const eye = player.character.eye
    // 刀不吃散布（spread 0），直接拿视线方向当扇形中心。
    const dir = aimDirection(player.yaw, player.pitch, spec, false, 0)
    const candidates: MeleeCandidate[] = []
    const byId = new Map<number, ShotTarget>()

    for (const other of this.players.values()) {
      // 与射线判定保持一致：不砍自己、不砍尸体。
      if (other === player || !other.alive) continue
      const feet = other.character.feet
      const crouching = other.character.crouching
      const half = crouching ? PLAYER_CROUCH_HALF_HEIGHT : PLAYER_HALF_HEIGHT
      // 胶囊轴线：脚底抬一个半径，向上 2 * halfHeight —— 和 Character 建
      // 碰撞体用的是同一套约定，否则会出现"看得见够不着"的一圈缝。
      const upper = { x: feet.x, y: feet.y + PLAYER_RADIUS + half * 2, z: feet.z }
      candidates.push({
        id: other.id,
        lower: { x: feet.x, y: feet.y + PLAYER_RADIUS, z: feet.z },
        upper,
        radius: PLAYER_RADIUS,
        feetY: feet.y,
        headMinHeight: upper.y + PLAYER_RADIUS - (crouching ? 0.35 : 0.45),
      })
      byId.set(other.id, { kind: 'player', player: other })
    }

    for (const entity of this.monsters) {
      if (entity.data.state === 'dead') continue
      const hb = monsterHurtbox(entity.data)
      candidates.push({
        id: entity.data.id,
        lower: { x: hb.x, y: hb.y - hb.halfHeight, z: hb.z },
        upper: { x: hb.x, y: hb.y + hb.halfHeight, z: hb.z },
        radius: hb.radius,
        feetY: entity.data.y,
        headMinHeight: entity.data.y + MONSTER_SPECS[entity.data.kind].height * 0.78,
      })
      byId.set(entity.data.id, { kind: 'monster', monster: entity })
    }

    this.pendingEvents.push({
      kind: EventKind.Shot,
      playerId: player.id,
      origin: eye,
      dir,
      weaponId: spec.id,
    })

    const hit = meleeStrike(eye, dir, spec, candidates)
    if (!hit) return
    // 刀也要看墙：meleeStrike 只遍历胶囊，不做静态遮挡。薄墙后 0.5m 的目标
    // 仍在 2.4m 刀程内，不补这一条就能隔墙/隔月台地板砍人。
    if (hit.distance > 0.08) {
      const blocked = traceShot(this.physics, {
        origin: eye,
        dir: { x: hit.point.x - eye.x, y: hit.point.y - eye.y, z: hit.point.z - eye.z },
        maxDistance: hit.distance - 0.05,
        exclude: player.character.collider,
        classify: () => null,
      })
      if (blocked.hit) return
    }
    const target = byId.get(hit.id)
    if (!target) return
    // 刀的伤害是平的：把距离夹进 effectiveRange 再算，避免 2.3m 处的
    // 一刀莫名其妙比 2.1m 少 3 点伤害。
    this.applyHit(
      player,
      target,
      damageAt(spec, Math.min(hit.distance, spec.effectiveRange), hit.headshot) *
        meleeDamageScale(player.traits),
      hit.headshot,
      hit.point,
    )
  }

  /**
   * 结算一次命中：事件、扣血、死亡全走这里，子弹与刀共用。
   *
   * 单一入口是刻意的 —— 两条路径各写一遍的结果，总有一条忘了发事件
   * （客户端于是没有血雾），或者忘了判 dead。
   */
  private applyHit(
    attacker: Player,
    target: ShotTarget,
    rawDamage: number,
    headshot: boolean,
    point: Vec3,
  ): void {
    const dmg = Math.round(rawDamage)

    if (target.kind === 'monster') {
      const entity = target.monster
      if (entity.data.state === 'dead') return
      // 石甲：Boss 可以把一部分子弹吃掉，但事件里必须报实际扣血量。
      const resist = MONSTER_SPECS[entity.data.kind].bulletResist ?? 1
      const applied = Math.max(1, Math.round(dmg * resist))
      // 怪物不吃延迟补偿的历史位姿（它们几乎不动，且 PvE 目标不值得
      // 为它多存一份 32 帧历史），所以这里直接用当前时刻的状态。
      this.pendingEvents.push({
        kind: EventKind.MonsterHit,
        attackerId: attacker.id,
        monsterId: entity.data.id,
        damage: applied,
        point,
      })
      // damageMonster 返回"这一击打死了"，扣血也由它做 —— 只有一处改生命值的入口。
      if (damageMonster(entity.data, applied, this.tick)) this.killMonster(entity, attacker.id)
      return
    }

    const victim = target.player
    if (!victim.alive) return
    // 处刑者：打残血目标额外加成。用**这一枪落下之前**的血量比例判定，
    // 否则"这一枪刚好把人打到 39%"也会被算成处刑，读起来是随缘的。
    const ratio = victim.maxHealth > 0 ? victim.health / victim.maxHealth : 1
    const execute = ratio < EXECUTE_BELOW ? executeScale(attacker.traits) : 1
    // 硬皮：受到的伤害 -15%。事件里报的必须是**实际扣掉的血**，否则客户端
    // 那行"命中 75"会和血条对不上，玩家会怀疑是自己没打中。
    const taken = Math.max(1, Math.round(dmg * execute * damageTakenScale(victim.traits)))
    victim.health -= taken
    this.pendingEvents.push({
      kind: EventKind.Hit,
      attackerId: attacker.id,
      victimId: victim.id,
      damage: taken,
      headshot,
      point,
    })
    if (victim.health <= 0) this.kill(victim, attacker.id, headshot)
  }

  /** killerId 可以是玩家也可以是怪物（共用一套 id 空间），所以只传 id 不传对象。 */
  private kill(victim: Player, killerId: number, headshot: boolean): void {
    const feet = victim.character.feet
    const carried = victim.carriedValue
    const loot = victim.loot.map((item) => ({ id: item.id, count: item.count }))
    const hadBounty = this.match.state.bountyCarrier === victim.id
    victim.health = 0
    victim.alive = false
    victim.respawnTick = this.tick + Math.ceil(RESPAWN_DELAY_MS / TICK_MS)
    victim.reloading = false
    // 死即掉落：现金和背包转进尸体缓存，而不是凭空消失。击杀者/其他人必须
    // 走到尸体边按住 E 才能拿走 —— 这就是"击杀有回报"和"死亡有代价"的交点。
    if (carried > 0 || loot.length > 0 || hadBounty) {
      let id = this.nextBodyId--
      if (id < SPOT_ID_MIN) {
        const oldest = this.bodyCaches.shift()
        if (oldest) {
          id = oldest.id
        } else {
          // 池子空但计数器已经跑到底（例如刚清过场）：复位再发，避免永远只复用 -64。
          this.nextBodyId = -2
          id = this.nextBodyId--
        }
      }
      this.bodyCaches.push({
        id,
        x: feet.x,
        z: feet.z,
        value: carried,
        items: loot,
        bounty: hadBounty,
        expiresTick: this.tick + Math.ceil(BODY_CACHE_TTL_MS / TICK_MS),
      })
    }
    victim.carriedValue = 0
    victim.loot = []
    this.abortSearch(victim)
    this.abortHeal(victim)
    // 尸体不再挡子弹：否则队友对着尸体开火会被"看不见的墙"吃掉一发。
    victim.character.setColliderEnabled(false)

    // 击杀奖励：只对玩家击杀生效（killerId < MONSTER_ID_BASE），自杀/被怪杀不给。
    if (killerId !== victim.id && killerId < MONSTER_ID_BASE) {
      const killer = this.players.get(killerId)
      if (killer) {
        killer.carriedValue = Math.min(0xffff, killer.carriedValue + KILL_REWARD)
        this.sendText(killer, `击杀奖励 +$${KILL_REWARD} · 去尸体处搜刮`)
      }
    }
    if (hadBounty) {
      // 赏金从"回炉"改成"掉落"：阶段保持 extract，cache.bounty 让
      // stepExtract 在有人摸到之前不要退回 banish。
      this.match.state.bountyCarrier = 0
      for (const player of this.players.values()) {
        this.sendText(player, '赏金掉落 · 去尸体处夺取')
      }
    }
    this.pendingEvents.push({
      kind: EventKind.Death,
      victimId: victim.id,
      killerId,
      headshot,
    })
  }

  private respawn(player: Player): void {
    const spawn = this.pickSpawn()
    player.health = player.maxHealth
    player.alive = true
    player.reloading = false
    player.ads = false
    // 重生 = 重新配装：上一命打空的弹匣不该跨命继承。
    resetLoadout(player.loadout)
    player.character.teleport(spawn)
    player.character.setColliderEnabled(true)
    this.pendingEvents.push({ kind: EventKind.Respawn, playerId: player.id, position: spawn })
  }

  // ------------------------------------------------------------ 延迟补偿

  /**
   * 把"客户端最后收到的快照 tick"换算成回滚目标 tick。
   *
   * 客户端画出来的敌人在它自己那边还要再晚 `INTERP_DELAY_MS`（插值必须
   * 有两个样本才能插，所以画面天然落后一个快照间隔以上）。只回滚到
   * ackedTick 的话，玩家瞄的是"90ms 前的他"、服务端射的是"现在的他"：
   * 横移 5m/s 就差 0.45m，正好一个身位 —— 也就是所有射击游戏里那个
   * "明明打中了却没中"。所以这里要再往回退同样长的时间。
   *
   * 按 `MAX_REWIND_MS` 夹住上限：不夹的话，玩家伪造一个很小的 ackedTick
   * 就能把对手拽到五秒前的位置开枪，那是作弊而不是补偿。
   */
  private rewindTickFor(player: Player): number {
    if (player.ackedTick <= 0) return this.tick
    const maxRewindTicks = Math.floor(MAX_REWIND_MS / TICK_MS)
    const floor = this.tick - maxRewindTicks
    const interpTicks = Math.round(INTERP_DELAY_MS / TICK_MS)
    const target = Math.max(player.ackedTick - interpTicks, floor)
    return Math.min(target, this.tick)
  }

  /**
   * 取历史帧里其他活人的胶囊位姿（解析式延迟补偿用）。
   *
   * 没有对应历史帧时退化成当下位姿 —— 等价于"不补偿"，比凭空少一个人安全：
   * 握手后的第一发、ackSeq 还是 0 的时候都会走到这里。
   */
  private rewindTargets(
    shooter: Player,
    tick: number,
  ): { playerId: number; a: Vec3; b: Vec3; feetY: number; headMinHeight: number }[] {
    const frame = this.history.find((f) => f.tick === tick)
    const out: { playerId: number; a: Vec3; b: Vec3; feetY: number; headMinHeight: number }[] = []
    for (const other of this.players.values()) {
      if (other.id === shooter.id || !other.alive) continue
      const current = other.character.body.translation()
      const entry = frame?.entries.find((e) => e.playerId === other.id)
      const cx = entry ? entry.bx : current.x
      const cy = entry ? entry.by : current.y
      const cz = entry ? entry.bz : current.z
      // 胶囊半高取"身体中心到脚底"再减半径：蹲下时这个值本来就小，不用另外判断姿态。
      const halfHeight = Math.max(0.05, current.y - other.character.feet.y - PLAYER_RADIUS)
      const top = cy + halfHeight + PLAYER_RADIUS
      // 站立头顶 1.9 → 头部带 1.45；蹲下头顶 1.4 → 头部带 1.05。
      // 用半高区分姿态，避免"蹲下永远打不到头"。
      const mid = (PLAYER_HALF_HEIGHT + PLAYER_CROUCH_HALF_HEIGHT) / 2
      const headMinHeight = top - (halfHeight < mid ? 0.35 : 0.45)
      out.push({
        playerId: other.id,
        a: { x: cx, y: cy - halfHeight, z: cz },
        b: { x: cx, y: cy + halfHeight, z: cz },
        feetY: cy - halfHeight - PLAYER_RADIUS,
        headMinHeight,
      })
    }
    return out
  }

  private pushHistory(): void {
    const entries: HistoryEntry[] = []
    for (const player of this.players.values()) {
      const t = player.character.body.translation()
      entries.push({ playerId: player.id, bx: t.x, by: t.y, bz: t.z })
    }
    this.history.push({ tick: this.tick, entries })
    if (this.history.length > SNAPSHOT_HISTORY) this.history.shift()
  }

  // ------------------------------------------------------------ 下行

  private broadcastSnapshot(): void {
    const base: PlayerSnapshot[] = []
    for (const player of this.players.values()) {
      const feet = player.character.feet
      base.push({
        id: player.id,
        x: feet.x,
        y: feet.y,
        z: feet.z,
        vx: player.character.vx,
        vy: player.character.vy,
        vz: player.character.vz,
        yaw: player.yaw,
        pitch: player.pitch,
        health: player.health,
        flags: 0,
        weaponId: heldWeapon(player.loadout).id,
        ammo: heldAmmo(player.loadout),
        reserve: player.loadout.reserveBySlot[player.loadout.currentSlot] ?? 0,
        slot: player.loadout.currentSlot,
        ackSeq: 0,
      })
    }
    // 怪物段对所有人完全相同（没有隐藏信息），一套数组所有人共用。
    const monsterViews: MonsterSnapshot[] = []
    for (const entity of this.monsters) {
      const data = entity.data
      monsterViews.push({
        id: data.id,
        kind: entity.kindCode,
        state: STATE_CODES[data.state],
        x: data.x,
        y: data.y,
        z: data.z,
        yaw: entity.yaw,
        health: data.health,
      })
    }

    const nowMs = this.tick * TICK_MS
    for (const receiver of this.players.values()) {
      // 每个人收到的快照只有 ackSeq 不同（自己的才非零）。
      // 其余字段共用一个数组，避免每帧为每个接收者重新构造 16 个对象。
      const view = base.map((p) => {
        const owner = this.players.get(p.id)!
        return {
          ...p,
          flags: stateFlagsOf({
            grounded: owner.character.grounded,
            crouching: owner.character.crouching,
            ads: owner.ads,
            alive: owner.alive,
            reloading: owner.reloading,
            switching: isSwitching(owner.loadout, this.tick),
          }),
          ackSeq: owner.id === receiver.id ? owner.ackSeq : 0,
        }
      })
      this.send(
        receiver,
        encodeSnapshot({ tick: this.tick, serverTime: nowMs, players: view, monsters: monsterViews }),
      )
    }
  }

  /**
   * 遍历存活玩家的脚底位置，给 MatchDriver 用。
   *
   * 直接返回生成器而不是数组：每 tick 调一次，60Hz 下每 tick 分配一个数组
   * 就是每秒 60 次 GC 压力，而调用方只是遍历一遍。
   */
  private *aliveActors(): Iterable<{ id: number; alive: boolean; feet: Vec3 }> {
    for (const player of this.players.values()) {
      yield { id: player.id, alive: player.alive, feet: player.character.feet }
    }
  }

  /**
   * 把目标状态发给所有人。
   *
   * **只在内容变化时发**：这个包 12 字节、20Hz 全场广播，看起来不多，但它是
   * 全局单份状态 —— 大多数 tick 什么也没变（线索读条时进度在变、站着不动时
   * 一秒都不变）。比对用整包字段而不是"变化标志位"，因为字段少到这个程度，
   * 逐字段比对比维护一套脏标记更不容易漏。
   */
  private publishObjective(): void {
    const buffer = encodeObjective(this.match.toPacket())
    // 比对**编码后的字节**而不是浮点字段：进度是 0..1 的浮点，逐帧都在动，
    // 而线上只有 256 级；按浮点比较等于每次都发，按字节比较才真的过滤掉
    // "变化不足以显示出来"的 tick。
    const bytes = new Uint8Array(buffer)
    const last = this.lastObjective
    if (last !== null && last.length === bytes.length && last.every((b, i) => b === bytes[i])) return
    this.lastObjective = bytes
    for (const player of this.players.values()) this.send(player, buffer)
  }

  private flushEvents(): void {
    const buffer = encodeEvents(this.pendingEvents)
    for (const player of this.players.values()) this.send(player, buffer)
    this.pendingEvents = []
  }

  private send(player: Player, buffer: ArrayBuffer): void {
    // readyState 1 = OPEN。玩家可能刚好在这一 tick 掉线。
    if (player.socket.readyState !== 1) return
    player.socket.send(buffer)
  }

  /**
   * 选一个出生点：**优先离所有人最远的那个**，而不是纯随机。
   *
   * 纯随机会让两个人以不可忽视的概率落在同一个点上（8 个点、2 个人，
   * 撞车概率 12.5%），而出生就贴脸的结果是"刚进游戏就被背后的人打死"。
   * 取最远点是 O(出生点 × 玩家数)，16 人 8 点也就 128 次距离计算，
   * 相比它在体验上消掉的随机灾难，这笔开销不值得省。
   *
   * 同时带一点随机扰动：完全确定的出生顺序会让玩家能预测"下一个进房的人
   * 从哪来"。用较大的随机下限保证候选之间不会因为浮点相等而总是选 index 0。
   */
  private pickSpawn(): Vec3 {
    const spawns = this.level.spawns
    if (spawns.length === 0) return { x: 0, y: this.level.groundY, z: 0 }

    const occupied: Vec3[] = []
    for (const player of this.players.values()) occupied.push(player.character.feet)

    let best = spawns[0]!
    let bestScore = -Infinity
    for (const spawn of spawns) {
      let nearest = Infinity
      for (const other of occupied) {
        const d = Math.hypot(spawn.x - other.x, spawn.z - other.z)
        if (d < nearest) nearest = d
      }
      // 没有其他玩家时 nearest 仍是 Infinity，加随机扰动把选择打散。
      const score = (nearest === Infinity ? 1e6 : nearest) + Math.random() * 4
      if (score > bestScore) {
        bestScore = score
        best = spawn
      }
    }
    return best
  }

  /** 给 /api/game/status 用的自述，避免外部读私有字段。 */
  describe(): { id: string; tick: number; players: number; secondsLeft: number; phase: string } {
    return {
      id: this.id,
      tick: this.tick,
      players: this.players.size,
      secondsLeft: this.match.state.secondsLeft,
      phase: this.match.state.phase,
    }
  }
}
