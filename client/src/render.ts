/**
 * 渲染层：三渲二卡通（《无主之地》式墨线）场景、关卡网格、角色模型、曳光弹。
 *
 * 这一层刻意不认识网络和物理 —— 它只接收"本帧应该画成什么样"的数据。
 * 于是"画面卡"和"位置不对"能被分开排查：画面问题看这里，位置问题看
 * game.ts 的预测与插值。
 *
 * ## 三渲二的四根柱子
 *
 * 1. **阶梯着色**：MeshToonMaterial + 一张 4 级的 gradientMap。光照不再
 *    连续过渡，而是被打成 4 个色阶 —— 这就是"手绘上色"与"照片"的分界线。
 * 2. **墨线描边**：把几何体复制一份、法线方向外扩、side: BackSide，形成
 *    一圈背面外壳。关键那一步是外扩量乘了 pos.w，于是线宽在**屏幕上
 *    恒定**（远处不糊成一片，近处不粗成一坨），这正是手绘墨线的行为。
 * 3. **纸感**：index.html 的 #grain 覆盖层（CSP 禁止外部资源，所以噪音
 *    是内联 SVG data-URI）负责静态纸纹；动态颗粒与暗角在 postfx 的合成里。
 * 4. **线条沸腾（boiling line）**：描边宽度按 12fps 在 0.85~1.15 倍之间跳，
 *    模仿手绘动画每张略有差异。**只动描边宽度，绝不抖动碰撞几何** ——
 *    视觉抖动可以，判定抖动会让"明明打中了却穿过去"。
 *
 * ## 为什么现在要后处理，但不用 EffectComposer
 *
 * 色阶和描边决定"看起来像不像手绘"，但决定"糊不糊"的是采样与高光：
 * 世界必须先进一张 HDR + MSAA 的浮点 RT，武器再单独进一张全分辨率透明 RT，
 * 然后才有地方做泛光、AgX 色调映射、降分辨率后的锐化和 FXAA。
 * 这些在 examples/jsm 的 composer 里会被拆成十几次 RT 往返和一套自己的
 * 色彩空间约定；这里用四个自写的全屏 pass（postfx.ts）就够，少一层抽象、
 * 也少一处"颜色到底在哪转"的坑。
 */

import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PointLight,
  RedFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
  type Texture,
} from 'three'
// 关卡盒子合批要用它：944 个盒子逐个 Mesh + 墨线壳 + 棱线 = 约 2800 个 draw call，
// 1080p 下掉到 31fps。按材质合并成一份几何体后降到 ~15 个。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { applyComicInk, setInkDetail, setInkKeyDirection, type ComicSurface } from './ink.ts'
import { createOutlineMaterial, setOutlineBoil, setOutlineResolution } from './outline.ts'
import { PostFX } from './postfx.ts'
import { probeGpu, type GpuInfo } from './gpu.ts'
import { createHunterMaterials, createHunterModel, type HunterMaterials, type HunterModel } from './hunter.ts'
import { createHunterTextures, type HunterTextures } from './baked-textures.ts'
import type { GraphicsQuality } from './settings.ts'
import { buildProps, type Props } from './props.ts'
import { createMonsterRenderer, type MonsterRenderer, type MonsterView } from './monsters.ts'
import { createObjectiveMarkers, type ObjectiveMarkers, type ObjectiveView } from './markers.ts'
import { createVfx, type ImpactKind, type Vfx } from './vfx.ts'
import { createAtmosphere, type Atmosphere } from './atmosphere.ts'
import { createEnvironmentProbe, type EnvironmentProbe } from './environment.ts'
import { SHADOW_GEOMETRY, createShadowMaterial, createShadowTexture } from './shadows.ts'
import { createViewmodel, type Viewmodel, type ViewmodelKit, type ViewmodelState } from './viewmodel.ts'

import {
  DEFAULT_WEAPON_ID,
  SCOPE_MIN_ZOOM,
  WEAPONS,
  StateFlags,
  type BoxBrush,
  type LevelDef,
  type PlayerSnapshot,
  type Vec3,
} from '@dk/shared'

/**
 * 材质提示 → 卡通固有色。
 *
 * 卡通渲染里**固有色就是最终色**（只被 4 个色阶乘一下），所以这些值必须
 * 直接取"手绘上色时挑的那一管颜料"，而不是像 PBR 那样给一个偏暗的底色
 * 指望光照提亮。饱和度拉高、明度拉开，否则 4 个色阶挤在一起看不出分级。
 */
/**
 * 每种材质在污渍斑块里混进的第二色与混入量。
 *
 * 关键在"每面墙的苔色不一样"：同一种石头用了同一份材质实例（几何/材质
 * 都是复用的），如果第二色也统一，十面墙会同时出现同一片绿斑，读成贴图
 * 平铺。这里只按材质分档 —— 再细就得给每面墙单独建材质，不值。
 */
const MATERIAL_TINT: Record<string, { tint: number; amount: number }> = {
  wood: { tint: 0x2b2418, amount: 0.35 },
  stone: { tint: 0x24322c, amount: 0.4 },
  mud: { tint: 0x2a2b1c, amount: 0.45 },
  metal: { tint: 0x2c2a20, amount: 0.32 },
  foliage: { tint: 0x1d2a14, amount: 0.4 },
}

/**
 * 关卡五种基础材质的固有色 + 程序化细节家族。
 *
 * 固有色仍是"手绘上色时挑的那一管颜料"（卡通渲染里它就是最终色），新增的
 * `surface` 只提供世界空间的固有色级细节：砖缝、木纹、拉丝、泥点、叶簇。
 * 它不改变光照模型，所以 4 级色阶仍然是画面的结构。
 */
const MATERIALS: Record<string, { color: number; surface: ComicSurface; specular: number; rim: number }> = {
  wood: { color: 0x8d7154, surface: 'wood', specular: 0.04, rim: 0.03 },
  stone: { color: 0x5a6169, surface: 'stone', specular: 0.05, rim: 0.035 },
  mud: { color: 0x746349, surface: 'mud', specular: 0.025, rim: 0.02 },
  metal: { color: 0x7f8a95, surface: 'metal', specular: 0.38, rim: 0.1 },
  foliage: { color: 0x5f7248, surface: 'foliage', specular: 0, rim: 0.02 },
}

/**
 * 地面配色按关卡的 `groundMaterial` 分档。
 *
 * 原来四张图共用同一个 0x51493a：地形盒子各不相同，可脚下永远是同一片暗棕，
 * 远景一糊就分不出自己在沼泽还是采石场。地面是占屏面积最大的一块，
 * 它不换色，玩家就觉得"四张图是同一张"。
 * 三种都压得比掩体暗、比掩体脏：地面要退后，掩体与角色才能"跳"出来。
 */
const GROUND_PALETTE: Record<string, { color: number; tint: number; tintAmount: number; surface: ComicSurface; specular: number }> = {
  /** 沼泽泥地：湿冷偏绿的深棕。 */
  mud: { color: 0x51493a, tint: 0x2a2c1c, tintAmount: 0.5, surface: 'mud', specular: 0.03 },
  /** 石地/采石场：冷灰，比泥地亮一档，碎石的亮面才站得住。 */
  stone: { color: 0x63655e, tint: 0x232830, tintAmount: 0.44, surface: 'stone', specular: 0.05 },
  /** 车站木栈：偏暖的旧木，尘埃感靠 tint 的暖棕。 */
  wood: { color: 0x6b5942, tint: 0x33291a, tintAmount: 0.42, surface: 'wood', specular: 0.04 },
}

/** 曳光弹存活时间（秒）。短于感知阈值会看不见，长了像激光。 */
const TRACER_LIFE = 0.09

/**
 * 描边基准宽度，单位是 **CSS 像素**（不是 NDC）。
 *
 * 早先按 NDC 给 0.0035，在 1280×720 下横向折 2.24px、纵向只有 1.26px ——
 * 宽屏上所有描边都被压成细线，"有，但读不出来"。改成像素后由 outline.ts
 * 用 uRes=(2/W, 2/H) 换算，两个轴的物理粗细一致。
 *
 * 2.6px 是折中：低于 2px 在集显 + 无 MSAA 的实际渲染里会被吃掉一两个像素，
 * 高到 4px 木箱那种半米见方的小物件就糊成黑块了。
 */
const INK_PIXELS = 2.6

/**
 * 远处角色的描边要比场景更粗。
 *
 * 远处的猎人是战术信息（要一眼分辨是人还是怪），值得加粗。
 * 第一人称武器的描边宽度由 viewmodel.ts 自己持有（它连零件都自己造）。
 */
const AVATAR_INK_PIXELS = 3.4

/** 沸腾频率（Hz）。12fps 是手绘动画的经典"on twos"，再高就不像手绘了。 */
const BOIL_HZ = 12

/**
 * 基础视野角的出厂值（度）。设置面板改 FOV 时改的是这个字段的实例值，
 * 而不是这个常量 —— updateCamera 每帧都要用它算开镜时的收窄量。
 */
const BASE_FOV = 75

/**
 * 开镜时从基础视野收窄多少度。
 *
 * 从 20 提到 24：取消屏幕准星后，照门/准星必须成为唯一的瞄准基准；
 * 稍近的视野让机械瞄具在 1080p 下更大、更容易对齐。
 */
