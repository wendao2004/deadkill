/**
 * 弹孔贴花：打在墙/地/箱子上的持久落点。
 *
 * ## 为什么要有它
 *
 * 粒子是"这一瞬间发生了什么"，贴花是"刚才那枪打在哪"。没有贴花的射击游戏，
 * 玩家打完一梭子只能从声音判断落点；有了贴花，墙上的孔会连成一条线，玩家
 * 能自己读出"我一直在往右偏"。这是最便宜、也最有效的射击手感反馈之一。
 *
 * ## 为什么按材质分池而不是一张图集
 *
 * 每个 ImpactKind 一张 128² 的 canvas 贴图，各自一个 InstancedMesh。代价是
 * 5 个 draw call（空池时 visible=false，一枪都不开就是 0），换来的是：
 * 不需要在图集里做 per-instance UV（three 的内置材质做不到），也不需要写
 * 自定义 shader。`vfx.ts` 的粒子已经证明了自定义 instanced shader 可行，
 * 但贴花没有逐帧动画，用内置材质能少一整条需要维护的 GLSL。
 *
 * ## 为什么法线必须从关卡推断
 *
 * 协议里没有命中法线。贴花如果永远面向 shooter（用 -dir 当法线），打地板时
 * 会得到一块立起来的方片，打斜墙时会浮在半空。`surfaces.ts` 的
 * `surfaceNormalAt` 从盒刷数据里反推出真实朝向，零协议成本。
 *
 * ## 生命周期
 *
 * 42 秒后回收，最后 2.5 秒按剩余寿命缩小到 0（不是淡出：内置材质没有
 * per-instance alpha，缩小是唯一不写 shader 的消失方式）。池是环形的：
 * 池满时覆盖最老的一格，永远不会增长。
 */

import {
  CanvasTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Scene,
} from 'three'

import type { Vec3 } from '@dk/shared'
import type { ImpactKind } from './vfx.ts'

/** 每类贴花的池大小。总数 84 个实例，5 个 draw call。 */
const CAPACITY: Record<ImpactKind, number> = {
  stone: 20,
  wood: 20,
  metal: 16,
  mud: 16,
  flesh: 12,
}

/** 贴花存活时间（秒）。短于 30s 会让玩家走回原地时"痕迹没了"。 */
const LIFETIME = 42
/** 最后多少秒开始缩小。 */
const FADE = 2.5

interface Slot {
  active: boolean
  age: number
  /** 生成时定下的尺寸（米）。 */
  size: number
  /** 绕法线的随机旋转，避免一墙的孔排成同一个方向。 */
  roll: number
  px: number
  py: number
  pz: number
  nx: number
  ny: number
  nz: number
}

export interface Decals {
  spawn(point: Vec3, normal: Vec3, kind: ImpactKind): void
  update(dt: number): void
  dispose(): void
}

/** 确定性哈希：同一串射击永远得到同一组尺寸/角度，截图可复现。 */
function hash(index: number): number {
  let n = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b)
  n ^= n >>> 13
  n = Math.imul(n, 0xc2b2ae35)
  n ^= n >>> 16
  return (n >>> 0) / 4294967296
}

const SIZE = 128

/**
 * 程序化贴花图。全部用 2D canvas 画：CSP 禁止外链图片，且只有 5 张 128²
 * 的图，运行时生成的成本远低于引入一条贴图资源管线。
 *
 * 读者会注意到的只有三件事：中心够黑、边缘是撕开的而不是圆的、周围有
 * 飞溅。所以每种材质都按这个结构画，只换颜色和飞溅形状。
 */
function makeTexture(kind: ImpactKind): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文')

  const palette = {
    stone: { core: 'rgba(8,8,9,0.92)', edge: 'rgba(150,148,138,0.34)', fly: 'rgba(120,118,110,0.45)' },
    wood: { core: 'rgba(18,12,7,0.92)', edge: 'rgba(176,142,98,0.38)', fly: 'rgba(92,62,32,0.62)' },
    metal: { core: 'rgba(6,7,9,0.94)', edge: 'rgba(255,220,150,0.50)', fly: 'rgba(196,202,214,0.45)' },
    mud: { core: 'rgba(14,12,8,0.80)', edge: 'rgba(96,104,82,0.32)', fly: 'rgba(34,29,19,0.66)' },
    flesh: { core: 'rgba(104,9,6,0.92)', edge: 'rgba(168,34,24,0.45)', fly: 'rgba(132,16,10,0.74)' },
  }[kind]

  const cx = SIZE / 2
  const cy = SIZE / 2
  const seed = { stone: 11, wood: 23, metal: 37, mud: 51, flesh: 67 }[kind]
  let seq = seed

  const rnd = (): number => {
    seq++
    return hash(seq)
  }

  // 中心的不规则弹坑：18 个顶点的多边形，半径在 0.45..1 之间抖。
  const base = SIZE * 0.23
  ctx.beginPath()
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2
    const r = base * (0.45 + rnd() * 0.65)
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fillStyle = palette.core
  ctx.fill()

  // 外圈撕裂边：同心的低透明度环，靠不规则半径读成"崩开的漆面"。
  ctx.strokeStyle = palette.edge
  ctx.lineWidth = 2.2
  ctx.beginPath()
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2
    const r = base * (1.05 + rnd() * 0.55)
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()

  // 放射状裂纹/木刺/金属刮痕：六到十根，长度与角度都来自哈希。
  const rays = kind === 'wood' ? 10 : kind === 'metal' ? 8 : 6
  ctx.strokeStyle = palette.fly
  for (let i = 0; i < rays; i++) {
    const a = rnd() * Math.PI * 2
    const inner = base * (0.8 + rnd() * 0.5)
    const outer = base * (1.5 + rnd() * 1.5)
    const kink = (rnd() - 0.5) * 0.4
    ctx.lineWidth = 0.8 + rnd() * 1.6
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
    ctx.lineTo(cx + Math.cos(a + kink) * outer, cy + Math.sin(a + kink) * outer)
    ctx.stroke()
  }

  // 飞溅点：血/泥最多，金属最少（金属是火花，不是液体）。
  const drops = kind === 'flesh' ? 14 : kind === 'mud' ? 12 : kind === 'stone' ? 8 : kind === 'wood' ? 8 : 5
  ctx.fillStyle = palette.fly
  for (let i = 0; i < drops; i++) {
    const a = rnd() * Math.PI * 2
    const r = base * (1.1 + rnd() * 2.2)
    const size = 1.2 + rnd() * 3.4
    ctx.beginPath()
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, size, 0, Math.PI * 2)
    ctx.fill()
  }

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** 世界空间的 +Z，用来把平面从"朝 +Z"转到命中法线。 */
const FORWARD = new Vector3(0, 0, 1)

