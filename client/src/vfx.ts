/**
 * 世界空间手绘战斗特效：命中飞溅、死亡墨爆、枪口硝烟。
 *
 * ## 为什么只有一套几何 + 一套材质
 *
 * 一个 InstancedMesh、一块 1x1 平面、一份 ShaderMaterial，全场 draw call 恒为 1
 * （没有活粒子时把 count 置 0，渲染器直接跳过，为 0）。碎片同时几十片时，若按 kind
 * 各建一套 InstancedMesh，光是材质切换与排序就会多出好几次状态变更；而 kind 之间
 * 真正的差别只有颜色、出射锥、寿命 —— 这些全是每实例数据，本就该走 instanceColor
 * 与 instanceMatrix，而不是走材质。
 *
 * ## 为什么 billboard 在顶点着色器里算
 *
 * 面板朝向需要相机基向量，而 createVfx 只拿得到 scene（拿不到 camera）。three 的
 * ShaderMaterial 顶点前缀里本来就声明了 uniform vec3 cameraPosition，顶点里现场算
 * right/up 即可。附带好处：每帧 CPU 只写"中心 + 长短轴 + 朝向"，不做任何叉乘归一化，
 * 也没有 Matrix4 临时对象。
 *
 * ## 为什么 instanceMatrix 被当成一个 float 袋子
 *
 * 变换在顶点里手算（见上），所以 instanceMatrix 的 16 个 float 原本完全空着。把
 * 长轴 / 短轴 / 形状码 / 随机种子 / 透明度 / 炽热值一并塞进这块本来每帧都要上传的
 * 缓冲里，比再挂五个 InstancedBufferAttribute 省五次上传。前提是读写槽位与顶点着色器
 * 严格对齐（见 VERTEX_SHADER 注释），改布局必须两边一起改。
 *
 * ## 为什么形状是硬边加缺口而不是软光斑
 *
 * 软边圆形粒子在任何距离上都读成发光点，正是要避免的通用 FPS 特效。笔触的特征
 * 相反：边界几乎一刀切（只留 1~2 像素的过渡防锯齿）、沿长度会干笔断续、两端收尖、
 * 中间弓一笔（手腕甩出来的弧，不是印刷的横杠）。
 *
 * ## 为什么寿命进度在 CPU 上算而不在着色器里算
 *
 * 稳态零分配要求 update() 只写回 instanceMatrix.array。既然每帧都要写满这块缓冲，
 * 就把位置、阻尼、重力、贴地一起在 CPU 算掉，不必再挂一条每帧上传的 instanceAge
 * 属性；着色器只管画形状。
 *
 * ## 为什么所有随机数都走 mulberry32
 *
 * 同一颗种子永远产出同一串碎屑形状与方向，特效才能被回放、截图对照、复现 bug。
 * 本文件不出现 Math.random。
 */

import {
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
} from 'three'
import type { Object3D, Scene } from 'three'
import { mulberry32 } from '@dk/shared'
import type { Vec3 } from '@dk/shared'

// ---------------------------------------------------------------- 公共契约

export type ImpactKind = 'flesh' | 'wood' | 'stone' | 'metal' | 'mud'

export interface VfxOptions {
  /** 同时活跃的特效上限，默认 96；超出时复用最老的。 */
  maxEffects?: number
}

export interface Vfx {
  /** 子弹打中某处的飞溅。dir 是子弹飞行方向（归一化），用来自动算背溅方向。 */
  impact(point: Vec3, dir: Vec3, kind: ImpactKind): void
  /** 怪物/玩家死亡时的一坨墨。 */
  burst(point: Vec3, scale: number): void
  /** Boss 范围技：一圈贴着地面的尘土/钟波，半径决定它铺多宽。 */
  shockwave(point: Vec3, radius: number): void
  /** 枪口硝烟，eye 是眼睛位置，dir 是朝向。 */
  muzzle(eye: Vec3, dir: Vec3, ads: boolean): void
  update(dt: number): void
  dispose(): void
  readonly root: Object3D
}

// ---------------------------------------------------------------- 常量

const TAU = Math.PI * 2
/** 写死的种子：形状与方向每次启动、每台机器都一致（原因见文件头）。 */
const VFX_SEED = 0x5eed1e5
const DEFAULT_MAX_EFFECTS = 96
/** 单发特效最多占多少颗粒子：burst 的 12 块墨 + 1 片血泊压印是最大值。 */
const MAX_PER_EFFECT = 14
/** 贴地压印离地的距离。给多了会浮空，给 0 会和地面 z-fighting 抖出闪烁的边。 */
const GROUND_Y = 0.02

/** 形状码：与顶点/片元着色器的分支一一对应，改值必须两边同步。 */
const SHAPE_FLICK = 0
const SHAPE_WISP = 1
const SHAPE_BLOT = 2
const SHAPE_POOL = 3

/** 物理档：同一套积分器喂所有粒子，靠重力 / 阻尼 / 淡出曲线分出手感。 */
const PHYS_FLECK = 0
const PHYS_SPARK = 1
const PHYS_INK = 2
const PHYS_SMOKE = 3
const PHYS_POOL = 4

/** 重力（m/s²）。硝烟给负值 —— 热烟往上飘，跟着碎屑一起掉就成灰了。 */
const GRAVITY = [12, 10, 9, -0.35, 0]
/** 空气阻尼（1/s）。碎屑很快停住；火星几乎不减速，所以要飞得远、拉得长。 */
const DRAG = [2.2, 1.0, 2.6, 1.4, 0]

