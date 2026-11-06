/**
 * 远端猎人的程序化模型。
 *
 * 旧版是两个盒子（身体 + 头），在"一眼分辨人/怪"的夜战里信息量太低。
 * 新版用程序化硬表面几何拼一个 1890 年代猎人的剪影：宽檐帽、长大衣、
 * 靴子、背包、斜挎弹药带、横抱的杠杆步枪。材质仍然走 **MeshToonMaterial
 * + applyComicInk**（阶梯光照、排线、世界空间细节、假高光、轮廓光），
 * 并且把浏览器里烘焙好的布料/皮革灰度贴图作为 albedo 细节。
 *
 * 几何按"身体 + 左右腿"分组：身体是一个刚体子组，两条腿绕髋关节转，
 * 由 render.ts 按远程玩家的插值速度做简单步行摆动。没有骨骼/蒙皮 ——
 * 远程观察距离通常在 5m 以外，摆动比解剖学精度更重要，也更省。
 */
import { Group, Mesh, type Material, type Texture } from 'three'
import {
  Assembly,
  blob,
  box,
  ring,
  rodZ,
} from './weapon-kit.ts'

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
  cloth: Material
  clothDark: Material
  leather: Material
  skin: Material
  metal: Material
  wood: Material
  dark: Material
}

export interface HunterTextures {
  readonly cloth: Texture
  readonly leather: Texture
}

export interface HunterModel {
  readonly root: Group
  /** 身体（大衣/头/手/枪）的刚体子组，用于走路轻微起伏。 */
  readonly body: Group
  readonly legL: Group
  readonly legR: Group
  dispose(): void
}

/** 一套材质在整局里共享；只有几何是每个远端玩家一份。 */
export function createHunterMaterials(kit: HunterKit, textures: HunterTextures): HunterMaterials {
  return {
    cloth: kit.toon(0x6d6a5c, {
      hatch: 0.34,
      specular: 0.03,
      rim: 0.1,
      map: textures.cloth,
    }),
    clothDark: kit.toon(0x4b4a40, {
      hatch: 0.32,
      specular: 0.02,
      rim: 0.08,
      map: textures.cloth,
    }),
    leather: kit.toon(0x5a4230, {
      hatch: 0.3,
      specular: 0.1,
      rim: 0.08,
      map: textures.leather,
    }),
    skin: kit.toon(0xc49a78, { hatch: 0.1, specular: 0.02, rim: 0.06 }),
    metal: kit.toon(0x4b5564, { hatch: 0.15, surface: 'metal', specular: 0.35, rim: 0.1 }),
    wood: kit.toon(0x5a3a22, { hatch: 0.12, surface: 'wood', specular: 0.03 }),
    dark: kit.toon(0x24231f, { hatch: 0.18, specular: 0 }),
  }
}

/** 把 Assembly 的合并结果挂成 Mesh，并加墨线壳 / 阴影。 */
function emit(
  asm: Assembly,
  parent: Group,
  mats: Record<string, Material>,
  kit: Pick<HunterKit, 'addInk'>,
): void {
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
    kit.addInk(mesh, 2.6)
  }
}

function mirrorX(v: number): number {
  return -v
}

