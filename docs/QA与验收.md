# QA 与验收

这份文档只回答一个问题：**怎么让另一台机器、另一个人，在十分钟内复现同一张截图和同一组读数。**

没有这一层，所有"画面/手感改好了"都只能靠肉眼争论；改一次渲染参数，没人知道是变好还是退化。实现见 `client/src/qa.ts`，URL 契约的单元测试见 `tests/qa.test.ts`。

---

## 1. 启动

```bash
pnpm --filter @dk/server dev     # 8787
pnpm --filter @dk/client dev     # 5173（/ws 与 /api 已代理到 8787）
```

然后直接打开带参数的 URL。**不需要点主界面**：`?shot`、`?bench`、`?show` 都会隐含 `?autostart=1`。

---

## 2. URL 参数

| 参数 | 取值 | 作用 |
|---|---|---|
| `q` | `performance` / `balanced` / `quality` / `auto`（别名 `low` / `medium` / `high` / `ultra` / `test`） | 固定画质档。`test` 映射到 `balanced` |
| `scale` | `0.5..1` | 固定渲染分辨率倍率；设了就**关闭自适应分辨率** |
| `wet` | `0..1` | 固定场景湿度（朝上表面压暗、垂直面流痕）；不传则跟随本局天气：死寂 0.35 / 浓雾 0.8 / 骤雨 1 / 虫潮 0.45 |
| `reload` | `0..1` | 强制换弹进度，配合 `show=weapon&dt=0` 拍时间轴关键帧（0.2 = 第一次压杆，0.78 = 第二次压杆） |
| `seed` | 非负整数 | 固定程序化随机种子（`game.ts` 读取） |
| `map` | 关卡 id | 固定关卡；不传时按会话记忆/随机 |
| `noaudio` | `1` | 不创建、不解锁 `AudioContext`（大厅与局内都不碰） |
| `post` | `0` | 关闭泛光/颗粒/暗角/色差/锐化/接触阴影；HDR、AgX、FXAA 保留 |
| `postfail` | `1` | 强制绕过整条后处理链，验证前向直出回退；`__stats().renderPath === 'direct'` |
| `autostart` | `1` | 跳过主界面，复用真实 `enter()` 启动链 |
| `dt` | 毫秒 | 固定每帧时长。`dt=0` **冻结模拟只重绘**；`dt=16.67` 钉住 60Hz |
| `cam` | `x,y,z,tx,ty,tz` | 固定世界相机（位置 + 注视点），每帧在渲染前覆盖 |
| `vm` | `0` | 隐藏第一人称武器层 |
| `hud` | `0` | 隐藏 HUD/目标 HUD/颗粒/暗角/准星/镜筒/死亡层 |
| `shot` | `1` | 截图模式：稳定 12 帧后 `window.__shotReady === true` |
| `bench` | `1` | 基准模式：预热 90 帧后，绕玩家巡游 600 帧，输出 `window.__bench` |
| `show` | `lair` / `clue` / `spawn` / `mats` / `fx` / `weapon` | 地点展示或子系统展示；默认清场（`hud=0&vm=0`） |

`?show=` 的默认清场可以被显式覆盖：`?show=lair&hud=1&vm=1`。`show=weapon` 是例外——它要展示的就是枪，默认保留武器层。

子系统展示：

- `show=mats`：五族材质立方体阵列（石/木/金属/泥/植被），与关卡墙同一套 PBR + 米制三平面 UV；机位在出生点正上方 16m，避开建筑。
- `show=fx`：一块泥地 + 每 0.16 秒轮转的命中粒子、贴花、光照脉冲与冲击波（间隔小于最短粒子寿命，截图时不会拍到空档）；因为靠 `dt` 推进，**不要配 `dt=0`**。软件渲染下页面可能只有 2–3fps，脚本应等 `__G.game.renderer.showcaseIndex >= 3` 再截图，而不是固定 `sleep`。
- `show=weapon`：世界熄灭，只留第一人称武器层与棚拍灯；适合检查枪模、材质绑定与待机姿态。加 `&reload=0.2`（或 `0.78`）可停在换弹时间轴的关键帧，并会跳过居中展示位姿，显示真实换弹姿态。

---

## 3. 诊断全局

