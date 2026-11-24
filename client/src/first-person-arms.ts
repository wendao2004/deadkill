/**
 * 第一人称手/臂。
 *
 * 旧版的两只手是用 `addHand()` 直接合并进枪的 Assembly 的：手和枪共用同一个
 * 刚性变换，换弹/开镜时手像焊在木头上，前臂永远水平伸出去。这里把手从枪里
 * 拆出来：
 *
 * - 手只保留腕关节在原点，手指朝 -Z、手背朝 +Y；
 * - 手的位置 = 枪上握点的世界坐标（由 weapon-models 的 hands 提供）；
 * - 前臂从腕点朝画面下缘外侧走，肘点固定在相机空间的一个偏移上；
 *   上臂再往画面外延伸一小段，只用来交代"手臂是从身体长出来的"。
 *
 * 为什么不用两骨 IK + 肩点：第一人称的肩点离镜头不到半米，两骨伸直时
 * 前臂会变成一根从画面中央捅到枪上的木棍（这正是旧版截图里的样子）。
 * 相机空间的固定肘点更便宜，也更好看：它就是"手抬起来、肘垂在身侧"。
 *
 * 不引入骨骼/AnimationMixer：每帧只是几个 Vector3 + 四元数，成本可忽略，
 * 也不会破坏确定性。
 */

import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three'
import { Assembly, blob, box, latheZ } from './weapon-kit.ts'
import type { HandAnchor, WeaponHands, WeaponMaterialSet } from './weapon-models.ts'

const HAND_SCALE = 0.92
const UP = new Vector3(0, 1, 0)
const _v = new Vector3()
const _w = new Vector3()
const _e = new Vector3()
const _dir = new Vector3()
const _q = new Quaternion()

/** 单只手：掌、手背、四指三节、拇指两节、指节垫、腕口与束带；不带前臂。 */
function buildHand(mats: WeaponMaterialSet, mirror: 1 | -1): Group {
  const h = new Assembly('hand')
  const s = mirror

  // 掌：比旧版更方一点，手背压扁 —— 圆球一样的掌在近景会读成"连指手套"。
  h.add(blob(0.078, 0.030, 0.092, 0.010, 2), 'glove', { z: -0.048 })
  // 手背凸起的指伸肌腱：一条窄条，给手背一点结构。
  h.add(blob(0.050, 0.008, 0.062, 0.003, 2), 'glove', { y: 0.017, z: -0.052 })
  // 掌根（大鱼际）：拇指根部的肉垫。
  h.add(blob(0.034, 0.026, 0.050, 0.010, 2), 'glove', { x: s * 0.030, y: -0.004, z: -0.020 })

  const fx = [0.026, 0.0085, -0.0095, -0.026]
  const len = [1.0, 1.06, 1.0, 0.86]
  for (let i = 0; i < 4; i++) {
    const x = s * fx[i]!
    const k = len[i]!
    // 三节指骨：近节贴在握把上，中节向下扣，远节收回掌心。
    h.add(blob(0.016, 0.017, 0.034 * k, 0.005, 1), 'glove', {
      x, y: -0.010, z: -0.096, rx: -0.55,
    })
    h.add(blob(0.0145, 0.0155, 0.028 * k, 0.005, 1), 'glove', {
      x, y: -0.030, z: -0.116, rx: -1.25,
    })
    h.add(blob(0.013, 0.014, 0.021 * k, 0.0045, 1), 'gloveDark', {
      x, y: -0.047, z: -0.124, rx: -1.95,
    })
    // 指节垫：四块小凸起，近看才知道这是手套而不是一根圆棒。
    h.add(blob(0.015, 0.009, 0.012, 0.004, 1), 'gloveDark', {
      x, y: 0.004, z: -0.088,
    })
  }

  // 拇指：两节，压在握把左侧（镜像后自动换边）。
  h.add(blob(0.020, 0.022, 0.042, 0.007, 2), 'glove', {
    x: s * 0.042, y: -0.004, z: -0.030, rz: -s * 0.55, ry: -s * 0.18,
  })
  h.add(blob(0.017, 0.018, 0.032, 0.006, 1), 'glove', {
    x: s * 0.058, y: -0.020, z: -0.058, rz: -s * 0.9, ry: -s * 0.25,
  })

  // 腕口：车削出来的喇叭形袖口，开口朝手臂方向（+Z）。
  const cuff = latheZ(
    [
      [0, 0.030],
      [0.005, 0.034],
      [0.040, 0.036],
      [0.048, 0.032],
      [0.048, 0.028],
    ],
    18,
  )
  cuff.scale(1, 0.78, 1)
  h.add(cuff, 'gloveDark', { z: 0.004 })
  cuff.dispose()
  // 束带 + 扣：一根窄带绕腕一圈，扣子偏在手背侧。
  h.add(box(0.070, 0.012, 0.014, 0.003, 2), 'gloveDark', { y: 0.002, z: 0.030 })
  h.add(box(0.014, 0.016, 0.010, 0.002, 2), 'brass', { x: s * 0.030, y: 0.006, z: 0.030 })

  const group = new Group()
  for (const [key, geo] of h.build()) {
    const source = (mats as unknown as Record<string, MeshToonMaterial | MeshBasicMaterial>)[key]
    if (!source) {
      geo.dispose()
      continue
    }
    // 手臂是独立的第一人称层：只和枪争遮挡，不应该被枪的深度缓冲吃掉。
    // 深度测试关掉、renderOrder 抬高，手才能稳定地压在护木/枪托上。
    //
    // 注意：Material.clone() 不复制 onBeforeCompile / customProgramCacheKey，
    // 也不共享 userData 里的 uniform 对象。直接 clone 会把墨线和对象空间细节
    // 一起丢掉，近景的手立刻变回一块平涂橡皮。这里手动把这两样接回来。
    const material = source.clone()
    material.onBeforeCompile = source.onBeforeCompile
    material.customProgramCacheKey = source.customProgramCacheKey
    material.userData = source.userData
    material.depthTest = false
    material.depthWrite = false
    const mesh = new Mesh(geo, material)
    mesh.castShadow = false
    mesh.renderOrder = 10
    group.add(mesh)
  }
  group.scale.setScalar(HAND_SCALE)
  return group
}

