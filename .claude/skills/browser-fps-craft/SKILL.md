---
name: browser-fps-craft
description: 构建或打磨浏览器 3D 第一人称射击游戏时使用（Three.js / WebGL、无编辑器、全程序化资产）。适用于从零做可玩的 FPS Demo、把原型提升到接近商业 Demo 的画面与手感、补音频/AI/性能降级/验收工具链。触发词：Three.js FPS、浏览器射击游戏、程序化材质/建模/音效、游戏手感、渲染管线、动态分辨率、游戏 QA。
---

# 浏览器 FPS 工艺手册（Saltline 蒸馏）

这不是“Three.js 入门”。它假定你已经有能力写 WebGL，目标是把一个能跑的射击原型，做到**看起来有明确美术方向、玩起来有手感、坏一台设备也能降级跑完、并且能被截图和脚本验收**。

样本：`realskyrin/fps3ademo-saltline` —— 一个由 Claude 生成的单文件浏览器 FPS 产物，1.42 MB、无外部素材（字体除外）、63 个合成音效、88 种材质、36 种道具、27 个程序化表面函数。恢复后的工程约 45,000 行游戏代码、66 个模块。本手册只提炼可迁移的做法，不要求复刻它的题材。

---

## 0. 先定档：你现在在哪一层

不要用“加更多模型”伪装完成度。按可观察结果定档：

| 档位 | 可观察标准 | 常见缺失 |
|---|---|---|
| L0 能跑 | 能移动、能开枪、有敌人、有 UI | 平光、灰盒、无音频层次 |
| L1 有氛围 | 一个明确美术方向；HDR/后处理；材质有细节；天空与雾统一 | 手感轻飘；音效是单采样；无降级 |
| L2 有手感 | 移动/镜头/武器/命中/音频形成闭环；有顿帧、后坐、晃动、脚步 | 敌人像靶子；任务无节奏；无验收手段 |
| L3 有系统 | AI 有感知/状态/资源竞争；任务状态机；程序化内容可扩展；错误隔离与自动降级；可用 URL 固定场景截图 | —— |

**目标至少 L2，交付验收按 L3。** 只做 L0 时不要引入后处理、骨骼、程序化音频——会拖慢迭代且掩盖玩法问题。

---

## 1. 六阶段流水线

每个阶段都有**退出条件**。不满足就不要进下一阶段。

### 阶段 0 — 定调（0.5 天）

先写一页 `docs/direction.md`，不写代码：

1. **一句话幻想**：玩家是谁、在哪、为什么现在必须动。
2. **三根支柱**：例如“慢节奏信息战 / 一枪致命 / 声音即情报”。所有系统取舍都回到这三句。
3. **视觉方向**：只允许 3 个颜色角色（环境主色、信号色、危险色）+ 2 种字体（展示/标签）+ 1 个重复母题（如港口编号、铆钉、警戒条纹）。
4. **约束**：单文件还是多文件、是否允许网络请求、目标帧率、最低设备、包体上限、是否需要移动端/手柄。
5. **输入矩阵**：键鼠、触屏、手柄各自怎么完成“移动/视角/开火/瞄准/交互”。
6. **参考定标**：列 3 个作品，说明各借什么（光照、HUD、音频），不抄资产。

**退出条件**：能用三句话说出“这游戏看起来、听起来、玩起来像什么”，且这三句不互相矛盾。

### 阶段 1 — 脊柱（先于任何内容）

在放第一个箱子之前，把运行时骨架搭好。顺序很重要：

- `context` 对象注入所有系统（不要用散落的浏览器全局）。
- 启动分步推进，每步 `await yieldToBrowser()`，有进度文案。
- 每个系统有 **fallback 空实现**，形状与真实系统一致。
- 初始化失败可降级；更新循环里每个系统独立 try/catch，单系统崩溃不拖垮整局。
- 画质预设 + 设备探测 + 动态分辨率。
- 确定性 RNG（种子可复现），需要并行的子系统 `fork()`。
- 诊断全局：`__ready / __fatal / __errors / __stats() / __G`。
- URL 参数：画质、种子、自动开始、静音、基准、固定 `dt`、固定相机、截图模式。
- 帧循环：dt 钳制、FPS 指数平滑、更新顺序固定。

