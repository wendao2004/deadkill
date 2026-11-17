/**
 * 模型的**对象空间**细节：颗粒、积垢、边缘磨亮。
 *
 * 为什么不是贴图：
 *
 * - 枪和手是跟着相机动的东西。ink.ts 的世界空间噪声在场景里很好用，但在
 *   0.4m 的武器上会"流动"——玩家一转身，木纹就从枪托跑到机匣上。
 * - 配件是可拆的，UV 贴图集一拆就断；而对象空间的程序化细节按零件自身坐标
 *   计算，换任何挂点都自动贴合。
 *
 * 这里只做三件在近景最容易被看见的事，全部在 `#include <color_fragment>`
 * 之后调制 `diffuseColor`，不新增 pass、不新增几何：
 *
 * 1. **颗粒**：低频噪声压暗凹处（木头导管孔、皮革颗粒、铸造面）。
 * 2. **积垢**：朝下的面（`-normal.y`）再加上一层噪声门控的脏污，模拟
 *    "手上的油和沼泽泥往低处流"。
 * 3. **磨亮**：菲涅尔边缘 × 噪声门控，把边角推向金属色 —— 倒角处的
 *    "露白"是硬表面看起来像被用过、而不是刚出厂的关键。
 *
 * 与 `applyComicInk` 的关系：ink 先打补丁，本模块**链式**接在它后面
 * （保存并调用上一个 onBeforeCompile），两者互不覆盖。
 */

import type { Material } from 'three'

export interface ModelDetailOptions {
  /** 颗粒强度 0..1（默认 0.35）。 */
  grain?: number
  /** 朝下面/凹处的积垢强度 0..1（默认 0.45）。 */
  cavity?: number
  /** 边缘磨亮强度 0..1（默认 0.25，金属件可到 0.6）。 */
  wear?: number
  /** 噪声频率（1/米）。木/皮 60~90，金属拉丝 200~320。 */
  scale?: number
  /** 纹理方向：wood 沿长度拉长，metal 高频竖向拉丝，none 各向同性。 */
  pattern?: 'none' | 'wood' | 'metal' | 'leather'
  /** 磨亮处混入的颜色（十六进制），默认冷钢色。 */
  wearColor?: number
}

interface DetailUniforms {
  uDetailScale: { value: number }
  uDetailGrain: { value: number }
  uDetailCavity: { value: number }
  uDetailWear: { value: number }
  uDetailPattern: { value: number }
  uDetailWearColor: { value: [number, number, number] }
}

const CACHE_KEY = 'model-detail-v1'

const VERTEX_DECL = `
varying vec3 vMD_pos;
varying vec3 vMD_nrm;
varying vec3 vMD_nrmV;
varying vec3 vMD_view;
`

const VERTEX_BODY = `
  vMD_pos = position;
  vMD_nrm = normal;
  // 片元里没有 modelViewMatrix（它只存在于顶点着色器），法线的视图空间
  // 变换必须在这里用 normalMatrix 算好再传下去。
  vMD_nrmV = normalize(normalMatrix * normal);
  vMD_view = -(modelViewMatrix * vec4(position, 1.0)).xyz;
`

const FRAGMENT_DECL = `
varying vec3 vMD_pos;
varying vec3 vMD_nrm;
varying vec3 vMD_nrmV;
varying vec3 vMD_view;
uniform float uDetailScale;
uniform float uDetailGrain;
uniform float uDetailCavity;
uniform float uDetailWear;
uniform float uDetailPattern;
uniform vec3 uDetailWearColor;

float mdcHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float mdcNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mdcHash(i), mdcHash(i + vec2(1.0, 0.0)), u.x),
    mix(mdcHash(i + vec2(0.0, 1.0)), mdcHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float mdcFbm(vec2 p) {
  return mdcNoise(p) * 0.62 + mdcNoise(p * 2.17 + 11.3) * 0.28 + mdcNoise(p * 4.7 + 3.1) * 0.1;
}
`

/** 十六进制 → 线性 RGB（与 ink.ts 的 toLinearTriplet 同一套公式）。 */
function toLinearTriplet(hex: number): [number, number, number] {
  const convert = (channel: number): number => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return [convert((hex >> 16) & 0xff), convert((hex >> 8) & 0xff), convert(hex & 0xff)]
}

const PATTERN_CODE: Record<NonNullable<ModelDetailOptions['pattern']>, number> = {
  none: 0,
  wood: 1,
  metal: 2,
  leather: 3,
}

