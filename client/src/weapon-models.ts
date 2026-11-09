/**
 * 第一人称武器模型：温菲尔德杠杆步枪系 / 双管霰弹 / 柯尔特转轮 / 猎刀。
 *
 * 本文件只造几何与层级，**不创建材质** —— 材质由 render.ts 统一登记与释放，
 * 这里通过 WeaponMaterialSet 注入。这样做的好处是：换一套配色 / 卡通描边参数
 * 不需要重新建模，四把枪也能共享同一批材质实例。
 *
 * 坐标与 viewmodel.ts 的约定一致：+Y 向上，-Z 指向枪口，原点在持枪手虎口附近。
 * 机械瞄具的照门与准星必须落在 x=0、y=SIGHT_Y 这条线上 —— viewmodel 用
 * solveAdsY 把相机原点反解到这条线上，两个瞄具才会在屏幕上重合成一个点。
 * 任何一边高 1mm，开镜就会"前准星浮在照门上"。
 *
 * 所有静态零件先塞进 Assembly 按材质合并，最后每把枪只剩 6~10 个 Mesh；
 * 击锤、转轮、刀光保持独立 Mesh，由 viewmodel 每帧驱动。
 */

import { AdditiveBlending, CylinderGeometry, DoubleSide, Group, Mesh, PlaneGeometry } from 'three'
import type { BufferGeometry, Material } from 'three'
import {
  Assembly,
  blob,
  box,
  dome,
  extrude,
  knurlBand,
  latheZ,
  mergeAll,
  mlokSlot,
  ring,
  rodZ,
  screw,
  serrations,
  tubeZ,
} from './weapon-kit.ts'
import type { ExtrudeOptions, Transform } from './weapon-kit.ts'

/** 照门/准星在武器局部空间的共同高度（米）。必须与 viewmodel.ts 完全一致。 */
export const SIGHT_Y = 0.026
/** 照门缺口的 z。准星在枪口附近，两点连线平行于枪管。 */
export const SIGHT_REAR_Z = -0.06

/** render.ts 注入的一整套材质。键名与 Assembly 的材质桶一一对应。 */
export interface WeaponMaterialSet {
  steel: Material
  darkSteel: Material
  wood: Material
  brass: Material
  sight: Material
  bore: Material
  blade: Material
  bladeEdge: Material
  glove: Material
  gloveDark: Material
  sleeve: Material
}

export interface BuiltRifle {
  group: Group
  stock: Group
  hammer: Mesh
  /** 杠杆子组，绕机匣下方的枢轴做射击循环。 */
  lever: Group
  dispose(): void
}

export interface BuiltShotgun {
  group: Group
  stock: Group
  hammers: Mesh[]
  dispose(): void
}

export interface BuiltRevolver {
  group: Group
  cylinder: Group
  hammer: Mesh
  dispose(): void
}

export interface BuiltKnife {
  group: Group
  glow: Mesh
  glowMat: Material
  dispose(): void
}

/* ==========================================================================
 * 内部工具
 * ========================================================================== */

/** 材质桶的键 → 实际材质。缺键时 emit 会丢弃该桶（不会静默换成别的材质）。 */
function materialMap(mats: WeaponMaterialSet): Record<string, Material> {
  return {
    steel: mats.steel,
    darkSteel: mats.darkSteel,
    wood: mats.wood,
    brass: mats.brass,
    sight: mats.sight,
    bore: mats.bore,
    blade: mats.blade,
    bladeEdge: mats.bladeEdge,
    glove: mats.glove,
    gloveDark: mats.gloveDark,
    sleeve: mats.sleeve,
  }
}

/** 把 Assembly 的合并结果挂成 Mesh。每材质一个 draw call。 */
function emit(asm: Assembly, parent: Group, mats: Record<string, Material>): void {
  for (const [key, geo] of asm.build()) {
    const mat = mats[key]
    if (!mat) {
      geo.dispose()
      continue
    }
    const mesh = new Mesh(geo, mat)
    // 武器在独立场景里渲染，不参与世界阴影。
    mesh.castShadow = false
    parent.add(mesh)
  }
}

/**
 * 侧剖面挤出：轮廓的 +X 是"枪口方向"，挤出厚度沿 X（左右）。
 * 旋转后轮廓 +X 映射到 -Z，正好和武器坐标一致。
 */
function sideProfile(
  pts: ReadonlyArray<readonly [number, number]>,
  depth: number,
  opts: ExtrudeOptions = {},
): BufferGeometry {
  const g = extrude(pts, depth, opts)
  g.rotateY(Math.PI / 2)
  return g
}

/** 内六角螺钉的快捷入口（几何即用即弃，Assembly 内部会克隆）。 */
function addScrew(asm: Assembly, key: string, t: Transform, rHead = 0.0024, len = 0.008): void {
  const g = screw(rHead, rHead * 0.55, rHead * 0.5, len, 10)
  asm.add(g, key, t)
  g.dispose()
}

/** 独立 Mesh（动画件）。几何所有权交给 mesh，dispose() 时统一释放。 */
function movingMesh(
  parent: Group,
  geo: BufferGeometry,
  mat: Material,
  x: number,
  y: number,
  z: number,
  baseX: number,
): Mesh {
  const mesh = new Mesh(geo, mat)
  mesh.castShadow = false
  mesh.position.set(x, y, z)
  mesh.rotation.x = baseX
  mesh.userData.baseX = baseX
  parent.add(mesh)
  return mesh
}

/**
 * 击锤几何：一块带倒角的侧板 + 后掠的拇指压片 + 几道防滑纹。
 * 原点在转轴处，所以 viewmodel 直接绕 x 轴转它就能"压倒 / 回弹"。
 */
function hammerGeometry(width: number, scale: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  const body = sideProfile(
    [
      [-0.011, -0.008],
      [0.011, -0.008],
      [0.010, 0.014],
      [0.002, 0.024],
      [-0.007, 0.023],
      [-0.013, 0.009],
    ],
    width,
    { bevel: 0.0006, bevelSegments: 2 },
  )
  body.scale(1, scale, 1)
  parts.push(body)
  // 后掠的拇指压片：真实的击锤有一个"掰"的尾巴，剪影里一眼能认出来。
  const spur = sideProfile(
    [
      [-0.008, 0.018],
      [-0.022, 0.033],
      [-0.029, 0.029],
      [-0.015, 0.011],
    ],
    width * 0.68,
    { bevel: 0.0005 },
  )
  spur.scale(1, scale, 1)
  parts.push(spur)
  // 压片上的横向刻纹
  for (let i = 0; i < 3; i++) {
    const rib = box(width * 0.72, 0.0014, 0.0018, 0.00025, 1)
    rib.rotateZ(0.7)
    rib.translate(-0.017 - i * 0.0032, (0.022 - i * 0.0035) * scale, 0)
    parts.push(rib)
  }
  return mergeAll(parts)!
}

/**
 * 一只戴手套的手。局部空间：手腕在原点，手指朝 -Z，手背朝 +Y。
 * mirror = +1 右手（拇指在 +X），-1 左手。
 *
 * 不追求解剖精度，追求"在 0.4m 处能读出这是只手"：四点最关键 ——
 * 圆润的掌、两节卷起的四指、压在对侧的拇指、以及腕口/前臂的粗细变化。
 * 手指用 seg=1 的倒角块而不是四根独立圆柱：近景里四根细圆柱只会糊成一团。
 */
