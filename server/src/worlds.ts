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
  type LevelDef,
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

export class WorldRegistry {
  private readonly worlds = new Map<string, World>()
  /** matchId -> 关卡 id。世界被清扫掉时一起删，避免这张表无限增长。 */
  private readonly levels = new Map<string, string>()
  private readonly defaultLevelId: string
  private sweeper: NodeJS.Timeout | null = null

  /**
   * @param defaultLevelId 没有登记过图（旧客户端 / 直接取世界）时用哪张图。
   *   非法 id 会被静默换成 DEFAULT_LEVEL_ID —— 构造期抛错会让整个服务起不来，
   *   而"少一张图"远比"服务挂了"可接受。
   */
  constructor(defaultLevelId: string = DEFAULT_LEVEL_ID) {
    this.defaultLevelId = resolveLevelId(defaultLevelId).levelId
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
          world.stop()
          this.worlds.delete(matchId)
        }
        this.levels.set(matchId, levelId)
        console.info(`[worlds] 匹配 ${matchId} 空场，按请求从 ${existing} 换成 ${levelId}`)
        return levelId
      }
      console.warn(
        `[worlds] 匹配 ${matchId} 已经在 ${existing} 上，忽略新请求 ${levelId}（世界不中途换图：里面还有 ${world.playerCount} 人）`,
      )
      return existing
    }
    this.levels.set(matchId, levelId)
    return levelId
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
        onEmpty: (id) => this.scheduleSweep(id),
      })
      world.start()
      this.worlds.set(matchId, world)
    }
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
    for (const world of this.worlds.values()) world.stop()
    this.worlds.clear()
    this.levels.clear()
  }

  private scheduleSweep(_id: string): void {
    // 世界变空时不需要立刻做什么 —— 清扫器会按 idleFor 判断。
    // 保留这个钩子是为了将来能在这里记指标（例如"这局持续了多久"）。
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, world] of this.worlds) {
      if (world.idleFor(now) < WORLD_IDLE_TIMEOUT_MS) continue
      world.stop()
      this.worlds.delete(id)
      // 世界没了就别再记着它用哪张图：否则每个来过的 matchId 永久占一条。
      // 重新进来时由 Hello 重新协商，空世界里没有状态可保。
      this.levels.delete(id)
    }
  }
}