const ADS_FOV_PULL = 24

interface Tracer {
  line: Line
  material: LineBasicMaterial
  life: number
}

/** 远端角色的可视化对象。 */
interface RemoteAvatar {
  group: Group
  model: HunterModel
  /** 上一帧的插值结果，用来算朝向与步行相位。 */
  lastX: number
  lastZ: number
  /** 平滑后的水平速度（m/s），驱动腿摆。 */
  speed: number
  phase: number
}

/**
 * 4 级灰度渐变图，供 MeshToonMaterial.gradientMap 采样。
 *
 * NearestFilter 是重点：线性过滤会把 4 级重又插回连续渐变，等于白做。
 * 用 RedFormat 单通道，因为 toon 着色器只读 .r。
 */
function makeGradientMap(): DataTexture {
  const steps = [0.32, 0.58, 0.82, 1.0]
  const data = new Uint8Array(steps.length)
  for (let i = 0; i < steps.length; i++) data[i] = Math.round(steps[i]! * 255)
  const tex = new DataTexture(data, steps.length, 1, RedFormat)
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

// ------------------------------------------------------------------ 树冠

/** 单位棱球：20 个面、非索引（hence 平直着色）。所有树冠都从它克隆。 */
const CANOPY_BASE = new IcosahedronGeometry(1, 0)

/**
 * 树冠是不是该换成棱球。
 *
 * 关卡里的树是"0.4m 方柱 + 3.2m 立方树冠"（shared/src/maps/kit.ts 的
 * BrushSet.tree）。正视时那块立方体只亮一个面，读成一块扁平绿板 ——
 * 截图里最假的一处。但**长条形的树篱不能换**：20m 长的棱球会变成一颗
 * 躺在地上的巨蛋。所以只换"接近方、边长小"的那一批。
 */
function isCanopy(brush: BoxBrush): boolean {
  if ((brush.material ?? 'wood') !== 'foliage') return false
  const wide = Math.max(brush.hx, brush.hz)
  return wide <= 3.4 && Math.abs(brush.hx - brush.hz) <= 1.6 && brush.hy <= 4
}

/**
 * 造一块不规则树冠。
 *
 * 顶点沿自身方向做 0.82~1.18 的确定性抖动 —— 用顶点序号 + 盒子坐标当种子，
 * 于是同一棵树每次加载长得一样（随机树冠会让同一张图在两局里判若两图），
 * 但相邻的树又各不相同。碰撞仍然用原来的盒子：判定形状不许跟着美术改。
 */
function canopyGeometry(brush: BoxBrush): BufferGeometry {
  const seed = brush.x * 12.9898 + brush.z * 78.233 + brush.y * 37.719
  const blob = (salt: number, sx: number, sy: number, sz: number, ox: number, oy: number, oz: number): BufferGeometry => {
    const geo = CANOPY_BASE.clone()
    const pos = geo.getAttribute('position') as Float32BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const v = Math.sin(seed + salt + i * 2.399) * 43758.5453
      const k = 0.82 + (v - Math.floor(v)) * 0.36
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k)
    }
    pos.needsUpdate = true
    geo.scale(sx, sy, sz)
    geo.translate(ox, oy, oz)
    return geo
  }
  // 一团主冠 + 两团卫星冠：单颗 20 面体在逆光里就是一个球，三团错开才有
  // "树冠边缘参差"的剪影。碰撞仍用原盒子，判定不跟美术改。
  const main = blob(0, brush.hx * 1.12, brush.hy * 1.02, brush.hz * 1.12, 0, 0, 0)
  const sideA = blob(
    1000,
    brush.hx * 0.7,
    brush.hy * 0.64,
    brush.hz * 0.7,
    brush.hx * 0.5,
    brush.hy * 0.16,
    brush.hz * 0.4,
  )
  const sideB = blob(
    2000,
    brush.hx * 0.66,
    brush.hy * 0.6,
    brush.hz * 0.66,
    -brush.hx * 0.48,
    -brush.hy * 0.12,
    -brush.hz * 0.42,
  )
  const geo = mergeGeometries([main, sideA, sideB], false) ?? main
  geo.rotateY((Math.sin(seed) * 0.5 + 0.5) * Math.PI + (brush.rotY ?? 0))
  geo.translate(brush.x, brush.y, brush.z)
  return geo
}

export class Renderer {
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  private readonly gl: WebGLRenderer
  /**
   * 第一人称武器的独立场景与相机。
   *
   * 武器在 VIEW 空间里运动，世界相机矩阵描述不了它；塞进同一个场景还会带来
   * 两个老问题：枪管插进墙里，以及世界降分辨率时枪跟着一起糊。单独渲染意味着
   * 武器永远按**全分辨率 + MSAA**画，并且天然不会穿墙。
   */
  private readonly viewScene: Scene
  private readonly viewCamera: PerspectiveCamera
  /** HDR 后处理管线：世界 RT → 泛光 → 合成 → FXAA。 */
  private readonly post: PostFX
  /** 启动时探测到的 GPU；只用于自动画质与诊断，不参与渲染。 */
  private readonly gpu: GpuInfo
  /** 当前画质档允许自动降到的分辨率下限。 */
  private minScale = 0.7
  private cssWidth = 1
  private cssHeight = 1
  private readonly levelGroup = new Group()
  private readonly avatars = new Map<number, RemoteAvatar>()
  /** 角色/怪物的接地阴影共用一张贴图和材质，避免每个角色一份。 */
  private readonly shadowTexture = createShadowTexture()
  private readonly shadowMaterial = createShadowMaterial(this.shadowTexture, 0.5)
  /** 骤雨：跟随相机的竖直线段，只在天候 key === 'storm' 时显示。 */
  private rain: LineSegments | null = null
  private rainPositions: Float32Array | null = null
  private readonly tracers: Tracer[] = []
  /** 第一人称武器（模型 + 全部程序化姿态动画），挂在 camera 上。 */
  private readonly viewmodel: Viewmodel
  /** 每帧复用的武器状态：见 updateCamera 的参数说明（避免每帧分配）。 */
  private readonly vmState: ViewmodelState = {
    ads: 0,
    recoil: 0,
    speed: 0,
    sprinting: false,
    airborne: false,
    reloadProgress: 0,
    reloading: false,
    time: 0,
    pitch: 0,
    // 武器身份的四个字段：viewmodel 内部按 weaponId 换整套模型（幂等），
    // switchProgress 是举枪进度（0..1），meleeProgress 只在刀上生效。
    weaponId: DEFAULT_WEAPON_ID,
    slot: 0,
    switchProgress: 1,
    meleeProgress: 0,
    scoped: false,
    viewScale: 1,
    wallBlock: 0,
  }
  /** 枪口光：一份在武器场景里照亮枪身，一份在世界里照亮周围墙面。 */
  private readonly muzzle: PointLight
  private readonly muzzleWorld: PointLight
  // 只要求有 dispose()：几何体、材质、贴图都要在这里统一释放，
  // 用联合类型会漏掉贴图（DataTexture 既不是 Material 也不是 BufferGeometry）。
  private readonly disposables: { dispose(): void }[] = []

  /** 共享的 4 级渐变图：所有卡通材质共用一张，省显存也保证分级一致。 */
  private readonly gradientMap: DataTexture
  /** 浏览器内烘焙的布料/皮革细节贴图（只给远端猎人用，整局共享）。 */
  private readonly hunterTextures: HunterTextures
  /** 远端猎人材质（共享；几何每个玩家一份）。 */
  private readonly hunterMaterials: HunterMaterials
  /** 非碰撞装饰（水、芦苇、栅栏、雾墙）。纯视觉，不参与任何判定。 */
  private readonly props: Props
  private readonly atmo: Atmosphere
  /** 从天空球烘出来的 IBL；PBR 材质靠它拿到方向性环境反射。 */
  private readonly environment: EnvironmentProbe
  /** 怪物渲染器。状态完全由服务端快照驱动，客户端不预测它们。 */
  private readonly monsters: MonsterRenderer
  /** 世界里的目标标记（线索光柱 / 血巢 / 撤离线），由 game.ts 喂目标状态。 */
  private readonly markers: ObjectiveMarkers
  /** 命中/死亡/枪口的一次性粒子。单个 InstancedMesh，稳态零开销。 */
  private readonly vfx: Vfx
  /**
   * 共享描边材质。宽度与沸腾倍率都是 outline.ts 的模块级 uniform，
   * 所以这里只需要一份，不需要维护"所有描边材质"的清单。
   */
  private readonly ink: ShaderMaterial
  private edgeMat: LineBasicMaterial | null = null
  /**
   * 写实档开关。
   *
   * 第三档（全面写实）默认开启：武器与猎人走 PBR + IBL，不再叠卡通排线
   * 和墨线。世界层（关卡/道具/怪物）在 M2 换材质之前仍走 toon，
   * 所以这个开关目前只作用于通过 `surfaceMaterial` 拿材质的对象。
   */
  private readonly realistic = true
  /** 基础视野角（度），设置面板可改。开镜收窄在它之上叠加。 */
  private baseFov = BASE_FOV
  /** 渲染分辨率缩放，见 setRenderScale。 */
  private renderScale = 1