function addHand(asm: Assembly, t: Transform, mirror: 1 | -1): void {
  const h = new Assembly('hand')
  const s = mirror

  // 掌：一块有厚度的圆角块，前窄后宽，掌根自然收进腕口。
  // 比真手略小一档：第一人称里手离相机只有 0.4m，等比放大会盖住枪身。
  h.add(blob(0.058, 0.028, 0.086, 0.009, 2), 'glove', { z: -0.044 })
  h.add(blob(0.064, 0.029, 0.042, 0.009, 2), 'glove', { z: -0.010 })
  // 指节护板（深色），让手背有第二个材质层次。
  h.add(blob(0.052, 0.012, 0.028, 0.004, 2), 'gloveDark', { y: 0.015, z: -0.076 })

  // 四指：每指两节向掌心卷曲 —— 这是"在握"而不是"贴着一块木头"的关键。
  const fx = [0.023, 0.0075, -0.0085, -0.023]
  for (let i = 0; i < 4; i++) {
    const x = s * fx[i]
    h.add(blob(0.014, 0.015, 0.031, 0.0045, 1), 'glove', { x, y: -0.009, z: -0.088, rx: -0.55 })
    h.add(blob(0.012, 0.013, 0.025, 0.0045, 1), 'glove', { x, y: -0.026, z: -0.106, rx: -1.15 })
  }

  // 拇指：从掌侧跨过来压住另一侧，两节。
  h.add(blob(0.018, 0.020, 0.038, 0.006, 2), 'glove', {
    x: s * 0.031, y: -0.002, z: -0.028, rz: -s * 0.55,
  })
  h.add(blob(0.016, 0.016, 0.029, 0.005, 1), 'glove', {
    x: s * 0.039, y: -0.017, z: -0.051, rz: -s * 0.85,
  })

  // 腕口：一圈加厚的织物，把"手"和"袖子"分开。
  const cuff = latheZ(
    [
      [0, 0.027],
      [0.004, 0.031],
      [0.034, 0.031],
      [0.038, 0.027],
      [0.038, 0.024],
    ],
    16,
  )
  cuff.scale(1, 0.82, 1)
  h.add(cuff, 'gloveDark', { z: 0.006 })
  cuff.dispose()

  // 前臂：从腕口向 +Z 延伸，近腕细、近肘粗。末端闭合，避免像一根开口管。
  //
  // 半径压到 3.3cm 上下：旧版 4cm 的胶囊在 0.4m 处会读成一根巨型的香肠，
  // 把枪托和机匣全挡住 —— 这是纯模型审查截图里最刺眼的一处。rx/rz 让它
  // 稍微向画面右下垂，而不是水平地伸出去。
  const fore = latheZ(
    [
      [0, 0],
      [0, 0.027],
      [0.012, 0.029],
      [0.100, 0.034],
      [0.158, 0.031],
      [0.162, 0],
    ],
    14,
  )
  fore.scale(1, 0.78, 1)
  // rx 为正 = 前臂往画面下方垂。旧值 -0.16 让它水平伸出去，第一人称里
  // 看起来像一根横在枪侧的香肠；现在两条小臂都从画面下缘进来。
  h.add(fore, 'sleeve', { y: -0.004, z: 0.035, rx: 0.55, rz: s * 0.10 })
  fore.dispose()

  const built = h.build()
  // 整体再缩 0.82：掌/前臂是按"真手"建的，但第一人称的手离相机只有
  // 0.4m，等比放进画面会变成一只盖住整把枪的巨手。缩放以腕关节为原点，
  // 手仍然贴在握把/护木上，只是不再抢枪身的轮廓。
  const k = 0.72
  const handTransform: Transform = {
    ...t,
    sx: (t.sx ?? 1) * k,
    sy: (t.sy ?? 1) * k,
    sz: (t.sz ?? 1) * k,
  }
  for (const [mat, geo] of built) {
    asm.add(geo, mat, handTransform)
    geo.dispose()
  }
}

/** 释放本把武器独有的几何与（可选的）克隆材质；注入的 mats 一律不碰。 */
function disposeGroup(group: Group, extra?: Material): void {
  group.traverse((o) => {
    const mesh = o as Mesh
    if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose()
  })
  if (extra) extra.dispose()
  group.clear()
}

/* ==========================================================================
 * 步枪系：温菲尔德 / 消音卡宾 / 带镜神射手
 * ========================================================================== */

