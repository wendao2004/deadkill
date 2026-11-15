# 验收与性能：画质档、动态分辨率、showcase、回归

样本对应：`src/core/quality.js`、`src/render/renderer.js`（动态分辨率）、`src/app/benchmark.js`、`src/app/showcases.js`、`docs/REFACTOR_VALIDATION.md`。

目标：让“画面对了/性能够了/没坏”变成**可重复的测量**，而不是主观判断。

---

## 1. 画质档

### 1.1 预设

| 档 | scale | msaa | shadow | tex | volSteps | ao | planar | bloom | motionBlur | rain |
|---|---|---|---|---|---|---|---|---|---|---|
| test | 1.0 | 0 | 1024 | 256 | 10 | on | 0.5 | on | off | 0.4 |
| low | 0.7 | 0 | 2048 | 512 | 12 | off | 0 | on | off | 0.5 |
| medium | 0.85 | 2 | 2048 | 1024 | 16 | on | 0.5 | on | off | 0.8 |
| high | 1.0 | 4 | 4096 | 1024 | 24 | on | 0.5 | on | on | 1.0 |
| ultra | 1.0 | 4 | 4096 | 2048 | 40 | on | 1 | on | on | 1.0 |

`test` 是 QA 专用：固定低纹理、无运动模糊，保证截图稳定。不要用它评估画质。

### 1.2 设备探测

```js
function chooseQuality(requested) {
  if (requested && PRESETS[requested]) return { ...PRESETS[requested] };

  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
  if (mobile) return { ...PRESETS.low };

  let renderer = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
            || document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
                          : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {}

  const weak = /SwiftShader|llvmpipe|Software|Mali|Adreno|PowerVR/i.test(renderer)
            || (/Intel/i.test(renderer) && !/Arc/i.test(renderer));
  return { ...(weak ? PRESETS.medium : PRESETS.high) };
}
```

不要只按 UA 判断；`UNMASKED_RENDERER` 更可靠。探测完立即 `loseContext()`，避免额外占用一个 GL 上下文。

---

## 2. 动态分辨率

### 2.1 算法（样本）

```js
const dyn = {
  scale: 1, enabled: !(shot || show || params.dynres === '0'),
  acc: 0, n: 0, settle: 3.5, upWait: 4, upDelay: 4,
};

function adapt(frameMs) {
  if (!dyn.enabled || !post || frameMs > 1500) return; // 切后台/断点不采样

  dyn.settle -= frameMs / 1000;
  dyn.upWait -= frameMs / 1000;
  if (dyn.settle > 0) { dyn.acc = dyn.n = 0; return; }

  dyn.acc += frameMs;
  dyn.n++;
  if (dyn.n < 45 && dyn.acc < 900) return;

  const avg = dyn.acc / dyn.n;
  dyn.acc = dyn.n = 0;
  let s = dyn.scale;

  if (avg > 21.5 && s > 0.6) {
    s = avg > 45 ? 0.6 : Math.max(0.6, s - (avg > 30 ? 0.2 : 0.1));
    dyn.upDelay = Math.min(60, dyn.upDelay * 2);
    dyn.upWait = dyn.upDelay;
  } else if (avg < 17.4 && s < 1 && dyn.upWait <= 0) {
    s = Math.min(1, s + 0.1);
    dyn.upWait = 2;
  } else if (avg < 17.4 && s >= 1) {
    dyn.upDelay = 4;
  }

  s = Math.round(s * 10) / 10;

  // 连续触底 → 降一档画质
  if (s <= 0.6 && avg > 26) {
    dyn.floorHits = (dyn.floorHits || 0) + 1;
    const next = { ultra: 'high', high: 'medium', medium: 'low' }[quality.name];
    if (dyn.floorHits >= 2 && next) {
      dyn.floorHits = 0;
      dyn.scale = 0.8;
      dyn.settle = 2;
      dyn.upDelay = 4;
      setQuality({ ...PRESETS[next] });
      return;
    }
  } else dyn.floorHits = 0;

  if (s !== dyn.scale) { dyn.scale = s; dyn.settle = 1; resize(); }
}
```

要点：

- 采样窗口 45 帧或 900ms，取平均；不要用单帧。
- 下降快（0.1/0.2），上升慢（0.1，且 `upWait` 翻倍）；有滞回，避免抖动。
- 启动后 3.5s 稳定期不调；截图/展示模式关闭。
- 连续两次在最低 scale 仍 >26ms → 降一整档画质。
- 任何 `resize` 后重置 settle，避免刚重建就继续降。

### 2.2 像素预算