/** 一段袖子：带锥度的圆柱，轴线从 from 到 to。 */
function buildLimb(radiusTop: number, radiusBottom: number, material: MeshToonMaterial): Mesh {
  const geometry = new CylinderGeometry(radiusTop, radiusBottom, 1, 10, 1)
  const mesh = new Mesh(geometry, material)
  mesh.castShadow = false
  return mesh
}

export interface FirstPersonArms {
  readonly root: Group
  update(
    hands: WeaponHands,
    gun: Object3D,
    visible: boolean,
    reload: number,
    reloading: boolean,
  ): void
  dispose(): void
}

export function createFirstPersonArms(mats: WeaponMaterialSet): FirstPersonArms {
  const root = new Group()
  root.name = 'first-person-arms'
  const rightHand = buildHand(mats, 1)
  const leftHand = buildHand(mats, -1)
  root.add(rightHand, leftHand)

  const sleeve = (mats.sleeve as MeshToonMaterial).clone()
  sleeve.depthTest = false
  sleeve.depthWrite = false
  // 前臂：腕细肘粗；上臂再粗一档，只露出画面外的一小截。
  //
  // 半径在 0.3m 的观察距离上被放大得很厉害：0.040 的肘部半径在 65° FOV 下
  // 就是画面高度的一成多，两根加起来正好是"两块黑板"。收细到 0.034 仍然
  // 有体积，但不再把地面挡掉。
  const rightFarm = buildLimb(0.024, 0.034, sleeve)
  const rightArm = buildLimb(0.034, 0.046, sleeve)
  const leftFarm = buildLimb(0.024, 0.034, sleeve)
  const leftArm = buildLimb(0.034, 0.046, sleeve)
  const limbs = [rightFarm, rightArm, leftFarm, leftArm]
  for (const limb of limbs) limb.renderOrder = 10
  root.add(...limbs)

  // 卷起的袖口：前臂靠肘那一端的一圈布，遮住两段袖子的接缝。
  const cuffGeo = new CylinderGeometry(0.038, 0.038, 0.040, 14, 1, true)
  const cuffs = [rightFarm, leftFarm].map(() => {
    const mesh = new Mesh(cuffGeo, sleeve)
    mesh.renderOrder = 10
    mesh.castShadow = false
    return mesh
  })
  root.add(...cuffs)

  // 腕箍：手套是棕色的、前臂是深色布料，两者之间原本是一道硬断层 ——
  // 近景看起来像"棕色积木浮在管子前面"。一圈窄袖箍压在腕口，手和前臂
  // 才读成同一条肢体。
  const wristGeo = new CylinderGeometry(0.030, 0.0325, 0.036, 12, 1, true)
  const wristWraps = [0, 1].map(() => {
    const mesh = new Mesh(wristGeo, sleeve)
    mesh.renderOrder = 12
    mesh.castShadow = false
    return mesh
  })
  root.add(...wristWraps)

  const geometries = [...limbs.map((mesh) => mesh.geometry), cuffGeo, wristGeo]
  const handMeshes: Mesh[] = []
  for (const hand of [rightHand, leftHand]) {
    hand.traverse((node) => {
      if (node instanceof Mesh) handMeshes.push(node)
    })
  }

  /** 相机空间里"肘垂在身侧"的偏移：向外、向下、略向身后。 */
  //
  // 肘点决定前臂在屏幕上的斜率。肘点越靠内（x 小）前臂越接近水平，就会
  // 变成一根横穿画面的斜杠；越靠外靠下，前臂越接近竖直，让出中间的视野。
  // 代价是肘部更快出画，但第一人称本来也看不到肘。
  const ELBOW_OFFSET = [new Vector3(0.255, -0.400, 0.130), new Vector3(-0.265, -0.390, 0.115)]
  /** 上臂从肘继续往画面外/身后走。 */
  const SHOULDER_OFFSET = [new Vector3(0.075, -0.215, 0.205), new Vector3(-0.085, -0.205, 0.195)]

  const setLimb = (mesh: Mesh, from: Vector3, to: Vector3): void => {
    _dir.subVectors(to, from)
    const length = _dir.length()
    if (length < 1e-5) {
      mesh.visible = false
      return
    }
    mesh.visible = true
    mesh.position.addVectors(from, to).multiplyScalar(0.5)
    mesh.quaternion.setFromUnitVectors(UP, _dir.multiplyScalar(1 / length))
    mesh.scale.set(1, length, 1)
  }

  const placeHand = (
    hand: Group,
    anchor: HandAnchor,
    gun: Object3D,
    reloadOffset: number,
  ): Vector3 => {
    _v.set(anchor.x, anchor.y, anchor.z)
    // reloadOffset：左手上弹时沿枪身向后收一点，避免"换弹时手还钉在护木上"。
    _v.z += reloadOffset
    gun.localToWorld(_v)
    gun.getWorldQuaternion(_q)
    hand.position.copy(_v)
    hand.quaternion.copy(_q)
    hand.rotateX(anchor.rx ?? 0)
    hand.rotateY(anchor.ry ?? 0)
    hand.rotateZ(anchor.rz ?? 0)
    hand.updateMatrixWorld(true)
    return _v
  }

  const dispose = (): void => {
    for (const geometry of geometries) geometry.dispose()
    for (const mesh of handMeshes) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshToonMaterial).dispose()
    }
    sleeve.dispose()
    root.clear()
  }

  const update = (hands: WeaponHands, gun: Object3D, visible: boolean, reload: number, reloading: boolean): void => {
    if (!visible) {
      root.visible = false
      return
    }
    root.visible = true
    gun.updateWorldMatrix(true, false)
    const leftOffset = reloading ? -0.12 * Math.sin(Math.min(1, Math.max(0, reload)) * Math.PI) : 0

    const place = (side: 0 | 1, hand: Group, anchor: HandAnchor, offset: number): void => {
      const wrist = placeHand(hand, anchor, gun, offset)
      _w.copy(wrist).add(ELBOW_OFFSET[side]!)
      const shoulder = _e.copy(_w).add(SHOULDER_OFFSET[side]!)
      const forearm = side === 0 ? rightFarm : leftFarm
      setLimb(forearm, _w, wrist)
      setLimb(side === 0 ? rightArm : leftArm, shoulder, _w)
      const cuff = cuffs[side]!
      cuff.visible = true
      cuff.position.copy(_w)
      cuff.quaternion.copy(forearm.quaternion)
      // 腕箍贴着腕点，轴向跟当前前臂一致：它盖住的是"手套腕口 ↔ 袖子"那道缝。
      const wrap = wristWraps[side]!
      wrap.visible = true
      wrap.position.copy(wrist)
      wrap.quaternion.copy(forearm.quaternion)
    }

    place(0, rightHand, hands.right, 0)
    if (hands.left) {
      place(1, leftHand, hands.left, leftOffset)
      leftHand.visible = true
    } else {
      leftHand.visible = false
      leftFarm.visible = false
      leftArm.visible = false
      cuffs[1]!.visible = false
      wristWraps[1]!.visible = false
    }
  }

  return { root, update, dispose }
}
