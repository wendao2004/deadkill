/**
 * 黑夜气氛层：把白天/灰蓝的场子改成"深夜沼泽"。
 *
 * 这个模块只做**环境**：主光、天空、雾、局部火光、后期渐变、萤火虫。
 * 它不碰关卡几何、不碰材质管线、不 import 项目里任何文件 —— 调用方
 * createAtmosphere(scene) 之后只保留 root 的生命周期，别的一概不管。
 *
 * ## 为什么必须自己 add root
 *
 * 调用方只要 "new 一下就好"。若要求调用方先建灯、先挂天空球、先给雾赋值，
 * 那么这个模块就变成了"半个渲染器"，接进去的地方会散在 render.ts 的四个
 * 角落里，以后谁先谁后都要重新推一遍。
 *
 * ## 为什么用平行光而不是 HemisphereLight 打底
 *
 * 项目是 4 级卡通着色（NoToneMapping + gradientMap），HemisphereLight 会把
 * 每一档色阶整体抬亮一截，暗部就不再有"最暗那一级"，画面立刻回到"白天"。
 * 平行光只影响朝向它的小半面，于是**暗部真的能黑**，同时亮部还能保住分级。
 * 暗部的可读性交给边缘光（rim）和地面反光，不靠环境光。
 *
 * ## 关于月亮压到 18°
 *
 * 高角度月光会把地面当正面照亮 —— dot(up, light) 接近 1，整块地皮吃满亮度，
 * 观感就是"阴天的白天"。18° 时地皮只吃到 0.31，而竖直面（墙、箱子、玩家）
 * 侧向吃光，于是地上是暗的、立起来的东西是亮的 —— 这正是夜里唯一的光比
 * 关系，也是《猎杀：对决》那种"只能看见剪影"的读数方式。
 *
 * ## 暗角/冷调搬到了 postfx
 *
 * 这里仍然保留那份 MultiplyBlending 的全屏面片，但 `visible = false`：
 * 现在世界先进入 HDR 浮点 RT，暗角与冷调必须在线性光里、色调映射之前做，
 * 才能让高光沿 AgX 的肩膀滚落。这里再乘一次只会把四角压成死黑。
 *
 * ## 性能红线（新增 draw call / 三角面）
 *
 * 天空球 1 call（星、月、云全在同一份 shader 里，不贴图）
 * 地面雾 1 call（六片 billboard 合成一个 BufferGeometry，实例化靠顶点属性）
 * 萤火虫 1 call（Points）
 * 后期面片 0 call（保留对象但 visible=false）
 * 合计 3 个 draw call、约 600 三角面。所有这些材质显式关掉
 * castShadow/receiveShadow —— 月光阴影已经打开，天空/雾/萤火虫不该参与。
 */

import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  Mesh,
  MultiplyBlending,
  PlaneGeometry,
  PointLight,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three'
import type { PerspectiveCamera, Scene } from 'three'

// ---------------------------------------------------------------- 调色板与常量

/** 月光。冷蓝是骨架：暖色只允许来自火盆和地平线余晖，两色一混就没夜味了。 */
const MOON_COLOR = 0x93a7c4
/**
 * 月光强度。默认场景实测中央区中位数只有 41–54/255，太暗；抬到 1.15 后
 * 仍保留"冷蓝夜色"，但暗部不再糊成一块。玩家可通过设置里的亮度再微调。
 */
const MOON_INTENSITY = 1.3
/** 月亮高度角（度）。理由见文件头。 */
const MOON_ELEVATION = 18
/** 天空散射补光：从月亮反方向、更高处来，模拟被月光照亮的半空散射。 */
const SKY_FILL_COLOR = 0x3d5270
/** 补光必须显著弱于主光，否则两个方向各照一半，光比没了，画面又平又亮。 */
const SKY_FILL_INTENSITY = 0.58
/** 边缘光：从摄像机后上方打，冷白，专门把轮廓从黑背景里勾出来。 */
const RIM_COLOR = 0xc8dcff
const RIM_INTENSITY = 0.55
/** 边缘光相对相机的方向（世界空间，单位向量偏置）：略高、略偏一侧。 */
const RIM_BACK = 0.86
const RIM_UP = 0.34

/** 地面雾：六片，围绕相机在一个 2R 的格子里 mod 循环，永远跟着玩家。 */
const MIST_RADIUS = 26
const MIST_COUNT = 6
/** 萤火虫数量。几十个就够给暗处一个尺度参照，再多就变圣诞树。 */
const FIREFLY_COUNT = 48
const FIREFLY_RADIUS = 15
/**
 * 点精灵的像素换算系数，按 1080p 标定：pointSize = uPixel * size / dist。
 * 本来应该用 viewport 高度算，但 update 只拿得到 camera，拿不到渲染尺寸；
 * 与其为此要求调用方再喂一个 setViewport，不如把结果 clamp 在 1~6px ——
 * 萤火虫本来就是 1~4px 的点，"分辨率变了只是点显得略大/略小"完全可以接受。
 */
const FIREFLY_PIXEL = 1100

/** 1D value noise：火光闪烁要平滑，不能用白噪声（白噪声是电视雪花）。 */
function hash1(seed: number): number {
  const s = Math.sin(seed * 127.1) * 43758.5453
  return s - Math.floor(s)
}

function noise1(t: number): number {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  return hash1(i) * (1 - u) + hash1(i + 1) * u
}