/**
 * 给一个卡通/标准材质补上对象空间细节，返回同一个材质以便链式调用。
 *
 * 幂等：同一个材质重复调用会直接返回，不会把 GLSL 注入两遍。
 */
export function applyModelDetail<T>(material: T, options?: ModelDetailOptions): T {
  const mat: any = material
  if (!mat || typeof mat !== 'object' || !mat.userData) return material
  if (mat.userData.modelDetailPatched === true) return material

  const uniforms: DetailUniforms = {
    uDetailScale: { value: options?.scale ?? 90 },
    uDetailGrain: { value: options?.grain ?? 0.35 },
    uDetailCavity: { value: options?.cavity ?? 0.45 },
    uDetailWear: { value: options?.wear ?? 0.25 },
    uDetailPattern: { value: PATTERN_CODE[options?.pattern ?? 'none'] },
    uDetailWearColor: { value: toLinearTriplet(options?.wearColor ?? 0x9aa3ad) },
  }

  mat.userData.modelDetailPatched = true
  mat.userData.modelDetailUniforms = uniforms

  const previous = mat.onBeforeCompile as ((shader: any) => void) | undefined
  const previousKey = mat.customProgramCacheKey as (() => string) | undefined

  mat.onBeforeCompile = (shader: any): void => {
    // 先把 ink 的补丁跑完，再在它的输出上继续注入 —— 顺序反了会把 ink 的
    // varying/uniform 声明挡在 main() 外面。
    if (typeof previous === 'function') previous(shader)
    Object.assign(shader.uniforms, uniforms)

    shader.vertexShader = VERTEX_DECL + '\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + VERTEX_BODY,
    )
    shader.fragmentShader = FRAGMENT_DECL + '\n' + shader.fragmentShader

    // 认不出注入点就原样放过：宁可没有颗粒，也不要把画面改坏。
    const hook = '#include <color_fragment>'
    if (!shader.fragmentShader.includes(hook)) return
    shader.fragmentShader = shader.fragmentShader.replace(
      hook,
      hook + `
{
  // 方向化采样：wood 沿 Y（枪身长度）拉长，metal 竖向拉丝，leather 各向同性。
  vec3 p = vMD_pos;
  vec2 q;
  if (uDetailPattern < 0.5) {
    q = p.xz * uDetailScale + p.y * uDetailScale * 0.7;
  } else if (uDetailPattern < 1.5) {
    q = vec2((p.x + p.z) * uDetailScale * 2.4, p.y * uDetailScale * 0.16);
  } else if (uDetailPattern < 2.5) {
    q = vec2((p.x + p.z) * uDetailScale * 0.35, p.y * uDetailScale * 1.9);
  } else {
    q = p.xz * uDetailScale * 2.0 + p.y * uDetailScale;
  }

  float grain = mdcFbm(q);
  float streak = mdcNoise(vec2((p.x + p.z) * uDetailScale * 0.8, p.y * uDetailScale * 3.0));

  // 1) 颗粒：只压暗，不加亮 —— 亮斑会让平涂面看起来像塑料。
  diffuseColor.rgb *= 1.0 - uDetailGrain * 0.34 * smoothstep(0.35, 0.85, grain);

  // 2) 积垢：朝下的面 + 噪声门控，模拟泥水/手油往低处流。
  float down = clamp(-vMD_nrm.y, 0.0, 1.0);
  diffuseColor.rgb *= 1.0 - uDetailCavity * 0.52 * down * smoothstep(0.25, 0.8, streak);

  // 3) 磨亮：菲涅尔边缘 × 噪声，把倒角推向金属色（用过的东西才有露白）。
  vec3 viewDir = normalize(vMD_view);
  float fresnel = pow(1.0 - clamp(abs(dot(normalize(vMD_nrmV), viewDir)), 0.0, 1.0), 2.4);
  float wearMask = clamp(fresnel * (0.45 + 0.75 * smoothstep(0.45, 0.9, streak)) * uDetailWear, 0.0, 0.85);
  diffuseColor.rgb = mix(diffuseColor.rgb, uDetailWearColor, wearMask);
}
`,
    )
  }

  mat.customProgramCacheKey = () =>
    CACHE_KEY +
    '|' + (typeof previousKey === 'function' ? previousKey() : '') +
    '|' + uniforms.uDetailScale.value.toFixed(0) +
    ':' + uniforms.uDetailPattern.value

  return material
}
