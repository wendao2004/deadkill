/**
 * 五族程序化 PBR 贴图：albedo 细节 / 法线 / 粗糙度。
 *
 * ## 为什么仍然程序化
 *
 * M5 之前仓库里没有 GLTF/KTX2 资产；直接换写实贴图等于先建一条资源管线。
 * 这一步先让**光照模型**变成物理基础：贴图只是给平面几何提供法线与粗糙度
 * 的微结构，颜色仍由关卡材质表（MATERIALS）决定。等资产管线落地，这里的
 * 输出可以无痛替换成 KTX2，材质接口不变。
 *
 * ## 三张图从同一个高度场来
 *
 * 每种材质只画一次高度场：砖缝低、砖面高；木纹是凹槽；金属是细拉丝；
 * 泥地是水洼；叶簇是团块。法线由高度场的中心差分得到，粗糙度由高度和
 * 斑块共同决定。好处是三张图永远对得上 —— 不会出现"法线说有缝、albedo
 * 却是平的"。
 *
 * ## 为什么是 256²
 *
 * 关卡盒子合批后 UV 是米制的，一张 256² 图铺 0.5–1.2m，近看约 2–4px/cm；
 * 512² 在 1080p 下只在贴脸时才有区别，显存却是四倍。M5 换 KTX2 时再按
 * hero 资产单独提高分辨率。
 */
