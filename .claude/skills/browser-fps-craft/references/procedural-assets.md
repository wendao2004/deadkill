# 程序化资产：纹理、几何、模型、音频

样本对应：`src/render/materials/surface-shaders.js`、`textures.js`、`src/core/geometry.js`、`src/enemies/models.js`、`src/world/props/*`、`src/audio/synthesis.js`、`library.js`。

程序化不是“省美术”，而是换取：**零下载、零版权、可 seed 复现、包体可控、风格统一**。代价是启动时间和 shader 复杂度，所以要预算。

---

## 1. 原则

1. **确定性**：所有内容生成走种子 RNG 或纯函数 hash；同一 seed 必须得到同一场景。
2. **分层生成**：一个表面函数产出 albedo/ORM/height；法线由 height 求导，不手写。
3. **参数化**：材质表只写参数（颜色、粗糙、金属、平铺、磨损量），不写 shader。
4. **可降级**：纹理尺寸、粒子数、音效变体数都跟画质档走；低端设备能用灰盒。
5. **生成让路**：启动分步 + `await setTimeout(0)`；重资源靠后；不要一次性阻塞 3 秒。

---

## 2. 程序化纹理

### 2.1 三目标输出

```glsl
// surface-shaders.js 的公共约定
void emit(vec3 color, float alpha, float height, float ao, float rough, float metal) {
  o0 = vec4(sqrt(clamp(color, 0.0, 1.0)), sat(alpha)); // albedo：sqrt 存感知空间
  o1 = vec4(sat(ao), clamp(rough, 0.03, 1.0), sat(metal), 1.0); // ORM
  float h = sat(height) * 255.0;
  float f = floor(h);
  o2 = vec4(f / 255.0, h - f, 0.0, 1.0);               // 16-bit height 拆两通道
}
```

管线：

```text
RawShaderMaterial（全屏三角形）
  → MRT: albedo / ORM / height
  → normal pass: 从 height 求梯度
  → albedo 平方还原（copy pass）
  → mipmap + repeat + anisotropy
```

样本的 normal pass：

```glsl
float H(vec2 uv) { vec4 t = texture(tH, uv); return t.r + t.g / 255.0; }
vec2 e = vec2(uTexel, 0.0);
float gx = (H(uv+e.x) - H(uv-e.x)) * 0.5
         + (H(uv+e.xy) + H(uv+e.x-y) - H(uv-e.xy) - H(uv-e.x-y)) * 0.25;
float gy = ...;
vec3 n = normalize(vec3(-gx * uK.x, -gy * uK.y, 1.0));
o = vec4(n * 0.5 + 0.5, 1.0);
```

### 2.2 公共图元

```glsl
uvec3 pcg3(uvec3 v);                  // 低成本 hash
vec3 h3(vec2 cell, vec2 period, float seed);
float gn(vec2 p, vec2 per, float s);  // 梯度噪声
float fbm(vec2 uv, vec2 freq, int oct, float seed);
vec4 vor(vec2 p, vec2 per, float s);  // x=F1, y=F2, z=cell id, w=second id
float scr(vec2 uv, float freq, float seed, float width,
          float angle, float spread, float density);
float rustMask(vec2 uv, vec2 freq, float threshold, float seed);
float chipsF(vec2 uv, vec2 freq, float seed, float density, float radius);
void paintDmg(vec2 uv, float amount,
              out float chip, out float stain, out float run);
```

这些函数覆盖了大多数硬表面：噪声做污渍/宏观变化，voronoi 做碎石/骨料/锈斑，scratch 做划痕，paintDmg 做掉漆/锈痕/流挂。

### 2.3 表面函数示例：沥青

