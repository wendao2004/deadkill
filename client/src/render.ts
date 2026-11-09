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
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  BufferAttribute,
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
  Vector2,
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
import { animateHunter, createHunterMaterials, createHunterModel, type HunterMaterials, type HunterModel } from './hunter.ts'
import { createHunterTextures, type HunterTextures } from './baked-textures.ts'
import { createSurfaceMaps, loadSurfaceTextures, type SurfaceFamily, type SurfaceMaps } from './pbr-textures.ts'
import { loadNatureAssets as loadNatureModels, scatterNature } from './nature-assets.ts'
import { decorateVillage, loadVillageAssets } from './village-assets.ts'
import { loadGeneratedAssets, type GeneratedAssets } from './generated-assets.ts'
import { decorateGenerated } from './forest-scene.ts'
import type { GraphicsQuality } from './settings.ts'
import { buildProps, type Props } from './props.ts'
import { createMonsterRenderer, type MonsterRenderer, type MonsterView } from './monsters.ts'
import { createObjectiveMarkers, type ObjectiveMarkers, type ObjectiveView } from './markers.ts'
import { createVfx, type ImpactKind, type Vfx } from './vfx.ts'
import { createAtmosphere, type Atmosphere } from './atmosphere.ts'
import { createEnvironmentProbe, type EnvironmentProbe } from './environment.ts'
import { SHADOW_GEOMETRY, createShadowMaterial, createShadowTexture } from './shadows.ts'
import { createViewmodel, type Viewmodel, type ViewmodelKit, type ViewmodelState } from './viewmodel.ts'
import { CAMERA_FEEL, Spring, angleDelta, approach, clamp, clamp01, hashNoise } from './feel.ts'

import {
  BODY_CACHE_TTL_MS,
  DEFAULT_WEAPON_ID,
  buildTerrainGrid,
  SCOPE_MIN_ZOOM,
  WEAPONS,
  StateFlags,
  VAULT_TIME,
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
const INK_PIXELS = 3.0

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
  /** 翻越动作的本地时钟（秒）：快照只给"正在翻越"，进度由客户端补。 */
  vaultTime: number
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

/**
 * 把 BoxGeometry 的 0..1 UV 改写成**米制盒投影** UV。
 *
 * 合批前的盒子仍在局部坐标（未旋转、未平移），所以直接按顶点位置和法线
 * 选投影轴：|n.x| 主导用 (z,y)，|n.y| 主导用 (x,z)，否则 (x,y)。
 * 每米 1/tile 个 UV 单位，贴图因此按真实尺度平铺，不会被盒子的长宽比拉伸。
 *
 * 必须在 rotateY/translate 之前调用：旋转后的世界位置会让相邻盒子的接缝
 * 对不上，而 UV 应该钉在各自的表面上。
 */
/** ComicSurface 里的 'default' 没有对应贴图，落回石族（中性、不偏色）。 */
function surfaceFamily(surface: ComicSurface | undefined): SurfaceFamily {
  return surface === undefined || surface === 'default' ? 'stone' : surface
}

/**
 * 给 PBR 材质加一条菲涅尔轮廓光。
 *
 * 写实档去掉了墨线壳，暗夜里低模/盒刷的剪影会和背景糊成一片；这条冷色
 * 边缘只是把"那里有个形体"重新点出来，强度压得很低，不会变回卡通描边。
 * 注入点在 `opaque_fragment` 之前：`normal` 已经过法线贴图扰动，
 * `vViewPosition` 是视图空间位置，都是 MeshStandard/Physical 现成的量。
 */
function applyPbrRim(material: MeshStandardMaterial, strength: number, detailFamily?: number): void {
  const uniforms = {
    color: { value: new Color(0x93a7c4) },
    strength: { value: Math.max(0, strength) },
    detail: { value: detailFamily ?? -1 },
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = uniforms.color
    shader.uniforms.uRimStrength = uniforms.strength
    shader.uniforms.uDetailFamily = uniforms.detail
    shader.fragmentShader =
      'uniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform int uDetailFamily;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      [
        '{',
        '  float rimFres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);',
        '  outgoingLight += uRimColor * rimFres * uRimStrength;',
        '}',
        '#include <opaque_fragment>',
      ].join('\n'),
    )

    if (detailFamily !== undefined && detailFamily >= 0) {
      shader.vertexShader =
        'varying vec3 vOwWorld;\nvarying vec3 vOwNormal;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvOwNormal = normalize(mat3(modelMatrix) * objectNormal);',
      )
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvOwWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )

      shader.fragmentShader =
        'varying vec3 vOwWorld;\nvarying vec3 vOwNormal;\n' +
        [
          'float owDetailHash(vec2 p) {',
          '  p = fract(p * vec2(123.34, 456.21));',
          '  p += dot(p, p + 45.32);',
          '  return fract(p.x * p.y);',
          '}',
          'float owDetailNoise(vec2 p) {',
          '  vec2 i = floor(p); vec2 f = fract(p);',
          '  f = f * f * (3.0 - 2.0 * f);',
          '  float a = owDetailHash(i);',
          '  float b = owDetailHash(i + vec2(1.0, 0.0));',
          '  float c = owDetailHash(i + vec2(0.0, 1.0));',
          '  float d = owDetailHash(i + vec2(1.0, 1.0));',
          '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
          '}',
          'float owDetailFbm(vec2 p) {',
          '  float v = 0.0; float a = 0.5;',
          '  for (int i = 0; i < 4; i++) { v += a * owDetailNoise(p); p *= 2.03; a *= 0.5; }',
          '  return v;',
          '}',
        ].join('\n') +
        shader.fragmentShader

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        [
          '#include <roughnessmap_fragment>',
          '{',
          '  vec3 owN = normalize(vOwNormal);',
          '  vec3 owW = abs(owN);',
          '  vec2 owUV;',
          '  if (owW.y > 0.7) owUV = vOwWorld.xz;',
          '  else if (owW.x > owW.z) owUV = vOwWorld.zy;',
          '  else owUV = vOwWorld.xy;',
          '  float owDetail = 1.0;',
          '  float owRough = 1.0;',
          '  if (uDetailFamily == 0) {',
          '    float p = fract(owUV.x / 0.32);',
          '    float seam = smoothstep(0.0, 0.03, p) * smoothstep(1.0, 0.97, p);',
          '    float grain = owDetailFbm(vec2(owUV.x * 4.0, owUV.y * 0.9));',
          '    owDetail = mix(0.80, 1.04, seam) * mix(0.90, 1.06, grain);',
          '    owRough = mix(1.06, 0.96, seam);',
          '  } else if (uDetailFamily == 1) {',
          '    float bh = 0.16; float bw = 0.36;',
          '    float row = floor(owUV.y / bh);',
          '    float off = mod(row, 2.0) * 0.5;',
          '    vec2 cell = vec2(owUV.x / bw + off, owUV.y / bh);',
          '    vec2 f = fract(cell);',
          '    float mortar = smoothstep(0.0, 0.045, f.x) * smoothstep(1.0, 0.955, f.x)',
          '                 * smoothstep(0.0, 0.08, f.y) * smoothstep(1.0, 0.92, f.y);',
          '    float block = owDetailHash(floor(cell));',
          '    owDetail = mix(0.66, 1.06, mortar) * mix(0.90, 1.08, block);',
          '    owRough = mix(1.08, 0.94, mortar);',
          '  } else if (uDetailFamily == 2) {',
          '    float streak = owDetailFbm(vec2(owUV.x * 0.9, owUV.y * 0.16));',
          '    float rust = smoothstep(0.58, 0.86, owDetailFbm(owUV * 0.55 + 11.0));',
          '    owDetail = mix(0.84, 1.05, streak);',
          '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.17, 0.08), rust * 0.35);',
          '    owRough = mix(0.92, 1.25, rust);',
          '  } else if (uDetailFamily == 3) {',
          '    owDetail = mix(0.88, 1.08, owDetailFbm(owUV * 1.3));',
          '  }',
          '  float owFade = 1.0 - smoothstep(16.0, 52.0, distance(vOwWorld, cameraPosition));',
          '  diffuseColor.rgb *= mix(1.0, owDetail, owFade * 0.6);',
          '  roughnessFactor = clamp(roughnessFactor * mix(1.0, owRough, owFade * 0.6), 0.04, 1.0);',
          '}',
        ].join('\n'),
      )
    }
  }
  // 不同 detail family 必须各编一份 program；强度走 uniform，不进 cache key。
  material.customProgramCacheKey = () => `pbr-rim-${detailFamily ?? -1}`
}

