/**
 * 漫画墨线层：给卡通材质补上"暗部交叉排线 + 纸面脏污"这两笔。
 *
 * ## 为什么用屏幕空间坐标
 *
 * 漫画里的排线是**画在纸上的**，不是贴在物体表面的贴图：同一个角色，脸上和
 * 衣褶上的线一样粗、一样密。拿 gl_FragCoord.xy 当排线坐标就自动得到这个
 * 性质 —— 跨距与线宽以像素为单位恒定，于是 40m 外的木箱不会糊成一片灰，
 * 贴脸的墙也不会变成条纹巨兽。反过来用 UV，每个物体的线密度都会被它自己
 * 的展开尺寸拉歪（大盒子稀、小盒子密），一眼假。
 *
 * ## 为什么每根线都不一样长、不一样粗
 *
 * 屏幕空间的等距正弦线在数学上就是一块布：间距恒定、长度无限、粗细一致，
 * 铺到一面 9m 平墙上立刻读成编织袋/砖墙。真实的手绘排线是**一笔一笔**画
 * 的 —— 每根线有自己的粗细，还会断成几段、段间留白。这两件事都得在
 * shader 里做（comicStrokes）：行内随机相位错开断点，笔画才不会连成网。
 *
 * ## 为什么只有一个方向
 *
 * 试过 -45° / +45° 交叉排线：两组线在任何可见强度下都会锁成格状，一面 9m
 * 平墙上读到的只能是编织袋或散落的符号，永远不像"阴影"。色调本来就由 4 级
 * 卡通色阶承担，排线只负责把最暗的一档打散 —— 单向斜线加随机断笔就够了。
 *
 * ## 为什么用亮度平滑遮罩而不是阈值
 *
 * 硬阈值（lum < 0.5 ? 有线 : 无线）在世界空间平坦、在屏幕上斜着的面上会
 * 沿 4 级色阶的边界切出一条锯齿带。smoothstep 让排线在阈值附近有一段渐变，
 * 色阶切换处被吃掉，才不会看到"台阶外面镶了一圈脏边"。
 *
 * ## 为什么要加世界空间的三平面细节
 *
 * 关卡是纯色盒子、枪是程序化倒角块：4 级色阶 + 排线解决了"明暗"，但没解决
 * "这是什么材质"。UV 在合批之后根本不存在（render.ts 把九百多个盒子烘进
 * 一份几何），屏幕空间噪声又会跟着相机游泳。于是按世界坐标、按主导轴投影出
 * 一个 2D 平面取样：砖缝、木纹、拉丝、泥点就永远钉在表面上，近看远看一致。
 * 只取一个主导轴而不是三轴混合：三轴要 3 次取样再插值，而在盒子/枪械这种
 * 九成是轴对齐面的几何上，混合的收益抵不上多出来的两次噪声。
 *
 * ## 为什么固有色调制压在 ±20% 以内
 *
 * 这是"让平面读成材质"，不是"贴壁纸"。细节一旦超过 ±20%，4 级色阶会被噪声
 * 打散，卡通感立刻退化成低分辨率 PBR。砖缝/板缝是例外（30%）：那里本来就
 * 该是断开的，断开得越干脆，墙才越像砖砌的。
 *
 * ## 为什么高光是假的
 *
 * 卡通材质只有 4 级漫反射，倒角、枪管、金属棱边在夜里会塌成同一块平色。
 * 用月亮方向做一个 44 次幂的 Blinn 高光 + 菲涅尔轮廓光，成本是两次 dot 和
 * 一次 pow，就能把"这是金属"这个信息补回来，而不必切到 PBR 材质 —— 后者会
 * 引入环境贴图、粗糙度链和一条完全不同的 program，还要和 NoToneMapping 打架。
 * 方向放在 INK_SHARED 里由渲染器每帧指向月亮；强度默认 0，所以不开的材质
 * 像素一个都不变。
 *
 * ## 为什么必须有 customProgramCacheKey
 *
 * three 的 program 缓存键只看材质类型与 defines / 光照分支 / 贴图槽，**不看
 * onBeforeCompile**。同类型的"打过补丁"和"没打补丁"材质于是共用一个 program，
 * 谁先编译谁赢 —— 表现就是补丁随机只出现在一部分网格上，另一部分静悄悄没了。
 * 换一个独立缓存键，两种变体各编译一份。
 *
 * ## 为什么不做动画
 *
 * 手绘排线就该是静的。动起来要多一个每帧上传的 uTime，整屏重算噪点，
 * 换来的只是"画面在抖"—— 收益为负，直接不做。
 *
 * ## 注入点为什么是 opaque_fragment
 *
 * 已按 three r186 的 meshtoon fragment 源码核对（three.module.js 里
 * `const fragment$4`）：`vec3 outgoingLight = ...` 之后紧跟
 * `#include <opaque_fragment>`，而 tonemapping / colorspace 都在它后面。
 * 插早了拿不到光照结果，插晚了颜色已经是 sRGB 编码过的，排线会偏色。
 * 所以：替换那一行，改 outgoingLight，再把那一行原样放回去。
 *
 * 本文件自包含，不 import 任何东西 —— 补丁只碰材质的运行时字段与 GLSL 字符串。
 */