```glsl
Tn.asphalt = `
void surf(vec2 uv) {
  vec4 a = vor(uv * 110.0, vec2(110.0), 1.0);   // 粗骨料
  vec4 b = vor(uv * 230.0 + 3.0, vec2(230.0), 2.0); // 细骨料
  float big  = fbm(uv, vec2(3.0), 4, 5.0);
  float mid  = fbm(uv, vec2(24.0), 4, 6.0);
  float fine = fbm(uv, vec2(300.0), 2, 7.0);
  float jag  = fbm(uv, vec2(420.0), 2, 8.0) - 0.5;

  float sa = smoothstep(0.46, 0.3, a.x + jag*0.3 - (a.y-a.x)*0.2 + (1.0-a.w)*0.12)
           * step(a.z, 0.62);
  float sb = smoothstep(0.46, 0.3, b.x + jag*0.2 + (1.0-b.w)*0.15)
           * step(b.z, 0.85);

  float h = max(sa * (0.45 + 0.55*a.w), sb * 0.5 * (0.5 + 0.5*b.w));
  h = h * 0.6 + fine * 0.3 + mid * 0.1;

  vec3 col = L(0.13, 0.13, 0.135) * (0.8 + 0.4 * mid);
  col = mix(col, mix(L(0.26,0.26,0.28), L(0.44,0.43,0.42), b.w), sb * 0.7);
  col = mix(col, mix(L(0.28,0.28,0.29), L(0.45,0.43,0.41), a.w), sa);

  // 裂缝：细噪声等值线 + 大尺度门控
  float crack = smoothstep(0.016, 0.009,
      abs(fbm(uv + vec2(0.13,0.4), vec2(2.0), 3, 9.0) - 0.5));
  col = mix(col, L(0.075,0.075,0.08), crack * 0.93);
  h = mix(h, 0.74, crack * 0.88);

  emit(col, 1.0, h, 0.85, mix(0.93, 0.74, sa), 0.02);
}`;
```

### 2.4 表面函数示例：掉漆钢

```glsl
Tn.paint = `
void surf(vec2 uv) {
  float chip, stain, run;
  paintDmg(uv, 1.0, chip, stain, run);
  vec3 paint = L(0.42, 0.10, 0.06);
  vec3 steel = L(0.22, 0.22, 0.23);
  vec3 rust  = L(0.32, 0.14, 0.06);
  vec3 col = mix(paint, steel, chip);
  col = mix(col, rust, stain * 0.7);
  col = mix(col, rust * 0.8, run * 0.5);
  float h = mix(0.7, 0.3, chip) - stain * 0.05;
  float r = mix(0.55, 0.35, chip) + stain * 0.2;
  float m = mix(0.1, 0.9, chip);
  emit(col, 1.0, h, 0.9, r, m);
}`;
```

### 2.5 铁丝网 / alpha cut

- 用距离场画菱形网格；`alphaTest = 0.5`。
- 远处线宽低于 1px 时，降低 alpha 阈值并转成稳定 dither，保持“约 1/3 覆盖率”的纱幕，避免整片消失或闪白。
- 反射/高光按覆盖率衰减。

```glsl
// 亚像素近似：覆盖率而不是二值
float wire = smoothstep(0.5 - w, 0.5 + w, diamond);
float cover = mix(wire, dither(gl_FragCoord.xy) * 0.66, subpixel);
if (cover < 0.02) discard;
```

### 2.6 尺寸与预算

```js
const base = Math.min(params.tex || quality.tex || 1024, 1024);
const size = material.hero && base >= 2048
  ? 2048
  : Math.max(32, Math.round(base * material.size));
// 3 张 RGBA8 + mipmap ≈ size² * 4 * 3 * 1.34 字节
```

样本：27 个表面函数、88 个材质条目；普通 256–1024，hero 2048；各向异性最多 8；4 秒无请求释放临时 MRT。

---

## 3. 几何

### 3.1 共享构造函数

| 函数 | 解决什么 |
|---|---|
| `boxGeometry(w,h,d,anchor)` | BoxGeometry 的 UV 每个面都是 0..1；按面重写 UV，让纹理按米平铺 |
| `beveledBoxGeometry(w,h,d,bevel,anchor)` | 3×3×3 分段，把角点往里收并重算法线；所有硬表面默认用它，边缘有高光 |
| `cylinderGeometry(r1,r2,h,seg,open,anchor)` | 侧面 UV 按周长展开，端面按平面展开 |
| `tubeGeometry(points,radius,...)` | CatmullRom 曲线 + 管；UV 按长度/周长展开（线缆、绳、软管） |
| `transformGeometry(geo,{p,r,s})` | 把变换烘进几何，便于合并 |
| `colorGeometry(geo, colorOrFn)` | 写顶点色，用于同一材质多色 |
| `mergeGeometryParts(parts)` | 统一 position/normal/uv/color，索引/非索引兼容，合并 |
| `batchStaticMeshes(root)` | 按材质+阴影+layer 分组，把静态网格合并成少量 Mesh |