**退出条件**：故意让任意一个系统在初始化时 `throw`，游戏仍能进标题；`__errors` 能读到原因；用同一 seed 两次启动，场景哈希一致。

### 阶段 2 — 垂直切片（1–3 天）

只做一个房间、一组材质、一把武器、一种敌人、一个目标点。但**画面必须按最终标准做**：最终后处理、最终光照、最终 HUD 风格。

- 先锁定“一张截图能不能当商店图”。
- 武器手感先调到“愿意反复开火”。
- 敌人先做到“会看你、会追、会死得好看”。

**退出条件**：固定 seed + 固定相机截一张图；把图给没参与的人看，对方能说出场景类型和情绪。

### 阶段 3 — 规模化（内容，不是系统）

用**注册表 + 生成器 + 对象池**扩展，不要复制粘贴：

| 内容 | 规模化方式 |
|---|---|
| 材质 | 表面函数注册表（一个 GLSL 函数产出 albedo/ORM/height），材质表只写参数 |
| 道具 | `PROP_SIZES` + builder 注册表 + 统一 collider 描述；未知道具回退灰盒 |
| 敌人 | 模型工厂 + 行为参数表 + 池；同一种行为换参数即变种 |
| 音效 | 合成配方表（生成器 + 种子 + 变体数 + 峰值 + 总线 + 优先级） |
| 关卡 | 放置辅助函数（墙、门、栈板、灯、路缘）+ 区域语义 |
| 任务 | 数据驱动目标列表 + 波次表 + 状态机 |

**退出条件**：新增一种道具/材质/音效只需要改一张表 + 一个函数，不改主循环。

### 阶段 4 — 手感（决定“像不像游戏”）

把所有手感参数集中成命名常量表，禁止散落魔法数。至少覆盖：

- 玩家：走/跑/蹲/瞄准速度、地面/空中加速、重力、跳跃顶点、土狼时间、跳跃缓冲、落地下沉、镜头高度阻尼。
- 镜头：步伐 bob（Y/X 分频）、横移侧倾、后坐（保留/施加/恢复/保持）、shake（pitch/yaw/roll 多频叠加）、FOV 冲刺/瞄准插值、受伤/低血量后处理。
- 武器：射速、弹匣、备弹、伤害、射程、基础散布、移动/空中/连射/蹲/瞄准的散布增减、后坐曲线、换弹时间轴。
- 命中：命中标记、方向弧、声音分层、粒子、贴花、光照脉冲、短暂顿帧。
- 音频：近/远、干/湿、室内/室外、玩家/敌人分层；音量随紧张度变化。

调参方法：一次只改一个常量；先改“能感知的 20%”（速度、后坐、FOV、音量），再改细节；每次改完截同机位图 + 录 10 秒。

**退出条件**：闭眼听 10 秒能分辨“走/跑/换弹/命中/受伤”；开火 20 发不觉得腻。

### 阶段 5 — 降级与鲁棒

- 设备探测：移动端/软件渲染/低端 GPU → 预设降档。
- 动态分辨率：帧时间中位数超阈值降 scale，低于阈值缓慢回升；连续触底再降一档画质。
- 着色器自检：启动时渲染一个测试物体；后处理链编译失败 → 回退前向渲染；软阴影 chunk 被驱动拒绝 → 回退 PCF。
- 音频不可用、指针锁不可用、触屏/手柄缺失，都要有可用路径。
- 内存：纹理按预算生成，离屏目标按画质缩放，池有上限。

**退出条件**：强制 `?q=low`、`?noaudio=1`、`?post=0` 都能玩；窗口反复缩放不崩；后台切回不炸。

