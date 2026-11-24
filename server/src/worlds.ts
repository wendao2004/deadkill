/**
 * 世界注册表：matchId -> (World, 关卡 id) 的懒创建与回收。
 *
 * 为什么需要它：一个 Rapier World 加上关卡碰撞体大约占 8~20MB。
 * 部署目标是 512MB 上限的容器（宿主 WebLearning 的 docker-compose 给每个
 * 容器都设了硬内存上限），所以"开局就建好 10 个房间"会把预算吃掉一半。
 * 这里的策略是：有人进来才建，人走空了就开始计时，超时销毁。
 *
 * ## 一个进程跑多张图
 *
 * 每个 matchId 自己带一张图。图的来源是客户端 Hello 里请求的 levelId，
 * 由 `registerLevel` 在握手时登记；`get` 建世界时按登记的 id 取 LevelDef。
 * 一张图**一旦被某个 matchId 用上就不能中途换**：World 里已经有玩家的
 * 物理状态（角色碰撞体、怪物、射线），换图等于把人和怪全塞进另一套几何里。
 */

import {
  DEFAULT_LEVEL_ID,
  LEVEL_IDS,
  LEVELS,
  WORLD_IDLE_TIMEOUT_MS,
  getLevel,
  isTimeBand,
  type LevelDef,
  type MatchTimeBand,
} from '@dk/shared'

import { World } from './world.ts'

/** 关卡 id 的解析结果。纯数据，便于单测直接断言。 */
export interface LevelResolution {
  /** 最终采用的关卡 id，保证一定存在于 LEVELS 里。 */
  levelId: string
  /**
   * 请求被拒时原始的 levelId（用于记日志）；null 表示请求被原样接受，
   * 或者客户端压根没请求（旧客户端）。
   */
  rejected: string | null
}

/**
 * 把"客户端请求的关卡 id"解析成一个**一定存在**的关卡 id。
 *
 * 为什么不直接用 `getLevel(requested)`：它遇到未知 id 是抛错的（故意的，
 * 免得"我在调 chapel 怎么进来是沼泽"这种问题查半小时）。但握手路径上不能
 * 因为一个拼错的 query 参数就把人踢下线，所以这里显式校验、显式回落，
 * 并把"拒了什么"作为返回值交给调用方记日志。
 */
export function resolveLevelId(
  requested: string | null | undefined,
  fallback: string = DEFAULT_LEVEL_ID,
): LevelResolution {
  // 兜底 id 本身也可能被配置错（构造参数），再兜一层。
  const safeFallback = Object.hasOwn(LEVELS, fallback) ? fallback : DEFAULT_LEVEL_ID
  if (!requested) return { levelId: safeFallback, rejected: null }
  if (Object.hasOwn(LEVELS, requested)) return { levelId: requested, rejected: null }
  return { levelId: safeFallback, rejected: requested }
}

/** 大厅里最多保留多少个房间登记（含还没人进的空房）。防止 POST 刷爆内存。 */
const MAX_ROOM_REGISTRATIONS = 64
/** 空房登记多久没人进就回收。有人进过之后由 World 的清扫器接管。 */
const EMPTY_ROOM_TTL_MS = 30 * 60_000

export interface RoomSummary {
  id: string
  levelId: string
  players: number
  secondsLeft: number
  phase: string
  roster: { id: number; name: string; team: number; alive: boolean }[]
}

export interface WorldRegistryOptions {
  onSettle?: (userId: string, earned: number) => number
  /** 同时存在的活跃世界上限。512MB 容器按每房 8–20MB 估算，默认 2。 */
  maxActiveWorlds?: number
  /** RSS 水位（MB）；超过后拒绝新建世界。默认 380（给容器留 132MB 余量）。 */
  rssLimitMb?: number
  /** 测试注入；默认读 process.memoryUsage().rss。 */
  rss?: () => number
}

