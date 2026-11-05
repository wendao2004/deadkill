# 接入 WebLearning（Club_Space）

> 目标：游戏跑在宿主**同一个 app 容器、同一个进程、同一个 origin** 上，
> 不新增容器、不新增端口、不改 `deploy/docker-compose.yml` 的结构。

## 0. 为什么是"挂插件"而不是"起一个新服务"

宿主的部署形态在 `deploy/Dockerfile` 里写死了：多阶段构建，运行时
`CMD ["node","--max-old-space-size=384","server/src/index.ts"]`，
容器硬上限 512MB，只有一个 `caddy` 对外发布端口。

任何"游戏单独起一个 Node 进程"的方案都要面对两件事：
- docker-compose 里多一个 service = 多一份固定 baseline 内存（Node 空载就要 40MB+）；
- Caddy 里多一条反代规则 = 多一处需要保持同步的配置。

而我们这个游戏服务端插件本身很轻（空闲时只有 Fastify 的几个 hook），
所以正确做法是 `app.register`。

---

## 1. 依赖

在**宿主仓库根目录**安装到 `server` 包：

```bash
cd D:/GithubProject/WebLearning
pnpm -F @wl/server add @fastify/websocket ws
pnpm -F @wl/server add -D @types/ws
```

游戏自己的代码（`shared` / `server` / `client`）有两种放法：

| 方案 | 做法 | 适用 |
|---|---|---|
| **A. 子目录 + workspace**（推荐） | 把 `dead_kill` 整个放进 `WebLearning/games/dead-kill/`，`pnpm-workspace.yaml` 加一行 `- 'games/dead-kill/*'` | 长期维护 |
| **B. 复制文件** | 把 `shared/src`、`server/src` 拷进宿主对应目录 | 一次性试验 |

方案 A 的改动：

```yaml
# WebLearning/pnpm-workspace.yaml
packages:
  - 'server'
  - 'web'
  - 'games/dead-kill/shared'
  - 'games/dead-kill/server'
  - 'games/dead-kill/client'
```

---

## 2. 宿主要改的三个文件

### 2.1 `server/src/index.ts` —— 加两行

```ts
// 文件顶部 import 区，紧跟现有 import
import websocket from '@fastify/websocket'
import { registerGame } from '../games/dead-kill/server/src/game.ts'
import { authenticateWithHost } from './game-bridge.ts'

// 在 await app.register(cookie) 之后、注册路由之前
await app.register(websocket, { options: { maxPayload: 1024 } })

await app.register(registerGame, {
  authenticate: authenticateWithHost,
  allowAnonymous: false,      // ← 生产必须 false
  maxMessagesPerSecond: 120,  // ← 60Hz 输入发包 + 一倍余量
})
```

⚠️ **顺序有要求**：`@fastify/websocket` 必须先于任何 `{ websocket: true }`
的路由注册，否则 Fastify 会在启动时抛 "websocket handler not supported"。
这个错误在启动期就炸，不会拖到玩家点"进入"时才暴露。

### 2.2 `server/src/game-bridge.ts` —— 新建，内容就是本仓库的
`server/src/integration-web-learning.ts`（把注释取消掉）

关键一行是身份解析：`currentUser(request)` 复用宿主已有的 cookie 会话，
**不要**另做一套登录。宿主的 `auth.ts` 已经处理了签名、过期、
`status !== 'active'` 这三种情况，重写一遍必然漏掉其中一种。

### 2.3 `deploy/Caddyfile` —— **不需要改**

这一点值得说明，因为它反直觉。现有配置里：

```caddy
handle /api/* {
    reverse_proxy app:3000 { flush_interval -1 ... }
}
handle {
    reverse_proxy app:3000 { flush_interval -1 }
}
```

- 游戏的 `GET /api/game/status` 落在第一条。
- 游戏的 `GET /ws/game` 落在第二条（`handle` 兜底），而 Caddy 的
  `reverse_proxy` **默认支持 WebSocket upgrade**，不需要额外配置。

