/**
 * 雨：GPU 驱动的雨丝 + 地面溅射环。
 *
 * ## 为什么不再每帧改顶点
 *
 * 旧实现是 480 条线段，CPU 每帧把整条位置缓冲往下推一次并重新上传。雨越大，
 * 上传越贵，而且线段只有一像素宽，在 1080p 下读起来像噪点。现在改成
 * InstancedMesh + 顶点着色器：位置由 uTime 在 GPU 里循环，CPU 每帧只写
 * 几个 uniform（时间、相机位置、强度）。雨量翻几倍也不增加主线程成本。
 *
 * ## 为什么雨丝跟着相机走
 *
 * 雨区是一个半径 26m、高 24m 的圆柱，中心钉在相机上。雨滴超出圆柱就从顶部
 * 绕回 —— 玩家永远处在雨的"中心"，但不会看到整片雨墙跟着自己平移，因为
 * 每个实例的相位不同，视觉上是连续雨幕。
 *
 * ## 为什么地面溅射也是 GPU 的
 *
 * 溅射环只需要"相位 + 位置"，没有物理；把 140 个环的缩放/淡出全部放进顶点
 * 着色器，CPU 0 成本。它们只铺在相机周围 12m，超出玩家视野的远处根本不需要。
 *
 * 所有随机数走 mulberry32：同一颗种子长同一场雨，截图可复现。
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { Camera, Object3D, Scene } from 'three'
import { mulberry32 } from '@dk/shared'

export type RainQuality = 'performance' | 'balanced' | 'quality'

export interface Rain {
  readonly root: Object3D
  /** 0 = 停雨，1 = 骤雨。会按画质缩实例数。 */
  setIntensity(intensity: number): void
  setQuality(quality: RainQuality): void
  /** 每帧调用：只推进时间和相机位置。 */
  update(dt: number, camera: Camera): void
  dispose(): void
}

const RAIN_SEED = 0x5a17f0
const MAX_DROPS = 1800
const MAX_SPLASHES = 140
/** 雨区半径（米）。太大看不出"雨在周围"，太小会看到边缘的圆柱。 */
const RADIUS = 26
/** 雨区高度（米）。 */
const HEIGHT = 24
const SPLASH_RADIUS = 12

const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uIntensity;
uniform vec3 uCamera;
uniform vec3 uWind;
varying vec2 vUv;
varying float vAlpha;

void main() {
  vUv = uv;
  float speed = 12.0 + aSeed.w * 10.0;
  // 减号 = 随时间向下；加号会让整场雨从地面往天上倒流。
  float y = mod(aSeed.z * ${HEIGHT.toFixed(1)} - uTime * speed, ${HEIGHT.toFixed(1)});
  vec3 center;
  center.x = uCamera.x + aSeed.x * ${RADIUS.toFixed(1)} + uWind.x * (y / speed);
  center.z = uCamera.z + aSeed.y * ${RADIUS.toFixed(1)} + uWind.z * (y / speed);
  center.y = uCamera.y - 9.0 + y;

  vec3 fall = normalize(vec3(uWind.x, -speed, uWind.z));
  vec3 toCam = normalize(uCamera - center);
  vec3 side = normalize(cross(fall, toCam));
  float len = 0.35 + aSeed.w * 0.85;
  float wid = 0.010 + aSeed.w * 0.008;
  vec3 world = center + side * (position.x * wid) + fall * (position.y * len);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  float d = distance(world, uCamera);
  float nearFade = smoothstep(0.35, 1.6, d);
  float farFade = 1.0 - smoothstep(${(RADIUS * 0.72).toFixed(1)}, ${RADIUS.toFixed(1)}, d);
  vAlpha = uIntensity * nearFade * farFade * (0.45 + aSeed.w * 0.55);
}
`

const RAIN_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
void main() {
  float ends = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
  float side = smoothstep(0.0, 0.35, 1.0 - abs(vUv.x * 2.0 - 1.0));
  gl_FragColor = vec4(uColor, ends * side * vAlpha);
}
`

const SPLASH_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uIntensity;
uniform vec3 uCamera;
uniform float uGroundY;
varying vec2 vUv;
varying float vAlpha;

