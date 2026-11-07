/**
 * HDR 后处理：MSAA 世界 → 独立全分辨率武器层 → Bloom → 合成 → FXAA。
 *
 * ## 为什么要把世界和第一人称武器拆成两张 RT
 *
 * 世界为了帧率可以按 renderScale 降分辨率（0.5~1），但手里的枪是**唯一
 * 始终占据画面中心、且玩家会盯着看**的物体。如果枪也吃降分辨率，枪管边缘
 * 的墨线会糊成一条灰边 —— 这正是现在"枪很简陋"的第一观感来源。反过来，
 * 枪如果画在世界深度里，贴墙时又会被墙裁掉半个枪身。拆开之后：世界按
 * renderScale 画，枪按原生分辨率画在另一张带独立深度的透明 RT 上，最后叠
 * 回去。两个问题一起消失。
 *
 * ## 为什么是 HDR + AgX 而不是继续 NoToneMapping
 *
 * 卡通色阶的问题从来不是"色阶本身"，而是**高光没有地方去**：月光、火光、
 * 枪口闪光的线性亮度远高于 1，直出时被硬削成同一片白，bloom 也就无从谈起
 * （阈值以下的像素全被削平了）。先把辐射度存进 half-float，再用 AgX 压回
 * 显示范围，高光才有滚落；4 级色阶仍然保留，只是每级内部多了一点亮度层次。
 *
 * ## 为什么降分辨率后一定要锐化
 *
 * 世界 RT 被双线性放大到输出分辨率时，任何一条硬边都会被摊成两三个像素的
 * 斜坡。这是"糊"的直接来源，和分辨率本身无关。合成阶段做一次亮度域的
 * 对比自适应锐化（高频处少给、噪声底以下不给），把斜坡压回去 —— 这是
 * 让 0.55 倍缩放仍然"看着是原生"的关键一步。
 *
 * ## 为什么不用 EffectComposer
 *
 * examples/jsm 的 composer 会引入自己的 Pass 体系、ping-pong RT 和色彩空间
 * 约定；我们这里只需要四次全屏绘制，用一份共享三角形 + 四个 ShaderMaterial
 * 就够了。少一层抽象，也少一处"颜色空间到底在哪转"的坑。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  Color,
  DepthFormat,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  NormalBlending,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three'
import type { Texture, TextureDataType, WebGLRenderer } from 'three'

// ------------------------------------------------------------------ 类型

export interface PostFXOptions {
  /** MSAA 采样数（两张 HDR RT 共用）。默认 4，上限是设备的 maxSamples。 */
  samples?: number
  /** Bloom 金字塔层数。默认 5。 */
  bloomLevels?: number
}

export interface PostSettings {
  /** 色调映射前的线性辐射度倍率。默认 1.15。 */
  exposure?: number
  /** Bloom 叠加强度。默认 0.07。 */
  bloom?: number
  /** 显示空间颗粒量。默认 0.012。 */
  grain?: number
  /** 线性光暗角强度 0..1。默认 0.28。 */
  vignette?: number
  /** 对比自适应锐化量。默认 0.35。 */
  sharpness?: number
  /** 画面四角的色差量。默认 0.0007。 */
  chromatic?: number
}

/** 默认值集中在这里：构造函数里的 uniform 和字段必须用同一份，否则第一帧会跳。 */
const DEFAULTS = {
  exposure: 1.22,
  bloom: 0.07,
  grain: 0.012,
  vignette: 0.28,
  sharpness: 0.35,
  chromatic: 0.0007,
}

/** Bloom 预过滤的软膝阈值（线性光）。1.0 = 只有超过显示白的部分才会发光。 */
const BLOOM_THRESHOLD = 1.0
const BLOOM_KNEE = 0.6

interface BloomMip {
  rt: WebGLRenderTarget
  width: number
  height: number
}

// ------------------------------------------------------------------ GLSL

/** 全屏三角形：一个图元铺满屏幕，没有对角线接缝，也不用 quad 的 4 个顶点。 */
const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`

/** 各 pass 共用的小工具。刻意不做成 include，避免 pass 之间互相耦合。 */
const LUM = /* glsl */ `
float owLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float owHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
`

/**
 * 13 采样降采样（Jimenez 2014 的 dual-filter）。
 *
 * 第一层多做两件事：
 * 1. 软膝预过滤 —— 只留下真正高于显示白的辐射度，避免把整帧雾化成一层奶白；
 * 2. Karis 亮度平均 —— 用 1/(1+luma) 加权，单个高亮像素无法把整级 mip 泵亮，
 *    否则枪口闪光会在屏幕上留下一团会呼吸的白斑。
 */
const BLOOM_DOWN = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // 源纹理的 texel 尺寸
uniform vec4 uParams;     // x: 是否做 Karis 预过滤, y: threshold, z: knee
uniform float uExposure;  // 曝光倍率：阈值必须在显示参考空间里判，否则换个曝光就是一个效果
varying vec2 vUv;

${LUM}

vec3 fetch( vec2 uv ) { return max( texture2D( tSrc, uv ).rgb, vec3( 0.0 ) ); }
float karisWeight( vec3 c ) { return 1.0 / ( 1.0 + owLum( c ) ); }

// 按最大通道判断，而不是只看亮度：红色曳光弹和橙色枪口闪光也必须能发光。
vec3 prefilter( vec3 c, float thr, float knee ) {
  float l = max( max( c.r, c.g ), c.b );
  float soft = clamp( l - thr + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee + 1e-5 );
  return c * ( max( soft, l - thr ) / max( l, 1e-4 ) );
}

void main() {
  vec2 t = uTexel;
  vec3 a = fetch( vUv + vec2( -2.0 * t.x,  2.0 * t.y ) );
  vec3 b = fetch( vUv + vec2(  0.0,        2.0 * t.y ) );
  vec3 c = fetch( vUv + vec2(  2.0 * t.x,  2.0 * t.y ) );
  vec3 d = fetch( vUv + vec2( -2.0 * t.x,  0.0 ) );
  vec3 e = fetch( vUv );
  vec3 f = fetch( vUv + vec2(  2.0 * t.x,  0.0 ) );
  vec3 g = fetch( vUv + vec2( -2.0 * t.x, -2.0 * t.y ) );
  vec3 h = fetch( vUv + vec2(  0.0,       -2.0 * t.y ) );
  vec3 i = fetch( vUv + vec2(  2.0 * t.x, -2.0 * t.y ) );
  vec3 j = fetch( vUv + vec2( -t.x,  t.y ) );
  vec3 k = fetch( vUv + vec2(  t.x,  t.y ) );
  vec3 l = fetch( vUv + vec2( -t.x, -t.y ) );
  vec3 m = fetch( vUv + vec2(  t.x, -t.y ) );

  vec3 result;
  if ( uParams.x > 0.5 ) {
    // 先乘曝光再判阈值：prefilter 是非线性的，必须逐样本乘，不能求和后补。
    a *= uExposure; b *= uExposure; c *= uExposure; d *= uExposure;
    e *= uExposure; f *= uExposure; g *= uExposure; h *= uExposure;
    i *= uExposure; j *= uExposure; k *= uExposure; l *= uExposure;
    m *= uExposure;
    float thr = uParams.y;
    float knee = max( uParams.z, 1e-4 );
    a = prefilter( a, thr, knee ); b = prefilter( b, thr, knee );
    c = prefilter( c, thr, knee ); d = prefilter( d, thr, knee );
    e = prefilter( e, thr, knee ); f = prefilter( f, thr, knee );
    g = prefilter( g, thr, knee ); h = prefilter( h, thr, knee );
    i = prefilter( i, thr, knee ); j = prefilter( j, thr, knee );
    k = prefilter( k, thr, knee ); l = prefilter( l, thr, knee );
    m = prefilter( m, thr, knee );
    vec3 g0 = ( a + b + d + e ) * 0.25;
    vec3 g1 = ( b + c + e + f ) * 0.25;
    vec3 g2 = ( d + e + g + h ) * 0.25;
    vec3 g3 = ( e + f + h + i ) * 0.25;
    vec3 g4 = ( j + k + l + m ) * 0.25;
    float w0 = karisWeight( g0 ) * 0.125;
    float w1 = karisWeight( g1 ) * 0.125;
    float w2 = karisWeight( g2 ) * 0.125;
    float w3 = karisWeight( g3 ) * 0.125;
    float w4 = karisWeight( g4 ) * 0.5;
    result = ( g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 ) /
             max( w0 + w1 + w2 + w3 + w4, 1e-5 );
    // 夹住极端值：太阳/直射火光的几十倍亮度会把整级 mip 拖亮。
    result = min( result, vec3( 24.0 ) );
  } else {
    result = e * 0.125;
    result += ( a + c + g + i ) * 0.03125;
    result += ( b + d + f + h ) * 0.0625;
    result += ( j + k + l + m ) * 0.125;
  }

  gl_FragColor = vec4( result, 1.0 );
}
`

