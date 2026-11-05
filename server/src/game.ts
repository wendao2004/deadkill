/**
 * 游戏对外的两个入口：状态查询与 WebSocket 会话。
 *
 * 作为一个普通的 Fastify 插件挂到宿主 app 上（`app.register(registerGame)`），
 * 这样它和宿主的登录、限流、审计、静态服务共用同一个进程、同一份监听端口。
 * 没有单独的 HTTP 服务器、没有额外的容器 —— 宿主部署在 512MB 硬上限的容器里，
 * 多一个进程就多一份 baseline。
 *
 * ## 为什么是 WebSocket 而不是宿主已有的 SSE
 *
 * 宿主的 `realtime.ts` 用 SSE，那对聊天是正确的（单向推送、零依赖、自带重连）。
 * 但射击游戏需要**每 tick 上行输入**：用 POST 上传的话每个输入都带一整套
 * HTTP 头（几百字节换 15 字节的负载），而且浏览器对单域只有 6 个 HTTP/1.1
 * 连接，两个玩家就能把连接池占满，聊天和文件下载一起卡住。SSE 还设不了
 * `binaryType`，二进制得走 base64（+33%）。所以两条通道并存：
 * 聊天走 SSE，游戏走 `/ws/game`。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import {
  MAX_INPUTS_PER_PACKET,
  Msg,
  initPhysics,
  PROTOCOL_VERSION,
  SNAPSHOT_RATE,
  TICK_RATE,
  decodeHello,
  decodeInputPacket,
  decodeLoadout,
  decodeSwitchSlot,
  encodeWelcome,
  type PlayerInput,
} from '@dk/shared'

import { WorldRegistry } from './worlds.ts'

export interface GameAuthResult {
  /** 稳定用户标识。同一个账号重连后仍然拿到同一个 id，用于战绩与养成存档。 */
  userId: string
  nickname: string
}

export interface GameOptions {
  /**
   * 从握手请求里解析出玩家身份。
   *
   * 集成进 WebLearning 时传 `(req) => { const u = currentUser(req); ... }`
   * 复用宿主的 cookie 会话；不传则退回开发模式的匿名连接。
   */
  authenticate?: (request: FastifyRequest) => GameAuthResult | null
  /** 开发模式允许无鉴权连接。生产必须为 false，否则任何人都能进游戏。 */
  allowAnonymous?: boolean
  /** 每个连接每秒允许的消息数上限，超过直接断开。 */
  maxMessagesPerSecond?: number
}

/** 每秒允许的输入包数量。客户端按 60Hz 发，留一倍余量。 */
const DEFAULT_MAX_MSG_PER_SEC = 120

/** 单条 WebSocket 消息的大小上限，防止有人发个 10MB 的包把堆打满。 */
const MAX_MESSAGE_BYTES = 4096

export function registerGame(
  app: FastifyInstance,
  options: GameOptions = {},
): void {
  const allowAnonymous = options.allowAnonymous ?? false
  const maxPerSecond = options.maxMessagesPerSecond ?? DEFAULT_MAX_MSG_PER_SEC
  const registry = new WorldRegistry()

  registry.startSweeper()
  app.addHook('onClose', async () => registry.stop())

  // 登记插件时还没 await 物理初始化，但路由不能等到那时才注册。
  // 用一个 promise 把"就绪"这件事补齐：每个连接 await 它即可，
  // 而 /api/game/status 不需要物理世界，立刻就能答。
  const physicsReady = initPhysics()

  app.get('/api/game/status', async () => ({
    ok: true as const,
    protocolVersion: PROTOCOL_VERSION,
    tickRate: TICK_RATE,
    snapshotRate: SNAPSHOT_RATE,
    ...registry.describe(),
  }))

  app.get('/ws/game', { websocket: true }, (socket, request) => {
    handleConnection(socket, request, { registry, physicsReady, allowAnonymous, maxPerSecond, authenticate: options.authenticate })
  })
}

interface ConnectionContext {
  registry: WorldRegistry
  physicsReady: Promise<void>
  allowAnonymous: boolean
  maxPerSecond: number
  authenticate?: (request: FastifyRequest) => GameAuthResult | null
}