/** sRGB 十六进制 → 线性 RGB，与 three.Color.setHex(SRGBColorSpace) 的换算逐位一致。 */
function lin(hex: number): readonly [number, number, number] {
  const cv = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return [cv((hex >> 16) & 0xff), cv((hex >> 8) & 0xff), cv(hex & 0xff)]
}

/** 命中墨色：色相按材质分，明度压在"中浅调"—— 夜空里再亮一点就成霓虹了。 */
const C_FLESH = lin(0x7d2b22)
const C_WOOD = lin(0x8d7154)
const C_STONE = lin(0x8f959c)
const C_METAL = lin(0xd99a4a)
const C_MUD = lin(0x746349)
/** 死亡爆散的墨：与描边同色（0x14100c），尸体等于"化进"自己的轮廓线。 */
const C_INK = lin(0x14100c)
/** 掺进墨点的一点血：纯黑墨点在暗场里读不出是活物还是木头。 */
const C_GORE = lin(0x4a1712)
/** 地面血泊压印：比飞溅更暗，否则在泥地上像一摊红油漆。 */
const C_POOL = lin(0x5a1e18)
/** 硝烟：近枪口偏暖、飘远偏冷 —— 跟着"灯火橙 + 冷月光"的整体色温走。 */
const C_SMOKE_WARM = lin(0xb9ab97)
const C_SMOKE_COOL = lin(0x8d969b)

interface KindSpec {
  readonly rgb: readonly [number, number, number]
  readonly countMin: number
  readonly countMax: number
  /** 出射锥半角（弧度），锥轴是背溅方向 -dir。 */
  readonly cone: number
  readonly speedMin: number
  readonly speedMax: number
  /** 单粒子寿命（秒），契约要求整段落在 0.25~0.6。 */
  readonly lifeMin: number
  readonly lifeMax: number
  /** 短轴尺寸（米）。 */
  readonly sizeMin: number
  readonly sizeMax: number
  /** 沿速度方向额外拉长的系数（每 m/s）：甩出去的墨迹。 */
  readonly stretch: number
  readonly phys: number
  /** 炽热尾量 0..1：金属火星冷却时仍挂一点橙。 */
  readonly hot: number
}

/**
 * 五种材质的"手感"参数。
 *
 * 差异必须能被眼睛读出来，否则换 kind 只是换颜色：石头崩得最散（锥半角 1.25 rad ≈ 72°）
 * 且寿命最短（成粉末），木头顺着背溅方向成束（0.85 rad ≈ 49°），泥最黏、飞得最低最慢，
 * 金属最快最远且带炽热尾声，血肉介于其间但碎片最大（血是"糊"上去的，不是"溅"）。
 */
const KINDS: readonly KindSpec[] = [
  // flesh
  { rgb: C_FLESH, countMin: 5, countMax: 8, cone: 1.05, speedMin: 2.2, speedMax: 6.2,
    lifeMin: 0.34, lifeMax: 0.58, sizeMin: 0.10, sizeMax: 0.22, stretch: 0.40, phys: PHYS_FLECK, hot: 0 },
  // wood
  { rgb: C_WOOD, countMin: 5, countMax: 7, cone: 0.85, speedMin: 3.0, speedMax: 7.4,
    lifeMin: 0.28, lifeMax: 0.44, sizeMin: 0.07, sizeMax: 0.16, stretch: 0.46, phys: PHYS_FLECK, hot: 0 },
  // stone
  { rgb: C_STONE, countMin: 6, countMax: 9, cone: 1.25, speedMin: 4.2, speedMax: 9.0,
    lifeMin: 0.25, lifeMax: 0.32, sizeMin: 0.07, sizeMax: 0.15, stretch: 0.32, phys: PHYS_FLECK, hot: 0 },
  // metal
  { rgb: C_METAL, countMin: 5, countMax: 8, cone: 0.95, speedMin: 5.0, speedMax: 10.5,
    lifeMin: 0.32, lifeMax: 0.52, sizeMin: 0.05, sizeMax: 0.11, stretch: 0.52, phys: PHYS_SPARK, hot: 1 },
  // mud
  { rgb: C_MUD, countMin: 4, countMax: 6, cone: 0.75, speedMin: 1.6, speedMax: 4.4,
    lifeMin: 0.40, lifeMax: 0.60, sizeMin: 0.10, sizeMax: 0.22, stretch: 0.42, phys: PHYS_FLECK, hot: 0 },
]

const KIND_INDEX: Record<ImpactKind, number> = { flesh: 0, wood: 1, stone: 2, metal: 3, mud: 4 }

/**
 * 模块级 scratch：锥基（t1 / t2）。
 *
 * 放在模块作用域而不是闭包里，是因为 spawn 路径要严格零分配；三个 spawn 接口都是
 * 同步调用，不存在重入。代价是它不是线程安全的 —— 这个包本来就只在主线程跑。
 */
const BASIS = new Float32Array(6)

/**
 * 写一组与 (x,y,z) 正交的基到 BASIS。
 * 参考轴按 |z| 挑，否则轴竖直时第一次叉积退化成零向量，整锥粒子会挤成一条线。
 */