/**
 * 建一套贴花池。返回的对象只做三件事：spawn / update / dispose。
 *
 * `scene` 只用来挂根节点；贴花不参与物理、不参与判定，也无法被子弹打掉。
 */
export function createDecals(scene: Scene): Decals {
  const root = new Group()
  root.name = 'decals'
  scene.add(root)

  const geometry = new PlaneGeometry(1, 1)
  const kinds = Object.keys(CAPACITY) as ImpactKind[]
  const pools = new Map<
    ImpactKind,
    {
      mesh: InstancedMesh
      slots: Slot[]
      cursor: number
      texture: CanvasTexture
    }
  >()

  for (const kind of kinds) {
    const texture = makeTexture(kind)
    const material = new MeshBasicMaterial({
      map: texture,
      // 贴花是半透明墨点：不写深度，避免后画的贴花被先画的挡掉。
      transparent: true,
      depthWrite: false,
      // 贴在表面上会与墙面 z-fighting；偏移交给 polygonOffset，比沿法线
      // 抬 1cm 可靠（抬多了会在斜面露出缝）。
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: DoubleSide,
      // 雾必须开：不然 40m 外的弹孔会比墙本身更清楚。
      fog: true,
      alphaTest: 0.02,
    })
    const mesh = new InstancedMesh(geometry, material, CAPACITY[kind])
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    mesh.visible = false
    root.add(mesh)
    const slots: Slot[] = []
    for (let i = 0; i < CAPACITY[kind]; i++) {
      slots.push({
        active: false,
        age: 0,
        size: 0,
        roll: 0,
        px: 0,
        py: 0,
        pz: 0,
        nx: 0,
        ny: 1,
        nz: 0,
      })
    }
    pools.set(kind, { mesh, slots, cursor: 0, texture })
  }

  // 每帧复用的临时对象：贴花更新在渲染循环里，不能每帧 new。
  const normal = new Vector3()
  const position = new Vector3()
  const scale = new Vector3()
  const quaternion = new Quaternion()
  const rollQuat = new Quaternion()
  const matrix = new Matrix4()
  let spawnSeq = 0

  const spawn = (point: Vec3, surfaceNormal: Vec3, kind: ImpactKind): void => {
    const pool = pools.get(kind)
    if (!pool) return
    const slot = pool.slots[pool.cursor]!
    pool.cursor = (pool.cursor + 1) % pool.slots.length

    normal.set(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z)
    if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0)
    normal.normalize()

    const roll = hash(spawnSeq * 7 + 3) * Math.PI * 2
    spawnSeq++

    slot.active = true
    slot.age = 0
    slot.size = (kind === 'metal' ? 0.2 : kind === 'flesh' ? 0.5 : 0.36) * (0.75 + hash(spawnSeq * 13) * 0.5)
    slot.roll = roll
    slot.px = point.x + normal.x * 0.012
    slot.py = point.y + normal.y * 0.012
    slot.pz = point.z + normal.z * 0.012
    slot.nx = normal.x
    slot.ny = normal.y
    slot.nz = normal.z
  }

  const update = (dt: number): void => {
    for (const pool of pools.values()) {
      const { mesh, slots } = pool
      let count = 0
      for (const slot of slots) {
        if (!slot.active) continue
        slot.age += dt
        if (slot.age >= LIFETIME) {
          slot.active = false
          continue
        }
        const remaining = LIFETIME - slot.age
        const fade = remaining < FADE ? remaining / FADE : 1
        const size = slot.size * fade

        normal.set(slot.nx, slot.ny, slot.nz)
        position.set(slot.px, slot.py, slot.pz)
        quaternion.setFromUnitVectors(FORWARD, normal)
        rollQuat.setFromAxisAngle(FORWARD, slot.roll)
        quaternion.multiply(rollQuat)
        scale.set(size, size, size)
        matrix.compose(position, quaternion, scale)
        mesh.setMatrixAt(count, matrix)
        count++
      }
      mesh.count = count
      mesh.visible = count > 0
      if (count > 0) mesh.instanceMatrix.needsUpdate = true
    }
  }

  const dispose = (): void => {
    for (const pool of pools.values()) {
      pool.mesh.dispose()
      const material = pool.mesh.material as MeshBasicMaterial
      material.dispose()
      pool.texture.dispose()
    }
    geometry.dispose()
    root.removeFromParent()
    pools.clear()
  }

  return { spawn, update, dispose }
}
