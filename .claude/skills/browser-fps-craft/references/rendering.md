# 渲染：管线、材质、光照与后处理

样本对应：`src/render/renderer.js`、`src/render/postprocessing.js`、`src/render/materials/*`、`src/render/sky.js`、`src/render/shadows.js`。

目标不是“效果越多越好”，而是：**一个方向 + 一条可降级的管线 + 一套程序化材质 + 可复现的画质档**。

---

## 1. 渲染器与相机分层

```js
const renderer = new WebGLRenderer({
  canvas, antialias: false,          // MSAA 交给 HDR RT
  powerPreference: 'high-performance',
  alpha: false, depth: true, stencil: false,
});

renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;     // 色调映射在后处理末尾
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
renderer.shadowMap.autoUpdate = false;    // 手动 needsUpdate
renderer.autoClear = false;
renderer.info.autoReset = false;          // 自己每帧 reset
```

两层相机：

- **世界相机**（`camera`，FOV 74，near 0.08，far 900）只渲染世界层 `vf`。
- **视图模型相机**（`viewCamera`，FOV 54，near 0.01，far 10）只渲染视图模型层 `zc`。
- 视图模型挂在主相机下，但网格 `layers.set(zc)`；世界相机看不到它。
- 每帧同步视图模型相机的世界矩阵：

```js
camera.updateMatrixWorld(true);
viewCamera.matrixWorld.copy(camera.matrixWorld);
viewCamera.matrixWorldInverse.copy(viewCamera.matrixWorld).invert();
```

这样武器永远不会穿墙，近裁剪也不会切掉枪管。

---

## 2. HDR 与渲染目标

```js
const depthTex = new DepthTexture(4, 4);
depthTex.type = UnsignedIntType;
depthTex.minFilter = depthTex.magFilter = NearestFilter;

const hdr = new WebGLRenderTarget(4, 4, {
  type: HalfFloatType,
  format: RGBAFormat,
  minFilter: LinearFilter, magFilter: LinearFilter,
  depthBuffer: true, stencilBuffer: false,
  depthTexture: depthTex,
  samples: quality.msaa | 0,
  generateMipmaps: false,
});
```

- 场景只渲染到这张 HDR 目标；最终后处理输出到 `null`（画布）。
- 画布始终原生分辨率；只有 HDR 目标按 `renderScale` 缩放。
- `resize()` 里限制总像素预算，避免 4K + 高 DPR 直接爆显存：

```js
const dpr = Math.min(devicePixelRatio || 1, 2);
const scale = quality.scale * dynamicScale;
const budget = { low: 1e6, medium: 1.5e6, high: 2.3e6, ultra: 3.7e6 }[quality.name];
let s = scale;
const px = w * dpr * h * dpr * s * s;
if (px > budget) s *= Math.sqrt(budget / px);
```

---

## 3. 后处理执行顺序

### 3.1 高级管线（推荐）

```text
1. 世界 HDR 渲染（shadowMap.needsUpdate 按需）
2. 深度复制（可选，给需要 depth 的 pass）
3. depth → 视空间线性深度（半分辨率，texelFetch）
4. AO（半分辨率，AO_TAPS=12）→ 水平双边模糊 → 垂直双边模糊
5. 体积光（半分辨率，VOL_STEPS 按画质 10–40，常用 16–24；采样太阳阴影图）
   → 水平模糊 → 垂直模糊
6. 合成：场景 + AO + 体积光，联合双边升采样，应用曝光
7. 运动模糊（可选，重投影上一帧 VP）
8. Bloom：6 级下采样（首级 partial Karis）→ 6 级上采样混合
9. 变形宽银幕拉丝：两次水平高亮模糊
10. 自动曝光：1×1 ping-pong，中心加权 log 平均 + 太阳可见度
11. 调色：ACES/AgX → 分离色调 → S 曲线 → 抬黑 → 饱和度
    → 暗角 → 受伤红边 → 淡入淡出 → sRGB
12. 最终：FXAA + 轻锐化 + 胶片颗粒 + 抖动
```

### 3.2 前向回退

后处理初始化失败或运行中抛错 → 永久切：

```js
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6 * exposure;
renderer.setRenderTarget(null);
renderer.clear();
renderer.render(scene, camera);
renderer.clearDepth();
renderer.render(scene, viewCamera);
```