| 全局 | 含义 |
|---|---|
| `window.__ready` | 至少两帧真正渲染完成 |
| `window.__fatal` | 启动/致命错误的首条文本；正常为 `null` |
| `window.__errors` | 捕获的 `console.error`、未捕获异常与被拒绝的 Promise（最多 100 条） |
| `window.__stats()` | 一帧读数：fps、tick、ping、画质、scale、GPU、draw calls、三角形、纹理、程序数、内核错误数、参数原文、`renderPath`（post/direct）；`resolution` 子对象含平滑帧时间、升降次数、画质降档次数、是否处于回升封锁 |
| `window.__shotReady` | 截图模式稳定帧数已到 |
| `window.__bench` | 基准结果 `{ frames, avg, median, p99, min, max, gpu }` |
| `window.__benchDone` | 基准已完成 |
| `window.__G` | `{ game, inGame, qa }`，仅用于诊断，不要当状态存储 |
| `window.__diag` / `window.__qa` | 原始诊断状态与解析后的参数 |

内核会给每个 `(系统, 阶段)` 单独 try/catch（`shared/src/kernel/kernel.ts` 的 `guard()`）：某个表现系统抛错时，同一处只记录一次，本帧其余系统照常推进，错误数进 `__stats().kernelErrors`。

**动态分辨率读数**：`__stats().resolution` 给出 `smoothedMs / upscales / downscales /
qualityDrops / blocked`。治理器规则：连续 1 秒超标降 0.1；到本档下限仍超标且是
自动画质才降档；连续 5 秒低于 75% 帧预算且过 10 秒冷却才升 0.05；升后 30 秒内
又掉则封锁 60 秒。`?scale=` 或 `?dt=` 会关闭自适应，基准时务必使用其中之一。

---

## 4. 截图配方

### 4.1 固定状态的场景图

```text
http://127.0.0.1:5173/?autostart=1&noaudio=1&seed=4207&q=quality&map=quarry-dust&dt=0&shot=1&hud=0&vm=0
```

- `dt=0`：模拟冻结，怪物、雨、玩家都不再动；随便等多久都是同一帧。
- `hud=0&vm=0`：画面里只剩世界。
- `shot=1`：等 `window.__shotReady === true` 再截图，避免拍到 shader 编译中的半成品。

### 4.2 指定机位（不依赖玩家走位）

```text
?autostart=1&noaudio=1&seed=4207&q=quality&cam=12,4.5,-8,0,1.2,0&dt=0&shot=1&hud=1&vm=0
```

`cam` 的六个数是世界坐标：`x,y,z` 是相机位置，`tx,ty,tz` 是看向的点。它每帧在 `renderWorld` 之前覆盖相机，因此不受后坐、镜头晃动、玩家移动影响。

### 4.3 无头浏览器的等待条件

任何自动截图脚本只应等这两个条件，不要用固定 `sleep`：

```js
// 场景图
await page.waitForFunction(() => window.__shotReady === true)
// 基准
await page.waitForFunction(() => window.__benchDone === true, { timeout: 600000 })
```

截图前再读一次 `window.__stats()` 并随图存档：`errors` 必须为 0，`kernelErrors` 必须为 0，draw calls / 三角形要和上一次同机位对比。

### 4.3.1 显卡与证据链（2026-11-22 起）

- 四个无头工具默认强制高性能 GPU：`--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist --disable-software-rasterizer`；`QA_GPU=0` 才回退 SwiftShader。没有 GPU 的 CI 必须显式设 `QA_GPU=0`。
- `qa-shot` / `qa-smoke` / `qa-bench` 会读 `__stats().gpuName`；`qa-bench --require-gpu` 在软件渲染时退出 3（SKIPPED），不会把 CPU 数据当硬件结果。
- `qa-shot` / `qa-menu-shot` 用 `Emulation.setDeviceMetricsOverride` 钉住视口，并校验 PNG 实际尺寸等于 `--w/--h`；过去 `--w 1600 --h 900` 实际产出 1584×749。
- 每张截图旁写同名 JSON（`<out>.json`）：GPU、levelId、modifier/hour、seed、quality、scale、calls/tris/programs/textures、sceneHash、errors。
- `qa-shot --expect-level=marsh-p0 --expect-modifier=4` 可以把“拍错图/拍错天气”变成非零退出。
- `qa-shot` / `qa-menu-shot` 在 `__errors` / `__fatal` / `__kernelErrors` 非空时直接失败；不再产出“看起来正常”的坏帧。
- 测试结束按临时 `user-data-dir` 反查并清理整套 Chrome；正常退出、异常、Ctrl+C 都有钩子。被外部强杀（TaskStop/SIGKILL）时仍可能遗留，验收前用 `Get-CimInstance Win32_Process` 按 `dkqa-` 前缀清一次。