### 阶段 6 — 验收（可重复，不靠感觉）

- 每个系统提供 `showcase(context)`：只搭该系统的最小场景，固定相机，固定 seed。
- URL 固定：`?seed=…&dt=0&cam=x,y,z,tx,ty,tz&q=test&noaudio=1`。
- `__stats()` 输出 draw calls / triangles / geometries / textures / programs / 分辨率 / scale / FPS / 状态。
- 基准模式：沿相机路径巡游，输出 avg/median/p99 帧时间与 GPU 名。
- 截图对比：重构或改画质前后，同机位、同 seed；记录像素差阈值，而不是“看起来一样”。
- 验收清单逐项打勾（见 §8）。

**退出条件**：另一个人按文档能在 10 分钟内复现同一张截图和同一组错误状态。

---

## 2. 十二条硬规则

1. **一个方向，不是一堆效果。** 先定 3 个颜色角色、2 种字体、1 个母题；所有 UI、天空、材质、灯光都服从它。宁可少一个效果，不要多一种风格。
2. **程序化优先。** 几何、纹理、音效都在运行时生成：无下载、无版权、可按 seed 复现、包体小。外部素材只留字体这类必须项。
3. **先脊柱，后内容。** fallback、错误隔离、质量档、诊断、固定 seed 必须在第一个道具之前存在。没有这些，后面每加一个系统都在给自己埋雷。
4. **每个系统都要能“不存在”。** 真实实现和 fallback 的接口形状必须一致；上层永远不知道下面是真货还是空实现。
5. **更新顺序是设计，不是巧合。** input → game flow → player → weapon → enemies → fx → ground/level/backdrop/materials → audio → hud → render。写进文档，改顺序要当回归风险处理。
6. **所有随机数走种子 RNG。** 内容生成用主 RNG，表现层可用 `Math.random`；需要独立复现的子系统 `fork()`。禁止在关卡生成里直接用 `Math.random`。
7. **手感参数全部命名并集中。** 一个 `PLAYER_MOVEMENT` / `WEAPON_TUNING` / `GAME_FLOW` 表，胜过一百个散落数字。
8. **动画用弹簧-阻尼，不用线性插值硬切。** `x += ((target - x) * k - v * c) * dt; v += …` 或 `damp()`；换弹/后坐/晃动各自独立通道，最后叠加。
9. **事件总线解耦表现。** 玩法只发 `impact / weapon:fire / player:hit / enemy:killed / objective:done`；特效、音频、HUD 各自订阅。不要在武器代码里直接生成粒子和播音效。
10. **池化 + 合批是默认，不是优化。** 静态关卡按材质合并；弹壳/碎片/弹丸/贴花/粒子全部定容池；实例化用于同材质重复体。
11. **先测量再优化。** 没有 `stats()` 和基准模式，就不要讨论性能。draw calls、三角形、纹理内存、帧时间分布四项都要可见。
12. **可验收才算完成。** 固定 seed、固定相机、固定 dt、截图、`__errors` 为空——这五件事同时成立，才叫“做完了”。

---

## 3. 最小架构骨架

### 3.1 上下文与工厂

```js
const context = {
  THREE, params, events: createEventBus(),
  rng: createRandom(+(params.seed || 4207)),
  time: { t: 0, dt: 0, frame: 0, real: 0 },
  quality: chooseQuality(params.q),
};

// 每个系统都是 (context) => object；object 至少含 update(dt)
context.render   = await createRenderer(context);
context.mats     = await createMaterials(context);
context.physics  = createPhysics(context);
context.props    = createProps(context);
context.input    = createInput(context);
context.level    = await createLevel(context);
// …backdrop / ground / fx / audio / player / combat / weapon / enemies / hud / game
```

**规则**：模块之间不直接 import 彼此的实现；通过 `context` 拿正在运行的系统，通过 `context.events` 通信。这样单系统可以替换、降级、单独 showcase。

### 3.2 启动：分步 + 降级 + 让出主线程

