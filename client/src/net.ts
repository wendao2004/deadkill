/**
 * WebSocket 连接与协议收发。
 *
 * 这一层只做三件事：连上去、握手、把二进制包分派给回调。
 * 它不认识 Three.js，也不认识物理 —— 这样"网络坏了"和"渲染坏了"
 * 能分开排查，而不是混在一个 3000 行的 game 文件里。
 */

import {
  PROTOCOL_VERSION,
  decodeEvents,
  decodeLoot,
  decodeNames,
  decodeObjective,
  decodeSnapshot,
  decodeText,
  decodeWelcome,
  encodeHello,
  encodeInputPacket,
  encodeLoadout,
  encodeSwitchSlot,
  Msg,
  type GameEvent,
  type LootPacket,
  type NameEntry,
  type ObjectivePacket,
  type PlayerInput,
  type Snapshot,
  type Vec3,
} from '@dk/shared'

import { followServerLevel } from './level-choice.ts'

export interface WelcomeInfo {
  playerId: number
  tickRate: number
  snapshotRate: number
  serverTime: number
  spawn: Vec3
  /**
   * 服务端**实际**用的关卡 id。正常情况下等于握手时请求的那张；
   * 不等时 net 层已经整页重载了（见 level-choice.ts），上层基本见不到差异。
   * null = 旧服务端没带这一段。
   */
  levelId: string | null
}

export interface NetHandlers {
  onWelcome: (info: WelcomeInfo) => void
  onSnapshot: (snapshot: Snapshot) => void
  onEvents: (events: GameEvent[]) => void
  /** 目标状态（线索/放逐/撤离）。只在内容变化时到达，不是每帧。 */
  onObjective: (objective: ObjectivePacket) => void
  /** 自己的战利品状态（搜刮进度 / 身上带的赏金）。只在变化时到达。 */
  onLoot: (loot: LootPacket) => void
  /** 服务端发给本人的一句中文（'搜到 $86、怀表 ×1'）。 */
  onText: (text: string) => void
  /** 全场昵称名单。加入/离开/改名时全量到达。 */
  onNames?: (entries: NameEntry[]) => void
  onClose: (info: CloseInfo) => void
}

export interface CloseInfo {
  /** 可直接展示给玩家的原因。 */
  reason: string
  /** WebSocket 关闭码；0 = 连接阶段就失败了，没有码。 */
  code: number
  /**
   * true = 传输层断开（切网、休眠、服务端重启），现在立刻重连有意义；
   * false = 服务端主动拒绝（版本不匹配、未登录、房间满、协议错），
   * 重连只会得到同一个拒绝。
   *
   * ws 约定里 4000 以上是应用自定义的关闭码，下面所有严重错误都落在那里，
   * 而 1000/1001/1006 这些是浏览器/中间层给的断开原因。
   */
  transient: boolean
}

/**
 * 连接地址从当前页面推导，**不写死 localhost**。
 *
 * 部署时客户端被宿主挂在 `/game/` 下、由 Caddy 反代 `/ws`，
 * 开发和生产的 URL 只有 origin 不同，协议、路径、端口推导规则一致。
 * 写死 ws://127.0.0.1:8787 的代码搬进部署必炸。
 */
/**
 * 本标签页的稳定连接身份。
 *
 * 开发模式没有账号，服务端只能按 IP 认人 —— 同一台机器开两个标签页互射时，
 * 两个连接会拿到同一个 userId，重连接管逻辑会把对方踢掉。用 sessionStorage
 * 给每个标签页一个随机 id：刷新/重连不变，新标签页必然不同。
 * 生产环境由宿主鉴权提供 userId，这个值不会被用到。
 */
function tabClientId(): string {
  try {
    let id = sessionStorage.getItem('dk.clientId')
    if (id === null || id === '') {
      id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36)
      sessionStorage.setItem('dk.clientId', id)
    }
    return id
  } catch {
    // 隐私模式/禁用存储：退回空串，服务端会继续按 IP 认人（本地单开也能用）。
    return ''
  }
}

function wsUrl(matchId: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  // 产物用相对路径（vite.config.ts 的 base: './'），所以页面被挂在哪个子路径
  // 下，资源就在哪。socket 必须跟页面目录走：'/' → '/ws/game'，
  // '/dead-kill/' → '/dead-kill/ws/game'。不用 BASE_URL —— 它是 './'，
  // 换成路径只会得到一个点。
  const base = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '')
  const params = new URLSearchParams({
    match: matchId,
    v: String(PROTOCOL_VERSION),
    // 仅对匿名开发模式有意义（见 tabClientId）。
    cid: tabClientId(),
  })
  return `${scheme}://${location.host}${base}/ws/game?${params}`
}

export class Net {
  private socket: WebSocket | null = null
  private handlers: NetHandlers | null = null
  /**
   * 握手时请服务端给的关卡 id，同时也是本地**已经建好**的那张图
   * （Game 在 constructor 里就按它建了 Renderer 与物理世界）。
   */
  private levelId = ''
  /** 大厅选的主武器，Welcome 之后立刻发给服务端。 */
  private primaryId = 0
  /** 本局带的天赋掩码：跟着配装包一起发给服务端，之后不再变。 */
  private traitMask = 0
  /** 本局合同 id：同样只随配装包发一次。 */
  private contract = 0
  /** 随身补给位图。 */
  private extras = 0
  /** 主武器配件 id。 */
  private attachment = 0
  /** 0 单人 / 1 双人。 */
  private squad = 0
  /** 队伍 id：同 party 的玩家由服务端强制编入同一队并共享出生点。 */
  private partyId = ''
  /** 已经发给服务端的最新输入序号，重连时用来判断是否要丢弃旧输入。 */
  lastSeq = 0
  closed = false