唯一的风险是 `flush_interval -1`：它对 WebSocket 无影响（那是 HTTP 响应
缓冲的参数），但对将来的 SSE 保活有帮助，保持现状即可。

### 2.4 `deploy/Caddyfile` 的 CSP —— **需要改一行**

当前：
```
connect-src 'self'
```
这一条**已经覆盖了 `wss://同源`**（CSP 的 `'self'` 包含同源 WebSocket，
现代浏览器都实现了这一点）。所以严格来说不需要改。

但有两点要留意：
- `worker-src 'self' blob:` 已经允许 —— Rapier 的 WASM 不需要 worker
  （它在主线程用内联 base64 的 WASM），所以这点也没问题。
- 如果将来引入 AudioWorklet（P3 的音频情报层会用到），需要
  `worker-src` 覆盖 `audio-worklet`，那是后续的事。

**结论：Caddyfile 一行都不用改。** 这个结论是我核对了
`connect-src`、`worker-src`、`script-src` 三条之后得出的，
不是"应该没事"。

---

## 3. 前端：挂到宿主桌面外壳

### 3.1 构建产物放到子路径

```bash
cd games/dead-kill/client
pnpm build
# 产物在 dist/，把它拷到宿主的前端产物目录下
```

宿主 `web/vite.config.ts` 的 `build.outDir` 是 `dist`，由
`@fastify/static` 托管 `web/dist`。所以把游戏产物拷到
`web/dist/game/` 即可，访问路径 `/game/index.html`。

⚠️ 游戏的 `vite.config.ts` 里 `base: './'` 就是为这一步准备的。
如果写成默认的 `'/'`，产物里的 `<script src="/assets/xxx.js">` 会
解析到站点根，在 `/game/` 下 404。

### 3.2 在宿主的应用注册表里加一条

`web/src/apps/registry.ts` 的 `APPS` 数组加：

```ts
{
  id: 'deadkill',
  name: 'DEAD KILL',
  icon: 'crosshair',        // 见 components/Icon.vue，需新增
  description: '沼泽里的硬核射击 · 与社团成员对战',
  tint: '#8f2b1f',
  onDesktop: true,
  inStartMenu: true,
  group: '常用',
  defaultSize: { w: 1280, h: 760 },
  minSize: { w: 960, h: 600 },
  resizable: true,
  component: () => import('@/apps/DeadKillApp.vue'),
},
```

### 3.3 外壳组件（`web/src/apps/DeadKillApp.vue`）

**关键判断：用 iframe，不要直接把游戏挂进 Vue 组件的 DOM。**

理由（这是本接入方案里唯一有争议的决定，所以写清楚）：

1. **指针锁定（Pointer Lock）** 在 iframe 里可以正常工作，但在被 Vue
   的过渡/拖拽窗口包裹时容易出现"锁定了但 mousemove 不触发"的边界情况。
2. **游戏循环与 Vue 是敌对的**。游戏每帧更新 60 次，如果它的 DOM 在
   Vue 的组件树里，任何 `v-if`/`v-show` 引起的 patch 都可能打断 canvas
   的尺寸计算（`clientWidth` 变 0 会让 Three 抛 "Cannot read properties of
   null"）。iframe 有自己的 document，与宿主的 patch 完全隔离。
3. **出事了能整体杀掉**。游戏崩溃（WebGL 上下文丢失、WASM OOM）时，
   iframe 挂了不影响桌面外壳本身，而同一个 document 里的 React/Vue 错误
   可能连累整个桌面。

代价：多一个 document 的内存（约 30~60MB 给 WebGL 上下文）。在 512MB 容器
里能接受，但**同一时刻只允许一个游戏窗口**（见下面的卸载逻辑）。

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const frame = ref<HTMLIFrameElement | null>(null)

onMounted(() => {
  // 窗口尺寸变化时 iframe 自己会收到 resize（它是独立的 document），
  // 这里不需要转发任何事件。
})