/**
 * 9 采样 tent 上采样，**按权重 lerp** 回上一级 mip。
 *
 * 不能用加法：每一级 mip 都从上一级重新采样，加法会把同一份能量按层数累加，
 * 5 层金字塔就得到 5 倍光晕，画面变成奶白雾。源码用的是 NormalBlending +
 * alpha=weight，等价于 lerp(dst, src, weight)，能量守恒。
 * 最宽的两级把半径收紧、权重压低 —— 它们是唯一能跨过整个轮廓的 halo，
 * 过强会把屋顶/树冠的边缘泡掉。
 */
const BLOOM_UP = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;   // 源（更小一级）的 texel 尺寸
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;

void main() {
  vec2 t = uTexel * uRadius;
  vec3 a = texture2D( tSrc, vUv + vec2( -t.x,  t.y ) ).rgb;
  vec3 b = texture2D( tSrc, vUv + vec2(  0.0,  t.y ) ).rgb;
  vec3 c = texture2D( tSrc, vUv + vec2(  t.x,  t.y ) ).rgb;
  vec3 d = texture2D( tSrc, vUv + vec2( -t.x,  0.0 ) ).rgb;
  vec3 e = texture2D( tSrc, vUv ).rgb;
  vec3 f = texture2D( tSrc, vUv + vec2(  t.x,  0.0 ) ).rgb;
  vec3 g = texture2D( tSrc, vUv + vec2( -t.x, -t.y ) ).rgb;
  vec3 h = texture2D( tSrc, vUv + vec2(  0.0, -t.y ) ).rgb;
  vec3 i = texture2D( tSrc, vUv + vec2(  t.x, -t.y ) ).rgb;
  vec3 sum = e * 4.0 + ( b + d + f + h ) * 2.0 + ( a + c + g + i );
  // 颜色不预乘权重；权重放在 alpha 里，靠 NormalBlending 做 lerp。
  gl_FragColor = vec4( sum * 0.0625, uWeight );
}
`

/**
 * AgX。矩阵、log 范围与曲线全部照抄参考实现：这是目前唯一一条
 * "高光不发紫、暗部还能保住色相"的曲线，ACES 的洋红肩膀在夜戏里很明显。
 */
const TONEMAP = /* glsl */ `
const mat3 OW_REC2020_FROM_SRGB = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 ) );
const mat3 OW_SRGB_FROM_REC2020 = mat3(
  vec3(  1.6605, -0.1246, -0.0182 ),
  vec3( -0.5876,  1.1329, -0.1006 ),
  vec3( -0.0728, -0.0083,  1.1187 ) );