### 3.2 静态合批

```js
function batchStaticMeshes(root, { castShadow = true, receiveShadow = true } = {}) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  const keep = [];
  root.traverse(mesh => {
    if (!mesh.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh
        || Array.isArray(mesh.material) || hasNoMergeFlag(mesh)) {
      keep.push(mesh); return;
    }
    const key = mesh.material.uuid
      + (mesh.castShadow ? 'c' : 'n')
      + (mesh.receiveShadow ? 'r' : 'n')
      + ':' + mesh.layers.mask;
    groups.get(key) ?? groups.set(key, { mat: mesh.material, geos: [] });
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    groups.get(key).geos.push(g);
  });
  // 每组 merge → 一个 Mesh；保留 noMerge/skinned/instanced 原对象
}
```

要点：

- 合批键必须包含材质、是否投影/接收阴影、layer；否则光照/阴影会串。
- 合批后 draw calls 从数百降到几十，但会失去视锥剔除粒度；按区域分块（样本把 staticRoot 与 dynRoot 分开）。
- 需要独立变换/动画/交互的对象打 `userData.noMerge`。
- 合批前把所有变换烘进几何；合批后不要再改这些对象的 matrix。

### 3.3 碰撞体

每个道具 builder 返回：

```js
group.userData.colliders = [
  { min: [-w/2, 0, -d/2], max: [w/2, h, d/2], surface: 'metal' },
];
group.userData.size = [w, h, d];
```

关卡/物理系统统一读取，生成 AABB。不要为每个小零件建碰撞体；用 1–3 个盒子近似。

---

## 4. 程序化模型

### 4.1 骨骼/蒙皮

样本的 enemy rig：

```js
const rig = new Rig();
rig.bone('root');
rig.bone('body', 'root', 0, 1.2, 0);
rig.bone('rotor0', 'body', 0.6, 0.3, 0);
rig.add('body', 'body', bodyGeometry, [1,1,1]);
rig.add('rotor0', 'rotor0', rotorGeometry, [1,1,1]);

const built = rig.build(['body', 'rotor0', ...]); // merge + skinIndex/skinWeight
```

- 每个部件只绑一根骨骼（weight=1），足以做旋翼、腿、炮塔、门。
- 顶点色按法线朝上略微提亮，模拟 AO。
- 几何在骨骼空间平移后合并；`skinIndex` 写骨骼索引。
- `SkinnedMesh` + `Skeleton`，每根骨骼一个 `Bone`，父子关系按名字建。

### 4.2 车削/挤出/环

- 枪管、弹壳、轮胎：`LatheGeometry`（轮廓点 → 旋转体）。
- 机匣/枪托：`ExtrudeGeometry` + `Shape`。
- 环/圈：`TorusGeometry`、`RingGeometry`。
- 线缆：`TubeGeometry` + CatmullRom。
- 所有部件先 `transformGeometry` 定位，再 merge；材质按用途分组（枪金属/聚合物/黄铜/手套）。

### 4.3 贴花/标签

- 用 canvas 生成文字/编号/警示贴图；一张 atlas 放多个标签。
- 单个标签是一小块平面，贴在模型表面，`polygonOffset` 防 z-fight。
- 枪身刻字可以用 20 多块极小平面；近看非常“贵”，成本却很低。
- 敌人编号牌、集装箱编号、地面标线都用同一套。

---

## 5. 关卡与道具

### 5.1 注册表

```js
const PROP_SIZES = {
  container20: [6.06, 2.59, 2.44, 'paint_red', 'metal'],
  jersey_barrier: [3, 0.81, 0.6, 'concrete', 'concrete'],
  // …
};

const PROP_BUILDERS = {};
function registerProp(name, builder) { PROP_BUILDERS[name] = builder; }
```

- builder 覆盖顺序要显式（基础 → 精细 → 角色 → 货物），否则同名道具行为不可预测。
- 未知道具回退灰盒 + 一条警告，不要崩。
- 每个道具声明尺寸和表面材质，供放置、碰撞、导航使用。

### 5.2 放置辅助

```js
wall(x, z, length, height, angle, material)
box(parent, material, w, h, d, x, y, z, bevel)
cylinder(parent, material, r, h, x, y, z, rot)
cable(points, radius, material, y)
```

