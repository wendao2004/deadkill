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
}

/** 挂在 userData.comicUniforms 上的四个可调项；运行时改 .value 即刻生效，不重编译。 */
type ComicUniforms = {
  uComicHatchSpacing: { value: number }
  uComicHatchStrength: { value: number }
  uComicHatchThreshold: { value: number }
  uComicGrime: { value: number }
  uComicMottle: { value: number }
  uComicTint: { value: [number, number, number] }
  uComicTintAmount: { value: number }
}

/**
 * 替换目标。**必须是 three 源码里逐字符存在的子串** —— 已用一次性脚本
 * 在 three.module.js 的 meshtoon fragment 上断言过，改版本时请复验。
 */
const FRAGMENT_HOOK = '#include <opaque_fragment>'

/** 程序缓存键：版本号带在里面，将来升级注入内容时换 v2 即可全量失效。 */
const CACHE_KEY = 'comic-ink-v1'

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
 * 顶点注入点。begin_vertex 之后 transformed 就是模型空间顶点（实例化还没
 * 乘上），拿它算世界坐标最省事；换成 project_vertex 之后再取就只剩裁剪空间。
 */
const VERTEX_HOOK = '#include <begin_vertex>'

/**
 * 世界坐标 varying。污渍必须按世界坐标取，按屏幕坐标取会跟着相机移动，
 * 墙面上的花纹会像贴了一层薄膜在游动。
 */
const WORLD_VARYING = 'varying vec3 vComicWorld;'

const VERTEX_INJECT = [
  VERTEX_HOOK,
  '#ifdef USE_INSTANCING',
  '  vComicWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;',
  '#else',
  '  vComicWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
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
].join('\n')

/**
 * 注入体：替换掉 `#include <opaque_fragment>`，改完 outgoingLight 再把原
 * include 放回去（opaque_fragment 负责把 outgoingLight 写进 gl_FragColor，
 * 少了它整个 shader 什么都不画）。
 */
const INJECT_GLSL = [
  '  {',
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
  '    float comicContact = 1.0 - clamp(abs(normal.y), 0.0, 1.0);',
  '    outgoingLight *= 1.0 - 0.3 * smoothstep(2.4, 0.0, vComicWorld.y) * comicContact;',
  '    // Grime: a low-frequency cell hash (one sample per 2px) beats per-pixel white noise and is cheaper.',
  '    outgoingLight *= 1.0 - uComicGrime * comicHash21(floor(gl_FragCoord.xy * 0.5));',
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

/** 给一个标准/卡通材质打上"漫画排线 + 纸纹"补丁，返回同一个材质以便链式调用。 */
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
  }

  // 引用同一批 uniform 对象：调用方之后拿到它改 .value，shader 里立刻生效。
  mat.userData.comicUniforms = uniforms
  mat.userData.comicPatched = true
  // 没有这一行，打过补丁的材质会复用未打补丁材质的 program（详见文件头）。
  mat.customProgramCacheKey = () => CACHE_KEY

  mat.onBeforeCompile = (shader: any): void => {
    // 只挂引用、不复制值：这样 setComicHatch 改的是真正上传的那一份。
    Object.assign(shader.uniforms, uniforms)

    // 注入必须在 main() 之外：uniform 与工具函数都是全局声明。
    shader.vertexShader = WORLD_VARYING + '\n' + shader.vertexShader.replace(VERTEX_HOOK, VERTEX_INJECT)
    shader.fragmentShader = UNIFORMS_GLSL + '\n' + WORLD_VARYING + '\n' + HASH_GLSL + '\n' + shader.fragmentShader

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
