/**
 * 非碰撞装饰层：沼泽水面、芦苇、枯树、破栅栏、雾墙。
 *
 * ## 铁律：看得见的东西必须真的能穿过去
 *
 * 装饰一旦和物理各说各话，玩家会记住"那里有东西挡着我"，然后一头撞在看不见
 * 的墙上。所以这里所有摆位都从 level.boxes / level.spawns / boundsHalf 推出来：
 * 贴着盒子脚印外围和地图边界生长，永远不落进可走的出生走廊。栅栏也只做"断的"
 * —— 断桩、缺横杆、倒伏，读起来就是废墟，不会有人指望它挡子弹。
 *
 * ## 为什么用种子随机
 *
 * 摆位一旦每刷新都变，地图就会"呼吸"：玩家昨天记住的那丛芦苇今天挪了半米，
 * 靠它判断距离和身位的肌肉记忆就作废了。所以全部随机数走 mulberry32（种子由
 * 关卡 id 派生），同一个关卡每次加载长出同一片沼泽。
 *
 * ## 为什么不直接调 render.ts 的私有方法
 *
 * render.ts 归主程所有，这里只按同一套约定自己实现"4 级渐变图 + 背面墨线外壳"。
 * 渐变图在注释里标出了可以换成主程那张共享贴图的位置。
 */

import type { Scene } from 'three'
import type { LevelDef, SearchKind, SearchSpot } from '@dk/shared'

import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DodecahedronGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  PlaneGeometry,
  RedFormat,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Side,
} from 'three'

import type { ComicSurface } from './ink.ts'
import { OUTLINE_SHARED } from './outline.ts'
import { SHADOW_GEOMETRY, createShadowMaterial, createShadowTexture } from './shadows.ts'

export interface PropsOptions {
  /** 放大/缩小装饰密度，1 = 正常。低配机器可以给 0.5。 */
  density?: number
}

export interface Props {
  /** 装饰根节点。渲染器用它开/关阴影，不需要知道这里建了什么。 */
  readonly root: Group
  /** 每帧调用，推进水面波纹与飘摇的草。dt 秒。 */
  update(dt: number): void
  /**
   * 显示/隐藏程序化芦苇、枯树与树挂。GLTF 自然资产加载成功后由 render.ts
   * 调 false；加载失败时保持可见，作为回退。
   */
  setNatureVisible(visible: boolean): void
  dispose(): void
}

/**
 * 往场景里加非碰撞装饰：水面、芦苇、枯树、栅栏、木桶、雾气面片。
 * 全部是纯视觉 —— 不参与物理，服务端不知道它们存在。
 */
export function buildProps(scene: Scene, level: LevelDef, options?: PropsOptions): Props {
  const density = Math.max(0, options?.density ?? 1)
  // 种子从关卡 id 派生：换关卡换一片沼泽，同一个关卡每次刷新一模一样。
  const rng = mulberry32(0x1a2b3c4d ^ hashString(level.id))
  const bag = new GpuBag()
  const root = new Group()
  root.name = 'props'
  scene.add(root)

  // 为什么不额外摆"木桶/木箱"当装饰：关卡里那些桶和箱子本来就是 level.boxes，
  // 由 render.ts 带碰撞画出来。在这里再补一批看上去一样、却能穿过去的桶，
  // 就是这个模块最该避免的画面 —— 形状越像掩体，玩家越会去试。所以装饰只做
  // 明显不能站人的东西：水、草、枯树梢、断篱、雾。

  /**
   * 4 级渐变图：与 render.ts 的 makeGradientMap() 同源（同样的
   * [0.32, 0.58, 0.82, 1.0] 与 NearestFilter），否则两套材质的色阶边界对不上，
   * 同一张图里会出现两种分级风格。
   * 主程若要少一张贴图，把 render.ts 里那张传进 makeToon 的 gradientMap 即可。
   */
  const gradientMap = makeGradientMap()
  bag.add(gradientMap)

  // ---------------------------------------------------------------- 落位工具

  /** 到最近盒子脚印（XZ 轴对齐包围盒）的距离；盒子内部为 0。 */
  const footprintClearance = (x: number, z: number): number => {
    let best = Infinity
    for (const b of level.boxes) {
      // 旋转盒没有现成的世界 AABB，用外接圆半径做保守估计：宁可多留一点干地，
      // 也不要让芦苇长进实心墙里。
      const ex = b.rotY ? Math.hypot(b.hx, b.hz) : b.hx
      const ez = b.rotY ? Math.hypot(b.hx, b.hz) : b.hz
      const dx = Math.max(Math.abs(x - b.x) - ex, 0)
      const dz = Math.max(Math.abs(z - b.z) - ez, 0)
      const d = Math.hypot(dx, dz)
      if (d < best) best = d
    }
    return best
  }

  /** 到最近出生点的水平距离。出生点 4m 内绝对不放任何东西。 */
  const spawnClearance = (x: number, z: number): number => {
    let best = Infinity
    for (const s of level.spawns) {
      const d = Math.hypot(x - s.x, z - s.z)
      if (d < best) best = d
    }
    return best
  }

  const insideBounds = (x: number, z: number): boolean =>
    Math.abs(x) <= level.boundsHalf - 0.4 && Math.abs(z) <= level.boundsHalf - 0.4

  /** 一条摆位能不能落：出界 / 贴墙 / 出生点附近 —— 任何一个命中就否决。 */
  const placeable = (x: number, z: number, spawnRing = 4.2): boolean =>
    insideBounds(x, z) && spawnClearance(x, z) >= spawnRing && footprintClearance(x, z) >= 0.5

  /**
   * 湿度场：0 = 干地，1 = 积水。
   *
   * 三个因子相乘，缺一个就会出错：
   * - 靠边界越湿（rimWeight）：沼泽在关卡边缘，中间是农舍的干院坝；
   * - 远离盒子才湿（boxDry）：贴着掩体脚印一圈始终是踩出来的干土，否则墙根
   *   泡在水里会读成"墙浮在水面上"；
   * - 出生点附近强制干（spawnDry）：出生点淹在水里、身边全是芦苇，玩家一进场
   *   就看不清自己站哪。
   */
  const wetness = (x: number, z: number): number => {
    const rim = Math.max(Math.abs(x), Math.abs(z)) / level.boundsHalf
    const rimWeight = smoothstep(0.42, 0.98, rim)
    const pooling = clamp01((valueNoise(x * 0.085, z * 0.085) - 0.48) / 0.42)
    const boxDry = smoothstep(0.8, 5.5, footprintClearance(x, z))
    const spawnDry = smoothstep(4.4, 9.0, spawnClearance(x, z))
    return Math.min(1, Math.max(rimWeight * 0.92, pooling * 0.95)) * boxDry * spawnDry
  }

  // 装饰按生物群系分家：这不是"锦上添花"，是让玩家站在任意一处截图都能说出
  // 自己在哪张图 —— 芦苇与枯树属于沼泽，墓碑属于教堂，碎石属于采石场，铁轨属于
  // 车站。少了这一层，五张图只会是同一片沼泽换了 box 坐标。
  const biome = biomeOf(level)
  // 装饰数量按面积开方缩放：地图从 40 放到 130（面积 10 倍）后，还按 420 根芦苇
  // 摆，密度会掉到原来的十分之一，边缘直接读成空场地。
  const dens = density * Math.sqrt(Math.max(1, (level.boundsHalf / 40) ** 2))
  const swamp = biome === 'swamp'

  const water = swamp ? buildWater(root, level, bag, wetness) : null
  // 程序化芦苇/枯树/树挂单独一组：GLTF 资产加载成功后整组隐藏，
  // 不删节点、不重建材质，失败时还能原样回退。
  const natureRoot = new Group()
  natureRoot.name = 'procedural-nature'
  root.add(natureRoot)
  const reeds = swamp ? buildReeds(natureRoot, level, bag, gradientMap, rng, dens, placeable, wetness) : null
  const trees = buildDeadTrees(natureRoot, level, bag, gradientMap, rng, Math.round(6 * dens), placeable)
  buildFence(root, level, bag, gradientMap, rng, dens, placeable)
  buildBiomeProps(root, level, bag, gradientMap, rng, dens, placeable, biome)
  // 叙事静物排在群系装饰之后：它贴着墙根长，先让大件落位才不会被挤掉。
  buildNarrative(root, level, bag, gradientMap, rng, dens, placeable, biome)
  // 破布得挂在真的树上，所以树列表要从 buildDeadTrees 带出来。
  buildTreeRags(natureRoot, level, bag, gradientMap, rng, trees)
  buildFogWalls(root, level, bag, rng, density)
  buildSearchSpots(root, level, bag, gradientMap)

  let time = 0
  return {
    root,
    setNatureVisible(visible: boolean): void {
      natureRoot.visible = visible
    },
    update(dt: number): void {
      // 夹住 dt：切后台回来时 dt 可能是好几秒，草会瞬间抽一下。
      time += Math.min(Math.max(dt, 0), 0.1)
      if (water) water.time.value = time
      if (reeds) reeds.uReedTime.value = time
    },
    dispose(): void {
      scene.remove(root)
      // InstancedMesh.dispose() 只丢 instanceMatrix / instanceColor 两块缓冲，
      // 几何体与材质仍要单独释放，所以两者都登记了。
      bag.dispose()
    },
  }
}

// ------------------------------------------------------------------ 常量

/**
 * 水面：深水 / 浅滩 / 浪脊。
 *
 * 上一版是浅青绿到近白的三档，在暗色夜景里成了画面最亮的东西 —— 一片沼泽
 * 反光不该比猎人的脸还抢眼。压到墨绿蓝、只留一档冷高光，水面才退回背景。
 */
const WATER_DEEP = 0x1d2a2a
const WATER_PALE = 0x3f5652
const WATER_CREST = 0x7d968c

/** 芦苇目标数量（密度 1 时）；一整片是**一次** draw call。 */
const REED_TARGET = 420
/** 芦苇单位高度：几何体本身 1 米高，真实高度由实例缩放决定。 */
const REED_UNIT = 1

/** 枯树：只比墨线亮一档的暖褐。再暗就和描边糊成一根黑棍，读不出是树。 */
const TREE_BARK = 0x6b5641

/** 栅栏：比木箱更灰更旧，读起来是废弃物而不是可用掩体。 */
const FENCE_WOOD = 0x8a7a63
/** 斜撑比桩再暗一档：它整天压在阴影里，同色会和桩糊成一根粗棍。 */
const FENCE_BRACE = 0x6f6250

/** 墨线基准宽度，单位 CSS 像素（与 render.ts 的 INK_PIXELS 同一量纲）。 */
const INK_BASE = 2.2

// ------------------------------------------------------------------ 工具

/** 一次性释放登记表；重复登记会去重（几何体常被父子共用）。 */
class GpuBag {
  private readonly items: { dispose(): void }[] = []

  add(...items: { dispose(): void }[]): void {
    for (const item of items) {
      if (!this.items.includes(item)) this.items.push(item)
    }
  }

  dispose(): void {
    for (const item of this.items) item.dispose()
    this.items.length = 0
  }
}