### 4.4 基准

```text
?autostart=1&noaudio=1&seed=4207&q=quality&map=marsh-p0&match=bench-marsh&scale=1&dt=16.67&bench=1
```

固定 `scale=1&dt=16.67` 是必须的：不钉住时动态分辨率会在 600 帧里改档，p99 会变成几种 scale 的混合值。`qa-bench` 默认会拒绝这种基准（可用 `--allow-adaptive` 显式放行）。

- 预热 90 帧，跳过着色器编译与纹理上传；
- 采样 600 帧（约 10 秒@60fps）；
- 相机绕玩家转 360°，覆盖背面/侧面的 draw call；
- 输出 `avg / median / p99 / min / max`。**p99 比 avg 重要**：平均 16ms、每两秒一次 80ms 卡顿，玩家感受到的是后者。

软件渲染（SwiftShader）下只有约 10fps；这只用于无 GPU 的 CI 冒烟，不代表目标平台性能。硬件基准请在有独显的机器上跑 `--require-gpu`，并归档同名 JSON（`--out docs/perf/...json`）。

### 4.5 截图对比

```bash
pnpm qa:diff before.png after.png
pnpm qa:diff before.png after.png --threshold 0.01 --tolerance 12
pnpm qa:diff before.png after.png --json
```

- `--tolerance`：单通道差超过多少才算一个"坏像素"，默认 8/255。用来吃掉颗粒、抖动、浏览器合成带来的 ±2~3 波动。
- `--threshold`：允许的坏像素占比，默认 0.2%。
- 退出码：0 = 在阈值内，1 = 超出，2 = 参数或解码错误。CI 可以直接拿它当门槛。

只支持 Chrome 截图产出的 8-bit RGB/RGBA、非隔行 PNG；工具自己解 IDAT，不引第三方依赖。比较只看 RGB，不看 alpha。

### 4.6 全路径冒烟

先启动 server 与 client，然后：

```bash
pnpm qa:smoke
# 或指定地址
node tools/qa-smoke.mjs --url http://127.0.0.1:5173/
```

覆盖：主界面加载 → 首次代号引导 → 进入沼泽 → 地图 → 组队 → 房间 → 点击「进入猎场」 → 入场并渲染两帧 → `Esc` 暂停 → `Esc` 恢复 → 放弃本局回大厅 → 再次走完大厅三步并出击。每步都等真实 DOM 状态，最后检查 `__errors` 为空。

**不覆盖死亡/结算**：死亡由服务端判定，客户端没有合法入口制造一次死亡；伪造它只会测到一条游戏里不存在的路径。这一段仍靠人工或录像回放。

---

## 5. 当前覆盖与缺口

已经可用：

- 参数解析 + 单元测试（`tests/qa.test.ts`）；
- `__ready / __fatal / __errors / __stats / __shotReady`；
- 固定画质/分辨率/种子/关卡/无音频；
- 固定 `dt`（冻结或钉帧）、固定机位、隐藏武器层、隐藏 UI；
- 自动进场、地点展示（`show=lair|clue|spawn`）、子系统展示（`show=mats|fx|weapon`）；
- 内核单系统错误隔离；
- 基准巡游与 p99 统计；
- 场景湿度 `?wet=`（天气驱动的墨线层压暗/流痕，QA 可固定）；
- 命中贴花（弹孔按材质分池）+ 命中光照脉冲，`show=fx` 同时覆盖两者；
- 后坐弹簧峰值反解（5.5mm / 0.7°，有单测）与换弹关键帧时间轴（`?reload=` 可验收）；
- 动态分辨率回升滞回（纯状态机 + 8 条单测；`__stats().resolution` 可读升降与封锁状态）；
- 截图对比工具（`pnpm qa:diff`，带通过阈值与退出码）；
- 全路径冒烟（`pnpm qa:smoke`，覆盖主界面→入场→暂停→恢复→回大厅→再入场）；
- 指针锁降级：API 缺失或 `pointerlockerror` 时自动切"移动鼠标转向"，
  `Game.lookHint()` / 状态条给出对应文案；