function applyBoxProjection(geo: BufferGeometry, tileMeters: number): void {
  const pos = geo.getAttribute('position')
  const nor = geo.getAttribute('normal')
  if (!pos || !nor) return
  let uv = geo.getAttribute('uv')
  if (!uv) {
    uv = new BufferAttribute(new Float32Array(pos.count * 2), 2)
    geo.setAttribute('uv', uv)
  }
  const inv = 1 / Math.max(0.05, tileMeters)
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i))
    const ny = Math.abs(nor.getY(i))
    const nz = Math.abs(nor.getZ(i))
    let u: number
    let v: number
    if (nx >= ny && nx >= nz) {
      u = pos.getZ(i)
      v = pos.getY(i)
    } else if (ny >= nz) {
      u = pos.getX(i)
      v = pos.getZ(i)
    } else {
      u = pos.getX(i)
      v = pos.getY(i)
    }
    uv.setXY(i, u * inv, v * inv)
  }
  uv.needsUpdate = true
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
  /** 门：每扇一个枢轴组，open 0..1 驱动旋转。 */
  private readonly doors: { pivot: Group; baseYaw: number; side: number; open: number; target: number }[] = []
  /** 最近一帧的 dt：render() 没有入参，门动画靠它推进。 */
  private frameDt = 1 / 60
  /** 捕兽夹：armed/sprung 两组网格按状态切换。 */
  private readonly traps: { armed: Group; sprung: Group; sprungOn: boolean }[] = []
  /** 油灯：点光源 + 发光灯罩。 */
  private readonly lamps: { light: PointLight; glow: Mesh; lit: boolean }[] = []
  /**
   * 玩家尸体。服务端的 bodyCaches 只发给"离得近的人一个 spotId"，客户端拿不到
   * 死亡坐标；但快照里有死亡瞬间的位置，所以这里在第一次看到 alive=0 时把
   * 远端猎人放倒留在原地，保留 BODY_CACHE_TTL_MS，与可搜刮的尸体缓存同寿。
   */
  private readonly corpses: { group: Group; model: HunterModel; age: number }[] = []
  /** 上一次快照里这个玩家是否活着；用来识别"刚死"这一帧。 */
  private readonly wasAlive = new Map<number, boolean>()
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
  /** 关卡五族程序化 PBR 贴图（albedo/normal/roughness），整局共享。 */
  private readonly surfaceMaps: Record<SurfaceFamily, SurfaceMaps>
  /** 远端猎人材质（共享；几何每个玩家一份）。 */
  private readonly hunterMaterials: HunterMaterials
  /** 非碰撞装饰（水、芦苇、栅栏、雾墙）。纯视觉，不参与任何判定。 */
  private readonly props: Props
  /** 关卡数据：自然资产散布要按树冠盒子定位。 */
  private readonly level: LevelDef
  /** 程序化树冠的独立网格：GLTF 树加载成功后隐藏它。 */
  private canopyMesh: Mesh | null = null
  /** GLTF 自然资产根节点（纯视觉）。 */
  private natureGroup: Group | null = null
  /** 程序化松树是否已经接管树木；决定 nature-assets 是否还要种一套枯树。 */
  private generatedTrees = false
  /** 模块化建筑视觉外壳（屋顶/门框/道具）。 */
  private villageGroup: Group | null = null
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
   * 画风开关：false = 手绘伪 3D（卡通色阶 + 墨线 + 排线），true = PBR 写实。
   *
   * 2026-11-08 决策：**默认手绘**。写实档把程序化几何的短板全暴露出来
   * （低模 + PBR 光照 = 一眼假），而手绘档的信息量来自轮廓、色阶与排线，
   * 恰好是程序化几何擅长的。写实分支保留，方便以后拿 authored 资产时 A/B。
   */
  private readonly realistic = false
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

  // ---- 相机手感（源码 player/camera.js 的移植）----
  /** 每一步落脚的垂直微冲量（5.4Hz 欠阻尼弹簧）。 */
  private readonly stepSpring = new Spring(CAMERA_FEEL.step.freq, CAMERA_FEEL.step.damping)
  /** 落地下沉（3.05Hz 欠阻尼弹簧）。 */
  private readonly landSpring = new Spring(CAMERA_FEEL.land.freq, CAMERA_FEEL.land.damping)
  private bobPhase = 0
  private bobWeight = 0
  private stepDistance = 0
  private prevFeetX = 0
  private prevFeetZ = 0
  private stepSampleReady = false
  private trauma = 0
  private strafeRoll = 0
  private turnRoll = 0
  private slideRoll = 0
  private prevYaw = 0
  private yawSampleReady = false
  private fovMove = 1
  private prevAirborne = false
  private prevVy = 0
  /** 枪口闪光剩余时间。 */
  private flash = 0
  /** 当前 ADS 混合系数（0 腰射，1 完全瞄准），用于插值 FOV 与枪位。 */
  private adsBlend = 0
  /** 上一帧 updateCamera 收到的倍率。到 SCOPE_MIN_ZOOM 才在开镜时收起枪身（见 ViewmodelState.scoped）。 */
  private adsZoom = 1
  /** 这一刀是不是重刀：由 game 在每次挥砍时设置。 */
  private meleeHeavy = false
  private time = 0
  /** 关卡本来的雾色与密度，见构造函数里 appliedFog 的注释。 */
  private fogBase = { color: 0, density: 0 }
  /** 沸腾计时器与当前倍数。 */
  private boilTimer = 0
  private boilScale = 1

  constructor(container: HTMLElement, level: LevelDef) {
    this.level = level
    this.gradientMap = makeGradientMap()
    this.disposables.push(this.gradientMap)
    this.surfaceMaps = createSurfaceMaps()

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
    this.post.setStyle(!this.realistic)
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
    this.viewScene.add(new AmbientLight(0x9fb4cc, 0.30))
    const vmKey = new DirectionalLight(0xffe9cf, 1.75)
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
    const vmFront = new DirectionalLight(0xdfe8ff, 0.80)
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
    this.scene.environmentIntensity = 0.95
    // PBR 与 toon 的响应完全不同：toon 的 4 级色阶会自己抬中间调，PBR 只会
    // 老老实实按入射光算。补一盏天空/地面半球光，把背光面从纯黑抬到可读，
    // 同时保留月光的方向性。0.3 是"能读出箱体侧面、又没把夜洗成阴天"的上限。
    this.scene.add(new HemisphereLight(0x3d5270, 0x181410, 0.3))
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
    this.buildDoors()
    this.buildTraps()
    this.buildLamps()

    // 装饰与怪物都挂在 scene 上（不是 levelGroup）：它们各自管自己的
    // 生命周期，Renderer.dispose 里逐个释放，混进关卡组会和"重建关卡"纠缠。
    // 两者都要用同一张 gradientMap —— 各自再生成一份会让分级色阶出现细微
    // 差异，而卡通渲染里色阶不一致就是"这块石头看着不像这块石头"。
    // 核显/软件渲染时装饰密度减半：芦苇/断篱/枯树是纯视觉，不参与判定，
    // 砍掉一半能实打实减少 draw call，而关卡的可读性几乎不受影响。
    this.props = buildProps(this.scene, level, {
      // 独显给 1.25：芦苇/枯树/地面碎屑都按这个倍率长，夜景里"空"是最伤的。
      density: this.gpu.integrated || this.gpu.software ? 0.45 : 1.25,
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
      // 唯一例外是准星/照门：几毫米宽的亮片只有靠一圈细线才能在暗墙前读出来。
      addInk: (mesh, pixels) => {
        if (!this.realistic) {
          this.addInk(mesh, pixels)
          return
        }
        const material = mesh.material as Material
        if (material?.userData?.isSight === true) this.addInk(mesh, 1.6)
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
    // 第三档（全面写实）不再把核显/软件渲染降级到 toon performance：
    // 自动档在独显上直接给 quality，其余给 balanced（几何/材质仍是写实档，
    // 只降 MSAA/阴影/泛光）。performance 保留为手动兜底，不再自动选中。
    const resolved: Exclude<GraphicsQuality, 'auto'> =
      quality === 'auto'
        ? this.gpu.integrated || this.gpu.software
          ? 'balanced'
          : 'quality'
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

  /**
   * 进局前加载 CC0 PBR 贴图（Poly Haven），替换启动时的程序化占位图。
   *
   * 失败不致命：占位图仍然能跑，只是墙面细节弱一档。所以这里 catch 掉，
   * 不能让一张 404 把整局挡在加载页。
   */
  async loadTextures(): Promise<void> {
    try {
      await loadSurfaceTextures(this.surfaceMaps, this.gl)
    } catch (error) {
      console.warn('[textures] PBR 贴图加载失败，继续使用程序化占位图', error)
    }
  }

  /**
   * 加载并散布 CC0 自然资产（枯树/草/岩石/枯枝/树桩）。
   *
   * 纯视觉，不生成碰撞体：树干/树冠的判定仍然来自 level.boxes。加载成功后
   * 隐藏程序化芦苇/枯树与树冠棱球；加载失败时保持程序化版本，场景不会空。
   */
  async loadNature(): Promise<void> {
    // 生成资产已经接管树木与地面植被；CC0 那套只在生成资产完全失败时兜底。
    // 两套同时开会叠成双层草，而且 CC0 的 PBR 材质和手绘色阶不是一个世界。
    if (this.generatedTrees) return
    try {
      const assets = await loadNatureModels()
      const density = this.gpu.integrated || this.gpu.software ? 0.45 : 1.25
      const group = new Group()
      group.name = 'nature-assets'
      // 松树已经由 generated-assets 接管时，这里只补草/石/灌木，不再种一套枯树。
      scatterNature(group, this.level, assets, density, !this.generatedTrees)
      this.scene.add(group)
      this.natureGroup = group
      // 只有关键资产都成功时才隐藏回退，避免"树加载失败但树冠也隐藏了"。
      if (assets.deadTree && assets.grass) {
        this.props.setNatureVisible(false)
        if (this.canopyMesh) this.canopyMesh.visible = false
      }
    } catch (error) {
      console.warn('[nature] 自然资产加载失败，保留程序化植被', error)
    }
  }

  /**
   * 加载并摆放 CC0 中世纪村庄模块化建筑外壳（屋顶/门框/阳台/烟囱/马车）。
   *
   * 只是视觉：碰撞仍然是 level.boxes 的平屋顶盒子。加载失败就保留原盒刷，
   * 不会因为一个 404 把整局挡在加载页。
   */
  async loadVillage(): Promise<void> {
    try {
      const { assets, materials } = await loadVillageAssets()
      const group = new Group()
      group.name = 'village-shells'
      decorateVillage(group, this.level, assets, materials)
      this.scene.add(group)
      this.villageGroup = group
    } catch (error) {
      console.warn('[village] 建筑外壳加载失败，保留盒刷外观', error)
    }
  }

  /**
   * 加载程序化 GLB 资产，并铺到松林营地。
   *
   * 和其它视觉壳一样是"锦上添花"：没有 heroes 锚点的地图、或者资产全部
   * 加载失败，都只是回到盒刷外观，不挡进局。
   */
  /**
   * 手绘档的 GLB 材质转换。
   *
   * 资产的配色本来就烘在顶点色里（生成器不写贴图），所以只需要把材质换成
   * 卡通材质并打开 vertexColors；材质家族按用途给，树的排线走 foliage、
   * 建筑走 wood、石头走 stone。返回一份共享墨线材质给实例外壳用。
   */
  private stylizeGenerated(assets: GeneratedAssets): Material {
    const outline = createOutlineMaterial({ pixels: 2.0 })
    this.disposables.push(outline)
    for (const asset of assets.values()) {
      // 作者导入的模型保留自己的材质：它们可能是带贴图的 authored 资产，
      // 强行换成顶点色卡通材质会直接变白/变黑。
      if (asset.tags.includes('imported')) continue
      const surface: ComicSurface =
        asset.tags.includes('tree') || asset.tags.includes('grass')
          ? 'foliage'
          : asset.tags.includes('building')
            ? 'wood'
            : 'stone'
      // 树没有墨线，靠一圈很轻的边缘光从夜色里分出来。
      const rim = asset.tags.includes('tree') ? 0.16 : 0
      const cache = new Map<Material, Material>()
      asset.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return
        const source = object.material as Material
        let toon = cache.get(source)
        if (!toon) {
          // 灯箱/火焰在原材质里是独立的发光材质；切成卡通材质时把自发光带上，
          // 否则路灯和水车在夜里会变成两块灰铁。
          const glow = source.name === 'glow' || source.name === 'ember'
          toon = this.surfaceMaterial(0xffffff, {
            hatch: 0.3,
            hatchSpacing: 10,
            surface,
            specular: 0.03,
            rim,
            emissive: glow ? 0.9 : 0,
          })
          ;(toon as Material & { vertexColors: boolean }).vertexColors = true
          toon.needsUpdate = true
          cache.set(source, toon)
        }
        object.material = toon
      })
    }
    return outline
  }

  async loadGenerated(): Promise<void> {
    try {
      // 地图作者导入的模型（heroes 里出现过、但生成清单没有的名字）
      const extra = [...new Set((this.level.heroes ?? []).map((h) => h.asset))]
      const assets = await loadGeneratedAssets(extra)
      // 手绘档：GLB 自带的是 PBR 材质，直接摆进卡通场景会像"贴错图"。
      // 这里统一换成卡通材质 + 顶点色，并给实例挂一份墨线外壳。
      const outline = this.realistic ? undefined : this.stylizeGenerated(assets)
      const ok = decorateGenerated(this.scene, this.level, assets, outline)
      if (ok) {
        // 树干盒子的外观已经被模型包住；树冠棱球必须关掉，否则会出现
        // "方块绿球 + 真松树"叠在一起。
        if (this.canopyMesh) this.canopyMesh.visible = false
        if (this.natureGroup) this.natureGroup.visible = false
        this.generatedTrees = true
      }
    } catch (error) {
      console.warn('[generated] 程序化资产加载失败，保留盒刷外观', error)
    }
  }

  /**
   * 可开关的门：每扇一个枢轴组，门板挂在枢轴侧边。
   *
   * 服务端只负责碰撞开关，客户端从目标包拿 doorsMask 再决定转到哪；
   * 0.18s 的指数逼近让门是"被推开"而不是瞬移。
   */
  private buildDoors(): void {
    const defs = this.level.doors ?? []
    if (defs.length === 0) return
    const material = this.surfaceMaterial(0x5a3a22, {
      hatch: 0.12,
      surface: 'wood',
      specular: 0.03,
      rim: 0.05,
    })
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!
      const pivot = new Group()
      pivot.position.set(def.x, this.level.groundY, def.z)
      const baseYaw = def.rotY ?? 0
      pivot.rotation.y = baseYaw
      const side = i % 2 === 0 ? 1 : -1
      const panel = new Mesh(new BoxGeometry(def.hx * 2, def.height, def.hz * 2), material)
      panel.position.set(side * def.hx, def.height / 2, 0)
      panel.castShadow = true
      panel.receiveShadow = true
      if (!this.realistic) this.addInk(panel)
      pivot.add(panel)
      this.levelGroup.add(pivot)
      this.doors.push({ pivot, baseYaw, side, open: 0, target: 0 })
    }
  }

  /** 捕兽夹：立齿 = 待触发，摊开 = 已弹开。 */
  private buildTraps(): void {
    const defs = this.level.traps ?? []
    if (defs.length === 0) return
    const material = this.surfaceMaterial(0x4a4d50, {
      hatch: 0.1,
      surface: 'metal',
      specular: 0.25,
      rim: 0.06,
    })
    for (const def of defs) {
      const root = new Group()
      root.position.set(def.x, this.level.groundY + 0.02, def.z)
      root.rotation.y = def.rotY ?? 0

      const base = new Mesh(new CylinderGeometry(0.5, 0.56, 0.08, 10), material)
      base.position.y = 0.04
      root.add(base)
      if (!this.realistic) this.addInk(base)

      const armed = new Group()
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2
        const tooth = new Mesh(new ConeGeometry(0.11, 0.36, 5), material)
        tooth.position.set(Math.cos(a) * 0.34, 0.24, Math.sin(a) * 0.34)
        tooth.rotation.set(Math.sin(a) * 0.55, 0, -Math.cos(a) * 0.55)
        armed.add(tooth)
        if (!this.realistic) this.addInk(tooth)
      }
      root.add(armed)

      const sprung = new Group()
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2
        const tooth = new Mesh(new ConeGeometry(0.11, 0.3, 5), material)
        tooth.position.set(Math.cos(a) * 0.55, 0.08, Math.sin(a) * 0.55)
        tooth.rotation.set(0, 0, Math.PI / 2)
        tooth.rotation.y = -a
        sprung.add(tooth)
      }
      sprung.visible = false
      root.add(sprung)

      this.levelGroup.add(root)
      this.traps.push({ armed, sprung, sprungOn: false })
    }
  }

  /** 油灯：铁杆 + 灯罩 + 点光源。打灭只切 visible，不销毁光源。 */
  private buildLamps(): void {
    const defs = this.level.lamps ?? []
    if (defs.length === 0) return
    const iron = this.surfaceMaterial(0x3a3d40, {
      hatch: 0.1,
      surface: 'metal',
      specular: 0.3,
      rim: 0.08,
    })
    const glowMat = new MeshBasicMaterial({
      color: 0xffc27a,
      transparent: true,
      opacity: 0.85,
      blending: AdditiveBlending,
      depthWrite: false,
    })
    this.disposables.push(glowMat)
    for (const def of defs) {
      const baseY = def.y ?? this.level.groundY
      const root = new Group()
      root.position.set(def.x, baseY, def.z)
      root.rotation.y = def.rotY ?? 0

      const post = new Mesh(new CylinderGeometry(0.06, 0.09, 2.4, 6), iron)
      post.position.y = 1.2
      post.castShadow = true
      root.add(post)
      const arm = new Mesh(new BoxGeometry(0.5, 0.06, 0.06), iron)
      arm.position.set(0.22, 2.36, 0)
      root.add(arm)
      const cage = new Mesh(new BoxGeometry(0.24, 0.32, 0.24), iron)
      cage.position.set(0.44, 2.2, 0)
      root.add(cage)
      if (!this.realistic) this.addInk(cage)

      const glow = new Mesh(new BoxGeometry(0.17, 0.24, 0.17), glowMat)
      glow.position.set(0.44, 2.2, 0)
      root.add(glow)

      const light = new PointLight(0xffb060, 1.35, 11, 2)
      light.position.set(0.44, 2.2, 0)
      root.add(light)

      this.levelGroup.add(root)
      this.lamps.push({ light, glow, lit: true })
    }
  }

  /** 亮着的灯位图：bit i = 第 i 盏还亮着。 */
  setLamps(mask: number): void {
    for (let i = 0; i < this.lamps.length; i++) {
      const lit = (mask & (1 << i)) !== 0
      const lamp = this.lamps[i]!
      if (lamp.lit === lit) continue
      lamp.lit = lit
      lamp.light.visible = lit
      lamp.glow.visible = lit
    }
  }

  /** 目标包里的捕兽夹状态位图。 */
  setTraps(mask: number): void {
    for (let i = 0; i < this.traps.length; i++) {
      const on = (mask & (1 << i)) !== 0
      const trap = this.traps[i]!
      if (trap.sprungOn === on) continue
      trap.sprungOn = on
      trap.armed.visible = !on
      trap.sprung.visible = on
    }
  }

  /** 目标包里的门状态位图。 */
  setDoors(mask: number): void {
    for (let i = 0; i < this.doors.length; i++) {
      this.doors[i]!.target = (mask & (1 << i)) !== 0 ? 1 : 0
    }
  }

  private updateDoors(dt: number): void {
    for (const door of this.doors) {
      door.open += (door.target - door.open) * Math.min(1, dt * 9)
      door.pivot.rotation.y = door.baseYaw + door.side * door.open * (Math.PI / 2)
    }
  }

  /**
   * 进局前预编译着色器。
   *
   * 不预编译时，第一帧看到新材质/第一枪打出新效果会在主线程同步编译
   * program，单帧能卡 100ms~3s。这里分两步：
   * 1. `compileAsync` 走 KHR_parallel_shader_compile 并行编译材质变体；
   * 2. 真实渲染一帧世界 + 武器并跑一次后处理 —— 深度/shadow 变体没有独立的
   *    编译 API，必须让 three 真的把它画一遍才会生成 program。
   *
   * 只渲染、不推进模拟，也不改相机/时钟；失败时降级为不预热，不能挡进局。
   */
  async prewarm(): Promise<void> {
    const r = this.gl
    const prevTarget = r.getRenderTarget()
    try {
      // 编译 variant 的 cache key 含 outputColorSpace/toneMapping，必须绑在
      // 和正式渲染相同的 HDR 目标上，否则会编出 canvas 版的错误变体。
      r.setRenderTarget(this.post.worldTarget)
      await r.compileAsync(this.scene, this.camera)
      r.setRenderTarget(this.post.viewTarget)
      await r.compileAsync(this.viewScene, this.viewCamera)

      // 第二遍：真正画一帧，覆盖 shadow/depth 与首帧才暴露的变体。
      r.setRenderTarget(this.post.worldTarget)
      r.render(this.scene, this.camera)
      r.setRenderTarget(this.post.viewTarget)
      r.render(this.viewScene, this.viewCamera)
      this.post.present()
    } catch (error) {
      console.warn('[prewarm] 预热失败，继续进局', error)
    } finally {
      r.setRenderTarget(prevTarget)
    }
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
    // 旧 toon 的固有色是按"平涂色块"选的，直接搬进 PBR 会在 AgX + 棚拍灯下
    // 变成高饱和塑料（木托尤其明显）。非金属向自身亮度靠 20% 并压暗一成，
    // 得到更接近胡桃木/旧皮革的低饱和底色。
    const base = new Color(color)
    if (!metal) {
      const lum = base.r * 0.2126 + base.g * 0.7152 + base.b * 0.0722
      base.lerp(new Color(lum, lum, lum), 0.2)
      base.multiplyScalar(0.9)
    }
    // 带自发光的枪件（准星/照门/刀口）是"涂了一层亮漆的金属"，不是裸金属：
    // 金属度 1 会把固有色反射掉，在暗夜棚拍灯下反而发灰，正好丢掉唯一的瞄准点。
    const painted = (opts.emissive ?? 0) >= 0.4
    const mat = new MeshStandardMaterial({
      color: base,
      metalness: metal && !painted ? 1 : 0,
      roughness: painted ? 0.5 : roughness,
      // 夜景 IBL 很暗，给一点加成；否则金属只剩棚拍灯的一点点直接高光，
      // 仍然读成灰板。环境本身来自天空球，不会把暗部洗白。
      envMapIntensity: painted ? 0.5 : metal ? 1.6 : 0.9,
      fog: opts.fog ?? true,
    })
    if (opts.map !== undefined) mat.map = opts.map
    if (opts.emissive !== undefined && opts.emissive > 0) {
      mat.emissive = new Color(color).multiplyScalar(opts.emissive)
    }
    applyPbrRim(mat, metal ? 0.3 : 0.16)
    this.disposables.push(mat)
    return mat
  }

  // ------------------------------------------------------------ 关卡

  /**
   * 关卡表面 PBR：固有色 × 程序化 albedo 细节，法线/粗糙度来自同一高度场。
   *
   * 与 `pbrMaterial` 的区别是这里必须带贴图与米制 UV；武器/猎人是程序化
   * 硬表面，暂时只吃固有色 + 环境反射。金属度按族给：只有 metal 族是真金属，
   * 其余保持 0，避免整面墙泛出塑料高光。
   */
  private pbrSurfaceMaterial(
    color: number,
    surface: ComicSurface | undefined,
    tint?: number,
    tintAmount = 0,
  ): MeshStandardMaterial {
    const family = surfaceFamily(surface)
    const maps = this.surfaceMaps[family]
    const base = new Color(color)
    if (tint !== undefined && tintAmount > 0) base.lerp(new Color(tint), tintAmount)
    // PBR 的固有色是线性反射率；toon 色块是按显示效果挑的，直接搬会偏亮。
    // authored 贴图自带固有色；材质色只做轻微染色，直接相乘会发黑。
    base.lerp(new Color(0xffffff), 0.55)
    const mat = new MeshStandardMaterial({
      color: base,
      map: maps.albedo,
      normalMap: maps.normal,
      roughnessMap: maps.roughness,
      // 粗糙度由贴图逐像素给，材质层保持 1（乘性）。
      roughness: 1,
      metalness: family === 'metal' ? 0.45 : 0,
      normalScale: new Vector2(0.55, 0.55),
      envMapIntensity: family === 'metal' ? 1.3 : 0.8,
      fog: true,
    })
    // 0 木 / 1 石 / 2 金属 / 3 泥 / 4 植被：程序化砖缝/木纹/锈迹在这里注入。
    const detailFamily =
      family === 'wood' ? 0 : family === 'stone' ? 1 : family === 'metal' ? 2 : family === 'mud' ? 3 : 4
    applyPbrRim(mat, family === 'metal' ? 0.22 : 0.12, detailFamily)
    this.disposables.push(mat)
    return mat
  }

  private buildLevel(level: LevelDef): void {

    // 地面：与物理共用同一份高度网格（shared/terrain.ts）。建筑/出生点/
    // 标记点/水边被压平，只有野地起伏。
    const terrain = buildTerrainGrid(level)
    const groundGeo = new BufferGeometry()
    groundGeo.setAttribute('position', new BufferAttribute(terrain.vertices, 3))
    groundGeo.setIndex(new BufferAttribute(terrain.indices, 1))
    groundGeo.computeVertexNormals()
    // 地面**完全不给排线**（hatch: 0）。
    //
    // 排线在漫画里是用来交代"这块形体转进暗面了"的，它必须依附于一个面的大小。
    // 地面是 260×260 米的起伏网格，任何间距规律地铺上去都会读成地板革/菱格纹，
    // 而不是阴影 —— 远看尤其假。地面的暗靠色阶本身（4 级 toon 的最低一级）就够了。
    const palette = GROUND_PALETTE[level.groundMaterial ?? 'mud'] ?? GROUND_PALETTE.mud!
    const groundFamily = surfaceFamily(palette.surface)
    const groundMat: Material = this.realistic
      ? this.pbrSurfaceMaterial(palette.color, palette.surface, palette.tint, palette.tintAmount)
      : this.toonMaterial(palette.color, {
          hatch: 0,
          tint: palette.tint,
          tintAmount: palette.tintAmount,
          surface: palette.surface,
          specular: palette.specular,
        })
    if (this.realistic) applyBoxProjection(groundGeo, this.surfaceMaps[groundFamily].tileMeters)
    const ground = new Mesh(groundGeo, groundMat)
    ground.position.set(0, 0, 0)
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
    // 树冠单独收集：GLTF 树加载成功后整块隐藏，避免"绿球 + 真树"重叠。
    const canopyGeos: BufferGeometry[] = []
    for (const brush of level.boxes) {
      // noRender：只给碰撞/判定用的隐形骨架（GLB 建筑的墙、立柱）。
      if (brush.noRender) continue
      const matKey = brush.material ?? 'wood'
      let list = buckets.get(matKey)
      if (!list) {
        list = []
        buckets.set(matKey, list)
      }
      const spec = MATERIALS[matKey] ?? MATERIALS.wood!
      const tile = this.surfaceMaps[surfaceFamily(spec.surface)].tileMeters
      // 树冠走棱球（见文件上方 canopyGeometry 的注释），其余仍是盒子。
      if (isCanopy(brush)) {
        const geo = canopyGeometry(brush)
        if (this.realistic) applyBoxProjection(geo, tile)
        canopyGeos.push(geo)
        continue
      }
      const geo = new BoxGeometry(brush.hx * 2, brush.hy * 2, brush.hz * 2)
      if (this.realistic) applyBoxProjection(geo, tile)
      if (brush.rotY) geo.rotateY(brush.rotY)
      geo.translate(brush.x, brush.y, brush.z)
      list.push(geo)
    }

    if (canopyGeos.length > 0) {
      const merged = mergeGeometries(canopyGeos, false)
      for (const geo of canopyGeos) geo.dispose()
      if (merged) {
        const spec = MATERIALS.foliage ?? MATERIALS.wood!
        const tint = MATERIAL_TINT.foliage ?? MATERIAL_TINT.wood!
        const material: Material = this.realistic
          ? this.pbrSurfaceMaterial(spec.color, spec.surface, tint.tint, tint.amount)
          : this.toonMaterial(spec.color, {
              tint: tint.tint,
              tintAmount: tint.amount,
              surface: spec.surface,
              specular: spec.specular,
              rim: spec.rim,
            })
        const mesh = new Mesh(merged, material)
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.levelGroup.add(mesh)
        this.canopyMesh = mesh
        this.disposables.push(merged)
      }
    }

    for (const [matKey, list] of buckets) {
      // 空桶必须跳过：树冠被单独收走之后，foliage 桶可能一个盒子都没有，
      // mergeGeometries([]) 会在 geometries[0].index 上直接抛。
      if (list.length === 0) continue
      // 合并前每个盒子都带全套 position/normal/uv，属性一致才能合并；
      // 一旦以后给某个盒子加了自定义属性，这里会返回 null，宁可跳过也别抛。
      const merged = mergeGeometries(list, false)
      for (const geo of list) geo.dispose()
      if (!merged) continue
      this.disposables.push(merged)

      const spec = MATERIALS[matKey] ?? MATERIALS.wood!
      const tint = MATERIAL_TINT[matKey] ?? MATERIAL_TINT.wood!
      const material: Material = this.realistic
        ? this.pbrSurfaceMaterial(spec.color, spec.surface, tint.tint, tint.amount)
        : this.toonMaterial(spec.color, {
            tint: tint.tint,
            tintAmount: tint.amount,
            surface: spec.surface,
            specular: spec.specular,
            rim: spec.rim,
          })
      const mesh = new Mesh(merged, material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.levelGroup.add(mesh)
      // 写实档不再有关卡墨线/棱线：PBR 法线与阴影接替了"分面"的工作，
      // 保留黑壳只会让像素级的砖缝、木纹被一圈 2.6px 黑线盖掉。
      if (!this.realistic) {
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
    /** 本地速度分量：侧移 roll 与落地冲击要用，不能只看速度大小。 */
    vx: number,
    vz: number,
    vy: number,
    sprinting: boolean,
    airborne: boolean,
    sliding: boolean,
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
    // tau 0.052 是源码的 ADS 时间常数 —— 比旧版（约 0.071s）更脆。
    this.adsBlend = approach(this.adsBlend, target, CAMERA_FEEL.fov.adsTau, dt)

    // 速度 FOV：冲刺/坠落时视野轻微拉开，静止时回 1。ADS 必须比它更硬，
    // 否则开镜途中冲刺会让准星在屏幕上"呼吸"。
    const moveTarget = sliding
      ? 1.085
      : sprinting
        ? CAMERA_FEEL.fov.sprint
        : airborne && vy < -6
          ? CAMERA_FEEL.fov.air
          : 1
    this.fovMove = approach(this.fovMove, moveTarget, CAMERA_FEEL.fov.moveTau, dt)

    // 带镜的枪在常规 ADS 收束之上再除一次倍数；不带镜时 adsZoom = 1，
    // 公式退化成原来那条 baseFov - PULL * blend，观感一字不变。
    this.adsZoom = adsZoom
    // 带镜的枪才把 FOV 除以倍数；机械瞄具只做 ADS_FOV_PULL 的收束。
    // 低倍镜（1.3/1.7）如果也除倍数，1.7 会得到 32°，再叠镜圈就是黑屏。
    const zoom = adsZoom >= SCOPE_MIN_ZOOM ? 1 + (adsZoom - 1) * this.adsBlend : 1
    const fov = (this.baseFov * this.fovMove - ADS_FOV_PULL * this.adsBlend) / zoom
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

    // ---- 步态相位：按"走了多少米"推进，而不是按时间 ----
    // 时间驱动的 bob 会在起停/跳跃后和脚步事件错开，走起来像在原地踩空气。
    if (!this.stepSampleReady) {
      this.prevFeetX = feet.x
      this.prevFeetZ = feet.z
      this.stepSampleReady = true
    }
    const moved = Math.hypot(feet.x - this.prevFeetX, feet.z - this.prevFeetZ)
    this.prevFeetX = feet.x
    this.prevFeetZ = feet.z
    const crouching = eyeHeight < 1.3
    const stride = (crouching ? 1.05 : 1.48) * (sprinting ? 1.28 : 1)
    if (!airborne) {
      this.stepDistance += moved
      // 一步 = π 相位：横向极值正好落在落脚那一帧。
      this.bobPhase += (moved / stride) * Math.PI
      if (this.bobPhase > Math.PI * 4) this.bobPhase -= Math.PI * 4
      if (this.stepDistance >= stride && speed > 0.55) {
        this.stepDistance -= stride
        const amp =
          CAMERA_FEEL.step.impulse *
          (sprinting ? CAMERA_FEEL.step.sprintScale : 1) *
          (crouching ? 0.55 : 1)
        this.stepSpring.impulse(-amp)
      }
    } else {
      this.stepDistance = stride * 0.55
    }

    // ---- 8 字 bob：速度越高越明显，但按 0.85 次幂压住冲刺的夸张感 ----
    let bobTarget = Math.min(
      CAMERA_FEEL.bob.speedCap,
      Math.pow(Math.max(0, speed) / 4.57, CAMERA_FEEL.bob.speedExp),
    )
    if (airborne) bobTarget = 0
    bobTarget *= 1 + (CAMERA_FEEL.bob.adsScale - 1) * this.adsBlend
    this.bobWeight = approach(this.bobWeight, bobTarget, CAMERA_FEEL.bob.airFade, dt)
    const theta = this.bobPhase + Math.PI * 0.5
    const bobX = Math.sin(theta) * CAMERA_FEEL.bob.ampX * this.bobWeight
    const bobY = Math.sin(theta * 2) * CAMERA_FEEL.bob.ampY * this.bobWeight
    const bobZ = Math.cos(theta * 2) * CAMERA_FEEL.bob.ampZ * this.bobWeight
    const bobRoll = -Math.sin(theta) * CAMERA_FEEL.bob.roll * this.bobWeight
    const bobPitch = Math.cos(theta * 2) * CAMERA_FEEL.bob.pitch * this.bobWeight

    // ---- 落地：冲击速度决定下沉、pitch/roll 与 trauma ----
    if (this.prevAirborne && !airborne) {
      const impact = Math.max(0, -Math.min(0, this.prevVy))
      const t = clamp01(
        (impact - CAMERA_FEEL.land.minSpeed) /
          (CAMERA_FEEL.land.fullSpeed - CAMERA_FEEL.land.minSpeed),
      )
      if (t > 0) {
        const mag = Math.pow(t, 0.72)
        this.landSpring.impulse(-CAMERA_FEEL.land.dipImpulse * mag)
        this.punchPitch += CAMERA_FEEL.land.pitch * mag
        this.punchRoll += CAMERA_FEEL.land.roll * mag
        this.trauma = clamp01(this.trauma + CAMERA_FEEL.land.trauma * mag * mag)
      }
    }
    this.prevAirborne = airborne
    this.prevVy = vy
    const stepOff = this.stepSpring.step(dt)
    const landOff = this.landSpring.step(dt)

    // ---- 横移 / 转向 roll：只在余光里感觉得到，但去掉就像镜头焊死 ----
    const rightX = Math.cos(yaw)
    const rightZ = -Math.sin(yaw)
    const lateral = vx * rightX + vz * rightZ
    const strafeTarget =
      clamp(
        -lateral / 4.57,
        -1,
        1,
      ) *
      CAMERA_FEEL.roll.strafe *
      (airborne ? 0.45 : 1) *
      (1 - 0.6 * this.adsBlend)
    this.strafeRoll = approach(this.strafeRoll, strafeTarget, CAMERA_FEEL.roll.tau, dt)

    if (!this.yawSampleReady) {
      this.prevYaw = yaw
      this.yawSampleReady = true
    }
    const yawRate = dt > 1e-6 ? angleDelta(this.prevYaw, yaw) / dt : 0
    this.prevYaw = yaw
    const turnTarget = clamp(
      yawRate * CAMERA_FEEL.roll.yawRate,
      -CAMERA_FEEL.roll.yawRateMax,
      CAMERA_FEEL.roll.yawRateMax,
    ) * (1 - 0.5 * this.adsBlend)
    this.turnRoll = approach(this.turnRoll, turnTarget, CAMERA_FEEL.roll.tau * 1.4, dt)
    const airRoll = airborne ? clamp(-vy * 0.02, -1, 1) * CAMERA_FEEL.roll.air : 0
    // 滑铲滚转：向左前方压枪的视觉倾斜，不改变射线。
    // 滑铲滚转：8° 是"身体贴地"的读法，再大就会让玩家以为镜头歪了。
    this.slideRoll = approach(this.slideRoll, sliding ? -8 * (Math.PI / 180) : 0, 0.08, dt)

    // ---- trauma：爆炸/重击/落地共用的噪声抖动 ----
    this.trauma = Math.max(0, this.trauma - CAMERA_FEEL.shake.decay * dt)
    const shakeAmount = this.trauma * this.trauma
    const shakeTime = this.time * CAMERA_FEEL.shake.freq
    let shakePitch = 0
    let shakeYaw = 0
    let shakeRoll = 0
    let shakeX = 0
    let shakeY = 0
    if (shakeAmount > 1e-4) {
      shakePitch = hashNoise(shakeTime, 11) * shakeAmount * CAMERA_FEEL.shake.rot
      shakeYaw = hashNoise(shakeTime + 31.7, 23) * shakeAmount * CAMERA_FEEL.shake.rot
      shakeRoll = hashNoise(shakeTime + 57.1, 37) * shakeAmount * CAMERA_FEEL.shake.rot * 0.7
      shakeX = hashNoise(shakeTime * 0.8 + 13.3, 41) * shakeAmount * CAMERA_FEEL.shake.pos
      shakeY = hashNoise(shakeTime * 0.8 + 71.9, 53) * shakeAmount * CAMERA_FEEL.shake.pos
    }

    // ---- 呼吸：静止时几乎看不见，开镜时被放大成"手在飘" ----
    const moveFactor = clamp01(speed / 2.2)
    const breathAmp =
      CAMERA_FEEL.breath.amp *
      (1 + (CAMERA_FEEL.breath.adsScale - 1) * this.adsBlend) *
      (1 - CAMERA_FEEL.breath.moveDamp * moveFactor)
    const breathA = Math.sin(this.time * Math.PI * 2 * CAMERA_FEEL.breath.freqA)
    const breathB = Math.sin(this.time * Math.PI * 2 * CAMERA_FEEL.breath.freqB + 1.7)
    const breathPitch = (breathA * 0.7 + breathB * 0.3) * breathAmp
    const breathYaw = (breathB * 0.75 - breathA * 0.25) * breathAmp * 1.15
    const breathPos =
      (breathA * 0.6 + breathB * 0.4) *
      CAMERA_FEEL.breath.posAmp *
      (1 - 0.8 * moveFactor)

    // ---- 视角后坐力：先按 11/s 回落，再叠加进相机 ----
    // 收得比枪快（枪 6/s）：视野如果和枪一样慢地爬回来，玩家会以为一直在被往上推。
    const punchDecay = Math.min(1, dt * 11)
    this.punchPitch -= this.punchPitch * punchDecay
    this.punchYaw -= this.punchYaw * punchDecay
    this.punchRoll -= this.punchRoll * punchDecay

    // 位置：bob 的 x/z 在水平面里，y 叠加落脚/落地/抖动/呼吸。
    const forwardX = -Math.sin(yaw)
    const forwardZ = -Math.cos(yaw)
    this.camera.position.set(
      feet.x + rightX * (bobX + shakeX) + forwardX * bobZ,
      feet.y + eyeHeight + bobY + stepOff + landOff + shakeY + breathPos,
      feet.z + rightZ * (bobX + shakeX) + forwardZ * bobZ,
    )
    this.camera.rotation.set(0, 0, 0)
    this.camera.rotateY(yaw + this.punchYaw + breathYaw + shakeYaw)
    // 俯仰要夹住：punch 加到极限值上会翻过头，抬头打天花板时视角会自己回弹。
    const limit = Math.PI / 2 - 0.02
    this.camera.rotateX(
      Math.min(limit, Math.max(-limit, pitch + this.punchPitch + bobPitch + breathPitch + shakePitch)),
    )
    // 挥刀的相机滚转来自 viewmodel（它才知道刀劈到第几段）。滞后一帧：
    // updateCamera 排在 viewmodel.update 之前，60fps 下 16ms 看不出来，
    // 而反过来先把相机转好再算武器会让开镜的共线约束差一帧。
    this.camera.rotateZ(
      this.punchRoll +
        this.viewmodel.cameraRoll +
        bobRoll +
        this.strafeRoll +
        this.turnRoll +
        this.slideRoll +
        airRoll +
        shakeRoll,
    )

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
    vm.sliding = sliding
    vm.airborne = airborne
    vm.reloading = reloading
    vm.reloadProgress = reloadProgress
    vm.time = this.time
    vm.stepPhase = this.bobPhase
    vm.pitch = pitch
    vm.yaw = yaw
    vm.weaponId = weaponId
    vm.slot = slot
    vm.switchProgress = switchProgress
    vm.meleeProgress = meleeProgress
    vm.meleeHeavy = this.meleeHeavy
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
  /** 刀杀/收刀花式，由 game 在近战击杀时调用。 */
  flourish(): void {
    this.viewmodel.flourish()
  }

  /** 下一次 meleeProgress 用重刀姿势。 */
  setMeleeHeavy(heavy: boolean): void {
    this.meleeHeavy = heavy
  }

  /** 按本局选择的配件显示镜筒/消音器外观。 */
  setWeaponAttachment(attachment: number): void {
    this.viewmodel.setAttachment(attachment)
  }

  onLocalShot(kick = 1, muzzle = true): void {
    this.recoil = Math.min(1, this.recoil + 0.55 * kick)
    // 枪模的推背独立于相机：两条弹簧各自过冲，合成后才是"枪撞肩 + 视野抬"。
    this.viewmodel.kick(kick, this.adsBlend)
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
    // 定格时长也吃伤害：重枪/爆头多停一两帧，轻武器连射不会被拖慢。
    this.freeze = Math.max(
      this.freeze,
      kill ? 0.082 : headshot ? 0.06 : 0.038 + Math.min(0.014, damage / 9000),
    )
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
    // 尸体与可搜刮缓存同寿（120s）；到点就直接移出场景，不做淡出 ——
    // 淡出需要每具尸体单独改材质透明度，而玩家真正关心的是"这 2 分钟里能搜"。
    const corpseTtl = BODY_CACHE_TTL_MS / 1000
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i]!
      corpse.age += dt
      if (corpse.age >= corpseTtl) {
        this.scene.remove(corpse.group)
        corpse.model.dispose()
        this.corpses.splice(i, 1)
      }
    }

    const seen = new Set<number>()
    const present = new Set<number>()
    for (const player of players) present.add(player.id)
    for (const player of players) {
      if (player.id === myId) continue
      if ((player.flags & StateFlags.Alive) === 0) {
        // 第一次看到这个玩家死亡：把他放倒在死亡位置。之后即使他复活，
        // 尸体也不会跟着走 —— 它属于"上一次死亡"，与 bodyCaches 一致。
        if (this.wasAlive.get(player.id) !== false) {
          this.spawnCorpse(player)
          this.wasAlive.set(player.id, false)
        }
        const dead = this.avatars.get(player.id)
        if (dead) dead.group.visible = false
        continue
      }
      this.wasAlive.set(player.id, true)
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

      // 动作由骨骼角度表达：蹲下是髋降 + 膝折，不是整体压扁。压扁会把
      // 滑铲/翻越/跳跃这些姿势一起压没，而且和 hitbox 对不上。
      const crouching = (player.flags & StateFlags.Crouching) !== 0
      const sliding = (player.flags & StateFlags.Sliding) !== 0
      const ads = (player.flags & StateFlags.Ads) !== 0
      const grounded = (player.flags & StateFlags.Grounded) !== 0
      const vaulting = (player.flags & StateFlags.Vaulting) !== 0
      const climbing = (player.flags & StateFlags.Climbing) !== 0
      const sprinting = !sliding && avatar.speed > 6.4
      const walking = avatar.speed > 0.25
      if (walking) avatar.phase += avatar.speed * dt * (sprinting ? 1.9 : 2.4)
      // 快照里只有"正在翻越"这一位，进度由本地时钟补；20Hz 快照不足以
      // 还原 0.34s 的动作曲线。
      avatar.vaultTime = vaulting ? Math.min(VAULT_TIME, avatar.vaultTime + dt) : 0
      animateHunter(avatar.model, {
        speed: avatar.speed,
        grounded,
        sliding,
        crouching,
        sprinting,
        ads,
        vault: vaulting ? avatar.vaultTime / VAULT_TIME : -1,
        climbing,
        phase: avatar.phase,
        dt,
      })
    }
    for (const [id, avatar] of this.avatars) {
      if (!seen.has(id)) {
        this.scene.remove(avatar.group)
        avatar.model.dispose()
        this.avatars.delete(id)
      }
    }
    // 离开对局的玩家不再需要"上一次是否活着"；尸体照常按 TTL 消失。
    for (const id of [...this.wasAlive.keys()]) if (!present.has(id)) this.wasAlive.delete(id)
  }

  /**
   * 在死亡位置放一具猎人模型。
   *
   * 没有骨骼/死亡动画，直接用程序化猎人的刚体姿势：绕 X 轴放倒、抬到地面
   * 之上。远处看到"地上躺着一个宽檐帽的人"就足够，近处也不会穿模到地下。
   */
  private spawnCorpse(player: PlayerSnapshot): void {
    const group = new Group()
    group.position.set(player.x, player.y, player.z)
    group.rotation.y = player.yaw
    const model = createHunterModel(this.hunterMaterials, { addInk: () => {} })
    // 模型原点在脚底、身体沿 +Y；绕 X 转 -90° 后沿 -Z 躺下，再抬 0.24m
    // 让大衣/帽子贴在地面而不是埋进去。
    model.root.rotation.x = -Math.PI / 2
    model.root.position.y = 0.24
    group.add(model.root)
    this.scene.add(group)
    this.corpses.push({ group, model, age: 0 })
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
    return { group, model, lastX: NaN, lastZ: NaN, speed: 0, phase: 0, vaultTime: 0 }
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
    this.updateDoors(this.frameDt)
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

  /**
   * 战局压力：0 = 开局，1 = 最后一秒。光会随对局推进暗下去，最后一段
   * 地平线偏红 —— 时间压力从 HUD 数字变成画面本身。
   */
  setPressure(progress: number): void {
    this.atmo.setPressure(progress)
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
    for (const corpse of this.corpses) {
      this.scene.remove(corpse.group)
      corpse.model.dispose()
    }
    this.corpses.length = 0
    this.wasAlive.clear()
    // GLTF 自然资产：几何、材质、贴图都是每个关卡自己加载的，必须一起释放。
    if (this.natureGroup) {
      this.natureGroup.traverse((object) => {
        const mesh = object as Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const material of materials) {
          for (const value of Object.values(material)) {
            const texture = value as Texture
            if (texture && (texture as { isTexture?: boolean }).isTexture) texture.dispose()
          }
          material.dispose()
        }
      })
      this.scene.remove(this.natureGroup)
      this.natureGroup = null
    }
    if (this.villageGroup) {
      this.villageGroup.traverse((object) => {
        const mesh = object as Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const mat of mats) {
          for (const value of Object.values(mat)) {
            const texture = value as Texture
            if (texture && (texture as { isTexture?: boolean }).isTexture) texture.dispose()
          }
          mat.dispose()
        }
      })
      this.scene.remove(this.villageGroup)
      this.villageGroup = null
    }
    this.hunterTextures.dispose()
    for (const maps of Object.values(this.surfaceMaps)) maps.dispose()
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
