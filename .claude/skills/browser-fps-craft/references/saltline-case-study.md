# 案例：Saltline（Claude Artifact）解剖

来源：`https://github.com/realskyrin/fps3ademo-saltline`
原始 Artifact：`https://claude.ai/artifact/BGY1SztrAYcJQHSsnHHGmp`，发布版本 `1794242702-61c7`
恢复日期：2026-11-10

---

## 1. 量化画像

| 指标 | 数值 |
|---|---|
| 原始产物 | 单个 `index.html`，1,423,413 字节，SHA-256 `f7081…f90` |
| 原始游戏脚本 | 约 72,964 行，打包为单文件 |
| 恢复后工程 | 66 个 ES 模块，`src/` 约 45,154 行（不含 Three.js vendor） |
| 引擎 | Three.js r180，本地 vendor，未升级 |
| 生产构建 | 约 1.38 MB JS，gzip 约 429 KB |
| 外部资源 | 仅 22 个字体文件（本地化）；无图片、模型、音频下载 |
| 音效 | 63 个 cue，全部 WebAudio 运行时合成 |
| 材质 | 88 个材质条目，27 个程序化表面函数 |
| 道具 | 36 种，注册表 + builder |
| 敌人 | 2 种（gull 无人机 / hound 地面机），池化 |
| 武器 | 1 把（PAC-9），30 发 / 150 备弹 / 720 RPM / 26 伤害 |
| 关卡 | 1 张港口图，3 个中继目标，3 波 + 追击 + 撤离 |
| 画质档 | test/low/medium/high/ultra，动态分辨率 0.6–1.0 |
| 状态机 | title / intro / playing / paused / dead / complete |

注意：恢复版把压缩后的代码拆成模块并改了可读名称，所以“45k 行”是恢复后的规模，不是作者原始书写行数。原始打包代码的局部变量名仍大量保留短名。

---

## 2. 文件地图（恢复版）

```text
src/
  game.js                      6 行入口：注册表 + 诊断 + startGame
  app/
    runtime.js                 context、启动顺序、主循环、动态系统更新
    boot-screen.js             进度文案与让出主线程
    diagnostics.js             __fatal/__errors/__ready
    benchmark.js               巡游基准面板
    showcases.js               各系统 showcase 注册表
    showcase-stubs.js          空输入/固定玩家
  core/
    config.js                  WORLD_BOUNDS / SUN_LIGHT / SKY_COLORS /
                               PLAYER_DIMENSIONS / QUALITY_PRESETS
    quality.js                 设备探测 → 画质档
    fallbacks.js               每个系统的空实现
    events.js                  同步事件总线
    random.js                  mulberry32 风格种子 RNG + range/int/pick/fork
    math.js                    clamp/lerp/saturate/smoothstep/damp
    geometry.js                盒/倒角盒/柱/管/合并/静态合批/顶点色
  render/
    renderer.js                场景、双相机、HDR、阴影、光池、动态分辨率
    postprocessing.js          AO/体积/运动模糊/Bloom/拉丝/曝光/调色/FXAA
    shadows.js                 Vogel 软阴影 chunk 补丁
    sky.js                     GLSL 天空 + PMREM + 噪声纹理
    materials/
      materials.js             纹理集生成、材质缓存、shader 补丁
      catalog.js               88 个材质参数
      surface-shaders.js       27 个表面函数 + 公共图元
      textures.js              法线/复制 pass、贴花/标签/数字
  world/
    physics.js                 AABB 碰撞、射线、胶囊移动、导航网格 + A*
    props/                     36 个道具 builder + 注册表 + 合批
    level/                     建筑、放置辅助、关卡装配
    backdrop/                  远景船/吊机/天际线
    ground/                    地面、沥青、积水、水
  input/input.js               键鼠/触屏/手柄/指针锁/拖拽回退
  player/player.js             移动、镜头、生命、后坐、回复
  combat/combat.js             射线命中、伤害、爆炸
  weapons/                     武器状态机、几何、手部 rig、动画
  enemies/                     模型、池、AI、投射物、死亡
  effects/                     粒子、弹壳、碎片、贴花、曳光、爆炸
  audio/                       合成器、音库、音乐、3D/混音
  ui/                          DOM HUD、菜单、设置、触控控件
  game/flow.js                 任务、波次、撤离、状态机
  ui.css                       1732 行：tokens/HUD/radio/touch/menu/motion
```