import {
  CanvasTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three'

export type SurfaceFamily = 'stone' | 'wood' | 'metal' | 'mud' | 'foliage'

export interface SurfaceMaps {
  readonly family: SurfaceFamily
  /** 灰度细节，乘在材质的固有色上。 */
  readonly albedo: Texture
  /** 切线空间法线，编码在 RGB。 */
  readonly normal: Texture
  /** 粗糙度，取 R 通道。 */
  readonly roughness: Texture
  /** 一张图在世界里铺多少米。 */
  readonly tileMeters: number
  dispose(): void
}

const SIZE = 256

/** 每种材质一张图铺多少米：砖缝/木板/拉丝的真实尺度。 */
const TILE_METERS: Record<SurfaceFamily, number> = {
  // 地面占屏面积最大，1.2m 的泥斑会在 20m 内重复几十次，读成"地板革"；
  // 放到 2.4m 后中景只看到 8–10 个周期，细节交给 mipmap 收敛。
  stone: 1.2,
  wood: 0.9,
  metal: 0.7,
  mud: 3.0,
  foliage: 1.2,
}

function hash2(x: number, y: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return h - Math.floor(h)
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = smooth(x - xi)
  const yf = smooth(y - yi)
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf
}

interface Sample {
  /** 0..1 高度，决定法线。 */
  h: number
  /** 0..255 灰度，乘固有色。 */
  a: number
  /** 0..255 粗糙度。 */
  r: number
}

function sampleFamily(family: SurfaceFamily, x: number, y: number): Sample {
  switch (family) {
    case 'stone': {
      // 错缝砖：每块 64×32，3px 灰缝。
      const bw = 64
      const bh = 32
      const row = Math.floor(y / bh)
      const ox = (row & 1) * (bw >> 1)
      const bx = (x + ox) % bw
      const by = y % bh
      const mortar = bx < 3 || by < 3
      const brick = hash2(Math.floor((x + ox) / bw), row, 3)
      const grit = noise2(x / 6, y / 6, 5)
      return mortar
        ? { h: 0.22, a: 182 + grit * 10, r: 238 }
        : { h: 0.62 + brick * 0.22 + grit * 0.04, a: 198 + brick * 12 + grit * 5, r: 205 - brick * 25 }
    }
    case 'wood': {
      // 竖向木板：48px 一块，2px 缝；木纹沿 y 拉长。
      const plank = Math.floor(x / 48)
      const seam = x % 48 < 2
      const grain = noise2(x / 42, y / 5, 7) * 0.55 + noise2(x / 11, y / 2, 9) * 0.45
      const knot = noise2(x / 18, y / 18, 13) > 0.78 ? 0.12 : 0
      return seam
        ? { h: 0.18, a: 178, r: 236 }
        : { h: 0.52 + grain * 0.28, a: 195 + hash2(plank, 0, 17) * 10 + grain * 12 - knot * 30, r: 185 + grain * 45 }
    }
    case 'metal': {
      // 水平拉丝 + 低频锈斑。锈的地方粗糙度拉高、亮度压低。
      const streak = noise2(x / 2.2, y / 36, 11)
      const rust = noise2(x / 38, y / 38, 21) > 0.74
      return rust
        ? { h: 0.42 + streak * 0.08, a: 186 + streak * 10, r: 232 }
        : { h: 0.52 + streak * 0.10, a: 216 + streak * 12, r: 118 + streak * 55 }
    }
    case 'mud': {
      // 低洼水洼 + 湿泥颗粒：水洼低、粗糙度低（反光），泥面高、粗糙。
      const n = noise2(x / 44, y / 44, 31) * 0.6 + noise2(x / 13, y / 13, 33) * 0.4
      const puddle = n > 0.63
      return puddle
        ? { h: 0.3 + n * 0.04, a: 194 + n * 10, r: 92 }
        : { h: 0.48 + n * 0.18, a: 200 + n * 12, r: 226 - n * 24 }
    }
    case 'foliage': {
      // 叶簇：高处的团块亮、低处的缝暗；法线强，远处靠 mip 收敛。
      const n = noise2(x / 9, y / 9, 41) * 0.55 + noise2(x / 3, y / 3, 43) * 0.45
      const leaf = n > 0.46
      return leaf
        ? { h: 0.68 + n * 0.16, a: 188 + n * 18, r: 198 }
        : { h: 0.3 + n * 0.12, a: 158 + n * 16, r: 240 }
    }
  }
}

function makeTexture(data: Uint8Array, srgb: boolean): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文')
  const img = ctx.createImageData(SIZE, SIZE)
  img.data.set(data)
  ctx.putImageData(img, 0, 0)
  const texture = new CanvasTexture(canvas)
  if (srgb) texture.colorSpace = SRGBColorSpace
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  // UV 已经按米算过，这里不再 repeat；只靠 wrap 平铺。
  texture.repeat.set(1, 1)
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

function build(family: SurfaceFamily): SurfaceMaps {
  const tileMeters = TILE_METERS[family]
  const height = new Float32Array(SIZE * SIZE)
  const albedo = new Uint8Array(SIZE * SIZE * 4)
  const rough = new Uint8Array(SIZE * SIZE * 4)

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x
      const s = sampleFamily(family, x, y)
      height[i] = s.h
      const a = Math.max(0, Math.min(255, Math.round(s.a)))
      const r = Math.max(0, Math.min(255, Math.round(s.r)))
      albedo[i * 4] = a
      albedo[i * 4 + 1] = a
      albedo[i * 4 + 2] = a
      albedo[i * 4 + 3] = 255
      rough[i * 4] = r
      rough[i * 4 + 1] = r
      rough[i * 4 + 2] = r
      rough[i * 4 + 3] = 255
    }
  }

  // 高度场 → 切线空间法线（中心差分，边界回绕保证可平铺）。
  const normal = new Uint8Array(SIZE * SIZE * 4)
  const strength = family === 'stone' ? 2.0 : family === 'wood' ? 1.8 : family === 'metal' ? 1.0 : family === 'mud' ? 1.8 : 2.2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x
      const xl = (x - 1 + SIZE) % SIZE
      const xr = (x + 1) % SIZE
      const yu = (y - 1 + SIZE) % SIZE
      const yd = (y + 1) % SIZE
      const dx = (height[y * SIZE + xl] - height[y * SIZE + xr]) * strength
      const dy = (height[yu * SIZE + x] - height[yd * SIZE + x]) * strength
      let nx = dx
      let ny = dy
      let nz = 1
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      nx /= len
      ny /= len
      nz /= len
      normal[i * 4] = Math.round((nx * 0.5 + 0.5) * 255)
      normal[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      normal[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      normal[i * 4 + 3] = 255
    }
  }

  const albedoTex = makeTexture(albedo, true)
  const normalTex = makeTexture(normal, false)
  const roughTex = makeTexture(rough, false)

  return {
    family,
    albedo: albedoTex,
    normal: normalTex,
    roughness: roughTex,
    tileMeters,
    dispose(): void {
      albedoTex.dispose()
      normalTex.dispose()
      roughTex.dispose()
    },
  }
}

/** 启动时烘一次；五族共 15 张 256² 贴图，约 4MB 显存。 */
export function createSurfaceMaps(): Record<SurfaceFamily, SurfaceMaps> {
  return {
    stone: build('stone'),
    wood: build('wood'),
    metal: build('metal'),
    mud: build('mud'),
    foliage: build('foliage'),
  }
}
