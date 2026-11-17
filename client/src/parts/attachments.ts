/**
 * 配件模型（分件）。
 *
 * 约定（与 weapon-models 一致）：
 * - 原点在安装面，−Z 指向枪口，+Y 向上；挂到枪的局部空间里就能对齐。
 * - 不创建材质：只吃 `WeaponMaterialSet`，由 render.ts 统一登记与释放。
 * - 每个 builder 内部用 Assembly 按材质合并，一件配件 2~4 个 draw call。
 *
 * 为什么单独一个目录：配件是"可拆的资产"，它的存在周期比某一把枪长。
 * 军械库工作台与局内第一人称共用这里的同一个 builder，避免出现
 * "工作台好看、局里不像同一把枪"。
 */

import { Group, Mesh } from 'three'
import type { BufferGeometry, Material } from 'three'
import { Assembly, box, latheZ, ring, tubeZ } from '../weapon-kit.ts'
import type { WeaponMaterialSet } from '../weapon-models.ts'

/** 与 weapon-models 的照门/准星同高（米）。光学镜必须落在这条线上。 */
const SIGHT_Y = 0.026

function materialMap(mats: WeaponMaterialSet): Record<string, Material> {
  return {
    steel: mats.steel,
    darkSteel: mats.darkSteel,
    brass: mats.brass,
    sight: mats.sight,
    bore: mats.bore,
  }
}

function emit(asm: Assembly, parent: Group, mats: Record<string, Material>): void {
  for (const [key, geo] of asm.build()) {
    const mat = mats[key]
    if (!mat) {
      geo.dispose()
      continue
    }
    const mesh = new Mesh(geo, mat)
    mesh.castShadow = false
    parent.add(mesh)
  }
}

/** 释放一个配件组：几何与 Mesh 一起丢掉（材质是共享的，不在这里释放）。 */
export function disposePart(group: Group): void {
  group.traverse((node) => {
    if (node instanceof Mesh) (node.geometry as BufferGeometry).dispose()
  })
  group.clear()
}

/* ==========================================================================
 * 枪口：制退器
 * ========================================================================== */

/**
 * 制退器：套在枪口前的一段粗管，两侧开三道排气口。
 *
 * 没有布尔运算，排气口用"贴上去的深色凹槽 + 外圈钢边"表达 —— 在 0.4m 的
 * 观察距离上，真正读出来的是**侧面有节奏的暗块**，不是真的洞。
 */
export function createMuzzleBrake(mats: WeaponMaterialSet, muzzleZ: number): Group {
  const group = new Group()
  group.name = 'muzzle-brake'
  const M = materialMap(mats)
  const asm = new Assembly('muzzle-brake')
  const len = 0.085

  const body = tubeZ(0.0142, 0.0132, len, 14, 0.0006)
  asm.add(body, 'darkSteel', { y: 0.004, z: muzzleZ - len / 2 - 0.006 })
  body.dispose()

  // 锁紧环：贴在枪口后方的一圈亮钢，说明"这是一个拧上去的件"。
  const collar = ring(0.0152, 0.0022, 16, 6)
  asm.add(collar, 'steel', { y: 0.004, z: muzzleZ + 0.004, rx: Math.PI / 2 })
  collar.dispose()

  // 三道排气口：两侧各一块深色凹槽 + 一条细钢唇边。
  for (let i = 0; i < 3; i++) {
    const z = muzzleZ - 0.018 - i * 0.021
    asm.addMirrored(box(0.004, 0.009, 0.014, 0.0006, 1), 'bore', { x: 0.0122, y: 0.004, z })
    asm.addMirrored(box(0.0022, 0.012, 0.017, 0.0005, 1), 'steel', { x: 0.0132, y: 0.004, z })
  }
  // 顶部泄气槽：从上方看是一条断续的暗线。
  asm.add(box(0.014, 0.003, 0.052, 0.0006, 1), 'bore', { y: 0.0175, z: muzzleZ - 0.042 })

  // 前端面：内孔 + 一圈倒角，正面看是"洞"而不是一根实心管。
  const cap = latheZ(
    [
      [0, 0.0138],
      [0.004, 0.0142],
      [0.008, 0.0132],
      [0.014, 0.0128],
    ],
    16,
  )
  asm.add(cap, 'steel', { y: 0.004, z: muzzleZ - len - 0.004 })
  cap.dispose()

  emit(asm, group, M)
  return group
}