export function buildRifle(
  o: { barrelLen: number; forendLen: number; sightBack: number; scope: boolean; suppressor: boolean },
  mats: WeaponMaterialSet,
): BuiltRifle {
  const M = materialMap(mats)
  const group = new Group()
  const stock = new Group()
  group.add(stock)
  const asm = new Assembly('rifle')
  const stockAsm = new Assembly('rifle-stock')

  const BARREL_Y = 0.004
  const RECEIVER_Y = -0.027
  const muzzleZ = -0.31 - o.barrelLen
  const forendZ = -0.15 - o.forendLen / 2
  const sightFrontZ = -0.28 - o.barrelLen + o.sightBack

  /* ---- 机匣 ---------------------------------------------------------- */
  const receiver = sideProfile(
    [
      [-0.120, -0.0425],
      [0.075, -0.0425],
      [0.120, -0.0280],
      [0.120, 0.0100],
      [0.090, 0.0425],
      [-0.070, 0.0425],
      [-0.120, 0.0060],
    ],
    0.045,
    { bevel: 0.0016, bevelSegments: 2 },
  )
  asm.add(receiver, 'steel', { y: RECEIVER_Y, z: -0.02 })
  receiver.dispose()

  // 右侧侧板：一块有软角的薄板，给机匣侧面一条真实的接缝。
  const sidePlate = sideProfile(
    [
      [-0.090, -0.026],
      [0.055, -0.026],
      [0.072, -0.008],
      [0.072, 0.018],
      [0.050, 0.028],
      [-0.085, 0.028],
      [-0.100, 0.012],
    ],
    0.003,
    { bevel: 0.0006 },
  )
  asm.add(sidePlate, 'darkSteel', { x: 0.0225, y: RECEIVER_Y, z: -0.02 })
  sidePlate.dispose()
  addScrew(asm, 'steel', { x: 0.0242, y: RECEIVER_Y + 0.012, z: -0.03, ry: Math.PI / 2 }, 0.0024, 0.006)
  addScrew(asm, 'steel', { x: 0.0242, y: RECEIVER_Y - 0.02, z: 0.01, ry: Math.PI / 2 }, 0.0024, 0.006)

  // 抛壳口：深色凹槽 + 一圈钢制唇边。它不是贴图，侧视时真的有深度。
  asm.add(box(0.004, 0.021, 0.055, 0.0006, 1), 'bore', { x: 0.0232, y: RECEIVER_Y + 0.010, z: -0.052 })
  const portLip = extrude(roundRectPlate(0.062, 0.028), 0.0025, { bevel: 0.0005 })
  asm.add(portLip, 'steel', { x: 0.0238, y: RECEIVER_Y + 0.010, z: -0.052, ry: Math.PI / 2 })
  portLip.dispose()

  // 装填口（右）与钢制活门。活门用钢而不是黄铜：一块金色小方块在侧面
  // 看起来像一发卡在枪身上的弹壳，这正是"默认怎么会有抛壳模型"的来源。
  asm.add(box(0.003, 0.020, 0.046, 0.0008, 1), 'darkSteel', { x: 0.0240, y: RECEIVER_Y - 0.020, z: 0.004 })
  asm.add(box(0.0025, 0.016, 0.036, 0.0006, 1), 'steel', { x: 0.0252, y: RECEIVER_Y - 0.020, z: 0.004 })

  // 上尾座（tang）：把机匣和枪托连成一条连续的顶线。
  asm.add(box(0.028, 0.010, 0.062, 0.0012, 2), 'steel', { y: RECEIVER_Y + 0.040, z: 0.112 })

  // 击锤的转轴座与击发机构侧板。
  asm.add(box(0.030, 0.016, 0.030, 0.0012, 2), 'steel', { y: RECEIVER_Y + 0.032, z: 0.055 })
  addScrew(asm, 'brass', { x: 0.0242, y: RECEIVER_Y + 0.030, z: 0.055, ry: Math.PI / 2 }, 0.003, 0.007)

  // 枪机与右侧拉柄：开镜时镜头正对机匣背面，没有这两笔就只剩一块平板。
  asm.add(box(0.022, 0.012, 0.080, 0.0010, 2), 'darkSteel', {
    y: RECEIVER_Y + 0.031,
    z: 0.012,
  })
  asm.add(box(0.006, 0.006, 0.032, 0.0010, 1), 'steel', {
    x: 0.030,
    y: RECEIVER_Y + 0.024,
    z: 0.008,
  })
  const boltKnob = dome(0.0065, 10, 0.7)
  asm.add(boltKnob, 'steel', {
    x: 0.048,
    y: RECEIVER_Y + 0.024,
    z: 0.008,
    rz: -Math.PI / 2,
  })
  boltKnob.dispose()
  // 尾座保险 + 尾座螺钉。
  asm.add(box(0.007, 0.005, 0.020, 0.0010, 1), 'steel', {
    x: -0.012,
    y: RECEIVER_Y + 0.047,
    z: 0.100,
  })
  addScrew(asm, 'brass', { y: RECEIVER_Y + 0.047, z: 0.125, rx: Math.PI / 2 }, 0.003, 0.010)

  /* ---- 扳机 / 护圈 / 杠杆 --------------------------------------------- */
  // 扳机护圈弓：半个圆环，转成侧视的 U 形。
  const guard = ring(0.024, 0.0030, 18, 7, Math.PI)
  asm.add(guard, 'darkSteel', { y: RECEIVER_Y - 0.030, z: 0.052, ry: Math.PI / 2, rz: Math.PI })
  guard.dispose()

  // 杠杆是**独立子组**：射击循环要绕机匣下方的枢轴转，不能和机匣合并。
  // 枢轴取在扳机护圈前方（y=-0.065，z=0.045），杠杆环和指环相对它摆位。
  const leverGroup = new Group()
  leverGroup.position.set(0, RECEIVER_Y - 0.038, 0.045)
  const leverAsm = new Assembly('rifle-lever')
  const leverRing = ring(0.050, 0.0034, 20, 8, Math.PI * 1.22)
  leverAsm.add(leverRing, 'steel', { z: -0.035, ry: Math.PI / 2, rz: Math.PI * 0.92 })
  leverRing.dispose()
  const leverLoop = ring(0.013, 0.0026, 14, 6)
  leverAsm.add(leverLoop, 'steel', { y: -0.032, z: 0.025, ry: Math.PI / 2 })
  leverLoop.dispose()
  emit(leverAsm, leverGroup, M)
  group.add(leverGroup)

  // 弯曲的扳机：侧剖面挤出，带一个真实的外弧面。
  const trigger = sideProfile(
    [
      [-0.004, 0.012],
      [0.006, 0.012],
      [0.009, 0.000],
      [0.003, -0.016],
      [-0.004, -0.014],
      [-0.007, 0.000],
    ],
    0.007,
    { bevel: 0.0007, bevelSegments: 2 },
  )
  asm.add(trigger, 'steel', { y: RECEIVER_Y - 0.036, z: 0.055 })
  trigger.dispose()

  /* ---- 枪管 / 弹仓管 / 枪口 ------------------------------------------- */
  const barrel = tubeZ(0.0115, 0.0048, o.barrelLen, 22, 0.0007)
  asm.add(barrel, 'steel', { y: BARREL_Y, z: -0.31 - o.barrelLen / 2 })
  barrel.dispose()
  // 真膛口：一小段深色内管退进枪口 8mm，从正面能看见"洞"。
  const bore = tubeZ(0.0049, 0.0028, 0.05, 16, 0.0003)
  // 内管长 0.05（半径方向 ±0.025）。中心放在枪口后 33mm，前端面就落在
  // 枪口内 8mm：从正面看是一个洞，而不是一根从枪口伸出来的黑管。
  asm.add(bore, 'bore', { y: BARREL_Y, z: muzzleZ + 0.033 })
  bore.dispose()
  // 枪口端面再加一圈亮环，强调圆冠的厚度。
  const crown = latheZ(
    [
      [0, 0.0048],
      [0, 0.0115],
      [0.0012, 0.0115],
      [0.0014, 0.0108],
      [0.0014, 0.0058],
    ],
    20,
  )
  asm.add(crown, 'darkSteel', { y: BARREL_Y, z: muzzleZ + 0.0007 })
  crown.dispose()

  // 弹仓管：枪管下方一根 0.52m 的管，前端封盖，中段一个枪管箍。
  const magLen = 0.52
  const magZ = -0.31 - magLen / 2 + 0.02
  const mag = rodZ(0.009, 0.009, magLen, 16, 0.001)
  asm.add(mag, 'steel', { y: BARREL_Y - 0.023, z: magZ })
  mag.dispose()
  const magCap = tubeZ(0.0105, 0.005, 0.016, 14, 0.0004)
  asm.add(magCap, 'darkSteel', { y: BARREL_Y - 0.023, z: magZ - magLen / 2 + 0.004 })
  magCap.dispose()
  // 枪管箍：把枪管和弹仓管连成一组，是最显眼的机械连接件。
  asm.add(box(0.030, 0.058, 0.011, 0.0018, 2), 'steel', {
    y: BARREL_Y - 0.010,
    z: magZ - magLen / 2 + 0.055,
  })

  /* ---- 前护木 -------------------------------------------------------- */
  const forend = blob(0.046, 0.042, o.forendLen, 0.009, 3)
  asm.add(forend, 'wood', { y: -0.004, z: forendZ })
  forend.dispose()

  // 两道钢制护木箍：圆角矩形环，真的把护木包一圈。
  const band = extrude(roundRectPlate(0.054, 0.052), 0.012, {
    bevel: 0.0010,
    holes: [roundRectPlate(0.046, 0.044)],
  })
  asm.add(band, 'steel', { y: -0.004, z: forendZ - o.forendLen * 0.30 })
  asm.add(band, 'steel', { y: -0.004, z: forendZ + o.forendLen * 0.30 })
  band.dispose()

  // 前端盖：比护木小一圈的深色钢板，封住枪管下方。
  asm.add(box(0.048, 0.044, 0.010, 0.003, 2), 'darkSteel', {
    y: -0.004,
    z: forendZ - o.forendLen / 2 - 0.004,
  })
  // 护木前背带环：一个很小的钢环，正面/侧面都能看出这是把带背带的猎枪。
  const swivel = ring(0.007, 0.0015, 12, 5)
  asm.add(swivel, 'steel', { y: -0.035, z: forendZ - o.forendLen * 0.32, ry: Math.PI / 2 })
  swivel.dispose()

  // 侧面 M-LOK 槽（左右各三）：沉孔 + 凸唇，比贴图更能打碎大片木头。
  const slotGeo = mlokSlot(0.030, 0.008, 0.002)
  slotGeo.rotateY(Math.PI / 2)
  for (let i = -1; i <= 1; i++) {
    asm.addMirrored(slotGeo, 'darkSteel', {
      x: 0.0238,
      y: -0.004,
      z: forendZ + i * Math.min(0.05, o.forendLen * 0.28),
    })
  }
  slotGeo.dispose()

  /* ---- 瞄具（必须 x=0, y=SIGHT_Y） ------------------------------------ */
  // 前准星：燕尾底座 + 竖片 + 顶部亮珠。取消屏幕准星后，准星片是唯一的
  // 瞄准基准，必须比旧模型更粗、更亮；顶部亮珠让它在暗墙上有一眼可见的点。
  asm.add(box(0.020, 0.008, 0.030, 0.0010, 2), 'steel', { y: 0.0195, z: sightFrontZ })
  // 准星/照门都让**上沿**落在 SIGHT_Y 上，而不是让几何中心落在 SIGHT_Y。
  // 相机/弹道沿 SIGHT_Y 出发，玩家用上沿对齐；中心对齐会让准星顶比弹道
  // 高 1cm，30m 外就打低半米 —— 没有屏幕准星后这是致命的。
  // 准星片比旧版加宽加高（0.014×0.028）：3.8 倍镜之外，1.3/1.7 倍机械瞄具
  // 在 1080p 上只有几个像素，太细就真的看不见。顶部再加一颗亮珠，给出
  // 一个"点"而不是一条边 —— 没有屏幕准星后，这是唯一的落点读数。
  asm.add(box(0.014, 0.028, 0.008, 0.0006, 1), 'sight', {
    y: SIGHT_Y - 0.014,
    z: sightFrontZ,
  })
  const bead = blob(0.0055, 0.0055, 0.004, 0.0018, 1)
  asm.add(bead, 'sight', { y: SIGHT_Y - 0.002, z: sightFrontZ })
  bead.dispose()
  // 照门：底座 + 两片竖起的外耳，缺口在中间。耳片上沿同样落在 SIGHT_Y，
  // 耳朵向外挪到 ±0.020、宽度收到 0.012，把缺口从 1.6cm 开到 2.8cm。
  asm.add(box(0.052, 0.007, 0.014, 0.0008, 2), 'steel', { y: RECEIVER_Y + 0.0435, z: SIGHT_REAR_Z })
  asm.add(box(0.012, 0.028, 0.009, 0.0006, 1), 'sight', {
    x: -0.020,
    y: SIGHT_Y - 0.014,
    z: SIGHT_REAR_Z,
  })
  asm.add(box(0.012, 0.028, 0.009, 0.0006, 1), 'sight', {
    x: 0.020,
    y: SIGHT_Y - 0.014,
    z: SIGHT_REAR_Z,
  })

  /* ---- 可选的镜 / 消音器 ---------------------------------------------- */
  if (o.scope) {
    const scopeZ = -0.42
    const scopeTube = tubeZ(0.019, 0.0152, 0.30, 24, 0.0008)
    asm.add(scopeTube, 'darkSteel', { y: SIGHT_Y, z: scopeZ })
    scopeTube.dispose()
    // 两片深色镜片（前端 + 目镜端），读成"玻璃"而不是通管。
    const lens = rodZ(0.0150, 0.0150, 0.0035, 20, 0.0004)
    asm.add(lens, 'bore', { y: SIGHT_Y, z: scopeZ - 0.147 })
    asm.add(lens, 'bore', { y: SIGHT_Y, z: scopeZ + 0.147 })
    lens.dispose()
    // 两个环形镜座。
    const mount = latheZ(
      [
        [0, 0.0190],
        [0, 0.0235],
        [0.013, 0.0235],
        [0.013, 0.0190],
      ],
      20,
    )
    asm.add(mount, 'steel', { y: SIGHT_Y, z: scopeZ - 0.095 })
    asm.add(mount, 'steel', { y: SIGHT_Y, z: scopeZ + 0.095 })
    mount.dispose()
    // 俯仰 / 风偏塔轮：小滚花圆柱，一个朝上、一个朝右。
    const turret = rodZ(0.0062, 0.0062, 0.016, 14, 0.0006)
    asm.add(turret, 'steel', { y: SIGHT_Y + 0.023, z: scopeZ + 0.010, rx: Math.PI / 2 })
    asm.add(turret, 'steel', { x: 0.023, y: SIGHT_Y, z: scopeZ + 0.010, ry: Math.PI / 2 })
    turret.dispose()
    const turretKnurl = knurlBand(0.0065, 0.010, 18, 0.00032, 2)
    asm.add(turretKnurl, 'darkSteel', { y: SIGHT_Y + 0.031, z: scopeZ + 0.010, rx: Math.PI / 2 })
    asm.add(turretKnurl, 'darkSteel', { x: 0.031, y: SIGHT_Y, z: scopeZ + 0.010, ry: Math.PI / 2 })
    turretKnurl.dispose()
    // 底座：把镜筒和机匣顶连起来，否则镜筒像浮在半空。
    asm.add(box(0.030, 0.020, 0.09, 0.002, 2), 'steel', { y: SIGHT_Y - 0.038, z: scopeZ + 0.05 })
    addScrew(asm, 'steel', { x: 0.017, y: SIGHT_Y - 0.038, z: scopeZ + 0.02, ry: Math.PI / 2 }, 0.003, 0.010)
    addScrew(asm, 'steel', { x: 0.017, y: SIGHT_Y - 0.038, z: scopeZ + 0.08, ry: Math.PI / 2 }, 0.003, 0.010)
  }

  if (o.suppressor) {
    const supLen = 0.20
    // 后盖压住枪口 1cm，前端再伸出 19cm。
    const supZ = muzzleZ - 0.09
    const sup = tubeZ(0.026, 0.0145, supLen, 22, 0.0009)
    asm.add(sup, 'steel', { y: BARREL_Y, z: supZ })
    sup.dispose()
    const supCap = latheZ(
      [
        [0, 0.0145],
        [0, 0.0255],
        [0.004, 0.0262],
        [0.012, 0.0262],
        [0.012, 0.0145],
      ],
      20,
    )
    asm.add(supCap, 'darkSteel', { y: BARREL_Y, z: supZ + supLen / 2 - 0.006 })
    // 后盖：套在枪口上的那一圈台阶，避免消音器像一根直接插进枪管的棍子。
    asm.add(supCap, 'steel', { y: BARREL_Y, z: supZ - supLen / 2 + 0.006 })
    supCap.dispose()
    // 防滑滚花：消音器最靠近镜头的那一段，必须打碎镜面高光。
    const supKnurl = knurlBand(0.0262, 0.018, 26, 0.00045, 3)
    asm.add(supKnurl, 'darkSteel', { y: BARREL_Y, z: muzzleZ - 0.05 })
    supKnurl.dispose()
  }

  /* ---- 枪托（独立 Group，开镜时被 viewmodel 收走） -------------------- */
  const stockBody = sideProfile(
    [
      [0.000, -0.012],
      [-0.020, -0.004],
      [-0.080, 0.006],
      [-0.150, 0.012],
      [-0.195, 0.010],
      [-0.218, 0.002],
      [-0.222, -0.030],
      [-0.214, -0.056],
      [-0.170, -0.064],
      [-0.085, -0.054],
      [-0.012, -0.048],
      [0.006, -0.036],
      [0.006, -0.024],
    ],
    0.040,
    { bevel: 0.0035, bevelSegments: 2, curveSegments: 4 },
  )
  stockAsm.add(stockBody, 'wood', { z: 0.080 })
  stockBody.dispose()

  // 钢制托底板 + 深色缓冲垫（都顺着托底的后倾角）。
  stockAsm.add(box(0.042, 0.070, 0.009, 0.002, 2), 'steel', { y: -0.030, z: 0.301, rx: -0.12 })
  stockAsm.add(blob(0.040, 0.066, 0.009, 0.005, 2), 'darkSteel', { y: -0.030, z: 0.307, rx: -0.12 })
  // 托底板上的防滑纹（四道浅槽）。
  for (let i = 0; i < 4; i++) {
    stockAsm.add(box(0.038, 0.0035, 0.004, 0.0008, 1), 'bore', {
      y: -0.052 + i * 0.014,
      z: 0.309,
      rx: -0.12,
    })
  }

  // 背带环 + 腕部螺钉。
  const sling = ring(0.008, 0.0018, 14, 6)
  stockAsm.add(sling, 'steel', { y: -0.058, z: 0.198, ry: Math.PI / 2 })
  sling.dispose()
  stockAsm.add(box(0.008, 0.012, 0.018, 0.0012, 2), 'steel', { y: -0.054, z: 0.198 })
  addScrew(stockAsm, 'brass', { x: 0.0208, y: -0.030, z: 0.090, ry: Math.PI / 2 }, 0.003, 0.008)

  // 右手握在枪颈，但**挂在主组**而不是 stock 子组：开镜时整块枪托会隐藏
  // （它应该在你脸颊后面），扣扳机的手必须留下，否则枪看起来像被拆开了。
  addHand(asm, { x: 0.046, y: -0.032, z: 0.04, ry: Math.PI / 2, rz: 0.08 }, 1)
  // 左手托护木下沿：掌在木料下方，手指向上包住，避免掌心穿进护木。
  addHand(asm, { x: -0.004, y: -0.045, z: forendZ + 0.035, ry: -Math.PI / 2, rz: Math.PI }, -1)

  /* ---- 击锤（独立 Mesh，viewmodel 绕 x 转） --------------------------- */
  const hammer = movingMesh(
    group,
    hammerGeometry(0.013, 1),
    mats.steel,
    0,
    0.004,
    0.048,
    -0.35,
  )

  emit(asm, group, M)
  emit(stockAsm, stock, M)

  return {
    group,
    stock,
    hammer,
    lever: leverGroup,
    dispose(): void {
      disposeGroup(group)
    },
  }
}

