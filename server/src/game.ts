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
  MAX_PLAYERS,
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

import { WorldRegistry, resolveLevelId } from './worlds.ts'

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

  /**
   * 好友在线状态：菜单/房间页每 15 秒心跳一次。
   *
   * 为什么不复用 World 的玩家表：大厅里"选了房间但还没出击"的人并不在
   * 任何 World 里；没有这份 presence，好友列表只能看到已经进图的人。
   * 它是纯内存、45 秒 TTL 的轻量目录，不参与对局权威。
   */
  const presences = new Map<string, PresenceEntry>()
  const PRESENCE_TTL_MS = 45_000
  const MAX_PRESENCE = 256
  const cleanPresence = (now: number): void => {
    for (const [code, entry] of presences) {
      if (now - entry.at > PRESENCE_TTL_MS) presences.delete(code)
    }
  }

  app.get('/api/presence', async () => {
    const now = Date.now()
    cleanPresence(now)
    return {
      ok: true as const,
      online: [...presences.values()]
        .map(({ code, name, roomId, levelId }) => ({ code, name, roomId, levelId }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  })

  app.post('/api/presence', async (request, reply) => {
    const body = (request.body ?? {}) as {
      code?: unknown
      name?: unknown
      roomId?: unknown
      levelId?: unknown
      leave?: unknown
    }
    const code = sanitizePresenceCode(body.code)
    if (!code) {
      reply.code(400)
      return { ok: false as const, error: '好友码无效' }
    }
    if (body.leave === true) {
      presences.delete(code)
      return { ok: true as const }
    }
    const now = Date.now()
    cleanPresence(now)
    if (!presences.has(code) && presences.size >= MAX_PRESENCE) {
      reply.code(429)
      return { ok: false as const, error: '在线目录已满' }
    }
    presences.set(code, {
      code,
      name: sanitizePresenceName(body.name),
      roomId: sanitizePresenceRoom(body.roomId),
      levelId: sanitizePresenceLevel(body.levelId),
      at: now,
    })
    return { ok: true as const }
  })

  /**
   * 队伍（party）：邀请制，最多 2 人。
   *
   * 与 presence 分开：presence 只回答"谁在线、在哪个房"，party 回答"谁和谁
   * 绑在一起"。队伍只在大厅存在，不参与对局权威；对局只认 Loadout 里带的
   * partyId —— 同 partyId 的两人在服务端被强制编进同一队，并与同队共享出生点。
   */
  const parties = new Map<string, PartyRecord>()
  const partyInvites = new Map<string, PartyInviteRecord>()
  const PARTY_MAX_MEMBERS = 2
  const PARTY_TTL_MS = 2 * 60 * 60_000
  const INVITE_TTL_MS = 60_000

  const cleanParties = (now: number): void => {
    for (const [id, invite] of partyInvites) {
      if (now - invite.at > INVITE_TTL_MS) partyInvites.delete(id)
    }
    for (const [id, party] of parties) {
      if (party.members.length === 0 || now - party.updatedAt > PARTY_TTL_MS) {
        parties.delete(id)
        for (const [inviteId, invite] of partyInvites) {
          if (invite.partyId === id) partyInvites.delete(inviteId)
        }
      }
    }
  }

  const partyOf = (code: string): PartyRecord | null => {
    for (const party of parties.values()) {
      if (party.members.some((member) => member.code === code)) return party
    }
    return null
  }

  const partyView = (party: PartyRecord): PartyView => ({
    id: party.id,
    leader: party.leader,
    members: party.members.map((member) => ({ ...member })),
    roomId: party.roomId,
    levelId: party.levelId,
    launchedAt: party.launchedAt,
  })

  app.get('/api/party/state', async (request) => {
    const code = sanitizePresenceCode((request.query as { code?: unknown }).code)
    const now = Date.now()
    cleanParties(now)
    const party = code ? partyOf(code) : null
    return {
      ok: true as const,
      party: party ? partyView(party) : null,
      invites: code
        ? [...partyInvites.values()]
            .filter((invite) => invite.toCode === code)
            .map((invite) => ({
              id: invite.id,
              partyId: invite.partyId,
              fromCode: invite.fromCode,
              fromName: invite.fromName,
            }))
        : [],
    }
  })

  app.post('/api/party/create', async (request, reply) => {
    const body = (request.body ?? {}) as { code?: unknown; name?: unknown }
    const code = sanitizePresenceCode(body.code)
    if (!code) {
      reply.code(400)
      return { ok: false as const, error: '好友码无效' }
    }
    const now = Date.now()
    cleanParties(now)
    const existing = partyOf(code)
    if (existing) return { ok: true as const, party: partyView(existing) }
    const id = createPartyId(parties)
    const party: PartyRecord = {
      id,
      leader: code,
      members: [{ code, name: sanitizePresenceName(body.name) }],
      roomId: '',
      levelId: '',
      launchedAt: 0,
      updatedAt: now,
    }
    parties.set(id, party)
    return { ok: true as const, party: partyView(party) }
  })

  app.post('/api/party/invite', async (request, reply) => {
    const body = (request.body ?? {}) as { fromCode?: unknown; toCode?: unknown }
    const from = sanitizePresenceCode(body.fromCode)
    const to = sanitizePresenceCode(body.toCode)
    const now = Date.now()
    cleanParties(now)
    const party = partyOf(from)
    if (!party || party.leader !== from) {
      reply.code(403)
      return { ok: false as const, error: '只有队长可以邀请' }
    }
    if (!to || to === from) {
      reply.code(400)
      return { ok: false as const, error: '好友码无效' }
    }
    if (party.members.some((member) => member.code === to)) {
      reply.code(409)
      return { ok: false as const, error: '对方已经在队伍里' }
    }
    if (party.members.length >= PARTY_MAX_MEMBERS) {
      reply.code(409)
      return { ok: false as const, error: '队伍已满' }
    }
    const target = presences.get(to)
    if (!target) {
      reply.code(404)
      return { ok: false as const, error: '好友不在线' }
    }
    for (const [id, invite] of partyInvites) {
      if (invite.partyId === party.id && invite.toCode === to) partyInvites.delete(id)
    }
    const invite: PartyInviteRecord = {
      id: createInviteId(partyInvites),
      partyId: party.id,
      fromCode: from,
      fromName: party.members.find((member) => member.code === from)?.name ?? '队长',
      toCode: to,
      at: now,
    }
    partyInvites.set(invite.id, invite)
    party.updatedAt = now
    return { ok: true as const, invite: { id: invite.id } }
  })

  app.post('/api/party/accept', async (request, reply) => {
    const body = (request.body ?? {}) as { code?: unknown; inviteId?: unknown }
    const code = sanitizePresenceCode(body.code)
    const inviteId = typeof body.inviteId === 'string' ? body.inviteId : ''
    const now = Date.now()
    cleanParties(now)
    const invite = partyInvites.get(inviteId)
    if (!code || !invite || invite.toCode !== code) {
      reply.code(404)
      return { ok: false as const, error: '邀请已失效' }
    }
    const party = parties.get(invite.partyId)
    if (!party) {
      partyInvites.delete(inviteId)
      reply.code(404)
      return { ok: false as const, error: '队伍已解散' }
    }
    if (party.members.length >= PARTY_MAX_MEMBERS) {
      reply.code(409)
      return { ok: false as const, error: '队伍已满' }
    }
    // 接受新队伍前先离开旧队伍：一个人只能在一个 party 里。
    for (const [id, other] of parties) {
      if (id === party.id) continue
      const before = other.members.length
      other.members = other.members.filter((member) => member.code !== code)
      if (other.members.length !== before) {
        other.updatedAt = now
        if (other.members.length === 0 || other.leader === code) {
          parties.delete(id)
          for (const [inviteKey, pending] of partyInvites) {
            if (pending.partyId === id) partyInvites.delete(inviteKey)
          }
        }
      }
    }
    const name = presences.get(code)?.name ?? sanitizePresenceName(undefined)
    party.members.push({ code, name })
    party.updatedAt = now
    partyInvites.delete(inviteId)
    for (const [id, pending] of partyInvites) {
      if (pending.toCode === code) partyInvites.delete(id)
    }
    return { ok: true as const, party: partyView(party) }
  })

  app.post('/api/party/decline', async (request) => {
    const body = (request.body ?? {}) as { code?: unknown; inviteId?: unknown }
    const code = sanitizePresenceCode(body.code)
    const inviteId = typeof body.inviteId === 'string' ? body.inviteId : ''
    const invite = partyInvites.get(inviteId)
    if (invite && invite.toCode === code) partyInvites.delete(inviteId)
    return { ok: true as const }
  })

  app.post('/api/party/leave', async (request) => {
    const body = (request.body ?? {}) as { code?: unknown }
    const code = sanitizePresenceCode(body.code)
    const now = Date.now()
    cleanParties(now)
    const party = partyOf(code)
    if (!party) return { ok: true as const }
    party.members = party.members.filter((member) => member.code !== code)
    party.updatedAt = now
    if (party.members.length === 0 || party.leader === code) {
      parties.delete(party.id)
      for (const [id, invite] of partyInvites) {
        if (invite.partyId === party.id) partyInvites.delete(id)
      }
    }
    return { ok: true as const }
  })

  app.post('/api/party/room', async (request, reply) => {
    const body = (request.body ?? {}) as { code?: unknown; roomId?: unknown; levelId?: unknown }
    const code = sanitizePresenceCode(body.code)
    const party = partyOf(code)
    if (!party || party.leader !== code) {
      reply.code(403)
      return { ok: false as const, error: '只有队长可以选房' }
    }
    party.roomId = sanitizePresenceRoom(body.roomId)
    party.levelId = sanitizePresenceLevel(body.levelId)
    party.launchedAt = 0
    party.updatedAt = Date.now()
    return { ok: true as const, party: partyView(party) }
  })

  app.post('/api/party/launch', async (request, reply) => {
    const body = (request.body ?? {}) as { code?: unknown; roomId?: unknown; levelId?: unknown }
    const code = sanitizePresenceCode(body.code)
    const party = partyOf(code)
    if (!party || party.leader !== code) {
      reply.code(403)
      return { ok: false as const, error: '只有队长可以出击' }
    }
    party.roomId = sanitizePresenceRoom(body.roomId)
    party.levelId = sanitizePresenceLevel(body.levelId)
    party.launchedAt = Date.now()
    party.updatedAt = party.launchedAt
    return { ok: true as const, party: partyView(party) }
  })

  app.get('/api/game/status', async () => ({
    ok: true as const,
    protocolVersion: PROTOCOL_VERSION,
    tickRate: TICK_RATE,
    snapshotRate: SNAPSHOT_RATE,
    ...registry.describe(),
  }))

  /**
   * 大厅房间列表。含"已创建但还没人进"的空房，否则创建完只能在列表里消失，
   * 其他玩家永远找不到这局。
   */
  app.get('/api/rooms', async () => ({
    ok: true as const,
    maxPlayers: MAX_PLAYERS,
    rooms: registry.listRooms(),
  }))

  /**
   * 创建房间。只登记房号与地图，真正的 World 仍在第一个玩家 WS 握手时懒创建。
   *
   * 这里不返回世界状态，也不创建物理世界 —— 512MB 容器里"点了创建但没人进"
   * 不应该先吃掉 8~20MB。
   */
  app.post('/api/rooms', async (request, reply) => {
    if (!registry.canCreateRoom()) {
      reply.code(409)
      return { ok: false as const, error: '房间数量已达上限，请稍后再试' }
    }
    const body = (request.body ?? {}) as { levelId?: unknown }
    const requested = typeof body.levelId === 'string' ? body.levelId : null
    const id = createRoomId(registry)
    const { levelId } = resolveLevelId(requested)
    registry.registerLevel(id, levelId)
    return { ok: true as const, id, levelId }
  })

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
  // 匿名开发模式的"每个标签页一个身份"。生产环境走 authenticate，用不到它。
  const clientId = sanitizeClientId(query.cid)

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

  // 心跳：浏览器会自动回 pong。没有它，拔网线/休眠/NAT 超时之后的半开连接会
  // 一直算"在线"—— 角色留在世界里、玩家列表里却没有人控制，就是幽灵人。
  // 连续两个周期没回 pong 就 terminate；close 回调会把角色转入断线保留，
  // 等同一个账号重连接管（见 World.resumePlayer）。
  const HEARTBEAT_MS = 15_000
  let pongSeen = true
  const heartbeat = setInterval(() => {
    if (socket.readyState !== 1) return
    if (!pongSeen) {
      socket.terminate()
      return
    }
    pongSeen = false
    try {
      socket.ping()
    } catch {
      socket.terminate()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const cleanup = (detach: boolean) => {
    if (closed) return
    closed = true
    clearInterval(refill)
    clearInterval(heartbeat)
    if (world && playerId) {
      // 正常退出（客户端 close(1000)）立刻移除；网络断开先保留 60 秒等重连。
      if (detach) world.detachPlayer(playerId, socket)
      else world.removePlayer(playerId, socket)
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
  socket.on('pong', () => {
    pongSeen = true
  })

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
    // 重连接管之后，旧连接可能还有几个包在路上。它们不能进入同一个输入队列：
    // 旧 seq 会把 ackSeq 推高，新会话的 1..N 随后全被当成重复包丢掉，
    // 表现就是"人回来了、身体却不听使唤"。
    if (!world.ownsPlayer(playerId, socket)) return
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
        world.receiveLoadout(
          playerId,
          loadout.weaponId,
          loadout.traits,
          loadout.contract,
          loadout.extras,
          loadout.attachment,
          loadout.squad,
          loadout.partyId ?? '',
          loadout.build,
        )
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
        // 优先用客户端带来的标签页 id：同一台机器开两个标签页时不会互相
        // 接管；旧客户端没有 cid 时退回 IP，行为与以前一致。
        userId: `anon:${clientId !== '' ? clientId : request.ip}`,
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
    const joined = target.addPlayer(socket, identity.nickname, identity.userId, hello.partyId ?? '')
    if (!joined) {
      socket.close(4009, '房间已满')
      return
    }
    // 两个连接几乎同时带着同一账号进来时，后一个已经在 resumePlayer 里接管，
    // 先到的这一条不能再继续注册 —— 否则两个连接会共用同一个 playerId，
    // 旧连接迟到的输入会和新会话混在一起（就是幽灵人的另一半）。
    if (!target.ownsPlayer(joined.id, socket)) {
      socket.close(4002, '该角色已在新的连接中继续游戏')
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
interface PartyMember {
  code: string
  name: string
}

interface PartyRecord {
  id: string
  leader: string
  members: PartyMember[]
  roomId: string
  levelId: string
  launchedAt: number
  updatedAt: number
}

interface PartyView {
  id: string
  leader: string
  members: PartyMember[]
  roomId: string
  levelId: string
  launchedAt: number
}

interface PartyInviteRecord {
  id: string
  partyId: string
  fromCode: string
  fromName: string
  toCode: string
  at: number
}

function createPartyId(parties: Map<string, PartyRecord>): string {
  for (let i = 0; i < 32; i++) {
    let id = 'p-'
    for (let j = 0; j < 5; j++) {
      id += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
    }
    if (!parties.has(id)) return id
  }
  return 'p-' + Date.now().toString(36)
}

function createInviteId(invites: Map<string, PartyInviteRecord>): string {
  for (let i = 0; i < 32; i++) {
    let id = 'i-'
    for (let j = 0; j < 5; j++) {
      id += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
    }
    if (!invites.has(id)) return id
  }
  return 'i-' + Date.now().toString(36)
}

interface PresenceEntry {
  code: string
  name: string
  roomId: string
  levelId: string
  at: number
}

function sanitizePresenceCode(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)
}

function sanitizePresenceName(raw: unknown): string {
  if (typeof raw !== 'string') return '无名猎人'
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, 24)
  return name || '无名猎人'
}

function sanitizePresenceRoom(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
}

function sanitizePresenceLevel(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
}

/** 房号字母表：去掉了 0/o/1/i/l 这类读起来会吵架的字符。 */
const ROOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** 随机房号，短到能口头报，长到 33^5 足够撞不上。 */
function createRoomId(registry: WorldRegistry): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    let id = 'r-'
    for (let i = 0; i < 5; i++) {
      id += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
    }
    if (!registry.has(id)) return id
  }
  // 32 次全撞上（几乎只可能是被恶意占满）：退化成时间戳，仍满足 sanitize。
  return 'r-' + Date.now().toString(36)
}

function sanitizeMatchId(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
  return cleaned || 'default'
}

/** 匿名标签页 id：同样只保留安全字符。空串表示客户端没给（旧客户端）。 */
function sanitizeClientId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64)
}

export type { PlayerInput }
