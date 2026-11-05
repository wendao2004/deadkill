/**
 * 「这局进哪张图」的唯一决策点。
 *
 * 为什么单独一个文件：这个决策有三方参与（URL 参数、本会话记忆、服务端
 * 实际给的图），散在 main.ts / net.ts / game.ts 里就会变成"三处各自挑一次"，
 * 而它们一旦不一致，表现是**能连上、能动、但站在空气里**（渲染的是 A 图的
 * 几何，服务端在 B 图上跟你算碰撞）。集中在一处，只有一处可能错。
 *
 * 服务端是权威：同一个 matchId 的第一位玩家决定了这张图，后来的人必须跟随。
 */

import { DEFAULT_LEVEL_ID, LEVELS, LEVEL_IDS } from '@dk/shared'

/** URL 上指定关卡的参数名：`?map=chapel-p0`。 */
export const LEVEL_QUERY = 'map'

/** sessionStorage 里记住本会话选的那张图。 */
const STORAGE_KEY = 'dk.level'

/** 已经为了跟随服务端重载过一次的 "本地图>服务端图"，用来兜底防死循环。 */
const FOLLOW_KEY = 'dk.level.followed'

function isKnownLevel(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.length > 0 && Object.hasOwn(LEVELS, id)
}

/**
 * 隐私模式 / 沙箱 iframe 里访问 sessionStorage 会抛异常。
 * 拿不到就当没有 —— 少一层"记住选择"，不该让整局开不起来。
 */
function session(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // 配额满 / 被禁用：不影响本局，忽略。
  }
}

/**
 * 本客户端要进哪张图，优先级：`?map=xxx` > 本会话记住的 > 随机挑一张。
 *
 * 为什么随机而不是永远默认图：多图是这个功能存在的前提，固定默认图等于
 * 每次调试都得手动敲 URL。用 sessionStorage 固定住是因为**刷新必须回到同一张
 * 图** —— 否则重连一次就换一张，服务端还记着旧图，玩家会一直站在空气里。
 */
export function pickLevelId(search: string = location.search, storage: Storage | null = session()): string {
  const asked = new URLSearchParams(search).get(LEVEL_QUERY)
  if (isKnownLevel(asked)) {
    write(storage, STORAGE_KEY, asked)
    return asked
  }

  const remembered = read(storage, STORAGE_KEY)
  if (isKnownLevel(remembered)) return remembered

  const picked = LEVEL_IDS[Math.floor(Math.random() * LEVEL_IDS.length)] ?? DEFAULT_LEVEL_ID
  write(storage, STORAGE_KEY, picked)
  return picked
}

/**
 * 记下"这局要进哪张图"。主界面选图走这里，而不是自己碰 sessionStorage ——
 * 键名与合法性校验只有这一份，两处各写一遍必然漂。
 */
export function rememberLevelId(id: string): void {
  if (isKnownLevel(id)) write(session(), STORAGE_KEY, id)
}

/**
 * 服务端在 Welcome 里回的图与本地**已建好**的图不一致时，整页跳转到
 * `?map=<serverId>`。返回 true 表示"正在重载，别继续用这个页面"。
 *
 * ## 为什么是整页重载而不是热切图
 *
 * Game 在 constructor 里就已经用 options.level 建好了 Renderer 与
 * buildLevelWorld（碰撞体、水面、巢穴、装饰物全在里面），物理世界一旦有
 * 玩家状态就不能换；热切换等于把半个对象图重建一遍，且很难验证"旧世界的
 * 残留句柄有没有全部释放"。整页重载是唯一能保证"渲染与物理从同一份 LevelDef
 * 出发"的做法。
 *
 * 代价是一次重载（~1s 白屏），而且**最多发生一次**：服务端记住这张图，
 * 重载后 URL 上的 ?map= 就是它，第二次握手两边必然一致。
 *
 * 用 location.replace 而不是 assign：跳转链上不该多一条历史记录，否则玩家
 * 点后退会回到那个不匹配的 ?map=xxx，又跳一次，形成"按后退就闪一下"的怪循环。
 */
export function followServerLevel(localLevelId: string, serverLevelId: string | null): boolean {
  if (!isKnownLevel(serverLevelId) || serverLevelId === localLevelId) return false

  const storage = session()
  const pair = `${localLevelId}>${serverLevelId}`
  // 兜底：万一某张图的 LevelDef 有问题反复不匹配，宁可停在原地也不要无限重载。
  if (read(storage, FOLLOW_KEY) === pair) return false
  write(storage, FOLLOW_KEY, pair)
  write(storage, STORAGE_KEY, serverLevelId)

  const url = new URL(location.href)
  url.searchParams.set(LEVEL_QUERY, serverLevelId)
  location.replace(url.toString())
  return true
}