/** 程序化细节的材质家族。默认 'default' 完全不产生细节，旧画面逐像素不变。 */
export type ComicSurface = 'default' | 'stone' | 'wood' | 'metal' | 'mud' | 'foliage'

export interface ComicOptions {
  /**
   * 排线的屏幕空间间距基准（像素级），默认 9.0。
   *
   * 这个值就是**相邻两根线的中心距**。低于 6px 时线挤在一起，断口被填满，
   * 又变回一层网纹；16 以上在大面上就只剩"几笔交代暗部"。
   */
  hatchSpacing?: number
  /** 排线强度 0..1，默认 0.55；0 等于关闭 */
  hatchStrength?: number
  /**
   * 阴影阈值，0..1，**按 gamma 编码后的感知亮度**判断，默认 0.30。
   *
   * 不是线性亮度：线性的 0.30 在眼里已经是中灰，却远低于任何合理的线性阈值，
   * 于是受光面也全被排线盖住。
   */
  hatchThreshold?: number
  /** 纸张污渍量 0..1，默认 0.06 */
  grime?: number
  /**
   * 世界空间污渍/苔痕量 0..1，默认 0.7。
   *
   * 关卡是一堆纯色盒子，屏幕上动辄两百像素宽，没有这张大尺度噪点就是一块
   * 硬纸板。噪点按世界坐标取，所以同一面墙近看远看花纹一致，也不会跟着
   * 相机游泳；贴地的部分额外压暗，等于免费的一圈接缝阴影。
   */
  mottle?: number
  /** 污渍斑块里混进的第二色（十六进制），默认墨绿 0x2a3320。 */
  tint?: number
  /** 第二色混入量 0..1，默认 0（纯乘性压暗，不改变色相）。 */
  tintAmount?: number
  /**
   * 材质家族，决定世界空间三平面细节的图案，默认 'default'（关闭）。
   *
   * 只影响固有色级别的细节（砖缝/木纹/拉丝/泥点/叶簇），不改变光照模型；
   * 强度刻意压在 ±20% 以内，砖缝等结构缝最多 30%。
   */
  surface?: ComicSurface
  /** 假高光强度 0..1，默认 0。金属枪身的倒角靠它读出来。 */
  specular?: number
  /** 高光/轮廓光颜色（十六进制 sRGB），默认 0xffffff。 */
  specColor?: number
  /** 剪影轮廓光强度 0..1，默认 0。逆光时勾出枪管与怪物的边缘。 */
  rim?: number
}

/**
 * 共享 uniform：所有打补丁的材质引用**同一个对象**，于是渲染器每帧只需要
 * 调一次 setInkKeyDirection 就能让全场高光跟着月亮转，而不必遍历材质。
 */
export const INK_SHARED: {
  keyDir: { value: number[] }
  /** 0 = 关闭世界空间程序化细节（性能档）；1 = 开。默认 1。 */
  detail: { value: number }
} = {
  // 约等于 atmosphere.ts 的默认月亮方向（方位 149°、仰角 18°），
  // 只在渲染器尚未调用 setInkKeyDirection 时兜底；specular 默认 0，不影响画面。
  keyDir: { value: [0.489, 0.309, -0.815] },
  detail: { value: 1 },
}

/** 性能档：跳过三平面材质细节的噪声采样（描边/排线/污渍保留）。 */
export function setInkDetail(on: boolean): void {
  INK_SHARED.detail.value = on ? 1 : 0
}

/** 把假高光的方向指向世界空间单位向量 (x, y, z)；内部归一化，原地改数组。 */
export function setInkKeyDirection(x: number, y: number, z: number): void {
  const dir = INK_SHARED.keyDir.value
  const len = Math.hypot(x, y, z)
  if (len < 1e-6) {
    dir[0] = 0
    dir[1] = 1
    dir[2] = 0
    return
  }
  dir[0] = x / len
  dir[1] = y / len
  dir[2] = z / len
}