```js
const budget = { low: 1e6, medium: 1.5e6, high: 2.3e6, ultra: 3.7e6 }[quality.name];
let s = quality.scale * dyn.scale;
const px = w * dpr * h * dpr * s * s;
if (px > budget) s *= Math.sqrt(budget / px);
```

先按预算压 scale，再算 RT 尺寸；不要让 4K + DPR2 直接分配超大 HDR。

---

## 3. 诊断与统计

```js
window.__stats = () => ({
  calls: renderer.info.render.calls,
  tris: renderer.info.render.triangles,
  geos: renderer.info.memory.geometries,
  tex: renderer.info.memory.textures,
  programs: renderer.info.programs?.length ?? 0,
  res: [render.resolution.x, render.resolution.y],
  scale: dyn.scale,
  advanced: postEnabled,
  softShadows,
  fps: fpsEma ? +(1 / fpsEma).toFixed(1) : 0,
  state: game.state,
});
```

每帧 `renderer.info.reset()`（因为 `autoReset=false`），否则统计会累加。

错误捕获见 `architecture.md`；`__errors` 必须包含 `console.error` 的包装结果，否则很多 WebGL 警告看不到。

---

## 4. Showcase：单系统可复现场景

每个系统导出一个模块：

```js
const levelShowcase = {
  create: () => createLevel,
  showcase: async (context) => {
    // 只搭该系统的最小场景
    return { cam: [x, y, z], target: [x, y, z], update(dt) {} };
  },
  TUNE: () => LEVEL_TUNING,
};
```

注册表：

```js
const SHOWCASES = { mats, level, backdrop, ground, fx, weapon, enemies, props, render };
```

启动时：

```js
const name = params.show && SHOWCASES[params.show] ? params.show : null;
if (name) {
  context.input = createShowcaseInput();     // 空输入
  context.player = createShowcasePlayer();   // 固定位置
  // 只初始化该系统需要的依赖，其余用 fallback
  context.level = { stub: true, playerStart: {...}, ... };
  const info = await SHOWCASES[name].showcase(context);
  setShot({ cam: [...info.cam, ...(info.target || [0,1,0])].join(',') });
}
```

用途：

- 材质：一排球体 + 几个大盒子，看 roughness/metalness/贴图。
- 关卡：固定相机看全景/局部。
- 武器：hip/ads/reload/empty/fire 多机位，可用 `?wpose=reload&wt=1.2` 冻在关键帧。
- 敌人：idle/fight/dead，可 `?epre=2` 预演 2 秒。
- 特效：逐个触发，看颜色/寿命/密度。

**每个 showcase 都必须能在 1 条 URL 内复现一张图。**

---

## 5. 固定场景截图

```text
?shot=1&q=test&seed=4207&dt=0&noaudio=1
&cam=-32,1.68,6,0,1.68,6
&fov=74&exposure=1
```

- `shot=1`：关闭动态分辨率/运动模糊/自动曝光（或固定），保证像素稳定。
- `dt=0`：时间不推进，只渲染一帧；适合结构/材质对比。
- `cam`：位置 + 看向点，6 个数。
- `fov/exposure`：固定镜头参数。
- `seed`：固定程序化内容。

扩展：

- `?noweapon=1`：隐藏武器，拍场景。
- `?dynres=0`：关闭动态分辨率。
- `?post=0`：前向回退。
- `?ao=0&vol=0&bloom=0&mb=1`：逐项开关。

**验收时同时记录 URL、画质档、浏览器、GPU、窗口尺寸。** 不同机器不能直接比 FPS。

---

## 6. 基准模式

```js
?bench=1   // 自动 noaudio + autostart
```

沿相机路径（关卡 `cinematicPath` 或默认两点）以 30s 循环巡游：

- 采集每帧毫秒数，保留最近 3000 帧。
- 每秒输出 avg / median / p99 / FPS。
- 同时输出 GPU 名、drawing buffer 尺寸、画质、DPR、`__stats()`、`__errors`。

p99 比 avg 更能暴露卡顿；avg 好看但 p99 爆炸，说明有周期性 hitch（GC/纹理上传/阴影重建）。

---

## 7. 回归与等价验证

恢复版工程做了三件事，值得抄：