  /** 后坐力累积量（0..1），每帧衰减。 */
  private recoil = 0
  /** 镜头运动强度 0..1（可访问性）；只作用于相机 punch，不影响枪模后坐。 */
  private motionScale = 1

  /**
   * 命中定格剩余时间（秒）。
   *
   * 命中那一瞬间把整帧的 dt 压到 12%，枪、抖动、怪物动画全部慢下来一瞬。
   * 这是"打中了"最直接的体感来源：只加数字飘字的话，玩家看到的是 UI 在动，
   * 而不是自己打中了东西。它只作用于视觉层，不碰网络与预测步进。
   */
  private freeze = 0

  /**
   * 开火造成的**视角**后坐力（弧度）。
   *
   * 枪抬多少是 viewmodel 的事，视野抬多少是这里的事 —— 只有枪在抖、准星钉在
   * 原地的话，连射会读成"画面没动"，手感立刻发死。三个分量分开存：俯仰负责
   * 压枪、横摆靠时间函数做出左右乱飘、滚转只是一点点视觉噪点。
   */
  private punchPitch = 0
  private punchYaw = 0
  private punchRoll = 0
  /** 枪口闪光剩余时间。 */
  private flash = 0
  /** 当前 ADS 混合系数（0 腰射，1 完全瞄准），用于插值 FOV 与枪位。 */
  private adsBlend = 0
  /** 上一帧 updateCamera 收到的倍率。到 SCOPE_MIN_ZOOM 才在开镜时收起枪身（见 ViewmodelState.scoped）。 */
  private adsZoom = 1
  private time = 0
  /** 关卡本来的雾色与密度，见构造函数里 appliedFog 的注释。 */
  private fogBase = { color: 0, density: 0 }
  /** 沸腾计时器与当前倍数。 */
  private boilTimer = 0
  private boilScale = 1

  constructor(container: HTMLElement, level: LevelDef) {
    this.gradientMap = makeGradientMap()
    this.disposables.push(this.gradientMap)

    this.ink = createOutlineMaterial({ pixels: INK_PIXELS })
    this.disposables.push(this.ink)
    this.disposables.push(this.shadowTexture, this.shadowMaterial)

    // 角色材质：浏览器内烘焙一次的布料/皮革灰度细节 + 卡通/墨线着色器。
    // 材质整局共享，只有几何是每个远端玩家一份。
    this.hunterTextures = createHunterTextures()
    this.hunterMaterials = createHunterMaterials(
      {
        toon: (color, options) =>
          this.surfaceMaterial(color, {
            hatch: options?.hatch,
            hatchSpacing: options?.hatchSpacing,
            surface: options?.surface,
            specular: options?.specular,
            rim: options?.rim,
            map: options?.map,
          }),
        // 写实档不给角色加墨线壳：这里留一条细轮廓会把 PBR 材质重新压回
        // 卡通剪影，而轮廓识别在 M3 会用"仅敌人"的 1.2–1.4px 描边补回来。
        addInk: (mesh, pixels) => {
          if (!this.realistic) this.addInk(mesh, pixels)
        },
      },
      this.hunterTextures,
    )

    // antialias: false 是刻意的。
    //
    // 这个画面**本来就有描边壳**：每个物体的轮廓都由 outline.ts 的 BackSide
    // 黑壳勾出来，几何边缘不缺抗锯齿。而 MSAA 4x 在弱 GPU 上是四倍的带宽开销
    // —— 实测这台机器（Intel HD P4600）帧时间从 5.5ms 涨到 21ms。
    // 卡通的平涂色块里也没有细密的高频纹理需要抗锯齿。
    this.gl = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
    // 限制 DPR：4K 屏上 DPR=2 会让像素数翻四倍，而卡通色块没有能受益的细节。
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.gl.setSize(container.clientWidth, container.clientHeight)
    this.cssWidth = Math.max(1, container.clientWidth)
    this.cssHeight = Math.max(1, container.clientHeight)
    // 实时阴影：主光在 atmosphere.ts 里配置，这里只负责打开开关。
    // PCF + normalBias 是平面卡通几何唯一不炸边的组合（见 atmosphere）。
    this.gl.shadowMap.enabled = true
    // three r186 已移除 PCFSoftShadowMap；PCFShadowMap + light.shadow.radius
    // 是现在等价的那一档，继续传旧值只会每帧打一条回落警告。
    this.gl.shadowMap.type = PCFShadowMap
    // 每帧手动 reset：后处理最后一步是一次全屏 pass，如果让 three 自动 reset，
    // 调试 HUD 会永远显示"1 个 draw call / 1 个三角形"，把真实开销藏掉。
    this.gl.info.autoReset = false
    // 场景照常画在**线性 HDR**里，色调映射/AgX 全部交给 postfx 的合成 pass。
    // 在材质阶段做 tonemap 会先压掉色阶，再进 HDR 缓冲时只剩一小段动态范围。
    this.gl.toneMapping = NoToneMapping
    container.appendChild(this.gl.domElement)

    // 探测 GPU。注意：网页**不能**选择显卡，powerPreference 只是提示；
    // 这里认出来的结果只用来选画质档，以及把真实卡名挂到调试探针上。
    this.gpu = probeGpu(this.gl)
    console.info(
      `[dead-kill] GPU: ${this.gpu.renderer || 'unknown'}${this.gpu.integrated ? ' (核显)' : ''}${this.gpu.software ? ' (软件渲染)' : ''}`,
    )

    // 后处理在知道尺寸后立刻建，避免第一帧用 0×0 的 RT。
    // 初始 4x 只是占位；Game 会在第一帧前按 GPU/设置调用 setQuality。
    this.post = new PostFX(this.gl, { samples: 4 })
    this.post.setSize(this.cssWidth, this.cssHeight, Math.min(window.devicePixelRatio, 2), this.renderScale)

    this.scene = new Scene()
    // 背景色只在天空球没盖住的角落露出来（例如 SwiftShader 下球被裁掉），
    // 给一个接近夜色而不是关卡雾色的值，免得漏出一圈"未画完的灰"。
    this.scene.background = new Color(0x05080d)
    // 雾保留但只用它分层次，不承担"遮丑"。
    this.scene.fog = new FogExp2(level.fogColor, level.fogDensity)
    // 关卡给的雾是基线。每局的"天气修正"（死寂/浓雾/骤雨/虫潮）在这条基线上
    // 乘系数，所以要先把原值记下来，否则切两次就再也回不到关卡本来的样子。
    this.fogBase = { color: level.fogColor, density: level.fogDensity }

    this.camera = new PerspectiveCamera(BASE_FOV, container.clientWidth / container.clientHeight, 0.05, 400)
    this.scene.add(this.camera)
    this.buildRain()

    // 武器场景：相机固定在原点、朝 -Z，武器坐标本身就是相机局部坐标。
    // 三盏固定的"棚拍灯"比让武器吃世界月光可靠得多：夜里整把枪会掉成
    // 一团纯黑剪影，而玩家需要随时读出枪管/护木/机匣的分界。
    this.viewScene = new Scene()
    // 近平面 0.26：开镜时枪托/托底退到镜头后面被自然裁掉，同时不裁掉
    // 扳机护圈/杠杆（它们在 0.30m 附近，0.3 会把它们切出缺口）。
    this.viewCamera = new PerspectiveCamera(BASE_FOV, container.clientWidth / container.clientHeight, 0.26, 12)
    this.viewScene.add(this.viewCamera)
    // 枪身底色改成深发蓝钢/深胡桃木后，照度要相应抬高，否则夜里整把枪
    // 退成一块黑剪影。总照度约 3.8，金属仍有足够的暗部，不会冲成塑料白。
    this.viewScene.add(new AmbientLight(0x9fb4cc, 0.42))
    const vmKey = new DirectionalLight(0xfff1da, 2.2)
    vmKey.position.set(-0.7, 1.3, 0.9)
    this.viewScene.add(vmKey)
    const vmFill = new DirectionalLight(0x8fb2e0, 0.7)
    vmFill.position.set(1.0, -0.3, 0.5)
    this.viewScene.add(vmFill)
    const vmRim = new DirectionalLight(0xcfe2ff, 0.85)
    vmRim.position.set(0.7, 0.5, -1.6)
    this.viewScene.add(vmRim)
    // 正面补光：枪的可见面朝 +Z（镜头方向），主光从左后方来，右/正面只剩
    // 环境光时整把枪会掉黑。一盏低强度正面光只抬可见面，不改变形体关系。
    const vmFront = new DirectionalLight(0xdfe8ff, 1.1)
    vmFront.position.set(0.1, 0.35, 1.4)
    this.viewScene.add(vmFront)

    // 天空与光照整块交给 atmosphere.ts：夜空球（月亮/星点/云带/地平线余烬）、
    // 月光 + 天空散射 + 跟随镜头的边缘光、贴地低雾、萤火虫、暗角后期。
    // 原来这里的 buildSky/buildLights 已删除 —— 旧灯组合计强度 ≈5.2，
    // 两套灯叠在地上就还是白天，夜晚永远是"调暗一点"而不是另一种照明。
    this.atmo = createAtmosphere(this.scene)
    this.atmo.setLevel(level.fogColor, level.fogDensity)
    // 天空烘成 IBL：必须在 setLevel 之后，否则烘到的是默认雾色而不是这一局
    // 的天光。武器场景单独给一份更高的 intensity —— 棚拍灯下金属需要环境
    // 反射才不像一块灰板，但世界层不能被环境光洗成灰白天。
    this.environment = createEnvironmentProbe(this.gl, this.atmo.sky)
    this.scene.environment = this.environment.environment
    this.scene.environmentIntensity = 0.35
    this.viewScene.environment = this.environment.environment
    this.viewScene.environmentIntensity = 1.0
    // 假高光的方向 = 月光方向。世界材质用它；武器场景在 render() 里会临时
    // 换成固定的"棚拍"方向（见 render 末尾），两套光照各自自洽。
    setInkKeyDirection(
      this.atmo.moonDirection.x,
      this.atmo.moonDirection.y,
      this.atmo.moonDirection.z,
    )
    // 巢穴处各点一盏火：这是玩家唯一能"远远看出血巢在哪"的暖色光源，
    // 与青色线索光柱分属两套色温，在黑白剪影里也不会认错。
    for (const nest of level.nests ?? []) {
      this.atmo.addFireLight({ x: nest.x, y: level.groundY + 0.9, z: nest.z })
    }

    this.scene.add(this.levelGroup)
    this.buildLevel(level)

    // 装饰与怪物都挂在 scene 上（不是 levelGroup）：它们各自管自己的
    // 生命周期，Renderer.dispose 里逐个释放，混进关卡组会和"重建关卡"纠缠。
    // 两者都要用同一张 gradientMap —— 各自再生成一份会让分级色阶出现细微
    // 差异，而卡通渲染里色阶不一致就是"这块石头看着不像这块石头"。
    // 核显/软件渲染时装饰密度减半：芦苇/断篱/枯树是纯视觉，不参与判定，
    // 砍掉一半能实打实减少 draw call，而关卡的可读性几乎不受影响。
    this.props = buildProps(this.scene, level, {
      density: this.gpu.integrated || this.gpu.software ? 0.4 : 1,
    })
    this.monsters = createMonsterRenderer(this.scene, {
      gradientMap: this.gradientMap,
      camera: this.camera,
      // 核显/软件渲染把渲染距离压到 45m：夜雾里本来也看不清，省下的
      // draw call 直接换成帧率。
      maxDistance: this.gpu.integrated || this.gpu.software ? 45 : 70,
    })
    // 装饰与怪物的阴影。只对不透明的卡通网格开：墨线外壳、水面、雾墙、
    // 血条都是 ShaderMaterial/BasicMaterial 或双面片，投进阴影只会得到
    // 一层噪点。草叶（DoubleSide）也跳过 —— 2048 的阴影图上它们比一个
    // texel 还细。
    this.enableCastingShadows(this.props.root)
    this.enableCastingShadows(this.monsters.root)

    // 目标标记与特效同样挂在 scene 上。两者都不预测、不判定，只把服务端
    // 已经定下来的状态画出来 —— 任何"我先看到光柱"的本地推断都会让两个
    // 玩家对同一件事看到不同画面。
    this.markers = createObjectiveMarkers(level)
    this.scene.add(this.markers.root)
    this.vfx = createVfx(this.scene)

    // 武器动画只吃一组标量（开镜混合/后坐力/速度/疾跑/离地/换弹进度/俯仰），
    // 与场景渲染无关，所以整块搬到 viewmodel.ts；这里只给它一个"借用材质与
    // 墨线壳"的通道，材质仍由 Renderer 统一登记释放。
    this.viewmodel = createViewmodel({
      // 武器有自己的棚拍灯（见构造函数上方），自发光只需要把最暗的一档从
      // 纯黑抬起来一点，保留"夜里也能读出机匣分界"的功能，不再承担主照明。
      toon: (color, options) => {
        return this.surfaceMaterial(
          color,
          {
            hatch: options?.hatch,
            hatchSpacing: options?.hatchSpacing,
            surface: options?.surface,
            specular: options?.specular,
            rim: options?.rim,
            emissive: options?.emissive ?? 0.3,
            map: options?.map,
          },
          true,
        )
      },
      // 第一人称武器是写实档里最不该被墨线勾边的一块：它离镜头 0.4m，
      // 墨线会变成一圈黑描边，正好和 PBR 的金属高光打架。
      addInk: (mesh, pixels) => {
        if (!this.realistic) this.addInk(mesh, pixels)
      },
      textures: {
        metal: this.hunterTextures.metal,
        wood: this.hunterTextures.wood,
        leather: this.hunterTextures.leather,
      },
    })
    this.viewCamera.add(this.viewmodel.root)
    this.muzzle = new PointLight(0xffd27a, 0, 9, 2)
    this.muzzle.position.set(0.18, -0.12, -0.55)
    this.viewCamera.add(this.muzzle)
    // 世界里的那一份枪口光：照亮玩家面前的墙/箱子/角色。武器场景里的那份
    // 只照枪本身，两者分开才能既看清枪、又有环境闪光。
    this.muzzleWorld = new PointLight(0xffd27a, 0, 12, 2)
    this.scene.add(this.muzzleWorld)
  }