function orthoBasis(x: number, y: number, z: number): void {
  const useX = Math.abs(z) > 0.9
  const rx = useX ? 1 : 0
  const rz = useX ? 0 : 1
  let t1x = -rz * y
  let t1y = rz * x - rx * z
  let t1z = rx * y
  const l = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z)
  if (l > 1e-6) {
    const inv = 1 / l
    t1x *= inv
    t1y *= inv
    t1z *= inv
  } else {
    t1x = 1
    t1y = 0
    t1z = 0
  }
  BASIS[0] = t1x
  BASIS[1] = t1y
  BASIS[2] = t1z
  BASIS[3] = y * t1z - z * t1y
  BASIS[4] = z * t1x - x * t1z
  BASIS[5] = x * t1y - y * t1x
}

/** 平滑阶跃。用它而不是线性插值：笔触的起收要"停一下"，线性淡出像接到指令就蒸发。 */
function sm(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

// ---------------------------------------------------------------- 着色器

/**
 * 顶点着色器。
 *
 * instanceMatrix 的槽位布局（浮点下标 → GLSL 访问式）：
 *   0,1,2    → instanceMatrix[0].xyz  沿当前速度的单位方向（长轴）
 *   3        → instanceMatrix[0].w    长轴全长（世界米）
 *   4        → instanceMatrix[1].x    短轴全长
 *   5        → instanceMatrix[1].y    形状码
 *   6        → instanceMatrix[1].z    每实例随机种子
 *   7        → instanceMatrix[1].w    透明度
 *   8        → instanceMatrix[2].x    炽热值
 *   12,13,14 → instanceMatrix[3].xyz  中心世界坐标
 * 其余位不用。实例矩阵自身的旋转/缩放没有意义（billboard 是现场算的），这正是能把
 * 这 16 个 float 挪作他用的前提。
 *
 * 注意：instanceMatrix / instanceColor 两个 attribute 由 three 的前缀按 define 声明，
 * 这里绝不能再写一遍 attribute，重复声明会直接编译失败。
 */
const VERTEX_SHADER = [
  'varying vec2 vUv;',
  'varying vec3 vColor;',
  'varying float vFade;',
  'varying float vSeed;',
  'varying float vShape;',
  'varying float vHot;',
  'void main() {',
  '  vUv = uv;',
  '  vColor = instanceColor;',
  '  vShape = instanceMatrix[1].y;',
  '  vSeed = instanceMatrix[1].z;',
  '  vFade = instanceMatrix[1].w;',
  '  vHot = instanceMatrix[2].x;',
  '  vec3 ctr = instanceMatrix[3].xyz;',
  '  float lenU = instanceMatrix[0].w;',
  '  float lenW = instanceMatrix[1].x;',
  '  vec3 dirW = instanceMatrix[0].xyz;',
  '  vec3 world;',
  '  if (vShape > 2.5) {',
  '    // 地面压印必须平躺在 XZ 上。若用面向相机的 billboard，玩家一低头血泊就立起来。',
  '    world = ctr + vec3(position.x * lenU, 0.0, position.y * lenW);',
  '  } else {',
  '    vec3 toCam = cameraPosition - ctr;',
  '    float d = length(toCam);',
  '    toCam = d > 1e-4 ? toCam * (1.0 / d) : vec3(0.0, 0.0, 1.0);',
  '    vec3 right = cross(vec3(0.0, 1.0, 0.0), toCam);',
  '    // 从正上方或正下方看时世界 up 会让叉积塌掉，退回 X 轴，避免整片特效消失。',
  '    if (dot(right, right) < 1e-4) right = vec3(1.0, 0.0, 0.0);',
  '    right = normalize(right);',
  '    vec3 up = cross(toCam, right);',
  '    // 把速度轴投影到屏幕平面：笔触走向跟着相机转，而不是跟着相机翻面。',
  '    vec2 ds = vec2(dot(dirW, right), dot(dirW, up));',
  '    float dl = length(ds);',
  '    vec2 ax = dl > 1e-3 ? ds * (1.0 / dl) : vec2(1.0, 0.0);',
  '    vec2 ay = vec2(-ax.y, ax.x);',
  '    vec2 q = ax * (position.x * lenU) + ay * (position.y * lenW);',
  '    world = ctr + right * q.x + up * q.y;',
  '  }',
  '  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);',
  '}',
].join('\n')

/**
 * 片元着色器。
 *
 * 四套形状共用一份程序，按 vShape 分支（每实例常量，分支预测友好）。共同点是硬边：
 * 边界用 1~2 像素宽的 smoothstep 收口，而不是高斯衰减。
 */
const FRAGMENT_SHADER = [
  'uniform float uTime;',
  'varying vec2 vUv;',
  'varying vec3 vColor;',
  'varying float vFade;',
  'varying float vSeed;',
  'varying float vShape;',
  'varying float vHot;',
  '',
  'float vfxHash(float n) {',
  '  return fract(sin(n * 127.1 + 311.7) * 43758.5453123);',
  '}',
  '',
  '// 团块的半径沿角度取 4 个随机半径并做平滑插值：轮廓是不规则的，但每段之间连续。',
  '// 早先按角度量化成台阶（直接取整）会得出一圈齿轮齿 —— 那是几何图形，不是笔画的团块。',
  'float vfxBlob(vec2 p, float seed, float squash) {',
  '  float r = length(p * vec2(1.0, squash));',
  '  float ang = atan(p.y, p.x);',
  '  float a = ang * 1.7 + seed * 7.0;',
  '  float c0 = floor(a);',
  '  float f = fract(a);',
  '  float r0 = vfxHash(c0 * 5.1 + seed * 3.0);',
  '  float r1 = vfxHash((c0 + 1.0) * 5.1 + seed * 3.0);',
  '  float wob = 0.40 + 0.34 * mix(r0, r1, smoothstep(0.0, 1.0, f));',
  '  // 第二层细齿：只缩半径、不切扇区。切扇区会留下两条笔直的径向边，读成方角；',
  '  // 凹口才是被笔头戳掉一块的样子。两层用互质的角频率，避免叠成均匀的锯齿边',
  '  // （等间距同深度的齿会把墨团修成一朵花）。',
  '  float fineA = vfxHash(floor(ang * 5.0 + seed * 21.0) * 3.3 + seed);',
  '  float fineB = vfxHash(floor(ang * 13.0 - seed * 11.0) * 7.1 + seed);',
  '  wob *= 1.0 - 0.22 * step(0.62, fineA) - 0.11 * step(0.74, fineB);',
  '  return smoothstep(-0.03, 0.03, wob - r);',
  '}',
  '',
  '// 一笔笔触：中线带弓弧、腹部最胖、两端收尖、边界被啃过、偶尔干笔断墨。',
  'float vfxStroke(vec2 p, float seed, out float tone) {',
  '  float bend = (seed - 0.5) * 1.35;',
  '  float centre = bend * (p.x * p.x - 0.3);',
  '  float across = p.y - centre;',
  '  float belly = 1.0 - p.x * p.x;',
  // 两端必须收到尖：四边形边界会把笔触切出一截平头，读起来像贴图而不是笔尖。
  '  float taper = smoothstep(1.0, 0.58, abs(p.x));',
  '  float halfW = (0.05 + 0.30 * belly) * taper;',
  '  float d = (halfW - abs(across)) * 1.5;',
  '  float edge = smoothstep(-0.016, 0.016, d);',
  '  float chewCell = floor(p.x * 7.0 + seed * 13.0);',
  '  edge *= smoothstep(-0.016, 0.016, d + (vfxHash(chewCell * 3.1) - 0.5) * 0.07);',
  '  float dryCell = floor(p.x * 5.0 + seed * 29.0);',
  '  edge *= step(0.14, vfxHash(dryCell * 7.7));',
  '  // 墨在边缘积成暗边、中间最亮 —— 这就是无主之地那种封边的读法。',
  '  tone = mix(0.58, 1.0, smoothstep(0.0, 0.075, d));',
  '  tone *= 1.0 + 0.30 * step(0.74, vfxHash(floor(p.x * 3.0 + seed * 41.0)))',
  '    * smoothstep(0.45, 0.0, abs(across));',
  '  return edge;',
  '}',
  '',
  'void main() {',
  '  vec2 p = vUv * 2.0 - 1.0;',
  '  // 一拍二抖动：整张纸每秒重抖 12 次，与 outline.ts 的 boil 同一个节奏。',
  '  // 每粒子各自跳变会读成电视雪花，共用低频时钟才像被重画了一遍。',
  '  float seed = vSeed + floor(uTime * 12.0) * 0.019;',
  '  float mask = 0.0;',
  '  float tone = 1.0;',
  '  if (vShape > 2.5) {',
  '    float r = length(p * vec2(1.0, 1.15));',
  '    float ang = atan(p.y, p.x);',
  '    float jetCoord = ang * 1.27 + seed * 3.0;',
  '    float sector = floor(jetCoord);',
  '    float jet = step(0.55, vfxHash(sector * 4.3 + seed * 17.0))',
  '      * step(abs(fract(jetCoord) - 0.5), 0.13)',
  '      * smoothstep(0.95, 0.12, r);',
  '    float core = vfxBlob(p, seed, 1.15);',
  '    mask = max(core, jet * 0.85);',
  '    tone = mix(0.50, 1.0, core);',
  '  } else if (vShape > 1.5) {',
  '    mask = vfxBlob(p, seed, 1.10);',
  '    tone = mix(0.46, 1.0, mask);',
  '  } else if (vShape > 0.5) {',
  '    // 硝烟：主体团块 + 两笔横向干刷。纯团块在画面里读成一坨棉花，',
  '    // 加干刷才有“枪口甩出去的一团烟”的方向感。',
  '    float body = vfxBlob(p * vec2(0.92, 1.06), seed, 1.35);',
  '    float w1 = vfxStroke(p * vec2(0.86, 1.9) + vec2(0.0, 0.10), seed + 0.37, tone);',
  '    float w2 = vfxStroke(p * vec2(0.72, 2.6) - vec2(0.06, 0.26), seed + 0.71, tone);',
  '    mask = max(body, max(w1, w2) * 0.72) * 0.95;',
  '    tone *= mix(0.74, 1.0, body);',
  '  } else {',
  '    mask = vfxStroke(p, seed, tone);',
  '  }',
  '  if (mask < 0.004) discard;',
  '  vec3 col = vColor * tone;',
  '  col = mix(col, col * 1.7 + vec3(0.45, 0.20, 0.04), vHot);',
  '  gl_FragColor = vec4(col, mask * vFade);',
  '  // 必须手动做线性→sRGB：ShaderMaterial 不会自动补这一步，而 lin() 已经把十六进制',
  '  // 当 sRGB 转成线性了。少了这行，暗部的血红会被直接上屏压成近黑。',
  '  #include <colorspace_fragment>',
  '}',
].join('\n')

// ---------------------------------------------------------------- 粒子存储

/**
 * 每颗粒子的字段偏移。
 *
 * 用一组等长 Float32Array 做 SoA 而不是对象数组：稳态下 update 只碰数字，没有属性
 * 查找，也不会给 GC 制造任何可回收物。capacity 在构造期定死，之后永不扩容 —— 扩容
 * 就是 realloc，也就是那一帧必定掉帧。
 */
const P_X = 0
const P_Y = 1
const P_Z = 2
const P_VX = 3
const P_VY = 4
const P_VZ = 5
const P_AX = 6
const P_AY = 7
const P_AZ = 8
const P_BASE = 9
const P_GROW = 10
const P_STRETCH = 11
const P_SHAPE = 12
const P_SEED = 13
const P_HOT = 14
const P_ALPHA = 15
const P_HOLD = 16
const P_PHYS = 17
const P_AGE = 18
const P_LIFE = 19
const P_CR = 20
const P_CG = 21
const P_CB = 22
/** 每颗粒子占的 float 数。加字段时只改这里，上面的偏移量按需追加。 */
const STRIDE = 23

/**
 * 出生参数暂存。
 *
 * 做成模块级单例而不是每次 spawn 一个对象字面量，是为了让 impact/burst/muzzle 在
 * 严格意义上零分配（连一个短命对象都不产生）。三个接口都是同步的，不存在交错写。
 */
const SP = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  base: 0.1, grow: 1, stretch: 0,
  shape: SHAPE_FLICK, hot: 0,
  alpha: 1, hold: 0, phys: PHYS_FLECK,
  life: 0.4,
  r: 1, g: 1, b: 1,
}