1. **结构审计**：把 66 个模块的 2069 条语句逐条映射回原始归档，确认表达式/常量/着色器/绑定一致；只允许模块边界、作用域改名、空 if 包裹差异。
2. **固定场景数值对比**：579 个场景节点的类型/名称/可见性/变换哈希；206 组几何的属性/索引/group 哈希；178 组材质的类型/名称/颜色/表面参数/显式 shader 字符串哈希；目标/玩家/武器/引擎状态逐项比对。
3. **图像对比**：同机位 JPEG，逐像素 RGB 平均差约 0.0077/0.0075/0.0095（0–255），最大差 9；记录为 JSON，而不是“看起来一样”。

你不必复刻 2069 条语句，但应建立：

- 场景/几何/材质的可哈希快照。
- 固定机位截图的像素差阈值。
- 关键交互的脚本化冒烟（移动距离、弹匣数、状态切换）。

---

## 8. 性能排查顺序

1. **先看帧时间分布**：avg/median/p99；p99 高 → 找周期性 hitch。
2. **关后处理**（`?post=0`）：如果恢复，逐项开关 AO/vol/bloom/mb。
3. **降分辨率**：如果线性恢复，瓶颈在填充率/后处理；如果不恢复，瓶颈在 CPU/draw calls。
4. **看 `__stats()`**：calls 高 → 合批/实例化；tris 高 → 模型/植被；tex 高 → 纹理预算；programs 高 → 材质变体爆炸。
5. **看 `__errors`**：shader 编译失败会静默回退，表现成“效果没了但帧率好了”。
6. **Chrome Performance**：找 `update` 里的每帧分配、DOM 更新、排序、raycast。
7. **移动端**：DPR 上限 1.5–2；纹理 512；关闭 planar reflection、motion blur；粒子减半。

### 常见 CPU 热点

- 每帧 `new Vector3/Matrix4`（GC 抖动）。用模块级临时对象。
- 每帧 `array.sort` / `filter`。缓存或改用插入/桶排序。
- 每帧 `innerHTML` / 大量 DOM 读写。HUD 只在值变化时更新，文本用缓存。
- 每帧 raycast 感知。改固定间隔。
- 每帧 `shadowMap.needsUpdate = true`。隔帧或按需。
- 每帧重建材质/几何。缓存 key。
- 控制台每帧输出。用 once 标记。

### 常见 GPU 热点

- 透明 overdraw（雨、烟、贴花、粒子）。控制数量与屏幕覆盖率。
- 全分辨率后处理链。AO/vol 半分辨率，bloom 从 1/2 开始。
- 4096 阴影 + 每帧更新。降尺寸/隔帧。
- 过多材质变体导致 program 切换。合批/合并 define。
- 纹理过大/过多。按预算生成，远处降 mip。

---

## 9. 验收矩阵

| 维度 | 必测 |
|---|---|
| 浏览器 | Chrome/Edge 最新；Safari 或 Firefox 至少一个 |
| 设备 | 桌面独显、桌面核显、移动端（或模拟降档） |
| 画质 | low / high；`?post=0`；`?noaudio=1` |
| 状态 | title → intro → playing → paused → dead → complete → retry |
| 输入 | 键鼠、拖拽回退、触屏（如有）、手柄（如有） |
| 网络/资源 | 无外部请求；断网可启动（字体已本地化） |
| 错误 | `__fatal == null`，`__errors` 空 |
| 性能 | avg/p99 在预算内；连续 3 分钟无下降 |
| 回归 | 固定场景哈希/截图差在阈值内 |

---

## 10. CI 闸门

本地能跑的命令，CI 必须原样跑：

```yaml
- run: npm ci
- run: npm run check     # 语法 + 导入/导出 + 循环依赖 + 归档/字体哈希
- run: npm run build
- uses: actions/upload-pages-artifact@v3
  with: { path: ./dist }
```

原则：

- **日常闸门**只放“改坏了就红”的检查：语法、依赖图、构建、关键哈希。
- **一次性证明脚本**（原件 SHA、迁移等价、逐语句映射）单独命名、单独运行，不要塞进日常 `check`；否则你每次有意改玩法都要维护历史证据。
- 构建产物大小、gzip 大小、纹理/音频预算可以作为非阻断报告，先观察再设阈值。
- 部署前至少跑一次 headless 冒烟：打开页面、等 `__ready`、读 `__errors`、截一张固定机位图。

---

## 11. 完成定义（Definition of Done）

- [ ] 一条 URL 能复现验收截图。
- [ ] `__stats()` 四项资源在预算内。
- [ ] 低画质/无音频/无后处理都能玩。
- [ ] 任意单系统初始化失败可降级。
- [ ] 同 seed 内容一致。
- [ ] 完整流程无卡死、无黑屏、无控制台刷屏。
- [ ] 手感检查表全过。
- [ ] 回归快照与阈值已记录。