不要每帧尝试重建后处理；失败一次就降级，日志写清楚。

### 3.3 关键参数

```js
const TUNE = {
  // 体积
  volSunScale: 0.85, volAmbient: 0.2, volSigma: 0.0034,
  volMaxDist: 170, volFarHaze: 0.42, volInteriorDust: 6,
  // AO
  aoRadius: 0.9, aoIntensity: 1.6, aoStrength: 0.95,
  // bloom / lens
  bloom: 0.065, bloomMix: 0.62, dirt: 0.1,
  streak: 0.03, streakThreshold: 2.2, flare: 0.16,
  // 曝光
  key: 0.12, minExposure: 0.6, maxExposure: 2, adaptTau: 1.5,
  // 调色
  agxMix: 0.25, ca: 0.0013, vignette: 0.3,
  grain: 0.02, sharpen: 0.3, lookPower: 1.18, lookSat: 1.22,
};
```

这些是样本值，不是普适真理。改之前先截同机位图。

---

## 4. 关键 shader 配方

### 4.1 线性深度（半分辨率）

```glsl
uniform sampler2D tDepth;
uniform float uNear, uFar;
void main() {
  // 用 texelFetch 取精确 texel，避免在 texel 角采样导致 AO 在地面上出现条带
  ivec2 p = min(ivec2(gl_FragCoord.xy) * 2, textureSize(tDepth, 0) - 1);
  float d = texelFetch(tDepth, p, 0).r;
  float z = d < 0.05 ? 0.01 : (uNear * uFar) / (uFar - d * (uFar - uNear));
  gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
}
```

### 4.2 AO（半分辨率，深度重建法线）

```glsl
vec3 vpos(vec2 uv, float z) {
  return vec3((uv * 2.0 - 1.0) * uTanHalf * z, -z);
}
// 取邻域最近深度差重建 dx/dy，cross 得法线
// Vogel/螺旋采样 AO_TAPS 次，按半径缩放
// 远处 smoothstep 淡出，避免远景噪点
```

要点：

- AO 只应作用于**环境光**。合成时按亮度淡出：`lit = smoothstep(0.16, 0.85, luma(col) * exposure)`，`a = mix(1, ao, strength * (1 - 0.8*lit))`。否则阳光直射面会出现脏边。
- 半分辨率结果的升采样用**联合双边**（用深度差做权重），不要直接 bilinear。

### 4.3 体积光

```glsl
for (int i = 0; i < VOL_STEPS; i++) {
  float f = (i + 1.0) / float(VOL_STEPS);
  float t1 = maxD * f * (0.35 + 0.65 * f);   // 近处采样更密
  float ds = t1 - tPrev;
  vec3 p = camPos + rd * (tPrev + ds * jitter);
  float sh = sunVis(p);                       // 采样太阳阴影图
  float ext = sigma * heightShape(p.y) * (1.0 + dust * insideBox(p));
  float Ti = exp(-ext * ds);
  acc += T * (sunRad * phase * sh + ambient) * (1.0 - Ti);
  T *= Ti;
  tPrev = t1;
}
// 远端解析接续：dist > maxD 时按雾密度衰减到地平线色
```

- 相位用双 lobe：紧前向（太阳方向的金色光晕）+ 宽 lobe（侧光柱也可见）。
- 室内 box 提高密度、降低环境项，让门/百叶窗/屋顶漏洞的光柱读得出来。
- 近处权重高、远处收敛成薄纱，是“艺术指导”而不是物理正确。

### 4.4 自动曝光

```glsl
// 7×5 中心加权 log 平均
float avg = clamp(exp(sum(log(max(luma,1e-4)) * w) / sumW), 0.002, 40.0);
// 太阳可见度：12 个螺旋采样，看深度是否为天空
vis = ...
// 1×1 ping-pong，指数缓动；首帧/NaN 保护
a = mix(prev, avg, rate);
if (!(a > 0.0) || a > 1e4) a = avg;
```

### 4.5 调色与最终