export class WorldRegistry {
  private readonly worlds = new Map<string, World>()
  /** matchId -> 关卡 id。世界被清扫掉时一起删，避免这张表无限增长。 */
  private readonly levels = new Map<string, string>()
  /**
   * matchId -> 时段（day / night）。没登记的 matchId 不在表里，世界全池抽。
   *
   * 和 levels 一样是世界级的属性：它决定的是"这一局是白昼还是夜"，进世界
   * 之后由 modifier 固化，客户端从目标包读回来。
   */
  private readonly times = new Map<string, MatchTimeBand>()
  /** matchId -> 空房登记时间。只用于回收"创建了但一直没人进"的房间。 */
  private readonly registeredAt = new Map<string, number>()
  private readonly defaultLevelId: string
  private readonly onSettle?: (userId: string, earned: number) => number
  private readonly maxActiveWorlds: number
  private readonly rssLimitMb: number
  private readonly rss: () => number
  private sweeper: NodeJS.Timeout | null = null

  /**
   * @param defaultLevelId 没有登记过图（旧客户端 / 直接取世界）时用哪张图。
   *   非法 id 会被静默换成 DEFAULT_LEVEL_ID —— 构造期抛错会让整个服务起不来，
   *   而"少一张图"远比"服务挂了"可接受。
   */
  constructor(
    defaultLevelId: string = DEFAULT_LEVEL_ID,
    options: WorldRegistryOptions = {},
  ) {
    this.defaultLevelId = resolveLevelId(defaultLevelId).levelId
    this.onSettle = options.onSettle
    this.maxActiveWorlds = Math.max(1, options.maxActiveWorlds ?? 2)
    this.rssLimitMb = Math.max(64, options.rssLimitMb ?? 380)
    this.rss = options.rss ?? (() => process.memoryUsage().rss)
  }

  /**
   * 创建新世界前的准入检查。
   *
   * 为什么必须放在 registry.get 之外：`?match=` 是客户端随便填的，WS 路径
   * 不经过 `POST /api/rooms`，所以 64 房登记上限挡不住它。一个已登录用户
   * 开 20 条连接、每条不同 match，就能建 20 个 60Hz Rapier 世界。
   */
  admit(matchId: string): { ok: true } | { ok: false; reason: string } {
    if (this.worlds.has(matchId)) return { ok: true }
    // 只统计**有玩家**的世界。空世界会保留 5 分钟给重连，如果也算名额，
    // 两条“进房后退”的连接就能让新 match 五分钟全部被拒（低成本 DoS）。
    let active = 0
    for (const world of this.worlds.values()) {
      if (world.playerCount > 0) active++
    }
    if (active >= this.maxActiveWorlds) {
      return {
        ok: false,
        reason: `活跃世界已达上限（${active}/${this.maxActiveWorlds}）`,
      }
    }
    const rssMb = Math.round(this.rss() / (1024 * 1024))
    if (rssMb >= this.rssLimitMb) {
      return { ok: false, reason: `服务端内存水位过高（${rssMb}MB / ${this.rssLimitMb}MB）` }
    }
    return { ok: true }
  }