  /**
   * @param levelId 本地已经按哪张图建好了渲染与物理。它会随 Hello 一起发给
   *   服务端作为"我想进这张图"；如果服务端早就给这个 matchId 定过别的图，
   *   Welcome 会把这个差异告诉我们，此时整页重载（见 level-choice.ts）。
   */
  connect(
    matchId: string,
    nickname: string,
    levelId: string,
    primaryId: number,
    traitMask: number,
    contract: number,
    extras: number,
    attachment: number,
    squad: number,
    partyId: string,
    handlers: NetHandlers,
  ): void {
    this.handlers = handlers
    this.levelId = levelId
    this.primaryId = primaryId
    this.traitMask = traitMask
    this.contract = contract
    this.extras = extras
    this.attachment = attachment
    this.squad = squad
    this.partyId = partyId
    const socket = new WebSocket(wsUrl(matchId))
    // 必须显式设成 arraybuffer：默认是 blob，而 blob 要先 await arrayBuffer()
    // 才能解析，等于给每个快照加一次微任务延迟。
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.onopen = () => socket.send(encodeHello(nickname, levelId, this.partyId))

    socket.onmessage = (event: MessageEvent) => {
      const buffer = event.data as ArrayBuffer
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1) return
      const kind = new DataView(buffer).getUint8(0)
      try {
        switch (kind) {
          case Msg.Welcome: {
            const welcome = decodeWelcome(buffer)
            // 服务端是权威：你请求的图可能在你之前就被这个 matchId 定掉了。
            // 本地已经按另一张图建好了物理与渲染，只能整页重载对齐 ——
            // 重载后 URL 上的 ?map= 就是服务端的图，不会再跳第二次。
            if (followServerLevel(this.levelId, welcome.levelId)) {
              this.close()
              break
            }
            // 配装必须在 Welcome 之后发：服务端是在 Hello 里才认识我这个
            // playerId 的，早一毫秒它只能把包丢掉。
            socket.send(
              encodeLoadout(
                this.primaryId,
                this.traitMask,
                this.contract,
                this.extras,
                this.attachment,
                this.squad,
                this.partyId,
              ),
            )
            this.handlers?.onWelcome(welcome)
            break
          }
          case Msg.Snapshot:
            this.handlers?.onSnapshot(decodeSnapshot(buffer))
            break
          case Msg.Event:
            this.handlers?.onEvents(decodeEvents(buffer))
            break
          case Msg.Objective:
            this.handlers?.onObjective(decodeObjective(buffer))
            break
          case Msg.Loot:
            this.handlers?.onLoot(decodeLoot(buffer))
            break
          case Msg.Text:
            this.handlers?.onText(decodeText(buffer))
            break
          case Msg.Names:
            this.handlers?.onNames?.(decodeNames(buffer))
            break
          default:
            break
        }
      } catch (error) {
        // 单包解析失败不应该让整局崩掉：把包丢掉继续。
        // 二进制协议里这通常意味着两边版本不一致，握手时已经拦过一次，
        // 能走到这里说明是 bug，日志留给开发者。
        console.error('包解析失败', kind, error)
      }
    }

    socket.onclose = (event: CloseEvent) => {
      this.closed = true
      // code 4000+ 是服务端主动拒绝（版本不匹配、房间满、未登录），
      // reason 里带的是可读原因，直接展示给玩家。
      this.handlers?.onClose({
        reason: event.reason || `连接断开（${event.code}）`,
        code: event.code,
        transient: event.code < 4000,
      })
    }
    // onerror 之后一定会跟一次 onclose，原因以那边为准；这里只记一条日志，
    // 否则同一个断开会被上报两次、状态条闪两下。
    socket.onerror = () => {
      console.error('游戏连接出错（详细原因见随后的 close）')
    }
  }

  sendInputs(inputs: PlayerInput[], ackedTick: number): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (inputs.length === 0) return
    if (inputs[inputs.length - 1]!.seq > this.lastSeq) {
      this.lastSeq = inputs[inputs.length - 1]!.seq
    }
    socket.send(encodeInputPacket(inputs, ackedTick))
  }

  /**
   * 切枪请求。
   *
   * 走独立的消息而不是塞进 InputPacket：InputPacket 每帧都发，而切枪是
   * "按了一次 2 键"这样一个离散事实。塞进输入包就得为它发明边沿语义
   * （重复发会不会切回原槽），而丢包重发时那个语义还会错。
   */
  sendSlot(slot: number): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(encodeSwitchSlot(slot))
  }

  /**
   * 关掉连接。
   *
   * @param leave true = 玩家主动离开，发 1000，服务端立刻移除角色；
   *   false = 我们正准备用新连接重连，只关传输层、**不发 1000**。不带关闭
   *   码的 close 会以 1005 到达服务端（< 4000），服务端据此把角色转入断线
   *   保留，等新连接接管。发 1000 的话角色会被当场删除，重连就换了一个新
   *   角色，位置与战利品全丢。
   */
  close(leave = true): void {
    this.closed = true
    const socket = this.socket
    this.socket = null
    if (!socket) return
    if (leave) socket.close(1000, 'client leave')
    else socket.close()
  }
}
