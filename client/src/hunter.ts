/**
 * 远端猎人的程序化角色：**有关节的可动骨架**，不是一个身体加两条腿。
 *
 * ## 为什么现在要拆关节
 *
 * 旧版只有"身体 + 左右腿"两个自由度，蹲下靠 `scale.y = 0.72` 整体压扁 ——
 * 滑铲、翻越、跳跃这些动作在压扁的模型上根本表达不出来，远看就是一块
 * 斜着移动的木头。Apex 那套身法的可读性来自**关节角度**（髋、膝、肩、肘、
 * 脊柱），所以先把骨架做对，再谈动作。
 *
 * ## 层级与坐标
 *
 * 原点在脚底、正面朝 -Z（和 yaw 约定一致）。骨架按人体比例：
 *
 *   hips (y=0.94)
 *     ├ spine (y=+0.02)  → 胸/大衣/背包/斜挎带
 *     │   ├ head (y=+0.52)
 *     │   ├ shoulderL/R (x=±0.23, y=+0.46) → elbow → hand
 *     ├ hipL/R (x=±0.12) → knee → foot
 *
 * 每个关节是一个 Group，几何挂在关节原点下方；旋转关节就能摆姿势。
 * 没有蒙皮：分段刚体在 5m 外读起来就是连续的，而且省掉骨骼动画的全部成本。
 *
 * ## 为什么只用两个材质
 *
 * 每个关节一次 draw call 已经够多了。配色全部烘进顶点色，整具身体只留
 * "布料/皮革"和"金属"两个材质，帽带、靴子、枪管靠颜色区分，而不是靠材质。
 */

import { Color, Float32BufferAttribute, Group, Mesh, type BufferGeometry, type Material, type Texture } from 'three'
import { Assembly, blob, box, ring, rodZ } from './weapon-kit.ts'

export interface HunterKit {
  toon(
    color: number,
    options?: {
      hatch?: number
      hatchSpacing?: number
      surface?: 'default' | 'stone' | 'wood' | 'metal' | 'mud' | 'foliage'
      specular?: number
      rim?: number
      map?: Texture
    },
  ): Material
  addInk(mesh: Mesh, pixels?: number): void
}

export interface HunterMaterials {
  /** 布料 / 皮革 / 皮肤 / 头发：全部走顶点色。 */
  readonly body: Material
  /** 金属件：枪管、扣具、鞋钉。 */
  readonly metal: Material
}

export interface HunterTextures {
  readonly cloth: Texture
  readonly leather: Texture
}

export interface HunterModel {
  readonly root: Group
  readonly hips: Group
  readonly spine: Group
  readonly head: Group
  readonly shoulderL: Group
  readonly shoulderR: Group
  readonly elbowL: Group
  readonly elbowR: Group
  readonly hipL: Group
  readonly hipR: Group
  readonly kneeL: Group
  readonly kneeR: Group
  /** 兼容旧调用方：hipL / hipR 的别名。 */
  readonly legL: Group
  readonly legR: Group
  /** 兼容旧调用方。 */
  readonly body: Group
  /** 当前姿势缓存，由 animateHunter 维护。 */
  readonly pose: HunterPoseState
  dispose(): void
}

/** 姿势缓存的键。全部是弧度 / 米。 */
export interface HunterPoseState {
  hipY: number
  spineRx: number
  spineRz: number
  headRx: number
  thighL: number
  thighR: number
  kneeL: number
  kneeR: number
  shoulderLx: number
  shoulderLz: number
  shoulderRx: number
  shoulderRz: number
  elbowL: number
  elbowR: number
}

export interface HunterPoseInput {
  /** 水平速度（m/s）。 */
  speed: number
  grounded: boolean
  sliding: boolean
  crouching: boolean
  sprinting: boolean
  ads: boolean
  /** 翻越进度 0..1；不在翻越时给 -1。 */
  vault: number
  /** 是否在贴墙攀爬。 */
  climbing?: boolean
  /** 步态相位（由调用方按位移累加）。 */
  phase: number
  dt: number
}

