/**
 * 目标点世界空间标记：谜样线索（clue）/ 燃烧的血巢（lair）/ 撤离点（extract）。
 *
 * ## 这个文件为什么存在
 *
 * 在这之前，80×80m 的沼泽里那三个半径 3.2m 的线索圈在画面上**一个像素都没有**：
 * 玩家只有 HUD 上的一个数字，等于被要求在一片雾里摸到三个看不见的点。可见性
 * 是玩法的一部分，不是装饰 —— 所以这里给每个目标一套"隔 40m 也认得出"的记号。
 *
 * ## 为什么线索常驻可见，撤离线却只在站进去时才显现
 *
 * 这两者是**不同性质**的信息：
 * - 线索是**导航目标**。玩家一进场不知道自己该往哪走，HUD 只会说"0/3"，这时候
 *   必须有一个远距离可读的方向锚点，否则开局就是原地转圈。所以线索的光柱永远亮着
 *   （只隐藏已收集的），相当于"下一步往这走"。
 * - 撤离点是**情报优势**。把它常驻标出来，等于免费告诉所有人："拿着赏金的人只能
 *   从这三个点跑，去三个点蹲着收人头就行"。全图三条撤离线常驻可见会把追逐战直接
 *   退化成守株待兔 —— 所以撤离标记**只有本机玩家站进去（extractIndex >= 0）时**
 *   才出现。这既是"你确实到地方了"的确认，又不泄露位置。反过来玩家若站在别的
 *   队伍要撤离的点上，他看到的依然是自己脚下的圈：信息约束对每个人独立生效。
 *
 * ## 为什么光柱不用 toon 材质
 *
 * 光柱是**光**，不是物体。MeshToonMaterial 会把它当不透明表面处理：受光方向一偏
 * 就成了半明半暗的柱子，深度写入还会把它后面的火星和地面环剔掉，看起来像一根塑料
 * 管插在地上。它要的是"加色叠加 + 不写深度 + 不受雾影响"——这三条全是
 * ShaderMaterial 的原生能力，toon 里一条都做不出来（雾会被强制乘上去，光柱在
 * fogDensity 0.019 的雾里 25m 外就糊没了，等于没做）。
 *
 * 而真正**实体**的部分（线索桩、血巢骨桩）反而必须是 toon：它们要读成"世界里的
 * 东西"，跟农舍木头、芦苇是同一套卡通分级；少这一层，标记就会从画面里"浮"出来。
 * 它们走 applyComicInk（hatch 关掉：几厘米粗的杆子上做屏幕空间排线只会变成噪点）
 * 再加一圈 BackSide 墨线壳，与 props.ts 的树、render.ts 的木箱完全同一套做法。
 *
 * ## 为什么隐藏用 visible / count 压缩，而不是把 mesh 从场景里移走
 *
 * add/remove 会进 Object3D 的 children 数组重排，并让渲染器重算渲染列表；更糟的是
 * 材质第一次进渲染列表时才编译 program，那一次卡顿正好发生在"血巢刚被揭示"这种
 * 全场都盯着画面的一瞬间。所以所有网格**常驻场景**，只切换两样东西：
 *   - mesh.visible（这一类标记一个实例都没有时直接整只不画）；
 *   - mesh.count（InstancedMesh 的实例数；three 在 primcount === 0 时直接 return，
 *     零实例 = 零 draw call）。
 * 血巢未揭示时它的光柱实例、地面焦痕环实例、火星实例、骨桩实例根本不会被写出，
 * 于是"连根节点都不要有可见物"是字面成立的，而着色器早就热好了。
 *
 * ## 性能（这条是硬约束，不是建议）
 *
 * draw call 上限 8，实际 **6**：
 *   1. beams     线索光柱 + 血巢光柱（一个 InstancedMesh，逐实例 aFill/aAlpha/aTint）
 *   2. rings     线索立足环/收束环 + 焦痕环 + 撤离环（同上）
 *   3. particles 血巢火星 + 撤离烟气（原地 billboard，退化成一个 InstancedMesh）
 *   4. glow      赏金携带者身上那团琥珀光（单 quad billboard）
 *   5. anchors   线索桩 / 血巢骨桩（toon 实体）
 *   6. ink       上面那批实体的墨线壳（共用同一份实例矩阵）
 * 填充率也按核显调过：柱底半径 0.9m、顶 2.6m（不是那种半径 3m 的大灯笼），
 * depthWrite 关闭 + additive，中心两层、边缘一层，靠叠加自然做出体积感，
 * 不需要额外叠平面。所有网格 frustumCulled = false —— 实例矩阵每帧重写，
 * 自动算出来的包围球会立刻过期，否则会出现"走到标记跟前它反而消失"。
 *
 * ## 零分配
 *
 * sync() 里没有 new、没有字面量数组、没有箭头函数、没有 .map/.filter。矩阵用
 * 模块级单例（_m4/_pos/_quat/_scale）compose 之后 setMatrixAt，逐实例属性直接
 * 下标写入预分配的 Float32Array。所有动画只由传入的 time 驱动（不读
 * performance.now）—— 暂停再恢复时画面不该跳一帧。
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  PlaneGeometry,
  Quaternion,
  RedFormat,
  RingGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { LevelDef } from '@dk/shared'

import { applyComicInk } from './ink.ts'
import { OUTLINE_SHARED } from './outline.ts'

// ---------------------------------------------------------------- 契约

export interface MarkerClue {
  x: number
  z: number
  found: boolean
}

export interface ObjectiveView {
  phase: 'hunt' | 'banish' | 'extract' | 'over'
  clues: MarkerClue[]
  /** 玩家正在读的那条线索下标，-1 = 没人在读 */
  activeClue: number
  /** 当前线索读取进度 0..1 */
  clueProgress: number
  /** 血巢位置（由三条线索质心算出，客户端也有一份同样的算法就自己算，不要从网络取） */
  lairX: number
  lairZ: number
  lairRevealed: boolean
  /** 放逐进度 0..1 */
  banishProgress: number
  /** 赏金携带者世界位置，null = 没人持有 */
  bountyAt: { x: number; y: number; z: number } | null
  /** 本机玩家世界位置（用来算"我离最近目标多远"，用于淡入） */
  myX: number
  myY: number
  myZ: number
  extracts: { name: string; x: number; z: number }[]
  /** 玩家所在的撤离点下标，-1 = 不在任何撤离点内 */
  extractIndex: number
  extractProgress: number
  /** 世界事件（EVENT_*）；eventX/Z 是补给空投落点。 */
  event: number
  eventX: number
  eventZ: number
  eventSeconds: number
}

export interface ObjectiveMarkers {
  /** 每帧调用。dt 秒，time 是累计秒（用来转动画）。 */
  sync(view: ObjectiveView, dt: number, time: number): void
  dispose(): void
  /** 所有标记的父节点，调用方自己 scene.add() */
  readonly root: import('three').Object3D
}

// ---------------------------------------------------------------- 常量