/* ==========================================================================
 * 供弹：加长弹仓 / 快装弹仓
 * ========================================================================== */

/**
 * 加长弹仓：管式弹仓向前伸出护木，端帽 + 两道卡箍。
 *
 * `forward` 是相对于原厂弹仓前端的额外长度（米）。快装弹仓用同样的形状，
 * 但更短、卡箍更靠前（换弹时手掌更好发力）。
 */
export function createMagazineTube(
  mats: WeaponMaterialSet,
  options: { forendZ: number; muzzleZ: number; extension: number },
): Group {
  const group = new Group()
  group.name = 'magazine-tube'
  const M = materialMap(mats)
  const asm = new Assembly('magazine-tube')
  const front = options.muzzleZ + 0.075 - options.extension
  const back = options.forendZ + 0.115
  const len = Math.max(0.10, back - front)
  const y = -0.021

  const tube = tubeZ(0.0104, 0.0104, len, 12, 0.0004)
  asm.add(tube, 'darkSteel', { y, z: (front + back) / 2 })
  tube.dispose()

  // 两道卡箍：把弹仓管和枪管绑在一起，近看能读出"这是延长件"。
  for (const z of [front + 0.05, back - 0.03]) {
    const band = ring(0.0118, 0.0022, 14, 6)
    asm.add(band, 'steel', { y, z, rx: Math.PI / 2 })
    band.dispose()
    asm.add(box(0.006, 0.016, 0.008, 0.0008, 1), 'steel', { x: 0.0, y: y + 0.012, z })
  }

  // 端帽：前端一个略粗的黄铜帽，和枪口形成两个不同直径的圆。
  const cap = latheZ(
    [
      [0, 0.0104],
      [0.002, 0.0116],
      [0.010, 0.0116],
      [0.012, 0.0104],
    ],
    14,
  )
  asm.add(cap, 'brass', { y, z: front + 0.004 })
  cap.dispose()

  emit(asm, group, M)
  return group
}

/* ==========================================================================
 * 枪托：加固托 / 轻量托
 * ========================================================================== */

/**
 * 枪托变体。挂在 `rig.stock` 上，和原厂托共用同一套 ADS 隐藏逻辑。
 *
 * - heavy：颊托垫高、托底板加厚、多一颗背带环 —— 数值上"后坐更小、更重"。
 * - light：削薄托底、挖两个减重孔（用深色内嵌片表达）、去颊托 —— "更轻、后坐更大"。
 */
export function createStockVariant(mats: WeaponMaterialSet, kind: 'heavy' | 'light'): Group {
  const group = new Group()
  group.name = `stock-${kind}`
  const M = materialMap(mats)
  const asm = new Assembly(`stock-${kind}`)

  if (kind === 'heavy') {
    // 颊托：一块压在托背上的木块，前沿倒角。
    asm.add(box(0.030, 0.020, 0.115, 0.004, 2), 'wood', { x: 0.0, y: 0.043, z: 0.148 })
    // 托底板：加厚 6mm 的钢制底板 + 两颗螺钉。
    asm.add(box(0.034, 0.062, 0.010, 0.003, 2), 'darkSteel', { y: -0.006, z: 0.238 })
    asm.add(box(0.030, 0.052, 0.004, 0.0015, 1), 'steel', { y: -0.006, z: 0.244 })
    asm.add(box(0.004, 0.004, 0.004, 0.001, 1), 'brass', { x: 0.012, y: 0.018, z: 0.244 })
    asm.add(box(0.004, 0.004, 0.004, 0.001, 1), 'brass', { x: -0.012, y: 0.018, z: 0.244 })
    // 背带环。
    const loop = ring(0.011, 0.0022, 12, 6)
    asm.add(loop, 'steel', { y: -0.040, z: 0.198, ry: Math.PI / 2 })
    loop.dispose()
  } else {
    // 轻量托：托底削薄，两侧减重孔用深色内嵌表示。
    asm.add(box(0.030, 0.048, 0.008, 0.002, 2), 'darkSteel', { y: -0.010, z: 0.236 })
    asm.addMirrored(box(0.003, 0.022, 0.048, 0.0015, 1), 'bore', { x: 0.0165, y: 0.014, z: 0.165 })
    asm.addMirrored(box(0.0022, 0.018, 0.040, 0.0012, 1), 'bore', { x: 0.0165, y: -0.020, z: 0.170 })
    // 减重孔外沿的亮边：不描边就只是一块脏木头。
    asm.addMirrored(box(0.002, 0.026, 0.052, 0.0012, 1), 'steel', { x: 0.0182, y: 0.014, z: 0.165 })
  }

  emit(asm, group, M)
  return group
}