void main() {
  vUv = uv;
  float cycle = fract(uTime * 1.25 + aSeed.z);
  float scale = mix(0.05, 0.42, cycle) * aSeed.w;
  vec3 center = vec3(
    uCamera.x + aSeed.x * ${SPLASH_RADIUS.toFixed(1)},
    uGroundY + 0.025,
    uCamera.z + aSeed.y * ${SPLASH_RADIUS.toFixed(1)}
  );
  vec3 world = center + vec3(position.x * scale, 0.0, position.y * scale);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vAlpha = uIntensity * (1.0 - cycle) * smoothstep(0.0, 0.12, cycle) * 0.55;
}
`

const SPLASH_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vAlpha;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float ring = smoothstep(0.55, 0.72, r) * (1.0 - smoothstep(0.82, 1.0, r));
  gl_FragColor = vec4(0.72, 0.80, 0.86, ring * vAlpha);
}
`

function fillSeeds(count: number, rnd: () => number): Float32Array {
  const seeds = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const o = i * 4
    seeds[o] = rnd() * 2 - 1
    seeds[o + 1] = rnd() * 2 - 1
    seeds[o + 2] = rnd()
    seeds[o + 3] = rnd()
  }
  return seeds
}

export function createRain(scene: Scene, groundY: number): Rain {
  const root = new Group()
  root.name = 'rain'
  scene.add(root)

  const rnd = mulberry32(RAIN_SEED)
  const dropSeeds = fillSeeds(MAX_DROPS, rnd)
  const splashSeeds = fillSeeds(MAX_SPLASHES, rnd)

  const cameraPos = new Vector3()
  const dropGeo = new PlaneGeometry(1, 1)
  const dropMat = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uCamera: { value: cameraPos },
      uWind: { value: new Vector3(0.9, 0, 0.35) },
      uColor: { value: new Color(0x9fb6c8) },
    },
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    blending: NormalBlending,
  })
  const drops = new InstancedMesh(dropGeo, dropMat, MAX_DROPS)
  dropGeo.setAttribute('aSeed', new InstancedBufferAttribute(dropSeeds, 4))
  drops.frustumCulled = false
  drops.renderOrder = 9
  drops.count = 0
  drops.visible = false
  root.add(drops)

  const splashGeo = new PlaneGeometry(1, 1)
  const splashMat = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uCamera: { value: cameraPos },
      uGroundY: { value: groundY },
      uColor: { value: new Color(0xaebdcc) },
    },
    vertexShader: SPLASH_VERT,
    fragmentShader: SPLASH_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    blending: AdditiveBlending,
  })
  const splashes = new InstancedMesh(splashGeo, splashMat, MAX_SPLASHES)
  splashGeo.setAttribute('aSeed', new InstancedBufferAttribute(splashSeeds, 4))
  splashes.frustumCulled = false
  splashes.renderOrder = 10
  splashes.count = 0
  splashes.visible = false
  root.add(splashes)

  let intensity = 0
  let qualityScale = 1
  let time = 0
  let disposed = false

  function refreshCounts(): void {
    const dropsWanted = Math.round(MAX_DROPS * Math.min(1, intensity) * qualityScale)
    const splashWanted = Math.round(MAX_SPLASHES * Math.min(1, intensity) * qualityScale)
    drops.count = dropsWanted
    splashes.count = splashWanted
    drops.visible = dropsWanted > 0
    splashes.visible = splashWanted > 0
    dropMat.uniforms.uIntensity!.value = intensity
    splashMat.uniforms.uIntensity!.value = intensity
  }

  return {
    root,
    setIntensity(next: number): void {
      if (disposed) return
      intensity = Math.max(0, Math.min(1, next))
      refreshCounts()
    },
    setQuality(quality: RainQuality): void {
      if (disposed) return
      qualityScale = quality === 'performance' ? 0.45 : quality === 'balanced' ? 0.72 : 1
      refreshCounts()
    },
    update(dt: number, camera: Camera): void {
      if (disposed || intensity <= 0) return
      time += Math.min(Math.max(dt, 0), 0.1)
      dropMat.uniforms.uTime!.value = time
      splashMat.uniforms.uTime!.value = time
      cameraPos.copy(camera.position)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      scene.remove(root)
      root.remove(drops)
      root.remove(splashes)
      drops.dispose()
      splashes.dispose()
      dropGeo.dispose()
      splashGeo.dispose()
      dropMat.dispose()
      splashMat.dispose()
    },
  }
}