/**
 * mulberry32。选它是因为**实现只有十行**，可以直接内联，不必为一串随机数引依赖；
 * 而且它全是 32 位整数运算，跨浏览器逐位一致 —— Math.random 没有这个保证，
 * 摆位会在不同机器上长歪。这也是本文件禁止 Math.random 的原因。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a：把关卡 id 变成一个稳定种子。 */
function hashString(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 整数格点哈希：全整数运算，任何机器结果都一样。 */
function latticeHash(ix: number, iz: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 平滑双线性值噪声：给"积水洼地"一个连续的大尺度形状，不是随机麻点。 */
function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = smoothstep(0, 1, x - ix)
  const fz = smoothstep(0, 1, z - iz)
  const a = latticeHash(ix, iz)
  const b = latticeHash(ix + 1, iz)
  const c = latticeHash(ix, iz + 1)
  const d = latticeHash(ix + 1, iz + 1)
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz)
}

/**
 * 4 级灰度渐变图，供 MeshToonMaterial.gradientMap 采样。
 * 步值与 render.ts 的 makeGradientMap() 逐值相同 —— 两套材质必须共用同一套色阶，
 * 否则同一帧里会出现两种分级风格。
 */
function makeGradientMap(): DataTexture {
  const steps = [0.32, 0.58, 0.82, 1.0]
  const data = new Uint8Array(steps.length)
  for (let i = 0; i < steps.length; i++) data[i] = Math.round(steps[i]! * 255)
  const map = new DataTexture(data, steps.length, 1, RedFormat)
  // 线性过滤会把 4 级插回连续渐变，等于白做。
  map.minFilter = NearestFilter
  map.magFilter = NearestFilter
  map.generateMipmaps = false
  map.needsUpdate = true
  return map
}

/**
 * 道具材质工厂。
 *
 * 关卡已经全面 PBR（normal/roughness + IBL），道具如果继续用 toon + 墨线，
 * 就会出现截图里最刺眼的那一幕：写实墙面前立着几棵"带黑边的卡通树"。
 * 这里改成 MeshStandardMaterial，按表面类型给一组粗糙度/金属度近似值；
 * 道具没有展开 UV，所以不挂贴图，只靠平滑光照 + 环境反射融入场景。
 */
function makeToon(
  color: number,
  bag: GpuBag,
  opts: {
    gradientMap?: DataTexture
    fog?: boolean
    side?: Side
    surface?: ComicSurface
    specular?: number
  } = {},
): MeshStandardMaterial {
  let metalness = 0
  let roughness = 0.88
  switch (opts.surface) {
    case 'metal':
      metalness = 0.55
      roughness = 0.42
      break
    case 'wood':
      roughness = 0.82
      break
    case 'foliage':
      roughness = 0.94
      break
    case 'mud':
    case 'stone':
      roughness = 0.9
      break
    default:
      break
  }
  // specular 是旧 toon 的假高光强度 0..1；这里反向映射成粗糙度。
  if (opts.specular !== undefined) {
    roughness = Math.min(1, Math.max(0.18, 1 - opts.specular * 0.8))
  }
  const mat = new MeshStandardMaterial({
    color,
    metalness,
    roughness,
    fog: opts.fog ?? true,
  })
  if (opts.side !== undefined) mat.side = opts.side
  bag.add(mat)
  return mat
}

/**
 * 墨线材质：背面外壳沿法线外扩，外扩量乘 pos.w 让线宽在屏幕上恒定（与
 * render.ts 的 makeInkMaterial 同一套原理）。
 *
 * 与那份唯一的差别：几何体可能来自 InstancedMesh，法线要先过 instanceMatrix。
 * 不做这一步，每棵实例化的树都朝"自己的局部原点方向"外扩，描边粗细随朝向
 * 变化，一眼假。
 */
function makeInkMaterial(bag: GpuBag, width = INK_BASE): ShaderMaterial {
  const mat = new ShaderMaterial({
    side: BackSide,
    uniforms: {
      uWidth: { value: width },
      uBoil: OUTLINE_SHARED.boil,
      uRes: OUTLINE_SHARED.resolution,
      uColor: { value: new Color(0x14100c) },
    },
    vertexShader: [
      'uniform float uWidth;',
      'uniform float uBoil;',
      'uniform vec2 uRes;',
      'void main() {',
      '  #ifdef USE_INSTANCING',
      '    vec4 local = instanceMatrix * vec4(position, 1.0);',
      '    vec3 nrm = normalize(mat3(instanceMatrix) * normal);',
      '  #else',
      '    vec4 local = vec4(position, 1.0);',
      '    vec3 nrm = normal;',
      '  #endif',
      '  vec4 pos = projectionMatrix * modelViewMatrix * local;',
      '  pos.xy += normalize(normalMatrix * nrm).xy * uWidth * uBoil * uRes * pos.w;',
      '  gl_Position = pos;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uColor;',
      'void main() {',
      '  gl_FragColor = vec4(uColor, 1.0);',
      '}',
    ].join('\n'),
  })
  // 写实档不再给道具描边：关卡是 PBR，黑边会把树/栅栏读成贴纸。
  // 不删几何、不改调用方，只让材质不参与渲染（Mesh 会被整棵跳过）。
  mat.visible = false
  bag.add(mat)
  return mat
}

// ------------------------------------------------------------ 顶点色拼件

/**
 * 给一整块几何刷一个颜色（写进顶点色）。
 *
 * 一个 InstancedMesh 只能挂一份几何 + 一份材质。想让木箱同时有木板、铁角、檐口
 * 高光，只有两条路：多几个 draw call，或者把颜色烘进顶点。选后者 —— 顶点色照样
 * 吃 toon 的四级色阶，而一件道具仍然只画一次。
 *
 * 索引在这里就摊平：合并只认三角形，留着 tri index 反而要多写一套偏移修正。
 */
function paint(geo: BufferGeometry, color: number): BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo
  const c = new Color(color)
  const count = flat.getAttribute('position').count
  const data = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    data[i * 3] = c.r
    data[i * 3 + 1] = c.g
    data[i * 3 + 2] = c.b
  }
  flat.setAttribute('color', new Float32BufferAttribute(data, 3))
  // 没有贴图的 toon 材质读不到 uv，留着只是多一份解包开销。
  flat.deleteAttribute('uv')
  return flat
}

/**
 * 把若干已上色的几何拼成一件道具。
 *
 * 只拼 position / normal / color，缺 color 的按纯白算 —— 于是这里没有失败分支：
 * three 自带的 mergeGeometries 在属性集对不上时返回 null，而这份属性集是我们
 * 自己定的，永远对得上。parts 只接受 three 自带图元或本函数拼出来的东西（它们
 * 都带 normal）。
 */
function assemble(parts: BufferGeometry[]): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  for (const part of parts) {
    const flat = part.index ? part.toNonIndexed() : part
    const pos = flat.getAttribute('position')
    const nrm = flat.getAttribute('normal')
    const col = flat.getAttribute('color')
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
      if (col) colors.push(col.getX(i), col.getY(i), col.getZ(i))
      else colors.push(1, 1, 1)
    }
    if (flat !== part) flat.dispose()
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geo.computeBoundingSphere()
  return geo
}

/**
 * 顶点色材质：颜色全在几何里，材质保持纯白，不去乘它第二次。
 * side 只有破布用得上 —— 一块布从背面也要看得见。
 */
function makePartMaterial(bag: GpuBag, _gradientMap: DataTexture, side?: Side): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
  })
  if (side !== undefined) mat.side = side
  bag.add(mat)
  return mat
}

// ------------------------------------------------------------------ 水面

/**
 * 水面：一整块平面 + 一个纯手写着色器。
 *
 * 为什么不用 MeshToonMaterial + onBeforeCompile：水面既不吃光照分级也不吃 toon
 * 的雾，它要的是"两股滚动的墨色水纹"，本来就是自定义片元逻辑，直接写
 * ShaderMaterial 比往 toon 里塞补丁短一半。
 *
 * 为什么几何体切 64×64 段而不是两个三角形：每个顶点烙一个 aMarsh 湿度值（由
 * 盒子脚印、出生点、边界算出），片元按它决定显不显示。于是**整张地图的水仍然是
 * 一次 draw call**，却只在洼地和边界成片，踩出来的干土路与出生点附近是干的。
 *
 * depthWrite: false 是硬要求：真写深度的话，站在浅水里的木桶/芦苇那圈背面墨线
 * 外壳会被水面按深度剔掉，物体看起来"丢了描边"。
 */
function buildWater(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  wetness: (x: number, z: number) => number,
): { time: { value: number } } {
  const size = level.boundsHalf * 2
  const segments = 64
  const geo = new PlaneGeometry(size, size, segments, segments)
  // 把旋转烘进几何体：之后 position.x/z 就是世界 XZ，写属性和调试都省一步。
  geo.rotateX(-Math.PI / 2)
  bag.add(geo)

  const positions = geo.getAttribute('position')
  const marshData = new Float32Array(positions.count)
  for (let i = 0; i < positions.count; i++) {
    marshData[i] = wetness(positions.getX(i), positions.getZ(i))
  }
  geo.setAttribute('aMarsh', new Float32BufferAttribute(marshData, 1))

  const time = { value: 0 }
  const mat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // 水面与地面盒顶面只差 5mm，靠 polygonOffset 把它往镜头方向偏一点，
    // 否则两块近乎共面的表面会在远处抖出摩尔纹。比整体抬高水面干净。
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    fog: false,
    uniforms: {
      uTime: time,
      uDeep: { value: new Color(WATER_DEEP) },
      uPale: { value: new Color(WATER_PALE) },
      uCrest: { value: new Color(WATER_CREST) },
      uFogColor: { value: new Color(level.fogColor) },
      uFogDensity: { value: level.fogDensity },
    },
    vertexShader: [
      'attribute float aMarsh;',
      'varying vec2 vWorld;',
      'varying vec3 vViewPos;',
      'varying float vMarsh;',
      'void main() {',
      '  vec4 world = modelMatrix * vec4(position, 1.0);',
      '  vWorld = world.xz;',
      '  vMarsh = aMarsh;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  vViewPos = mv.xyz;',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime;',
      'uniform vec3 uDeep;',
      'uniform vec3 uPale;',
      'uniform vec3 uCrest;',
      'uniform vec3 uFogColor;',
      'uniform float uFogDensity;',
      'varying vec2 vWorld;',
      'varying vec3 vViewPos;',
      'varying float vMarsh;',
      'void main() {',
      '  if (vMarsh < 0.02) discard;',
      '  vec2 p = vWorld;',
      '  // 两道波纹各自拿对方的坐标去调制相位：纹路于是不是整齐的平行线，',
      '  // 而是互相顶开的"水舌"，手绘水面就是这种笔触。',
      '  float r1 = sin(p.x * 0.62 + uTime * 0.85 + sin(p.y * 0.27 + uTime * 0.41) * 1.9);',
      '  float r2 = sin(p.y * 0.83 - uTime * 0.62 + sin(p.x * 0.35 - uTime * 0.33) * 1.7);',
      '  float band = max(r1, r2);',
      '  // 硬边切级：水彩是几笔色块，不是连续滚落的高光。',
      '  float crest = smoothstep(0.55, 0.72, band);',
      '  float trough = smoothstep(-0.15, -0.45, min(r1, r2));',
      '  vec3 col = mix(uDeep, uPale, 0.24 + 0.28 * (r1 * 0.5 + 0.5));',
      '  col = mix(col, uPale, crest * 0.35);',
      '  col = mix(col, uCrest, smoothstep(0.90, 0.99, band) * 0.45);',
      '  col = mix(col, uDeep * 1.15, trough * 0.4);',
      '  float alpha = smoothstep(0.02, 0.30, vMarsh) * 0.62;',
      '  // 自己算 FogExp2：纯 ShaderMaterial 不接 scene.fog，不补这一步的话近处的',
      '  // 水被雾压暗、远处反而亮，一眼看穿。',
      '  float viewDepth = length(vViewPos);',
      '  float fogFactor = clamp(1.0 - exp(-uFogDensity * uFogDensity * viewDepth * viewDepth), 0.0, 1.0);',
      '  gl_FragColor = vec4(mix(col, uFogColor, fogFactor), alpha);',
      '  // ShaderMaterial 不会自动做线性→输出色彩空间，少了这一行水面会比场景亮一档。',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  })
  bag.add(mat)

  const mesh = new Mesh(geo, mat)
  // 高度取 groundY - 0.005：按要求落在"地面高度之下"，但只低 5mm。
  // 注意地面盒的**可见顶面**在 groundY - 0.01（render.ts:355），所以水面比地面盒
  // 高 5mm —— 再低就会被地面盒整片遮死，水面会凭空消失。这 5mm 的间隙配上
  // polygonOffset（材质里设置）才不会和地面 moiré 闪烁。
  mesh.position.y = level.groundY - 0.005
  // 透明队列里画得最早 → 层次是"雾墙 → 水 → 其他透明物"。
  mesh.renderOrder = -5
  root.add(mesh)
  return { time }
}