export interface AtmosphereOptions {
  /** 夜空基调色。天顶、地平线、云的暗部都从它派生，默认 0x0a1424（深蓝黑）。 */
  tint?: number
  /**
   * 月亮方位角（度，0 = +Z，绕 Y 轴，相机默认朝 -Z）。
   *
   * 默认 149：月亮在视野前方偏右 35°、贴着地平线的位置。之所以不用"月亮在
   * 背后"（-38，让正面受光），是因为那样天空里根本看不到月亮盘 —— 而一个
   * 低垂的月盘正是这个夜空唯一的高光锚点。代价是物体的正面不再直接受月光，
   * 得靠边缘光和地面反光把轮廓拉出来（也正是《猎杀》里的读数方式：看得见
   * 剪影和边缘，看不见正面细节）。
   */
  moonAzimuth?: number
  /** 月亮高度角（度）。默认 18；调高会把地面照亮，见文件头。 */
  moonElevation?: number
  /** 萤火虫数量，0 = 关闭。默认 48。 */
  fireflies?: number
  /** 地面雾片数，0 = 关闭。默认 6。 */
  mistPatches?: number
}

/** 火盆句柄。返回的 PointLight 本身已经挂进 root，调用方可以随时改位置。 */
export interface FireLight {
  readonly light: PointLight
  /** 基准强度（闪烁围绕它上下浮动），运行时可改。 */
  setIntensity(value: number): void
  setColor(color: number): void
}

export interface Atmosphere {
  readonly root: Group
  /**
   * 天空球。环境探针（environment.ts）会 clone 它烘 IBL；外部不要改它的
   * 变换/材质，只当作一个可复制的视觉源。
   */
  readonly sky: Mesh
  /**
   * 主光（月光）。渲染器要用它开启实时阴影，并让阴影相机跟着玩家走。
   * 暴露对象而不是复制一份方向：灯的 position/target 每帧由本模块维护，
   * 外部只读。
   */
  readonly keyLight: DirectionalLight
  /** 月光方向（单位向量，世界空间，指向光源）。给材质层的高光方向用。 */
  readonly moonDirection: Vector3
  /**
   * 每帧调用。
   *
   * dt 用来推进内部"状态型"动画（火光闪烁、雾片漂移的积分），time 用来驱动
   * 与绝对时钟同步的部分（云带、星点闪烁、萤火虫漫游 —— 这些是纯函数，
   * time 从 0 跳回任意值都不会在画面上留下痕迹）。
   */
  update(dt: number, camera: PerspectiveCamera, time: number): void
  /** 关卡切换时把雾颜色/密度灌进来（同时把天空地平线对齐到同一颜色）。 */
  setLevel(fogColor: number, fogDensity: number): void
  /**
   * 实时阴影档位。0 = 关闭，1024/2048 = 贴图边长。
   * 弱 GPU/核显上关掉阴影是提升帧率最直接的一档。
   */
  setShadowQuality(size: number): void
  /** 按关卡坐标摆一个火盆，返回可继续操作的句柄。color 默认 0xff9a45。 */
  addFireLight(pos: Vector3 | { x: number; y: number; z: number }, color?: number): FireLight
  dispose(): void
}

/** 转成线性空间的 Color（new Color(hex) 默认按 sRGB 解释，正是我们要的）。 */
function lin(hex: number): Color {
  return new Color(hex)
}