onBeforeUnmount(() => {
  // 必须主动把 src 清空：仅从 DOM 里移除 iframe 并不会立刻销毁它的
  // WebGL 上下文和 WASM 内存，它们要等 GC —— 而一张 4MB 的 WASM 堆
  // 在 512MB 的容器里"等 GC"是很危险的。
  if (frame.value) frame.value.src = 'about:blank'
})
</script>

<template>
  <iframe
    ref="frame"
    src="/game/index.html"
    class="deadkill-frame"
    allow="fullscreen"
    sandbox="allow-scripts allow-same-origin allow-pointer-lock"
  />
</template>

<style scoped>
.deadkill-frame {
  width: 100%; height: 100%; border: 0; display: block;
  background: #05070a;
}
</style>
```

⚠️ `sandbox` 属性里 **`allow-pointer-lock` 是必须的**，缺了它
`requestPointerLock()` 会被静默拒绝 —— 表现是"鼠标锁不住，视角不能转"，
而控制台里可能一句话都没有。

---

## 4. 账号与存档（P6 才需要，先留设计）

游戏不该自己建一套用户表。宿主的 `node:sqlite` 库已经开着，加两张表即可：

```sql
-- 迁移写在宿主的 migrate() 里，和现有表同一个 schema_version 序列
CREATE TABLE IF NOT EXISTS dk_hunters (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname    TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1,
  bloodline   INTEGER NOT NULL DEFAULT 0,   -- 猎杀的"血脉"等价物
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dk_matches (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  -- 结算明细（谁杀了谁、赏金归属）存 JSON，避免为一局游戏开五张表。
  summary     TEXT
);
```

⚠️ `REFERENCES users(id) ON DELETE CASCADE` 不是装饰：宿主的
`revokeAllSessions` / 账号停用路径会删 users 行，没有级联就会留下
孤儿存档，而它们会在"重新注册同名账号"时被错误地认领。

---

## 5. 部署检查清单

改完之后按顺序验：

1. `pnpm -F @wl/server typecheck` —— 宿主的 `tsc` 能看懂游戏源码的
   `.ts` 后缀导入（`allowImportingTsExtensions` 已在 `tsconfig.base.json` 打开）。
2. `node server/src/index.ts` 起得来，日志里能看到 Fastify 监听。
3. `curl http://127.0.0.1:3000/api/game/status` 返回
   `{"ok":true,"protocolVersion":1,...}`。
4. 浏览器开 `https://<NAS>:9443/game/index.html`，能进菜单。
5. 点"进入沼泽" → 房间出现一个玩家 → 开火有枪口火光。
6. **未登录时**（清掉 cookie）再试 → 应该被 `4001 未登录` 拒绝，
   而不是能进游戏。这一条必须验，它验证的是 `allowAnonymous: false`
   真的生效了。
7. `docker compose up -d` 重建镜像，重复 3~6。
8. 观察容器内存（`docker stats`）：一个玩家在房间里时应该在
   120~180MB（宿主 60~80 + 游戏 WASM 40~60 + 快照/网络）。

---

## 6. 已知限制（诚实列出）

| 限制 | 影响 | 什么时候修 |
|---|---|---|
| 全端用 TCP（WebSocket） | 丢包时会排队重发，高延迟下"橡皮筋"比 UDP 明显 | 局域网 <5ms RTT 无感；上公网前换 WebTransport(HTTP/3)，Caddy 已支持 |
| 每房间一个 Rapier World（8~20MB） | 512MB 容器只够 1~2 个活跃房间 | 单房间 16 人够用；要做多房间得把物理挪到独立进程 |
| 服务器 tick 与渲染帧率解耦 | 在网络抖动时快照会成组到达 | 客户端已用 90ms 插值缓冲吸收；再差就得做外推回滚 |
| 没有反作弊 | 客户端改了也用不上（位置/伤害全在服务端算），但**自瞄**无法检测 | 自瞄检测需要行为分析，属于 P5 之后的事 |
| 无音频 | 猎杀类最核心的"听声辨位"完全缺失 | P3 |