/** 圆角矩形轮廓的简写（内部只用于挤出环/板）。 */
function roundRectPlate(w: number, h: number): [number, number][] {
  const r = Math.min(w, h) * 0.18
  const pts: [number, number][] = []
  const hw = w / 2 - r
  const hh = h / 2 - r
  const corners: Array<[number, number, number]> = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, -Math.PI / 2],
  ]
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 3; i++) {
      const a = a0 + (i / 3) * (Math.PI / 2)
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
  }
  return pts
}

/* ==========================================================================
 * 双管霰弹：全尺寸 / 短管
 * ========================================================================== */

export function buildShotgun(mats: WeaponMaterialSet): BuiltShotgun {
  const M = materialMap(mats)
  const group = new Group()
  const stock = new Group()
  group.add(stock)
  const asm = new Assembly('shotgun')
  const stockAsm = new Assembly('shotgun-stock')

  const BARREL_Y = 0.002
  const barrelLen = 0.46
  const muzzleZ = -0.53

  /* ---- 两根并排枪管 + 上肋条 ----------------------------------------- */
  const barrel = tubeZ(0.0155, 0.0095, barrelLen, 20, 0.0006)
  for (const sx of [-1, 1]) {
    asm.add(barrel, 'steel', { x: sx * 0.0165, y: BARREL_Y, z: -0.30 })
  }
  barrel.dispose()
  // 两个真实膛口：深色内管退进枪口，正对镜头时是两个洞而不是两个白点。
  const bore = tubeZ(0.0096, 0.0060, 0.05, 14, 0.0003)
  for (const sx of [-1, 1]) {
    asm.add(bore, 'bore', { x: sx * 0.0165, y: BARREL_Y, z: muzzleZ + 0.033 })
  }
  bore.dispose()
  // 枪口端面的亮环（车削圆冠的厚度）。
  const muzzleRing = latheZ(
    [
      [0, 0.0095],
      [0, 0.0155],
      [0.0012, 0.0155],
      [0.0014, 0.0148],
      [0.0014, 0.0102],
    ],
    18,
  )
  for (const sx of [-1, 1]) {
    asm.add(muzzleRing, 'darkSteel', { x: sx * 0.0165, y: BARREL_Y, z: muzzleZ + 0.0007 })
  }
  muzzleRing.dispose()

  // 上肋条：并排双管之间那条窄脊，侧影里是"两支枪管焊在一起"的证据。
  asm.add(box(0.010, 0.005, barrelLen - 0.006, 0.0008, 1), 'steel', {
    y: BARREL_Y + 0.0175,
    z: -0.30,
  })
  // 肋条前端的小斜台。
  asm.add(box(0.010, 0.004, 0.020, 0.0006, 1), 'darkSteel', {
    y: BARREL_Y + 0.0155,
    z: muzzleZ + 0.012,
  })

  /* ---- 机匣 / 铰链 / 上开锁杆 ----------------------------------------- */
  asm.add(box(0.052, 0.054, 0.150, 0.005, 3), 'steel', { y: -0.008, z: 0.0 })
  // 两侧的抛光侧板：一条接缝就能把"一整块铁"拆成机匣和侧板两个零件。
  asm.addMirrored(box(0.002, 0.040, 0.120, 0.0008, 1), 'darkSteel', {
    x: 0.027,
    y: -0.008,
    z: 0.0,
  })
  addScrew(asm, 'steel', { x: 0.0278, y: -0.008, z: -0.040, ry: Math.PI / 2 }, 0.0026, 0.006)
  addScrew(asm, 'steel', { x: 0.0278, y: -0.008, z: 0.040, ry: Math.PI / 2 }, 0.0026, 0.006)

  // 铰链销：折开式霰弹枪唯一的"机构"特征，横穿机匣下前角。
  const hinge = rodZ(0.0035, 0.0035, 0.064, 14, 0.0004)
  asm.add(hinge, 'brass', { y: -0.032, z: -0.045, ry: Math.PI / 2 })
  hinge.dispose()
  asm.add(box(0.012, 0.016, 0.020, 0.0012, 2), 'steel', { x: -0.028, y: -0.032, z: -0.045 })

  // 上开锁杆：机匣顶部向后伸的拇指杆。
  const topLever = sideProfile(
    [
      [-0.012, 0.000],
      [0.028, 0.001],
      [0.040, 0.005],
      [0.020, 0.008],
      [-0.008, 0.007],
    ],
    0.009,
    { bevel: 0.0008, bevelSegments: 2 },
  )
  asm.add(topLever, 'brass', { y: 0.019, z: 0.030 })
  topLever.dispose()
  // 桶式释放钮（右侧）。
  asm.add(box(0.010, 0.012, 0.020, 0.0012, 2), 'darkSteel', { x: 0.028, y: 0.001, z: 0.012 })
  asm.add(box(0.004, 0.008, 0.012, 0.0008, 1), 'brass', { x: 0.035, y: 0.001, z: 0.012 })

  /* ---- 双扳机 / 护圈 -------------------------------------------------- */
  const triggerGeo = sideProfile(
    [
      [-0.004, 0.011],
      [0.005, 0.011],
      [0.008, 0.000],
      [0.003, -0.014],
      [-0.004, -0.012],
      [-0.007, 0.000],
    ],
    0.006,
    { bevel: 0.0006, bevelSegments: 2 },
  )
  asm.add(triggerGeo, 'steel', { y: -0.042, z: 0.026 })
  asm.add(triggerGeo, 'steel', { y: -0.042, z: 0.052 })
  triggerGeo.dispose()

  const guard = ring(0.024, 0.0030, 18, 7, Math.PI)
  asm.add(guard, 'darkSteel', { y: -0.048, z: 0.040, ry: Math.PI / 2, rz: Math.PI })
  guard.dispose()

  /* ---- 木护木 + 防滑纹 ------------------------------------------------ */
  const forend = blob(0.064, 0.052, 0.180, 0.008, 3)
  asm.add(forend, 'wood', { y: -0.028, z: -0.200 })
  forend.dispose()
  asm.add(box(0.060, 0.050, 0.010, 0.003, 2), 'darkSteel', { y: -0.028, z: -0.292 })

  // 侧面与底面的防滑纹。轴选 y 时肋条按高度排开，正好贴在护木侧壁。
  const checkSide = serrations(0.0022, 0.036, 0.130, 5, 0.0005, 'y')
  asm.add(checkSide, 'darkSteel', { x: 0.0325, y: -0.028, z: -0.200 })
  asm.add(checkSide, 'darkSteel', { x: -0.0325, y: -0.028, z: -0.200 })
  checkSide.dispose()
  const checkBottom = serrations(0.040, 0.0018, 0.120, 6, 0.0005, 'x')
  asm.add(checkBottom, 'darkSteel', { y: -0.054, z: -0.200 })
  checkBottom.dispose()

  /* ---- 瞄具（x=0, y=SIGHT_Y） ----------------------------------------- */
  // 前准星珠。
  const beadBase = box(0.010, 0.006, 0.014, 0.0005, 1)
  asm.add(beadBase, 'steel', { y: SIGHT_Y - 0.008, z: -0.520 })
  beadBase.dispose()
  const bead = dome(0.0052, 12, 0.75)
  asm.add(bead, 'sight', { y: SIGHT_Y, z: -0.520, rx: -Math.PI / 2 })
  bead.dispose()
  // 后照门：两片外耳 + 底座，缺口 28mm；取消屏幕准星后要更醒目。
  asm.add(box(0.042, 0.006, 0.012, 0.0008, 2), 'steel', { y: 0.022, z: 0.020 })
  asm.add(box(0.009, 0.028, 0.009, 0.0006, 1), 'sight', { x: -0.013, y: SIGHT_Y, z: 0.020 })
  asm.add(box(0.009, 0.028, 0.009, 0.0006, 1), 'sight', { x: 0.013, y: SIGHT_Y, z: 0.020 })

  /* ---- 双外露击锤（独立 Mesh） ---------------------------------------- */
  const hammerGeo = hammerGeometry(0.011, 0.9)
  const hammerL = movingMesh(group, hammerGeo.clone(), mats.steel, -0.019, 0.022, 0.078, -0.45)
  const hammerR = movingMesh(group, hammerGeo, mats.steel, 0.019, 0.022, 0.078, -0.45)

  /* ---- 枪托（独立 Group） --------------------------------------------- */
  const stockBody = sideProfile(
    [
      [0.000, -0.014],
      [-0.020, -0.006],
      [-0.080, 0.004],
      [-0.150, 0.010],
      [-0.195, 0.008],
      [-0.218, 0.000],
      [-0.222, -0.030],
      [-0.214, -0.056],
      [-0.170, -0.064],
      [-0.080, -0.054],
      [-0.012, -0.048],
      [0.006, -0.036],
      [0.006, -0.024],
    ],
    0.038,
    { bevel: 0.0035, bevelSegments: 2, curveSegments: 4 },
  )
  stockAsm.add(stockBody, 'wood', { z: 0.075 })
  stockBody.dispose()
  stockAsm.add(box(0.040, 0.068, 0.009, 0.002, 2), 'steel', { y: -0.030, z: 0.296, rx: -0.12 })
  stockAsm.add(blob(0.038, 0.064, 0.009, 0.005, 2), 'darkSteel', { y: -0.030, z: 0.302, rx: -0.12 })
  const sling = ring(0.008, 0.0018, 14, 6)
  stockAsm.add(sling, 'steel', { y: -0.056, z: 0.190, ry: Math.PI / 2 })
  sling.dispose()
  addScrew(stockAsm, 'brass', { x: 0.0198, y: -0.030, z: 0.085, ry: Math.PI / 2 }, 0.0028, 0.007)

  // 右手握托颈（主组，理由同上）、左手托粗护木。
  addHand(asm, { x: 0.046, y: -0.032, z: 0.02, ry: Math.PI / 2, rz: 0.08 }, 1)
  addHand(asm, { x: -0.002, y: -0.054, z: -0.190, ry: -Math.PI / 2, rz: Math.PI }, -1)

  emit(asm, group, M)
  emit(stockAsm, stock, M)

  return {
    group,
    stock,
    hammers: [hammerL, hammerR],
    dispose(): void {
      disposeGroup(group)
    },
  }
}