```js
async function initializeSystem(name, factory, required = false) {
  const t0 = performance.now();
  try {
    context[name] = await factory();
  } catch (err) {
    console.error(`[boot] ${name} failed`, err);
    if (required || !FALLBACKS[name]) throw err;
    context[name] = FALLBACKS[name]();       // 形状一致的空实现
  }
  const ms = performance.now() - t0;
  if (ms > 150) console.log(`[boot] ${name} ${ms.toFixed(0)}ms`);
  await setBootProgress(labelFor(name), progressFor(name));
}
```

启动文案承担叙事（“Raising the terminal / Stacking containers / Flooding the apron”），进度条承担真实反馈。每步 `await` 一次宏任务，避免长时间白屏。

### 3.3 帧循环：dt 钳制 + 单系统隔离

```js
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const raw = (now - prev) / 1000;
  prev = now;
  fpsEma = fpsEma ? fpsEma * 0.95 + raw * 0.05 : raw;

  const dt = Math.min(raw, 0.05);
  context.time.dt = dt;
  context.time.t += dt;
  context.time.frame++;

  updateSystem('input', dt);
  const active = game.update(dt) !== false
    && game.state !== 'title' && game.state !== 'paused';

  if (active) {
    updateSystem('player', dt);
    updateSystem('weapon', dt);
    updateSystem('enemies', dt);
  }
  // 暂停时仍更新 fx/ground/level/backdrop/mats/audio/hud（看情况）
  updateSystem('fx', dt); /* … */
  try { render.frame(dt); } catch (e) { reportOnce('render', e); }
});
```

`updateSystem` 内部对每个系统只报告一次同类错误，避免每帧刷屏拖死控制台。渲染循环自身也要兜底：后处理失败一次就永久切前向。

### 3.4 fallback 契约

```js
const FALLBACKS = {
  fx: () => ({
    stub: true,
    update() {},
    muzzleFlash() {}, tracer() {}, impact() {}, smoke() {},
    explosion() {}, debris() {}, shell() {}, decal() {},
    clear() {}, addEmitter: () => ({ stop() {}, setPos() {} }),
  }),
  audio: () => ({
    stub: true, update() {}, resume() {}, play() {}, loop: () => ({ stop() {} }),
    setIntensity() {}, setInterior() {}, setVolume() {}, setPaused() {},
  }),
  // …
};
```

空实现必须包含**真实实现被调用到的每一个方法**。发现上层报 “undefined is not a function”，先补 fallback，而不是加 `if`。

### 3.5 诊断与 QA 全局

```js
window.__ready;    // 至少两帧渲染完成
window.__fatal;    // 启动错误
window.__errors;   // 捕获的错误（含 console.error 包装）
window.__stats();  // calls/tris/geos/tex/programs/res/scale/fps/state
window.__G;        // 运行中的 context
```

配合 URL 参数：

| 参数 | 用途 |
|---|---|
| `?q=low\|medium\|high\|ultra\|test` | 固定画质，便于截图对比 |
| `?seed=4207` | 固定程序化内容 |
| `?autostart=1` | 跳过标题，直接进入游戏 |
| `?noaudio=1` | 音频问题定位 |
| `?post=0` `?ao=0` `?vol=0` `?bloom=0` `?mb=1` | 逐项关/开渲染特性 |
| `?shot=1&dt=0&cam=…` | 固定帧、固定相机截图 |
| `?bench=1` | 巡游基准，输出 avg/median/p99 |
| `?show=mats\|level\|fx\|weapon\|enemies` | 单系统 showcase |

这不是“调试选项”，是**让另一个模型/另一台机器能复现你的画面**的基础设施。

---

## 4. 画面最小配方

### 4.1 管线（Three.js，前向 + 自写后处理）

场景先渲染到 `RGBA16F + MSAA` 的 HDR 目标；色调映射全部放在后处理末尾。推荐顺序：