/** 材质家族 → shader 里的整数编号。顺序即协议，改动要同步 INJECT_GLSL。 */
function surfaceIdOf(surface: ComicSurface | undefined): number {
  switch (surface) {
    case 'stone':
      return 1
    case 'wood':
      return 2
    case 'metal':
      return 3
    case 'mud':
      return 4
    case 'foliage':
      return 5
    default:
      return 0
  }
}

/** 挂在 userData.comicUniforms 上的可调项；运行时改 .value 即刻生效，不重编译。 */
type ComicUniforms = {
  uComicHatchSpacing: { value: number }
  uComicHatchStrength: { value: number }
  uComicHatchThreshold: { value: number }
  uComicGrime: { value: number }
  uComicMottle: { value: number }
  uComicTint: { value: [number, number, number] }
  uComicTintAmount: { value: number }
  uComicSurface: { value: number }
  uComicSpecular: { value: number }
  uComicSpecColor: { value: [number, number, number] }
  uComicRim: { value: number }
  /** 与 INK_SHARED.keyDir 是同一个对象，故意不做拷贝。 */
  uInkKeyDir: { value: number[] }
  /** 与 INK_SHARED.detail 是同一个对象。 */
  uComicDetail: { value: number }
}

/**
 * 替换目标。**必须是 three 源码里逐字符存在的子串** —— 已用一次性脚本
 * 在 three.module.js 的 meshtoon fragment 上断言过，改版本时请复验。
 */
const FRAGMENT_HOOK = '#include <opaque_fragment>'

/** 程序缓存键：版本号带在里面，将来升级注入内容时换版本即可全量失效。 */
const CACHE_KEY = 'comic-ink-v2'

/** 便宜的 2D→1D 整数哈希：不需要好看，只需要相邻格子不相关。 */
const HASH_GLSL = [
  'float comicHash21(vec2 p) {',
  '  p = fract(p * vec2(123.34, 456.21));',
  '  p += dot(p, p + 45.32);',
  '  return fract(p.x * p.y);',
  '}',
  '// Smooth value noise: hatch has to arrive in soft patches, not per-cell blocks.',
  'float comicNoise2(vec2 p) {',
  '  vec2 i = floor(p);',
  '  vec2 f = fract(p);',
  '  f = f * f * (3.0 - 2.0 * f);',
  '  float a = comicHash21(i);',
  '  float b = comicHash21(i + vec2(1.0, 0.0));',
  '  float c = comicHash21(i + vec2(0.0, 1.0));',
  '  float d = comicHash21(i + vec2(1.0, 1.0));',
  '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
  '}',
  '// One family of hand-drawn strokes.',
  '// Two things separate a drawn hatch from a screen-space sine grid: every stroke',
  '// gets its own width, and each stroke is broken into segments with random gaps.',
  '// Continuous lines at even spacing are mathematically identical to woven fabric,',
  '// so a flat 9m wall read as a wicker basket no matter how thin the lines were.',
  'float comicStrokes(float across, float along, float spacing, float seed) {',
  '  float q = across / spacing + 0.5;',
  '  float row = floor(q);',
  '  float w = 0.09 + 0.08 * comicHash21(vec2(row, seed));',
  '  float ink = 1.0 - smoothstep(w, w + 0.06, abs(fract(q) - 0.5));',
  '  float seg = floor(along / (spacing * 6.0) + comicHash21(vec2(row, seed + 3.0)) * 2.0);',
  '  return ink * step(0.52, comicHash21(vec2(row * 1.7 + seg, seed + 11.0)));',
  '}',
].join('\n')

/**
 * 世界空间材质细节。
 *
 * 每个函数只返回**固有色乘数**（vec3），不碰光照：这样排线、污渍、tint 的
 * 判断仍然基于同一条光照结果，色阶不会因为贴了细节就错位。
 * horizon = 1 表示该片元的主导轴是 Y（地面/桌面），砖墙要换成不规则石板，
 * 木纹/拉丝也要把纤维方向转 90°。
 *
 * 取样预算：每个函数最多 3 次 comicNoise2，加原有排线/污渍的 5 次仍在 8 次以内。
 */
