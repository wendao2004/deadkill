# DEAD KILL

一款跑在浏览器里的硬核 3D 射击游戏，玩法参考《猎杀：对决》(Hunt: Showdown)：
节奏慢、信息稀缺、一两枪就死、声音是核心情报。

**当前状态：P0 可玩**。两个人能在同一张测试地图里互相打死；
移动、命中、伤害全部由服务端判定。

## 技术栈

| 层 | 选型 | 一句话理由 |
|---|---|---|
| 渲染 | **Three.js r186** | 可 tree-shake（核心 ~150KB gz）、着色器可控、代码优先不需要编辑器 |
| 物理 | **Rapier3D 0.21**（WASM） | **客户端与服务端共用同一套**，否则预测必然漂移 |
| 网络 | **原生 WebSocket + 手写二进制协议** | 射击需要每 tick 上行输入，SSE/HTTP 做不到 |
| 服务端 | **Fastify 5**（作为宿主插件） | 与 WebLearning 现有后端同进程、同端口、同容器 |
| 客户端 | **纯 TypeScript + Vite** | 游戏循环与 Vue 响应式敌对；纯 TS 可嵌入任何宿主 |

完整决策依据（含被否决的方案与代价）见 `docs/技术栈决策.md`。
引擎内核（固定步换算、帧相位、确定性随机、共享层边界）见 `docs/内核.md`。
接入宿主的步骤见 `docs/接入 WebLearning.md`。

## 快速开始

```bash
pnpm install

# 终端 1：服务端（8787）
pnpm --filter @dk/server dev

# 终端 2：客户端（5173，已把 /ws 与 /api 代理到 8787）
pnpm --filter @dk/client dev
```

开 **两个标签页** 访问 http://127.0.0.1:5173 ，都点"进入沼泽"，
鼠标点一下画面锁定视角，就能互射。

操作：`WASD` 移动 · `Shift` 疾跑 · `Ctrl` 蹲 · `空格` 跳 ·
`左键` 开火 · `右键` 瞄准 · `R` 换弹 · `Esc` 释放鼠标

## 目录结构

```
shared/          两端共用的代码（不含 DOM、不含 node: 内置模块）
  kernel/        引擎内核：fixed-clock（固定步/丢积压/插值 alpha）、registry（依赖拓扑）、
                 events（同步总线）、rng（xoshiro128** + forkFor）、kernel（帧相位编排）
  math.ts        零依赖向量/角度运算
  constants.ts   所有"两端必须一致"的常量与武器表
  protocol.ts    手写二进制协议（定长、小端、DataView）
  level.ts       关卡盒刷数据（客户端画网格 / 服务端生成碰撞体，同一份）
  worldbuild.ts  从关卡构建 Rapier World
  sim.ts         移动加速模型（纯函数）
  character.ts   Rapier 角色控制器封装
  hit.ts         射线命中、散布、伤害衰减
  loot.ts        搜刮点掉落（纯函数，两端可各自重算）
  matchDriver.ts 线索 → 放逐 → 撤离状态机
  lagcomp.ts     回滚到哪一 tick + 历史帧里的胶囊位姿
  snapshotView.ts 快照投影与 ackSeq 贴取

server/          游戏服务端（作为 Fastify 插件）
  world.ts       一个房间 = 一个 Rapier World + 9 段 tick 流水线 + 延迟补偿
  worlds.ts      World 注册表与空闲回收
  game.ts        /api/game/status + /ws/game 握手
  index.ts       独立开发入口（集成时不用它）

client/          Three.js 客户端
  game.ts        预测 / 和解 / 远端插值（四个系统注册进内核）
  render.ts      场景、关卡网格、第一人称武器、曳光弹
  input.ts       键鼠 → PlayerInput
  net.ts         WebSocket 收发
  main.ts        DOM 接线（换成 Vue 组件只需改这一个文件）

docs/            技术栈决策 + 宿主接入指南 + 内核说明（docs/内核.md）
```

## 已经做对的三件难事

**1. 预测与服务端同源。**
`shared/sim.ts` + `shared/character.ts` 被客户端和服务端**逐字共用**。
客户端预测自己走了 1 米、服务端算出 0.97 米，玩家就会感觉被反复拽回 ——
唯一的根治办法是两边跑同一个函数、同一份常量、同一个物理引擎。

**2. 延迟补偿真的生效。**
开火时把其他玩家倒回"射击者屏幕上那一刻"再判射线。这里有个 Rapier 的坑：
`setTranslation` 之后必须调 `propagateModifiedBodyPositionsToColliders()`，
否则 `castRay` 仍然用碰撞体缓存的旧变换 —— **回滚写了但完全没效果**。
这一条是实测出来的（见 `server/src/world.ts` 的 `rewind` 注释）。

**3. 服务端是唯一裁判。**
客户端发上来的是意图（前后左右、视角、按键），位置、命中、伤害全在服务端算。
改前端代码能让自己屏幕上瞬移，但改不了判定。

## 还没做

| 阶段 | 内容 |
|---|---|
| P1 | 沼泽农舍的正式美术资源（现在全是盒子） |
| P2 | 弹速、下坠、换弹动画、多把武器 |
| P3 | 音频情报层（脚步/枪声方位衰减）—— 猎杀类的灵魂 |
| P4 | PvE 怪物与"打怪会招来玩家" |
| P5 | 撤离与赏金循环 |
| P6 | 猎人养成、装备、永久死亡 |