// ------------------------------------------------------------------ 芦苇

/**
 * 芦苇。一整片是**一个** InstancedMesh = 一次 draw call。
 *
 * 摆动全在顶点着色器里用**一个** uTime uniform 完成：CPU 端每帧改 400 多个实例
 * 矩阵会把这层的收益直接吃光（400 × 16 个 float 上传 + compose），而 GPU 只是多
 * 算几条 sin。相位由实例矩阵的平移量派生，所以每丛草的节奏天生错开，不需要额外
 * 的实例属性。
 */
function buildReeds(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
  density: number,
  placeable: (x: number, z: number, spawnRing?: number) => boolean,
  wetness: (x: number, z: number) => number,
): { uReedTime: { value: number } } {
  const uReedTime = { value: 0 }
  const target = Math.round(REED_TARGET * density)

  // 候选点只有两类：边界芦苇带、每个盒子脚印外围一圈。两处都不是玩家长住的地方。
  const spots: { x: number; z: number }[] = []
  const ringSteps = Math.max(8, Math.round((level.boundsHalf * 8) / 0.9))
  for (let i = 0; i < ringSteps; i++) {
    const angle = (i / ringSteps) * Math.PI * 2 + (rng() - 0.5) * 0.05
    const radius = level.boundsHalf - (0.6 + rng() * 3.4)
    spots.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius })
  }
  for (const b of level.boxes) {
    if (b.hy * 2 < 0.5) continue // 贴地的装饰面不用长草，免得盖住它
    const reach = Math.hypot(b.hx, b.hz) + 0.7
    for (let k = 0; k < 4; k++) {
      const angle = rng() * Math.PI * 2
      const dist = reach + rng() * 2.0
      spots.push({ x: b.x + Math.cos(angle) * dist, z: b.z + Math.sin(angle) * dist })
    }
  }

  const accepted: { x: number; z: number }[] = []
  for (const spot of spots) {
    if (accepted.length >= target) break
    if (!placeable(spot.x, spot.z)) continue
    // 芦苇要长在水边。但也留一小撮旱地芦苇 —— 纯沿水线会长成一圈画出来的环。
    if (wetness(spot.x, spot.z) < 0.08 && rng() > 0.2) continue
    accepted.push(spot)
  }

  const geo = makeReedGeometry()
  bag.add(geo)
  const mat = makeToon(0x6f8f3e, bag, { gradientMap, side: DoubleSide, surface: 'foliage' })
  patchReedSway(mat, uReedTime)

  const mesh = new InstancedMesh(geo, mat, Math.max(1, accepted.length))
  bag.add(mesh)
  const dummy = new Object3D()
  const tint = new Color()
  for (let i = 0; i < accepted.length; i++) {
    const spot = accepted[i]!
    dummy.position.set(spot.x, level.groundY, spot.z)
    dummy.rotation.set(0, rng() * Math.PI * 2, 0)
    const wide = 0.8 + rng() * 0.5
    dummy.scale.set(wide, 0.55 + rng() * 0.6, wide)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
    // 逐丛色相差一点点：整片同色会糊成一块绿板，看不出是几十丛草。
    tint.setHSL(0.22 + (rng() - 0.5) * 0.05, 0.42 + rng() * 0.2, 0.36 + rng() * 0.14)
    mesh.setColorAt(i, tint)
  }
  mesh.count = accepted.length
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  root.add(mesh)

  return { uReedTime }
}

/**
 * 一丛芦苇：3 片锥形叶，每片 3 个三角形。
 *
 * 用三角形而不是双面四边形，是因为单面片从侧面看会消失，而开 DoubleSide 的
 * 面片在低角度又容易和相邻叶片穿插；三角形绕 Y 匀开 60° 就有一丛立体的草。
 * 腰线折一下是为了让叶片微弯，直锥体会像三根针。
 */
function makeReedGeometry(): BufferGeometry {
  const geo = new BufferGeometry()
  const positions: number[] = []
  const blades = 3
  for (let b = 0; b < blades; b++) {
    const rot = (b * Math.PI) / blades
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const w = 0.035
    const h = REED_UNIT
    const bend = (b % 2 === 0 ? 1 : -1) * 0.16
    const put = (x: number, y: number, z: number): void => {
      positions.push(x * cos + z * sin, y, -x * sin + z * cos)
    }
    const bl: [number, number, number] = [-w, 0, 0]
    const br: [number, number, number] = [w, 0, 0]
    const ml: [number, number, number] = [-w * 0.6, h * 0.55, bend * 0.3]
    const mr: [number, number, number] = [w * 0.6, h * 0.55, bend * 0.3]
    const tip: [number, number, number] = [0, h, bend]
    const tris: [number, number, number][][] = [
      [bl, br, mr],
      [bl, mr, ml],
      [ml, mr, tip],
    ]
    for (const tri of tris) {
      for (const v of tri) put(v[0], v[1], v[2])
    }
  }
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geo.computeVertexNormals()
  return geo
}

/**
 * 给芦苇材质打"随风摆"补丁。
 *
 * 注入点选 begin_vertex 之后：那一刻 transformed 已是局部坐标，摆动量乘高度的
 * 平方 → 根部纹丝不动、梢头摆幅最大，正是草的样子。若改在 project_vertex 之后，
 * 摆幅会被透视除法吃掉，远处的草就不动了。
 *
 * customProgramCacheKey 不能省：three 的 program 缓存键不看 onBeforeCompile，
 * 打过补丁和没打补丁的 MeshToonMaterial 会共用同一个 program，谁先编译谁赢，
 * 表现就是"只有一部分芦苇会动"。（client/src/ink.ts 里踩过同一个坑。）
 */
function patchReedSway(material: MeshStandardMaterial, uReedTime: { value: number }): void {
  const swayUniforms = {
    uReedTime,
    uReedSway: { value: 0.16 },
  }
  material.customProgramCacheKey = (): string => 'props-reed-sway-v1'
  material.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, swayUniforms)
    shader.vertexShader =
      ['uniform float uReedTime;', 'uniform float uReedSway;', ''].join('\n') + shader.vertexShader
    const hook = '#include <begin_vertex>'
    if (!shader.vertexShader.includes(hook)) return
    shader.vertexShader = shader.vertexShader.replace(
      hook,
      [
        hook,
        '  #ifdef USE_INSTANCING',
        '    float reedPhase = instanceMatrix[3].x * 0.83 + instanceMatrix[3].z * 0.61;',
        '  #else',
        '    float reedPhase = 0.0;',
        '  #endif',
        '  float reedH = clamp(transformed.y, 0.0, 1.0);',
        '  float reedBend = sin(uReedTime * 1.9 + reedPhase) * uReedSway;',
        '  float reedLean = cos(uReedTime * 1.31 + reedPhase * 1.7) * uReedSway * 0.45;',
        '  transformed.x += reedBend * reedH * reedH;',
        '  transformed.z += reedLean * reedH * reedH;',
      ].join('\n'),
    )
  }
}

// ------------------------------------------------------------------ 枯树

/** 一棵枯树的落位。破布要挂在真树上，所以这份数据得从 buildDeadTrees 带出去。 */
interface TreeSpot {
  x: number
  z: number
  height: number
  radius: number
  yaw: number
}

/**
 * 枯树：树干 + 每棵 6 根枝（4 根主枝，其中 2 根再岔一根），实例化成**三个**
 * draw call（树干、树干墨线、树枝）。
 *
 * 只给树干挂墨线是有意的：枝杈太细，套外壳会糊成一坨黑，反而看不出是树。
 * 位置全压在边界附近的环带上 —— 场中央放一棵能穿的树，玩家一定会试着用它当掩体。
 */