---

## 3. 关键设计决策

### 3.1 一个明确的美术方向

- 场景：黎明/风暴的集装箱港口。
- 色彩：暖橙太阳 + 青色阴影 + 骨白 UI + 信号橙/危险红。
- 字体：Big Shoulders Display（标题）、Barlow Condensed（标签）、IBM Plex Mono（数据）。
- 母题：港口编号、警戒条纹、铆钉、铁锈、雨。
- HUD 像港口管理局的标牌，不是科幻 HUD。
- 无线电字幕承担叙事，不靠过场动画。

后处理、天空、材质、UI 全部服务这个方向；没有“每个效果都开一点”的堆砌。

### 3.2 全程序化

- 几何：倒角盒、柱、管、车削、挤出、合并；没有外部模型。
- 纹理：GPU MRT 生成 albedo/ORM/normal；没有外部贴图。
- 音频：63 个 cue 运行时合成；没有外部音频。
- 字体：唯一外部资源，恢复时本地化。
- 结果：1.42MB 单文件，无网络请求，可按 seed 复现。

### 3.3 启动脊柱

- 分 15 步初始化，有世界观文案和真实进度。
- 每步 `await` 让出主线程。
- 每系统 fallback；初始化失败可降级。
- 渲染器启动自检：后处理失败 → 前向；软阴影 chunk 失败 → PCF。
- `__ready` 在两帧后置真。

### 3.4 主循环

```
input → game.update（状态机）→ player → weapon → enemies
→ fx → ground → level → backdrop → mats → audio → hud → render
```

- `dt = min(raw, 0.05)`；`?dt=` 可固定。
- 每系统 try/catch，只报一次。
- 暂停时跳过玩法与场景动画，但仍更新音频/HUD。
- `render.frame()` 自己兜底：后处理抛错一次就永久回退。

### 3.5 渲染管线

HDR `RGBA16F + MSAA` → 深度 → 半分辨率 AO → 半分辨率体积光 → 联合双边合成 → 运动模糊 → Bloom（6 级）→ 拉丝 → 自动曝光 → ACES/AgX 调色 → FXAA/锐化/颗粒/抖动。

关键取舍：

- 场景 `NoToneMapping`，只在后处理末尾做色调映射。
- 世界与视图模型分层渲染，视图模型独立相机/近裁剪。
- 阴影 `autoUpdate=false`，隔帧更新。
- 室内用 CubeCamera 烘第二套环境贴图。
- 局部光用 6 盏点光源池。
- 动态分辨率 0.6–1.0，连续触底降画质。

### 3.6 材质

- 27 个表面函数覆盖硬表面。
- `onBeforeCompile` 注入三平面、顶点色、湿ness、宏观变化、alpha cut。
- 材质缓存键包含所有变体维度。
- 纹理按画质档生成；4 秒无请求释放临时 MRT。

### 3.7 手感

- 玩家常量表完整（走/跑/蹲/瞄准/加速/重力/土狼/缓冲/落地下沉/回复）。
- 镜头 = 基础 + 后坐 + shake + 落地下沉 + 侧倾 + FOV。
- 武器 = 弹簧通道 + 时间轴换弹 + 待机检查 + 热量/烟雾 + 湿ness。
- 命中 = 粒子/贴花/声音/光照/HUD/后处理/顿帧。
- 敌人 = 视锥/LOS/听觉 + 四状态 + 攻击令牌 + 池化投射物。

### 3.8 音频

- 63 个 cue，每个 1–4 个变体，多采样率。
- 近场/干声总线、室内/室外卷积 IR、3D panner。
- 音乐分层按紧张度（0.15/0.6/1.0）。
- 循环体（旋翼/伺服/电流/雨）返回句柄。

### 3.9 QA

