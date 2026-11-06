/**
 * 夜景环境探针：把 atmosphere 的天空球烘成 IBL。
 *
 * ## 为什么不是一张 HDRI
 *
 * 项目的夜空是程序化 shader（月亮/星点/云带/地平线余烬都由 `uTime` 驱动），
 * 背包里再塞一张 4K 全景图，等于维护两种天空：一张贴图和一套 shader 会在
 * 月相、雾色、天气修正上慢慢对不齐。这里直接把现有的天空球**渲染到一张
 * 128px 的 cube target**，再走 `PMREMGenerator` 生成环境贴图 —— 天空是什么
 * 样，反射就是什么样，改天空不用同步第二份资产。
 *
 * ## 为什么 PMREM 和原始 cube 都要留
 *
 * `PMREMGenerator.fromCubemap()` 的输出是 **CubeUV 编码**（`CubeUVReflectionMapping`），
 * 只适合直接赋给 `scene.environment` 给 MeshStandard/Physical 采样。
 * 卡通材质没有 envMap 槽位，若以后要在 ink.ts 里手写反射，必须采样原始
 * `WebGLCubeRenderTarget.texture`，不能拿 PMREM 的输出去 `textureCube`。
 *
 * ## 什么时候 capture
 *
 * 天空每帧都在变（云在漂），但环境光不需要逐帧更新：一次 128px cube +
 * PMREM 约几毫秒。启动时一次、天气/关卡切换时一次就够；月光方向本身是常量，
 * 云遮月的 8% 起伏不值得每帧重烘。
 */
import {
  CubeCamera,
  HalfFloatType,
  LinearSRGBColorSpace,
  PMREMGenerator,
  Scene,
  WebGLCubeRenderTarget,
  type Object3D,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'

/** 环境探针独占的 layer，避免把世界里的任何东西捕进天空。 */
const ENV_LAYER = 6

export interface EnvironmentProbe {
  /** CubeUV 环境贴图，赋给 `scene.environment`。换 capture 后引用会变。 */
  readonly environment: Texture
  /** 原始 cube 贴图，给手写反射用（不是 PMREM 的输出）。 */
  readonly cube: Texture
  /** 重新烘一次天空。关卡/天气切换后调用。 */
  capture(): void
  dispose(): void
}

export function createEnvironmentProbe(
  renderer: WebGLRenderer,
  sky: Object3D,
  size = 128,
): EnvironmentProbe {
  const cubeTarget = new WebGLCubeRenderTarget(size, {
    type: HalfFloatType,
    generateMipmaps: false,
    colorSpace: LinearSRGBColorSpace,
  })
  const cubeCamera = new CubeCamera(0.1, 1000, cubeTarget)
  cubeCamera.layers.set(ENV_LAYER)

  // 天空球在场景里是跟着相机走的；探针要一份"原点视角"的副本。
  // clone 共享 geometry/material，不会多编译一份 shader。
  const scene = new Scene()
  const clone = sky.clone(true)
  clone.position.set(0, 0, 0)
  clone.rotation.set(0, 0, 0)
  clone.layers.set(ENV_LAYER)
  scene.add(clone)

  const generator = new PMREMGenerator(renderer)
  generator.compileCubemapShader()

  let pmremTarget: WebGLRenderTarget | null = null

  const capture = (): void => {
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    try {
      cubeCamera.update(renderer, scene)
    } finally {
      renderer.setRenderTarget(prevTarget)
      renderer.autoClear = prevAutoClear
    }
    const next = generator.fromCubemap(cubeTarget.texture)
    if (pmremTarget !== null) pmremTarget.dispose()
    pmremTarget = next
  }

  capture()

  return {
    get environment(): Texture {
      return pmremTarget!.texture
    },
    cube: cubeTarget.texture,
    capture,
    dispose(): void {
      pmremTarget?.dispose()
      pmremTarget = null
      cubeTarget.dispose()
      generator.dispose()
      scene.remove(clone)
      scene.clear()
    },
  }
}