/* ==========================================================================
 * 柯尔特 M1873 转轮手枪
 * ========================================================================== */

export function buildRevolver(mats: WeaponMaterialSet): BuiltRevolver {
  const M = materialMap(mats)
  const group = new Group()
  const asm = new Assembly('revolver')

  const BARREL_Y = 0.002

  /* ---- 框架 / 顶带 ---------------------------------------------------- */
  // 侧剖面挤出：底把的斜肩、后方的击锤座、前方的枪管接口都在同一条轮廓里。
  const frame = sideProfile(
    [
      [-0.055, -0.030],
      [0.050, -0.030],
      [0.060, 0.000],
      [0.045, 0.022],
      [-0.030, 0.022],
      [-0.055, 0.008],
    ],
    0.034,
    { bevel: 0.002, bevelSegments: 2 },
  )
  asm.add(frame, 'steel', { y: -0.004, z: 0.0 })
  frame.dispose()
  // 顶带：把转轮上方的框架连起来，是转轮手枪"不能折开"的结构证据。
  asm.add(box(0.030, 0.008, 0.088, 0.0015, 2), 'steel', { y: 0.024, z: -0.014 })
  addScrew(asm, 'steel', { x: 0.018, y: -0.010, z: 0.010, ry: Math.PI / 2 }, 0.0026, 0.007)
  addScrew(asm, 'steel', { x: 0.018, y: -0.010, z: -0.030, ry: Math.PI / 2 }, 0.0026, 0.007)

  /* ---- 枪管 / 下护套 / 抽壳杆 ----------------------------------------- */
  const barrel = tubeZ(0.0115, 0.0048, 0.300, 20, 0.0007)
  asm.add(barrel, 'steel', { y: BARREL_Y, z: -0.200 })
  barrel.dispose()
  const bore = tubeZ(0.0049, 0.0028, 0.05, 14, 0.0003)
  asm.add(bore, 'bore', { y: BARREL_Y, z: -0.350 + 0.033 })
  bore.dispose()
  const crown = latheZ(
    [
      [0, 0.0048],
      [0, 0.0115],
      [0.0012, 0.0115],
      [0.0014, 0.0108],
      [0.0014, 0.0058],
    ],
    18,
  )
  asm.add(crown, 'darkSteel', { y: BARREL_Y, z: -0.350 + 0.0007 })
  crown.dispose()

  // 下护套（ejector rod housing）+ 抽壳杆。
  asm.add(box(0.014, 0.016, 0.240, 0.0015, 2), 'steel', { y: -0.024, z: -0.200 })
  const ejector = rodZ(0.0048, 0.0048, 0.245, 12, 0.0006)
  asm.add(ejector, 'darkSteel', { y: -0.030, z: -0.195 })
  ejector.dispose()
  asm.add(box(0.010, 0.010, 0.010, 0.001, 1), 'brass', { y: -0.025, z: -0.322 })

  /* ---- 转轮（独立 Group，换弹时绕 z 转） ------------------------------ */
  const cylinder = new Group()
  cylinder.position.set(0, -0.010, -0.020)
  group.add(cylinder)
  const cylAsm = new Assembly('revolver-cylinder')

  // 轮体：车削出来的真圆柱，两端带圆冠。半径 36mm、长 62mm，和真枪一致。
  const cylBody = latheZ(
    [
      [-0.031, 0],
      [-0.031, 0.0335],
      [-0.029, 0.0355],
      [0.029, 0.0355],
      [0.031, 0.0335],
      [0.031, 0],
    ],
    24,
  )
  cylAsm.add(cylBody, 'steel', {})
  cylBody.dispose()
  // 六个弹巢：端面上一圈深色圆盘。-Z 是枪口方向，所以端面在 z=-0.0315。
  const chamber = rodZ(0.0075, 0.0075, 0.004, 14, 0.0002)
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6
    cylAsm.add(chamber, 'bore', {
      x: Math.cos(a) * 0.0230,
      y: Math.sin(a) * 0.0230,
      z: -0.0315,
    })
    // 弹巢外圈的黄铜底火环，侧视时能读成"六发"。
    cylAsm.add(ring(0.0082, 0.0010, 12, 5), 'brass', {
      x: Math.cos(a) * 0.0230,
      y: Math.sin(a) * 0.0230,
      z: -0.0318,
    })
  }
  chamber.dispose()
  // 六条浅凹槽：贴着轮体侧壁的深色长条，转起来能看出这是转轮。
  const flute = box(0.006, 0.016, 0.046, 0.0010, 1)
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6
    cylAsm.add(flute, 'darkSteel', {
      x: Math.cos(a) * 0.0330,
      y: Math.sin(a) * 0.0330,
      z: 0,
      rz: a,
    })
  }
  flute.dispose()
  // 中心轴 / 棘轮。
  const ratchet = rodZ(0.0060, 0.0060, 0.010, 12, 0.0004)
  cylAsm.add(ratchet, 'darkSteel', { z: -0.033 })
  ratchet.dispose()
  emit(cylAsm, cylinder, M)

  /* ---- 击锤 / 扳机 / 护圈 --------------------------------------------- */
  const hammer = movingMesh(group, hammerGeometry(0.011, 0.9), mats.steel, 0, 0.016, 0.058, -0.5)

  const trigger = sideProfile(
    [
      [-0.004, 0.010],
      [0.005, 0.010],
      [0.008, -0.001],
      [0.003, -0.014],
      [-0.004, -0.012],
      [-0.007, -0.001],
    ],
    0.006,
    { bevel: 0.0006, bevelSegments: 2 },
  )
  asm.add(trigger, 'steel', { y: -0.030, z: 0.046 })
  trigger.dispose()
  const guard = ring(0.022, 0.0030, 16, 7, Math.PI)
  asm.add(guard, 'darkSteel', { y: -0.038, z: 0.042, ry: Math.PI / 2, rz: Math.PI })
  guard.dispose()

  /* ---- 木握把 + 黄铜背带/底帽 ----------------------------------------- */
  const grip = sideProfile(
    [
      [0.012, -0.004],
      [-0.024, -0.004],
      [-0.030, -0.030],
      [-0.040, -0.072],
      [-0.052, -0.094],
      [-0.020, -0.104],
      [0.004, -0.090],
      [0.010, -0.052],
      [0.014, -0.028],
    ],
    0.034,
    { bevel: 0.003, bevelSegments: 2, curveSegments: 4 },
  )
  asm.add(grip, 'wood', { z: 0.048 })
  grip.dispose()
  // 黄铜背带：沿握把后缘的一块弧面薄板。
  asm.add(box(0.036, 0.096, 0.008, 0.002, 2), 'brass', { y: -0.058, z: 0.092, rx: 0.22 })
  // 底帽 + 螺钉。
  asm.add(blob(0.040, 0.014, 0.036, 0.005, 2), 'brass', { y: -0.104, z: 0.096 })
  addScrew(asm, 'brass', { x: 0.018, y: -0.060, z: 0.070, ry: Math.PI / 2 }, 0.0028, 0.007)

  /* ---- 瞄具（x=0, y=SIGHT_Y） ------------------------------------------ */
  asm.add(box(0.014, 0.006, 0.020, 0.0006, 1), 'steel', { y: 0.0145, z: -0.350 })
  // 与步枪同理：准星/照门上沿落在 SIGHT_Y，弹道才与瞄具读数一致。
  asm.add(box(0.009, 0.020, 0.009, 0.0006, 1), 'sight', {
    y: SIGHT_Y - 0.010,
    z: -0.350,
  })
  asm.add(box(0.008, 0.024, 0.008, 0.0006, 1), 'sight', {
    x: -0.012,
    y: SIGHT_Y - 0.012,
    z: 0.030,
  })
  asm.add(box(0.008, 0.024, 0.008, 0.0006, 1), 'sight', {
    x: 0.012,
    y: SIGHT_Y - 0.012,
    z: 0.030,
  })

  // 单手：握把上的右手，前臂从右下出画。
  addHand(asm, { x: 0.030, y: -0.052, z: 0.080, ry: Math.PI / 2, rz: 0.12 }, 1)

  emit(asm, group, M)

  return {
    group,
    cylinder,
    hammer,
    dispose(): void {
      disposeGroup(group)
    },
  }
}