- 色调映射：ACES（Hill fit）与 AgX 按 `agxMix` 混合——ACES 给橙色的冲击力，AgX 让高光滚到白。
- 分离色调：阴影偏青、高光偏暖；轻 S 曲线；抬黑（`col * 0.988 + vec3(0.006,0.0085,0.011)`）。
- 受伤：红边 + 低血量去饱和/暗角；ADS 收暗角。
- 最终：FXAA 只在局部对比度足够时执行；锐化在强边缘处回退；颗粒按亮度加权；最后加 1/255 抖动防天空色带。

### 4.6 Bloom 的 Karis average

首级下采样用 4 个 2×2 组的亮度倒数加权，压制 firefly，同时不杀死太阳。后续级别用标准 13-tap。上采样逐级 mix。

---

## 5. 程序化材质系统

### 5.1 架构

```text
surface-shaders.js
  ├─ 公共 GLSL：hash / noise / fbm / voronoi / scratches / rustMask / paintDmg
  ├─ Tn.<surface>(uv)：每个表面函数调用 emit(...)
  └─ emit(c, alpha, height, ao, rough, metal) → 3 个 MRT 输出

materials.js
  ├─ 用 RawShaderMaterial + 全屏三角形，一次渲染 3 个目标
  ├─ albedo (sRGB) / ORM (AO,R,M) / normal (由 height 求导)
  ├─ 生成 mipmap、设置 repeat/anisotropy
  ├─ 缓存：按 (surface, size) 复用渲染目标
  └─ 材质表：名字 → { set, color, rough, metal, nrm, tile, wet, macro, ... }
```

### 5.2 尺寸与预算

```js
const texBase = Math.min(params.tex || quality.tex || 1024, 1024);
const size = material.hero && texBase >= 2048
  ? 2048
  : Math.max(32, Math.round(texBase * material.size));
```

- 普通表面 256–1024；hero（沥青）2048。
- 3 张 RGBA8 + mipmap ≈ `size² × 4 × 3 × 1.34` 字节。
- 生成后 4 秒无新请求就释放临时 MRT 缓存（材质本身仍持有纹理）。
- 各向异性 `min(8, maxAnisotropy)`。

### 5.3 材质补丁（Three.js）

```js
material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, {
    uSlWet, uSlWetP, uSlMacro, uSlUv, uSlX,
  });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_COMMON)
    .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_PROJECT);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + FRAG_COMMON)
    .replace('#include <map_fragment>', FRAG_MAP)
    .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
    .replace('#include <metalnessmap_fragment>', FRAG_METAL)
    .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
    .replace('#include <aomap_fragment>', FRAG_AO);
};

material.defines = {
  SL_TINT: material.tint,
  SL_TRIPLANAR: triplanar ? '' : undefined,
  SL_FX: fx ? '' : undefined,
  SL_ACUT: alphaCut ? '' : undefined,
};

material.customProgramCacheKey = () =>
  `sl2|${tint}|${triplanar ? 't' : ''}${fx ? 'f' : ''}${alphaCut ? 'a' : ''}`;
```

要点：

- `customProgramCacheKey` 必须覆盖所有 define 组合，否则 Three 会错误复用 program。
- 三平面投影用于没有合理 UV 的大件/合并几何；用世界坐标，按法线主轴混合。
- 顶点色用于同一材质多色（容器、敌人装甲）。
- 湿ness：朝上最强、垂直面流痕、底面为零；用世界法线和 UV 计算。
- 宏观变化：低频 noise 扰动颜色/粗糙度，打散平铺。
- alpha cut 用于铁丝网：距离越远阈值越低，保持线宽约 1px，亚像素后转成稳定 dither 纱幕。

### 5.4 材质表

样本 88 个条目、27 个表面函数。一个条目大致是：

```js
paint_red: {
  set: 'paint', size: 1, tile: 2.5, bump: 2.5,
  color: 0x8a2b22, rough: 0.55, metal: 0.1,
  nrm: 1, tint: 1,
  wet: [1, 1, 0.6, 0.4],     // 朝上/垂直/底面/流痕
  macro: [0.04, 0.8, 0.35, 0],
}
```

未知材质不要崩：警告一次并回退到一个中性 `MeshStandardMaterial`。

---

## 6. 光照、天空、环境

### 6.1 太阳与阴影

```js
sun.castShadow = true;
sun.shadow.mapSize.set(min(quality.shadow, maxTextureSize), ...);
sun.shadow.bias = -0.00012;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 1;
```