const POSE_KEYS: (keyof HunterPoseState)[] = [
  'hipY',
  'spineRx',
  'spineRz',
  'headRx',
  'thighL',
  'thighR',
  'kneeL',
  'kneeR',
  'shoulderLx',
  'shoulderLz',
  'shoulderRx',
  'shoulderRz',
  'elbowL',
  'elbowR',
]

/** 布料/皮革的基础色。全部是 sRGB，paint() 会转进线性空间。 */
const C = {
  cloth: 0x6d6a5c,
  clothDark: 0x4b4a40,
  leather: 0x5a4230,
  leatherDark: 0x3f2e20,
  skin: 0xc49a78,
  hair: 0x2b241d,
  eye: 0x14110e,
  scarf: 0x5f3a2e,
  metal: 0x5a6472,
  wood: 0x5a3a22,
} as const

function paint(geo: BufferGeometry, hex: number): BufferGeometry {
  const color = new Color(hex)
  const count = geo.attributes.position.count
  const arr = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    arr[i * 3] = color.r
    arr[i * 3 + 1] = color.g
    arr[i * 3 + 2] = color.b
  }
  geo.setAttribute('color', new Float32BufferAttribute(arr, 3))
  return geo
}

/** 建一套共享材质。整局只建一次。 */
export function createHunterMaterials(kit: HunterKit, _textures?: HunterTextures): HunterMaterials {
  const body = kit.toon(0xffffff, { hatch: 0.24, specular: 0.03, rim: 0.08 })
  const metal = kit.toon(0xffffff, { hatch: 0.14, surface: 'metal', specular: 0.34, rim: 0.1 })
  // 顶点色承载全部配色：材质底色必须是白，否则颜色会被乘暗。
  ;(body as Material & { vertexColors: boolean }).vertexColors = true
  ;(metal as Material & { vertexColors: boolean }).vertexColors = true
  body.needsUpdate = true
  metal.needsUpdate = true
  return { body, metal }
}