  /**
   * 登记"这个 matchId 要进哪张图"，返回**实际**生效的关卡 id。
   *
   * 握手时调用（Hello 里带着客户端想进的图）。四种情况：
   *  - 第一次登记：采纳请求（未知 id 回落到默认图并记一条日志）。
   *  - 已登记过同一张图：幂等返回。
   *  - 已登记过**别的**图，但世界已经空了（`playerCount === 0`）：**采纳新请求**，
   *    顺手销毁那个空世界。原先这里是"一律不换"，后果是房号一旦被谁用过，
   *    这张图就被永久钉死 —— 玩家在大厅换地图卡、换的却是同一张，表现为
   *    「四张图都一样」。空世界里没有任何物理状态可保，换图是安全的。
   *  - 已登记过**别的**图且里面还有人：保持已有世界的图并记日志。不能换 ——
   *    中途换图会让先来的玩家被塞进另一套几何。
   */
  registerLevel(matchId: string, requested: string | null | undefined): string {
    const { levelId, rejected } = resolveLevelId(requested, this.defaultLevelId)
    if (rejected !== null) {
      console.warn(
        `[worlds] 匹配 ${matchId} 请求的关卡 "${rejected}" 不存在，回落到 ${levelId}（可选: ${LEVEL_IDS.join(', ')}）`,
      )
    }
    const existing = this.levels.get(matchId)
    if (existing !== undefined) {
      if (existing === levelId) return existing
      const world = this.worlds.get(matchId)
      if (world === undefined || world.playerCount === 0) {
        if (world) {
          world.dispose()
          this.worlds.delete(matchId)
        }
        this.levels.set(matchId, levelId)
        this.registeredAt.set(matchId, Date.now())
        console.info(`[worlds] 匹配 ${matchId} 空场，按请求从 ${existing} 换成 ${levelId}`)
        return levelId
      }
      console.warn(
        `[worlds] 匹配 ${matchId} 已经在 ${existing} 上，忽略新请求 ${levelId}（世界不中途换图：里面还有 ${world.playerCount} 人）`,
      )
      return existing
    }
    this.levels.set(matchId, levelId)
    this.registeredAt.set(matchId, Date.now())
    return levelId
  }

  /**
   * 登记"这一局要白天还是夜里"。
   *
   * 与关卡同一套规则：**第一个进来的客户端决定**，后来的只能跟随。理由一样 ——
   * 世界一旦建好，光照/雾/怪物数量都按当时的 modifier 铺下去了，中途改时段
   * 等于把整局的氛围换掉，而玩家可能正趴在草丛里。
   *
   * 返回最终生效的时段；null = 没指定（旧客户端），由 World 自己全池抽。
   * 空场时可以改（和换图一样），这样"上一局玩的是夜、下一局想试白天"不必
   * 换个房号。
   */
  registerTime(
    matchId: string,
    requested: string | null | undefined,
  ): MatchTimeBand | null {
    const asked = isTimeBand(requested) ? requested : null
    if (asked === null) return this.times.get(matchId) ?? null
    const existing = this.times.get(matchId)
    if (existing === undefined || existing === asked) {
      this.times.set(matchId, asked)
      return asked
    }
    const world = this.worlds.get(matchId)
    if (world === undefined || world.playerCount === 0) {
      if (world) {
        world.dispose()
        this.worlds.delete(matchId)
      }
      this.times.set(matchId, asked)
      console.info(`[worlds] 匹配 ${matchId} 空场，时段 ${existing} → ${asked}`)
      return asked
    }
    console.warn(
      `[worlds] 匹配 ${matchId} 已经跑在 ${existing}，忽略时段请求 ${asked}（里面还有 ${world.playerCount} 人）`,
    )
    return existing
  }

  /** 这个 matchId 登记的时段；null = 没指定，世界按旧规则全池抽。 */
  timeBandOf(matchId: string): MatchTimeBand | null {
    return this.times.get(matchId) ?? null
  }

  /** 大厅创建房间时防止撞上已有 id / 世界。 */
  has(matchId: string): boolean {
    return this.levels.has(matchId) || this.worlds.has(matchId)
  }
  /** 当前登记的房间数（含空房），用于创建上限。 */
  get roomCount(): number {
    return this.levels.size
  }

  /**
   * 大厅房间列表：活跃世界 + 已创建但还没人进的空房。
   *
   * 空房必须出现在列表里，否则"创建房间"之后别人在列表里永远找不到它 ——
   * 只能靠房号手输，那就等于没有房间列表。
   */
  listRooms(): RoomSummary[] {
    const out: RoomSummary[] = []
    for (const world of this.worlds.values()) {
      const description = world.describe()
      out.push({ ...description, levelId: this.levelIdOf(description.id) })
    }
    for (const [id, levelId] of this.levels) {
      if (this.worlds.has(id)) continue
      out.push({ id, levelId, players: 0, secondsLeft: 0, phase: 'lobby', roster: [] })
    }
    // 有人的房间排前面；同人数按房号，结果稳定，不随 Map 插入顺序跳。
    out.sort((a, b) => b.players - a.players || a.id.localeCompare(b.id))
    return out
  }