1. 场景 HDR（世界相机 + 第一人称相机，分层渲染）。
2. 深度 → 视空间线性深度（半分辨率）。
3. AO（半分辨率，12 taps，法线由深度重建；两遍双边模糊）。
4. 体积光（半分辨率，按画质 10–40 步，常用 16–24；采样太阳阴影图；远端解析雾接续；两遍模糊）。
5. 合成 AO + 体积光（联合双边升采样），应用曝光。
6. 运动模糊（可选，重投影上一帧 VP，深度剔除）。
7. Bloom（6 级下采样；首级 partial Karis average；上采样逐级混合）。
8. 变形宽银幕拉丝（两次水平高亮模糊）。
9. 自动曝光（1×1 ping-pong，中心加权 log 平均；太阳可见度驱动）。
10. 调色（ACES/AgX 混合、分离色调、S 曲线、抬黑、饱和度、暗角、受伤、淡入淡出、sRGB）。
11. 最终（FXAA + 轻锐化 + 亮度加权胶片颗粒 + 抖动防色带）。

关键参数（样本值，需按项目调）：

```js
const TUNE = {
  volSigma: 0.0034, volMaxDist: 170, volFarHaze: 0.42, volInteriorDust: 6,
  aoRadius: 0.9, aoIntensity: 1.6, aoStrength: 0.95,
  bloom: 0.065, bloomMix: 0.62, dirt: 0.1, streak: 0.03, flare: 0.16,
  key: 0.12, minExposure: 0.6, maxExposure: 2, adaptTau: 1.5,
  agxMix: 0.25, ca: 0.0013, vignette: 0.3, grain: 0.02, sharpen: 0.3,
};
```

### 4.2 材质：程序化纹理集 + 着色器补丁

不要为每个表面下载 PBR 贴图。启动时用 GLSL **一次生成三张图**：

- `albedo`（sRGB）
- `ORM`（AO / roughness / metalness 打包）
- `normal`（由高度图求导）

一个表面函数只需实现 `surf(uv)` 并调用：

```glsl
void emit(vec3 c, float a, float h, float ao, float r, float m) {
  o0 = vec4(sqrt(clamp(c,0.,1.)), sat(a));       // albedo (sqrt = 感知空间)
  o1 = vec4(sat(ao), clamp(r,.03,1.), sat(m),1.); // ORM
  float hh = sat(h)*255.; float fl = floor(hh);
  o2 = vec4(fl/255., hh-fl, 0., 1.);              // 16-bit height in 2 channels
}
```

常用图元：`hash / value noise / fbm / voronoi / scratches / rustMask / paintDmg`。样本有 27 个表面函数、88 个材质条目，覆盖沥青、混凝土、砖、环氧、油漆、船壳、镀锌、金属、拉丝、锈、花纹板、瓦楞、铁丝网、危险条纹、枪金属、阳极氧化、聚合物、碳纤、织物、装甲、木、塑料、篷布、纸板、绳、轮胎、玻璃、水。

材质层用 `onBeforeCompile` 注入：

- 三平面投影（大件、无 UV 道具）
- 顶点色（同一材质多种颜色）
- 湿ness（朝上表面更强、垂直面有流痕、底面没有）
- 宏观变化（大尺度颜色/粗糙度扰动，消除平铺感）
- alpha cut（铁丝网、栅栏）
- 贴合地面的细节衰减（远处淡出，避免闪烁）

**材质缓存键**必须包含：材质名 + 顶点色 + 三平面 + 双面 + 室内 + 颜色覆盖。否则会拿到错误变体。

### 4.3 光照

- 一盏方向光当太阳，阴影相机按场景包围盒拟合，`shadowMap.autoUpdate=false`，只在需要时 `needsUpdate`。
- 天空 shader 生成环境贴图（PMREM）；室外一张，室内用 CubeCamera 在棚内再烘一张，进入室内切换 `scene.environment`。
- 局部闪光用**有限点光源池**（样本 6 盏）：`flash()` 短 TTL，`acquire()` 给持续光源（如敌人探照灯）。
- 软阴影通过替换 Three 的 `shadowmap_pars_fragment` chunk：Vogel 盘采样 + 接收面深度梯度偏置 + 阴影图边缘淡出。驱动拒绝时回退 stock PCF。