阴影相机按“主玩法区域 + 关键远景”的包围盒拟合：

```js
// 用太阳方向构造 lookAt 矩阵，把 8 个角点变换到光空间取 min/max
// near/far 也按深度范围算，最后加 1m 余量
```

`shadowMap.autoUpdate=false`；每帧或隔帧 `needsUpdate=true`（样本在非 ultra/非 shot 时隔帧更新）。

### 6.2 软阴影

替换 Three 的 `shadowmap_pars_fragment`：

- Vogel 盘采样（taps 16；low 10）
- 接收面深度梯度偏置（receiver plane depth bias）
- 阴影图边缘淡出

如果 chunk 布局与预期不符，**返回 false 并保留 stock PCF**，不要硬改。样本还会在自检发现该 chunk 编译失败时自动回退 `PCFSoftShadowMap`。

### 6.3 天空与环境

- 天空是一个大盒子/球，`BackSide`，自定义 shader：天顶/地平线/背阳地平线三色、太阳盘、米氏光晕、云底起伏、缝隙透光、闪电、远景空气透视。
- 用 `PMREMGenerator` 从天空场景烘环境贴图，赋给 `scene.environment`，强度约 2。环境贴图让金属有正确的反射。
- 室内再烘一张：`CubeCamera(0.15, 300, 128)` 放在棚中央，`PMREMGenerator.fromCubemap`，进入室内切换 `scene.environment` 与 `envMapIntensity`；带 `userData.interior` 的材质直接换 `envMap`。
- 天空 shader 加 `SALTLINE_SKY` 标记，便于着色器错误分类。

### 6.4 点光源池

```js
const pool = Array.from({ length: 6 }, () => new PointLight(0xffffff, 0, 12, 2));
function flash(pos, color = 0xffd080, intensity = 30, distance = 10, ttl = 0.06) {
  const light = pool.find(l => !l.userData.busy)
    ?? pool.filter(l => !l.userData.persistent)
           .sort((a, b) => a.userData.ttl - b.userData.ttl)[0];
  // 设置位置/颜色/强度/TTL
}
function acquire() { /* 持续光源，返回 release() */ }
```

枪口闪光、爆炸、敌人探照灯共用一个小池，避免动态光源数量失控。

---

## 7. 画质档与分辨率

样本预设：

| 档 | scale | msaa | shadow | tex | volSteps | ao | planar | bloom | motionBlur | rain |
|---|---|---|---|---|---|---|---|---|---|---|
| test | 1.0 | 0 | 1024 | 256 | 10 | on | 0.5 | on | off | 0.4 |
| low | 0.7 | 0 | 2048 | 512 | 12 | off | 0 | on | off | 0.5 |
| medium | 0.85 | 2 | 2048 | 1024 | 16 | on | 0.5 | on | off | 0.8 |
| high | 1.0 | 4 | 4096 | 1024 | 24 | on | 0.5 | on | on | 1.0 |
| ultra | 1.0 | 4 | 4096 | 2048 | 40 | on | 1 | on | on | 1.0 |

`test` 是 QA 专用：固定低纹理、无运动模糊，保证截图稳定。

动态分辨率与自动降档见 `qa-and-performance.md`。

---

## 8. 常见坑

1. **在 texel 角采样深度** → AO 条带。用 `texelFetch` 或 `+0.5`。
2. **AO 作用到直射光** → 阳光面脏边。按亮度淡出。
3. **Bloom 首级不做 Karis** → 高光 firefly 闪烁。
4. **自动曝光不防 NaN** → 一帧黑屏后永久黑。首帧和异常值回退 `avg`。
5. **`customProgramCacheKey` 漏 define** → 材质串味。
6. **后处理 resize 不同步 depthTexture 尺寸** → 深度采样错位/黑边。
7. **阴影相机跟随玩家每帧重建** → 阴影抖动。按区域拟合，或加稳定偏移。
8. **在透明材质上写深度** → 排序错误。透明体 `depthWrite=false`，贴花用 polygonOffset。
9. **色调映射既在场景又在后处理** → 双重压缩。场景 `NoToneMapping`，只在最终做。
10. **不做抖动** → 天空渐变出现色带。