  canCreateRoom(): boolean {
    return this.levels.size < MAX_ROOM_REGISTRATIONS
  }

  /** 这个 matchId 实际用的关卡 id（未登记 = 默认图）。Welcome 包要用它回传。 */
  levelIdOf(matchId: string): string {
    return this.levels.get(matchId) ?? this.defaultLevelId
  }

  /**
   * 取一个世界，不存在就建。
   *
   * 建完立刻 `start()`：tick 循环必须在第一个玩家入场之前跑起来，
   * 否则握手到第一 tick 之间加入的玩家会看到一个静止的世界。
   */
  get(matchId: string): World {
    let world = this.worlds.get(matchId)
    if (!world) {
      world = new World({
        id: matchId,
        level: this.levelOf(matchId),
        timeBand: this.timeBandOf(matchId),
        onEmpty: (id) => this.scheduleSweep(id),
        onSettle: this.onSettle,
      })
      this.worlds.set(matchId, world)
    }
    // 空世界在最后一人离开时 stop()；这里重新拉起，start() 对已在跑的是 no-op。
    world.start()
    return world
  }

  /** 当前活跃世界数，给 /api/game/status 用。满员判定、容量观测都靠它。 */
  get size(): number {
    return this.worlds.size
  }

  /** 关卡对象永远来自 getLevel：保证 LevelDef 与登记的 id 一致，不会互相打架。 */
  private levelOf(matchId: string): LevelDef {
    return getLevel(this.levelIdOf(matchId))
  }

  /** 状态接口：每个世界用哪张图必须能一眼看出来，否则"谁在跑 chapel"只能靠猜。 */
  describe(): { worlds: (ReturnType<World['describe']> & { levelId: string })[] } {
    return {
      worlds: [...this.worlds.values()].map((w) => {
        const description = w.describe()
        return { ...description, levelId: this.levelIdOf(description.id) }
      }),
    }
  }

  /**
   * 定期清扫空世界。
   *
   * 用 30 秒的粗粒度轮询而不是给每个世界挂一个 setTimeout：
   * 世界可能被反复进出，反复 clearTimeout/setTimeout 会漏一个就永久泄漏
   * 一个 World（以及它那 8~20MB 的 WASM 内存）。轮询的代价是"多留了最多
   * 30 秒"，比泄漏便宜得多。
   */
  startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), 30_000)
    // 不要因为清扫器让进程无法退出。
    this.sweeper.unref?.()
  }

  stop(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    for (const world of this.worlds.values()) world.dispose()
    this.worlds.clear()
    this.levels.clear()
    this.times.clear()
  }

  private scheduleSweep(_id: string): void {
    // 世界变空时不需要立刻做什么 —— 清扫器会按 idleFor 判断。
    // 保留这个钩子是为了将来能在这里记指标（例如"这局持续了多久"）。
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, world] of this.worlds) {
      if (world.idleFor(now) < WORLD_IDLE_TIMEOUT_MS) continue
      world.dispose()
      this.worlds.delete(id)
      // 世界没了就别再记着它用哪张图：否则每个来过的 matchId 永久占一条。
      // 重新进来时由 Hello 重新协商，空世界里没有状态可保。
      this.levels.delete(id)
      this.times.delete(id)
      this.registeredAt.delete(id)
    }
    // 创建了房间但一直没人进：30 分钟后回收登记，否则大厅列表会被空房撑满。
    for (const [id, at] of this.registeredAt) {
      if (this.worlds.has(id)) continue
      if (now - at < EMPTY_ROOM_TTL_MS) continue
      this.levels.delete(id)
      this.times.delete(id)
      this.registeredAt.delete(id)
    }
  }
}