  get canvas(): HTMLCanvasElement {
    return this.gl.domElement
  }

  /**
   * 设置面板改视野。
   *
   * 只改基础值、不直接写 camera.fov：camera.fov 每帧都由 updateCamera 按
   * "基础值 - 开镜收窄"重算，直接写会被下一帧覆盖掉，表现为"滑条一动就弹回去"。
   */
  setFov(degrees: number): void {
    this.baseFov = degrees
    this.camera.fov = degrees
    this.camera.updateProjectionMatrix()
    // 武器相机在 updateCamera 里靠"fov 有没有变"来决定是否重建投影；
    // 初始 FOV 在开局就写死，那一帧不会触发 diff，所以这里必须同步一次。
    this.viewCamera.fov = degrees
    this.viewCamera.updateProjectionMatrix()
  }

  /**
   * 画面亮度。只滤镜 WebGL 画布，不碰 HUD/镜筒。
   *
   * 用 CSS filter 而不是 toneMappingExposure：项目固定 NoToneMapping（卡通
   * 分级的硬要求），exposure 在 no-tone-mapping 下不参与片元，调了也不会变。
   */
  setBrightness(brightness: number): void {
    const value = Math.min(1.8, Math.max(0.8, brightness))
    // 亮度现在作用在 HDR 合成的曝光上，而不是 CSS filter：
    // 在高光已经进入 AgX 之后再加一层 brightness 只会把白压平；在线性光里
    // 乘曝光，亮部会沿肩部滚落，暗部也不会被一起洗灰。
    this.post.setSettings({ exposure: 1.22 * value })
  }

  /** 镜头晃动强度：1 完整 / 0.45 减弱 / 0 关闭。 */
  setMotionScale(scale: number): void {
    this.motionScale = Math.min(1, Math.max(0, scale))
  }

  /**
   * 渲染分辨率缩放（1 = 原生，0.7 = 七成像素）。
   *
   * 卡通渲染的像素开销几乎全在片元着色（4 级 toon + 排线 + 描边壳），
   * 而色块本来就是平的 —— 降分辨率损失的细节很少，换来的帧率却很实在。
   * 这是"弱 GPU 上唯一真正有效"的旋钮：draw call 只有 175 个、三角形
   * 一万五，几何侧没有任何优化空间。
   */
  setRenderScale(scale: number): void {
    this.renderScale = Math.min(Math.max(scale, 0.5), 1)
    // 画布始终按设备像素比原生分辨率；只缩小世界的 HDR target。
    // 旧实现是缩小画布再让 CSS 拉满屏 —— 浏览器的双线性拉伸会把整个画面
    // （包括 HUD 后面的所有像素）变糊，而且没有任何锐化机会。
    this.post.setSize(this.cssWidth, this.cssHeight, Math.min(window.devicePixelRatio, 2), this.renderScale)
  }

  getScale(): number {
    return this.renderScale
  }

  /** 启动画质探测结果（给调试探针/提示用）。 */
  gpuInfo(): GpuInfo {
    return this.gpu
  }

  /** 调试 HUD 用的短标签；不暴露完整驱动串，太长了。 */
  gpuLabel(): string {
    if (this.gpu.software) return '软件渲染'
    if (this.gpu.integrated) return '核显'
    if (this.gpu.discrete) return '独显'
    return '未知GPU'
  }

  /** 当前画质档允许自动降到的分辨率下限。 */
  getMinScale(): number {
    return this.minScale
  }