function buildDeadTrees(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
  count: number,
  placeable: (x: number, z: number, spawnRing?: number) => boolean,
): TreeSpot[] {
  if (count <= 0) return []

  const trunkGeo = new CylinderGeometry(0.1, 0.2, 1, 7, 1)
  trunkGeo.translate(0, 0.5, 0) // 原点挪到树根，"从地面长上去"才由缩放决定
  bag.add(trunkGeo)
  // 枝比树干细得多：上一版 0.062 的根径在 4m 长的枝上读成电线杆，
  // 剪影里出现一根横穿画面的长杆，整张图立刻像未完成的灰模。
  const branchGeo = new CylinderGeometry(0.018, 0.04, 1, 5, 1)
  branchGeo.translate(0, 0.5, 0)
  bag.add(branchGeo)

  const trunkMat = makeToon(TREE_BARK, bag, { gradientMap, surface: 'wood', specular: 0.02 })
  const branchMat = makeToon(TREE_BARK, bag, { gradientMap, surface: 'wood', specular: 0.02 })
  const inkMat = makeInkMaterial(bag, INK_BASE * 1.4)

  const trees: TreeSpot[] = []
  let guard = 0
  while (trees.length < count && guard < count * 40) {
    guard++
    // 半径取 boundsHalf 的 68%~95%：贴着沼泽外圈，不进场地中央。
    const angle = rng() * Math.PI * 2
    const radius = level.boundsHalf * (0.68 + rng() * 0.27)
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    if (!placeable(x, z, 5)) continue
    let tooClose = false
    for (const other of trees) {
      if (Math.hypot(other.x - x, other.z - z) < 6) tooClose = true
    }
    if (tooClose) continue
    trees.push({
      x,
      z,
      height: 2.8 + rng() * 1.9,
      radius: 0.8 + rng() * 0.5,
      yaw: rng() * Math.PI * 2,
    })
  }
  if (trees.length === 0) return []

  const trunks = new InstancedMesh(trunkGeo, trunkMat, trees.length)
  bag.add(trunks)
  const hulls = new InstancedMesh(trunkGeo, inkMat, trees.length)
  bag.add(hulls)
  // 外壳不参与射线：它纯粹是画面上的一圈墨，不该挡拾取。
  hulls.raycast = (): void => {}
  // 容量按每棵 6 根算：4 根主枝 + 2 根分叉。
  const branches = new InstancedMesh(branchGeo, branchMat, trees.length * 6)
  bag.add(branches)

  const dummy = new Object3D()
  const trunkMatrix = new Matrix4()
  // 分叉的落点要在父枝的矩阵上算，所以留一个复用的向量，别在循环里 new。
  const forkAt = new Vector3()
  let branchIndex = 0
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i]!
    dummy.position.set(tree.x, level.groundY, tree.z)
    dummy.rotation.set(0, tree.yaw, 0)
    dummy.scale.set(tree.radius, tree.height, tree.radius)
    dummy.updateMatrix()
    trunkMatrix.copy(dummy.matrix)
    trunks.setMatrixAt(i, trunkMatrix)
    // 墨线外壳共享同一份实例矩阵，描边于是严丝合缝地包住树干。
    hulls.setMatrixAt(i, trunkMatrix)

    for (let b = 0; b < 4; b++) {
      // 枝从树干 46%~78% 高度斜插出去；越高的枝越短，剪影才像枯树。
      // tilt 是离竖直方向的角度：0.45~0.8rad（26°~46°）才读成"斜上生长的枝"，
      // 上一版 0.85~1.3rad 几乎是水平的，横过头顶像两根晾衣杆。
      const at = 0.46 + b * 0.15 + rng() * 0.05
      const swing = tree.yaw + b * 2.1 + rng() * 0.6
      const tilt = 0.45 + rng() * 0.35
      const length = (0.78 - at * 0.34) * tree.height
      dummy.position.set(tree.x, level.groundY + at * tree.height, tree.z)
      dummy.rotation.set(Math.cos(swing) * tilt, swing, Math.sin(swing) * tilt)
      dummy.scale.set(tree.radius * 0.9, length, tree.radius * 0.9)
      dummy.updateMatrix()
      branches.setMatrixAt(branchIndex++, dummy.matrix)

      // 分叉：四根直枝的剪影是"四根插在地上的棍子"，一根枝上再岔一根才读成树。
      // 只长在第 1、3 根上，并且更细更短 —— 每根枝都对称地岔一下就成了模型标本。
      if (b !== 1 && b !== 3) continue
      // 几何是单位高的圆柱（y: 0→1），所以"枝的 62% 处"就是局部 y = 0.62。
      forkAt.set(0, 0.62, 0).applyMatrix4(dummy.matrix)
      const forkSwing = swing + 1 + rng() * 0.9
      const forkTilt = 0.5 + rng() * 0.45
      dummy.position.copy(forkAt)
      dummy.rotation.set(Math.cos(forkSwing) * forkTilt, forkSwing, Math.sin(forkSwing) * forkTilt)
      dummy.scale.set(tree.radius * 0.5, length * 0.42, tree.radius * 0.5)
      dummy.updateMatrix()
      branches.setMatrixAt(branchIndex++, dummy.matrix)
    }
  }
  trunks.instanceMatrix.needsUpdate = true
  hulls.instanceMatrix.needsUpdate = true
  branches.count = branchIndex
  branches.instanceMatrix.needsUpdate = true
  root.add(trunks, hulls, branches)
  return trees
}

// ------------------------------------------------------------------ 破布

/**
 * 挂在枯树上的破布：**1** 个 draw call，不给墨线外壳。
 *
 * 布只有几厘米厚，套外壳会糊成一团墨。而它要传达的信息只是"这棵树下发生过什么"，
 * 一块偏冷的布挂在暖褐色的树皮上就够读了。
 *
 * 不做飘动：芦苇已经在动，再给背景添一层动态，只会让人分不清哪里真的有什么在动 ——
 * 在这个游戏里那等于死。
 */
function buildTreeRags(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
  trees: TreeSpot[],
): void {
  if (trees.length === 0) return
  // 只挂 3 面。挂满全场就不叫"证据"了，那叫旗子。
  const count = Math.min(3, trees.length)
  const geo = makeRagGeometry()
  bag.add(geo)
  const mesh = new InstancedMesh(geo, makePartMaterial(bag, gradientMap, DoubleSide), count)
  bag.add(mesh)

  const dummy = new Object3D()
  const step = Math.max(1, Math.floor(trees.length / count))
  for (let i = 0; i < count; i++) {
    const tree = trees[i * step]!
    const angle = rng() * Math.PI * 2
    const reach = 0.55 + rng() * 0.6
    dummy.position.set(
      tree.x + Math.cos(angle) * reach,
      // 挂点落在树冠下方一段：再高会被枝挡住，再低就成了掉在地上的布。
      level.groundY + tree.height * (0.46 + rng() * 0.24),
      tree.z + Math.sin(angle) * reach,
    )
    dummy.rotation.set((rng() - 0.5) * 0.14, angle + rng() * 1.2, (rng() - 0.5) * 0.14)
    dummy.scale.setScalar(0.85 + rng() * 0.45)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
  root.add(mesh)
}

/**
 * 破布几何：三片长短不齐的布从挂点垂下来。原点就是**挂点**（下摆落在负 y），
 * 于是实例的 position 可以直接当"挂在哪儿"用。
 */
function makeRagGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const widths = [0.3, 0.22, 0.16]
  for (let i = 0; i < 3; i++) {
    const w = widths[i]!
    const h = 0.4 + i * 0.14
    parts.push(
      paint(
        new PlaneGeometry(w, h, 1, 1).translate((i - 1) * 0.16, -h * 0.5, (i % 2 === 0 ? 1 : -1) * 0.05),
        i === 1 ? 0x7b7364 : 0x6d665a,
      ),
    )
  }
  return assemble(parts)
}

// ------------------------------------------------------------------ 栅栏

/**
 * 破栅栏：边界内侧一段段的断篱。桩与横杆各一个 InstancedMesh。
 *
 * "断"是这段的**唯一**设计目标：只有约 62% 的段被生成（整段整段地缺，缺口是
 * 9m 级的大洞，一眼看得穿），段内约 68% 的桩还在，相邻桩之间只留约 72% 的横杆，
 * 另有一成桩子是倒伏的，还有三成相邻桩之间空着。
 * 比例是调过的：横杆再少就只剩一地孤零零的桩子，读不出"这里曾经是篱笆"；再多
 * 就接近连续栅栏，站在后面的人会以为那是掩体。现在每一段都能看清"几根桩 + 一两
 * 根斜掉的杆，然后断开"。
 * 反过来做一条连续栅栏，哪怕只有一米高，也是这个模块最坏的画面。
 */
function buildFence(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
  density: number,
  placeable: (x: number, z: number, spawnRing?: number) => boolean,
): void {
  // 桩脚上的斜撑：40° 顶出去的一根短木，末端正好搭到相邻横杆的高度。
  // 桩本身是歪的、朝向随机，撑木于是各有各的斜法 —— "这里曾经有人支撑过它、
  // 后来断了"就是从这一排歪撑里读出来的。撑与桩共用一份几何，所以这段是
  // **零**新增 draw call。
  const postGeo = assemble([
    paint(new BoxGeometry(0.12, 1.05, 0.13).translate(0, 0.525, 0), FENCE_WOOD),
    paint(new BoxGeometry(0.07, 0.62, 0.05).rotateZ(-0.7).translate(0.19, 0.26, 0), FENCE_BRACE),
  ])
  bag.add(postGeo)
  const railGeo = assemble([paint(new BoxGeometry(1, 0.09, 0.05), FENCE_WOOD)])
  bag.add(railGeo)

  // 桩与杆共用一份材质：颜色已经在顶点里了，这里再乘一次就会暗两档。
  const woodMat = makePartMaterial(bag, gradientMap)

  const postMatrices: Matrix4[] = []
  const railMatrices: Matrix4[] = []
  const dummy = new Object3D()
  const dist = Math.max(2, level.boundsHalf - 1.5)
  const halfSpan = level.boundsHalf - 1.2
  const segmentLength = 9
  const segmentsPerSide = Math.max(1, Math.ceil((halfSpan * 2) / segmentLength))

  // side 0..3 → 四条边；先沿边取样再映射回世界 XZ。
  const along = (side: number, t: number): { x: number; z: number } => {
    if (side === 0) return { x: t, z: dist }
    if (side === 1) return { x: t, z: -dist }
    if (side === 2) return { x: dist, z: t }
    return { x: -dist, z: t }
  }

  for (let side = 0; side < 4; side++) {
    for (let seg = 0; seg < segmentsPerSide; seg++) {
      if (rng() > 0.62) continue
      const spanStart = -halfSpan + (seg * halfSpan * 2) / segmentsPerSide
      const spanEnd = spanStart + (halfSpan * 2) / segmentsPerSide
      const slots = Math.max(2, Math.round((spanEnd - spanStart) / 2.2))
      let prev: { x: number; z: number } | null = null
      for (let i = 0; i <= slots; i++) {
        const point = along(side, lerp(spanStart, spanEnd, i / slots))
        // 被出生点或盒子否决时直接断开，而不是就地挪 —— 挪会挪进可走走廊。
        if (!placeable(point.x, point.z) || rng() > 0.68) {
          prev = null
          continue
        }
        const jitter = (rng() - 0.5) * 0.5
        const px = side >= 2 ? point.x + jitter : point.x
        const pz = side >= 2 ? point.z : point.z + jitter
        const fallen = rng() < 0.1
        dummy.position.set(px, level.groundY - (fallen ? 0.1 : 0.02), pz)
        dummy.rotation.set(
          (rng() - 0.5) * 0.12,
          rng() * Math.PI * 2,
          fallen ? (rng() < 0.5 ? -1 : 1) * (0.95 + rng() * 0.4) : (rng() - 0.5) * 0.16,
        )
        dummy.scale.set(1, fallen ? 0.9 : 1, 1)
        dummy.updateMatrix()
        postMatrices.push(dummy.matrix.clone())

        if (prev && rng() < 0.72) {
          const dx = px - prev.x
          const dz = pz - prev.z
          const len = Math.hypot(dx, dz)
          if (len > 0.5 && len < 3.2) {
            dummy.position.set(
              (prev.x + px) * 0.5,
              level.groundY + (rng() < 0.5 ? 0.38 : 0.78),
              (prev.z + pz) * 0.5,
            )
            // 盒子长轴在 X：绕 Y 转 atan2(-dz, dx) 才能让 X 轴对上两桩连线。
            dummy.rotation.set(0, Math.atan2(-dz, dx), (rng() - 0.5) * 0.1)
            dummy.scale.set(len * 0.92, 1, 1)
            dummy.updateMatrix()
            railMatrices.push(dummy.matrix.clone())
          }
        }
        prev = { x: px, z: pz }
      }
    }
  }

  const postCount = Math.min(postMatrices.length, Math.round(160 * density))
  const railCount = Math.min(railMatrices.length, Math.round(120 * density))
  if (postCount <= 0) return

  const posts = new InstancedMesh(postGeo, woodMat, postCount)
  bag.add(posts)
  for (let i = 0; i < postCount; i++) posts.setMatrixAt(i, postMatrices[i]!)
  posts.instanceMatrix.needsUpdate = true
  root.add(posts)

  if (railCount > 0) {
    const rails = new InstancedMesh(railGeo, woodMat, railCount)
    bag.add(rails)
    for (let i = 0; i < railCount; i++) rails.setMatrixAt(i, railMatrices[i]!)
    rails.instanceMatrix.needsUpdate = true
    root.add(rails)
  }
}