const SURFACE_GLSL = [
  '// Stone: brick courses on walls, irregular flagstones on horizontal faces.',
  'vec3 comicStoneSurface(vec2 p, float horizon) {',
  '  vec3 tint = vec3(1.0);',
  '  if (horizon > 0.5) {',
  '    // Flagstones: one jittered grid (a Voronoi needs neighbour loops we do not want).',
  '    float warp = comicNoise2(p * 1.7 + vec2(3.1, 8.7));',
  '    vec2 q = p / vec2(0.92, 0.74);',
  '    q += (vec2(warp, comicNoise2(p * 1.7 + vec2(9.3, 2.1))) - 0.5) * 0.22;',
  '    vec2 cell = floor(q);',
  '    vec2 f = fract(q);',
  '    float d = min(min(f.x, 1.0 - f.x) * 0.92, min(f.y, 1.0 - f.y) * 0.74);',
  '    float gap = 1.0 - smoothstep(0.006, 0.022, d);',
  '    float stone = 0.93 + 0.14 * comicHash21(cell + 3.7);',
  '    tint *= stone * (1.0 - 0.28 * gap);',
  '  } else {',
  '    // Brick courses: 0.78m x 0.30m, every other row shifted half a brick.',
  '    float row = floor(p.y / 0.30);',
  '    float bxx = p.x + mod(row, 2.0) * 0.39;',
  '    float col = floor(bxx / 0.78);',
  '    vec2 f = vec2(fract(bxx / 0.78) * 0.78, fract(p.y / 0.30) * 0.30);',
  '    float d = min(min(f.x, 0.78 - f.x), min(f.y, 0.30 - f.y));',
  '    float mortar = 1.0 - smoothstep(0.006, 0.018, d);',
  '    float brick = 0.93 + 0.14 * comicHash21(vec2(row, col) + 5.1);',
  '    // A thin catch light along each brick top lip: sunlight on the chamfer.',
  '    float lip = smoothstep(0.26, 0.298, f.y);',
  '    tint *= brick * (1.0 - 0.30 * mortar);',
  '    tint += vec3(0.05) * lip * (1.0 - mortar);',
  '  }',
  '  // Low-frequency weathering: moss, rain, years of sun.',
  '  tint *= 0.90 + 0.20 * comicNoise2(p * 0.33 + vec2(4.7, 8.1));',
  '  return tint;',
  '}',
  '// Wood: ~6.5x stretched grain, 0.42m board seams, sparse knots.',
  'vec3 comicWoodSurface(vec2 p, float horizon) {',
  '  float across = p.x;',
  '  float along = p.y;',
  '  if (horizon > 0.5) {',
  '    across = p.y;',
  '    along = p.x;',
  '  }',
  '  // Board seams and plank-to-plank value variation.',
  '  float plank = floor(across / 0.42);',
  '  float seamD = min(fract(across / 0.42), 1.0 - fract(across / 0.42)) * 0.42;',
  '  float seam = 1.0 - smoothstep(0.004, 0.014, seamD);',
  '  float plankVal = 0.93 + 0.14 * comicHash21(vec2(plank, 17.3));',
  '  // Grain is the same noise stretched along the board, plus a finer fibre line.',
  '  float grain = comicNoise2(vec2(across * 24.0, along * 3.7));',
  '  grain = grain * 0.72 + 0.28 * comicNoise2(vec2(across * 61.0, along * 7.0) + 9.1);',
  '  vec3 tint = vec3(plankVal * (0.90 + 0.18 * grain));',
  '  // Knots: one cheap jittered cell per 1.6m, circular darkening, not all cells.',
  '  vec2 kq = p / 1.6;',
  '  vec2 kc = floor(kq);',
  '  vec2 kf = fract(kq) - (0.30 + 0.40 * vec2(comicHash21(kc), comicHash21(kc + 7.1)));',
  '  float knot = (1.0 - smoothstep(0.03, 0.10, length(kf))) * step(0.72, comicHash21(kc + 2.3));',
  '  tint *= 1.0 - 0.22 * knot;',
  '  tint *= 1.0 - 0.26 * seam;',
  '  return tint;',
  '}',
  '// Metal: brushed streaks, weak oxidation patches, edge pits.',
  'vec3 comicMetalSurface(vec2 p, float horizon) {',
  '  float across = p.x;',
  '  float along = p.y;',
  '  if (horizon > 0.5) {',
  '    across = p.y;',
  '    along = p.x;',
  '  }',
  '  // ~17:1 anisotropic noise reads as a brushed finish instead of grey mottling.',
  '  float brush = comicNoise2(vec2(across * 84.0, along * 5.0));',
  '  brush = brush * 0.7 + 0.3 * comicNoise2(vec2(across * 190.0, along * 11.0) + 4.3);',
  '  vec3 tint = vec3(0.94 + 0.12 * brush);',
  '  // Oxidation pulled toward warm brown, deliberately weak: gunmetal stays gunmetal.',
  '  float rust = smoothstep(0.60, 0.90, comicNoise2(p * 1.15 + vec2(19.2, 4.4)));',
  '  tint = mix(tint, tint * vec3(1.10, 0.66, 0.40), 0.32 * rust);',
  '  // Fine pitting along edges and recesses.',
  '  float pit = smoothstep(0.72, 0.95, comicHash21(floor(p * 26.0)));',
  '  tint *= 1.0 - 0.10 * pit;',
  '  return tint;',
  '}',
  '// Mud/ground: damp patches, pooled water, pebble speckle.',
  'vec3 comicMudSurface(vec2 p, float horizon) {',
  '  // Damp patches: low frequency, darker and a touch cooler.',
  '  float damp = smoothstep(0.42, 0.78, comicNoise2(p * 0.55 + vec2(2.7, 11.4)));',
  '  vec3 tint = mix(vec3(1.0), vec3(0.82, 0.89, 1.00), 0.55 * damp);',
  '  // Puddles sit inside the deepest damp patches. There is no height field here,',
  '  // so "lowest" is read from the damp mask rather than absolute Y (an absolute-Y',
  '  // term once took the whole flat ground plane down a stop).',
  '  float pool = damp * (1.0 - smoothstep(0.25, 0.55, comicNoise2(p * 1.9 + vec2(33.1, 7.7))));',
  '  tint = mix(tint, vec3(0.72, 0.80, 0.94), 0.35 * pool);',
  '  // Fine aggregate: dark pebbles plus the occasional bright grain.',
  '  float grit = comicHash21(floor(p * 46.0));',
  '  tint *= 1.0 - 0.12 * smoothstep(0.80, 0.94, grit);',
  '  tint += vec3(0.08) * step(0.96, comicHash21(floor(p * 23.0) + 7.7));',
  '  return tint;',
  '}',
  '// Foliage: two scales of leaf clusters with a slight hue shift.',
  'vec3 comicFoliageSurface(vec2 p, float horizon) {',
  '  float coarse = comicNoise2(p * 6.5);',
  '  float fine = comicNoise2(p * 19.0 + vec2(5.3, 9.7));',
  '  float leaf = coarse * 0.62 + fine * 0.38;',
  '  float clump = smoothstep(0.32, 0.72, leaf);',
  '  vec3 tint = mix(vec3(0.84), vec3(1.14), clump);',
  '  // Warm/cool leaf variation, kept under 10% so the 4 toon steps survive.',
  '  tint *= mix(vec3(1.0), vec3(0.90, 1.03, 0.84), clump * 0.35);',
  '  return tint;',
  '}',
].join('\n')

