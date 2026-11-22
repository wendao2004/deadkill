# DEAD KILL · 架构与运行契约

## 1. 分层

```
shared/    两端逐字共用：固定步时钟、依赖拓扑、确定性 RNG、协议、移动/角色、
           枪械/伤害/穿透、AI 感知、关卡数据、快照视图、延迟补偿
client/    DOM、Three.js、预测/和解、输入、音频、HUD、菜单、QA
server/    Fastify 插件、World（Rapier 权威模拟）、WorldRegistry、房间/队伍 API
```

**禁止**：`client/` 与 `server/` 互相 import；表现层不得读取服务端私有状态；
`shared/` 不碰 `window` / `document` / `node:`。

## 2. 启动顺序

1. `main.ts` 解析 URL 参数、安装诊断全局、创建菜单。
2. 用户出击 / `?autostart=1`：`enter()` 读取关卡、配装、昵称、partyId。
3. `Game` 创建：物理世界、Renderer、Input、Audio、Net 依次接线。
4. WebSocket 握手：`Hello`（昵称 + levelId + partyId）→ `Welcome`
   （playerId + spawn + 服务端实际 levelId）→ `Loadout`（武器/天赋/合同/队伍）。
5. 首帧渲染完成两帧后 `__ready = true`；启动错误写 `__fatal`。

启动期每个系统可失败：内核按系统/阶段 `guard()`，同一处只报一次；
渲染后处理链自检失败会永久切到 ACES 前向直出。

## 3. 更新顺序

内核依赖拓扑固定为：

```
input → game flow → player → weapon → enemies → fx → level/backdrop/materials
      → audio → hud → render
```

- 固定步 60Hz 跑玩法；渲染跟随 rAF。
- `dt` 钳制；后台切回不会一次补几百帧。
- 输入是意图（前后左右/视角/按键），命中/伤害/掉落由服务端结算。
- 表现系统（fx/audio/hud）只订阅事件，不在武器代码里直接生成粒子或播音效。

## 4. 权威与网络

- 服务端权威：位置、命中、伤害、战利品、目标、毒圈、Boss。
- 客户端预测 + 服务端和解；远端延迟插值。
- 延迟补偿：开火按射击者最后收到的快照 tick 回滚玩家胶囊，解析求交；
  回滚窗口按服务端实测 RTT 收紧（低延迟 120ms，高延迟最多 150ms）。
- 快照 20Hz；昵称名单、目标状态、战利品走独立低频包。
- 兴趣管理：自己/同队/90m 内可见 → 精确位姿；墙后 45m 内 → 2m 量化
  `AudioOnly` 层（客户端不渲染，只播声音）；更远不下发。视线缓存 4Hz，
  只对静态几何做射线。
- 协议 27：Hello 在 `profileId` 后再追加 `partyCode`；服务端用它校验
  Loadout 里的 `partyId` 是否真属于该好友码。26 追加稳定 `profileId`；
  新增 `Msg.Result`（个人结算）与 `Msg.Profile`（金币/已解锁天赋/配件/
  已付款补给）。24 加多槽位 build；
  25 把天气 modifier 扩为昼夜 8 档；同 party 强制同队并共享出生点。

## 5. 失败隔离与降级

| 系统 | 失败/降级路径 |
|---|---|
| 后处理链 | 启动自检读 program link；失败或 `?postfail=1` → ACES 前向直出 |
| 指针锁 | API 缺失/被拒 → 鼠标增量转向，canvas 内点击仍可开火 |
| 音频 | `?noaudio=1` / 上下文创建失败 → 空实现，玩法不依赖 |
| 动态分辨率 | 帧时间中位数超预算降 0.1；稳定 headroom 升 0.05；触底再降画质档 |
| 世界/房间 | 无人才建；空世界清扫；空房登记 30 分钟回收 |
| 单系统异常 | 内核按 system/phase try/catch，本帧其余系统继续 |
| 场景背景 | 无 WebGL → CSS 渐变大厅，菜单仍可点 |

所有空实现的接口形状与真实实现一致；上层不写 `if (system.stub)`。

## 6. QA 契约

URL：

```
?q=performance|balanced|quality|auto
?seed=4207
?autostart=1
?shot=1&dt=0&cam=x,y,z,tx,ty,tz
?bench=1
?show=lair|clue|spawn|weapon|mats|fx
?noaudio=1  ?post=0  ?postfail=1  ?hud=0  ?vm=0
```

诊断：

```
__ready  __fatal  __errors  __G  __stats()
__stats() -> calls/tris/geos/tex/programs/res/scale/fps/state
             renderPath/scene.hash/vertices/materials
```

验收命令：

```bash
pnpm test
pnpm qa:smoke -- --url http://127.0.0.1:5173/
pnpm qa:diff -- before.png after.png
```

场景哈希：`Renderer.sceneSignature()` 只遍历静态根，输出 `__stats().scene.hash`；
同 seed 两次启动应一致。

## 7. 已知缺口

- 触屏/手柄输入未接入；`direction.md` 输入矩阵中已标记。
- 房间名册显示的是已进入世界的玩家；菜单里“选房未出击”的在线状态由
  `/api/presence` 覆盖，但真正的“准备间/人齐开局”还未做。
- 队伍上限 2 人，对应现有双人队；4 人队需要扩服务端 team 上限、HUD 与
  出生点槽位。
- 基准模式给出 avg/median/p99，但没有自动把 p99 写进 CI 阈值。
- 动态分辨率在 60Hz 垂直同步下通常不会触达回升；高刷屏才需要观察抖动。
