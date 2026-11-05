/**
 * 把游戏挂进宿主 WebLearning（Club_Space）的适配层。
 *
 * 这个文件**不被 dead_kill 自己 import** —— 它是给宿主仓库用的样板：把内容
 * 复制到 `WebLearning/server/src/game-bridge.ts`，然后在宿主的
 * `server/src/index.ts` 里加一行 `await app.register(bridgeGame)`。
 *
 * 之所以做成"复制"而不是"发布成包"：宿主的部署形态是单个 app 容器、
 * 单进程、零构建（`node server/src/index.ts` 直接跑 .ts），
 * 多一个 npm 包就多一次 `pnpm install` 和一次版本对齐。
 * 而这段适配逻辑只有二十来行，复制它的维护成本低于维护一个包。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'

// ---- 以下是宿主仓库内可用的导入（在 dead_kill 里编译会报错，属预期）----
// import { currentUser } from './auth.ts'
// import { audit } from './audit.ts'
// import { enforceRateLimit } from './routes/auth-guard.ts'
// import { registerGame } from '../dead-kill/server/src/game.ts'

/**
 * 宿主侧唯一需要写的逻辑：从 cookie 会话里取出玩家身份。
 *
 * 三个判断都有理由：
 *  - `currentUser` 返回 null = 没登录，直接拒绝（游戏不接受匿名）。
 *  - `status !== 'active'` = 账号被停用，但旧 cookie 还没过期；
 *    不查这个字段就等于"封号了还能进游戏"。
 *  - 昵称用 `display_name` 而不是 `username`：username 是登录名，
 *    把它显示给同房间的其他人等于泄露一半凭据。
 */
export function authenticateWithHost(request: FastifyRequest): { userId: string; nickname: string } | null {
  // 以下四行在宿主仓库里取消注释即可。
  // const user = currentUser(request)
  // if (!user) return null
  // if (user.status !== 'active') return null
  // return { userId: user.id, nickname: user.display_name || user.username }
  return null
}

/**
 * 注册游戏插件。
 *
 * ⚠️ 两个参数**不能照抄开发配置**：
 *  - `allowAnonymous` 必须为 false。开发时用 true 是为了不依赖宿主 cookie
 *    就能开两个标签页互射；在生产里它为 true 就等于任何人都能进。
 *  - `authenticate` 必须给。没有它 `allowAnonymous: false` 会让所有连接
 *    被 `4001 未配置鉴权` 拒绝 —— 这是刻意的失败关闭（fail closed），
 *    而不是"悄悄放行"。
 */
export async function bridgeGame(app: FastifyInstance): Promise<void> {
  // ⚠️ 必须先装 @fastify/websocket：宿主目前只装了 @fastify/cookie 与
  // @fastify/static，没有 WebSocket 插件，`{ websocket: true }` 的路由
  // 会直接抛 "websocket handler not supported"。
  //
  // await app.register(fastifyWebsocket, { options: { maxPayload: 1024 } })
  //
  // await app.register(registerGame, {
  //   authenticate: authenticateWithHost,
  //   allowAnonymous: false,
  // })
}