/** 线索：冷青白。比月光更冷、更亮一档，在暗沼泽里是"人工的"颜色。 */
const CLUE_COLOR = 0x9fd8e0
/** 血巢：焦橙 + 血红，两种都用在同一个柱子上，上段偏橙、下段偏血。 */
const LAIR_HOT = 0xd96b2a
const LAIR_DARK = 0x7d2b22
/** 撤离：病态黄绿。和线索的冷青一眼就能分开，且不与赏金琥珀撞色。 */
const EXTRACT_COLOR = 0x9aa845
/** 赏金光晕：琥珀。不做光柱 —— 携带者需要隐蔽性。 */
const BOUNTY_COLOR = 0xe0a25a

/** 光柱几何：底部 0.9m、顶部散开到 2.6m。窄是填充率要求，宽是"顶部散开"的表达。 */
const BEAM_BOTTOM_RADIUS = 0.9
const BEAM_TOP_RADIUS = 2.6
const CLUE_BEAM_HEIGHT = 14
const LAIR_BEAM_HEIGHT = 19
const CLUE_BEAM_WIDTH = 0.85
const LAIR_BEAM_WIDTH = 1.7

/** 交互半径，与 shared/src/match.ts 的 CLUE_RADIUS / LAIR_RADIUS / EXTRACT_RADIUS 对齐。 */
const CLUE_RADIUS = 3.2
const LAIR_RADIUS = 4.5
const EXTRACT_RADIUS = 6
/** "你到了"的判定范围：进入这个距离光柱收细、地面环加亮。 */
const CLUE_NEAR_RANGE = 3

const MAX_BEAMS = 8
const MAX_RINGS = 16
const MAX_ANCHORS = 8
/** 血巢周围的骨桩数量（3 根线索桩 + 5 根骨桩 = 实例上限 8）。 */
const SPIKE_COUNT = 5
/**
 * 粒子槽位：
 *   [0, EMBER_SLOTS)                          血巢火星
 *   [EMBER_SLOTS, EMBER_SLOTS+SMOKE_SLOTS)    撤离点烟气
 *   [.., +CLUE_SLOTS)                         线索余烬
 * 三类可以同时可见，所以槽位固定、不共用。
 */
const EMBER_SLOTS = 64
const SMOKE_SLOTS = 32
const CLUE_SLOTS = 140
const CLUE_SLOT_BASE = EMBER_SLOTS + SMOKE_SLOTS
const MAX_PARTICLES = CLUE_SLOT_BASE + CLUE_SLOTS

/** 墨线宽度（CSS 像素）。比主场景的 2.6 细：这些杆子只有几厘米粗。 */
const ANCHOR_INK_PIXELS = 1.4

// ---------------------------------------------------------------- 模块级单例
//
// 全部在模块加载时分配一次。sync() 里只写它们的字段，绝不 new。

const _m4 = new Matrix4()
const _pos = new Vector3()
const _scl = new Vector3()
/** 单位四元数：光柱/地面环/粒子永远只做平移+缩放，绝不旋转。绝不能和 _quat 混用 ——
 *  _quat 会被锚点写坏，混用的话下一帧所有光柱都跟着歪。 */
const _unit = new Quaternion()
const _quat = new Quaternion()
const _euler = new Euler()

// ---------------------------------------------------------------- 小工具

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** 指数趋近：帧率无关的淡入淡出，dt = 0 时完全静止（暂停不会把状态推走）。 */
function approach(current: number, target: number, dt: number, rate: number): number {
  if (dt <= 0) return current
  const k = 1 - Math.exp(-rate * dt)
  return current + (target - current) * k
}

/** 从世界坐标派生一个稳定的 [0,1) 相位：同一个点每次加载都有同一套抖动。 */
function seedOf(x: number, z: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453
  return v - Math.floor(v)
}

/** 预分配的逐实例属性（DynamicDrawUsage：每帧会被重写）。 */
function instancedAttr(count: number, itemSize: number): InstancedBufferAttribute {
  const attr = new InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize)
  attr.setUsage(DynamicDrawUsage)
  return attr
}

/**
 * 4 级灰度渐变图，供 MeshToonMaterial.gradientMap 采样。
 * 步值与 render.ts 的 makeGradientMap() / props.ts 的同名函数逐值相同 ——
 * 卡通渲染里色阶不一致就是"这块木头看着不像这块木头"。
 */