function handleConnection(
  socket: WebSocket,
  request: FastifyRequest,
  ctx: ConnectionContext,
): void {
  const query = request.query as Record<string, string | undefined>
  const matchId = sanitizeMatchId(query.match ?? 'default')

  let playerId = 0
  let world: ReturnType<WorldRegistry['get']> | null = null
  let closed = false

  // 令牌桶：每秒补满一次。比"每个包都查一次时间戳"便宜，
  // 而且能容许 60Hz 客户端的正常抖动。
  let tokens = ctx.maxPerSecond
  const refill = setInterval(() => {
    tokens = ctx.maxPerSecond
  }, 1000)
  refill.unref?.()

  const cleanup = (detach: boolean) => {
    if (closed) return
    closed = true
    clearInterval(refill)
    if (world && playerId) {
      // 正常退出（客户端 close(1000)）立刻移除；网络断开先保留 20 秒等重连。
      if (detach) world.detachPlayer(playerId)
      else world.removePlayer(playerId)
    }
    world = null
    playerId = 0
  }

  // 关连接必须留痕：玩家"莫名其妙退回大厅"基本都发生在这一行附近，
  // 没有这条日志就只能猜是握手超时、房间满，还是他自己的客户端断的。
  // 关闭码语义一个字都没改，只是把 ws 给的 code/reason 原样记下来。
  socket.on('close', (code: number, reason: Buffer) => {
    request.log.info(
      { playerId, code, reason: reason.toString(), matchId, ip: request.ip },
      'game ws closed',
    )
    // 1000 = 客户端主动退出；4xxx = 服务端明确拒绝/踢人。两者都立刻移除。
    // 其余（1006 网络断、1001 页面关闭、1012 服务重启等）保留 20 秒等重连。
    cleanup(code !== 1000 && code < 4000)
  })
  socket.on('error', () => cleanup(true))

  // 握手阶段的超时：连上来了却不发 Hello（例如误用浏览器直接打开这个地址），
  // 不能让它一直占着一个连接和一份内存。
  const handshakeTimer = setTimeout(() => {
    if (!world) socket.close(4008, '握手超时')
  }, 5000)
  handshakeTimer.unref?.()

  socket.on('message', async (data: unknown) => {
    if (closed) return
    tokens--
    if (tokens < 0) {
      socket.close(4029, '消息过于频繁')
      return
    }
    const buffer = toArrayBuffer(data)
    if (!buffer || buffer.byteLength > MAX_MESSAGE_BYTES) {
      socket.close(4003, '非法数据包')
      return
    }

    if (!world) {
      // 第一条消息必须是 Hello，否则协议状态就是错的。
      await onHello(buffer)
      return
    }
    if (buffer.byteLength < 1) return
    const kind = new DataView(buffer).getUint8(0)

    // 切枪是低频离散指令，和每帧的输入包分开走：混进 InputPacket 就得为
    // 它发明"边沿还是持续"的语义，而服务端只想要"他按了 1 键"这一个事实。
    if (kind === Msg.SwitchSlot) {
      try {
        world.receiveSwitchSlot(playerId, decodeSwitchSlot(buffer))
      } catch {
        socket.close(4003, '切枪包解析失败')
      }
      return
    }

    // 选枪：进游戏后一次性上报的配装。服务端只在没开过枪时采纳（见
    // World.receiveLoadout），所以它同样是低频离散指令。
    if (kind === Msg.Loadout) {
      try {
        const loadout = decodeLoadout(buffer)
        world.receiveLoadout(playerId, loadout.weaponId, loadout.traits)
      } catch {
        socket.close(4003, '选枪包解析失败')
      }
      return
    }

    if (kind !== Msg.Input) return
    try {
      const packet = decodeInputPacket(buffer)
      world.receiveInput(playerId, packet.inputs.slice(0, MAX_INPUTS_PER_PACKET), packet.ackedTick)
    } catch {
      // 解析失败说明对方协议实现有问题，断掉比继续猜安全。
      socket.close(4003, '输入包解析失败')
    }
  })

  async function onHello(buffer: ArrayBuffer): Promise<void> {
    let hello: ReturnType<typeof decodeHello>
    try {
      hello = decodeHello(buffer)
    } catch {
      socket.close(4003, '期望握手包')
      return
    }
    // 版本不一致直接拒绝，而不是尝试兼容。
    // 二进制协议里字段错位的后果是静默解析出乱数据：玩家的位置会莫名其妙
    // 乱跳、子弹打不中 —— 比"连不上"难查一百倍。
    if (hello.version !== PROTOCOL_VERSION) {
      socket.close(4001, `协议版本不匹配（服务端 ${PROTOCOL_VERSION}）`)
      return
    }

    let identity: GameAuthResult | null = null
    if (ctx.authenticate) {
      identity = ctx.authenticate(request)
      if (!identity) {
        socket.close(4001, '未登录')
        return
      }
    } else if (ctx.allowAnonymous) {
      identity = {
        userId: `anon:${request.ip}`,
        nickname: hello.nickname.trim().slice(0, 16) || '猎人',
      }
    } else {
      socket.close(4001, '未配置鉴权')
      return
    }

    await ctx.physicsReady
    // 先登记"这个 matchId 要进哪张图"，再取世界 —— 反过来的话第一个进来的人
    // 会先被塞进默认图的世界里，而世界一旦建好就不能换图。
    // 旧客户端的 Hello 里没有这一段（decodeHello 给 null），登记的就是默认图。
    ctx.registry.registerLevel(matchId, hello.levelId)
    const target = ctx.registry.get(matchId)
    const joined = target.addPlayer(socket, identity.nickname, identity.userId)
    if (!joined) {
      socket.close(4009, '房间已满')
      return
    }
    clearTimeout(handshakeTimer)
    world = target
    playerId = joined.id
    // 进房成功也记一条：和上面的 closed 成对，才能算出每个人在局里待了多久、
    // 是"根本没进来"还是"进来后被断"。
    request.log.info(
      { playerId: joined.id, nickname: identity.nickname, matchId, ip: request.ip },
      'game joined',
    )

    socket.send(
      encodeWelcome({
        playerId: joined.id,
        tickRate: TICK_RATE,
        snapshotRate: SNAPSHOT_RATE,
        serverTime: target.tickCount * (1000 / TICK_RATE),
        spawn: joined.spawn,
        // 回传**实际**用的图：客户端可能请求的是 chapel，但这个 matchId 的
        // 世界已经被别人按 quarry 建好了。客户端拿这个 id 校正自己的渲染。
        levelId: ctx.registry.levelIdOf(matchId),
      }),
    )
  }
}

/**
 * 把 ws 给的 `RawData` 转成 ArrayBuffer。
 *
 * ws 在 Node 下给的是 Buffer（可能是一个共享池的视图），所以必须按
 * `byteOffset/byteLength` 切片，不能直接拿 `buffer.buffer` —— 那样会带进
 * 同池其它消息的字节，解析出来是一堆垃圾。
 */
function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data as Buffer[])
    return merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength) as ArrayBuffer
  }
  return null
}

/** matchId 只允许简单的字符集，避免它被拼进日志/将来被拼进 SQL 时出问题。 */
function sanitizeMatchId(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
  return cleaned || 'default'
}

export type { PlayerInput }