// ---------------------------------------------------------------- 工厂

export function createVfx(scene: Scene, options?: VfxOptions): Vfx {
  const maxEffects = Math.max(1, Math.floor(options?.maxEffects ?? DEFAULT_MAX_EFFECTS))
  const capacity = maxEffects * MAX_PER_EFFECT

  // 所有缓冲在这里一次性分配完，之后每次 spawn 只是往里面写数字。
  const data = new Float32Array(capacity * STRIDE)
  const geo = new PlaneGeometry(1, 1)
  const mat = new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    // 特效是最后画上去的一层墨，不写深度；写了会让后画的碎片被先画的碎片挡掉，
    // 笔触之间出现生硬的矩形缺口。
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    // 绝不用加法混合：加法会把暗色墨点变成光斑，直接跑偏成通用 FPS 特效。
    blending: NormalBlending,
    fog: false,
  })
  const mesh = new InstancedMesh(geo, mat, capacity)
  // 实例矩阵里存的不是真变换（见 VERTEX_SHADER），包围球算出来没有意义。
  // 不关剔除的话，镜头一转整团特效就会被判成在视锥外，集体消失。
  mesh.frustumCulled = false
  mesh.renderOrder = 8
  mesh.count = 0
  mesh.visible = false
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)

  const colors = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  colors.setUsage(DynamicDrawUsage)
  mesh.instanceColor = colors
  // 自持数组引用：update 直接写它，绕开 setColorAt（那个要传 Color 对象）。
  const colorArray = colors.array as Float32Array
  const matrixArray = mesh.instanceMatrix.array as Float32Array

  const root = new Group()
  root.matrixAutoUpdate = false
  root.add(mesh)
  scene.add(root)

  // 一次播种，整场游戏共用这条序列：同一串射击永远产出同一串碎屑，回放才对得上。
  const rnd = mulberry32(VFX_SEED)
  let uTime = 0
  /** 下一个要分配的特效槽。环形推进，走到头就自然覆盖最老的那批。 */
  let nextSlot = 0
  let disposed = false

  /** 取一个特效槽，并清空其名下的所有粒子（清 P_LIFE 就够了，update 认这个）。 */
  function takeSlot(): number {
    const slot = nextSlot
    nextSlot = nextSlot + 1 >= maxEffects ? 0 : nextSlot + 1
    const base = slot * MAX_PER_EFFECT
    const end = base + MAX_PER_EFFECT
    for (let i = base; i < end; i++) data[i * STRIDE + P_LIFE] = 0
    return base
  }

  /** 把 SP 写进第 idx 颗粒子。纯数字搬运。 */
  function commit(idx: number): void {
    const o = idx * STRIDE
    data[o + P_X] = SP.x
    data[o + P_Y] = SP.y
    data[o + P_Z] = SP.z
    data[o + P_VX] = SP.vx
    data[o + P_VY] = SP.vy
    data[o + P_VZ] = SP.vz
    data[o + P_AX] = SP.vx
    data[o + P_AY] = SP.vy
    data[o + P_AZ] = SP.vz
    data[o + P_BASE] = SP.base
    data[o + P_GROW] = SP.grow
    data[o + P_STRETCH] = SP.stretch
    data[o + P_SHAPE] = SP.shape
    data[o + P_SEED] = rnd()
    data[o + P_HOT] = SP.hot
    data[o + P_ALPHA] = SP.alpha
    data[o + P_HOLD] = SP.hold
    data[o + P_PHYS] = SP.phys
    data[o + P_AGE] = 0
    data[o + P_LIFE] = SP.life
    data[o + P_CR] = SP.r
    data[o + P_CG] = SP.g
    data[o + P_CB] = SP.b
  }

  // ------------------------------------------------------------ impact

  function impact(point: Vec3, dir: Vec3, kind: ImpactKind): void {
    if (disposed) return
    const spec = KINDS[KIND_INDEX[kind]]
    if (spec === undefined) return

    // 背溅方向 = 子弹来向的反面。dir 没归一化也照样能用，这里统一收一次。
    let dx = dir.x
    let dy = dir.y
    let dz = dir.z
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dl > 1e-6) {
      dx /= dl
      dy /= dl
      dz /= dl
    } else {
      dx = 0
      dy = 1
      dz = 0
    }

    const count = spec.countMin + Math.floor(rnd() * (spec.countMax - spec.countMin + 1))
    const slotBase = takeSlot()
    const cosCone = Math.cos(spec.cone)
    orthoBasis(-dx, -dy, -dz)
    const t1x = BASIS[0]
    const t1y = BASIS[1]
    const t1z = BASIS[2]
    const t2x = BASIS[3]
    const t2y = BASIS[4]
    const t2z = BASIS[5]

    for (let k = 0; k < count; k++) {
      // 四分之一走顺溅：子弹带着碎屑继续往前甩。全是背溅会像撒爆米花。
      const forward = rnd() < 0.25
      const axx = forward ? dx : -dx
      const axy = forward ? dy : -dy
      const axz = forward ? dz : -dz
      const ct = 1 - rnd() * (1 - cosCone)
      const st = Math.sqrt(Math.max(0, 1 - ct * ct))
      const phi = rnd() * TAU
      const cp = Math.cos(phi)
      const sp = Math.sin(phi)
      const nx = axx * ct + (t1x * cp + t2x * sp) * st
      const ny = axy * ct + (t1y * cp + t2y * sp) * st
      const nz = axz * ct + (t1z * cp + t2z * sp) * st
      const speed = spec.speedMin + rnd() * (spec.speedMax - spec.speedMin)

      SP.base = spec.sizeMin + rnd() * (spec.sizeMax - spec.sizeMin)
      // 生在表面外一点，否则笔画中心被命中面切掉一半，看起来像一张贴纸。
      const off = SP.base * 0.45
      SP.x = point.x + nx * off
      SP.y = point.y + ny * off
      SP.z = point.z + nz * off
      SP.vx = nx * speed
      SP.vy = ny * speed
      SP.vz = nz * speed
      SP.grow = 1
      SP.stretch = spec.stretch
      SP.shape = SHAPE_FLICK
      SP.hot = spec.hot
      SP.alpha = 1
      SP.hold = 0
      SP.phys = spec.phys
      SP.life = spec.lifeMin + rnd() * (spec.lifeMax - spec.lifeMin)
      // 逐片微调明度：完全同色的一撮碎片会读成一个色块。
      const tint = 0.82 + rnd() * 0.36
      SP.r = spec.rgb[0] * tint
      SP.g = spec.rgb[1] * tint
      SP.b = spec.rgb[2] * tint
      commit(slotBase + k)
    }
  }

  // ------------------------------------------------------------ burst

  function burst(point: Vec3, scale: number): void {
    if (disposed) return
    const s = scale > 0.01 ? scale : 0.01
    const count = 8 + Math.floor(rnd() * 5) // 8..12
    const slotBase = takeSlot()
    const spread = Math.sqrt(s)

    for (let k = 0; k < count; k++) {
      // 球面上偏上的一撮：死亡墨爆要有往上泼的重力感，纯球面均匀分布像礼花。
      const ny = 0.15 + rnd() * 0.85
      const phi = rnd() * TAU
      const rxz = Math.sqrt(Math.max(0, 1 - ny * ny))
      const nx = Math.cos(phi) * rxz
      const nz = Math.sin(phi) * rxz
      const speed = (2.4 + rnd() * 3.1) * spread
      SP.base = (0.14 + rnd() * 0.16) * s
      SP.x = point.x + nx * SP.base * 0.6
      SP.y = point.y + ny * SP.base * 0.6
      SP.z = point.z + nz * SP.base * 0.6
      SP.vx = nx * speed
      SP.vy = ny * speed
      SP.vz = nz * speed
      SP.grow = 1
      SP.stretch = 0.34
      SP.shape = SHAPE_BLOT
      SP.hot = 0
      SP.alpha = 0.94
      SP.hold = 0.12
      SP.phys = PHYS_INK
      SP.life = 0.45 + rnd() * 0.15
      // 三分之一的墨块掺血：全黑在暗场里读不出是活物，全红又像喷漆罐。
      const src = rnd() < 0.34 ? C_GORE : C_INK
      const tint = 0.85 + rnd() * 0.3
      SP.r = src[0] * tint
      SP.g = src[1] * tint
      SP.b = src[2] * tint
      commit(slotBase + k)
    }

    // 地面压印：同一个 InstancedMesh，靠 vShape == SHAPE_POOL 在顶点里改成平躺
    // （只吃 XZ），于是才能用"极扁的 instanceMatrix"这一套混进来而不必另开一个 mesh。
    const pool = slotBase + count
    SP.x = point.x
    SP.y = GROUND_Y
    SP.z = point.z
    SP.vx = 0
    SP.vy = 0
    SP.vz = 0
    SP.base = (0.55 + rnd() * 0.35) * s
    SP.grow = 1.12
    SP.stretch = 0
    SP.shape = SHAPE_POOL
    SP.hot = 0
    SP.alpha = 0.78
    // 0.40s 的静止停留，剩下 0.20s 收掉。停留就是"这具尸体刚倒下"的读秒。
    SP.hold = 0.66
    SP.phys = PHYS_POOL
    SP.life = 0.6
    const tint = 0.88 + rnd() * 0.24
    SP.r = C_POOL[0] * tint
    SP.g = C_POOL[1] * tint
    SP.b = C_POOL[2] * tint
    commit(pool)
  }

  // ------------------------------------------------------------ shockwave

  /**
   * 范围脉冲：12 颗尘土从圆心向外扫成一张慢慢变大的环。
   *
   * 不另开一个 RingGeometry：粒子系统本来就有池子、有淡出、有物理积分，
   * 复用它的代价是 12 个 slot，而新建一套网格要额外管生命周期、透明排序与 dispose。
   */
  function shockwave(point: Vec3, radius: number): void {
    if (disposed) return
    const r = Math.max(0.5, radius)
    const count = 12
    const slotBase = takeSlot()
    for (let k = 0; k < count; k++) {
      const angle = (k / count) * TAU
      const nx = Math.cos(angle)
      const nz = Math.sin(angle)
      const speed = r * 3.1
      SP.base = 0.22 + r * 0.035
      SP.x = point.x + nx * r * 0.28
      SP.y = point.y + 0.16
      SP.z = point.z + nz * r * 0.28
      SP.vx = nx * speed
      SP.vy = 0.8 + r * 0.06
      SP.vz = nz * speed
      SP.grow = 0.55
      SP.stretch = 0.8
      SP.shape = SHAPE_FLICK
      SP.hot = 0
      SP.alpha = 0.72
      SP.hold = 0.04
      SP.phys = PHYS_FLECK
      SP.life = 0.38 + r * 0.015
      const tint = 0.8 + rnd() * 0.35
      SP.r = C_STONE[0] * tint
      SP.g = C_STONE[1] * tint
      SP.b = C_STONE[2] * tint
      commit(slotBase + k)
    }
  }

  // ------------------------------------------------------------ muzzle

  function muzzle(eye: Vec3, dir: Vec3, ads: boolean): void {
    if (disposed) return
    let dx = dir.x
    let dy = dir.y
    let dz = dir.z
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dl > 1e-6) {
      dx /= dl
      dy /= dl
      dz /= dl
    } else {
      dx = 0
      dy = 0
      dz = -1
    }

    // 开镜时硝烟会直接糊在准星上，是最劝退的画面：减半，并往枪线收窄。
    const count = ads ? 2 : 3 + Math.floor(rnd() * 3) // 常态 3..5
    const spread = ads ? 0.16 : 0.42
    const slotBase = takeSlot()
    orthoBasis(dx, dy, dz)
    const t1x = BASIS[0]
    const t1y = BASIS[1]
    const t1z = BASIS[2]
    const t2x = BASIS[3]
    const t2y = BASIS[4]
    const t2z = BASIS[5]

    for (let k = 0; k < count; k++) {
      // eye 前方 0.6m 是枪口的大致位置。
      const along = 0.6 + rnd() * 0.12
      const lat = (rnd() - 0.5) * spread
      const vert = (rnd() - 0.5) * spread
      SP.x = eye.x + dx * along + t1x * lat + t2x * vert
      SP.y = eye.y + dy * along + t1y * lat + t2y * vert
      SP.z = eye.z + dz * along + t1z * lat + t2z * vert
      // 沿枪线漂出去再带一点上升：热烟不走直线。
      const drift = 0.9 + rnd() * 1.3
      SP.vx = dx * drift + t1x * (rnd() - 0.5) * 0.5
      SP.vy = dy * drift + 0.35 + rnd() * 0.4
      SP.vz = dz * drift + t1z * (rnd() - 0.5) * 0.5
      SP.base = 0.10 + rnd() * 0.08
      // 快速膨胀：硝烟的可读信号是体积在涨，不是颜色在变。
      // 膨胀上限卡在 2.6 倍左右：0.6m 处再大就直接糊满整个屏幕，比不画还糟。
      SP.grow = ads ? 1.9 + rnd() * 0.5 : 2.3 + rnd() * 0.7
      SP.stretch = 0
      SP.shape = SHAPE_WISP
      SP.hot = 0
      // 开镜时更淡，避免挡住目标。
      SP.alpha = ads ? 0.30 : 0.44
      SP.hold = 0
      SP.phys = PHYS_SMOKE
      SP.life = 0.30 + rnd() * 0.15
      const w = rnd()
      SP.r = C_SMOKE_WARM[0] + (C_SMOKE_COOL[0] - C_SMOKE_WARM[0]) * w
      SP.g = C_SMOKE_WARM[1] + (C_SMOKE_COOL[1] - C_SMOKE_WARM[1]) * w
      SP.b = C_SMOKE_WARM[2] + (C_SMOKE_COOL[2] - C_SMOKE_WARM[2]) * w
      commit(slotBase + k)
    }
  }

  // ------------------------------------------------------------ update

  function update(dt: number): void {
    if (disposed) return
    if (!(dt > 0)) return
    // 卡帧时 dt 可能是半秒。不夹住的话碎屑会一步穿过地面再被拉回来，看着像瞬移。
    const step = dt > 0.1 ? 0.1 : dt
    uTime += step
    mat.uniforms.uTime.value = uTime

    let out = 0
    for (let i = 0; i < capacity; i++) {
      const o = i * STRIDE
      const life = data[o + P_LIFE]
      if (life <= 0) continue
      const age = data[o + P_AGE] + step
      if (age >= life) {
        // 死亡只清 P_LIFE：它是 update 的唯一存活判据，也是 takeSlot 的唯一复位点。
        data[o + P_LIFE] = 0
        continue
      }
      data[o + P_AGE] = age

      const ph = data[o + P_PHYS]
      const damp = 1 / (1 + DRAG[ph] * step)
      let vx = data[o + P_VX] * damp
      let vy = (data[o + P_VY] - GRAVITY[ph] * step) * damp
      let vz = data[o + P_VZ] * damp

      let px = data[o + P_X] + vx * step
      let py = data[o + P_Y] + vy * step
      let pz = data[o + P_Z] + vz * step

      if (ph < PHYS_SMOKE && py < GROUND_Y) {
        // 落地就地蹭住：弹跳会让硬边笔触在空中翻跟头，读起来像贴图穿模。
        // 摩擦力只在真正触地的那一帧吃一次（vy < 0 表示还没蹭住）。逐帧乘系数会把
        // 速度磨成零，笔触的拉长量 lenL 跟着速度走，于是落地的碎屑全退化成圆疙瘩。
        // 判据必须是「砸下来」而不是「朝下」：贴地后重力每帧还会把 vy 拉成小负数，
        // 用 vy < 0 会逐帧连乘摩擦，把速度磨没、笔触退化成圆疙瘩。
        if (vy < -0.6) {
          vx *= 0.45
          vz *= 0.45
        }
        py = GROUND_Y
        vy = 0
      }

      data[o + P_X] = px
      data[o + P_Y] = py
      data[o + P_Z] = pz
      data[o + P_VX] = vx
      data[o + P_VY] = vy
      data[o + P_VZ] = vz

      const t = age / life
      // 硝烟与墨点靠膨胀吃掉淡出；碎屑靠位移与缩短。
      const growF = 1 + (data[o + P_GROW] - 1) * t
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz)
      let ax = data[o + P_AX]
      let ay = data[o + P_AY]
      let az = data[o + P_AZ]
      if (sp > 0.08) {
        const inv = 1 / sp
        ax = vx * inv
        ay = vy * inv
        az = vz * inv
        data[o + P_AX] = ax
        data[o + P_AY] = ay
        data[o + P_AZ] = az
      }
      // 拉长跟着当前速度走，粒子减速时墨迹会自己收回去。固定拉长会变成一根
      // 越飞越不合物理的面条。
      const lenW = data[o + P_BASE] * growF
      const lenL = lenW * (1 + sp * data[o + P_STRETCH])

      const hold = data[o + P_HOLD]
      const fadeOut = 1 - sm((t - hold) / (1 - hold))
      const fadeIn = t < 0.08 ? sm(t / 0.08) : 1
      // 火星的炽热值随年龄升到顶：冷却的金属是"越烧越红"才收，不是一出生最亮。
      const hot = data[o + P_HOT] * (0.55 + 0.45 * t)

      const m = out * 16
      matrixArray[m] = ax
      matrixArray[m + 1] = ay
      matrixArray[m + 2] = az
      matrixArray[m + 3] = lenL
      matrixArray[m + 4] = lenW
      matrixArray[m + 5] = data[o + P_SHAPE]
      matrixArray[m + 6] = data[o + P_SEED]
      matrixArray[m + 7] = data[o + P_ALPHA] * fadeOut * fadeIn
      matrixArray[m + 8] = hot
      matrixArray[m + 12] = px
      matrixArray[m + 13] = py
      matrixArray[m + 14] = pz

      const c = out * 3
      colorArray[c] = data[o + P_CR]
      colorArray[c + 1] = data[o + P_CG]
      colorArray[c + 2] = data[o + P_CB]

      out++
    }

    mesh.count = out
    mesh.visible = out > 0
    if (out > 0) {
      mesh.instanceMatrix.needsUpdate = true
      colors.needsUpdate = true
    }
  }

  // ------------------------------------------------------------ dispose

  function dispose(): void {
    if (disposed) return
    disposed = true
    // root 是自己挂上去的，也要自己摘：调用方只会丢掉 Vfx 引用，不会再去动 scene。
    scene.remove(root)
    root.remove(mesh)
    // InstancedMesh.dispose() 会顺手把 instanceMatrix / instanceColor 的 GPU 绑定从
    // WebGLAttributes 里摘掉；少了它，这两块缓冲会跟着上下文泄漏。
    mesh.dispose()
    geo.dispose()
    mat.dispose()
    mesh.count = 0
    mesh.visible = false
  }

  return {
    impact,
    burst,
    shockwave,
    muzzle,
    update,
    dispose,
    get root(): Object3D {
      return root
    },
  }
}