- URL 参数：q/seed/autostart/noaudio/post/ao/vol/bloom/mb/dynres/shot/dt/cam/fov/exposure/show/noweapon/bench。
- 每系统 showcase。
- `__stats()`、`__G`、`__errors`、`__fatal`。
- 巡游基准输出 avg/median/p99。
- 恢复版额外做了结构审计、场景/几何/材质哈希、固定场景图像差。

---

## 4. 为什么它“像 Claude 做的”

不是单个技术点，而是**同时具备以下五件事**：

1. **品味连贯**：颜色、字体、文案、灯光、HUD 指向同一个世界。
2. **系统深度**：不是“能开枪”，而是纹理、音频、AI、动画、后处理都有真实实现。
3. **防御式工程**：fallback、错误隔离、着色器自检、动态降级、移动端/触屏/手柄。
4. **可测量**：诊断全局、URL 固定场景、基准、截图对比。
5. **内容规模化**：注册表/生成器/池，让 36 个道具、63 个音效、88 个材质不靠复制粘贴。

多数模型能做出 1 或 2，很少同时做 3、4、5。

---

## 5. 可复制 vs 不可复制

### 值得直接搬

- context 注入 + fallback 契约。
- 启动分步 + 每系统错误隔离。
- 种子 RNG + 固定场景 URL。
- 画质档 + 动态分辨率 + 自动降档。
- 程序化纹理 MRT 架构与 `emit()` 约定。
- 倒角盒/柱/管/合并/静态合批。
- 弹簧-阻尼通道 + 时间轴换弹。
- impact 五通道反馈。
- AI 感知/状态/令牌。
- 音频合成清单 + 变体 + 总线 + IR。
- showcase 模块。
- `__stats()`/`__errors`。

### 不要照搬

- 单文件/无网络约束：你的项目可能有多文件、有服务端；不要为了“像 Artifact”而自缚。
- 极短变量名：恢复版保留了大量压缩名，可读性差；新代码用语义命名。
- 88 个材质/63 个音效的规模：按项目需要裁剪；小项目 15 个材质、20 个音效就够。
- 固定数值：移动/后坐/敌人参数只适应该样本的节奏；必须按你的 TTK/地图尺度重调。
- 单人任务状态机：多人/服务端权威项目不要直接套。
- 过度后处理：样本是“展示型 Demo”，允许重后处理；竞技项目要克制。

---

## 6. 诚实的局限

- 这是**恢复/重构**产物，不是原始作者工程；原始源码不可得，变量名和注释不完整。
- 没有自动化玩法测试；恢复版的验证以结构等价、固定场景、人工冒烟为主。
- 移动端/实体手柄只做了实现，恢复验收未覆盖。
- 单机、单地图、单武器、两种敌人；不能代表完整商业体量。
- 音频/纹理在启动时生成，低端设备有启动成本；样本用进度条和让出主线程缓解，但没有做后台 Worker 生成。
- 后处理很重；在核显/移动端依赖降档。
- 变量名短、注释集中在少数复杂 shader/算法，维护性一般。

---

## 7. 对 dead_kill 的映射

| Saltline 做法 | dead_kill 可落点 |
|---|---|
| 程序化表面函数 + 三平面 | 沼泽泥/木/锈/瓦楞/植被/血迹，减少贴图依赖 |
| 静态合批 + 道具注册表 | 地图盒子/植被/道具合批，降低 draw calls |
| 弹簧通道 + 时间轴换弹 | 武器视图模型与换弹动画 |
| impact 五通道 | 命中反馈链 |
| AI 感知/状态/令牌 | PvE 怪物（若有） |
| 音频合成/变体/IR | 枪声/脚步/环境，减少采样包体 |
| 启动自检/降级 | 客户端渲染兼容性 |
| URL 固定场景 + `__stats()` | 渲染升级回归与性能验收 |
| 画质档/动态分辨率 | 现有自适应补回升与降档 |
| showcase | 武器/材质/地图局部快速迭代 |

dead_kill 已有服务端权威、Rapier、预测和解、HDR 管线；不要重写这些。优先补**内容密度、反馈链、QA 可复现性**。