// ------------------------------------------------------------------ 雾墙

/**
 * 雾墙：2~3 片竖直大面片，纹理是运行时画出来的径向渐变。
 *
 * 目的只有一个 —— 给边界加一层空气。沼泽的能见度本来就该糊掉，画面里出现一条
 * 清晰的操场边线会立刻穿帮。
 *
 * CSP 禁止外部资源，所以渐变必须用 CanvasTexture 现场画（和 index.html 里内联
 * SVG 噪音同一个理由）。depthWrite: false + 最低 renderOrder → 它永远排在其他
 * 透明物件后面，不会把水面或曳光弹盖白。
 */
function buildFogWalls(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  rng: () => number,
  density: number,
): void {
  const count = Math.min(3, Math.max(2, Math.round(3 * density)))
  const fogTexture = makeFogTexture(level.fogColor)
  bag.add(fogTexture)
  const fogMat = new MeshBasicMaterial({
    map: fogTexture,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    opacity: 0.72,
  })
  bag.add(fogMat)

  // 半径乘 1.06 —— 雾墙必须落在**可走范围之外**。放在 boundsHalf 以内看似更贴边界，
  // 但玩家能走到 x/z = ±boundsHalf，那时他会站到 16m 高的雾片背后，一块半透明的
  // 大板子立刻读成"一堵能穿过去的墙"，正是这个模块最该避免的画面。
  const radius = level.boundsHalf * 1.06
  const startAngle = rng() * Math.PI * 2
  for (let i = 0; i < count; i++) {
    const angle = startAngle + (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.35
    const geo = new PlaneGeometry(radius * 1.25, 16)
    bag.add(geo)
    const wall = new Mesh(geo, fogMat)
    wall.position.set(Math.cos(angle) * radius, level.groundY + 6.5, Math.sin(angle) * radius)
    // PlaneGeometry 正面朝 +Z，lookAt 把 +Z 指向中心 → 面片始终面向场内。
    wall.lookAt(0, wall.position.y, 0)
    wall.renderOrder = -10
    root.add(wall)
  }
}

/** 运行时画一张雾的径向渐变：中心浓、边缘完全透明。 */
function makeFogTexture(fogColor: number): CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('props: 需要 2D canvas 来生成雾的渐变贴图')

  const hex = new Color(fogColor).getHexString()
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const rgba = (alpha: number): string => 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, rgba(0.62))
  gradient.addColorStop(0.45, rgba(0.42))
  gradient.addColorStop(0.78, rgba(0.16))
  gradient.addColorStop(1, rgba(0))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)

  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

// ------------------------------------------------------------------ 分群系装饰

type Biome = 'swamp' | 'farm' | 'church' | 'quarry' | 'station' | 'forest'

/**
 * 从关卡读生物群系。字段可选（老关卡没有），缺省按沼泽处理 —— 沼泽是已经调
 * 好的那张图，缺字段时宁可多长芦苇，也不要让一张图突然秃掉。
 */
function biomeOf(level: LevelDef): Biome {
  const raw = (level as { biome?: string }).biome
  return raw === 'farm' || raw === 'church' || raw === 'quarry' || raw === 'station' || raw === 'forest' ? raw : 'swamp'
}

interface PropSpec {
  /**
   * 单位几何：原点在**底面中心**，尺寸≈真实尺寸，实例再按 scale 缩放。
   * 颜色烘在顶点色里（见 paint / assemble），所以一件道具可以同时有木板、铁件
   * 和一条亮出来的檐口 —— 而整件仍然只画一次。
   */
  geo: BufferGeometry
  /**
   * 墨线外壳用的几何：默认与 geo 相同。
   * 只有"细到一包墨线就糊"的部位才另给一份简化几何 —— 马车轮的六根辐条就是
   * 例子：外壳照着辐条外扩两像素，整只轮子会变成一块黑饼。
   */
  hullGeo?: BufferGeometry
  count: number
  scaleMin: number
  scaleMax: number
  /** 埋进地里的深度。石头和墓碑不埋一条缝，会像"摆在地板上的道具"。 */
  sink: number
  /** 墨线外扩量倍数，0 = 不画外壳。 */
  ink: number
  /** 最大倾倒角（弧度）：墓碑立了一百年不会还是笔直的，歪掉的桩子更不会。 */
  tilt?: number
}

/**
 * 各群系的装饰清单。
 *
 * 刻意守住 buildProps 开头那条原则：不摆"看上去像掩体、却能穿过去"的东西。
 * 所以车站放的是煤堆与枕木，而不是木箱；采石场放的是碎石堆，而不是石台 ——
 * 形状越像能躲，玩家越会去试，试一次就不再信这个世界的碰撞了。
 */
function specsFor(biome: Biome, level: LevelDef): PropSpec[] {
  const big = Math.max(1, (level.boundsHalf / 40) ** 0.5)
  switch (biome) {
    case 'church':
      return [
        {
          geo: headstoneGeometry(),
          count: Math.round(40 * big), scaleMin: 0.8, scaleMax: 1.25, sink: 0.1, ink: 1.3, tilt: 0.16,
        },
        {
          geo: crossMarkerGeometry(),
          count: Math.round(16 * big), scaleMin: 0.9, scaleMax: 1.3, sink: 0.08, ink: 1.2, tilt: 0.24,
        },
        {
          // 塌下来的碎石：一块孤零零的多面体只是"一个石头"，两块压在一起才是塌方。
          geo: assemble([
            paint(new DodecahedronGeometry(0.6, 0).scale(1, 0.7, 1).translate(0, 0.42, 0), 0x5f6157),
            paint(new DodecahedronGeometry(0.32, 0).scale(1, 0.6, 1).rotateY(0.8).translate(0.42, 0.3, -0.1), 0x6b6d63),
          ]),
          count: Math.round(18 * big), scaleMin: 0.6, scaleMax: 1.2, sink: 0.12, ink: 1.2,
        },
      ]
    case 'quarry':
      return [
        {
          geo: assemble([
            paint(new DodecahedronGeometry(1, 0).scale(1, 0.62, 1).translate(0, 0.55, 0), 0x6d6f72),
            // 背上再压一块亮一点的断石：采石场的石头永远是新断口，不该是单色的。
            paint(new DodecahedronGeometry(0.62, 0).scale(1, 0.5, 1).rotateY(1.1).translate(0.6, 0.72, -0.2), 0x7c7e81),
          ]),
          count: Math.round(22 * big), scaleMin: 1.5, scaleMax: 3.0, sink: 0.35, ink: 1.6,
        },
        {
          geo: assemble([
            paint(new DodecahedronGeometry(0.35, 0).scale(1, 0.62, 1).translate(0, 0.2, 0), 0x5b5d60),
            paint(new DodecahedronGeometry(0.2, 0).scale(1, 0.6, 1).translate(0.26, 0.13, 0.12), 0x67696c),
          ]),
          count: Math.round(64 * big), scaleMin: 0.5, scaleMax: 1.2, sink: 0.12, ink: 1.2,
        },
      ]
    case 'farm':
      return [
        {
          // 横躺的草垛：圆柱先绕 Z 转 90°，再抬到半径高度，原点才能落回底面。
          geo: assemble([
            paint(new CylinderGeometry(0.66, 0.66, 1.15, 10).rotateZ(Math.PI / 2).translate(0, 0.66, 0), 0x8d7d46),
            // 捆草的两道箍：没有它们，草垛只是一根黄圆柱。
            paint(new CylinderGeometry(0.68, 0.68, 0.05, 10).rotateZ(Math.PI / 2).translate(-0.32, 0.66, 0), 0x6d5f33),
            paint(new CylinderGeometry(0.68, 0.68, 0.05, 10).rotateZ(Math.PI / 2).translate(0.34, 0.66, 0), 0x6d5f33),
          ]),
          count: Math.round(18 * big), scaleMin: 0.8, scaleMax: 1.2, sink: 0.05, ink: 1.1,
        },
        {
          // 废掉的马车：车斗 + 还立着的右轮 + 躺在地上的左轮 + 折断的车轴。
          geo: brokenCartGeometry(true),
          hullGeo: brokenCartGeometry(false),
          count: Math.round(8 * big), scaleMin: 0.9, scaleMax: 1.2, sink: 0.04, ink: 1.2,
        },
      ]
    case 'station':
      return [
        {
          // 电线杆：杆 + 横担 + 两只瓷瓶。有横担才读得出"这里通过电"。
          geo: assemble([
            paint(new CylinderGeometry(0.11, 0.15, 1, 6).translate(0, 0.5, 0), 0x4f3d2c),
            paint(new BoxGeometry(0.92, 0.07, 0.07).translate(0, 0.92, 0), 0x5c4835),
            paint(new BoxGeometry(0.06, 0.14, 0.06).translate(-0.38, 0.85, 0), 0x6b6a66),
            paint(new BoxGeometry(0.06, 0.14, 0.06).translate(0.38, 0.85, 0), 0x6b6a66),
          ]),
          count: Math.round(12 * big), scaleMin: 5.5, scaleMax: 7, sink: 0.2, ink: 1.4,
        },
        {
          geo: assemble([
            paint(new DodecahedronGeometry(0.55, 0).scale(1, 0.55, 1).translate(0, 0.28, 0), 0x2c2b2a),
            paint(new DodecahedronGeometry(0.3, 0).scale(1, 0.6, 1).translate(0.42, 0.18, 0.18), 0x35342f),
          ]),
          count: Math.round(20 * big), scaleMin: 0.8, scaleMax: 1.6, sink: 0.1, ink: 1.1,
        },
      ]
    case 'forest':
      return [
        {
          // 倒枝：一根主干 + 两根分叉。松林里最便宜的"地面信息"。
          geo: assemble([
            paint(new CylinderGeometry(0.08, 0.12, 2.2, 5).rotateZ(Math.PI / 2 - 0.12).translate(0, 0.11, 0), 0x4a3826),
            paint(new CylinderGeometry(0.05, 0.07, 0.9, 4).rotateZ(1.1).translate(0.55, 0.28, 0.1), 0x52402c),
            paint(new CylinderGeometry(0.04, 0.06, 0.7, 4).rotateZ(-1.0).translate(-0.6, 0.24, -0.12), 0x453321),
          ]),
          count: Math.round(34 * big), scaleMin: 0.7, scaleMax: 1.4, sink: 0.06, ink: 1.1, tilt: 0.3,
        },
        {
          // 蕨丛：六片斜向上的锥叶，中间一撮更暗的芯。
          geo: assemble([
            ...Array.from({ length: 6 }, (_, i) => {
              const a = (i / 6) * Math.PI * 2
              return paint(
                new ConeGeometry(0.16, 0.85, 4)
                  .rotateZ(Math.PI / 2 - 0.55)
                  .rotateY(a)
                  .translate(Math.cos(a) * 0.34, 0.34, Math.sin(a) * 0.34),
                0x3c5228,
              )
            }),
            paint(new SphereGeometry(0.2, 6, 4).scale(1, 0.7, 1).translate(0, 0.22, 0), 0x2c3c1d),
          ]),
          count: Math.round(70 * big), scaleMin: 0.8, scaleMax: 1.5, sink: 0.04, ink: 1.0, tilt: 0.2,
        },
        {
          // 苔石：比采石场小、比教堂圆，埋在落叶层里只露半截。
          geo: assemble([
            paint(new DodecahedronGeometry(0.5, 0).scale(1.2, 0.55, 1).translate(0, 0.24, 0), 0x565a4c),
            paint(new DodecahedronGeometry(0.3, 0).scale(1, 0.5, 1).translate(0.38, 0.16, 0.2), 0x4b4f43),
          ]),
          count: Math.round(26 * big), scaleMin: 0.7, scaleMax: 1.4, sink: 0.12, ink: 1.1,
        },
      ]
    default:
      return []
  }
}