### 4.4 一个方向

样本的取景逻辑值得抄：黎明/风暴的港口，太阳低角度暖橙，阴影偏青，雾把远景压成剪影，HUD 像港口管理局的标牌。所有后处理参数都在服务这个方向，而不是“每个效果都开一点”。

---

## 5. 最小手感配方

### 5.1 玩家（样本值）

```js
const PLAYER_MOVEMENT = {
  walk: 3.8, sprint: 6.4, crouch: 1.9, ads: 2.4,
  accelGround: 34, decelGround: 26, accelAir: 9,
  gravity: 21, jumpApex: 1.0, coyote: 0.12, jumpBuffer: 0.13,
  standHeight: 1.8, crouchHeight: 1.15, eyeRate: 11,
  bobY: 0.024, bobX: 0.013, bobSprint: 1.9, bobAds: 0.22,
  rollStrafe: 0.02, landDip: 0.36, landDipMax: 0.2,
  fovSprint: 6, fovAds: 52, adsLook: 0.6,
  regenDelay: 4, regenRate: 25,
  recoilKeep: 0.35, recoilApply: 34, recoilRecover: 6.5, recoilHold: 0.09,
  shakePitch: 0.03, shakeYaw: 0.03, shakeRoll: 0.045,
};
```

要点：

- 水平速度用“朝目标速度加速”，不是直接赋值；空中控制显著弱于地面。
- 跳跃用 `v = sqrt(2 * g * apex)` 反推，保证“跳起高度”是可调设计量。
- 土狼时间 + 跳跃缓冲；落地按下落速度产生下沉、shake、脚步、超过阈值掉血。
- 镜头 eye 高度用 `damp`，蹲起不瞬移。
- 步伐 bob 分 Y/X 两个频率；横移产生 roll；瞄准时 bob/roll 大幅衰减。
- 后坐分两段：一部分永久进 pitch/yaw（`recoilKeep`），一部分是弹簧偏移再恢复；停火后延迟再回落。

### 5.2 镜头合成

每帧按固定顺序叠加，不要互相覆盖：

```
基础 eye/yaw/pitch
+ 后坐弹簧偏移 (pitch/yaw)
+ shake（多频正弦 × 强度²）
+ 落地下沉 (g.x)
+ 横移 roll
+ 受伤/低血量后处理（不是镜头）
→ camera.position / rotation
```

FOV 单独插值：基础 + 冲刺增量 → 瞄准 FOV；瞄准过程用更快的阻尼，避免“拉风箱”。

### 5.3 武器视图模型

- 视图模型挂在**独立相机层**，近裁剪面 0.01，世界相机看不到它，避免穿墙和与场景抢深度。
- 所有运动走“弹簧通道”：后坐 Z/P/Y/R、摆动 Y/P、跳跃 Y/P、换弹 bump。每通道 `k/c` 不同，最后叠加。
- 换弹用**时间轴关键帧**（magout → magin → bolt），不是单段插值；弹匣在 0.86s 出现新弹匣，空仓换弹多 0.62s 拉栓。
- 待机 24s 触发 inspect；连续射击产生 heat → smoke；进入室内枪身 wetness 平滑变化。
- 散布 = 基础 × 瞄准 + 移动 + 连射 bloom + 空中 - 蹲；后坐与散布分开，不能用一个值糊弄。

### 5.4 命中反馈链

一次命中至少同时发生：

1. 命中标记（准星四段闪白/红，弱点不同）
2. 方向弧（受到攻击时显示来源方位）
3. 粒子（按表面：金属火花、混凝土粉尘、木屑、水花、玻璃碎片）
4. 贴花（同一 atlas，随机旋转/尺寸，池化上限）
5. 声音（近/远、材质、是否击杀）
6. 光照脉冲（短 TTL 点光源）
7. 受击方后处理（红边、低血量去饱和、暗角）
8. 轻微顿帧/镜头 shake（仅击杀或爆炸）