/* ==========================================================================
 * 猎刀
 * ========================================================================== */

export function buildKnife(mats: WeaponMaterialSet): BuiltKnife {
  const M = materialMap(mats)
  const group = new Group()
  const asm = new Assembly('knife')

  /* ---- 握把 / 护手 / 铆钉 / 尾帽 --------------------------------------- */
  // 椭圆木柄：倒角给到 10mm，侧视是一个有腰身的软体，不是一根方木。
  asm.add(blob(0.026, 0.032, 0.110, 0.010, 3), 'wood', { z: 0.020 })
  // 黄铜护手：横向一根，隔开手和刃。
  asm.add(box(0.052, 0.014, 0.014, 0.002, 2), 'brass', { z: -0.040 })
  // 三颗贯穿柄的铆钉（沿 X 轴）。
  const rivet = rodZ(0.0030, 0.0030, 0.030, 10, 0.0004)
  for (const z of [0.000, 0.032, 0.060]) {
    asm.add(rivet, 'brass', { z, ry: Math.PI / 2 })
  }
  rivet.dispose()
  // 尾帽 + 一颗小螺钉。
  asm.add(blob(0.028, 0.034, 0.020, 0.006, 2), 'brass', { z: 0.080 })
  addScrew(asm, 'steel', { x: 0.014, y: 0, z: 0.084, ry: Math.PI / 2 }, 0.0026, 0.006)

  /* ---- 刀身：侧剖挤出 + 真实倒角 -------------------------------------- */
  // 轮廓 +X 是刀尖方向；放置时 z0=-0.04，所以刀尖落在 z≈-0.34，刀根贴着护手。
  const bladeProfile: Array<[number, number]> = [
    [0.000, 0.024],
    [0.235, 0.022],
    [0.288, 0.013],
    [0.300, 0.000],
    [0.252, -0.005],
    [0.080, -0.014],
    [0.000, -0.014],
  ]
  const blade = sideProfile(bladeProfile, 0.006, { bevel: 0.0010, bevelSegments: 2, curveSegments: 4 })
  asm.add(blade, 'blade', { z: -0.040 })
  blade.dispose()

  // 刃口亮条：沿切削边的窄带，材质比刀面亮两档。挥砍时它先扫过画面，
  // 那一下反光就是"这是把刀"的全部说服力。
  const edgeProfile: Array<[number, number]> = [
    [0.300, -0.0004],
    [0.252, -0.0056],
    [0.080, -0.0146],
    [0.000, -0.0146],
    [0.000, -0.0088],
    [0.084, -0.0088],
    [0.246, 0.0004],
    [0.286, 0.0034],
  ]
  const edge = sideProfile(edgeProfile, 0.0040, { bevel: 0.0004, bevelSegments: 1 })
  asm.add(edge, 'bladeEdge', { z: -0.040 })
  edge.dispose()

  // 血槽：刀面两侧各一条深色细槽（真凹槽在卡通材质下读成一条阴影线）。
  const fuller = box(0.0009, 0.0050, 0.200, 0.0002, 1)
  asm.addMirrored(fuller, 'darkSteel', { x: 0.0032, y: 0.006, z: -0.170 })
  fuller.dispose()

  // 刀根/刀背的加强脊：让剪影从侧面看有厚度变化。
  asm.add(box(0.008, 0.006, 0.090, 0.0010, 1), 'darkSteel', { y: 0.021, z: -0.090 })

  /* ---- 刀光面片 -------------------------------------------------------- */
  // 双面加色混合的薄面：刀挂在画面右侧时，相机从 -X 侧看它，正好铺成一条
  // 沿刀身的带子，而不是一个正对镜头的白方块。
  const glowGeo = new PlaneGeometry(0.34, 0.10)
  glowGeo.rotateY(Math.PI / 2)
  const glowMat = mats.bladeEdge.clone()
  glowMat.transparent = true
  glowMat.opacity = 0
  glowMat.depthWrite = false
  glowMat.blending = AdditiveBlending
  glowMat.side = DoubleSide
  glowMat.needsUpdate = true
  const glow = new Mesh(glowGeo, glowMat)
  glow.position.set(0, 0.004, -0.2)
  glow.visible = false
  glow.castShadow = false
  // 刀光不挡子弹、不参与拾取，它只是一层画面效果。
  glow.raycast = () => {}
  group.add(glow)

  // 整把刀绕组的原点转 = 绕手腕转，挥砍不需要额外的枢轴节点。
  addHand(asm, { x: 0.022, y: -0.012, z: 0.028, ry: Math.PI / 2, rz: 0.10 }, 1)

  emit(asm, group, M)

  return {
    group,
    glow,
    glowMat,
    dispose(): void {
      disposeGroup(group, glowMat)
    },
  }
}