  /**
   * 切换画质档。
   *
   * 三档对应的开销：
   * - performance：无 MSAA、无泛光、无实时阴影、关程序化细节；给核显/软件渲染；
   * - balanced：2x MSAA、4 级泛光、1024 阴影、细节开；
   * - quality：4x MSAA、5 级泛光、2048 阴影、细节开。
   *
   * auto 会按探测结果选起始档；之后的升降档由 Game 按实测帧时间做。
   */
  setQuality(quality: GraphicsQuality): void {
    const resolved: Exclude<GraphicsQuality, 'auto'> =
      quality === 'auto'
        ? this.gpu.integrated || this.gpu.software
          ? 'performance'
          : 'balanced'
        : quality

    if (resolved === 'performance') {
      // 无 MSAA、无泛光、无 FXAA、无实时阴影、无程序化细节；世界 0.65 起、
      // 最低 0.5。描边/排线仍然在，所以画面不会变成"没做完的白模"。
      this.post.setQuality({ samples: 0, bloomLevels: 3, bloom: false, fxaa: false })
      this.atmo.setShadowQuality(0)
      setInkDetail(false)
      this.minScale = 0.5
    } else if (resolved === 'balanced') {
      this.post.setQuality({ samples: 2, bloomLevels: 4, bloom: true, fxaa: true })
      this.atmo.setShadowQuality(1024)
      setInkDetail(true)
      this.minScale = 0.65
    } else {
      this.post.setQuality({ samples: 4, bloomLevels: 5, bloom: true, fxaa: true })
      this.atmo.setShadowQuality(2048)
      setInkDetail(true)
      this.minScale = 0.75
    }
    // 接触阴影是写实档的固定项；performance 档是低端独显兜底，关掉省一次
    // 全屏 8 步射线。强度在 quality 档给足，balanced 收一点。
    this.post.setContactShadow(resolved !== 'performance', resolved === 'quality' ? 0.42 : 0.32)
  }

  setSize(width: number, height: number): void {
    this.cssWidth = Math.max(1, width)
    this.cssHeight = Math.max(1, height)
    this.gl.setSize(this.cssWidth, this.cssHeight)
    this.camera.aspect = this.cssWidth / this.cssHeight
    this.camera.updateProjectionMatrix()
    this.viewCamera.aspect = this.camera.aspect
    this.viewCamera.updateProjectionMatrix()
    this.post.setSize(this.cssWidth, this.cssHeight, Math.min(window.devicePixelRatio, 2), this.renderScale)
    // 墨线宽度是像素单位，屏幕一 resize 换算系数就得跟着换，否则窗口拉宽时
    // 线会横向变粗、纵向变细。这是所有用 outline.ts 的模块共用的那一份。
    setOutlineResolution(width, height)
  }

  // ------------------------------------------------------------ 墨线

  /**
   * 给一个网格挂上描边外壳。
   *
   * 用**子节点**而不是同位置的兄弟节点：这样父网格的位移/旋转/缩放
   * 自动继承，蹲下压扁身体时描边也跟着压扁，不会出现"身体扁了、墨线还是
   * 站着的高度"。
   *
   * 粗细差异改由 `pixels` 给一份独立材质表达（目前只有手持武器的粗描边需要），
   * 不再用 NDC 倍数去乘 —— 那份系数和像素宽度不是同一个量纲。
   */
  private addInk(mesh: Mesh, pixels = INK_PIXELS): void {
    let mat = this.ink
    if (pixels !== INK_PIXELS) {
      mat = createOutlineMaterial({ pixels })
      this.disposables.push(mat)
    }
    const hull = new Mesh(mesh.geometry, mat)
    // 外壳不参与射线：它纯粹是画面上的一圈墨，不该挡子弹也不该被拾取。
    hull.raycast = () => {}
    // 墨线壳是沿法线外扩的背面，投进阴影会把每个物体放大一圈。
    hull.castShadow = false
    hull.receiveShadow = false
    mesh.add(hull)
  }

