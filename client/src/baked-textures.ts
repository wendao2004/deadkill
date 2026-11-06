/**
 * 浏览器内烘焙的角色细节贴图。
 *
 * 为什么烘焙而不是继续全程序化：
 * - 角色的布料/皮革需要**小尺度、方向稳定**的纹理（经纬、褶皱、缝线）。
 *   用世界空间噪声做，衣服一动纹路就跟着"游"，而且每个角色都要算一遍；
 * - 启动时在 128×128 的 Canvas 里烘焙一次，之后只是一张普通贴图，由
 *   MeshToonMaterial 的漫反射采样，运行时零额外 ALU。
 *
 * 这张图是**灰度细节**（0.7~1.0），材质的 `color` 仍然负责色相；所以同一张
 * 布料图可以给外套、裤子、背包用不同颜色，不需要为每个颜色重新烘一张。
 *
 * 注意：这是运行时烘焙，不是导入外部美术资源。要搬到别的引擎，可以把
 * canvas 导出成 PNG/KTX2；在当前 Web 端直接作为 CanvasTexture 用。
 */
import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three'

export interface HunterTextures {
  readonly cloth: Texture
  readonly leather: Texture
  /** 枪身钢件：拉丝、划痕、凹坑的灰度细节。 */
  readonly metal: Texture
  /** 枪身木件：木纹、棕眼、清漆深浅。 */
  readonly wood: Texture
  dispose(): void
}

/** 32-bit 整数哈希 → 0..1。确定性，不依赖 Math.random。 */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

/** 低成本 value noise：4 个角哈希 + smoothstep。 */
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

function makeTexture(size: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文')
  paint(ctx, size)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.repeat.set(2, 2)
  texture.minFilter = LinearMipmapLinearFilter
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

/**
 * 布料：经纬 + 不均匀褪色 + 污渍 + 缝合线。
 *
 * 灰度范围压在 0.72~1.0：再暗会把外套压成一团黑，除非材质本身很亮。
 */
function paintCloth(ctx: CanvasRenderingContext2D, size: number): void {
  const img = ctx.createImageData(size, size)
  const data = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const macro = noise2(x / 22, y / 22, 11)
      const milli = noise2(x / 5, y / 5, 37)
      // 经纬：每 3 像素一道很浅的明暗，避免细到摩尔纹。
      const weave = (x % 3 === 0 ? -5 : 0) + (y % 3 === 0 ? -4 : 0)
      // 大块污渍：低频噪声低于阈值时压暗。
      const stain = noise2(x / 30, y / 30, 71) < 0.34 ? -18 : 0
      let v = 208 + (macro - 0.5) * 24 + (milli - 0.5) * 12 + weave + stain
      v = Math.max(176, Math.min(246, v))
      const i = (y * size + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  // 缝合线：一条竖线一条横线，颜色略深；不是网格，避免整件衣服像桌布。
  ctx.strokeStyle = 'rgba(110, 102, 88, 0.55)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(size * 0.18, 0)
  ctx.lineTo(size * 0.18, size)
  ctx.moveTo(0, size * 0.72)
  ctx.lineTo(size, size * 0.72)
  ctx.stroke()
  // 针脚：沿竖线一小段一小段。
  ctx.strokeStyle = 'rgba(70, 66, 58, 0.5)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let y = 0; y < size; y += 7) {
    ctx.moveTo(size * 0.18 - 2, y)
    ctx.lineTo(size * 0.18 + 2, y)
  }
  ctx.stroke()
}

/** 皮革：斑驳底色 + 褶皱纹 + 边缘缝线。 */
function paintLeather(ctx: CanvasRenderingContext2D, size: number): void {
  const img = ctx.createImageData(size, size)
  const data = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const macro = noise2(x / 18, y / 18, 3)
      const grain = noise2(x / 3, y / 3, 19)
      const pit = hash2(x, y, 53) < 0.06 ? -22 : 0
      let v = 190 + (macro - 0.5) * 34 + (grain - 0.5) * 16 + pit
      v = Math.max(150, Math.min(232, v))
      const i = (y * size + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  // 褶皱：几条低透明度的弧线，方向不一致。
  ctx.strokeStyle = 'rgba(96, 74, 56, 0.4)'
  ctx.lineWidth = 1.2
  for (let i = 0; i < 7; i++) {
    const x0 = hash2(i, 3, 9) * size
    const y0 = hash2(i, 7, 9) * size
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.quadraticCurveTo(
      x0 + (hash2(i, 11, 9) - 0.5) * size * 0.5,
      y0 + (hash2(i, 13, 9) - 0.5) * size * 0.5,
      x0 + (hash2(i, 17, 9) - 0.5) * size,
      y0 + (hash2(i, 19, 9) - 0.5) * size,
    )
    ctx.stroke()
  }
  // 边缘的双排缝线。
  ctx.strokeStyle = 'rgba(58, 46, 34, 0.6)'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.strokeRect(5.5, 5.5, size - 11, size - 11)
  ctx.strokeRect(10.5, 10.5, size - 21, size - 21)
  ctx.setLineDash([])
}

/** 枪钢：沿一个方向拉丝 + 稀疏划痕 + 微小凹坑。 */
function paintGunMetal(ctx: CanvasRenderingContext2D, size: number): void {
  const img = ctx.createImageData(size, size)
  const data = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 拉丝：x 高频、y 低频。
      const brush = noise2(x / 2.2, y / 24, 17) * 0.6 + noise2(x / 9, y / 3, 41) * 0.4
      const pit = hash2(x, y, 73) < 0.035 ? -26 : 0
      const scratch = hash2(Math.floor(x / 1.5), Math.floor(y / 24), 91) < 0.02 ? 18 : 0
      let v = 176 + (brush - 0.5) * 34 + pit + scratch
      v = Math.max(132, Math.min(224, v))
      const i = (y * size + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

/** 枪木：沿 x 的胡桃木纹 + 棕眼 + 清漆深浅。 */
function paintGunWood(ctx: CanvasRenderingContext2D, size: number): void {
  const img = ctx.createImageData(size, size)
  const data = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const warp = noise2(x / 30, y / 9, 5)
      const grain = noise2(x / 3.5, y / 1.6 + warp * 5, 23)
      const pore = hash2(x, y, 61) < 0.045 ? -22 : 0
      let v = 178 + (grain - 0.5) * 40 + (warp - 0.5) * 18 + pore
      v = Math.max(132, Math.min(222, v))
      const i = (y * size + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

export function createHunterTextures(): HunterTextures {
  const cloth = makeTexture(128, paintCloth)
  const leather = makeTexture(128, paintLeather)
  const metal = makeTexture(128, paintGunMetal)
  const wood = makeTexture(128, paintGunWood)
  // 枪件贴图是**乘性细节**，不是颜色贴图：按 NoColorSpace 取样，0.7 就是
  // 线性 0.7；按 sRGB 解码会掉到 0.45，整把枪会黑成一团。
  metal.colorSpace = NoColorSpace
  wood.colorSpace = NoColorSpace
  // 枪件比布料小得多，贴图重复两档才有细节。
  metal.repeat.set(3, 3)
  wood.repeat.set(1.5, 2.5)
  return {
    cloth,
    leather,
    metal,
    wood,
    dispose(): void {
      cloth.dispose()
      leather.dispose()
      metal.dispose()
      wood.dispose()
    },
  }
}