function buildBiomeProps(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
  density: number,
  placeable: (x: number, z: number, spawnRing?: number) => boolean,
  biome: Biome,
): void {
  if (biome === 'swamp') return // 沼泽那套水/芦苇/枯树已经按湿度和脚印算好了，不叠别的
  for (const spec of specsFor(biome, level)) {
    buildCluster(root, level, bag, gradientMap, rng, spec, Math.round(spec.count * density), placeable)
  }
  if (biome === 'station') buildRails(root, level, bag, gradientMap, rng)
}

// -------------------------------------------------------------- 叙事静物

/**
 * 叙事静物：一个群系一处，数量很少，但每一件都在回答"这里发生过什么"。
 *
 * ## 和群系装饰的差别是摆位
 *
 * 碎石、煤堆本来就该撒满整片场地；长椅、路牌、撬棍不行 —— 一张摆在旷野正中的
 * 长椅不解释任何事，只是多出一个可疑的平地摆设。所以它们沿盒子脚印的外圈采样
 * （nearBoxSpots），贴着墙根出现。沼泽与采石场反过来：那边根本没有墙可贴，
 * 木桩、断牌、撬棍本来就该躺在野地里，所以走均匀撒点。
 *
 * ## 为什么要把一整处静物烘成一件几何
 *
 * 长椅 + 灯柱 + 灯罩是 8 块几何，如果各用一个 InstancedMesh 就是 16 个 draw call。
 * 全部烘进顶点色之后，一处静物只花 1 次主体 + 1 次墨线。这条路子是本轮所有
 * "加细节"动作能成立的前提。
 */
function buildNarrative(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
  density: number,
  placeable: (x: number, z: number, spawnRing?: number) => boolean,
  biome: Biome,
): void {
  const spec = narrativeSpec(biome)
  // 至少 2 处：只有一处的话，走运的玩家整局都碰不上这张图想讲的那句话。
  const count = Math.max(2, Math.round(spec.count * density))
  const wild = biome === 'swamp' || biome === 'quarry'
  let spots = wild
    ? scatterSpots(level, rng, count, 9, placeable)
    : nearBoxSpots(level, rng, count, placeable)
  // 教堂、车站也可能一张图里一堵够高的墙都没有（只有矮台）。宁可摆远一点，
  // 也不要这一轮新增的静物整组消失。
  if (spots.length < 2) spots = scatterSpots(level, rng, count, 9, placeable)
  placeInstances(root, level, bag, gradientMap, rng, spec, spots)
}

function narrativeSpec(biome: Biome): PropSpec {
  switch (biome) {
    case 'quarry':
      // 撬棍 + 碎石 + 垫木：采石场"人刚走"的全部证据。
      return { geo: quarryWorkGeometry(), count: 4, scaleMin: 0.9, scaleMax: 1.2, sink: 0.05, ink: 1.2 }
    case 'swamp':
      // 歪掉的路牌 + 三根木桩。墨线收窄到 0.85：板子只有 3.5cm 厚，外扩两像素
      // 就把整块板吃成黑片了。
      return { geo: swampMarkGeometry(), count: 4, scaleMin: 0.85, scaleMax: 1.15, sink: 0.09, ink: 0.85 }
    case 'farm':
      // 农舍门廊下的一条长椅和一盏油灯。
      return { geo: benchLanternGeometry(), count: 3, scaleMin: 0.9, scaleMax: 1.1, sink: 0.03, ink: 1.0 }
    case 'church':
    case 'station':
      // 墓园墙边与站台上都该有一条能坐的长椅、一盏还挂着的灯。
      return { geo: benchLanternGeometry(), count: 4, scaleMin: 0.9, scaleMax: 1.1, sink: 0.03, ink: 1.0 }
    case 'forest':
      // 砍到一半的树桩 + 插在里面的斧头：伐木队"刚走"的唯一证据。
      return { geo: axeStumpGeometry(), count: 4, scaleMin: 0.9, scaleMax: 1.2, sink: 0.06, ink: 1.1 }
  }
}

/** 斧头桩：树桩 + 斧柄 + 斧刃 + 脚边木屑。 */
function axeStumpGeometry(): BufferGeometry {
  return assemble([
    paint(new CylinderGeometry(0.32, 0.42, 0.6, 7).translate(0, 0.3, 0), 0x4a3524),
    paint(new CylinderGeometry(0.32, 0.32, 0.05, 7).translate(0, 0.62, 0), 0x8a7048),
    paint(new BoxGeometry(0.06, 0.9, 0.06).rotateZ(0.42).translate(0.2, 0.96, 0), 0x6b4a2e),
    paint(new BoxGeometry(0.28, 0.18, 0.05).rotateZ(0.42).translate(0.38, 1.32, 0), 0x8d9196),
    paint(new BoxGeometry(0.22, 0.03, 0.12).translate(-0.3, 0.02, 0.2), 0x9a8256),
  ])
}

/**
 * 墓碑：底座 + 碑身 + 拱顶 + 正面凸起的十字。
 *
 * 十字是**凸**出来的而不是刻进去的：凹槽在 toon 的四级色阶里几乎看不见，
 * 而凸起的一条会在顶上吃到最亮的一级，十米外就能认出"这是块碑"。
 */
function headstoneGeometry(): BufferGeometry {
  return assemble([
    paint(new BoxGeometry(0.46, 0.9, 0.13).translate(0, 0.55, 0), 0x7b756c),
    // 拱顶：一个盒子绕 Z 转 45° 卡在碑顶，低多边形也读得出"圆头碑"。
    paint(new BoxGeometry(0.32, 0.32, 0.14).rotateZ(Math.PI / 4).translate(0, 1.0, 0), 0x7b756c),
    paint(new BoxGeometry(0.07, 0.4, 0.014).translate(0, 0.76, 0.072), 0x8d8780),
    paint(new BoxGeometry(0.26, 0.07, 0.014).translate(0, 0.86, 0.072), 0x8d8780),
    // 底座：埋进土里的一圈。少了它，碑就像插在地上的一张纸。
    paint(new BoxGeometry(0.58, 0.16, 0.24).translate(0, 0.1, 0), 0x66615a),
  ])
}

/** 木十字架：墓园里比石碑便宜的那一半。上沿比横臂暗一档，免得读成一块 T 形板。 */
function crossMarkerGeometry(): BufferGeometry {
  return assemble([
    paint(new BoxGeometry(0.13, 1.05, 0.11).translate(0, 0.52, 0), 0x746e66),
    paint(new BoxGeometry(0.52, 0.13, 0.1).translate(0, 0.78, 0), 0x7d776e),
    paint(new BoxGeometry(0.34, 0.12, 0.2).translate(0, 0.06, 0), 0x615c55),
  ])
}

/**
 * 一只六辐车轮：轮圈 + 轮毂 + 三根贯穿辐条（每根都是一条直径，所以三根就是六根）。
 * 原点在轮心、轮面在 XY 平面 —— 立起来直接用，绕 X 转 90° 就是躺在地上。
 */
function cartWheelGeometry(radius: number, rim: number, spoke: number, withSpokes: boolean): BufferGeometry {
  const parts: BufferGeometry[] = [paint(new TorusGeometry(radius, 0.05, 4, 10), rim)]
  if (withSpokes) {
    parts.push(paint(new CylinderGeometry(0.09, 0.09, 0.18, 6).rotateX(Math.PI / 2), spoke))
    for (let i = 0; i < 3; i++) {
      parts.push(paint(new BoxGeometry(radius * 2, 0.05, 0.05).rotateZ((i * Math.PI) / 3), spoke))
    }
  }
  return assemble(parts)
}

/**
 * 废掉的马车：车斗 + 一只还立着的轮子 + 一只躺平的轮子 + 折断的车轴 + 两块散板。
 *
 * withSpokes = false 时省掉辐条辐毂，用来生成**墨线外壳**：辐条只有 5cm，
 * 照它外扩两像素会让整只轮子变成一块黑饼，于是外壳只包车斗与轮圈。
 */
function brokenCartGeometry(withSpokes: boolean): BufferGeometry {
  const WOOD = 0x5a4630
  const WOOD_HI = 0x6d5638
  const IRON = 0x3c3a36
  const parts: BufferGeometry[] = [
    // 车斗：一块底板 + 两侧矮栏。矮栏刻意压到膝高 —— 一张看着能躲的车斗，
    // 玩家一定会去试，试一次就不再信这个世界的碰撞。
    paint(new BoxGeometry(1.9, 0.14, 0.9).translate(0, 0.36, 0), WOOD),
    paint(new BoxGeometry(1.9, 0.2, 0.08).translate(0, 0.52, 0.41), WOOD_HI),
    paint(new BoxGeometry(1.9, 0.2, 0.08).translate(0, 0.52, -0.41), WOOD_HI),
    // 折断的车轴：一头折了口，所以车斗才朝那边歪着。
    paint(new BoxGeometry(0.2, 0.16, 1.42).translate(0.12, 0.28, 0), IRON),
    paint(new BoxGeometry(0.16, 0.14, 0.34).rotateZ(0.5).translate(0.12, 0.17, 0.8), IRON),
    // 散在地上的两块板。
    paint(new BoxGeometry(0.9, 0.06, 0.22).rotateY(0.5).translate(-0.9, 0.03, 0.5), WOOD),
    paint(new BoxGeometry(0.7, 0.06, 0.2).rotateY(-0.9).translate(0.95, 0.03, -0.45), WOOD_HI),
    // 还立着的右轮：轮子比车斗低半头，整件东西的重心才落在地上。
    cartWheelGeometry(0.5, IRON, WOOD_HI, withSpokes).rotateZ(0.05).translate(-0.5, 0.5, 0.52),
    // 躺平的左轮：歪在车旁，说明"这车不是停在这儿，是坏的"。
    cartWheelGeometry(0.46, IRON, WOOD_HI, withSpokes).rotateX(Math.PI / 2).rotateY(0.9).translate(0.85, 0.05, -0.55),
  ]
  return assemble(parts)
}