### 5.5 敌人 AI（最低可玩结构）

- 感知：视锥 + 距离 + LOS，检测间隔 0.11–0.19s（不要每帧 raycast）；听觉由枪声/爆炸事件触发。
- 状态：`patrol → investigate → engage → search → patrol`；`engage` 丢失视野 4s 转 `search`，搜索 8s 回巡逻。
- **攻击令牌**：同时最多 2–3 个敌人开火（人多时 3），令牌间隔 1.25s，避免所有人同时集火导致不可玩。
- 增援：一个敌人进入 engage 时，附近同伴转 investigate（rally）。
- 投射物池化，命中用“线段-胶囊最近距离”，不是逐帧球体。
- 死亡：掉旋翼/失稳/坠落/沉没， wreck 有上限，旧的自沉。

---

## 6. 性能预算（桌面 1080p / 移动 720p）

| 项目 | 目标 |
|---|---|
| 帧时间 | 桌面 avg ≤ 16.6ms，p99 ≤ 25ms；移动 avg ≤ 33ms |
| Draw calls | ≤ 150（合批后）；单帧新增透明体 ≤ 40 |
| 三角形 | 0.5–1.5M；单敌人 ≤ 8k；单武器 ≤ 15k |
| 纹理内存 | 桌面 ≤ 300MB；移动 ≤ 120MB；单张 ≤ 1024²（hero 2048²） |
| 阴影 | 2048² 起步，4096² 仅高端；`autoUpdate=false` |
| 后处理 RT | 半分辨率做 AO/体积；全分辨率只留场景 + 最终 |
| 动态分辨率 | 0.6–1.0；连续触底两次再降一档画质 |
| 音频 | 同时发声 ≤ 32；每音效变体 ≤ 4；总合成缓冲 ≤ 8MB |

质量档必须同时控制：`scale / msaa / shadow / tex / volSteps / ao / planar / bloom / motionBlur / rain`。只改分辨率不叫降级。

---

## 7. 验收清单

复制到 issue/PR，逐项打勾：

- [ ] `?seed=<fixed>&dt=0&cam=…&q=test&noaudio=1` 截图可复现。
- [ ] `window.__ready === true`，`__fatal == null`，`__errors.length === 0`。
- [ ] `__stats()` 的 calls/tris/tex/programs 在预算内。
- [ ] 标题 → 部署 → 入场 → playing → 暂停 → 恢复 → 死亡 → 重开，全路径无卡死。
- [ ] 移动、跳跃、蹲、冲刺、瞄准、开火、换弹、交互、暂停键位全部有效。
- [ ] 音频在用户手势后进入 running；静音/暂停/切后台正确。
- [ ] `?q=low` 与 `?noaudio=1` 可玩；窗口缩放、DPR 变化不崩。
- [ ] 指针锁不可用时自动进入拖拽/键盘转向模式。
- [ ] 单系统初始化抛错时，fallback 接管且游戏可玩。
- [ ] 同 seed 两次启动，场景节点/几何/材质哈希一致（或差异可解释）。
- [ ] 新增道具/材质/音效不需要改主循环。
- [ ] 所有手感参数在命名表中，无散落魔法数。

---

## 8. 反模式

- **先堆模型后定方向**：最后所有东西都要重做。先定调。
- **每个系统直接 import 彼此**：无法单独 showcase、无法降级、循环依赖。
- **用 `if (window.__something)` 做降级**：降级要发生在系统边界，接口形状一致。
- **所有随机数用 `Math.random`**：截图不可复现，bug 不可复现。
- **后处理一次性全开**：帧时间爆了才找原因。逐项开关 + 基准。
- **用线性插值做所有动画**：看起来像 UI，不像手。弹簧-阻尼。
- **敌人每帧 raycast 感知**：CPU 爆炸；用固定间隔 + 事件。
- **音频用单采样 + 随机 pitch**：听 30 秒就腻；分层、变体、卷积空间。
- **没有 QA 参数**：每次“看起来好了”都无法证明，回归全靠肉眼。
- **把调试全局当持久存储**：`__G` 只用于诊断。