export function createHunterModel(
  mats: HunterMaterials,
  kit: Pick<HunterKit, 'addInk'>,
): HunterModel {
  const map: Record<string, Material> = {
    cloth: mats.cloth,
    clothDark: mats.clothDark,
    leather: mats.leather,
    skin: mats.skin,
    metal: mats.metal,
    wood: mats.wood,
    dark: mats.dark,
  }

  const root = new Group()
  // 原点在脚底；身体/腿都绕髋部（y=0.9）转。
  const body = new Group()
  body.position.y = 0.9
  root.add(body)

  const cloth = new Assembly('hunter-cloth')
  const clothDark = new Assembly('hunter-cloth-dark')
  const leather = new Assembly('hunter-leather')
  const skin = new Assembly('hunter-skin')
  const metal = new Assembly('hunter-metal')
  const wood = new Assembly('hunter-wood')
  const dark = new Assembly('hunter-dark')

  /* ---- 躯干 / 大衣 --------------------------------------------------- */
  // 胸 + 大衣下摆：下摆比胸宽一圈，剪影才不是一根方柱。
  cloth.add(blob(0.46, 0.50, 0.30, 0.06, 2), 'cloth', { y: 0.30 })
  cloth.add(blob(0.54, 0.26, 0.34, 0.05, 2), 'cloth', { y: 0.06 })
  // 肩线：把脖子和肩分开。
  cloth.add(blob(0.52, 0.15, 0.30, 0.06, 1), 'cloth', { y: 0.50 })
  // 腰带。
  leather.add(blob(0.50, 0.075, 0.32, 0.02, 2), 'leather', { y: 0.10 })
  // 斜挎弹药带：横过胸口，给正面一条明显的斜线。
  dark.add(box(0.075, 0.62, 0.05, 0.01, 1), 'dark', {
    y: 0.35,
    z: -0.155,
    rz: 0.62,
    ry: 0.12,
  })
  for (let i = 0; i < 4; i++) {
    metal.add(box(0.035, 0.045, 0.02, 0.006, 1), 'metal', {
      x: -0.11 + i * 0.075,
      y: 0.22 + i * 0.085,
      z: -0.185,
      rz: 0.62,
    })
  }
  // 领口/围巾。
  clothDark.add(blob(0.24, 0.13, 0.22, 0.05, 1), 'clothDark', { y: 0.55 })
  // 背包 + 铺盖卷。
  leather.add(blob(0.30, 0.34, 0.16, 0.04, 1), 'leather', { y: 0.30, z: 0.20 })
  clothDark.add(rodZ(0.065, 0.065, 0.34, 10, 0.01), 'clothDark', {
    y: 0.52,
    z: 0.24,
    rz: Math.PI / 2,
  })

  /* ---- 双臂（静态，一前一后抱着枪） --------------------------------- */
  // 左臂：上臂略外张、前臂横过胸前，手在枪护木附近。
  cloth.add(blob(0.13, 0.30, 0.14, 0.03, 1), 'cloth', {
    x: -0.27,
    y: 0.38,
    z: -0.01,
    rz: 0.22,
  })
  cloth.add(blob(0.115, 0.27, 0.12, 0.03, 1), 'cloth', {
    x: -0.33,
    y: 0.22,
    z: -0.12,
    rx: -0.85,
    rz: 0.35,
  })
  // 右臂：握枪的手更低。
  cloth.add(blob(0.13, 0.30, 0.14, 0.03, 1), 'cloth', {
    x: 0.27,
    y: 0.38,
    z: -0.005,
    rz: -0.2,
  })
  cloth.add(blob(0.115, 0.26, 0.12, 0.03, 1), 'cloth', {
    x: 0.30,
    y: 0.20,
    z: -0.08,
    rx: -0.55,
    rz: -0.25,
  })
  // 手套。
  leather.add(blob(0.10, 0.10, 0.13, 0.03, 1), 'leather', { x: -0.30, y: 0.20, z: -0.22 })
  leather.add(blob(0.10, 0.10, 0.12, 0.03, 1), 'leather', { x: 0.28, y: 0.16, z: -0.16 })

  /* ---- 头 / 宽檐帽 --------------------------------------------------- */
  skin.add(blob(0.145, 0.14, 0.145, 0.04, 1), 'skin', { y: 0.57 })
  skin.add(blob(0.20, 0.23, 0.22, 0.06, 2), 'skin', { y: 0.70 })
  // 鼻子 + 下巴，侧影能看出是朝前的。
  skin.add(blob(0.055, 0.06, 0.06, 0.02, 1), 'skin', { y: 0.69, z: -0.115 })
  skin.add(blob(0.14, 0.06, 0.05, 0.02, 1), 'skin', { y: 0.62, z: -0.075 })
  // 眼睛 + 下半张脸的围巾：2~3m 近看时，没有这两笔脸就是一颗棕色的蛋。
  dark.add(blob(0.045, 0.022, 0.018, 0.004, 1), 'dark', { x: -0.048, y: 0.725, z: -0.108 })
  dark.add(blob(0.045, 0.022, 0.018, 0.004, 1), 'dark', { x: 0.048, y: 0.725, z: -0.108 })
  clothDark.add(blob(0.16, 0.08, 0.06, 0.02, 1), 'clothDark', { y: 0.635, z: -0.078 })
  // 帽檐 + 帽冠 + 帽带。帽冠用圆角块，宽檐帽的剪影靠帽檐而不是车削。
  leather.add(blob(0.62, 0.028, 0.60, 0.012, 1), 'leather', { y: 0.82 })
  leather.add(blob(0.30, 0.17, 0.30, 0.05, 2), 'leather', { y: 0.86 })
  dark.add(blob(0.325, 0.035, 0.325, 0.01, 1), 'dark', { y: 0.845 })

  /* ---- 横抱的杠杆步枪 ------------------------------------------------ */
  // 只做剪影：枪托、机匣、枪管、杠杆环。太细的零件在 10m 外只会闪。
  wood.add(box(0.05, 0.10, 0.30, 0.012, 2), 'wood', {
    x: 0.13,
    y: 0.28,
    z: 0.10,
    rx: -0.12,
  })
  metal.add(box(0.045, 0.075, 0.20, 0.008, 1), 'metal', { x: 0.13, y: 0.30, z: -0.12 })
  metal.add(rodZ(0.012, 0.012, 0.56, 10, 0.006), 'metal', {
    x: 0.13,
    y: 0.32,
    z: -0.50,
  })
  metal.add(ring(0.035, 0.0045, 12, 5, Math.PI), 'metal', {
    x: 0.13,
    y: 0.25,
    z: -0.08,
    ry: Math.PI / 2,
    rz: Math.PI,
  })

  /* ---- 腿（每个是一组，绕髋关节摆动） -------------------------------- */
  const makeLeg = (sx: number): Group => {
    const leg = new Group()
    leg.position.set(sx, 0.9, 0)
    const legCloth = new Assembly('hunter-leg-cloth')
    const legDark = new Assembly('hunter-leg-dark')
    const legLeather = new Assembly('hunter-leg-leather')
    legCloth.add(blob(0.165, 0.38, 0.18, 0.04, 1), 'cloth', { y: -0.20 })
    legDark.add(blob(0.145, 0.36, 0.16, 0.035, 1), 'clothDark', { y: -0.57 })
    legLeather.add(blob(0.155, 0.14, 0.26, 0.03, 1), 'leather', {
      y: -0.83,
      z: -0.04,
    })
    legLeather.add(blob(0.16, 0.10, 0.16, 0.03, 1), 'leather', { y: -0.38 })
    emit(legCloth, leg, map, kit)
    emit(legDark, leg, map, kit)
    emit(legLeather, leg, map, kit)
    root.add(leg)
    return leg
  }

  const legL = makeLeg(mirrorX(0.12))
  const legR = makeLeg(0.12)

  emit(cloth, body, map, kit)
  emit(clothDark, body, map, kit)
  emit(leather, body, map, kit)
  emit(skin, body, map, kit)
  emit(metal, body, map, kit)
  emit(wood, body, map, kit)
  emit(dark, body, map, kit)

  return {
    root,
    body,
    legL,
    legR,
    dispose(): void {
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
      root.clear()
    },
  }
}
