/**
 * dead_kill 独立开发入口。
 *
 * 这个文件只服务于本地开发：起一个自带静态服务的 Fastify，把客户端
 * `dist` 和游戏插件一起挂上。**集成进 WebLearning 时不走这里** ——
 * 那边是在宿主已有的 app 上 `app.register(registerGame, {...})`，
 * 宿主负责认证/静态/HTTPS，本模块只提供 `registerGame`。
 *
 * 之所以仍然需要这个入口：游戏的手感调试是秒级的（改一个加速度值就得
 * 立刻跑起来看），每次都要去宿主仓库里起整套 pnpm dev 会毁掉这个循环。
 * 两边共用同一份 `game.ts`，所以这里调通的逻辑搬过去就是同一个逻辑。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import Fastify from 'fastify'

import { registerGame } from './game.ts'

const here = dirname(fileURLToPath(import.meta.url))
const clientDist = join(here, '../../client/dist')

const HOST = process.env.DK_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DK_PORT ?? 8787)

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.DK_LOG_LEVEL ?? 'info' },
    // 路由参数最长 256，给 /ws/game?match=... 留够空间。
    maxParamLength: 256,
  })

  // websocket 插件必须先于任何 websocket 路由注册。
  await app.register(fastifyWebsocket, {
    options: {
      // 帧大小上限：客户端只上行输入包（最多 6 + 8*15 = 126 字节），
      // 给 1KB 已经很宽松。默认的 100MB 在这种场景下是纯粹的风险面。
      maxPayload: 1024,
    },
  })

  app.register(registerGame, {
    // 开发模式允许匿名：不依赖宿主 cookie 就能两个人开两个标签页互射。
    allowAnonymous: true,
  })

  // --- 客户端 ---
  // 开发时客户端由 Vite（5173）服务，带 HMR；这里托管的是 `pnpm build`
  // 的产物，用来验证"打包后还能跑"—— 热更新下正常、打包后白屏的问题
  // 极常见（动态 import 路径、worker url、着色器内联）。
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist, prefix: '/' })
    app.setNotFoundHandler((request, reply) => {
      // SPA 回退，但 API 与 ws 路径不吞，否则错误的接口调用会拿到一份 HTML。
      const url = request.raw.url ?? '/'
      if (url.startsWith('/api') || url.startsWith('/ws')) {
        reply.code(404).send({ error: 'not found' })
        return
      }
      reply.sendFile('index.html')
    })
  } else {
    app.get('/', async (_request, reply) => {
      reply.type('text/plain; charset=utf-8').send(
        'client/dist 不存在。开发模式请另开终端跑 `pnpm --filter @dk/client dev`（默认 5173）。\n',
      )
    })
  }

  await app.listen({ host: HOST, port: PORT })
  app.log.info(
    `dead_kill 服务端就绪 http://${HOST}:${PORT}  ws://${HOST}:${PORT}/ws/game?match=default`,
  )

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