/**
 * 顶点注入点。begin_vertex 之后 transformed 就是模型空间顶点（实例化还没
 * 乘上），拿它算世界坐标最省事；换成 project_vertex 之后再取就只剩裁剪空间。
 */
const VERTEX_HOOK = '#include <begin_vertex>'

/**
 * 世界坐标 + 世界法线 varying。污渍必须按世界坐标取，按屏幕坐标取会跟着相机
 * 移动，墙面上的花纹会像贴了一层薄膜在游动。世界法线供三平面选轴与假高光用；
 * 法线同样不能取视图空间，否则高光会跟着相机转头。
 */
const WORLD_VARYING = 'varying vec3 vComicWorld;\nvarying vec3 vComicNormal;'

const VERTEX_INJECT = [
  VERTEX_HOOK,
  '#ifdef USE_INSTANCING',
  '  vComicWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;',
  '  vComicNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);',
  '#else',
  '  vComicWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
  '  vComicNormal = normalize(mat3(modelMatrix) * normal);',
  '#endif',
].join('\n')

const UNIFORMS_GLSL = [
  'uniform float uComicHatchSpacing;',
  'uniform float uComicHatchStrength;',
  'uniform float uComicHatchThreshold;',
  'uniform float uComicGrime;',
  'uniform float uComicMottle;',
  'uniform vec3 uComicTint;',
  'uniform float uComicTintAmount;',
  'uniform float uComicSurface;',
  'uniform float uComicSpecular;',
  'uniform vec3 uComicSpecColor;',
  'uniform float uComicRim;',
  'uniform vec3 uInkKeyDir;',
  'uniform float uComicDetail;',
].join('\n')