/**
 * 长椅 + 油灯：一处"有人在这儿坐过"的最小集合。
 *
 * 灯罩是整张图里唯一的暖色（0xa8935c）。在墨绿偏蓝的雾里，一点暖光比任何形状
 * 都更早被看见，所以它不只是一个细节，也是一个地标。
 */
function benchLanternGeometry(): BufferGeometry {
  const BENCH = 0x7a6045
  const DARK = 0x5c4a37
  const IRON = 0x3a3833
  return assemble([
    paint(new BoxGeometry(1.6, 0.09, 0.34).translate(0, 0.44, 0), BENCH),
    paint(new BoxGeometry(0.1, 0.42, 0.3).translate(-0.62, 0.21, 0), DARK),
    paint(new BoxGeometry(0.1, 0.42, 0.3).translate(0.62, 0.21, 0), DARK),
    // 靠背往后仰 9°：竖直的靠背读起来像一块挡板。
    paint(new BoxGeometry(1.6, 0.22, 0.06).rotateX(-0.16).translate(0, 0.68, -0.2), BENCH),
    // 灯柱 + 横臂 + 吊在臂端的灯。
    paint(new CylinderGeometry(0.045, 0.07, 1.72, 6).translate(1.05, 0.86, 0), IRON),
    paint(new BoxGeometry(0.34, 0.05, 0.05).translate(0.9, 1.7, 0), IRON),
    paint(new BoxGeometry(0.12, 0.03, 0.12).translate(0.74, 1.56, 0), IRON),
    paint(new CylinderGeometry(0.07, 0.09, 0.18, 6).translate(0.74, 1.45, 0), 0xa8935c),
  ])
}

/**
 * 沼泽边的木桩与残破路牌。路牌不指任何方向正是重点 —— 它曾经指过。
 */
function swampMarkGeometry(): BufferGeometry {
  const WET = 0x6a5540
  const OLD = 0x5a4735
  return assemble([
    // 立柱往一边歪 9°，牌板再歪 24°：一块还挂在钉子上的板不会和柱子同角度。
    paint(new BoxGeometry(0.08, 1.6, 0.08).rotateZ(0.16).translate(-0.6, 0.8, 0), WET),
    paint(new BoxGeometry(0.62, 0.26, 0.035).rotateZ(0.42).translate(-0.3, 1.2, 0.02), OLD),
    paint(new BoxGeometry(0.04, 0.05, 0.05).translate(-0.42, 1.24, 0.03), 0x3c3a36),
    // 三根打进泥里的桩：一高一低，一根已经倒伏。
    paint(new CylinderGeometry(0.055, 0.075, 0.95, 5).rotateZ(0.06).translate(0.3, 0.44, 0.1), WET),
    paint(new CylinderGeometry(0.05, 0.07, 0.62, 5).rotateZ(-0.1).translate(0.72, 0.28, -0.2), WET),
    paint(new BoxGeometry(0.9, 0.07, 0.07).rotateY(0.7).translate(0.5, 0.09, 0.55), OLD),
  ])
}

/** 采石场的一小摊活儿：碎石 + 撬棍 + 垫木。撬棍是"人刚走"的唯一证据。 */
function quarryWorkGeometry(): BufferGeometry {
  return assemble([
    paint(new DodecahedronGeometry(0.34, 0).scale(1, 0.62, 1).translate(0, 0.2, 0), 0x6a6c6e),
    paint(new DodecahedronGeometry(0.26, 0).scale(1.1, 0.55, 1).translate(0.42, 0.14, 0.2), 0x7a7c7e),
    paint(new DodecahedronGeometry(0.2, 0).scale(1, 0.6, 1).translate(-0.3, 0.11, -0.22), 0x7a7c7e),
    // 撬棍：斜插在碎石里的铁杆，上端一个弯头（撬棍的弯头是它唯一的识别特征）。
    paint(new BoxGeometry(0.055, 0.86, 0.055).rotateZ(-0.42).rotateX(0.16).translate(0.16, 0.42, 0.06), 0x47474a),
    paint(new BoxGeometry(0.055, 0.05, 0.16).rotateZ(0.14).translate(0.33, 0.8, 0.13), 0x47474a),
    // 垫木：撬石头的人垫在下面的那块。
    paint(new BoxGeometry(0.8, 0.08, 0.24).rotateY(-0.5).translate(-0.15, 0.04, 0.42), 0x5c4a37),
  ])
}

/**
 * 木箱：方，檐口比箱身宽出一圈，四角被铁皮包住。
 *
 * 檐口那一圈是远距离唯一读得到的东西 —— 一块方木头在雾里只是"一个方块"，
 * 而方块上面再压一条略宽的板，剪影立刻变成"箱盖"。
 */
function crateSpotGeometry(): BufferGeometry {
  const CRATE_WOOD = 0x7d5b39
  const CRATE_RIM = 0x9c7644
  const CRATE_BAND = 0x4a3a28
  const CRATE_IRON = 0x3e3b35
  const parts: BufferGeometry[] = [
    paint(new BoxGeometry(0.64, 0.46, 0.48).translate(0, 0.26, 0), CRATE_WOOD),
    paint(new BoxGeometry(0.7, 0.06, 0.54).translate(0, 0.52, 0), CRATE_RIM),
    paint(new BoxGeometry(0.66, 0.05, 0.5).translate(0, 0.34, 0), CRATE_BAND),
    // 正面的两道板缝：1.4cm 的暗线，三米内才看得见，但凑近就全靠它们。
    paint(new BoxGeometry(0.6, 0.014, 0.012).translate(0, 0.17, 0.243), CRATE_BAND),
    paint(new BoxGeometry(0.6, 0.014, 0.012).translate(0, 0.44, 0.243), CRATE_BAND),
  ]
  // 四角竖着包一条铁皮：这是"能翻的箱子"和"一块木头"的分界。
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(paint(new BoxGeometry(0.055, 0.5, 0.055).translate(sx * 0.313, 0.27, sz * 0.237), CRATE_IRON))
    }
  }
  return assemble(parts)
}

/**
 * 麻袋：圆，顶上收口束成一个疙瘩。
 *
 * 它必须比木箱高一头、并且顶上有个"尖" —— 三种搜刮点的剪影如果都是方块，
 * 玩家只能走到跟前才分得出哪个是哪个，"远处能看见目标"就等于没做。
 */
function sackSpotGeometry(): BufferGeometry {
  const CLOTH = 0x7a6d56
  const CLOTH_HI = 0x8b7d63
  const ROPE = 0x4f4638
  return assemble([
    paint(new CylinderGeometry(0.27, 0.31, 0.46, 8, 1).translate(0, 0.25, 0), CLOTH),
    // 收口：从袋身往上收细的一截，读作"布被攥起来了"。
    paint(new CylinderGeometry(0.13, 0.27, 0.16, 8, 1).translate(0, 0.56, 0), CLOTH_HI),
    paint(new CylinderGeometry(0.145, 0.155, 0.05, 8, 1).translate(0, 0.66, 0), ROPE),
    // 束口以上的布头：Dodecahedron 的棱正好是揉皱的布。
    paint(new DodecahedronGeometry(0.085, 0).translate(0, 0.71, 0), CLOTH_HI),
  ])
}

/**
 * 尸体：长而扁，一头伸出两只靴子、另一头是发暗的头，中间甩着一条外露的手臂。
 *
 * 这一件是三种里最要紧的：一具"卷起来的布包"和一具"能搜的尸体"在剪影上本来
 * 没有区别，而手和靴子是人体唯一不需要解释的部分。
 */
function corpseSpotGeometry(): BufferGeometry {
  const CLOTH = 0x40382f
  const COAT = 0x4a4238
  const HEAD = 0x554a3f
  const LEATHER = 0x342d26
  return assemble([
    // 躯干：低而长。
    paint(new BoxGeometry(0.62, 0.2, 0.4).translate(0.06, 0.1, 0), CLOTH),
    // 肩/外衣隆起的一块：人躺下时最厚的在肩，不在腰。
    paint(new BoxGeometry(0.26, 0.24, 0.42).translate(-0.12, 0.13, 0), COAT),
    // 头：一个多面体 + 一块更暗的头发，把"头"从"布包"里分出来。
    paint(new DodecahedronGeometry(0.105, 0).translate(-0.3, 0.12, 0.01), HEAD),
    paint(new DodecahedronGeometry(0.075, 0).translate(-0.36, 0.15, -0.02), 0x2e2823),
    // 外露的手臂：从肩下甩出去，末端一只手掌。
    paint(new BoxGeometry(0.34, 0.07, 0.08).rotateY(0.5).rotateZ(0.18).translate(-0.02, 0.07, 0.26), COAT),
    paint(new BoxGeometry(0.1, 0.055, 0.1).rotateY(0.5).translate(0.13, 0.075, 0.35), 0x6a5b4b),
    // 靴子：从躯干另一端伸出去两只 —— 这是"尸体"和"一卷布"的差别。
    paint(new BoxGeometry(0.2, 0.13, 0.11).translate(0.42, 0.065, 0.09), LEATHER),
    paint(new BoxGeometry(0.2, 0.13, 0.11).translate(0.42, 0.065, -0.1), LEATHER),
  ])
}

/**
 * 搜刮点：木箱 / 麻袋 / 尸包。
 *
 * ## 为什么必须有"看得见的东西"
 *
 * 「搜」如果只是走到某个坐标按住 E、屏幕角上多一行字，玩家永远记不住哪儿能搜，
 * 也就不会有"绕去那间屋子翻箱"的路线规划 —— 搜打撤里的「搜」正是靠这个长出来的。
 * 所以服务端只给坐标和类型（level.searchSpots），形状与朝向全部在这里定：
 * 服务端不知道它长什么样，也不需要知道。
 *
 * ## 为什么和别的装饰不同：必须有轮廓
 *
 * 芦苇和枯树是背景，糊一点反而对；搜刮点是**目标**，玩家要在三十米外一眼认出
 * "那边有个能翻的箱子"。所以配色比周围亮一档、并且强制带一层墨线外壳，
 * 让它在雾里也留得下一个形状。
 *
 * ## 三种形制必须在**剪影**上分开
 *
 * 雾里三十米，玩家分辨的是轮廓而不是颜色。所以三种点各长成一个读得出来的形：
 *
 *   木箱 —— 方。檐口比箱身宽出一圈，四角被铁皮包住。
 *   麻袋 —— 圆。顶上收口束成一个疙瘩，比箱子高出一头。
 *   尸体 —— 长而扁。一头发暗，另一头伸出两只靴子，侧面甩着一条手臂。
 *
 * 颜色仍然压在 GROUND_PALETTE 同一档里（木 0x7d5b39 / 麻 0x7a6d56 / 布 0x40382f）。
 * 所谓"提亮"只是把檐口、收口、肩线抬一档 —— 在四级 toon 色阶里已经够跳出来，
 * 而整张图不会因此冒出一颗糖果。
 *
 * ## 每类一个 InstancedMesh
 *
 * 一张图十六个点，三类各一次 InstancedMesh + 一次墨线外壳 = 最多 6 个 draw call，
 * 与摆十几个单独 Mesh 相差一个数量级。这一轮加的零件（铁角、箍带、收口、手、靴）
 * 全部烘进同一份顶点色几何，所以细节变多了，6 这个数字没动。
 *
 * 实例化之后"被搜过了要变样"也没法逐实例改材质，所以外观一律静态 —— 搜过的反馈
 * 交给 overlay 的提示与音效，而非"箱子消失"这种一眼假的处理。
 */