---

## 9. 按需读取

| 文件 | 什么时候读 |
|---|---|
| `references/architecture.md` | 搭骨架、加系统、做降级、接 QA 参数 |
| `references/rendering.md` | 画面不够“贵”、后处理/材质/阴影/天空要落地 |
| `references/game-feel.md` | 手感轻飘、武器/镜头/命中/敌人 AI 要调 |
| `references/procedural-assets.md` | 要程序化纹理/几何/模型/音效，或包体受限 |
| `references/qa-and-performance.md` | 帧率不稳、要自动降级、要做可复现验收 |
| `references/saltline-case-study.md` | 想看完整样本的数值、文件地图、取舍与教训 |

---

## 10. 给非 Claude 模型的使用方式

这份手册的目标是让能力较弱的模型也产出接近的结果。使用时要**强制过程**，而不是只给一句“做个 FPS”：

1. **先产出 `direction.md`**：一句话幻想、三根支柱、3 色 2 字体 1 母题、约束、输入矩阵。没有这一页，不要开始写渲染。
2. **再产出 `architecture.md`**：系统清单、初始化顺序、更新顺序、fallback 契约、URL 参数、诊断全局。没有这一页，不要开始堆内容。
3. **只做垂直切片**：一个房间、一把武器、一种敌人、一个目标；用最终画面标准；先截一张图。
4. **按 reference 加载**：渲染问题只读 `rendering.md`；手感只读 `game-feel.md`；资产只读 `procedural-assets.md`；性能/验收只读 `qa-and-performance.md`。不要一次塞全部。
5. **每次只改一个系统/一个常量**；改完必须给固定 URL + 截图 + `__stats()`。
6. **把清单当硬门槛**：SKILL.md §7 与 §8 的检查项不通过，不宣布完成。
7. **禁止“看起来好了”**：没有 `__ready`、`__errors` 为空、固定场景可复现，就不算完成。

对模型的具体提示词模板：

```text
按 browser-fps-craft 执行阶段 0 和阶段 1。
先输出 docs/direction.md 和 docs/architecture.md，不要写游戏代码。
架构必须包含：context 注入、启动顺序、更新顺序、每系统 fallback、URL 参数、__stats()。
完成后停下，等我确认。
```

确认后再让它做垂直切片，并附上本项目的 `direction.md`、`architecture.md` 和对应的 reference 文件。

---

## 11. 应用到 dead_kill 的优先落点

`dead_kill` 已有服务端权威、Rapier、预测/和解、HDR 渲染升级，缺的是“单机 Demo 级的内容密度与可验收性”。按收益排序：

1. **QA 脊柱**：补 `?seed/?dt/?cam/?shot/?q/?show` 与 `__stats()`；把现有截图对比流程脚本化。
2. **程序化表面函数**：现有材质若仍依赖少量贴图，补 5–8 个表面函数（泥、木、锈、瓦楞、铁丝网、血迹），用三平面 + 顶点色覆盖沼泽场景。
3. **命中反馈链**：把 impact 事件补全为“粒子 + 贴花 + 声音 + 光照脉冲 + HUD 弧”五件套。
4. **武器视图模型通道**：把后坐/摆动/换弹拆成独立弹簧通道，换弹改时间轴。
5. **敌人感知与令牌**：如果 PvE 敌人是直线追击，补视锥/LOS/状态机/攻击令牌。
6. **动态分辨率与画质档**：现有自适应只降不升；补回升滞回与质量降档。

不要直接搬 Saltline 的题材、数值或单文件约束；搬的是**结构与阈值**。