/**
 * 注入体：替换掉 `#include <opaque_fragment>`，改完 outgoingLight 再把原
 * include 放回去（opaque_fragment 负责把 outgoingLight 写进 gl_FragColor，
 * 少了它整个 shader 什么都不画）。
 *
 * 顺序很重要：材质细节先乘到固有色上，排线/污渍/tint 再照旧读取这条光照结果；
 * 假高光最后加。倒过来会让排线的亮度阈值跟着细节抖，暗部出现一圈圈噪点。
 */
const INJECT_GLSL = [
  '  {',
  '    vec3 comicN = normalize(vComicNormal);',
  '    // ---- Material detail: world space, dominant-axis projection. ----',
  '    // Branching on a uniform is free (no divergence); default = 0 means the',
  '    // whole block is skipped and existing materials are pixel-identical.',
  '    if (uComicSurface > 0.5 && uComicDetail > 0.5) {',
  '      vec3 an = abs(comicN);',
  '      vec2 comicSurfP;',
  '      float comicHorizon = 0.0;',
  '      if (an.y >= an.x && an.y >= an.z) {',
  '        comicSurfP = vComicWorld.xz;',
  '        comicHorizon = 1.0;',
  '      } else if (an.x >= an.z) {',
  '        comicSurfP = vComicWorld.zy;',
  '      } else {',
  '        comicSurfP = vComicWorld.xy;',
  '      }',
  '      int comicId = int(uComicSurface + 0.5);',
  '      vec3 comicSurf = vec3(1.0);',
  '      if (comicId == 1) comicSurf = comicStoneSurface(comicSurfP, comicHorizon);',
  '      else if (comicId == 2) comicSurf = comicWoodSurface(comicSurfP, comicHorizon);',
  '      else if (comicId == 3) comicSurf = comicMetalSurface(comicSurfP, comicHorizon);',
  '      else if (comicId == 4) comicSurf = comicMudSurface(comicSurfP, comicHorizon);',
  '      else if (comicId == 5) comicSurf = comicFoliageSurface(comicSurfP, comicHorizon);',
  '      // Albedo-level modulation only: the light response stays shared, so the',
  '      // 4 toon steps do not turn into per-pixel noise.',
  '      // Distance fade: the brick mortar and brushed metal are sub-pixel past',
  '      // ~40m and have no mip chain (procedural, not a texture). Without this',
  '      // the far walls shimmer as the camera moves. Keep the low-frequency',
  '      // weathering (mottle below) at full strength; only the fine pattern fades.',
  '      float comicDetail = 1.0 - smoothstep(16.0, 52.0, distance(cameraPosition, vComicWorld));',
  '      outgoingLight *= mix(vec3(1.0), comicSurf, comicDetail);',
  '    }',
  '    // Screen space: pixel units keep line width/density independent of distance.',
  '    // (GLSL comments stay ASCII on purpose: the shader source charset is not UTF-8 safe.)',
  '    vec2 comicPx = gl_FragCoord.xy;',
  '    // Jitter per 3px cell so the strokes wobble like pen work instead of CAD parallels.',
  '    comicPx += (comicHash21(floor(comicPx * 0.3333)) - 0.5) * 1.4;',
  '    // Rotate +-45deg (1/sqrt2): u runs across one stroke family, v along it.',
  '    float u45 = (comicPx.x + comicPx.y) * 0.70710678;',
  '    float v45 = (comicPx.x - comicPx.y) * 0.70710678;',
  '    float comicInk1 = comicStrokes(u45, v45, max(uComicHatchSpacing, 1.0), 1.0);',
  '    // Luminance mask: outgoingLight is still linear-lit here, the only sane place to judge it.',
  '    // Gamma-encoded before thresholding: a linear value of 0.30 is already a mid grey to the eye,',
  '    // but sits far below any sane linear threshold, so every lit face hatched and the level read',
  '    // as brickwork instead of shading. Judging the same number the artist sees fixes that.',
  '    float comicLum = pow(max(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)), 0.0), 0.4545);',
  '    // Narrow window: hatch marks shadow, it does not tint the whole surface.',
  '    float comicDark = 1.0 - smoothstep(uComicHatchThreshold - 0.08, uComicHatchThreshold + 0.02, comicLum);',
  '    // One direction only. Two stroke families at any visible strength form a lattice,',
  '    // and a lattice on a 9m wall reads as woven basket or as scattered glyphs - never as',
  '    // shading. Borderlands-style cel shading carries the tone with 4 flat steps; the pen',
  '    // work only has to break up the deepest shadow.',
  '    float comicHatch = comicInk1;',
  '    // Patchiness: an artist hatches a shadow *region*, never a whole face at even',
  '    // coverage. Large soft blobs (~90px) leave bare paper between the strokes.',
  '    comicHatch *= smoothstep(0.42, 0.80, comicNoise2(comicPx * 0.011));',
  '    // Hatch only darkens, never mixes a fixed ink color: hue survives, wood still reads as wood.',
  '    outgoingLight *= 1.0 - 0.42 * comicHatch * comicDark * uComicHatchStrength;',
  '    // Mottle: two octaves of world-space noise. A flat 9m box has no texture, so without',
  '    // this every wall reads as a sheet of cardboard. Sampled in world space so the pattern',
  '    // is nailed to the surface instead of swimming with the camera.',
  '    float comicMottle = comicNoise2(vComicWorld.xz * 0.42) * 0.5',
  '      + comicNoise2(vComicWorld.xz * 1.9 + vec2(31.7, 7.3)) * 0.3',
  '      + comicNoise2(vComicWorld.xz * 6.3 + vec2(-13.1, 5.9)) * 0.2;',
  '    // Symmetric around 1.0: the blotches lighten as often as they darken, otherwise the',
  '    // whole level just loses a stop of exposure as the noise is dialled up.',
  '    outgoingLight *= mix(1.0, 0.58 + 0.84 * comicMottle, uComicMottle);',
  '    // Colour pick-up: real ground is not one pigment. Mixing toward a moss/dirt tone in',
  '    // the low blotches turns "noise on a grey plane" into "wet patches in mud".',
  '    outgoingLight = mix(outgoingLight, uComicTint, uComicTintAmount * (1.0 - comicMottle));',
  '    // Drips: stains run *down* a wall, so sample a column-stretched noise (fine along x,',
  '    // coarse along y). Without this a wall is uniformly weathered, which reads as noise',
  '    // rather than as a thing water has been running over for twenty years.',
  '    // Masked by height: on a horizontal plane the stretched sample collapses to a 1D slice',
  '    // along x+z, which painted long diagonal bands across the whole ground.',
  '    float comicDrip = comicNoise2(vec2((vComicWorld.x + vComicWorld.z) * 2.6, vComicWorld.y * 0.22));',
  '    outgoingLight *= 1.0 - 0.26 * smoothstep(0.45, 0.85, comicDrip) * smoothstep(0.25, 0.9, vComicWorld.y);',
  '    // Contact darkening: the bottom of anything is where dirt and moss pile up. This fakes',
  '    // the ambient occlusion the renderer never computes.',
  '    // Masked by facing: an up-facing surface *is* the bottom-most thing, so the unmasked',
  '    // term took a third of the exposure off the entire ground plane at night.',
  '    float comicContact = 1.0 - clamp(abs(comicN.y), 0.0, 1.0);',
  '    outgoingLight *= 1.0 - 0.3 * smoothstep(2.4, 0.0, vComicWorld.y) * comicContact;',
  '    // Grime: a low-frequency cell hash (one sample per 2px) beats per-pixel white noise and is cheaper.',
  '    outgoingLight *= 1.0 - uComicGrime * comicHash21(floor(gl_FragCoord.xy * 0.5));',
  '    // ---- Fake key-light specular + rim. ----',
  '    // Added after albedo/grime so the highlight is not multiplied away by dirt,',
  '    // and before opaque_fragment so it is still linear-lit when tonemapping runs.',
  '    // A tight 44 exponent keeps it on chamfers and polished metal instead of',
  '    // smearing a plastic sheen over every box.',
  '    if (uComicSpecular > 0.001 || uComicRim > 0.001) {',
  '      vec3 comicV = normalize(cameraPosition - vComicWorld);',
  '      vec3 comicL = normalize(uInkKeyDir);',
  '      vec3 comicH = normalize(comicV + comicL);',
  '      float comicSpec = pow(max(dot(comicN, comicH), 0.0), 44.0);',
  '      outgoingLight += uComicSpecColor * (comicSpec * uComicSpecular);',
  '      // Fresnel silhouette: the moon behind a barrel draws its edge in one line.',
  '      float comicRim = pow(1.0 - max(dot(comicN, comicV), 0.0), 3.0);',
  '      outgoingLight += uComicSpecColor * (comicRim * uComicRim);',
  '    }',
  '  }',
  '  ' + FRAGMENT_HOOK,
].join('\n')

