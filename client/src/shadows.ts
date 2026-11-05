/**
 * 接地阴影：一张径向渐变的软圆片。
 *
 * 项目关掉了 shadowMap（卡通平涂 + 弱 GPU 的取舍），代价是箱子和角色像
 * "贴"在地上而不是站在地上。这里用一张 1 个 draw call 的贴地黑片补回接触感：
 * 只对角色/怪物/可搜物这类"需要读高度"的东西用，不给全部关卡盒刷铺。
 */
import { CanvasTexture, MeshBasicMaterial, PlaneGeometry, type Texture } from 'three'

/** 64×64 的径向衰减；中心不纯黑，避免在泥地上压出一个硬洞。 */
export function createShadowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(32, 32, 3, 32, 32, 31)
  gradient.addColorStop(0, 'rgba(0,0,0,0.82)')
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.46)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  const texture = new CanvasTexture(canvas)
  texture.needsUpdate = true
  return texture
}

export const SHADOW_GEOMETRY = /* @__PURE__ */ (() => {
  const geo = new PlaneGeometry(1, 1)
  geo.rotateX(-Math.PI / 2)
  return geo
})()

export function createShadowMaterial(texture: Texture, opacity = 0.5): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map: texture,
    color: 0x000000,
    transparent: true,
    opacity,
    depthWrite: false,
  })
}
