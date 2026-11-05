/**
 * 统一墨线材质：背面外壳 + 沿法线外扩，线宽以 **CSS 像素** 为单位。
 *
 * ## 为什么不按 NDC 给宽度
 *
 * 老实现 `pos.xy += nrm.xy * uWidth * pos.w` 里的 uWidth 是 NDC 单位，于是同一个
 * 值在 x 与 y 方向换算出**不同的像素数**：1280×720 下 x 是 2.24px、y 只有
 * 1.26px。宽屏上所有描边都被压成椭圆截面的细线，看着"有，但读不出来"。
 * 现在调用方给像素，着色器用 `uRes = (2/W, 2/H)` 换算，两个轴的物理粗细一致
 * —— 这是《无主之地》那种能当轮廓线的墨线的前提。
 *
 * ## 为什么 uRes / uBoil 是共享对象而不是每材质一份
 *
 * 一个场景里有几十份墨线材质（关卡盒子、手持武器、怪物、道具），但视口只有
 * 一个、沸腾相位也只有一个。做成模块级单例、所有材质引用同一份 uniform 对象：
 * setSize 只需改一次，不需要遍历材质表去找谁要更新。
 *
 * ## 为什么必须支持 USE_INSTANCING
 *
 * 道具层（props.ts）的树与栅栏是 InstancedMesh。实例化时 `normal` 是模型空间
 * 法线，必须先过 instanceMatrix，否则每棵树都朝"自己的局部原点"外扩，描边粗细
 * 随朝向变化，一眼假。
 *
 * ## 为什么沸腾是全局一个值
 *
 * 手绘动画的"线条沸腾"是整张纸一起抖（on twos，12fps）。如果每个物体各抖各的，
 * 读起来是"每根线都在独立抽搐"，像显存坏了。全局一个相位反而更贵在手绘感上。
 */
import { BackSide, Color, ShaderMaterial, Vector2 } from 'three'

export interface OutlineOptions {
  /** 线宽，CSS 像素。默认 2.4。 */
  pixels?: number
  /** 墨色，默认 0x14100c（偏暖的近黑，不是纯黑 —— 纯黑会和暗部糊成一片）。 */
  color?: number
  /** 透明度，默认 1。尸体淡出用。 */
  opacity?: number
}

/** 默认线宽：1280 宽约 2.4px。低于 2px 在集显上会被抗锯齿吃掉。 */
const DEFAULT_PIXELS = 2.4

/**
 * 全场共用的两个 uniform 对象，**本身就是 IUniform**（不是裸值）。
 *
 * 外部模块（monsters.ts 的尸体淡出墨线、props.ts 的实例化墨线）要自己拼
 * vertexShader，把它们按引用塞进 uniforms 即可 —— setOutlineResolution /
 * setOutlineBoil 一处改、全场生效。做成裸值再包一层的话，每加一种墨线材质
 * 就要在 render.ts 里多登记一次，漏一个就是"这个物体的线不跟着屏幕变"。
 */
export const OUTLINE_SHARED = {
  /**
   * 屏幕换算系数 `(2/W, 2/H)`，单位是 CSS 像素 —— 与 devicePixelRatio 无关，
   * 于是高分屏上墨线不会变细（宽度按 CSS 像素理解才符合"笔有多粗"的直觉）。
   */
  resolution: { value: new Vector2(2 / 1280, 2 / 720) },
  /** 沸腾倍率，三档循环由 render.ts 每 1/12 秒写一次。 */
  boil: { value: 1 },
}

const VERTEX_SHADER = [
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
  '  // pos.w here is the pre-perspective-divide clip w: multiplying by it cancels',
  '  // the divide, so the offset lands as a constant screen-space length.',
  '  pos.xy += normalize(normalMatrix * nrm).xy * uWidth * uBoil * uRes * pos.w;',
  '  gl_Position = pos;',
  '}',
].join('\n')

const FRAGMENT_SHADER = [
  'uniform vec3 uColor;',
  'uniform float uOpacity;',
  'void main() {',
  '  gl_FragColor = vec4(uColor, uOpacity);',
  '}',
].join('\n')

/** 建一份墨线材质。调用方负责在 dispose 时释放它（ShaderMaterial.dispose）。 */
export function createOutlineMaterial(options: OutlineOptions = {}): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    uniforms: {
      uWidth: { value: options.pixels ?? DEFAULT_PIXELS },
      uBoil: OUTLINE_SHARED.boil,
      uRes: OUTLINE_SHARED.resolution,
      uColor: { value: new Color(options.color ?? 0x14100c) },
      uOpacity: { value: options.opacity ?? 1 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  })
}

/**
 * 视口变化时调用一次。
 *
 * 夹住下界：窗口被压成 0 宽时 2/W 会是 Infinity，直接让整个 draw call 消失，
 * 而且不会报错 —— 这种"画面没了但日志干净"最难查。
 */
export function setOutlineResolution(width: number, height: number): void {
  OUTLINE_SHARED.resolution.value.set(2 / Math.max(width, 1), 2 / Math.max(height, 1))
}

/** 线条沸腾倍率（0.85~1.15 之间晃）。一份材质都不用遍历。 */
export function setOutlineBoil(scale: number): void {
  OUTLINE_SHARED.boil.value = scale
}