function makeGradientMap(): DataTexture {
  const steps = [0.32, 0.58, 0.82, 1.0]
  const data = new Uint8Array(steps.length)
  for (let i = 0; i < steps.length; i++) data[i] = Math.round(steps[i]! * 255)
  const map = new DataTexture(data, steps.length, 1, RedFormat)
  map.minFilter = NearestFilter
  map.magFilter = NearestFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

// ---------------------------------------------------------------- 着色器

/**
 * 光柱顶点着色器。
 *
 * 法线只用来做"边缘软化"：additive 的圆柱壳在视线正对处会穿两层（前壁 + 后壁），
 * 到轮廓处只剩一层，本身就有一层体积感；再把 |dot(N, V)| 极小的那一圈压掉，
 * 才不会在屏幕上看到一根带硬边的管子。
 *
 * 逐实例 aFill 是线索读取进度的高度遮罩：0 = 全暗，1 = 灌满。
 */
const BEAM_VERTEX = [
  'attribute float aAlpha;',
  'attribute float aFill;',
  'attribute float aSeed;',
  'attribute vec3 aTint;',
  'varying float vAlpha;',
  'varying float vFill;',
  'varying vec2 vUv;',
  'varying vec3 vTint;',
  'varying float vSeed;',
  'varying float vFacing;',
  'void main() {',
  '  vUv = uv;',
  '  vAlpha = aAlpha;',
  '  vFill = aFill;',
  '  vTint = aTint;',
  '  vSeed = aSeed;',
  '  vec4 local = instanceMatrix * vec4(position, 1.0);',
  '  vec4 mv = modelViewMatrix * local;',
  '  vec3 nrm = normalize(normalMatrix * mat3(instanceMatrix) * normal);',
  '  vFacing = abs(dot(nrm, normalize(-mv.xyz)));',
  '  gl_Position = projectionMatrix * mv;',
  '}',
].join('\n')

/**
 * 光柱片元着色器。
 *
 * 三件事叠在一起：底浓上淡的竖直衰减（光是打上来的，越往上越散）、按 uv.y 向上
 * 滚动的流动纹理（uv.y - time * 0.15，角向频率取整数倍才不会在 uv.x 接缝上裂开）、
 * 以及读取进度的高度遮罩 + 一条填充锋线。
 */
const BEAM_FRAGMENT = [
  'uniform float uTime;',
  'varying float vAlpha;',
  'varying float vFill;',
  'varying vec2 vUv;',
  'varying vec3 vTint;',
  'varying float vSeed;',
  'varying float vFacing;',
  'void main() {',
  '  // Bottom-heavy falloff: the mud is the source, the top dissolves into the fog.',
  '  float grad = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.55);',
  '  // Rising flow. 2.0 / 0.15 are the scroll speed asked for by the design brief;',
  '  // the angular term uses an integer harmonic so the cylinder seam stays invisible.',
  '  float flow = fract(vUv.y * 2.0 - uTime * 0.15 + vSeed);',
  '  float streak = smoothstep(0.30, 0.95, flow);',
  '  float swirl = 0.5 + 0.5 * sin(vUv.x * 6.2831853 * 3.0 + vUv.y * 6.0 - uTime * 0.9 + vSeed * 6.2831853);',
  '  float body = grad * (0.62 + 0.38 * streak) * (0.72 + 0.28 * swirl);',
  '  // Silhouette softening (see BEAM_VERTEX).',
  '  float edge = smoothstep(0.02, 0.34, vFacing);',
  '  // Reading progress: everything above the fill line drops to a dim ghost so the',
  '  // player sees the bar climbing the beam instead of a solid column blinking.',
  '  // 硬切（step）而不是 smoothstep：本项目所有分级都是平的，光柱上出现一条',
  '  // 8cm 高的软过渡带，会和 4 级色阶打架，看起来像曝光没对齐。',
  '  float below = step(vUv.y, vFill);',
  '  float mask = 0.10 + 0.90 * below;',
  '  float live = step(0.0015, vFill) * (1.0 - step(0.9985, vFill));',
  '  float d = (vUv.y - vFill) * 16.0;',
  '  float crest = exp(-d * d) * live;',
  '  float top = 1.0 - smoothstep(0.82, 1.0, vUv.y);',
  '  float alpha = clamp(vAlpha * edge * top * (body * mask + crest * 0.95), 0.0, 1.0);',
  '  vec3 col = vTint * (0.55 + 1.05 * body);',
  '  gl_FragColor = vec4(col, alpha);',
  '  // ShaderMaterial does not convert linear -> output space on its own; skipping this',
  '  // line makes every marker read one stop too hot (the project already paid for this).',
  '  #include <colorspace_fragment>',
  '}',
].join('\n')

/**
 * 地面环顶点着色器。环是 RingGeometry 绕 X 轴 -90° 摊平的，所以半径留在 xz 面上，
 * 角度用 atan2(z, x) 直接算 —— 不需要额外属性。
 */
const RING_VERTEX = [
  'attribute float aAlpha;',
  'attribute float aSpin;',
  'attribute float aDash;',
  'attribute float aPhase;',
  'attribute vec3 aTint;',
  'varying float vAlpha;',
  'varying float vSpin;',
  'varying float vDash;',
  'varying float vPhase;',
  'varying float vAng;',
  'varying float vRadius;',
  'varying vec3 vTint;',
  'void main() {',
  '  vAlpha = aAlpha;',
  '  vSpin = aSpin;',
  '  vDash = aDash;',
  '  vPhase = aPhase;',
  '  vTint = aTint;',
  '  vAng = atan(position.z, position.x);',
  '  vRadius = length(position.xz);',
  '  vec4 local = instanceMatrix * vec4(position, 1.0);',
  '  gl_Position = projectionMatrix * modelViewMatrix * local;',
  '}',
].join('\n')

/**
 * 地面环片元着色器：一圈亮边 + 虚线刻痕，虚线的角向相位随 uTime 旋转。
 * aDash = 0 且 aPhase = 0.5 时虚线退化成整圈实线（撤离点 / 立足环用这个）。
 */
const RING_FRAGMENT = [
  'uniform float uTime;',
  'varying float vAlpha;',
  'varying float vSpin;',
  'varying float vDash;',
  'varying float vPhase;',
  'varying float vAng;',
  'varying float vRadius;',
  'varying vec3 vTint;',
  'void main() {',
  '  float sector = fract(vAng * 0.15915494 * vDash + vPhase + uTime * vSpin);',
  '  float dash = 1.0 - smoothstep(0.30, 0.62, abs(sector - 0.5));',
  '  // 环的亮度向外递增，但最外缘必须收掉，否则剪影是一条硬边 —— 贴着地面的',
  '  // 发光体一旦有硬边，就立刻被读成"一块加了发光的地皮"，而不是光本身。',
  '  float rim = smoothstep(0.74, 0.97, vRadius) * (1.0 - smoothstep(0.985, 1.0, vRadius));',
  '  float alpha = clamp(vAlpha * rim * (0.28 + 0.72 * dash), 0.0, 1.0);',
  '  gl_FragColor = vec4(vTint * (0.8 + 0.9 * dash), alpha);',
  '  #include <colorspace_fragment>',
  '}',
].join('\n')

/**
 * 火星 / 烟气顶点着色器。
 *
 * billboard 在**视图空间**里做（把实例原点变换到视图空间后，直接用 position.xy
 * 撑开四边形）。这样不需要相机句柄，也就不会因为"每帧 new 一个 Object3D 去 lookAt"
 * 把零分配规则破坏掉。上浮用 fract(time * speed + phase)，相位来自逐实例静态属性，
 * 所以每颗火星的节奏天生错开。
 */
const PARTICLE_VERTEX = [
  'uniform float uTime;',
  'attribute float aAlpha;',
  'attribute float aPhase;',
  'attribute float aSpeed;',
  'attribute float aRise;',
  'attribute float aSize;',
  'attribute vec3 aTint;',
  'varying vec2 vUv;',
  'varying float vAlpha;',
  'varying vec3 vTint;',
  'void main() {',
  '  vec3 origin = instanceMatrix[3].xyz;',
  '  float life = fract(uTime * aSpeed + aPhase);',
  '  origin.y += life * aRise;',
  '  origin.x += sin(uTime * 0.8 + aPhase * 6.2831853) * 0.35 * life;',
  '  origin.z += cos(uTime * 1.1 + aPhase * 6.2831853) * 0.35 * life;',
  '  vec4 mv = modelViewMatrix * vec4(origin, 1.0);',
  '  mv.xy += position.xy * aSize * (0.65 + 0.55 * life);',
  '  gl_Position = projectionMatrix * mv;',
  '  vUv = uv;',
  '  // Fade in and out across the lifetime: a spark that pops in reads as a dropped frame.',
  '  vAlpha = aAlpha * sin(3.14159265 * clamp(life, 0.0, 1.0));',
  '  vTint = aTint;',
  '}',
].join('\n')

const PARTICLE_FRAGMENT = [
  'varying vec2 vUv;',
  'varying float vAlpha;',
  'varying vec3 vTint;',
  'void main() {',
  '  float r = length(vUv - 0.5) * 2.0;',
  '  float halo = 1.0 - smoothstep(0.25, 1.0, r);',
  '  float core = 1.0 - smoothstep(0.05, 0.32, r);',
  '  float alpha = clamp(vAlpha * (halo * halo * 0.85 + core * 0.6), 0.0, 1.0);',
  '  gl_FragColor = vec4(vTint * (0.9 + core * 1.2), alpha);',
  '  #include <colorspace_fragment>',
  '}',
].join('\n')

/** 赏金光晕：单 quad，同样在视图空间里撑开，永远正对镜头。 */
const GLOW_VERTEX = [
  'uniform float uSize;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
  '  mv.xy += position.xy * uSize;',
  '  gl_Position = projectionMatrix * mv;',
  '  vUv = uv;',
  '}',
].join('\n')

const GLOW_FRAGMENT = [
  'uniform float uAlpha;',
  'uniform vec3 uColor;',
  'varying vec2 vUv;',
  'void main() {',
  '  float r = length(vUv - 0.5) * 2.0;',
  '  float halo = pow(1.0 - clamp(r, 0.0, 1.0), 2.4);',
  '  float core = 1.0 - smoothstep(0.10, 0.34, r);',
  '  float alpha = clamp(uAlpha * (halo * 0.75 + core * 0.9), 0.0, 1.0);',
  '  gl_FragColor = vec4(uColor * (1.0 + core * 1.4), alpha);',
  '  #include <colorspace_fragment>',
  '}',
].join('\n')

/**
 * 墨线壳（实例化）。与 outline.ts / props.ts 同一套原理：背面 + 沿法线外扩，
 * 外扩量乘 pos.w 抵消透视除法，线宽于是恒定在 CSS 像素上。
 * 必须处理 USE_INSTANCING：否则每根桩都朝自己的局部原点方向外扩，描边随朝向变形。
 */
const INK_VERTEX = [
  'uniform float uWidth;',
  'uniform float uBoil;',
  'uniform vec2 uRes;',
  'void main() {',
  '  vec4 local = instanceMatrix * vec4(position, 1.0);',
  '  vec3 nrm = normalize(mat3(instanceMatrix) * normal);',
  '  vec4 pos = projectionMatrix * modelViewMatrix * local;',
  '  pos.xy += normalize(normalMatrix * nrm).xy * uWidth * uBoil * uRes * pos.w;',
  '  gl_Position = pos;',
  '}',
].join('\n')

/**
 * 墨线壳的片元。
 *
 * 这里**必须**走一遍 colorspace_fragment，逻辑和光柱那边完全不同：
 * ShaderMaterial 的片元前缀里包含 colorspace_pars_fragment + linearToOutputTexel，
 * 但输出编码这一步是要自己 include 的。uColor 是 new Color(0x14100c) 解出来的
 * 线性值，少了这行，墨线会按线性值直接上屏 —— 0x14100c 这种近黑会被抬到 #6b6158
 * 那种脏灰，整根桩子的描边变成毛边灰线，看着像抗锯齿没开。
 * （MeshToonMaterial 那些不需要，它们是 onBeforeCompile 改的，前缀照常生效。）
 */
const INK_FRAGMENT = [
  'uniform vec3 uColor;',
  'void main() {',
  '  gl_FragColor = vec4(uColor, 1.0);',
  '  #include <colorspace_fragment>',
  '}',
].join('\n')

// ---------------------------------------------------------------- 主体

export function createObjectiveMarkers(level: LevelDef): ObjectiveMarkers {
  const root = new Group()
  root.name = 'objective-markers'

  const groundY = level.groundY
  const bag: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(item: T): T => {
    bag.push(item)
    return item
  }

  // 颜色在这里就转成线性（Color 构造时按 SRGBColorSpace 解码），着色器里再统一
  // 走 colorspace_fragment 编码回输出空间。整个文件里没有第二处颜色转换。
  const clueCol = new Color(CLUE_COLOR)
  const hotCol = new Color(LAIR_HOT)
  const darkCol = new Color(LAIR_DARK)
  const extractCol = new Color(EXTRACT_COLOR)

  const beamTime = { value: 0 }
  const ringTime = { value: 0 }
  const particleTime = { value: 0 }

  // ------------------------------------------------------------ 光柱

  const beamGeo = new CylinderGeometry(BEAM_TOP_RADIUS, BEAM_BOTTOM_RADIUS, 1, 16, 1, true)
  // 原点挪到柱底：实例缩放的高度直接就是"从地面长上去多高"。
  beamGeo.translate(0, 0.5, 0)
  keep(beamGeo)

  const beamAlphaAttr = instancedAttr(MAX_BEAMS, 1)
  const beamFillAttr = instancedAttr(MAX_BEAMS, 1)
  const beamSeedAttr = instancedAttr(MAX_BEAMS, 1)
  const beamTintAttr = instancedAttr(MAX_BEAMS, 3)
  beamGeo.setAttribute('aAlpha', beamAlphaAttr)
  beamGeo.setAttribute('aFill', beamFillAttr)
  beamGeo.setAttribute('aSeed', beamSeedAttr)
  beamGeo.setAttribute('aTint', beamTintAttr)
  keep(beamAlphaAttr)
  keep(beamFillAttr)
  keep(beamSeedAttr)
  keep(beamTintAttr)

  const beamMat = keep(
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      // fog: false 是关键。雾是给"真实表面"分层次的，光柱必须穿雾可见，
      // 否则 fogDensity 0.019 在 25m 外就把它糊成背景色，等于没做。
      fog: false,
      uniforms: { uTime: beamTime },
      vertexShader: BEAM_VERTEX,
      fragmentShader: BEAM_FRAGMENT,
    }),
  )

  const beams = new InstancedMesh(beamGeo, beamMat, MAX_BEAMS)
  beams.instanceMatrix.setUsage(DynamicDrawUsage)
  beams.count = 0
  beams.visible = false
  beams.frustumCulled = false
  beams.renderOrder = 6
  root.add(beams)
  keep(beams)

  // ------------------------------------------------------------ 地面环

  const ringGeo = new RingGeometry(0.72, 1, 48, 1)
  ringGeo.rotateX(-Math.PI / 2)
  keep(ringGeo)

  const ringAlphaAttr = instancedAttr(MAX_RINGS, 1)
  const ringSpinAttr = instancedAttr(MAX_RINGS, 1)
  const ringDashAttr = instancedAttr(MAX_RINGS, 1)
  const ringPhaseAttr = instancedAttr(MAX_RINGS, 1)
  const ringTintAttr = instancedAttr(MAX_RINGS, 3)
  ringGeo.setAttribute('aAlpha', ringAlphaAttr)
  ringGeo.setAttribute('aSpin', ringSpinAttr)
  ringGeo.setAttribute('aDash', ringDashAttr)
  ringGeo.setAttribute('aPhase', ringPhaseAttr)
  ringGeo.setAttribute('aTint', ringTintAttr)
  keep(ringAlphaAttr)
  keep(ringSpinAttr)
  keep(ringDashAttr)
  keep(ringPhaseAttr)
  keep(ringTintAttr)

  const ringMat = keep(
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: { uTime: ringTime },
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
    }),
  )

  const rings = new InstancedMesh(ringGeo, ringMat, MAX_RINGS)
  rings.instanceMatrix.setUsage(DynamicDrawUsage)
  rings.count = 0
  rings.visible = false
  rings.frustumCulled = false
  rings.renderOrder = 5
  root.add(rings)
  keep(rings)

  // ------------------------------------------------------------ 火星 / 烟气

  const partGeo = new PlaneGeometry(1, 1)
  keep(partGeo)

  const partAlphaAttr = instancedAttr(MAX_PARTICLES, 1)
  const partPhaseAttr = instancedAttr(MAX_PARTICLES, 1)
  const partSpeedAttr = instancedAttr(MAX_PARTICLES, 1)
  const partRiseAttr = instancedAttr(MAX_PARTICLES, 1)
  const partSizeAttr = instancedAttr(MAX_PARTICLES, 1)
  const partTintAttr = instancedAttr(MAX_PARTICLES, 3)
  partGeo.setAttribute('aAlpha', partAlphaAttr)
  partGeo.setAttribute('aPhase', partPhaseAttr)
  partGeo.setAttribute('aSpeed', partSpeedAttr)
  partGeo.setAttribute('aRise', partRiseAttr)
  partGeo.setAttribute('aSize', partSizeAttr)
  partGeo.setAttribute('aTint', partTintAttr)
  keep(partAlphaAttr)
  keep(partPhaseAttr)
  keep(partSpeedAttr)
  keep(partRiseAttr)
  keep(partSizeAttr)
  keep(partTintAttr)

  const partMat = keep(
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: { uTime: particleTime },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
    }),
  )

  const particles = new InstancedMesh(partGeo, partMat, MAX_PARTICLES)
  particles.instanceMatrix.setUsage(DynamicDrawUsage)
  particles.count = 0
  particles.visible = false
  particles.frustumCulled = false
  particles.renderOrder = 7
  root.add(particles)
  keep(particles)

  // 逐槽位的静态属性：槽位一旦定下角色（线索余烬 / 火星 / 烟气）就不再变，
  // 逐帧只改矩阵与尺寸。
  const clueAngle = new Float32Array(CLUE_SLOTS)
  const clueRadius = new Float32Array(CLUE_SLOTS)
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const clue = i >= CLUE_SLOT_BASE
    const ember = !clue && i < EMBER_SLOTS
    const r = seedOf(i * 1.7 + 0.31, i * 0.9 + 2.7)
    const r2 = seedOf(i * 0.37 + 5.1, i * 2.3 + 0.7)
    partPhaseAttr.array[i] = r
    if (clue) {
      const k = i - CLUE_SLOT_BASE
      // 前 24 颗是贴地的大颗粒余烬，其余是上升的细火星。
      const ground = k < 24
      clueAngle[k] = r * Math.PI * 2
      clueRadius[k] = (ground ? 0.25 + r2 * 0.9 : 0.2 + r2 * 0.7) * 1.1
      partSpeedAttr.array[i] = ground ? 0.035 + r2 * 0.02 : 0.10 + r * 0.10
      partRiseAttr.array[i] = ground ? 0.35 + r2 * 0.35 : 2.4 + r2 * 2.6
      partSizeAttr.array[i] = ground ? 0.16 + r2 * 0.10 : 0.055 + r2 * 0.05
      partAlphaAttr.array[i] = ground ? 0.45 : 0.8
      partTintAttr.array[i * 3] = clueCol.r * (0.7 + r2 * 0.7)
      partTintAttr.array[i * 3 + 1] = clueCol.g * (0.7 + r2 * 0.6)
      partTintAttr.array[i * 3 + 2] = clueCol.b * (0.7 + r2 * 0.5)
    } else {
      partSpeedAttr.array[i] = ember ? 0.22 + r * 0.26 : 0.055 + r * 0.05
      partRiseAttr.array[i] = ember ? 4.5 + r2 * 4.0 : 7.0 + r2 * 5.0
      partSizeAttr.array[i] = ember ? 0.16 + r2 * 0.14 : 1.5 + r2 * 1.1
      partAlphaAttr.array[i] = ember ? 0.85 : 0.22
      if (ember) {
        // 血巢火星：焦橙到血红之间随机，越亮越像被风抽起来的余烬。
        const mix = r2
        partTintAttr.array[i * 3] = hotCol.r * (0.55 + mix * 0.8)
        partTintAttr.array[i * 3 + 1] = hotCol.g * (0.30 + mix * 0.7) + darkCol.g * (1 - mix) * 0.6
        partTintAttr.array[i * 3 + 2] = hotCol.b * (0.20 + mix * 0.5) + darkCol.b * (1 - mix)
      } else {
        partTintAttr.array[i * 3] = extractCol.r
        partTintAttr.array[i * 3 + 1] = extractCol.g
        partTintAttr.array[i * 3 + 2] = extractCol.b
      }
    }
  }
  partPhaseAttr.needsUpdate = true
  partSpeedAttr.needsUpdate = true
  partRiseAttr.needsUpdate = true
  partSizeAttr.needsUpdate = true
  partAlphaAttr.needsUpdate = true
  partTintAttr.needsUpdate = true
  // 尺寸基线：非活动槽位每帧把 aSize 写成 0，四边形退化成一个点、像素数为零。
  // 这样"槽位固定 + 单个 count"就能同时表达两类粒子，而不必冒着重排实例的风险。
  const partBaseSize = new Float32Array(MAX_PARTICLES)
  for (let i = 0; i < MAX_PARTICLES; i++) {
    partBaseSize[i] = partSizeAttr.array[i]
    partSizeAttr.array[i] = 0
  }
  partSizeAttr.needsUpdate = true

  // ------------------------------------------------------------ 赏金光晕

  const glowGeo = keep(new PlaneGeometry(1, 1))
  const glowAlpha = { value: 0 }
  const glowSize = { value: 1.1 }
  const glowMat = keep(
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: {
        uAlpha: glowAlpha,
        uSize: glowSize,
        uColor: { value: new Color(BOUNTY_COLOR) },
      },
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
    }),
  )
  const glow = new Mesh(glowGeo, glowMat)
  glow.frustumCulled = false
  glow.visible = false
  glow.renderOrder = 8
  root.add(glow)

  // ------------------------------------------------------------ 实体锚点（toon）

  const gradientMap = keep(makeGradientMap())
  const anchorGeo = new CylinderGeometry(0.03, 0.075, 1, 5, 1)
  anchorGeo.translate(0, 0.5, 0)
  keep(anchorGeo)

  // hatch 关掉（hatchStrength 0）：几厘米粗的杆子上做屏幕空间排线，只会被读成噪点。
  // mottle 也压到 0.3 —— 这些小东西本来就是"被别人动过"的异物，不需要风化。
  const anchorMat = keep(
    applyComicInk(
      new MeshToonMaterial({ color: 0xffffff, gradientMap }),
      { hatchStrength: 0, mottle: 0.3, grime: 0.05 },
    ),
  )

  const anchors = new InstancedMesh(anchorGeo, anchorMat, MAX_ANCHORS)
  anchors.instanceMatrix.setUsage(DynamicDrawUsage)
  anchors.count = 0
  anchors.visible = false
  anchors.frustumCulled = false
  anchors.renderOrder = 0
  root.add(anchors)
  keep(anchors)
  // 逐实例颜色在这里一次性初始化（角色固定），之后逐帧只改矩阵。
  const anchorTint = new Color()
  for (let i = 0; i < MAX_ANCHORS; i++) {
    // 前 3 个槽是线索桩（旧木板），其余是血巢骨桩（焦黑）。
    anchorTint.setHex(i < 3 ? 0x8a7a63 : 0x2e211a)
    anchors.setColorAt(i, anchorTint)
  }
  if (anchors.instanceColor) anchors.instanceColor.needsUpdate = true

  const inkMat = keep(
    new ShaderMaterial({
      side: BackSide,
      uniforms: {
        uWidth: { value: ANCHOR_INK_PIXELS },
        uBoil: OUTLINE_SHARED.boil,
        uRes: OUTLINE_SHARED.resolution,
        uColor: { value: new Color(0x14100c) },
      },
      vertexShader: INK_VERTEX,
      fragmentShader: INK_FRAGMENT,
    }),
  )
  const anchorInk = new InstancedMesh(anchorGeo, inkMat, MAX_ANCHORS)
  anchorInk.instanceMatrix.setUsage(DynamicDrawUsage)
  anchorInk.count = 0
  anchorInk.visible = false
  anchorInk.frustumCulled = false
  anchorInk.raycast = (): void => {}
  anchorInk.renderOrder = 0
  root.add(anchorInk)
  keep(anchorInk)

  // ------------------------------------------------------------ 状态

  let lairFade = 0
  let extractFade = 0
  let supplyPulse = 0
  /** 本帧活动的火星/烟气槽位数（0..EMBER_SLOTS / 0..SMOKE_SLOTS）。 */
  let emberOn = 0
  let smokeOn = 0
  let clueOn = 0
  let clueX = 0
  let clueZ = 0
  let clueNear = 0
  let clueProgress = 0
  /** 上一帧火星是否是亮的：用于"变暗那一帧"把 64 个槽位清零一次，之后不再空转。 */
  let emberLit = false
  /** 火星围绕血巢、烟气围绕撤离点的水平偏移（构造时算一次，永不重算）。 */
  const emberOffX = new Float32Array(EMBER_SLOTS)
  const emberOffZ = new Float32Array(EMBER_SLOTS)
  const smokeOffX = new Float32Array(SMOKE_SLOTS)
  const smokeOffZ = new Float32Array(SMOKE_SLOTS)
  for (let i = 0; i < EMBER_SLOTS; i++) {
    const a = seedOf(i * 3.1, 1.7) * Math.PI * 2
    const r = 0.45 + seedOf(i * 0.7, 9.3) * 0.75
    emberOffX[i] = Math.cos(a) * LAIR_RADIUS * r * 0.8
    emberOffZ[i] = Math.sin(a) * LAIR_RADIUS * r * 0.8
  }
  for (let i = 0; i < SMOKE_SLOTS; i++) {
    const a = seedOf(i * 2.3, 4.1) * Math.PI * 2
    const r = 0.15 + seedOf(i * 1.1, 6.9) * 0.85
    smokeOffX[i] = Math.cos(a) * EXTRACT_RADIUS * r * 0.9
    smokeOffZ[i] = Math.sin(a) * EXTRACT_RADIUS * r * 0.9
  }
  /** 血巢骨桩的位置与倾角（5 根，围着血巢）。血巢坐标一稳定就只算一次。 */
  let spikePacked = false
  let spikeOriginX = Number.NaN
  let spikeOriginZ = Number.NaN
  const spikeX = new Float32Array(SPIKE_COUNT)
  const spikeZ = new Float32Array(SPIKE_COUNT)
  const spikeYaw = new Float32Array(SPIKE_COUNT)
  const spikeTilt = new Float32Array(SPIKE_COUNT)
  const spikeLen = new Float32Array(SPIKE_COUNT)

  // 逐实例属性的底层数组：sync 里直接用下标写，不经过 setter。
  const beamAlphaArr = beamAlphaAttr.array
  const beamFillArr = beamFillAttr.array
  const beamSeedArr = beamSeedAttr.array
  const beamTintArr = beamTintAttr.array
  const ringAlphaArr = ringAlphaAttr.array
  const ringSpinArr = ringSpinAttr.array
  const ringDashArr = ringDashAttr.array
  const ringPhaseArr = ringPhaseAttr.array
  const ringTintArr = ringTintAttr.array
  const partAlphaArr = partAlphaAttr.array
  const partSizeArr = partSizeAttr.array

  // ------------------------------------------------------------ sync

  // ------------------------------------------------------------ 补给空投光柱
  const supplyGroup = new Group()
  supplyGroup.visible = false
  const supplyBeamMat = new MeshBasicMaterial({
    color: 0xffc06a,
    transparent: true,
    opacity: 0.16,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  })
  const supplyBeamGeo = new CylinderGeometry(0.75, 0.75, 60, 12, 1, true)
  const supplyBeam = new Mesh(supplyBeamGeo, supplyBeamMat)
  supplyBeam.position.y = 30
  supplyBeam.renderOrder = 2
  supplyGroup.add(supplyBeam)
  const supplyRingMat = new MeshBasicMaterial({
    color: 0xffb457,
    transparent: true,
    opacity: 0.5,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  })
  const supplyRingGeo = new RingGeometry(1.4, 2.4, 40)
  const supplyRing = new Mesh(supplyRingGeo, supplyRingMat)
  supplyRing.rotation.x = -Math.PI / 2
  supplyRing.position.y = 0.04
  supplyGroup.add(supplyRing)
  root.add(supplyGroup)
  keep(supplyGroup)

  function sync(view: ObjectiveView, dt: number, time: number): void {
    const step = Math.min(Math.max(dt, 0), 0.1)

    beamTime.value = time
    ringTime.value = time
    particleTime.value = time

    lairFade = approach(lairFade, view.lairRevealed ? 1 : 0, step, 4.5)
    if (lairFade < 0.002) lairFade = 0
    // 补给空投：只画一根可穿墙的金色光柱 + 地面圆环，全图可见。
    if (view.event === 1) {
      supplyGroup.visible = true
      supplyGroup.position.set(view.eventX, 0, view.eventZ)
      supplyPulse += dt
      const pulse = 1 + Math.sin(supplyPulse * 3.2) * 0.06
      supplyBeam.scale.set(pulse, 1, pulse)
      supplyRing.scale.setScalar(pulse)
      supplyBeamMat.opacity = 0.13 + Math.sin(supplyPulse * 4.1) * 0.04
      supplyRingMat.opacity = 0.42 + Math.sin(supplyPulse * 2.7) * 0.12
    } else if (supplyGroup.visible) {
      supplyGroup.visible = false
    }

    const extractOn = view.extractIndex >= 0 && view.extractIndex < view.extracts.length
    extractFade = approach(extractFade, extractOn ? 1 : 0, step, 4.5)
    if (extractFade < 0.002) extractFade = 0

    const banish = clamp01(view.banishProgress)
    const extractProg = clamp01(view.extractProgress)
    // 赏金被取走之后，血巢的光柱要退成"暗淡余烬"：血迹还在，但不该继续抢注意力。
    const spent = view.phase === 'extract' || view.phase === 'over'

    const myX = view.myX
    const myZ = view.myZ
    let nBeam = 0
    let nRing = 0
    let nAnchor = 0
    emberOn = 0
    smokeOn = 0
    clueOn = 0

    // ---- 线索：常驻可见（found 的除外） ----
    for (let i = 0; i < view.clues.length; i++) {
      const clue = view.clues[i]
      if (clue.found) continue
      const dist = Math.hypot(clue.x - myX, clue.z - myZ)
      // near = 1 表示"你到了"：光柱收细、整体亮一档、地面环加亮。
      const near = 1 - smoothstep(CLUE_NEAR_RANGE * 0.4, CLUE_NEAR_RANGE, dist)
      const active = i === view.activeClue
      const progress = active ? clamp01(view.clueProgress) : 1

      if (active) {
        clueX = clue.x
        clueZ = clue.z
        clueNear = near
        clueProgress = progress
        clueOn = CLUE_SLOTS
      }

      // 线索桩：一根歪插在泥里的旧木板。细到剪影上明显不能当掩体。
      if (nAnchor < 3) {
        const index = nAnchor++
        const seed = seedOf(clue.x + 3.1, clue.z + 7.7)
        _pos.set(clue.x + (seed - 0.5) * 0.7, groundY, clue.z + (seedOf(clue.z, clue.x) - 0.5) * 0.7)
        _euler.set((seed - 0.5) * 0.34, seed * 6.2831853, (seedOf(clue.z, clue.x) - 0.5) * 0.34)
        _quat.setFromEuler(_euler)
        _scl.set(1, 1.15 + seed * 0.5, 1)
        _m4.compose(_pos, _quat, _scl)
        anchors.setMatrixAt(index, _m4)
      }
    }

    // ---- 线索余烬：当前线索周围的一柱上升火星 + 贴地余烬 ----
    // 旧版是光柱 + 两圈环，远看像廉价的任务光圈；这里换成只由粒子组成的
    // 呼吸感：贴地大颗粒负责"这里有东西"，上升细火星负责方向与高度。
    if (clueOn > 0) {
      for (let k = 0; k < CLUE_SLOTS; k++) {
        const slot = CLUE_SLOT_BASE + k
        const angle = clueAngle[k] + time * (0.22 + (k % 9) * 0.015)
        const radius = clueRadius[k] * (1 - 0.22 * clueProgress)
        _pos.set(clueX + Math.cos(angle) * radius, groundY, clueZ + Math.sin(angle) * radius)
        _m4.makeTranslation(_pos.x, _pos.y, _pos.z)
        particles.setMatrixAt(slot, _m4)
        partSizeArr[slot] =
          partBaseSize[slot] * (0.55 + 0.45 * clueNear) * (0.7 + 0.6 * clueProgress)
      }
    } else {
      for (let k = 0; k < CLUE_SLOTS; k++) partSizeArr[CLUE_SLOT_BASE + k] = 0
    }

    // ---- 血巢：未揭示时一个实例都不写 ----
    // 站在血巢里时把光柱和焦痕环淡掉：它们是不透明的大面片，贴脸时整屏糊成
    // 一片橙色，脚下一米内什么都看不见 —— 而放逐恰好要求你站进去读条。
    const lairDx = view.myX - view.lairX
    const lairDz = view.myZ - view.lairZ
    const nearFade = Math.min(Math.max((Math.sqrt(lairDx * lairDx + lairDz * lairDz) - 1.6) / 3.4, 0), 1)
    if (lairFade > 0) {
      if (nBeam < MAX_BEAMS) {
        const index = nBeam++
        // 放逐中光柱随进度变粗（全场都该看见"有人在放逐了"）。
        let width = LAIR_BEAM_WIDTH + banish * 0.55
        let alpha = lairFade * (0.95 + 0.45 * banish) * nearFade
        let height = LAIR_BEAM_HEIGHT
        let r = hotCol.r
        let g = hotCol.g
        let b = hotCol.b
        if (spent) {
          // 余烬：矮、细、暗、偏血褐 —— 还看得见，但不再抢画面。
          width *= 0.6
          height *= 0.82
          alpha *= 0.3
          r = darkCol.r * 1.6
          g = darkCol.g * 1.6
          b = darkCol.b * 1.6
        }
        _pos.set(view.lairX, groundY, view.lairZ)
        _scl.set(width, height, width)
        _m4.compose(_pos, _unit, _scl)
        beams.setMatrixAt(index, _m4)
        beamAlphaArr[index] = alpha
        beamFillArr[index] = 1
        beamSeedArr[index] = seedOf(view.lairX, view.lairZ)
        beamTintArr[index * 3] = r
        beamTintArr[index * 3 + 1] = g
        beamTintArr[index * 3 + 2] = b
      }

      // 地面焦痕环：一圈虚线，缓慢转，放逐时转快、变亮。
      if (nRing < MAX_RINGS) {
        const index = nRing++
        _pos.set(view.lairX, groundY + 0.05, view.lairZ)
        _scl.set(LAIR_RADIUS, 1, LAIR_RADIUS)
        _m4.compose(_pos, _unit, _scl)
        rings.setMatrixAt(index, _m4)
        ringAlphaArr[index] = lairFade * (0.4 + 0.5 * banish) * (spent ? 0.35 : 1) * (0.2 + 0.8 * nearFade)
        ringSpinArr[index] = 0.22 + 0.55 * banish
        ringDashArr[index] = 10
        ringPhaseArr[index] = 0
        const dim = spent ? 0.55 : 1
        ringTintArr[index * 3] = (hotCol.r * 0.9 + darkCol.r * 0.5) * dim
        ringTintArr[index * 3 + 1] = (hotCol.g * 0.9 + darkCol.g * 0.5) * dim
        ringTintArr[index * 3 + 2] = (hotCol.b * 0.9 + darkCol.b * 0.5) * dim
      }

      // 骨桩：5 根焦黑的骨/烧焦木，向外倒伏（明显不是掩体，只是"这里有事发生过"）。
      // 位置与倾角只依赖血巢坐标，第一次揭示时算进 spike* 数组，之后逐帧零成本。
      if (!spikePacked || spikeOriginX !== view.lairX || spikeOriginZ !== view.lairZ) {
        for (let k = 0; k < SPIKE_COUNT; k++) {
          const a = (k / SPIKE_COUNT) * Math.PI * 2 + seedOf(view.lairX, view.lairZ) * 6.2831853
          spikeX[k] = view.lairX + Math.cos(a) * 2.1
          spikeZ[k] = view.lairZ + Math.sin(a) * 2.1
          spikeYaw[k] = a + Math.PI * 0.5
          spikeTilt[k] = 0.34 + seedOf(k * 1.3, 4.7) * 0.4
          spikeLen[k] = 0.9 + seedOf(k * 2.7, 1.1) * 0.7
        }
        spikeOriginX = view.lairX
        spikeOriginZ = view.lairZ
        spikePacked = true
      }
      // 倒伏角度乘 lairFade：刚揭示时骨桩是慢慢"塌"下来的，不是凭空立着出现。
      for (let k = 0; k < SPIKE_COUNT; k++) {
        if (nAnchor >= MAX_ANCHORS) break
        const index = nAnchor++
        _pos.set(spikeX[k], groundY, spikeZ[k])
        _euler.set(0, spikeYaw[k], -spikeTilt[k] * lairFade)
        _quat.setFromEuler(_euler)
        _scl.set(1.4, spikeLen[k], 1.4)
        _m4.compose(_pos, _quat, _scl)
        anchors.setMatrixAt(index, _m4)
      }

    }

    // 火星：放逐越久越密，赏金被取走后只剩零星余烬。
    //
    // 槽位 = 实例下标（0..EMBER_SLOTS-1），非活动槽位把 aSize 写成 0 —— 逐实例属性
    // 是按下标取的，槽位与下标一旦错位，火星就会染上烟气的相位和颜色。这段**不能**
    // 塞进上面那个 "lairFade > 0" 分支里：撤离点单独可见时粒子仍然要画，而没被清零
    // 的火星槽位会带着上一帧的矩阵飘在血巢原处，变成去不掉的鬼火。
    if (lairFade > 0 || emberLit) {
      emberOn = Math.round(EMBER_SLOTS * lairFade * (0.5 + 0.5 * banish))
      if (spent) emberOn = Math.round(emberOn * 0.3)
      if (emberOn > EMBER_SLOTS) emberOn = EMBER_SLOTS
      for (let k = 0; k < EMBER_SLOTS; k++) {
        if (k < emberOn) {
          _pos.set(view.lairX + emberOffX[k], groundY + 0.15, view.lairZ + emberOffZ[k])
          _scl.set(1, 1, 1)
          _m4.compose(_pos, _unit, _scl)
          particles.setMatrixAt(k, _m4)
          partAlphaArr[k] = 0.85 * lairFade * (0.35 + 0.65 * nearFade)
          partSizeArr[k] = partBaseSize[k]
        } else {
          partSizeArr[k] = 0
        }
      }
      emberLit = emberOn > 0
    }

    // ---- 撤离点：只在自己站进去时显现 ----
    if (extractFade > 0) {
      const ex = view.extracts[view.extractIndex]
      if (ex) {
        if (nRing < MAX_RINGS) {
          const index = nRing++
          _pos.set(ex.x, groundY + 0.05, ex.z)
          _scl.set(EXTRACT_RADIUS, 1, EXTRACT_RADIUS)
          _m4.compose(_pos, _unit, _scl)
          rings.setMatrixAt(index, _m4)
          ringAlphaArr[index] = extractFade * (0.28 + 0.62 * extractProg)
          // 进度越高转得越快：读条越到后面越"急"。
          ringSpinArr[index] = 0.18 + 0.7 * extractProg
          ringDashArr[index] = 20
          ringPhaseArr[index] = 0
          ringTintArr[index * 3] = extractCol.r
          ringTintArr[index * 3 + 1] = extractCol.g
          ringTintArr[index * 3 + 2] = extractCol.b
        }

        // 贴地烟气：缓慢上升的一层薄雾，说明"这里有一口活气"。
        smokeOn = Math.round(SMOKE_SLOTS * extractFade * (0.6 + 0.4 * extractProg))
        for (let k = 0; k < SMOKE_SLOTS; k++) {
          const slot = EMBER_SLOTS + k
          if (k < smokeOn) {
            _pos.set(ex.x + smokeOffX[k], groundY + 0.1, ex.z + smokeOffZ[k])
            _scl.set(1, 1, 1)
            _m4.compose(_pos, _unit, _scl)
            particles.setMatrixAt(slot, _m4)
            partAlphaArr[slot] = (0.16 + 0.26 * extractProg) * extractFade
            partSizeArr[slot] = partBaseSize[slot]
          } else {
            partSizeArr[slot] = 0
          }
        }
      }
    }

    // ---- 赏金携带者：一小团琥珀光晕 ----
    if (view.bountyAt) {
      glow.visible = true
      glow.position.set(view.bountyAt.x, view.bountyAt.y, view.bountyAt.z)
      // 呼吸只由 time 驱动：暂停时它必须停在原地，而不是继续吸气。
      const breathe = 0.82 + 0.18 * Math.sin(time * 3.1)
      glowAlpha.value = 0.75 * breathe
      glowSize.value = 1.15 + 0.12 * Math.sin(time * 2.2)
    } else {
      glow.visible = false
    }

    // ---- 提交 ----
    beams.count = nBeam
    beams.visible = nBeam > 0
    if (nBeam > 0) beams.instanceMatrix.needsUpdate = true
    beamAlphaAttr.needsUpdate = true
    beamFillAttr.needsUpdate = true
    beamSeedAttr.needsUpdate = true
    beamTintAttr.needsUpdate = true

    rings.count = nRing
    rings.visible = nRing > 0
    if (nRing > 0) rings.instanceMatrix.needsUpdate = true
    ringAlphaAttr.needsUpdate = true
    ringSpinAttr.needsUpdate = true
    ringDashAttr.needsUpdate = true
    ringPhaseAttr.needsUpdate = true
    ringTintAttr.needsUpdate = true

    // 槽位是连续的：火星占 [0, EMBER_SLOTS)，烟气紧接着。count 只要覆盖到最后
    // 一个活动槽位即可，退化（尺寸 0）的中间槽位不产生任何像素。
    particles.count =
      clueOn > 0
        ? MAX_PARTICLES
        : smokeOn > 0
          ? EMBER_SLOTS + smokeOn
          : emberOn > 0
            ? EMBER_SLOTS
            : 0
    particles.visible = particles.count > 0
    if (particles.count > 0) particles.instanceMatrix.needsUpdate = true
    partAlphaAttr.needsUpdate = true
    partSizeAttr.needsUpdate = true

    anchors.count = nAnchor
    anchors.visible = nAnchor > 0
    anchorInk.visible = nAnchor > 0
    anchorInk.count = nAnchor
    if (nAnchor > 0) {
      anchors.instanceMatrix.needsUpdate = true
      // 墨线壳共用同一份实例矩阵：桩子歪多少，墨线就歪多少。
      anchorInk.instanceMatrix.array.set(anchors.instanceMatrix.array)
      anchorInk.instanceMatrix.needsUpdate = true
    }

    // 整根 root 的开关：血巢未揭示、撤离线不在里面、也没有赏金光 —— 这时场景里
    // **一个可见物都不该有**。把 root.visible 一起关掉，渲染器连遍历这六个孩子
    // 的可见性判断都省了；它也是"隐藏靠 visible、不靠移除节点"这条规则的终点。
    root.visible = nBeam > 0 || nRing > 0 || clueOn > 0 || anchors.visible || glow.visible || particles.visible
  }

  return {
    root,
    sync,
    dispose(): void {
      root.removeFromParent()
      for (let i = 0; i < bag.length; i++) bag[i].dispose()
      bag.length = 0
      root.clear()
    },
  }
}