/**
 * 十六进制 → 线性 RGB 三元组。
 *
 * 不 import three 的 Color 是刻意的：本文件是纯 GLSL 补丁，能被 Node 里的
 * 单测直接调用，少一个 three 依赖就少一类"测试环境跑不起来"。公式与
 * three.Color.setHex 在 SRGBColorSpace 下完全一致。
 */
function toLinearTriplet(hex: number): [number, number, number] {
  const convert = (channel: number): number => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return [convert((hex >> 16) & 0xff), convert((hex >> 8) & 0xff), convert(hex & 0xff)]
}

/** 给一个标准/卡通材质打上"漫画排线 + 纸纹 + 材质细节"补丁，返回同一个材质以便链式调用。 */
export function applyComicInk<T>(material: T, options?: ComicOptions): T {
  // three 的 Material 类型没有暴露 onBeforeCompile 的宽松签名，这里统一走 any：
  // 补丁本身是运行时行为，类型收窄并不会让它更安全。
  const mat: any = material
  if (!mat || typeof mat !== 'object' || !mat.userData) return material

  // 二次打补丁会把同一段 GLSL 注入两遍（uniform 重复声明直接编译失败），
  // 也会把 customProgramCacheKey 套娃。这里直接放过。
  if (mat.userData.comicPatched === true) return material

  const uniforms: ComicUniforms = {
    uComicHatchSpacing: { value: options?.hatchSpacing ?? 9.0 },
    uComicHatchStrength: { value: options?.hatchStrength ?? 0.55 },
    uComicHatchThreshold: { value: options?.hatchThreshold ?? 0.30 },
    uComicGrime: { value: options?.grime ?? 0.06 },
    uComicMottle: { value: options?.mottle ?? 0.7 },
    uComicTint: { value: toLinearTriplet(options?.tint ?? 0x2a3320) },
    uComicTintAmount: { value: options?.tintAmount ?? 0 },
    uComicSurface: { value: surfaceIdOf(options?.surface) },
    uComicSpecular: { value: options?.specular ?? 0 },
    uComicSpecColor: { value: toLinearTriplet(options?.specColor ?? 0xffffff) },
    uComicRim: { value: options?.rim ?? 0 },
    // 共享对象，不拷贝：setInkKeyDirection 改一次，所有材质下一帧都生效。
    uInkKeyDir: INK_SHARED.keyDir,
    uComicDetail: INK_SHARED.detail,
  }

  // 引用同一批 uniform 对象：调用方之后拿到它改 .value，shader 里立刻生效。
  mat.userData.comicUniforms = uniforms
  mat.userData.comicPatched = true
  // 没有这一行，打过补丁的材质会复用未打补丁材质的 program（详见文件头）。
  mat.customProgramCacheKey = () => CACHE_KEY

  mat.onBeforeCompile = (shader: any): void => {
    // 只挂引用、不复制值：这样 setComicHatch 改的是真正上传的那一份。
    Object.assign(shader.uniforms, uniforms)

    // 注入必须在 main() 之外：uniform、varying 与工具函数都是全局声明。
    shader.vertexShader = WORLD_VARYING + '\n' + shader.vertexShader.replace(VERTEX_HOOK, VERTEX_INJECT)
    shader.fragmentShader =
      UNIFORMS_GLSL + '\n' + WORLD_VARYING + '\n' + HASH_GLSL + '\n' + SURFACE_GLSL + '\n' + shader.fragmentShader

    // 认不出注入点就原样放过 —— 宁可这材质没排线，也别把画面改坏。
    //
    // 这里能匹配到 #include 原文，是因为 onBeforeCompile 在 resolveIncludes 之前
    // 调用（three r186：WebGLRenderer.getProgram 调 onBeforeCompile，Program 构造
    // 才把 include 展开）。本补丁按 MeshToonMaterial 的 chunk 布局验证；lambert /
    // phong / standard 的 fragment 也以同一行收尾，所以它们顺带可用，但只有 toon
    // 是逐行核对过的 —— 换 three 版本请重跑断言。
    if (!shader.fragmentShader.includes(FRAGMENT_HOOK)) return
    shader.fragmentShader = shader.fragmentShader.replace(FRAGMENT_HOOK, INJECT_GLSL)
  }

  return material
}

/** 运行时调排线强度（0..1），用于淡入淡出；不改 .value 之外的东西，所以不触发重编译。 */
export function setComicHatch(material: unknown, strength: number): void {
  const mat = material as { userData?: { comicUniforms?: ComicUniforms } } | null | undefined
  const uniforms = mat?.userData?.comicUniforms
  if (!uniforms) return
  uniforms.uComicHatchStrength.value = Math.min(Math.max(strength, 0), 1)
}