export function createAtmosphere(scene: Scene, options: AtmosphereOptions = {}): Atmosphere {
  const tint = new Color(options.tint ?? 0x0a1424)
  const moonAzimuth = ((options.moonAzimuth ?? 149) * Math.PI) / 180
  const moonElevation = ((options.moonElevation ?? MOON_ELEVATION) * Math.PI) / 180

  const root = new Group()
  root.name = 'atmosphere'
  root.matrixAutoUpdate = true
  scene.add(root)

  /** 统一登记释放：几何体 / 材质都只在这里 new，也只在这里 dispose。 */
  const disposables: { dispose(): void }[] = []

  // 复用同一批临时对象：update 每帧跑，不能在这里分配。
  const tmpDir = new Vector3()
  const tmpRight = new Vector3()
  const tmpUp = new Vector3()
  // 阴影 texel 对齐用的光空间基（每帧复用，不在 update 里分配）。
  const shadowRight = new Vector3()
  const shadowUp = new Vector3()
  const shadowAnchor = new Vector3()
  const tmpColor = new Color()
  const moonDir = new Vector3(
    Math.sin(moonAzimuth) * Math.cos(moonElevation),
    Math.sin(moonElevation),
    Math.cos(moonAzimuth) * Math.cos(moonElevation),
  ).normalize()

  // ------------------------------------------------------------------ 雾
  //
  // 复用场景里已有的 FogExp2 实例（render.ts 会先建一个）：setLevel 只改
  // .color/.density，不换对象，这样调用方拿着的引用不会被悄悄换掉，也不会
  // 每换一关多一份垃圾。
  const existingFog = scene.fog
  const fog = existingFog instanceof FogExp2 ? existingFog : new FogExp2(0x232c35, 0.019)
  scene.fog = fog

  // ------------------------------------------------------------------ 天空
  //
  // 一块反着看的大球。所有东西（渐变、月盘、光晕、星、云）都在同一个
  // fragment 里算完 —— 独立 sprite 会把 draw call 从 1 变成十个，而这些
  // 元素本来就用不着各自的变换。
  const skyUniforms = {
    uZenith: { value: new Color() },
    uHorizon: { value: new Color() },
    uBelow: { value: new Color() },
    uEmber: { value: new Color(0x4a2a14) },
    uMoonDir: { value: moonDir.clone() },
    uMoonColor: { value: lin(MOON_COLOR).multiplyScalar(1.35) },
    uCloudDark: { value: new Color() },
    uCloudLit: { value: new Color() },
    uTime: { value: 0 },
  }

  const skyMaterial = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    // 天空自己就是"最远的那一层"，再叠一次指数雾只会把它抹成纯色。
    depthTest: false,
    fog: false,
    uniforms: skyUniforms,
    vertexShader: [
      'varying vec3 vDir;',
      'void main() {',
      '  vDir = normalize(position);',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uZenith;',
      'uniform vec3 uHorizon;',
      'uniform vec3 uBelow;',
      'uniform vec3 uEmber;',
      'uniform vec3 uMoonDir;',
      'uniform vec3 uMoonColor;',
      'uniform vec3 uCloudDark;',
      'uniform vec3 uCloudLit;',
      'uniform float uTime;',
      'varying vec3 vDir;',
      'float skyHash(vec2 p) {',
      '  p = fract(p * vec2(127.1, 311.7));',
      '  p += dot(p, p + 34.7);',
      '  return fract(p.x * p.y);',
      '}',
      'float skyNoise(vec2 p) {',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), f.x),',
      '             mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), f.x), f.y);',
      '}',
      'void main() {',
      '  vec3 d = normalize(vDir);',
      '  float h = d.y;',
      '  // 天顶到地平线：0.42 次幂让亮带收在地平线附近一小圈，抬头就是深蓝黑。',
      '  // 指数越小越"贴地"，0.42 时 25 度仰角已经吃掉六成亮带，不会糊成灰穹顶。',
      '  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));',
      '  // 相机往下看时（枪口朝地）也得有东西，不能是纯黑。',
      '  col = mix(col, uBelow, smoothstep(0.0, -0.45, h));',
      '  // 地平线余晖：太阳早就没了，只剩远处城镇/沼泽甲烷火的一点暖。',
      '  // 只加不减，且颜色本身很暗（0x4a2a14），所以不会把夜空染成黄昏。',
      '  col += uEmber * exp(-max(h, -0.1) * 20.0);',
      '  float md = max(dot(d, uMoonDir), 0.0);',
      '  // 月盘半径：acos(0.99975) ~= 1.3 度，比真实的 0.5 度大一圈 —— 游戏里的',
      '  // 月亮就是要一眼认出是月亮，写实的尺寸在 1080p 上只有 8 个像素。',
      '  float disc = smoothstep(0.99975, 0.99988, md);',
      '  float halo = pow(md, 480.0) * 0.60 + pow(md, 26.0) * 0.055;',
      '  if (h > -0.02) {',
      '    // 星点：把方向投到经纬网格上，每格一个 hash 决定有没有星、星在格子里的位置。',
      '    // 不用贴图、不用顶点，密度是均匀的，而且成本只有两次三角函数。',
      '    vec2 sc = vec2(atan(d.z, d.x) * 9.0, asin(clamp(h, -1.0, 1.0)) * 9.0);',
      '    vec2 cell = floor(sc);',
      '    vec2 f = fract(sc);',
      '    float r = skyHash(cell);',
      '    vec2 jit = vec2(skyHash(cell + 3.7), skyHash(cell + 19.1));',
      '    // 10% 的格子有星：约 150 颗撒满全天，抬头看是"稀疏"而不是"星尘"。',
      '    float star = smoothstep(0.100, 0.020, length(f - jit)) * step(0.900, r);',
      '    star *= (0.50 + 0.50 * skyHash(cell + 41.3)) * (0.7 + 0.3 * sin(uTime * 1.9 + r * 63.0));',
      '    // 贴地平线的星被大气吃掉：没有这一项，星会一路撒到雾里，假得很明显。',
      '    star *= smoothstep(0.03, 0.28, h);',
      '    col += uMoonColor * star * 1.70;',
      '    // 云带：把视线投到一张虚拟平面上取两层 value noise，云因此自动朝地平线',
      '    // 收敛（越远越密），这正是真实层云的透视。0.006 的漂移速度 = 几乎不动，',
      '    // 但盯着看能发现它在走。',
      '    vec2 cp = d.xz / max(h + 0.16, 0.06);',
      '    float drift = uTime * 0.006;',
      '    float n = skyNoise(cp * 0.42 + vec2(drift, drift * 0.35)) * 0.62',
      '            + skyNoise(cp * 1.15 + vec2(-drift * 1.7, drift)) * 0.38;',
      '    float cloud = smoothstep(0.50, 0.70, n) * smoothstep(-0.02, 0.14, h);',
      '    // 云的暗部比天顶还暗：夜里的云是"更黑的一块"，只有被月亮照到的边缘发亮。',
      '    vec3 cloudCol = mix(uCloudDark, uCloudLit, smoothstep(0.05, 0.6, h));',
      '    cloudCol += uMoonColor * pow(md, 6.0) * 0.16;',
      '    col = mix(col, cloudCol, cloud * 0.72);',
      '  }',
      '  col += uMoonColor * (disc * 3.2 + halo);',
      '  gl_FragColor = vec4(col, 1.0);',
      '  // 必须手动做线性 -> sRGB：ShaderMaterial 不会自动补这一步（见 render.ts 同名注释）。',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  })

  const skyGeometry = new SphereGeometry(320, 24, 12)
  const sky = new Mesh(skyGeometry, skyMaterial)
  sky.name = 'atmosphere.sky'
  // 背景必须先画、且不能写深度（它身后什么都没有）。
  sky.renderOrder = -1000
  sky.frustumCulled = false
  sky.castShadow = false
  sky.receiveShadow = false
  root.add(sky)
  disposables.push(skyGeometry, skyMaterial)

  // ------------------------------------------------------------------ 地面雾
  //
  // 六片 billboard 合成**一个** BufferGeometry，用一个 ShaderMaterial 画。
  // 不用 InstancedMesh 是因为自定义 shader 里要自己乘 instanceMatrix（还得
  // 处理 USE_INSTANCING 宏），而这里只是 6 个四边形 —— 顶点属性更直接。
  const mistPatches = Math.max(0, Math.floor(options.mistPatches ?? MIST_COUNT))
  const mistPositions = new Float32Array(mistPatches * 4 * 3)
  const mistBase = new Float32Array(mistPatches * 4 * 3)
  const mistMotion = new Float32Array(mistPatches * 4 * 4)
  const mistCorner = new Float32Array(mistPatches * 4 * 2)
  const mistIndex = new Uint16Array(mistPatches * 6)
  const mistSeed = hash1(7.31)
  for (let i = 0; i < mistPatches; i++) {
    // 均匀撒在半径 R 的格子里（不是圆盘）：格子是 mod 循环的周期，圆形分布会
    // 在四个角留空，转身时能看到明显的空洞。
    const px = (hash1(i * 3.7 + mistSeed) * 2 - 1) * MIST_RADIUS
    const pz = (hash1(i * 11.3 + 2.1) * 2 - 1) * MIST_RADIUS
    // y 落在 0.6~1.1：雾要糊住地面和膝盖高度，太高就变成天上的云。
    const py = 0.6 + hash1(i * 5.9 + 4.4) * 0.5
    const sx = 9 + hash1(i * 7.7 + 9.2) * 8
    const sy = 1.5 + hash1(i * 2.3 + 13.6) * 1.1
    // 每片自己的风向与速度：0.1~0.25 m/s，慢到像"没在动但确实在动"。
    const vx = (hash1(i * 17.1 + 5.5) * 2 - 1) * 0.22
    const vz = (hash1(i * 23.3 + 8.8) * 2 - 1) * 0.22
    for (let c = 0; c < 4; c++) {
      const vi = i * 4 + c
      mistCorner[vi * 2] = c === 0 || c === 3 ? -1 : 1
      mistCorner[vi * 2 + 1] = c < 2 ? -1 : 1
      mistBase[vi * 3] = px
      mistBase[vi * 3 + 1] = py
      mistBase[vi * 3 + 2] = pz
      mistMotion[vi * 4] = vx
      mistMotion[vi * 4 + 1] = vz
      mistMotion[vi * 4 + 2] = sx
      mistMotion[vi * 4 + 3] = sy
    }
    // 顺序 0-1-2 / 0-2-3（逆时针），Billboard 双面可见所以顺序不致命。
    mistIndex[i * 6] = i * 4
    mistIndex[i * 6 + 1] = i * 4 + 2
    mistIndex[i * 6 + 2] = i * 4 + 1
    mistIndex[i * 6 + 3] = i * 4
    mistIndex[i * 6 + 4] = i * 4 + 3
    mistIndex[i * 6 + 5] = i * 4 + 2
  }
  // positions 只是为了让 three 知道有顶点（真正的坐标在 shader 里算），
  // 全部塞原点会让 boundingSphere 变成一个点 —— 所以必须关掉视锥剔除。
  mistPositions.set(mistBase)

  const mistGeometry = new BufferGeometry()
  mistGeometry.setAttribute('position', new BufferAttribute(mistPositions, 3))
  mistGeometry.setAttribute('aBase', new BufferAttribute(mistBase, 3))
  mistGeometry.setAttribute('aMotion', new BufferAttribute(mistMotion, 4))
  mistGeometry.setAttribute('aCorner', new BufferAttribute(mistCorner, 2))
  mistGeometry.setIndex(new BufferAttribute(mistIndex, 1))

  const mistUniforms = {
    uColor: { value: new Color(0x6f8298) },
    uOpacity: { value: 0.10 },
    uTime: { value: 0 },
    uRadius: { value: MIST_RADIUS },
  }

  const mistMaterial = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // 双面：转身穿过一片雾时不能突然消失。
    side: DoubleSide,
    fog: false,
    blending: AdditiveBlending,
    uniforms: mistUniforms,
    vertexShader: [
      'attribute vec3 aBase;',
      'attribute vec4 aMotion;',
      'attribute vec2 aCorner;',
      'uniform float uTime;',
      'uniform float uRadius;',
      'varying vec2 vUv;',
      'varying vec3 vWorld;',
      'varying float vFade;',
      'void main() {',
      '  // 世界坐标里漂移 + 以相机为中心的 mod 循环：雾片永远在玩家周围，',
      '  // 但看得到的那几片（<26m）从不参与循环跳变（跳变点在 26m 之外且已淡化）。',
      '  vec3 center = aBase;',
      '  vec2 camXZ = cameraPosition.xz;',
      '  vec2 raw = aBase.xz + aMotion.xy * uTime - camXZ + uRadius;',
      '  center.xz = mod(raw, 2.0 * uRadius) - uRadius + camXZ;',
      '  // 相机朝右/朝上的基向量（viewMatrix 旋转部分的行）。',
      '  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);',
      '  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);',
      '  vec3 world = center + right * (aCorner.x * aMotion.z) + up * (aCorner.y * aMotion.w);',
      '  vUv = aCorner * 0.5 + 0.5;',
      '  vWorld = world;',
      '  float dist = distance(world, cameraPosition);',
      '  // 近处淡出：贴脸的雾会糊满屏幕，而且也会吃掉准星附近的所有信息。',
      '  // 远处淡出：让 mod 循环的重置点永远在看不见的地方。',
      '  vFade = smoothstep(2.0, 7.0, dist) * (1.0 - smoothstep(17.0, 25.0, dist));',
      '  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uColor;',
      'uniform float uOpacity;',
      'uniform float uTime;',
      'varying vec2 vUv;',
      'varying vec3 vWorld;',
      'varying float vFade;',
      'float mistHash(vec2 p) {',
      '  p = fract(p * vec2(127.1, 311.7));',
      '  p += dot(p, p + 34.7);',
      '  return fract(p.x * p.y);',
      '}',
      'float mistNoise(vec2 p) {',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(mistHash(i), mistHash(i + vec2(1.0, 0.0)), f.x),',
      '             mix(mistHash(i + vec2(0.0, 1.0)), mistHash(i + vec2(1.0, 1.0)), f.x), f.y);',
      '}',
      'void main() {',
      '  // 四边软边：硬边的四边形无论多亮都会读成"一块板"。',
      '  float edge = smoothstep(0.0, 0.30, vUv.x) * smoothstep(1.0, 0.70, vUv.x)',
      '             * smoothstep(0.0, 0.36, vUv.y) * smoothstep(1.0, 0.46, vUv.y);',
      '  // 云絮：世界空间取噪点，所以雾片平移时纹理会"流过"平面而不是整块滑动。',
      '  float drift = uTime * 0.05;',
      '  float wisp = mistNoise(vWorld.xz * 0.22 + vec2(drift, drift * 0.6)) * 0.65',
      '             + mistNoise(vWorld.xz * 0.62 - vec2(drift * 1.4, -drift)) * 0.35;',
      '  float a = uOpacity * edge * vFade * smoothstep(0.30, 0.78, wisp);',
      '  if (a < 0.003) discard;',
      '  gl_FragColor = vec4(uColor, a);',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  })

  const mistGeometryMesh = new Mesh(mistGeometry, mistMaterial)
  mistGeometryMesh.name = 'atmosphere.mist'
  mistGeometryMesh.frustumCulled = false
  mistGeometryMesh.castShadow = false
  mistGeometryMesh.receiveShadow = false
  // 雾在实体之后、后期之前画。
  mistGeometryMesh.renderOrder = 10
  root.add(mistGeometryMesh)
  disposables.push(mistGeometry, mistMaterial)

  // ------------------------------------------------------------------ 萤火虫
  const fireflyCount = Math.max(0, Math.floor(options.fireflies ?? FIREFLY_COUNT))
  const ffBase = new Float32Array(fireflyCount * 3)
  const ffMotion = new Float32Array(fireflyCount * 4)
  const ffPhaseY = new Float32Array(fireflyCount)
  for (let i = 0; i < fireflyCount; i++) {
    ffBase[i * 3] = (hash1(i * 3.1 + 1.7) * 2 - 1) * FIREFLY_RADIUS
    // 只在 0.35~1.5m 之间：这是"贴着沼泽水面飞"的高度，也是玩家视线下方
    // 最好用的尺度参照 —— 远处一片黑的时候，靠它们判断对面箱子有多远。
    ffBase[i * 3 + 1] = 0.35 + hash1(i * 7.9 + 3.3) * 1.15
    ffBase[i * 3 + 2] = (hash1(i * 13.7 + 5.1) * 2 - 1) * FIREFLY_RADIUS
    ffMotion[i * 4] = 0.5 + hash1(i * 19.3 + 2.2) * 1.1
    ffMotion[i * 4 + 1] = 0.5 + hash1(i * 23.7 + 8.4) * 1.1
    ffMotion[i * 4 + 2] = hash1(i * 29.1 + 4.6)
    ffMotion[i * 4 + 3] = 0.028 + hash1(i * 31.7 + 6.8) * 0.026
    ffPhaseY[i] = hash1(i * 37.3 + 9.9)
  }

  const ffGeometry = new BufferGeometry()
  ffGeometry.setAttribute('position', new BufferAttribute(ffBase, 3))
  ffGeometry.setAttribute('aBase', new BufferAttribute(ffBase, 3))
  ffGeometry.setAttribute('aMotion', new BufferAttribute(ffMotion, 4))
  ffGeometry.setAttribute('aPhaseY', new BufferAttribute(ffPhaseY, 1))

  const ffUniforms = {
    uColor: { value: new Color(0xe4ff86) },
    uTime: { value: 0 },
    uRadius: { value: FIREFLY_RADIUS },
    uPixel: { value: FIREFLY_PIXEL },
  }

  const ffMaterial = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // 加色：萤火虫是发光体，在暗背景上叠亮才对；用普通 alpha 会在雾里显脏。
    blending: AdditiveBlending,
    fog: false,
    uniforms: ffUniforms,
    vertexShader: [
      'attribute vec3 aBase;',
      'attribute vec4 aMotion;',
      'attribute float aPhaseY;',
      'uniform float uTime;',
      'uniform float uRadius;',
      'uniform float uPixel;',
      'varying float vAlpha;',
      'void main() {',
      '  vec3 camXZ = vec3(cameraPosition.x, 0.0, cameraPosition.z);',
      '  vec3 p = aBase;',
      '  p.xz = mod(aBase.xz - camXZ.xz + uRadius, 2.0 * uRadius) - uRadius + camXZ.xz;',
      '  // 三轴不同频率的慢速漫游：同一频率会让整群萤火虫同步摆动，像一片 LED。',
      '  float t = uTime * 0.28 + aMotion.z * 6.2831;',
      '  p.x += sin(t * 1.7 + aPhaseY * 4.0) * aMotion.x;',
      '  p.z += cos(t * 1.3 + aPhaseY * 7.0) * aMotion.y;',
      '  p.y += sin(t * 0.9 + aPhaseY * 2.0) * 0.22;',
      '  vec4 mv = viewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = clamp(uPixel * aMotion.w / max(-mv.z, 0.4), 1.6, 8.0);',
      '  // 呼吸：单个萤火虫的闪烁是"一明一灭"，不是正弦渐变，所以取三次方。',
      '  float blink = 0.22 + 0.78 * pow(0.5 + 0.5 * sin(uTime * 1.35 + aMotion.z * 31.0), 3.0);',
      '  vAlpha = blink * (1.0 - smoothstep(16.0, 26.0, -mv.z));',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vec2 q = gl_PointCoord * 2.0 - 1.0;',
      '  // 高斯核而不是硬圆：2px 的硬圆看起来是"脏点"，软核才像发光。',
      '  float core = exp(-dot(q, q) * 3.2);',
      '  float a = vAlpha * core;',
      '  if (a < 0.004) discard;',
      '  gl_FragColor = vec4(uColor, a);',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  })

  const fireflies = new Points(ffGeometry, ffMaterial)
  fireflies.name = 'atmosphere.fireflies'
  fireflies.frustumCulled = false
  fireflies.renderOrder = 20
  fireflies.castShadow = false
  fireflies.receiveShadow = false
  if (fireflyCount > 0) root.add(fireflies)
  disposables.push(ffGeometry, ffMaterial)

  // ------------------------------------------------------------------ 后期渐变
  //
  // 一个 2x2 的面片，顶点 shader 直接吐 NDC 全屏（不看 modelView），所以
  // 不关心相机、不关心长宽比，也不占额外的 RenderTarget。
  const postGeometry = new PlaneGeometry(2, 2)
  const postUniforms = {
    uAspect: { value: 1 },
    uVignette: { value: 0.30 },
    uCool: { value: 1 },
  }
  const postMaterial = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // three 的 BLEND 实现里 MultiplyBlending 走 premultiplied 分支：
    // blendFunc(ZERO, SRC_COLOR) 即 dst * src。不给这个 flag 它会只报错、
    // 不设混合方程，于是这块面片被当成不透明白色直接盖住整个画面。
    premultipliedAlpha: true,
    // MultiplyBlending：dst * src。逐通道相乘 = 暗角 + 冷调偏移一次做完，
    // 而且不改变色阶之间的相对关系（加法混合会把黑提成灰，4 级分级立刻变糊）。
    blending: MultiplyBlending,
    fog: false,
    uniforms: postUniforms,
    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = vec4(position.xy, 1.0, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform float uAspect;',
      'uniform float uVignette;',
      'uniform float uCool;',
      'varying vec2 vUv;',
      'float postHash(vec2 p) {',
      '  p = fract(p * vec2(127.1, 311.7));',
      '  p += dot(p, p + 34.7);',
      '  return fract(p.x * p.y);',
      '}',
      'void main() {',
      '  vec2 p = vUv * 2.0 - 1.0;',
      '  // 乘上长宽比才是屏幕上的圆：NDC 的 x 在宽屏上代表更多像素。',
      '  p.x *= uAspect;',
      '  float r = length(p * vec2(0.92, 1.0));',
      '  float vig = 1.0 - uVignette * smoothstep(0.55, 1.55, r);',
      '  // 冷调偏移：红压 6%，蓝抬 4%。抬过 1.0 的部分在 8bit framebuffer 上',
      '  // 被 clamp，表现就是"高光偏青"，正是月光该有的样子。',
      '  vec3 cool = mix(vec3(1.0), vec3(0.94, 0.985, 1.045), uCool);',
      '  // 抖动：这段渐变跨越 ~40 个亮度级，8bit 直出会看到一圈圈色带。',
      '  // 一层 +-0.5/255 的高频噪声就能把它藏起来，成本是一次 hash。',
      '  float dither = (postHash(gl_FragCoord.xy) - 0.5) * 0.0039;',
      '  gl_FragColor = vec4(cool * vig + dither, 1.0);',
      '  // 这里**不能**做线性->sRGB：这个面片输出的是"乘数"，乘法发生在已经',
      '  // 编码好的 framebuffer 上。做了编码，0.58 的暗角会被抬到 0.79，',
      '  // 暗角基本上就消失了。',
      '}',
    ].join('\n'),
  })
  const post = new Mesh(postGeometry, postMaterial)
  post.name = 'atmosphere.post'
  post.frustumCulled = false
  // 最后画：所有透明物（雾、萤火虫）之后。
  post.renderOrder = 5000
  post.castShadow = false
  post.receiveShadow = false
  // 暗角/冷调/抖动已经搬进 postfx.ts 的 HDR 合成（在线性光里做，高光滚落
  // 才正确）。这里保留对象但不画：双重暗角会把已经偏暗的沼泽压成一团黑。
  post.visible = false
  root.add(post)
  disposables.push(postGeometry, postMaterial)

  // ------------------------------------------------------------------ 光照

  // 主光：冷蓝月光，低角度。castShadow 一律关掉 —— 项目里 shadowMap 就是
  // 关的，开一个 shadow camera 只会白烧一个 pass。
  const moon = new DirectionalLight(MOON_COLOR, MOON_INTENSITY)
  moon.position.copy(moonDir).multiplyScalar(120)
  // 实时阴影：一盏跟随玩家的紧密正交阴影相机，2048 覆盖约 100m。
  //
  // 以前 shadowMap 是关的，靠贴地黑片假装接触阴影。但在一个"看剪影"的夜战
  // 游戏里，物体与地面的接触线是判断距离和掩体关系的主要线索 —— 没有它，
  // 箱子和角色像贴纸一样浮在地上，画面再清晰也读不出空间。
  //
  // 阴影相机不覆盖整张 90m 地图，而是每帧跟着玩家（见 update 里 moon 的
  // position/target 跟随）：2048 张 100m 是 5cm/texel，阴影边缘才有轮廓；
  // 覆盖 200m 会糊成一片灰。方向不变，所以太阳角度/明暗关系仍然稳定。
  moon.castShadow = true
  moon.shadow.mapSize.set(2048, 2048)
  const shadowCam = moon.shadow.camera
  shadowCam.left = -52
  shadowCam.right = 52
  shadowCam.top = 52
  shadowCam.bottom = -52
  shadowCam.near = 1
  shadowCam.far = 260
  shadowCam.updateProjectionMatrix()
  moon.shadow.bias = -0.0007
  // normalBias 是这套几何的必需品：纯 bias 会在地面与墙的交界处留下漏光的细线。
  // 写实档给关卡加了法线贴图后，0.035（按平面卡通几何调的）会让 PBR 表面
  // 出现大片自阴影斑点（shadow acne）；0.12 是"墙脚不浮空、墙面不斑点"的
  // 折中，仍要在独显上按实际 texel 尺寸复测。
  moon.shadow.normalBias = 0.12
  moon.shadow.radius = 2.5
  root.add(moon)
  root.add(moon.target)

  // 天空散射：从月亮反方向、更高处来。它唯一的作用是让"背光的竖直面"从
  // 纯黑里浮出来一点点，强度必须低到看不出它在哪边，只觉着"空气里有光"。
  const skyFill = new DirectionalLight(SKY_FILL_COLOR, SKY_FILL_INTENSITY)
  skyFill.position.set(-moonDir.x * 60, 90, -moonDir.z * 60)
  skyFill.castShadow = false
  root.add(skyFill)
  root.add(skyFill.target)

  // 边缘光：方向**每帧**贴着相机重算（后上方），所以它永远打在物体的轮廓
  // 远端，等于一盏廉价的 rim light。平行光没有"角度"参数，用精确的反向
  // 方向 + 略高的仰角模拟小角度光的效果；强度 0.62 是被 toon 分级吃掉的
  // 上限 —— 再高就会把暗部整体照亮，轮廓反而不突出了。
  const rim = new DirectionalLight(RIM_COLOR, RIM_INTENSITY)
  rim.castShadow = false
  root.add(rim)
  root.add(rim.target)

  // 极低的环境光：只负责把"背光面"从纯黑抬到能看出轮廓，不参与形体的
  // 方向性（0.22 在四档 toon 里通常只抬最低一档）。没有它时，玩家正对
  // 的墙/箱子经常是一块纯黑，连掩体在哪都读不出来。
  const ambient = new AmbientLight(0x2f4257, 0.28)
  root.add(ambient)

  // ------------------------------------------------------------------ 火光
  const fires: {
    light: PointLight
    base: number
    seed: number
    cold: Color
    hot: Color
  }[] = []
  const fireHandles = new WeakMap<PointLight, FireLight>()

  function addFireLight(
    pos: Vector3 | { x: number; y: number; z: number },
    color = 0xff9a45,
  ): FireLight {
    // 火盆灯不用平行光：火焰是有位置的局部光源，distance/decay 让它的影响
    // 半径有限（14m），否则地图上四五个火盆会把整张图抬成黄昏。
    const light = new PointLight(color, 6, 14, 2)
    light.position.set(pos.x, pos.y, pos.z)
    light.castShadow = false
    root.add(light)

    const entry = {
      light,
      base: 6,
      // 每盏火盆一个固定相位：不同火盆不能同步跳动，同步就变成"整盏灯在闪"。
      seed: fires.length * 17.31 + 3.7,
      cold: new Color(0xff6a1e),
      hot: new Color(0xffc07a),
    }
    fires.push(entry)

    const handle: FireLight = {
      light,
      setIntensity(value: number): void {
        entry.base = value
      },
      setColor(value: number): void {
        entry.cold.setHex(value)
        entry.hot.setHex(value)
      },
    }
    fireHandles.set(light, handle)
    return handle
  }

  // ------------------------------------------------------------------ 关卡参数
  let fogColorHex = 0x232c35

  function setLevel(fogColor: number, fogDensity: number): void {
    fogColorHex = fogColor
    // 直接吃关卡给的雾颜色/密度：雾本身就是"远景要糊成什么颜色"的定义，
    // 在这里再压暗一次会让关卡美术失去对远景的控制权。
    fog.color.setHex(fogColor)
    fog.density = fogDensity

    // 天空地平线对齐到雾色：远景物体淡出成雾色，如果天空那一圈比雾色亮很多，
    // 就会看到一条"地平线台阶"。对齐之后远景是一块连续的冷蓝黑，
    // 暖色余晖只在最底下一小条叠加，不会盖过雾色。
    skyUniforms.uHorizon.value.setHex(fogColor).multiplyScalar(1.25)
    skyUniforms.uBelow.value.setHex(fogColor).multiplyScalar(0.55)
    // 天顶：关卡的雾色往下压到 0.22，再往 tint（深蓝黑）混 62%。这两步是
    // "别让天空变成灰穹顶"的关键 —— 雾色本身是给远景用的中间调，直接当天顶
    // 会得到一整片灰蓝，抬头看不见黑。
    skyUniforms.uZenith.value
      .copy(tmpColor.setHex(fogColor).multiplyScalar(0.22))
      .lerp(tint, 0.62)
    // 云的暗部 = 天顶再暗一点（夜里的云是"更黑的一块"）。
    skyUniforms.uCloudDark.value.copy(skyUniforms.uZenith.value).multiplyScalar(0.75)
    // 云的亮部只比暗部亮一点点：真正的亮边由 shader 里 pow(md,6) 那一项
    // 在月亮附近加上去，如果底色就提得很亮，云会变成一片铺满天空的灰布，
    // 星星全被盖住（第一版就是这么错的）。
    skyUniforms.uCloudLit.value
      .copy(tmpColor.setHex(fogColor).multiplyScalar(0.62))
      .lerp(tmpColor.setHex(MOON_COLOR).multiplyScalar(0.30), 0.25)

    // 地面雾：比雾色亮，否则它跟远景糊成一片，看不出"贴地的水汽"。
    mistUniforms.uColor.value
      .setHex(fogColor)
      .lerp(tmpColor.setHex(MOON_COLOR).multiplyScalar(0.8), 0.45)
      .multiplyScalar(1.55)
  }

  function setShadowQuality(size: number): void {
    const px = Math.max(0, Math.floor(size))
    if (px <= 0) {
      moon.castShadow = false
      if (moon.shadow.map) {
        moon.shadow.map.dispose()
        moon.shadow.map = null
      }
      return
    }
    if (moon.shadow.mapSize.x !== px || moon.shadow.mapSize.y !== px) {
      moon.shadow.mapSize.set(px, px)
      // 改 mapSize 必须丢掉旧的 RenderTarget，否则 three 会继续复用旧尺寸。
      if (moon.shadow.map) {
        moon.shadow.map.dispose()
        moon.shadow.map = null
      }
    }
    moon.castShadow = true
  }

  setLevel(0x232c35, 0.019)

  // ------------------------------------------------------------------ 每帧

  // 内部累计时钟：dt 驱动的部分（火光、雾漂移）用自己的积分，这样即便外部
  // 时间轴在关卡重建时归零，闪烁也不会被"重置成一模一样"。
  let clock = 0
  let moonNoisePhase = 0

  function update(dt: number, camera: PerspectiveCamera, time: number): void {
    const step = Math.min(Math.max(dt, 0), 0.1)
    clock += step

    // 阴影相机跟着玩家：方向不变，只平移光源与目标。
    //
    // 必须做 texel 对齐。正交阴影相机的光栅只认 texel 网格；目标点跟着相机
    // 连续移动时，同一根柱子会每帧落在不同 texel 的亚像素位置上，边缘就会
    // 爬行/闪烁。做法是把目标点在光空间里的 right/up 分量量化到 texel，
    // 只平移、不转方向；光源位置由对齐后的目标点重新推导，方向严格不变。
    moon.target.position.copy(camera.position)
    if (moon.castShadow && moon.shadow.mapSize.x > 0) {
      // 光空间基：backward = 从目标指向光源；right = up × backward（与 three
      // 的 Matrix4.lookAt 一致），up = backward × right。用世界 up 兜底。
      shadowRight.crossVectors(tmpUp.set(0, 1, 0), moonDir)
      if (shadowRight.lengthSq() > 1e-8) {
        shadowRight.normalize()
        shadowUp.crossVectors(moonDir, shadowRight).normalize()
        // 一个 shadow texel 对应的世界距离。正交相机宽度 / 贴图分辨率。
        const texel = (shadowCam.right - shadowCam.left) / moon.shadow.mapSize.x
        if (texel > 1e-6) {
          const r = moon.target.position.dot(shadowRight)
          const u = moon.target.position.dot(shadowUp)
          const dr = Math.round(r / texel) * texel - r
          const du = Math.round(u / texel) * texel - u
          moon.target.position
            .addScaledVector(shadowRight, dr)
            .addScaledVector(shadowUp, du)
        }
      }
    }
    moon.position.copy(moon.target.position).addScaledVector(moonDir, 120)
    moon.target.updateMatrixWorld()
    // 外部 time 若不可用（比如某些测试里传 0），退化成内部时钟。
    const t = Number.isFinite(time) && time > 0 ? time : clock

    skyUniforms.uTime.value = t
    mistUniforms.uTime.value = t
    ffUniforms.uTime.value = t
    sky.position.copy(camera.position)

    // 后期：暗角需要长宽比才不歪。
    postUniforms.uAspect.value = camera.aspect

    // 边缘光每帧贴相机：取相机后方向再抬一点，光源方向就是"从摄像机后方上方
    // 打过来"。目标点跟着相机走，于是方向恒定与世界位置无关。
    camera.getWorldDirection(tmpDir)
    tmpDir.negate()
    tmpUp.set(0, 1, 0)
    tmpRight.crossVectors(tmpDir, tmpUp).normalize()
    rim.position
      .copy(camera.position)
      .addScaledVector(tmpDir, 40 * RIM_BACK)
      .addScaledVector(tmpUp, 40 * RIM_UP)
      .addScaledVector(tmpRight, 8)
    rim.target.position.copy(camera.position)

    // 云遮月：月光强度缓慢起伏 8%。这是"月亮在云后面走"的廉价替身，
    // 静态强度会让整个场景看起来像一张打光好的照片，完全没有时间感。
    moonNoisePhase += step * 0.045
    const veil = 0.86 + 0.14 * (noise1(moonNoisePhase) * 0.7 + noise1(moonNoisePhase * 2.3) * 0.3)
    moon.intensity = MOON_INTENSITY * veil

    for (let i = 0; i < fires.length; i++) {
      const f = fires[i]
      // 两个不同频率的 1D value noise 相加：低频是"火势"，高频是"火苗舔动"。
      const n =
        noise1(clock * 1.9 + f.seed) * 0.62 + noise1(clock * 5.7 + f.seed * 1.7) * 0.38
      f.light.intensity = f.base * (0.74 + 0.46 * n)
      // 色温抖动：亮的时候偏金黄，弱的瞬间偏暗红 —— 这就是火焰看起来"HDR"的原因。
      f.light.color.copy(f.cold).lerp(f.hot, Math.min(Math.max(n, 0), 1))
    }
    // 雾与萤火虫全在 GPU 上算（顶点属性 + uTime），CPU 每帧零工作量。
  }

  function dispose(): void {
    for (const item of disposables) item.dispose()
    disposables.length = 0
    // 火光灯没有几何/材质，直接从 root 摘掉即可（root 移除时也会一起带走，
    // 这里显式清空引用，避免调用方还拿着句柄往死场景里塞灯）。
    for (const f of fires) f.light.removeFromParent()
    fires.length = 0
    // 只回收自己建的雾：如果场景里原本就有一份 FogExp2，那是调用方的对象。
    if (existingFog !== fog) scene.fog = existingFog ?? null
    root.removeFromParent()
    root.clear()
  }

  return {
    root,
    sky,
    keyLight: moon,
    moonDirection: moonDir,
    update,
    setLevel,
    setShadowQuality,
    addFireLight,
    dispose,
  } satisfies Atmosphere
}