/** 把 Assembly 的合并结果挂成 Mesh，并加墨线壳 / 阴影。 */
function emit(asm: Assembly, parent: Group, mats: Record<string, Material>, kit: Pick<HunterKit, 'addInk'>): void {
  for (const [key, geo] of asm.build()) {
    const material = mats[key]
    if (!material) {
      geo.dispose()
      continue
    }
    const mesh = new Mesh(geo, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    kit.addInk(mesh, 2.4)
  }
}

function joint(parent: Group, x: number, y: number, z = 0): Group {
  const g = new Group()
  g.position.set(x, y, z)
  parent.add(g)
  return g
}

/** 头的几何：颅骨、下颌、鼻、眼、围巾、宽檐帽。 */
function buildHead(asm: Assembly): void {
  asm.add(paint(blob(0.21, 0.24, 0.22, 0.06, 2), C.skin), 'body', { y: 0.11 })
  asm.add(paint(blob(0.13, 0.09, 0.15, 0.03, 1), C.skin), 'body', { y: 0.02, z: -0.03 })
  asm.add(paint(blob(0.055, 0.055, 0.06, 0.02, 1), C.skin), 'body', { y: 0.10, z: -0.115 })
  // 眼窝：两个深色小块。没有眼睛的脸在夜里就是一颗褐色的蛋。
  asm.add(paint(blob(0.045, 0.022, 0.02, 0.005, 1), C.eye), 'body', { x: -0.05, y: 0.15, z: -0.103 })
  asm.add(paint(blob(0.045, 0.022, 0.02, 0.005, 1), C.eye), 'body', { x: 0.05, y: 0.15, z: -0.103 })
  // 下半张脸的围巾 + 后颈的头发。
  asm.add(paint(blob(0.17, 0.09, 0.07, 0.02, 1), C.scarf), 'body', { y: 0.02, z: -0.07 })
  asm.add(paint(blob(0.18, 0.10, 0.16, 0.03, 1), C.hair), 'body', { y: 0.10, z: 0.06 })
  // 宽檐帽：帽檐、帽冠、帽带。
  asm.add(paint(blob(0.62, 0.026, 0.60, 0.01, 1), C.leatherDark), 'body', { y: 0.235 })
  asm.add(paint(blob(0.29, 0.17, 0.29, 0.05, 2), C.leather), 'body', { y: 0.30 })
  asm.add(paint(blob(0.305, 0.032, 0.305, 0.008, 1), C.hair), 'body', { y: 0.265 })
}

/** 躯干：胸、肩、大衣下摆、腰带、斜挎带、背包、横抱的步枪。 */
function buildSpine(asmBody: Assembly, asmMetal: Assembly): void {
  // 胸廓：上宽下窄，剪影才不是一根方柱。
  asmBody.add(paint(blob(0.46, 0.40, 0.28, 0.06, 2), C.cloth), 'body', { y: 0.26 })
  asmBody.add(paint(blob(0.52, 0.16, 0.30, 0.06, 2), C.cloth), 'body', { y: 0.46 })
  // 领口围巾。
  asmBody.add(paint(blob(0.25, 0.12, 0.22, 0.04, 1), C.scarf), 'body', { y: 0.53 })
  // 斜挎弹药带：横过胸口的一条明显的斜线。
  asmBody.add(paint(blob(0.08, 0.62, 0.05, 0.01, 1), C.leatherDark), 'body', { y: 0.30, z: -0.155, rz: 0.62, ry: 0.12 })
  for (let i = 0; i < 4; i++) {
    asmMetal.add(paint(blob(0.035, 0.045, 0.02, 0.006, 1), C.metal), 'metal', {
      x: -0.1 + i * 0.07,
      y: 0.18 + i * 0.08,
      z: -0.185,
      rz: 0.62,
    })
  }
  // 背包 + 铺盖卷。
  asmBody.add(paint(blob(0.30, 0.34, 0.17, 0.04, 1), C.leather), 'body', { y: 0.28, z: 0.19 })
  asmBody.add(paint(rodZ(0.065, 0.065, 0.34, 8, 0.01), C.clothDark), 'body', { y: 0.49, z: 0.23, rz: Math.PI / 2 })
}

function buildHips(asm: Assembly): void {
  // 大衣下摆 + 腰带 + 骨盆。
  asm.add(paint(blob(0.50, 0.34, 0.33, 0.06, 2), C.cloth), 'body', { y: -0.10 })
  asm.add(paint(blob(0.51, 0.075, 0.325, 0.02, 1), C.leather), 'body', { y: 0.03 })
  asm.add(paint(blob(0.30, 0.16, 0.24, 0.04, 1), C.clothDark), 'body', { y: -0.02 })
  // 腰带扣。
  asm.add(paint(box(0.09, 0.06, 0.02, 0.006, 1), C.metal), 'body', { y: 0.03, z: -0.17 })
}

function buildUpperArm(asm: Assembly): void {
  asm.add(paint(blob(0.125, 0.32, 0.135, 0.03, 1), C.cloth), 'body', { y: -0.15 })
}

function buildForearm(asm: Assembly): void {
  asm.add(paint(blob(0.105, 0.28, 0.115, 0.03, 1), C.cloth), 'body', { y: -0.13 })
  // 手套。
  asm.add(paint(blob(0.095, 0.12, 0.115, 0.03, 1), C.leather), 'body', { y: -0.28 })
}

function buildThigh(asm: Assembly): void {
  asm.add(paint(blob(0.17, 0.46, 0.19, 0.04, 1), C.cloth), 'body', { y: -0.23 })
}

function buildShin(asm: Assembly): void {
  asm.add(paint(blob(0.14, 0.38, 0.155, 0.035, 1), C.clothDark), 'body', { y: -0.19 })
  // 靴筒 + 靴头（朝 -Z）。
  asm.add(paint(blob(0.155, 0.16, 0.17, 0.03, 1), C.leather), 'body', { y: -0.35 })
  asm.add(paint(blob(0.155, 0.10, 0.28, 0.035, 1), C.leatherDark), 'body', { y: -0.40, z: -0.05 })
}

/** 横抱在胸前的杠杆步枪：只做剪影。 */
function buildRifle(asmBody: Assembly, asmMetal: Assembly): void {
  asmBody.add(paint(box(0.05, 0.10, 0.30, 0.012, 2), C.wood), 'body', { x: 0.13, y: 0.24, z: 0.10, rx: -0.12 })
  asmMetal.add(paint(box(0.045, 0.075, 0.20, 0.008, 1), C.metal), 'metal', { x: 0.13, y: 0.26, z: -0.12 })
  asmMetal.add(paint(rodZ(0.012, 0.012, 0.56, 8, 0.006), C.metal), 'metal', { x: 0.13, y: 0.28, z: -0.50 })
  asmMetal.add(paint(ring(0.035, 0.0045, 10, 4, Math.PI), C.metal), 'metal', { x: 0.13, y: 0.21, z: -0.08, ry: Math.PI / 2, rz: Math.PI })
}

export function createHunterModel(mats: HunterMaterials, kit: Pick<HunterKit, 'addInk'>): HunterModel {
  const map: Record<string, Material> = { body: mats.body, metal: mats.metal }
  const root = new Group()

  const hips = joint(root, 0, 0.94)
  const spine = joint(hips, 0, 0.02)
  const head = joint(spine, 0, 0.52)

  const shoulderL = joint(spine, -0.23, 0.46)
  const shoulderR = joint(spine, 0.23, 0.46)
  const elbowL = joint(shoulderL, 0, -0.30)
  const elbowR = joint(shoulderR, 0, -0.30)

  const hipL = joint(hips, -0.12, 0)
  const hipR = joint(hips, 0.12, 0)
  const kneeL = joint(hipL, 0, -0.46)
  const kneeR = joint(hipR, 0, -0.46)

  const builders: [Assembly, Group, string][] = []
  const asm = (name: string): Assembly => new Assembly(name)

  // 髋 / 躯干 / 头
  const hipsAsm = asm('hunter-hips')
  buildHips(hipsAsm)
  builders.push([hipsAsm, hips, 'hips'])

  const spineAsm = asm('hunter-spine')
  const spineMetal = asm('hunter-spine-metal')
  buildSpine(spineAsm, spineMetal)
  buildRifle(spineAsm, spineMetal)
  builders.push([spineAsm, spine, 'spine'], [spineMetal, spine, 'spine-metal'])

  const headAsm = asm('hunter-head')
  buildHead(headAsm)
  builders.push([headAsm, head, 'head'])

  // 手臂
  const upperL = asm('hunter-uparm-l')
  buildUpperArm(upperL)
  builders.push([upperL, shoulderL, 'uparm-l'])
  const foreL = asm('hunter-forearm-l')
  buildForearm(foreL)
  builders.push([foreL, elbowL, 'forearm-l'])
  const upperR = asm('hunter-uparm-r')
  buildUpperArm(upperR)
  builders.push([upperR, shoulderR, 'uparm-r'])
  const foreR = asm('hunter-forearm-r')
  buildForearm(foreR)
  builders.push([foreR, elbowR, 'forearm-r'])

  // 腿
  const thighLAsm = asm('hunter-thigh-l')
  buildThigh(thighLAsm)
  builders.push([thighLAsm, hipL, 'thigh-l'])
  const shinLAsm = asm('hunter-shin-l')
  buildShin(shinLAsm)
  builders.push([shinLAsm, kneeL, 'shin-l'])
  const thighRAsm = asm('hunter-thigh-r')
  buildThigh(thighRAsm)
  builders.push([thighRAsm, hipR, 'thigh-r'])
  const shinRAsm = asm('hunter-shin-r')
  buildShin(shinRAsm)
  builders.push([shinRAsm, kneeR, 'shin-r'])

  for (const [assembly, parent] of builders) emit(assembly, parent, map, kit)

  const pose: HunterPoseState = {
    hipY: 0.94,
    spineRx: 0,
    spineRz: 0,
    headRx: 0,
    thighL: 0,
    thighR: 0,
    kneeL: 0,
    kneeR: 0,
    shoulderLx: 0,
    shoulderLz: 0,
    shoulderRx: 0,
    shoulderRz: 0,
    elbowL: 0,
    elbowR: 0,
  }

  return {
    root,
    hips,
    spine,
    head,
    shoulderL,
    shoulderR,
    elbowL,
    elbowR,
    hipL,
    hipR,
    kneeL,
    kneeR,
    legL: hipL,
    legR: hipR,
    body: spine,
    pose,
    dispose(): void {
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
      root.clear()
    },
  }
}

/** 指数逼近：dt 变化时收敛比例一致，60Hz 与 144Hz 看起来一样。 */
function converge(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

/**
 * 每帧摆姿势。
 *
 * 所有目标角度都是"这个动作在视频里应该长什么样"的直接翻译，没有物理：
 * 滑铲是前腿伸出、后腿收起、上身反弓；翻越是一手撑、双腿收、身体越过障碍。
 * 平滑用指数逼近，动作之间不会有生硬的切换。
 */
export function animateHunter(model: HunterModel, input: HunterPoseInput): void {
  const p = model.pose
  const speed = input.speed
  const moving = speed > 0.25
  const run = Math.min(1, speed / 7)
  const swing = Math.sin(input.phase)
  const lift = Math.max(0, Math.sin(input.phase))

  // 基础目标
  let hipY = 0.94
  let spineRx = 0
  let spineRz = 0
  let headRx = 0
  let thighL = 0
  let thighR = 0
  let kneeL = 0
  let kneeR = 0
  let shoulderLx = 0.12
  let shoulderLz = 0.16
  let shoulderRx = 0.16
  let shoulderRz = -0.14
  let elbowL = 0.38
  let elbowR = 0.42

  if (input.climbing) {
    // 攀爬：双手举过头顶抓墙，膝盖收起，身体贴近墙面。
    hipY = 0.88
    spineRx = -0.12
    headRx = 0.22
    thighL = 0.55
    thighR = 0.35
    kneeL = -1.5
    kneeR = -1.2
    shoulderLx = 2.85
    shoulderLz = 0.18
    shoulderRx = 2.7
    shoulderRz = -0.18
    elbowL = 0.35
    elbowR = 0.4
  } else if (input.sliding) {
    // 滑铲：髋压到 0.5m，前腿（右）贴地伸出，后腿收起，上身反弓，
    // 双臂向两侧张开保持平衡。这是滑铲与"蹲着跑"最直观的区别。
    hipY = 0.50
    spineRx = -0.46
    spineRz = 0.08
    headRx = 0.34
    thighR = 1.15
    kneeR = -0.22
    thighL = -0.30
    kneeL = -1.75
    shoulderLx = 0.55
    shoulderLz = 0.95
    shoulderRx = 0.35
    shoulderRz = -0.85
    elbowL = 0.75
    elbowR = 0.6
  } else if (input.vault >= 0) {
    // 翻越：手臂前撑、双腿收起、身体先抬后落。进度 t 驱动，和位移同步。
    const t = Math.min(1, Math.max(0, input.vault))
    const arc = Math.sin(t * Math.PI)
    hipY = 0.94 + arc * 0.34
    spineRx = 0.55 * (1 - Math.abs(t - 0.5) * 2) + 0.12
    headRx = -0.2
    thighL = 1.05 - t * 0.4
    thighR = 1.25 - t * 0.5
    kneeL = -2.1 + t * 0.6
    kneeR = -1.95 + t * 0.5
    shoulderLx = 2.15
    shoulderLz = 0.28
    shoulderRx = 2.0
    shoulderRz = -0.22
    elbowL = 0.35
    elbowR = 0.4
  } else if (!input.grounded) {
    // 空中：前腿收、后腿拖，手臂上抬。跳跃和坠落共用，靠速度区分不了。
    spineRx = 0.08
    thighL = 0.55
    thighR = -0.18
    kneeL = -0.85
    kneeR = -0.35
    shoulderLx = 0.55
    shoulderLz = 0.32
    shoulderRx = 0.45
    shoulderRz = -0.3
    elbowL = 0.75
    elbowR = 0.8
  } else if (input.crouching) {
    // 蹲：髋降 0.3m，双膝前折，上身微前倾。
    hipY = 0.64
    spineRx = 0.22
    headRx = -0.1
    thighL = 1.05
    thighR = 1.0
    kneeL = -1.9
    kneeR = -1.85
    shoulderLx = 0.6
    shoulderLz = 0.2
    shoulderRx = 0.5
    shoulderRz = -0.18
    elbowL = 0.9
    elbowR = 0.85
  } else if (input.ads) {
    // 开镜：双臂抬到胸前，头压低找瞄具。
    spineRx = 0.06
    headRx = 0.12
    thighL = 0.02
    thighR = -0.02
    kneeL = -0.05
    kneeR = -0.05
    shoulderLx = 1.05
    shoulderLz = 0.42
    shoulderRx = 1.15
    shoulderRz = -0.36
    elbowL = 1.55
    elbowR = 1.6
  } else if (moving) {
    // 走 / 跑：腿反相摆动，手臂反向摆，躯干前倾 + 上下起伏。
    const amp = 0.42 * run + 0.2
    const armAmp = 0.55 * run + 0.25
    const crouchRun = input.sprinting ? 0.16 : 0.06
    hipY = 0.94 + Math.abs(swing) * 0.035 * run
    spineRx = crouchRun + 0.05 * run
    spineRz = -swing * 0.045 * run
    headRx = -crouchRun * 0.5
    thighL = swing * amp
    thighR = -swing * amp
    kneeL = -Math.max(0, -swing) * 0.95 - lift * 0.25
    kneeR = -Math.max(0, swing) * 0.95 - lift * 0.25
    shoulderLx = -swing * armAmp + 0.12
    shoulderRx = swing * armAmp + 0.12
    elbowL = 0.45 + run * 0.45
    elbowR = 0.5 + run * 0.45
  } else {
    // 站立：呼吸起伏 + 肩膀轻微不对称。
    hipY = 0.94 + Math.sin(input.phase * 0.6) * 0.006
    shoulderLx = 0.12 + Math.sin(input.phase * 0.6) * 0.02
    shoulderRx = 0.16 + Math.sin(input.phase * 0.6 + 1.1) * 0.02
  }

  // 平滑：动作切换用 0.09s 的时间常数，够快但不闪。
  const tau = 0.09
  const k = 1 - Math.exp(-Math.max(0, input.dt) / tau)
  const set = (key: keyof HunterPoseState, target: number): void => {
    p[key] += (target - p[key]) * k
  }
  p.hipY += (hipY - p.hipY) * k
  set('spineRx', spineRx)
  set('spineRz', spineRz)
  set('headRx', headRx)
  set('thighL', thighL)
  set('thighR', thighR)
  set('kneeL', kneeL)
  set('kneeR', kneeR)
  set('shoulderLx', shoulderLx)
  set('shoulderLz', shoulderLz)
  set('shoulderRx', shoulderRx)
  set('shoulderRz', shoulderRz)
  set('elbowL', elbowL)
  set('elbowR', elbowR)

  // 写回骨架
  model.hips.position.y = p.hipY
  model.spine.rotation.x = p.spineRx
  model.spine.rotation.z = p.spineRz
  model.head.rotation.x = p.headRx
  model.hipL.rotation.x = p.thighL
  model.hipR.rotation.x = p.thighR
  model.kneeL.rotation.x = p.kneeL
  model.kneeR.rotation.x = p.kneeR
  model.shoulderL.rotation.x = p.shoulderLx
  model.shoulderL.rotation.z = p.shoulderLz
  model.shoulderR.rotation.x = p.shoulderRx
  model.shoulderR.rotation.z = p.shoulderRz
  model.elbowL.rotation.x = p.elbowL
  model.elbowR.rotation.x = p.elbowR
}

/** 供外部重置姿势（复活/传送时避免从滑铲姿势慢慢爬起来）。 */
export function resetHunterPose(model: HunterModel): void {
  for (const key of POSE_KEYS) {
    if (key === 'hipY') model.pose[key] = 0.94
    else model.pose[key] = 0
  }
}