function buildSearchSpots(root: Group, level: LevelDef, bag: GpuBag, gradientMap: DataTexture): void {
  const spots = level.searchSpots
  if (!spots || spots.length === 0) return

  // 三份几何按需建：老关卡的 searchSpots 里可能只有木箱，另外两种不必占内存。
  const kinds: { kind: SearchKind; make: () => BufferGeometry }[] = [
    { kind: 'crate', make: crateSpotGeometry },
    { kind: 'sack', make: sackSpotGeometry },
    { kind: 'corpse', make: corpseSpotGeometry },
  ]

  // 朝向没写时按坐标派生：同一张图每次加载角度一致，不会"今天歪、明天正"。
  const yawOf = (spot: SearchSpot, index: number): number => {
    if (typeof spot.rotY === 'number') return spot.rotY
    return ((Math.sin(index * 12.9898) * 43758.5453) % 1) * Math.PI * 2
  }

  // 三类的材质完全一样（纯白 × 顶点色），所以整张图只要两份：本体 + 墨线外壳。
  const mat = makePartMaterial(bag, gradientMap)
  // 外扩量比芦苇树梢细一档：这些东西本身只有半米高，线一粗就成了墨块。
  const ink = makeInkMaterial(bag, INK_BASE * 0.75)

  const dummy = new Object3D()
  for (const spec of kinds) {
    const members: { spot: SearchSpot; index: number }[] = []
    for (let i = 0; i < spots.length; i++) {
      const spot = spots[i]!
      if (spot.kind === spec.kind) members.push({ spot, index: i })
    }
    if (members.length === 0) continue

    const geo = spec.make()
    bag.add(geo)
    const mesh = new InstancedMesh(geo, mat, members.length)
    bag.add(mesh)
    // 墨线共用同一份几何：这些形体本来就是"大块套小块"，一起包边正合适。
    const hull = new InstancedMesh(geo, ink, members.length)
    bag.add(hull)
    hull.raycast = (): void => {}

    for (let i = 0; i < members.length; i++) {
      const { spot, index } = members[i]!
      // 几何的原点就在底面中心，所以直接贴地；再沉 2cm 免得底边透光。
      dummy.position.set(spot.x, level.groundY - 0.02, spot.z)
      dummy.rotation.set(0, yawOf(spot, index), 0)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      hull.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    hull.instanceMatrix.needsUpdate = true
    root.add(mesh)
    root.add(hull)
  }

  // 搜刮点也补一层接地影：木箱/麻袋/尸体是最需要读高度的目标，
  // 没有影子时它们像浮在泥面上。全部点一次 InstancedMesh，1 个 draw call。
  const shadowTex = createShadowTexture()
  const shadowMat = createShadowMaterial(shadowTex, 0.42)
  bag.add(shadowTex, shadowMat)
  const shadows = new InstancedMesh(SHADOW_GEOMETRY, shadowMat, spots.length)
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i]!
    dummy.position.set(spot.x, level.groundY + 0.015, spot.z)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.set(0.9, 1, 1.2)
    dummy.updateMatrix()
    shadows.setMatrixAt(i, dummy.matrix)
  }
  shadows.instanceMatrix.needsUpdate = true
  root.add(shadows)
}

/** 一个待摆放的位置。缩放不在这里定 —— 它属于实例化那一步的随机量。 */
interface PropSpot {
  x: number
  z: number
  yaw: number
}

/**
 * 在一张图上均匀撒点：半径 94% 内随机、避开出生点、彼此至少隔 minGap。
 *
 * 只回答"摆在哪"，不碰几何 —— 同一次撒点既能喂装饰，也能喂叙事静物。
 */
function scatterSpots(
  level: LevelDef,
  rng: () => number,
  count: number,
  minGap: number,
  placeable: (x: number, z: number, spawnRing?: number) => boolean,
): PropSpot[] {
  const spots: PropSpot[] = []
  let guard = 0
  while (spots.length < count && guard < count * 60) {
    guard++
    const x = (rng() * 2 - 1) * level.boundsHalf * 0.94
    const z = (rng() * 2 - 1) * level.boundsHalf * 0.94
    if (!placeable(x, z, 5)) continue
    let tooClose = false
    for (const other of spots) {
      if (Math.hypot(other.x - x, other.z - z) < minGap) {
        tooClose = true
        break
      }
    }
    if (tooClose) continue
    spots.push({ x, z, yaw: rng() * Math.PI * 2 })
  }
  return spots
}

/**
 * 沿**建筑脚印的外圈**撒点：长椅、油灯、路牌这一类东西不该散在野地里，
 * 它们得贴着墙根、门口、站台边，才读得出"有人在这儿住过"。
 *
 * 只认半高 1.2 米以上的盒子（矮墩、台阶、地台都不算"墙"），否则一条地台边上
 * 会围一圈长椅。间距放到 7 米：一件静物自己就有 1.6 米宽，靠太近会叠在一起。
 */
function nearBoxSpots(
  level: LevelDef,
  rng: () => number,
  count: number,
  placeable: (x: number, z: number, spawnRing?: number) => boolean,
): PropSpot[] {
  const walls = level.boxes.filter((box) => box.hy * 2 >= 1.2)
  const spots: PropSpot[] = []
  if (walls.length === 0) return spots
  const minGap = 7
  let guard = 0
  while (spots.length < count && guard < count * 60) {
    guard++
    const box = walls[Math.floor(rng() * walls.length) % walls.length]!
    // 带 rotY 的盒子是"躺着的长方体"，外圈得按对角线量，否则会插进墙里。
    const reach = (box.rotY ? Math.hypot(box.hx, box.hz) : Math.max(box.hx, box.hz)) + 1.0 + rng() * 1.8
    const angle = rng() * Math.PI * 2
    const x = box.x + Math.cos(angle) * reach
    const z = box.z + Math.sin(angle) * reach
    if (!placeable(x, z, 5)) continue
    let tooClose = false
    for (const other of spots) {
      if (Math.hypot(other.x - x, other.z - z) < minGap) {
        tooClose = true
        break
      }
    }
    if (tooClose) continue
    // 朝向背对墙：长椅和路牌都是"面朝空处"摆的。
    spots.push({ x, z, yaw: angle + Math.PI / 2 })
  }
  return spots
}

/**
 * 把一份几何摆到一组位置上：一次 InstancedMesh + 一次墨线外壳，共 2 个 draw call。
 *
 * 墨线外壳尽量吃 spec.hullGeo —— 也就是简化过的副本。马车辐条这种不到三厘米的
 * 细零件如果也包边，外扩之后彼此粘连，整辆马车就成一团黑。
 */
function placeInstances(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
  spec: PropSpec,
  spots: PropSpot[],
): void {
  if (spots.length === 0) return
  bag.add(spec.geo)
  const mesh = new InstancedMesh(spec.geo, makePartMaterial(bag, gradientMap), spots.length)
  bag.add(mesh)

  let hulls: InstancedMesh | null = null
  if (spec.ink > 0) {
    const hullGeo = spec.hullGeo ?? spec.geo
    if (hullGeo !== spec.geo) bag.add(hullGeo)
    hulls = new InstancedMesh(hullGeo, makeInkMaterial(bag, INK_BASE * spec.ink), spots.length)
    bag.add(hulls)
    hulls.raycast = (): void => {}
  }

  const tilt = spec.tilt ?? 0
  const dummy = new Object3D()
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i]!
    const scale = spec.scaleMin + rng() * (spec.scaleMax - spec.scaleMin)
    dummy.position.set(spot.x, level.groundY - spec.sink * scale, spot.z)
    // 墓碑靠倾斜拿掉"整齐感"：一排同角度的石头比一排歪石头更假。
    const lean = tilt > 0 ? (rng() - 0.5) * 2 * tilt : 0
    dummy.rotation.set(lean, spot.yaw, tilt > 0 ? (rng() - 0.5) * 2 * tilt : 0)
    dummy.scale.setScalar(scale)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
    if (hulls) hulls.setMatrixAt(i, dummy.matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
  if (hulls) hulls.instanceMatrix.needsUpdate = true
  root.add(mesh)
  if (hulls) root.add(hulls)
}

/** 单一类型的一群装饰：撒点 + 实例化，共 2 个 draw call。 */
function buildCluster(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
  spec: PropSpec,
  count: number,
  placeable: (x: number, z: number, spawnRing?: number) => boolean,
): void {
  if (count <= 0) return
  // 平均间距由数量反推：地图越大、同类越多，允许彼此靠得越近。
  const minGap = Math.max(1.5, (level.boundsHalf * 1.3) / Math.sqrt(count))
  placeInstances(root, level, bag, gradientMap, rng, spec, scatterSpots(level, rng, count, minGap, placeable))
}

/**
 * 车站的铁轨：一对钢轨 + 一排枕木，横穿整张图。
 *
 * 为什么值得单开一段：铁轨是这个群系唯一**能一句话说清**的地标 —— 玩家从出生点
 * 走出来看见两条平行亮线，立刻知道自己站在车站而不是又一片沼泽。整段是一个
 * Group（2 根轨道 + 1 个枕木 InstancedMesh = 3 个 draw call），做成装饰不参与碰撞，
 * 因为轨面只有 14cm 高，踩上去本来也不该绊人。
 */
function buildRails(
  root: Group,
  level: LevelDef,
  bag: GpuBag,
  gradientMap: DataTexture,
  rng: () => number,
): void {
  const group = new Group()
  const offset = (rng() * 2 - 1) * level.boundsHalf * 0.42
  const alongZ = rng() < 0.5
  group.position.set(alongZ ? offset : 0, level.groundY, alongZ ? 0 : offset)
  if (!alongZ) group.rotation.y = Math.PI / 2

  const length = level.boundsHalf * 2.02
  const railGeo = new BoxGeometry(0.13, 0.14, length)
  bag.add(railGeo)
  const railMat = makeToon(0x5c5f63, bag, { gradientMap, surface: 'metal', specular: 0.18 })
  for (const dx of [-0.72, 0.72]) {
    const rail = new Mesh(railGeo, railMat)
    rail.position.set(dx, 0.26, 0)
    group.add(rail)
  }

  const sleeperGeo = new BoxGeometry(2.7, 0.18, 0.24)
  bag.add(sleeperGeo)
  const sleeperMat = makeToon(0x42332a, bag, { gradientMap, surface: 'wood' })
  const count = Math.max(1, Math.floor(length / 1.15))
  const sleepers = new InstancedMesh(sleeperGeo, sleeperMat, count)
  bag.add(sleepers)
  const dummy = new Object3D()
  for (let i = 0; i < count; i++) {
    dummy.position.set(0, 0.09, -length / 2 + (i + 0.5) * (length / count))
    dummy.rotation.set(0, 0, 0)
    dummy.scale.setScalar(1)
    dummy.updateMatrix()
    sleepers.setMatrixAt(i, dummy.matrix)
  }
  sleepers.instanceMatrix.needsUpdate = true
  group.add(sleepers)
  root.add(group)
}