  /**
   * 给一棵已经建好的子树打开阴影，只挑"实心、不透明、单面"的卡通网格。
   *
   * 装饰层（props）与怪物层（monsters）都在自己的模块里建网格，渲染器不应该
   * 逐类去认它们；这个遍历就是两边唯一需要的契约：材质类型决定它配不配投影。
   */
  private enableCastingShadows(root: Object3D): void {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return
      const material = object.material
      // 写实档会把 props/怪物的材质逐批换成 StandardMaterial；继续只认
      // MeshToonMaterial 会让它们静默失去投影（编译通过、画面上只是没影子）。
      if (!(material instanceof MeshToonMaterial) && !(material instanceof MeshStandardMaterial)) return
      if (material.transparent) return
      // 双面片：草叶、芦苇、旗布。它们在 2048 的阴影图上比一个 texel 还细，
      // 投出来只有噪点，还会让阴影相机多画几千个实例。
      if (material.side === DoubleSide) return
      object.castShadow = true
      object.receiveShadow = true
    })
  }

  /**
   * 卡通材质工厂：固有色 + 共享渐变图 + 漫画排线。
   *
   * 排线是**屏幕空间**画的，所以近处物体上的线更粗、远处自动变密 ——
   * 这正好是手绘漫画的观感（画家不会因为物体远就换更细的笔）。
   * 手持武器单独降强度：它离镜头只有 0.4m，满强度排线会把枪变成
   * 一团条纹噪声，读不出"这是把温菲尔德"。
   */
  private toonMaterial(
    color: number,
    opts: {
      fog?: boolean
      hatch?: number
      hatchSpacing?: number
      tint?: number
      tintAmount?: number
      /** 世界空间程序化材质细节的家族（砖/木纹/拉丝/泥/叶）。 */
      surface?: ComicSurface
      /** 假高光强度；金属倒角靠它读出来。 */
      specular?: number
      specColor?: number
      /** 剪影轮廓光；夜里逆光时把枪管和角色边缘勾出来。 */
      rim?: number
      /** 自发光比例（相对固有色）；只给武器用，见构造函数。 */
      emissive?: number
      /** 浏览器内烘焙好的细节贴图（角色布料/皮革）；世界材质不用。 */
      map?: Texture
    } = {},
  ): MeshToonMaterial {
    const mat = new MeshToonMaterial({
      color,
      gradientMap: this.gradientMap,
      fog: opts.fog ?? true,
    })
    // three 对 `map: undefined` 会打警告；只在真有烘焙贴图时赋值。
    if (opts.map !== undefined) mat.map = opts.map
    if (opts.emissive !== undefined && opts.emissive > 0) {
      mat.emissive = new Color(color).multiplyScalar(opts.emissive)
    }
    // 线距 36px（spacing 18）：关卡盒子在屏幕上动辄两百像素宽，线一密就糊成
    // 编织袋。阈值 0.42 按感知亮度算，只有真正的暗面才排线 —— 受光面留白，
    // 这才是《无主之地》那种"大面积平涂 + 暗部几笔"的结构。
    applyComicInk(mat, {
      hatchSpacing: opts.hatchSpacing ?? 18,
      hatchStrength: opts.hatch ?? 0.55,
      hatchThreshold: 0.42,
      grime: 0.05,
      tint: opts.tint,
      tintAmount: opts.tintAmount,
      surface: opts.surface,
      specular: opts.specular,
      specColor: opts.specColor,
      rim: opts.rim,
    })
    this.disposables.push(mat)
    return mat
  }

  /**
   * 武器/猎人材质调度：写实档走 PBR，回退档仍走 toon。
   *
   * `view` 只影响雾：第一人称武器在独立场景里，没有世界雾；猎人要参与世界雾。
   */
  private surfaceMaterial(
    color: number,
    opts: {
      fog?: boolean
      hatch?: number
      hatchSpacing?: number
      surface?: ComicSurface
      specular?: number
      specColor?: number
      rim?: number
      emissive?: number
      map?: Texture
    } = {},
    view = false,
  ): Material {
    if (!this.realistic) {
      return this.toonMaterial(color, {
        ...opts,
        fog: view ? false : opts.fog,
        // 武器场景里自发光只负责把最暗一档抬起来，沿用旧值。
        emissive: view ? opts.emissive ?? 0.3 : opts.emissive,
      })
    }
    return this.pbrMaterial(color, { ...opts, fog: view ? false : opts.fog ?? true })
  }

  /**
   * PBR 材质：把原来的"假高光强度"翻译成粗糙度/金属度。
   *
   * 写实档不再有 44 次幂 Blinn 假高光 —— 真实的方向性反射由 IBL 和
   * 月光/棚拍灯提供。`specular` 只是旧参数名，这里当作"表面有多亮"的意图：
   * 金属按 1.0 金属度、粗糙度 0.12–0.55；非金属保持 0 金属度、0.35–0.8。
   *
   * 贴图目前只有启动时烘的灰度细节图（布/皮革/金属/木）。它作为 albedo
   * 乘性细节使用；法线/ORM 贴图要等 M2 的 512² 五族资产。
   */
  private pbrMaterial(
    color: number,
    opts: {
      fog?: boolean
      surface?: ComicSurface
      specular?: number
      emissive?: number
      map?: Texture
    } = {},
  ): MeshStandardMaterial {
    const metal = opts.surface === 'metal'
    const specular = opts.specular ?? (metal ? 0.4 : 0.05)
    const roughness = metal
      ? Math.min(0.55, Math.max(0.12, 0.55 - specular * 0.45))
      : Math.min(0.82, Math.max(0.35, 0.76 - specular * 0.5))
    const mat = new MeshStandardMaterial({
      color,
      metalness: metal ? 1 : 0,
      roughness,
      // 夜景 IBL 很暗，给一点加成；否则金属只剩棚拍灯的一点点直接高光，
      // 仍然读成灰板。环境本身来自天空球，不会把暗部洗白。
      envMapIntensity: metal ? 1.6 : 0.9,
      fog: opts.fog ?? true,
    })
    if (opts.map !== undefined) mat.map = opts.map
    if (opts.emissive !== undefined && opts.emissive > 0) {
      mat.emissive = new Color(color).multiplyScalar(opts.emissive)
    }
    this.disposables.push(mat)
    return mat
  }

  // ------------------------------------------------------------ 关卡

  private buildLevel(level: LevelDef): void {

    const groundGeo = new BoxGeometry(level.boundsHalf * 2, 1, level.boundsHalf * 2)
    // 地面**完全不给排线**（hatch: 0）。
    //
    // 排线在漫画里是用来交代"这块形体转进暗面了"的，它必须依附于一个面的大小。
    // 地面是 80×80 米的无限平面，任何间距规律地铺上去都会读成地板革/菱格纹，
    // 而不是阴影 —— 远看尤其假。地面的暗靠色阶本身（4 级 toon 的最低一级）就够了。
    const palette = GROUND_PALETTE[level.groundMaterial ?? 'mud'] ?? GROUND_PALETTE.mud!
    const groundMat = this.toonMaterial(palette.color, {
      hatch: 0,
      tint: palette.tint,
      tintAmount: palette.tintAmount,
      surface: palette.surface,
      specular: palette.specular,
    })
    const ground = new Mesh(groundGeo, groundMat)
    ground.position.set(0, level.groundY - 0.5 - 0.01, 0)
    // 地面只接收阴影，不投：它本身是最大的一块遮挡体，投进阴影图只会
    // 把整张 shadow map 的深度占满，还挡住所有真正该投射的物体。
    ground.receiveShadow = true
    ground.castShadow = false
    this.levelGroup.add(ground)
    this.disposables.push(groundGeo)

    // 关卡盒子按材质合批（把世界变换烘进顶点）。
    //
    // 为什么必须合：新地图有 944 个盒子，原来每个盒子 = 实体 Mesh + 墨线外壳
    // 子 Mesh + 棱线 LineSegments，一次就是 3 个 draw call。实测 2111 次绘制、
    // 25.6ms/帧、直接掉到 31fps —— 全部时间花在提交状态上，三角形才 39k。
    // 合批后每种材质只剩 3 个对象，代价是丢掉逐盒的视锥剔除（整张图 11k 三角
    // 全画），换来两个数量级的 draw call 下降，这笔账在任何 GPU 上都划算。
    const buckets = new Map<string, BufferGeometry[]>()
    for (const brush of level.boxes) {
      const matKey = brush.material ?? 'wood'
      let list = buckets.get(matKey)
      if (!list) {
        list = []
        buckets.set(matKey, list)
      }
      // 树冠走棱球（见文件上方 canopyGeometry 的注释），其余仍是盒子。
      if (isCanopy(brush)) {
        list.push(canopyGeometry(brush))
        continue
      }
      const geo = new BoxGeometry(brush.hx * 2, brush.hy * 2, brush.hz * 2)
      if (brush.rotY) geo.rotateY(brush.rotY)
      geo.translate(brush.x, brush.y, brush.z)
      list.push(geo)
    }

    for (const [matKey, list] of buckets) {
      // 合并前每个盒子都带全套 position/normal/uv，属性一致才能合并；
      // 一旦以后给某个盒子加了自定义属性，这里会返回 null，宁可跳过也别抛。
      const merged = mergeGeometries(list, false)
      for (const geo of list) geo.dispose()
      if (!merged) continue
      this.disposables.push(merged)

      const spec = MATERIALS[matKey] ?? MATERIALS.wood!
      const tint = MATERIAL_TINT[matKey] ?? MATERIAL_TINT.wood!
      const mesh = new Mesh(
        merged,
        this.toonMaterial(spec.color, {
          tint: tint.tint,
          tintAmount: tint.amount,
          surface: spec.surface,
          specular: spec.specular,
          rim: spec.rim,
        }),
      )
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.levelGroup.add(mesh)
      this.addInk(mesh)

      // 棱边再加一道细线：盒子内部没有曲面，只靠外轮廓时两个盒子贴在一起
      // 会糊成一大块。顺着棱走线能重新切出体块 —— 这是手绘分面的做法。
      // 合批后一次性算：盒子之间不共享顶点，EdgesGeometry 仍然给出每个盒子
      // 自己的棱，视觉与逐盒一致，只是变成一次绘制。
      const edgeGeo = new EdgesGeometry(merged)
      this.disposables.push(edgeGeo)
      this.levelGroup.add(new LineSegments(edgeGeo, this.edgeMaterial()))
    }
  }

  // ------------------------------------------------------------ 每帧

  /**
   * 更新相机与武器姿态。feet 是预测出的本地脚底位置，eyeHeight 由蹲下状态决定。
   *
   * 武器那几个标量（疾跑 / 离地 / 换弹）走独立参数而不是状态对象：
   * 每帧 new 一个对象是最容易被忽视的分配，而这条路径上的 GC 抖动
   * 会直接读成瞄准时的微顿。内部复用 vmState 字段。
   */
  updateCamera(
    feet: Vec3,
    eyeHeight: number,
    yaw: number,
    pitch: number,
    ads: boolean,
    dt: number,
    speed: number,
    sprinting: boolean,
    airborne: boolean,
    reloading: boolean,
    reloadProgress: number,
    weaponId: number,
    slot: number,
    switchProgress: number,
    meleeProgress: number,
    adsZoom: number,
    wallBlock: number,
  ): void {
    // 命中定格：先把这一帧的视觉时间压缩，再往下走。
    if (this.freeze > 0) {
      this.freeze = Math.max(0, this.freeze - dt)
      dt *= 0.12
    }

    const target = ads ? 1 : 0
    // ADS 过渡用指数逼近而不是线性：线性到位那一下会有"咔"的停顿感。
    this.adsBlend += (target - this.adsBlend) * Math.min(1, dt * 14)

    // 带镜的枪在常规 ADS 收束之上再除一次倍数；不带镜时 adsZoom = 1，
    // 公式退化成原来那条 baseFov - PULL * blend，观感一字不变。
    this.adsZoom = adsZoom
    // 带镜的枪才把 FOV 除以倍数；机械瞄具只做 ADS_FOV_PULL 的收束。
    // 低倍镜（1.3/1.7）如果也除倍数，1.7 会得到 32°，再叠镜圈就是黑屏。
    const zoom = adsZoom >= SCOPE_MIN_ZOOM ? 1 + (adsZoom - 1) * this.adsBlend : 1
    const fov = (this.baseFov - ADS_FOV_PULL * this.adsBlend) / zoom
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov
      this.camera.updateProjectionMatrix()
      // 武器相机必须跟世界相机同 FOV：否则开镜时世界在放大、枪却没变，
      // 枪会看起来在往后退。两边的投影必须逐帧一致。
      this.viewCamera.fov = fov
      this.viewCamera.updateProjectionMatrix()
    }

    this.time += dt
    // 夜空、月亮、边缘光、雾片与萤火虫全部按 time 推进；dt 只用于火光闪烁
    // 这类有状态的东西。放在相机摆位之前：边缘光每帧要跟着 camera 走。
    this.atmo.update(dt, this.camera, this.time)
    // 走动时的头部起伏：频率跟着速度走，静止时归零。
    const bobAmp = Math.min(speed / 6, 1) * 0.018
    const bob = Math.sin(this.time * 10.5) * bobAmp * (1 - this.adsBlend * 0.8)

    // 眼高直接取角色控制器的值（蹲下时更矮），不要再自己插一遍 ——
    // 两处插值不同步会让镜头和实际射线起点对不上，近距离会"打中了不算"。
    // 视角后坐力按同一份 dt 指数回落。收得比枪的快（枪 6/s、视角 11/s）：
    // 视野如果和枪一样慢地爬回来，玩家会以为自己一直在被往上推。
    const punchDecay = Math.min(1, dt * 11)
    this.punchPitch -= this.punchPitch * punchDecay
    this.punchYaw -= this.punchYaw * punchDecay
    this.punchRoll -= this.punchRoll * punchDecay

    this.camera.position.set(feet.x, feet.y + eyeHeight + bob, feet.z)
    this.camera.rotation.set(0, 0, 0)
    this.camera.rotateY(yaw + this.punchYaw)
    // 俯仰要夹住：punch 加到极限值上会翻过头，抬头打天花板时视角会自己回弹。
    const limit = Math.PI / 2 - 0.02
    this.camera.rotateX(Math.min(limit, Math.max(-limit, pitch + this.punchPitch)))
    // 挥刀的相机滚转来自 viewmodel（它才知道刀劈到第几段）。滞后一帧：
    // updateCamera 排在 viewmodel.update 之前，60fps 下 16ms 看不出来，
    // 而反过来先把相机转好再算武器会让开镜的共线约束差一帧。
    this.camera.rotateZ(this.punchRoll + this.viewmodel.cameraRoll)

    // 水面波纹与芦苇摆动只依赖时间。放在这里是因为 updateCamera 是每帧
    // 唯一保证被调用的入口，而它已经拿到了 dt。
    this.props.update(dt)
    this.updateRain(dt)

    // 后坐力在这里衰减、再以衰减后的值喂武器：武器模块只回答"给定后坐力，
    // 枪该抬多少"，不自己持有计时器 —— 同一份 dt 在两处累加，衰减速率迟早漂。
    this.recoil = Math.max(0, this.recoil - dt * 6)

    const vm = this.vmState
    vm.ads = this.adsBlend
    vm.recoil = this.recoil
    vm.motionScale = this.motionScale
    vm.speed = speed
    vm.sprinting = sprinting
    vm.airborne = airborne
    vm.reloading = reloading
    vm.reloadProgress = reloadProgress
    vm.time = this.time
    vm.pitch = pitch
    vm.yaw = yaw
    vm.weaponId = weaponId
    vm.slot = slot
    vm.switchProgress = switchProgress
    vm.meleeProgress = meleeProgress
    // 带镜的枪进镜筒时要收起枪身，否则模型正好压在分划上（见 viewmodel 的 scoped）。
    vm.scoped = this.adsZoom >= SCOPE_MIN_ZOOM
    // 镜筒放大的是世界，不是手里这把枪：枪位按同一倍数推远，屏幕上大小不变。
    vm.viewScale = zoom
    vm.wallBlock = Math.min(1, Math.max(0, wallBlock))
    this.viewmodel.update(vm, dt)

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt)
      // 灯离枪只有 0.5~1m，衰减是平方反比；240cd 会把整把枪洗成纯白。
      // 45cd 在枪口附近仍然明显过曝，但只持续 3 帧，正好是"闪一下"。
      this.muzzle.intensity = this.flash * 45
      // 世界那一盏：让贴脸的墙和对面的人真的被枪口闪一下。位置放在相机
      // 前方一点，避免光心落在玩家自己的碰撞体内部（衰减从 0 距离开始）。
      this.muzzleWorld.position.copy(this.camera.position)
      this.muzzleWorld.intensity = this.flash * 35
    } else {
      this.muzzle.intensity = 0
      this.muzzleWorld.intensity = 0
    }

    this.updateBoil(dt)
    this.vfx.update(dt)

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i]!
      tracer.life -= dt
      if (tracer.life <= 0) {
        this.scene.remove(tracer.line)
        tracer.line.geometry.dispose()
        tracer.material.dispose()
        this.tracers.splice(i, 1)
        continue
      }
      tracer.material.opacity = Math.max(0, tracer.life / TRACER_LIFE)
    }
  }

  /**
   * 目标标记的每帧同步。view 由 game.ts 拼（它才知道当前包和玩家位置），
   * 时间轴用渲染器自己的 this.time —— 标记的动画必须和描边沸腾同一只钟，
   * 否则暂停/掉帧后光柱的脉动会跟画面其余部分错开。
   */
  syncObjective(view: ObjectiveView, dt: number): void {
    this.markers.sync(view, dt, this.time)
  }

  /** 命中/枪口粒子入口。方向只能由调用方给：服务端事件只带位置。 */
  get effects(): Vfx {
    return this.vfx
  }

  /**
   * 线条沸腾：每 1/12 秒换一次描边宽度，模仿手绘动画每张略有差异。
   *
   * 只改 uWidth（纯视觉），**绝不改几何体**。碰撞体来自物理引擎，
   * 与这里的网格无关；但玩家看到的是网格，一旦视觉与判定错开半米，
   * 射击手感就会变成"打不中"。
   */
  private updateBoil(dt: number): void {
    this.boilTimer -= dt
    if (this.boilTimer > 0) return
    this.boilTimer = 1 / BOIL_HZ
    // 三档循环而不是随机：随机会让线宽在相邻两帧跳变过大，看着像电压不稳。
    const cycle = [1, 1.14, 0.88]
    const idx = Math.floor(this.time * BOIL_HZ) % cycle.length
    this.boilScale = cycle[idx] ?? 1
    // 一份模块级 uniform，全场所有墨线（关卡/武器/怪物/道具）同时换相位。
    setOutlineBoil(this.boilScale)
  }

  /**
   * 开火反馈：枪的后坐力 + 视角后坐力 + 枪口闪光。
   *
   * `kick` 由调用方按武器给（霰弹/神射手的推背肯定不是转轮手枪那个量级）。
   * 这里不查武器表：渲染层不该知道弹道数据，否则改数值要动两个仓库。
   */
  /**
   * 扣扳机的本地反馈。
   *
   * @param kick   后坐力幅度（0..1）
   * @param muzzle 是否点枪口火光。挥刀必须传 false —— 刀没有枪口，
   *   那点暖光在近距离缠斗里会让玩家以为自己开了一枪（而且它是整屏的
   *   点光源，黑暗里一眼就能看见，等于给对手报点）。
   */
  onLocalShot(kick = 1, muzzle = true): void {
    this.recoil = Math.min(1, this.recoil + 0.55 * kick)
    if (muzzle) {
      this.flash = 0.05
      // 枪口星芒由 viewmodel 画（它知道当前枪的枪口在哪），这里的闪光计时器
      // 只负责两盏枪口点光源。
      this.viewmodel.flash()
    }
    // 开镜时视野只有一半宽，同样的角度偏移在屏幕上大一倍 —— 压一档。
    const adsScale = 1 - this.adsBlend * 0.55
    this.punchPitch += 0.016 * kick * adsScale * this.motionScale
    // 横摆用时间函数而不是 Math.random：随机数会让同一把枪每次连射的
    // 落点分布都不一样，玩家练不出肌肉记忆；固定节奏至少是可预期的。
    this.punchYaw += Math.sin(this.time * 91.7) * 0.0055 * kick * adsScale * this.motionScale
    this.punchRoll += Math.sin(this.time * 63.1) * 0.008 * kick * adsScale * this.motionScale
  }

  /**
   * 命中/击杀的重量感：一记向上的相机拳 + 一小段视觉定格。
   *
   * 和 onLocalShot 分开：开火是"我推了枪"，命中是"枪推了对面"，两者同时发生
   * 时必须能各自叠加，否则贴脸打中人只会看到开火那一下。
   *
   * @param damage  实际扣血量（用来决定拳有多重，小口径连射不该震屏）
   * @param headshot 爆头额外加码
   * @param kill    这一下打死人/怪：定格更长，给玩家半拍确认时间
   */
  hitPunch(damage: number, headshot: boolean, kill: boolean): void {
    const weight = Math.min(1, Math.max(0.15, damage / 60)) * (headshot ? 1.35 : 1)
    this.freeze = Math.max(this.freeze, kill ? 0.075 : headshot ? 0.055 : 0.04)
    const adsScale = 1 - this.adsBlend * 0.55
    this.punchPitch += 0.011 * weight * adsScale * this.motionScale
    this.punchYaw += (Math.random() - 0.5) * 0.007 * weight * adsScale * this.motionScale
    this.punchRoll += 0.005 * weight * adsScale * this.motionScale
  }

  /** 曳光弹：从枪口到命中点（或射程尽头）的一条线。 */
  addTracer(origin: Vec3, dir: Vec3, distance: number, hit: boolean): void {
    const end = new Vector3(
      origin.x + dir.x * distance,
      origin.y + dir.y * distance,
      origin.z + dir.z * distance,
    )
    const geo = new BufferGeometry()
    geo.setAttribute(
      'position',
      new Float32BufferAttribute(
        [origin.x, origin.y, origin.z, end.x, end.y, end.z],
        3,
      ),
    )
    // 卡通画法里的弹道不是细光丝，而是一道**亮黄的粗笔触**。
    // 颜色乘到 1 以上：曳光弹要进泛光的阈值，才会在夜空里"发亮"而不只是
    // 一条黄线。LineBasicMaterial 的 Color 允许 >1，HDR 合成会把它滚回白色。
    const mat = new LineBasicMaterial({
      color: new Color(hit ? 0xffe066 : 0xffc94a).multiplyScalar(2.6),
      transparent: true,
      opacity: 1,
      depthWrite: false,
    })
    const line = new Line(geo, mat)
    this.scene.add(line)
    this.tracers.push({ line, material: mat, life: TRACER_LIFE })
  }

  // ------------------------------------------------------------ 远端角色

  /**
   * 更新所有远端角色。
   *
   * 传进来的是**已经插值好的**位置（由 game.ts 算），这一层只负责
   * 摆模型、转向、按血量改颜色。
   */
  syncAvatars(players: PlayerSnapshot[], myId: number, dt: number): void {
    const seen = new Set<number>()
    for (const player of players) {
      if (player.id === myId) continue
      if ((player.flags & StateFlags.Alive) === 0) {
        const dead = this.avatars.get(player.id)
        if (dead) dead.group.visible = false
        continue
      }
      seen.add(player.id)
      let avatar = this.avatars.get(player.id)
      if (!avatar) {
        avatar = this.createAvatar()
        this.avatars.set(player.id, avatar)
        this.scene.add(avatar.group)
      }
      avatar.group.visible = true
      avatar.group.position.set(player.x, player.y, player.z)

      // 朝向：移动时跟位移，静止时跟快照 yaw。最短弧插值避免转身闪一下。
      const dx = player.x - avatar.lastX
      const dz = player.z - avatar.lastZ
      const moved = Number.isFinite(dx) && Number.isFinite(dz) ? Math.hypot(dx, dz) : 0
      // 远端快照 20Hz，位置又是插值出来的；直接拿两点差分当速度会一跳一跳。
      // 指数平滑一次，腿摆才是连续的。
      const instant = dt > 0 ? Math.min(8, moved / dt) : 0
      avatar.speed += (instant - avatar.speed) * Math.min(1, dt * 10)
      avatar.lastX = player.x
      avatar.lastZ = player.z
      if (moved > 1e-4) {
        const targetYaw = Math.atan2(-dx, -dz)
        avatar.group.rotation.y = shortestArc(avatar.group.rotation.y, targetYaw, 0.35)
      } else {
        avatar.group.rotation.y = shortestArc(avatar.group.rotation.y, player.yaw, 0.35)
      }

      // 蹲下时整体压低：脚底仍在 y=0，头的高度跟着降，和 hitbox 一致。
      const crouching = (player.flags & StateFlags.Crouching) !== 0
      avatar.group.scale.y = crouching ? 0.72 : 1

      // 简单步行：腿绕髋关节前后摆，身体随相位轻微起伏。速度趋近 0 时幅度
      // 自然归零；不做骨骼，远端 5m 外看不出差别，但"在走"一眼就能读出来。
      const walking = avatar.speed > 0.25
      const amp = walking ? Math.min(0.55, avatar.speed * 0.11) : 0
      if (walking) avatar.phase += avatar.speed * dt * 2.2
      const swing = Math.sin(avatar.phase) * amp
      avatar.model.legL.rotation.x = swing
      avatar.model.legR.rotation.x = -swing
      avatar.model.body.position.y = 0.9 + (walking ? Math.abs(Math.sin(avatar.phase)) * 0.014 : 0)
    }
    for (const [id, avatar] of this.avatars) {
      if (!seen.has(id)) {
        this.scene.remove(avatar.group)
        avatar.model.dispose()
        this.avatars.delete(id)
      }
    }
  }

  private createAvatar(): RemoteAvatar {
    const group = new Group()
    const shadow = new Mesh(SHADOW_GEOMETRY, this.shadowMaterial)
    shadow.scale.set(1.15, 1, 1.7)
    shadow.position.y = 0.02
    group.add(shadow)

    // 程序化猎人：大衣/宽檐帽/靴子/背包/横抱的步枪。材质整局共享，
    // 这里只建几何；墨线壳用比关卡更粗的 3.4px，远处也能认出是人。
    const model = createHunterModel(this.hunterMaterials, {
      addInk: (mesh) => this.addInk(mesh, AVATAR_INK_PIXELS),
    })
    group.add(model.root)
    return { group, model, lastX: NaN, lastZ: NaN, speed: 0, phase: 0 }
  }

  /** 把服务端快照里的怪物交给渲染器。插值与动画都在 monsters.ts 内部做。 */
  syncMonsters(list: MonsterView[], dt: number): void {
    this.monsters.sync(list, dt)
  }

  render(): void {
    // 整帧的 draw call / 三角形从 0 开始累计（含阴影 pass 与后处理）。
    this.gl.info.reset()
    // 世界材质的假高光跟着月亮；武器场景整帧切换成固定的"棚拍"方向，
    // 于是无论玩家面朝哪边，枪身倒角上那条高光都在同一个位置 —— 这是
    // 金属读成金属、而不是读成一块灰板的关键。
    const moon = this.atmo.moonDirection
    setInkKeyDirection(moon.x, moon.y, moon.z)
    this.post.renderWorld(this.scene, this.camera)
    // 深度已经写完：把相机矩阵与朝月亮的方向交给接触阴影。放在武器层之前，
    // present 里就能直接用这一帧的深度，不需要额外 prepass。
    this.post.updateContactShadow(this.camera, moon)

    setInkKeyDirection(-0.35, 0.78, 0.52)
    this.post.renderView(this.viewScene, this.viewCamera)
    this.post.present()
  }

  /**
   * 渲染开销探针。
   *
   * 只靠 fps 判断性能是错的：fps 里混着服务端 tick、物理步进、DOM 写入和
   * 浏览器的合成开销，看不出钱花在哪。draw call 数与三角形数是唯一能直接
   * 定位"是几何太多还是着色太贵"的两个数。
   */
  stats(): { calls: number; triangles: number; lines: number; points: number; programs: number; geometries: number; textures: number } {
    const info = this.gl.info
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    }
  }

  /**
   * 视角探针：当前相机 FOV 与这一帧生效的倍镜倍数。
   *
   * 「右键真的放大了没有」这件事在图上看不出来 —— 只能读这两个数：装了镜的枪
   * 开镜后 fov 应约等于 (75-20)/zoom，腰射时回到 75。
   */
  /**
   * 相机后坐（弧度）。弹药判定要把它加进 aimYaw/aimPitch，否则"准星在敌人身上
   * 但弹道还停在上一枪的角度"。
   */
  aimPunch(): { yaw: number; pitch: number } {
    return { yaw: this.punchYaw, pitch: this.punchPitch }
  }

  aim(): { fov: number; zoom: number; ads: number } {
    return { fov: this.camera.fov, zoom: this.adsZoom, ads: this.adsBlend }
  }

  /**
   * 骤雨：480 根短线，围在相机 22m 半径内。线段而不是 Points，因为雨滴的
   * 速度感来自"拉长"，点只会读成一团噪点。
   */
  private buildRain(): void {
    const count = 480
    const positions = new Float32Array(count * 2 * 3)
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 44
      const z = (Math.random() - 0.5) * 44
      const y = Math.random() * 22
      const o = i * 6
      positions[o] = x
      positions[o + 1] = y
      positions[o + 2] = z
      positions[o + 3] = x
      positions[o + 4] = y - 0.38
      positions[o + 5] = z
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
    const mat = new LineBasicMaterial({
      color: 0xaebdcc,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    })
    const rain = new LineSegments(geo, mat)
    rain.frustumCulled = false
    rain.visible = false
    this.scene.add(rain)
    this.rain = rain
    this.rainPositions = positions
    this.disposables.push(geo, mat)
  }

  setRain(active: boolean): void {
    if (this.rain) this.rain.visible = active
  }

  /** 每帧把雨滴往下推、绕回顶部，并让整片雨跟着相机走。 */
  private updateRain(dt: number): void {
    const rain = this.rain
    const positions = this.rainPositions
    if (!rain || !positions || !rain.visible) return
    const fall = Math.min(dt, 0.1) * 13
    for (let i = 0; i < positions.length; i += 6) {
      positions[i + 1] -= fall
      positions[i + 4] -= fall
      if (positions[i + 1] < 0) {
        positions[i + 1] += 22
        positions[i + 4] = positions[i + 1] - 0.38
      }
    }
    rain.geometry.getAttribute('position').needsUpdate = true
    rain.position.x = this.camera.position.x
    rain.position.z = this.camera.position.z
  }

  /**
   * 本局的天气修正：雾的密度倍率与色调。
   *
   * 只改雾，不改光照 —— 浓雾局真正变的是"能看多远"，把太阳也调暗会变成
   * 另一个游戏。fogScale = 1 且 tint 与关卡基线相同时等于什么都不做。
   */
  setModifier(fogScale: number, fogTint: number): void {
    const fog = this.scene.fog
    if (fog instanceof FogExp2) {
      fog.density = this.fogBase.density * Math.max(0.1, fogScale)
      // 0 表示"这张图自己的雾色"：修正表里没有更合适的色调时不要硬塞一个。
      if (fogTint !== 0) fog.color.setHex(fogTint)
      else fog.color.setHex(this.fogBase.color)
      this.atmo.setLevel(fog.color.getHex(), fog.density)
      // 天光跟着雾色变了：重烘一次 IBL。capture 返回的是新纹理，两个场景
      // 都要重新指过去，否则环境反射还停在上一种天气。
      this.environment.capture()
      const env = this.environment.environment
      this.scene.environment = env
      this.viewScene.environment = env
    }
  }

  dispose(): void {
    this.monsters.dispose()
    this.markers.dispose()
    this.vfx.dispose()
    this.viewmodel.dispose()
    this.props.dispose()
    // 大气在 props 之后：它会把自己那盏复用的 FogExp2 还原，props 里若有
    // 依赖雾的材质先释放更安全。环境探针 clone 了天空，先于大气释放。
    this.environment.dispose()
    this.atmo.dispose()
    for (const avatar of this.avatars.values()) avatar.model.dispose()
    this.avatars.clear()
    this.hunterTextures.dispose()
    this.post.dispose()
    this.gl.dispose()
    for (const item of this.disposables) item.dispose()
    this.disposables.length = 0
    this.gl.domElement.remove()
  }

  /** 棱边线材质是全局共享的常量，不为每个盒子建一份。 */
  private edgeMaterial(): LineBasicMaterial {
    if (!this.edgeMat) {
      this.edgeMat = new LineBasicMaterial({ color: 0x14100c, transparent: true, opacity: 0.32 })
      this.disposables.push(this.edgeMat)
    }
    return this.edgeMat
  }
}

/** 朝目标角度转 step（弧度），按最短弧方向。 */
function shortestArc(current: number, target: number, step: number): number {
  let delta = target - current
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  if (Math.abs(delta) <= step) return target
  return current + Math.sign(delta) * step
}

export { DEFAULT_WEAPON_ID, WEAPONS }