vec3 owAgxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
       + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 owAgX( vec3 color, float slope, float power, float sat ) {
  const mat3 inset = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
  const mat3 outset = mat3(
    vec3(  1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
    vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
    vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );
  const float minEv = -12.47393;
  const float maxEv = 4.026069;

  color = OW_REC2020_FROM_SRGB * color;
  color = inset * color;
  color = max( color, 1e-10 );
  color = ( log2( color ) - minEv ) / ( maxEv - minEv );
  color = clamp( color, 0.0, 1.0 );

  // look：斜率必须是 1.0。它乘的是归一化后的 log 值，1.05 不是"亮 5%"，
  // 而是在 AgX 已经定好中灰位置之后再整体推 0.5 档。
  color = pow( max( color * slope, 0.0 ), vec3( power ) );
  float l = owLum( color );
  color = l + sat * ( color - l );

  color = owAgxContrast( clamp( color, 0.0, 1.0 ) );
  color = outset * color;
  color = pow( max( color, vec3( 0.0 ) ), vec3( 2.2 ) );
  color = OW_SRGB_FROM_REC2020 * color;
  return clamp( color, 0.0, 1.0 );
}
`

/**
 * 世界层合成：世界 + 接触阴影 + 武器 → sceneRT。
 *
 * 放在 bloom 之前，原因有两条：
 * 1. 源码的 step 14 就是先 resolve 视图模型、step 16 才 bloom；枪口闪光属于
 *    武器层，只有先合成进场景颜色，它才会真正产生光晕。
 * 2. 接触阴影与锐化都只应该作用于世界层：武器离镜头 0.4m，屏幕空间接触
 *    阴影在它身上没有意义，锐化也会让枪管边缘出现白边。先把它们在世界层
 *    做完，再叠加预乘 alpha 的武器，两个不变量都保住了。
 */
const COMBINE = /* glsl */ `
precision highp float;
uniform sampler2D tWorld;
uniform sampler2D tView;
uniform sampler2D tContact;
uniform vec2 uWorldTexel;
uniform float uSharpness;
uniform float uChromatic;
uniform float uContact;
varying vec2 vUv;

${LUM}

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot( d, d );

  // --- 世界采样：径向色差（只在世界层做，武器必须保持绝对锐利）---
  // 0.0007 在四角约合一个像素的几分之一，作用是让边缘微微发散，不是做故障效果。
  vec3 world;
  float ca = uChromatic * r2;
  if ( ca > 0.00002 ) {
    vec2 o = d * ca;
    world.r = texture2D( tWorld, vUv + o ).r;
    world.g = texture2D( tWorld, vUv ).g;
    world.b = texture2D( tWorld, vUv - o ).b;
  } else {
    world = texture2D( tWorld, vUv ).rgb;
  }
  world = max( world, vec3( 0.0 ) );

  // --- 对比自适应锐化（只取亮度，绝不放大色差）---
  // 用未偏移的中心采样算增益：如果拿色差后的像素和未偏移的邻域做差，
  // 差值里就含有色差偏移本身，锐化会把洋红/绿边放大成"彩边"。
  vec3 centre = max( texture2D( tWorld, vUv ).rgb, vec3( 0.0 ) );
  vec3 s1 = max( texture2D( tWorld, vUv + vec2( uWorldTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
  vec3 s2 = max( texture2D( tWorld, vUv - vec2( uWorldTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
  vec3 s3 = max( texture2D( tWorld, vUv + vec2( 0.0, uWorldTexel.y ) ).rgb, vec3( 0.0 ) );
  vec3 s4 = max( texture2D( tWorld, vUv - vec2( 0.0, uWorldTexel.y ) ).rgb, vec3( 0.0 ) );

  float lc = owLum( centre );
  float l1 = owLum( s1 );
  float l2 = owLum( s2 );
  float l3 = owLum( s3 );
  float l4 = owLum( s4 );
  float lmn = min( min( l1, l2 ), min( l3, l4 ) );
  float lmx = max( max( l1, l2 ), max( l3, l4 ) );
  float lblur = ( l1 + l2 + l3 + l4 ) * 0.25;
  // 局部对比度已经很高时少给：否则墨线附近会出现一圈白边。
  float contrast = ( lmx - lmn ) / ( lmx + lmn + 0.02 );
  float amount = uSharpness * ( 1.0 - clamp( contrast * 1.6, 0.0, 1.0 ) );
  // 噪声底以下不锐化：夜戏里暗部的"细节"大部分是颗粒，越锐越脏。
  amount *= smoothstep( 0.002, 0.025, lc );
  float gain = clamp( ( lc + ( lc - lblur ) * amount ) / max( lc, 1e-4 ), 0.0, 4.0 );
  world *= gain;

  // --- 接触阴影：只乘世界层。武器层有自己的深度，且离镜头 0.4m，
  //     屏幕空间射线在它身上没有意义。---
  if ( uContact > 0.0001 ) {
    world *= texture2D( tContact, vUv ).r;
  }

  // --- 武器层合成 ---
  // MSAA resolve 后边缘像素是"覆盖率 × 颜色 / 覆盖率 alpha"，本质是预乘。
  // 先乘 (1-a) 再相加，剪影处既不会漏出世界，也不会出现一圈黑边。
  vec4 vm = max( texture2D( tView, vUv ), vec4( 0.0 ) );
  float alpha = clamp( vm.a, 0.0, 1.0 );
  gl_FragColor = vec4( world * ( 1.0 - alpha ) + vm.rgb, 1.0 );
}
`

/**
 * 合成：scene → Bloom → 曝光 → 暗角 → AgX → sRGB → 调色 → 颗粒 → 抖动。
 *
 * 只做一遍全屏读写：每个效果都只是几行 ALU，合成到一张 LDR RT 里，
 * 避免"每个效果一张 RT"的带宽开销。世界/武器的合成、锐化、接触阴影与
 * 色差已经在 COMBINE 里完成，这里只处理与全画面有关的部分。
 */
const COMPOSITE = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;
uniform float uGrain;
uniform float uVignette;
varying vec2 vUv;

${LUM}
${TONEMAP}

vec3 linearToSrgb( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666667 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
}

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot( d, d );

  vec3 hdr = max( texture2D( tScene, vUv ).rgb, vec3( 0.0 ) );

  // --- Bloom：加法。预过滤已经只留下高于显示白的部分，叠上去才是"光晕"，
  //     而不是把整帧替换成模糊副本的奶白雾。bloom 在预过滤时已经乘过曝光
  //     （阈值必须落在显示参考空间），所以这里先曝光场景、再叠 bloom，
  //     不能再把 bloom 乘一遍。---
  hdr *= uExposure;
  hdr += max( texture2D( tBloom, vUv ).rgb, vec3( 0.0 ) ) * max( uBloom, 0.0 );

  // --- 暗角：cos^4 是镜头的透射损失，属于线性光。放在色调映射之后会变成
  //     对码值的平乘，把天空的显示白硬压下来，四角永远到不了白。---
  float cos4 = pow( 1.0 / ( 1.0 + r2 * 2.4 ), 2.0 );
  hdr *= mix( 1.0, cos4, clamp( uVignette, 0.0, 1.0 ) );

  // --- AgX（slope 1.0 / power 1.05 / sat 1.06）---
  vec3 col = owAgX( hdr, 1.0, 1.05, 1.06 );
  col = clamp( col, 0.0, 1.0 );
  vec3 disp = linearToSrgb( col );

  // --- 显示空间调色：很轻的 S 曲线 + 冷暗部/暖高光分裂 ---
  // 曲线保端点（0 仍是 0、1 仍是 1），所以不会把黑压死。
  float preLum = owLum( disp );
  vec3 softContrast = disp * disp * ( 3.0 - 2.0 * disp );
  disp = mix( disp, softContrast, 0.06 );
  float shadowW = 1.0 - smoothstep( 0.0, 0.45, preLum );
  float highW = smoothstep( 0.55, 1.0, preLum );
  disp += vec3( -0.005, 0.002, 0.012 ) * shadowW;       // 夜沼泽的青灰暗部
  disp += vec3( 0.010, 0.004, -0.005 ) * highW * 0.7;   // 火光一侧的暖高光
  disp = clamp( disp, 0.0, 1.0 );

  // --- 颗粒：用 gl_FragCoord 而不是时间，逐像素稳定，不会像电视雪花一样闪。
  //     暗部少给：显示变换之后，暗部噪声是"画面脏"的主要来源。---
  if ( uGrain > 0.0005 ) {
    float g1 = owHash12( gl_FragCoord.xy ) - 0.5;
    float g2 = owHash12( gl_FragCoord.xy * 1.7 + 19.19 ) - 0.5;
    float response = uGrain * ( 0.35 + 0.65 * smoothstep( 0.0, 0.30, owLum( disp ) ) );
    disp += ( g1 * 0.65 + g2 * 0.35 ) * response;
  }

  // --- 8bit 写入前的抖动：天空大面积渐变最容易出条带 ---
  disp += ( owHash12( gl_FragCoord.xy * 0.5 + 7.7 ) - 0.5 ) * 0.0022;

  // 直接写 sRGB：ShaderMaterial 不会自动补 colorspace_fragment，画布按 sRGB 解释。
  gl_FragColor = vec4( disp, 1.0 );
}
`

/**
 * 紧凑 FXAA（3.11 风格），在输出分辨率上跑。
 *
 * 合成后的图是不透明的，所以不需要处理 alpha；亮度按 sRGB 码值算 —— 此时
 * 人眼感知的对比就是码值对比，用线性亮度反而会把暗部边缘判成"没有边"。
 */
const FXAA = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform vec2 uTexel;
varying vec2 vUv;

${LUM}

void main() {
  vec3 rgbNW = texture2D( tColor, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbNE = texture2D( tColor, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbSW = texture2D( tColor, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  vec3 rgbSE = texture2D( tColor, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  vec3 rgbM = texture2D( tColor, vUv ).rgb;

  float lumaNW = owLum( rgbNW );
  float lumaNE = owLum( rgbNE );
  float lumaSW = owLum( rgbSW );
  float lumaSE = owLum( rgbSE );
  float lumaM  = owLum( rgbM );
  float lumaMin = min( lumaM, min( min( lumaNW, lumaNE ), min( lumaSW, lumaSE ) ) );
  float lumaMax = max( lumaM, max( max( lumaNW, lumaNE ), max( lumaSW, lumaSE ) ) );

  // 平坦区域直接放过：FXAA 的成本全在下面那 4 次额外采样上。
  if ( lumaMax - lumaMin < max( 0.0312, lumaMax * 0.125 ) ) {
    gl_FragColor = vec4( rgbM, 1.0 );
    return;
  }

  vec2 dir = vec2(
    -( ( lumaNW + lumaNE ) - ( lumaSW + lumaSE ) ),
      ( ( lumaNW + lumaSW ) - ( lumaNE + lumaSE ) ) );
  float dirReduce = max( ( lumaNW + lumaNE + lumaSW + lumaSE ) * 0.03125, 0.0078125 );
  float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
  dir = clamp( dir * rcpDirMin, -8.0, 8.0 ) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D( tColor, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb +
    texture2D( tColor, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D( tColor, vUv - dir * 0.5 ).rgb +
    texture2D( tColor, vUv + dir * 0.5 ).rgb );

  float lumaB = owLum( rgbB );
  gl_FragColor = vec4( ( lumaB < lumaMin || lumaB > lumaMax ) ? rgbA : rgbB, 1.0 );
}
`

/**
 * 屏幕空间接触阴影：从每个像素沿"朝月亮"的方向在视图空间里走 8 步，
 * 投影回屏幕比较深度。比阴影贴图便宜得多，专门补"箱脚/角色脚与地面之间
 * 那 2–4px 的暗部"—— 实时阴影在 2048² / ±52m 下做不到这个尺度。
 *
 * 输出 `1.0 = 无遮挡`，合成阶段只乘世界层。天空深度（1.0）直接放过。
 *
 * ## 为什么步进方向在视图空间
 *
 * 世界空间方向每帧跟着相机转，投影回屏幕时会因透视变成一条曲线；在视图
 * 空间里沿固定方向步进，再把每个采样点投影回屏幕，才是屏幕空间阴影的
 * 标准做法。代价是每步一次矩阵乘，8 步在独显上是可接受的。
 */
const CONTACT = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform vec3 uLightView;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uRadius;
uniform float uBias;
uniform float uThickness;
uniform float uMaxDistance;
varying vec2 vUv;

float contactHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.7);
  return fract(p.x * p.y);
}

vec3 viewPosition(vec2 uv, float d) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 view = uInvProj * clip;
  return view.xyz / view.w;
}

void main() {
  float d = texture2D(tDepth, vUv).x;
  // 天空/远裁剪面：没有遮挡体，也没有可投影的表面。
  if (d >= 0.99999) {
    gl_FragColor = vec4(1.0);
    return;
  }

  vec3 origin = viewPosition(vUv, d);
  // 只做近景：40m 外的接触阴影在屏幕上不到一个像素，步进只会制造噪点。
  float fade = 1.0 - smoothstep(uMaxDistance * 0.6, uMaxDistance, -origin.z);
  if (fade <= 0.001) {
    gl_FragColor = vec4(1.0);
    return;
  }

  // 背光面不参与接触阴影。屏幕空间射线在"月光在墙背后"的表面上会立刻
  // 打到自己的深度，产生大片随机斑块；这类面本来就被主光判为背光，
  // 交给光照/阴影图即可。法线由相邻深度的视图空间位置叉乘重建。
  float dR = texture2D(tDepth, vUv + vec2(uTexel.x, 0.0)).x;
  float dU = texture2D(tDepth, vUv + vec2(0.0, uTexel.y)).x;
  if (dR < 0.99999 && dU < 0.99999) {
    vec3 pR = viewPosition(vUv + vec2(uTexel.x, 0.0), dR);
    vec3 pU = viewPosition(vUv + vec2(0.0, uTexel.y), dU);
    vec3 n = normalize(cross(pR - origin, pU - origin));
    if (dot(n, uLightView) < 0.08) {
      gl_FragColor = vec4(1.0);
      return;
    }
  }

  // 用像素哈希抖动起点，把 8 步的阶梯状断层打散成细噪声；
  // 之后 FXAA / 泛光会把它吃掉，不需要额外的模糊 pass。
  float jitter = contactHash(gl_FragCoord.xy) - 0.5;
  float occ = 0.0;
  for (int i = 1; i <= 8; i++) {
    float t = (float(i) + jitter) / 8.0 * uRadius;
    vec3 p = origin + uLightView * t;
    vec4 clip = uProj * vec4(p, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z > 1.0) break;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    float sd = texture2D(tDepth, uv).x;
    if (sd >= 0.99999) continue;
    vec3 sp = viewPosition(uv, sd);
    // 两者都是负数；sp.z > p.z 表示遮挡体比射线点更靠近相机。
    float gap = sp.z - p.z;
    if (gap > uBias && gap < uThickness) {
      occ = 1.0;
      break;
    }
  }

  float lit = 1.0 - occ * uStrength * fade;
  gl_FragColor = vec4(vec3(lit), 1.0);
}
`

// ------------------------------------------------------------------ 工具

/** 半浮点颜色缓冲是否可渲染。没有它就只能退回 8bit（HDR 信息会丢失，但不会崩）。 */
function supportsFloatColor(renderer: WebGLRenderer): boolean {
  const extensions = renderer.extensions
  return extensions.has('EXT_color_buffer_float') || extensions.has('EXT_color_buffer_half_float')
}

// ------------------------------------------------------------------ 主体

export class PostFX {
  private readonly renderer: WebGLRenderer
  private readonly maxSamples: number
  private samples: number
  private bloomLevels: number
  private bloomEnabled = true
  /** 性能档可以关掉 FXAA，省掉一张全分辨率 LDR 目标与一次全屏 pass。 */
  private fxaaEnabled = true
  private readonly hdrType: TextureDataType

  private worldRT: WebGLRenderTarget
  private viewRT: WebGLRenderTarget
  /**
   * 世界 + 武器合成后的场景颜色（全分辨率、无 MSAA）。
   *
   * 必须是原生分辨率：世界 RT 可以按 renderScale 降，但武器层是"玩家会盯着
   * 看"的唯一物体，合成时不能把它降到世界分辨率再放大，否则枪管边缘会糊。
   * 它也是 bloom 的输入 —— 枪口闪光只有进到这张图里才会产生光晕。
   */
  private sceneRT: WebGLRenderTarget
  private ldrRT: WebGLRenderTarget
  /**
   * 世界层的深度纹理。
   *
   * 接触阴影、GTAO、TAA 的 reactive mask 都要在这里取场景深度；武器层是
   * 独立的全分辨率 RT，深度不参与世界效果。MSAA 的深度由 three 的
   * `resolveDepthBuffer`（默认 true）在 resolve 时一并 blit 出来。
   */
  private worldDepth: DepthTexture | null = null
  /** 接触阴影的 1 通道结果（RGBA8 占位，纹理过滤比 R8 兼容性好）。 */
  private contactRT: WebGLRenderTarget
  private readonly contactMaterial: ShaderMaterial
  private contactEnabled = true
  private contactReady = false
  private contactStrength = 0.38
  private readonly bloomMips: BloomMip[] = []

  /** 世界 RT 的像素尺寸。对象本身恒定，setSize 只改字段，避免调用方拿到旧引用。 */
  readonly worldSize: { width: number; height: number } = { width: 1, height: 1 }
  private viewWidth = 1
  private viewHeight = 1

  // 全屏三角形的一份共享资源：所有 pass 只换 material。
  private readonly fsGeometry: BufferGeometry
  private readonly fsScene: Scene
  private readonly fsCamera: Camera
  private readonly fsMesh: Mesh

  private readonly downMaterial: ShaderMaterial
  private readonly upMaterial: ShaderMaterial
  private readonly combineMaterial: ShaderMaterial
  private readonly compositeMaterial: ShaderMaterial
  private readonly fxaaMaterial: ShaderMaterial

  // 所有 texel 尺寸缓存：setSize 写一次，每帧只读，不在渲染循环里 new Vector2。
  private readonly worldTexel = new Vector2(1, 1)
  private readonly bloomTexel = new Vector2(1, 1)
  private readonly ldrTexel = new Vector2(1, 1)
  /** renderWorld/renderView 保存 clear color 用的临时对象（复用，不分配）。 */
  private readonly savedClearColor = new Color()

  private exposure = DEFAULTS.exposure
  private bloomStrength = DEFAULTS.bloom
  private grain = DEFAULTS.grain
  private vignette = DEFAULTS.vignette
  private sharpness = DEFAULTS.sharpness
  private chromatic = DEFAULTS.chromatic

  private disposed = false

  constructor(renderer: WebGLRenderer, options: PostFXOptions = {}) {
    this.renderer = renderer
    this.maxSamples = Math.max(0, renderer.capabilities.maxSamples)
    this.samples = Math.min(Math.max(0, Math.floor(options.samples ?? 4)), this.maxSamples)
    // 再多的层也只会变成 1x1 的纯色，夹在 1..8 之间既保证有 bloom，也防止误传。
    this.bloomLevels = Math.max(1, Math.min(8, Math.floor(options.bloomLevels ?? 5)))
    this.hdrType = supportsFloatColor(renderer) ? HalfFloatType : UnsignedByteType

    // --- 材质 ---
    this.downMaterial = new ShaderMaterial({
      uniforms: {
        tSrc: { value: null as Texture | null },
        uTexel: { value: new Vector2(1, 1) },
        uParams: { value: new Vector4(1, BLOOM_THRESHOLD, BLOOM_KNEE, 0) },
        uExposure: { value: DEFAULTS.exposure },
      },
      vertexShader: FS_VERT,
      fragmentShader: BLOOM_DOWN,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
    })

    this.upMaterial = new ShaderMaterial({
      uniforms: {
        tSrc: { value: null as Texture | null },
        uTexel: { value: new Vector2(1, 1) },
        uRadius: { value: 1 },
        uWeight: { value: 0.5 },
      },
      vertexShader: FS_VERT,
      fragmentShader: BLOOM_UP,
      depthTest: false,
      depthWrite: false,
      // NormalBlending + alpha=uWeight = lerp(dst, src, weight)，能量守恒。
      blending: NormalBlending,
      transparent: true,
      premultipliedAlpha: false,
      toneMapped: false,
    })

    this.combineMaterial = new ShaderMaterial({
      uniforms: {
        tWorld: { value: null as Texture | null },
        tView: { value: null as Texture | null },
        tContact: { value: null as Texture | null },
        uWorldTexel: { value: new Vector2(1, 1) },
        uContact: { value: 0 },
        uSharpness: { value: DEFAULTS.sharpness },
        uChromatic: { value: DEFAULTS.chromatic },
      },
      vertexShader: FS_VERT,
      fragmentShader: COMBINE,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
    })

    this.compositeMaterial = new ShaderMaterial({
      uniforms: {
        tScene: { value: null as Texture | null },
        tBloom: { value: null as Texture | null },
        uExposure: { value: DEFAULTS.exposure },
        uBloom: { value: DEFAULTS.bloom },
        uGrain: { value: DEFAULTS.grain },
        uVignette: { value: DEFAULTS.vignette },
      },
      vertexShader: FS_VERT,
      fragmentShader: COMPOSITE,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
    })

    this.fxaaMaterial = new ShaderMaterial({
      uniforms: {
        tColor: { value: null as Texture | null },
        uTexel: { value: new Vector2(1, 1) },
      },
      vertexShader: FS_VERT,
      fragmentShader: FXAA,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
    })

    this.contactMaterial = new ShaderMaterial({
      uniforms: {
        tDepth: { value: null as Texture | null },
        uInvProj: { value: null },
        uProj: { value: null },
        uLightView: { value: new Vector3(0, 1, 0) },
        uTexel: { value: new Vector2(1 / 1280, 1 / 720) },
        uStrength: { value: 0.38 },
        uRadius: { value: 1.2 },
        uBias: { value: 0.04 },
        uThickness: { value: 0.35 },
        uMaxDistance: { value: 18 },
      },
      vertexShader: FS_VERT,
      fragmentShader: CONTACT,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
    })

    // --- 全屏三角形 ---
    this.fsGeometry = new BufferGeometry()
    this.fsGeometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    )
    this.fsGeometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))

    this.fsScene = new Scene()
    this.fsScene.matrixAutoUpdate = false
    this.fsCamera = new Camera()
    this.fsMesh = new Mesh(this.fsGeometry)
    this.fsMesh.frustumCulled = false
    this.fsMesh.matrixAutoUpdate = false
    this.fsScene.add(this.fsMesh)

    // --- 初始 RT ---
    // 真实尺寸要等 setSize；先用 1x1 占位，保证 setSize 之前调用 render/present 不会炸。
    this.worldRT = this.makeHdrTarget(1, 1, true, true)
    this.viewRT = this.makeHdrTarget(1, 1, true)
    this.sceneRT = this.makeSceneTarget(1, 1)
    this.ldrRT = this.makeLdrTarget(1, 1)
    this.contactRT = this.makeContactTarget(1, 1)
    this.rebuildBloom(1, 1)
    this.bindTargets()
  }

  // ------------------------------------------------------------ 公共 API

  /** 当前世界 HDR RT。降分辨率时它会小于 viewTarget，这是刻意的。 */
  get worldTarget(): WebGLRenderTarget {
    return this.worldRT
  }

  /**
   * 世界层的深度纹理（与 worldRT 同尺寸）。
   *
   * 调用方只能在 renderWorld 之后、下一帧重建 RT 之前使用；setSize/切画质
   * 会重建 worldRT 并换掉这个引用，所以不要缓存它。
   */
  get depthTexture(): DepthTexture | null {
    return this.worldDepth
  }

  /** 当前武器 HDR RT（始终全分辨率，透明背景）。 */
  get viewTarget(): WebGLRenderTarget {
    return this.viewRT
  }

  /**
   * @param cssWidth   画布 CSS 宽度
   * @param cssHeight  画布 CSS 高度
   * @param pixelRatio 画布的 devicePixelRatio
   * @param renderScale 世界分辨率倍率（0.5..1）
   */
  setSize(cssWidth: number, cssHeight: number, pixelRatio: number, renderScale: number): void {
    if (this.disposed) return

    const cw = Math.max(1, cssWidth)
    const ch = Math.max(1, cssHeight)
    const dpr = Math.max(0.1, pixelRatio)
    // 只夹合理区间：renderScale 是性能旋钮，不该被一个手滑的 0 变成全黑。
    const scale = Math.min(2, Math.max(0.25, renderScale))

    const ww = Math.max(1, Math.floor(cw * dpr * scale))
    const wh = Math.max(1, Math.floor(ch * dpr * scale))
    const vw = Math.max(1, Math.floor(cw * dpr))
    const vh = Math.max(1, Math.floor(ch * dpr))

    if (ww !== this.worldSize.width || wh !== this.worldSize.height) {
      this.worldSize.width = ww
      this.worldSize.height = wh
      const old = this.worldRT
      this.worldRT = this.makeHdrTarget(ww, wh, true, true)
      old.dispose()
      const oldContact = this.contactRT
      this.contactRT = this.makeContactTarget(ww, wh)
      oldContact.dispose()
      // 注意：**不**在这里重建泛光金字塔。renderScale 变化只改世界 RT 的
      // 尺寸；泛光 mip 只负责"模糊 + 上采样"，采样是归一化 UV，不要求和
      // 源纹理同尺寸。每压一次分辨率就重新分配 5 张 RT，本身就会造成一次
      // 几十毫秒的卡顿 —— 这正是"移动一卡一卡"的来源之一。
    }

    if (vw !== this.viewWidth || vh !== this.viewHeight) {
      this.viewWidth = vw
      this.viewHeight = vh
      const oldView = this.viewRT
      this.viewRT = this.makeHdrTarget(vw, vh, true)
      oldView.dispose()
      // 场景合成与 bloom 都在原生分辨率上跑：武器不能跟着世界降分辨率。
      const oldScene = this.sceneRT
      this.sceneRT = this.makeSceneTarget(vw, vh)
      oldScene.dispose()
      const oldLdr = this.ldrRT
      this.ldrRT = this.makeLdrTarget(vw, vh)
      oldLdr.dispose()
      // 窗口尺寸变了才重建金字塔（此时世界尺寸也一起变了）。
      this.rebuildBloom(vw, vh)
    }

    this.worldTexel.set(1 / ww, 1 / wh)
    this.ldrTexel.set(1 / vw, 1 / vh)
    this.bindTargets()
  }

  /**
   * 接触阴影开关与强度。
   *
   * 只在 `updateContactShadow` 至少调用过一次之后才真正参与合成，
   * 避免首帧拿着 null 矩阵去跑全屏 pass。
   */
  setContactShadow(enabled: boolean, strength = 0.38): void {
    this.contactEnabled = enabled
    this.contactStrength = Math.min(0.6, Math.max(0, strength))
    // uContact 只是 0/1 开关；强度已经在 contact shader 里乘过一次了。
    this.combineMaterial.uniforms.uContact.value = enabled && this.contactReady ? 1 : 0
  }

  /**
   * 每帧在 `present()` 之前调用：相机矩阵 + 朝月亮的方向（世界空间）。
   *
   * 深度纹理来自 worldRT；如果这一帧重建过 RT，`worldDepth` 已经是新的，
   * 这里重新取一次即可。
   */
  updateContactShadow(camera: Camera, lightDirection: Vector3): void {
    if (this.worldDepth === null) return
    const u = this.contactMaterial.uniforms
    u.uInvProj.value = camera.projectionMatrixInverse
    u.uProj.value = camera.projectionMatrix
    u.uLightView.value.copy(lightDirection).transformDirection(camera.matrixWorldInverse).normalize()
    u.uTexel.value.copy(this.worldTexel)
    u.uStrength.value = this.contactStrength
    u.tDepth.value = this.worldDepth
    this.contactReady = true
    // 同 setContactShadow：强度只在 contact shader 里应用一次。
    this.combineMaterial.uniforms.uContact.value = this.contactEnabled ? 1 : 0
  }

  setSettings(settings: PostSettings): void {
    if (settings.exposure !== undefined) this.exposure = Math.max(0.01, settings.exposure)
    if (settings.bloom !== undefined) this.bloomStrength = Math.max(0, settings.bloom)
    if (settings.grain !== undefined) this.grain = Math.max(0, Math.min(0.08, settings.grain))
    if (settings.vignette !== undefined) this.vignette = Math.max(0, Math.min(1, settings.vignette))
    if (settings.sharpness !== undefined) this.sharpness = Math.max(0, Math.min(1.5, settings.sharpness))
    if (settings.chromatic !== undefined) this.chromatic = Math.max(0, Math.min(0.01, settings.chromatic))

    const u = this.compositeMaterial.uniforms
    u.uExposure.value = this.exposure
    u.uBloom.value = this.bloomEnabled ? this.bloomStrength : 0
    u.uGrain.value = this.grain
    u.uVignette.value = this.vignette

    // 锐化/色差属于世界层，在 COMBINE 里应用；下采样时每帧从字段再写一次。
    const ku = this.combineMaterial.uniforms
    ku.uSharpness.value = this.sharpness
    ku.uChromatic.value = this.chromatic
  }

  /**
   * 运行时切画质。三个旋钮分别对应 GPU 上最贵的三块：
   *
   * - `samples`：世界/武器的 MSAA。4→2→0 在弱 GPU/核显上差别最大；
   * - `bloomLevels`：泛光金字塔层数；0 或 `bloom:false` 直接跳过整条链；
   * - `bloom`：是否跑泛光。
   *
   * 改采样数必须重建两张带深度的 RT；改层数必须重建金字塔。都会 dispose
   * 旧目标，不会随切换累积显存。
   */
  setQuality(quality: {
    samples?: number
    bloomLevels?: number
    bloom?: boolean
    fxaa?: boolean
  }): void {
    if (this.disposed) return

    if (quality.bloom !== undefined) this.bloomEnabled = quality.bloom
    if (quality.fxaa !== undefined) this.fxaaEnabled = quality.fxaa

    let resized = false
    if (quality.samples !== undefined) {
      const next = Math.min(Math.max(0, Math.floor(quality.samples)), this.maxSamples)
      if (next !== this.samples) {
        this.samples = next
        resized = true
      }
    }
    if (quality.bloomLevels !== undefined) {
      const next = Math.max(0, Math.min(8, Math.floor(quality.bloomLevels)))
      if (next !== this.bloomLevels) {
        this.bloomLevels = next
        this.rebuildBloom(this.worldSize.width, this.worldSize.height)
      }
    }
    if (resized) {
      const oldWorld = this.worldRT
      const oldView = this.viewRT
      this.worldRT = this.makeHdrTarget(this.worldSize.width, this.worldSize.height, true, true)
      this.viewRT = this.makeHdrTarget(this.viewWidth, this.viewHeight, true)
      oldWorld.dispose()
      oldView.dispose()
    }

    this.compositeMaterial.uniforms.uBloom.value = this.bloomEnabled ? this.bloomStrength : 0
    this.bindTargets()
  }

  /**
   * 把世界画进 HDR RT。
   *
   * 只保存并还原自己改过的状态（autoClear / clear color / RT），
   * 调用方持有的相机、场景、雾一概不碰。
   */
  renderWorld(scene: Scene, camera: Camera): void {
    if (this.disposed) return
    const r = this.renderer
    const prevTarget = r.getRenderTarget()
    const prevAutoClear = r.autoClear
    r.getClearColor(this.savedClearColor)
    const prevAlpha = r.getClearAlpha()

    r.autoClear = false
    try {
      r.setClearColor(0x000000, 1)
      r.setRenderTarget(this.worldRT)
      r.clear(true, true, false)
      r.render(scene, camera)
    } finally {
      r.setRenderTarget(prevTarget)
      r.setClearColor(this.savedClearColor, prevAlpha)
      r.autoClear = prevAutoClear
    }
  }

  /**
   * 把第一人称武器画进全分辨率透明 RT。
   *
   * 背景强制为 null 再清成 alpha 0：即使调用方误传了带背景的场景，
   * 也不会得到一块不透明的"世界副本"压在枪后面。
   */
  renderView(scene: Scene, camera: Camera): void {
    if (this.disposed) return
    const r = this.renderer
    const prevTarget = r.getRenderTarget()
    const prevAutoClear = r.autoClear
    const prevBackground = scene.background
    r.getClearColor(this.savedClearColor)
    const prevAlpha = r.getClearAlpha()

    r.autoClear = false
    try {
      scene.background = null
      r.setClearColor(0x000000, 0)
      r.setRenderTarget(this.viewRT)
      r.clear(true, true, false)
      r.render(scene, camera)
    } finally {
      scene.background = prevBackground
      r.setRenderTarget(prevTarget)
      r.setClearColor(this.savedClearColor, prevAlpha)
      r.autoClear = prevAutoClear
    }
  }

  /** Bloom → 合成 → FXAA 到画布。必须每帧在 renderWorld / renderView 之后调用一次。 */
  present(): void {
    if (this.disposed) return
    const r = this.renderer
    const prevAutoClear = r.autoClear
    // 所有 pass 都是全屏三角形，自己铺满目标；让 renderer 自动 clear 会把
    // 上采样正在累加的目标 mip 清掉，所以整段关掉 autoClear。
    r.autoClear = false
    try {
      if (this.contactEnabled && this.contactReady && this.worldDepth !== null) this.runContact()
      // 武器必须在 bloom 之前进场景：枪口闪光属于武器层，晚合成就不发光。
      this.runCombine()
      this.runBloom()
      if (this.fxaaEnabled) {
        this.runComposite(this.ldrRT)
        this.runFxaa()
      } else {
        // 性能档：合成直接写画布，省一张全分辨率 RT 与一次 FXAA。
        // 描边/排线本身遮住了大部分锯齿，弱 GPU 上这笔开销不值得。
        this.runComposite(null)
      }
    } finally {
      r.setRenderTarget(null)
      r.autoClear = prevAutoClear
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    this.worldRT.dispose()
    this.viewRT.dispose()
    this.sceneRT.dispose()
    this.ldrRT.dispose()
    this.contactRT.dispose()
    for (const mip of this.bloomMips) mip.rt.dispose()
    this.bloomMips.length = 0

    this.downMaterial.dispose()
    this.upMaterial.dispose()
    this.combineMaterial.dispose()
    this.compositeMaterial.dispose()
    this.fxaaMaterial.dispose()
    this.contactMaterial.dispose()
    this.fsGeometry.dispose()
    this.fsScene.clear()
  }

  // ------------------------------------------------------------ 内部

  private makeHdrTarget(
    width: number,
    height: number,
    depth: boolean,
    withDepthTexture = false,
  ): WebGLRenderTarget {
    const target = new WebGLRenderTarget(width, height, {
      type: this.hdrType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: depth,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: this.samples,
      // MSAA 的深度必须一起 resolve 到 depthTexture，否则屏幕空间效果会读到
      // 未解析的多重采样深度（表现为整屏随机遮挡）。three 默认就是 true。
      resolveDepthBuffer: true,
    })
    if (withDepthTexture) {
      const depthTexture = new DepthTexture(width, height)
      depthTexture.format = DepthFormat
      depthTexture.type = UnsignedIntType
      target.depthTexture = depthTexture
      this.worldDepth = depthTexture
    }
    return target
  }

  /** 合成后的场景颜色：全分辨率、无 MSAA（输入已经 resolve 过）。 */
  private makeSceneTarget(width: number, height: number): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      type: this.hdrType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: 0,
    })
  }

  private makeContactTarget(width: number, height: number): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: 0,
    })
  }

  private makeBloomTarget(width: number, height: number): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      type: this.hdrType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: 0,
    })
  }

  private makeLdrTarget(width: number, height: number): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: 0,
    })
  }

  private rebuildBloom(width: number, height: number): void {
    for (const mip of this.bloomMips) mip.rt.dispose()
    this.bloomMips.length = 0

    let w = width
    let h = height
    for (let i = 0; i < this.bloomLevels; i++) {
      w = Math.max(1, Math.floor(w / 2))
      h = Math.max(1, Math.floor(h / 2))
      // 第一层允许 1x1（世界本身极小时），之后低于 2px 就没有可采样的邻居了。
      if (i > 0 && (w < 2 || h < 2)) break
      this.bloomMips.push({ rt: this.makeBloomTarget(w, h), width: w, height: h })
    }
  }

  /** 把刚重建过的 RT 重新绑定到材质上。setSize 只在尺寸变化时走到这里。 */
  private bindTargets(): void {
    const ku = this.combineMaterial.uniforms
    ku.tWorld.value = this.worldRT.texture
    ku.tView.value = this.viewRT.texture
    ku.tContact.value = this.contactRT.texture
    ku.uWorldTexel.value.copy(this.worldTexel)

    const cu = this.compositeMaterial.uniforms
    cu.tScene.value = this.sceneRT.texture
    cu.tBloom.value = this.bloomMips.length > 0 ? this.bloomMips[0]!.rt.texture : null

    const fu = this.fxaaMaterial.uniforms
    fu.tColor.value = this.ldrRT.texture
    fu.uTexel.value.copy(this.ldrTexel)
  }

  private blit(material: ShaderMaterial, target: WebGLRenderTarget | null): void {
    this.fsMesh.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.fsScene, this.fsCamera)
  }

  private runBloom(): void {
    if (!this.bloomEnabled) return
    const count = this.bloomMips.length
    if (count === 0) return

    const down = this.downMaterial.uniforms
    down.uExposure.value = this.exposure
    for (let i = 0; i < count; i++) {
      const mip = this.bloomMips[i]!
      const prev = i > 0 ? this.bloomMips[i - 1]! : null
      const srcW = prev ? prev.width : this.viewWidth
      const srcH = prev ? prev.height : this.viewHeight

      // 源是合成后的场景（世界 + 武器），不是 worldRT：枪口闪光必须能 bloom。
      down.tSrc.value = prev ? prev.rt.texture : this.sceneRT.texture
      this.bloomTexel.set(1 / srcW, 1 / srcH)
      down.uTexel.value.copy(this.bloomTexel)
      // 只有第一层做阈值与 Karis 平均；后面的层已经是纯扩散。
      down.uParams.value.set(i === 0 ? 1 : 0, BLOOM_THRESHOLD, BLOOM_KNEE, 0)
      this.blit(this.downMaterial, mip.rt)
    }

    const up = this.upMaterial.uniforms
    for (let i = count - 1; i > 0; i--) {
      const src = this.bloomMips[i]!
      const dst = this.bloomMips[i - 1]!
      up.tSrc.value = src.rt.texture
      this.bloomTexel.set(1 / src.width, 1 / src.height)
      up.uTexel.value.copy(this.bloomTexel)

      // 最宽的两级把半径和权重都压一档：它们是唯一能把光晕铺到几十像素外的层，
      // 满强度会把树冠/屋顶的剪影泡掉。低频亮度保留，作用距离收回。
      const wide = i >= count - 2
      up.uRadius.value = wide ? 0.62 : 1.0
      up.uWeight.value = wide ? 0.34 : 0.5
      this.blit(this.upMaterial, dst.rt)
    }

    // 由粗到细累加完之后，mip0 就是最终 bloom。
    this.compositeMaterial.uniforms.tBloom.value = this.bloomMips[0]!.rt.texture
  }

  private runContact(): void {
    const u = this.contactMaterial.uniforms
    u.tDepth.value = this.worldDepth
    this.blit(this.contactMaterial, this.contactRT)
  }

  private runCombine(): void {
    const ku = this.combineMaterial.uniforms
    ku.tWorld.value = this.worldRT.texture
    ku.tView.value = this.viewRT.texture
    ku.tContact.value = this.contactRT.texture
    this.blit(this.combineMaterial, this.sceneRT)
  }

  private runComposite(target: WebGLRenderTarget | null): void {
    const cu = this.compositeMaterial.uniforms
    cu.tScene.value = this.sceneRT.texture
    this.blit(this.compositeMaterial, target)
  }

  private runFxaa(): void {
    const fu = this.fxaaMaterial.uniforms
    fu.tColor.value = this.ldrRT.texture
    fu.uTexel.value.copy(this.ldrTexel)
    this.blit(this.fxaaMaterial, null)
  }
}