- 后处理链自检：预热后检查核心 pass 的 program 链接状态，失败或 `?postfail=1`
  时回退 ACES 前向直出（`renderPath: direct`）。

尚未完成（按收益排序）：

1. **`show=enemies`**：怪物模型/动画由服务端快照驱动，还没有伪造 `MonsterView` 的最小 harness。
2. **死亡/结算路径**：服务端判定，客户端没有合法入口强制死亡，目前只靠人工。
3. **`show=lair` 的机位**：固定偏移 `+7/+5/+7` 可能贴进建筑，后续应改为沿地图开阔方向取景。

---

## 6. 验收清单

复制到 PR / issue，逐项打勾：

- [ ] 带 `seed + map + q + cam + dt=0 + shot=1` 的 URL 能稳定出图。
- [ ] `__ready === true`，`__fatal === null`，`__errors.length === 0`。
- [ ] `__stats().kernelErrors === 0`。
- [ ] `__stats()` 的 calls / triangles / textures / programs 在预算内且与上次同机位可对比。
- [ ] `?q=performance`、`?post=0`、`?noaudio=1` 都能正常进局。
- [ ] `?postfail=1` 时 `__stats().renderPath === 'direct'`，画面非黑、`__errors` 为空。
- [ ] `?hud=0&vm=0` 画面里没有 UI、没有枪。
- [ ] `?show=lair` 在每张地图上都能落到求解出的巢穴点。
- [ ] 窗口缩放、DPR 变化不崩；切后台再回来不炸。
- [ ] 指针锁不可用或被拒绝时自动进入"移动鼠标转向"降级；键盘移动、开火、瞄准仍有效。
- [ ] 任意一个系统初始化抛错时，标题/进局仍可完成，`__errors` 能读到原因。
- [ ] 同 seed 两次启动，`__stats()` 的场景读数一致（差异可解释）。
- [ ] `?bench=1` 能输出 `__bench`，p99 在预算内。


### 基准（可进 CI）

```bash
pnpm qa:bench -- --w 1920 --h 1080 --require-gpu \
  --out docs/perf/marsh-quality-1080.json \
  --url "http://127.0.0.1:5173/?bench=1&q=quality&seed=4207&noaudio=1&map=marsh-p0&match=bench-marsh&scale=1&dt=16.67"
```

输出 `__bench` 的 frames/avg/median/p99/min/max 与 `__stats()`；`--out` 归档
gpuName/scale/resolution/calls/tris/errors。`--require-gpu` 在软件渲染时退出 3；
默认拒绝动态分辨率改档。脚本结束会清理整套 Chrome 子进程。

### 一键验证

```bash
pnpm verify        # typecheck + 332 条测试（含 client/tests）+ vite build
pnpm qa:verify     # verify + 全路径冒烟（需要 server/client 已启动）
```

GitHub Actions：`.github/workflows/verify.yml` 在 hosted runner 上跑
typecheck/test/build + `QA_GPU=0` 冒烟；硬件基准在 `bench-selfhosted.yml`
（workflow_dispatch，需 `[self-hosted, gpu]` runner）。


---

## 叙事静物与多图验收（2026-11-18）

| 参数 | 作用 |
|---|---|
| `?story=1` | 给每组叙事静物插青色定位柱；坐标同时写到 `window.__storySpots` |
| `?match=<id>` | 覆盖 QA 房间号。**不换房间就换不了图** —— 服务端按房间首位玩家的 `?map=` 定关卡 |
| `?colliders=1` | 碰撞盒线框（青=可见，橙=`noRender` 隐形骨架） |
| `?build=...` | 强制配件外观（只改外观不改数值） |
| `?vmdist=` | 武器展示机位距离，0.36~0.45 做近景检查 |

逐图验收的最小流程：

```bash
node tools/qa-shot.mjs --out a.png --url "...?map=chapel-night&match=shot-chapel&shot=1"
node tools/qa-shot.mjs --out b.png --url "...?map=quarry-dust&match=shot-quarry&shot=1"
```

第二条如果还拍出教堂，就是忘了 `&match=`。