/* ==========================================================================
 * 瞄具：4× 镜
 * ========================================================================== */

/**
 * 4× 镜：比 2× 更长、物镜更大、镜环更高。
 *
 * 必须落在 y=SIGHT_Y、z≈-0.42 这条线上：viewmodel 的开镜反解按这条线算，
 * 差 1mm 就会出现"镜筒里看到准星"或"准星浮在镜片上"。
 */
export function createScope4x(mats: WeaponMaterialSet): Group {
  const group = new Group()
  group.name = 'scope-4x'
  const M = materialMap(mats)
  const asm = new Assembly('scope-4x')
  const z = -0.42
  const len = 0.34

  const tube = tubeZ(0.0175, 0.0175, len, 12, 0.0004)
  asm.add(tube, 'darkSteel', { y: SIGHT_Y, z })
  tube.dispose()

  // 物镜端（前）与目镜端（后）各一段加粗的喇叭口。
  const objective = latheZ(
    [
      [0, 0.0175],
      [0.030, 0.0215],
      [0.048, 0.0235],
      [0.052, 0.0228],
    ],
    14,
  )
  asm.add(objective, 'darkSteel', { y: SIGHT_Y, z: z - len / 2 - 0.026 })
  objective.dispose()

  const eyepiece = latheZ(
    [
      [0, 0.0175],
      [0.022, 0.0205],
      [0.034, 0.0212],
      [0.038, 0.0203],
    ],
    14,
  )
  asm.add(eyepiece, 'darkSteel', { y: SIGHT_Y, z: z + len / 2 + 0.019 })
  eyepiece.dispose()

  // 镜片：两端各一片深色玻璃（bore 材质），正对镜头时读成"洞"。
  for (const [dz, r] of [
    [-len / 2 - 0.030, 0.0205],
    [len / 2 + 0.010, 0.0185],
  ] as const) {
    const lens = tubeZ(r, r, 0.004, 16, 0.0002)
    asm.add(lens, 'bore', { y: SIGHT_Y, z: z + dz })
    lens.dispose()
  }

  // 镜环 + 底座：两圈卡箍压在枪身导轨上。
  for (const dz of [-0.105, 0.105]) {
    const ringGeo = ring(0.0215, 0.0035, 12, 6)
    asm.add(ringGeo, 'steel', { y: SIGHT_Y, z: z + dz, rx: Math.PI / 2 })
    ringGeo.dispose()
    asm.add(box(0.026, 0.026, 0.014, 0.002, 2), 'darkSteel', { y: SIGHT_Y - 0.026, z: z + dz })
    asm.add(box(0.040, 0.006, 0.018, 0.0015, 1), 'steel', { y: SIGHT_Y - 0.040, z: z + dz })
  }

  // 调节塔：顶部（仰角）与右侧（风偏），带滚花环。
  asm.add(box(0.020, 0.020, 0.020, 0.003, 2), 'darkSteel', { y: SIGHT_Y + 0.017, z: z + 0.005 })
  asm.add(box(0.012, 0.006, 0.012, 0.002, 1), 'steel', { y: SIGHT_Y + 0.029, z: z + 0.005 })
  asm.add(box(0.020, 0.018, 0.018, 0.003, 2), 'darkSteel', { x: 0.019, y: SIGHT_Y, z: z + 0.005 })
  asm.add(box(0.006, 0.012, 0.012, 0.002, 1), 'steel', { x: 0.031, y: SIGHT_Y, z: z + 0.005 })

  emit(asm, group, M)
  return group
}

/* ==========================================================================
 * 2× 镜与消音器：从 weapon-models 收编
 * ========================================================================== */

/**
 * 这两件最早写在 `weapon-models.ts` 里（跟着枪一起 build）。现在统一出口：
 * 军械库与局内都从这里取，避免"工作台一套、局内另一套"。
 *
 * 没有重写几何：直接转发原 builder，保证行为与已有验收图完全一致。
 */
export { createScopeAttachment as createScope2x, createSuppressorAttachment as createSuppressor } from '../weapon-models.ts'