关卡代码只调用这些函数；不要在每个物件上手写 `new Mesh`。这样改材质/尺寸/风格只改一处。

### 5.3 区域语义

- 关卡对象带 `zone`（yard/shed/quay），用于音频混响、敌人巡逻、任务目标、室内外判断。
- `interiorBoxes` 给渲染/音频/武器 wetness 用。
- `groundSurfaceAt(x,z)` 返回表面类型（混凝土/水/金属），供脚步/弹着点音效。
- `enemySpawns` 分 `air/ground`，按距离/视线/最近使用时间选点。

---

## 6. 程序化音频

### 6.1 音库清单

```js
{
  rifle_shot: { gen: rifleShot, n: 4, sr: 44100, peak: 0.97,
                bus: 'near', max: 5, pri: 9, boot: 1 },
  step_metal: { gen: footstepMetal, n: 3, sr: 32000, peak: 0.5,
                bus: 'near', max: 3, pri: 5 },
  // …
}
```

- `n` 个变体，播放时随机选；避免机械复读。
- `sr` 按用途：近场 44.1k，环境/尾部 22.05–32k。
- `peak` 归一化；`max/pri` 控制并发与抢占；`boot` 预生成。
- 样本 63 个 cue，覆盖武器、换弹、脚步、材质撞击、敌人、环境、任务、UI、音乐。

### 6.2 合成积木

- 振荡器：`sin/saw/square` + 频率包络（pitch drop）。
- 噪声：白噪/粉噪/带通噪声；枪声的“crack”是高频短噪声。
- 包络：attack/decay/sustain/release；机械声用极短 attack + 指数 decay。
- 滤波：lowpass/highpass/bandpass 扫频；伺服是窄带扫频。
- 失真/饱和：软削波给枪声厚度。
- 卷积：程序化 IR（指数衰减噪声 + 早期反射）做室外/室内。
- 调制：旋翼用低频正弦调制噪声振幅/滤波。

### 6.3 空间与混音

- 近场（武器/换弹）走干声；世界声走 3D panner + 距离衰减。
- 室内/室外切两套卷积 IR，交叉淡化，不要硬切。
- 循环体返回句柄：

```js
const loop = audio.loop('gull_rotor', { pos, gain: 0.5 });
loop.setPos(pos); loop.setGain(g); loop.stop();
```

- `setIntensity(0.15 | 0.6 | 1.0)` 控制音乐层与紧张度；`setPaused` 暂停所有。
- 用户手势后才能 `AudioContext.resume()`；启动时不要假设音频已运行。

### 6.4 内存与启动

- 44.1k 单声道 1 秒 ≈ 176KB；63 个 cue × 变体 × 平均 1–3 秒，容易到几十 MB。
- 低画质/移动端降低变体数与采样率；环境声可流式/循环复用。
- 预生成放在启动后半段，或按 `boot` 优先级分批；不要阻塞首帧。

---

## 7. 资产预算与检查

| 项目 | 建议 |
|---|---|
| 纹理 | 每表面 3 张；普通 ≤1024，hero ≤2048；总纹理 ≤ 300MB（桌面）/120MB（移动） |
| 几何 | 单道具 ≤ 5k tris；单敌人 ≤ 8k；单武器 ≤ 15k；关卡合并后 ≤ 1.5M |
| 材质 | 唯一材质数 ≤ 100；合批后每材质一个 draw call |
| 音频 | 同时发声 ≤ 32；变体 ≤ 4；总缓冲 ≤ 8MB（可按画质降） |
| 启动 | 纹理生成 + 音频预生成 ≤ 2.5s（桌面）；每步让出主线程 |

### 检查表

- [ ] 同 seed 两次生成，几何/材质/音效哈希一致。
- [ ] 纹理无明显接缝/拉伸；盒体 UV 按米平铺。
- [ ] 倒角盒边缘有高光，不是纯平面。
- [ ] 合批后 draw calls 明显下降，阴影/材质没有串。
- [ ] 未知道具/材质有灰盒回退和警告。
- [ ] 音效无爆音/点击（首尾有淡入淡出）。
- [ ] 低画质下纹理/音频/粒子按比例缩减。
- [ ] 启动没有超过 300ms 的同步阻塞（看日志）。