/**
 * 可拆卸的 2× 镜：出击前选了配件才显示。
 *
 * 位置和 buildRifle 内置瞄具一致（y=SIGHT_Y、z=-0.42），所以开镜时的
 * "枪身对齐瞄准线"逻辑不需要为普通步枪另写一套。
 */
export function createScopeAttachment(mats: WeaponMaterialSet): Group {
  const group = new Group()
  group.name = 'scope-attachment'
  const scopeZ = -0.42

  const tube = new Mesh(new CylinderGeometry(0.019, 0.019, 0.30, 16), mats.darkSteel)
  tube.rotation.x = Math.PI / 2
  tube.position.set(0, SIGHT_Y, scopeZ)
  group.add(tube)

  for (const dz of [-0.147, 0.147]) {
    const lens = new Mesh(new CylinderGeometry(0.0165, 0.0165, 0.006, 16), mats.bore)
    lens.rotation.x = Math.PI / 2
    lens.position.set(0, SIGHT_Y, scopeZ + dz)
    group.add(lens)
  }
  for (const dz of [-0.095, 0.095]) {
    const mount = new Mesh(new CylinderGeometry(0.016, 0.016, 0.05, 10), mats.steel)
    mount.position.set(0, SIGHT_Y - 0.024, scopeZ + dz)
    group.add(mount)
  }
  const turret = new Mesh(new CylinderGeometry(0.012, 0.012, 0.02, 10), mats.steel)
  turret.rotation.x = Math.PI / 2
  turret.position.set(0, SIGHT_Y + 0.026, scopeZ + 0.01)
  group.add(turret)
  return group
}

/** 可拆卸的消音器：拧在枪口上，比枪管粗一圈。 */
export function createSuppressorAttachment(mats: WeaponMaterialSet, muzzleZ: number): Group {
  const group = new Group()
  group.name = 'suppressor-attachment'
  const can = new Mesh(new CylinderGeometry(0.024, 0.024, 0.18, 16), mats.darkSteel)
  can.rotation.x = Math.PI / 2
  can.position.set(0, 0, muzzleZ - 0.09)
  group.add(can)
  const cap = new Mesh(new CylinderGeometry(0.026, 0.026, 0.014, 16), mats.steel)
  cap.rotation.x = Math.PI / 2
  cap.position.set(0, 0, muzzleZ - 0.182)
  group.add(cap)
  return group
}
