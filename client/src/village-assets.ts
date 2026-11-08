/**
 * CC0 中世纪村庄模块化建筑的"视觉外壳"。
 *
 * 来源：Quaternius Medieval Village MegaKit（CC0），glTF 版本镜像：
 * https://github.com/J-Ponzo/gltf-medieval-village-megakit
 *
 * 只取屋顶/门框/阳台/烟囱/马车/木箱，叠在现有的盒刷建筑上：
 * - 判定仍然由 level.boxes 负责（平屋顶碰撞不动）；
 * - 视觉外壳不参与碰撞，玩家不会被看不见的坡屋顶卡住；
 * - 屋顶坡度只改剪影，不改"能不能站"。
 */

import {
  Box3,
  Group,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { LevelDef } from '@dk/shared'

interface VillageModel {
  scene: Group
  box: Box3
}

export type VillageAssets = Record<string, VillageModel>

interface Materials {
  roof: MeshStandardMaterial
  wood: MeshStandardMaterial
  stone: MeshStandardMaterial
  metal: MeshStandardMaterial
}

const PIECES = [
  'Roof_RoundTiles_4x6',
  'Roof_RoundTiles_6x8',
  'DoorFrame_Flat_WoodDark',
  'Window_Wide_Flat1',
  'Balcony_Simple_Straight',
  'Prop_Chimney',
  'Prop_Wagon',
  'Prop_Crate',
  'Roof_Support2',
] as const

/** 1x1 白图：glTF 引用的贴图我们不用，避免每块 assets 都去 404。 */
const WHITE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII='

export async function loadVillageAssets(): Promise<{ assets: VillageAssets; materials: Materials }> {
  const manager = new LoadingManager()
  manager.setURLModifier((url) => (/\.(png|jpg|jpeg)$/i.test(url) ? WHITE_PNG : url))
  const loader = new GLTFLoader(manager)
  const entries = await Promise.all(
    PIECES.map(async (name) => {
      try {
        const url = new URL(`./models/village/${name}.gltf`, document.baseURI).href
        const gltf = await loader.loadAsync(url)
        gltf.scene.updateMatrixWorld(true)
        const box = new Box3().setFromObject(gltf.scene)
        return [name, { scene: gltf.scene, box }] as const
      } catch (error) {
        console.warn(`[village] ${name}.gltf 加载失败`, error)
        return [name, null] as const
      }
    }),
  )
  const assets: VillageAssets = {}
  for (const [name, model] of entries) if (model) assets[name] = model

  const textureBase = new URL('./models/village/textures/', document.baseURI)
  const textureLoader = new TextureLoader()
  const roofAlbedo = await textureLoader.loadAsync(new URL('roof_albedo.jpg', textureBase).href)
  const roofNormal = await textureLoader.loadAsync(new URL('roof_normal.png', textureBase).href)
  const roofRough = await textureLoader.loadAsync(new URL('roof_roughness.jpg', textureBase).href)
  roofAlbedo.colorSpace = SRGBColorSpace
  roofAlbedo.wrapS = roofAlbedo.wrapT = RepeatWrapping
  roofNormal.wrapS = roofNormal.wrapT = RepeatWrapping
  roofRough.wrapS = roofRough.wrapT = RepeatWrapping

  const roof = new MeshStandardMaterial({
    map: roofAlbedo,
    normalMap: roofNormal,
    roughnessMap: roofRough,
    roughness: 1,
    metalness: 0,
    color: 0x8f8a80,
  })
  const wood = new MeshStandardMaterial({ color: 0x4c3928, roughness: 0.86, metalness: 0 })
  const stone = new MeshStandardMaterial({ color: 0x6a675f, roughness: 0.92, metalness: 0 })
  const metal = new MeshStandardMaterial({ color: 0x4a4d50, roughness: 0.55, metalness: 0.55 })
  return { assets, materials: { roof, wood, stone, metal } }
}

function materialFor(name: string, materials: Materials): MeshStandardMaterial {
  if (/Roof/i.test(name)) return materials.roof
  if (/Chimney|Support/i.test(name)) return materials.stone
  if (/Balcony|Door|Window|Wagon|Crate/i.test(name)) return materials.wood
  return materials.stone
}

interface Placement {
  x: number
  y: number
  z: number
  /** 目标宽/深/高（米）。模型按包围盒等比/非等比缩放。 */
  w: number
  d: number
  h: number
  rotY?: number
}

/** 把一个模型按"目标包围盒"摆到世界里。 */
function place(
  parent: Group,
  model: VillageModel | undefined,
  material: MeshStandardMaterial,
  p: Placement,
): void {
  if (!model) return
  const sizeX = Math.max(0.001, model.box.max.x - model.box.min.x)
  const sizeY = Math.max(0.001, model.box.max.y - model.box.min.y)
  const sizeZ = Math.max(0.001, model.box.max.z - model.box.min.z)
  const clone = model.scene.clone(true)
  clone.position.set(
    -(model.box.min.x + model.box.max.x) / 2,
    -model.box.min.y,
    -(model.box.min.z + model.box.max.z) / 2,
  )
  clone.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    mesh.material = material
    mesh.castShadow = true
    mesh.receiveShadow = true
  })
  const inner = new Group()
  inner.add(clone)
  const outer = new Group()
  outer.add(inner)
  outer.scale.set(p.w / sizeX, p.h / sizeY, p.d / sizeZ)
  outer.position.set(p.x, p.y, p.z)
  outer.rotation.y = p.rotY ?? 0
  parent.add(outer)
}

interface BuildingShell {
  roof: string
  x: number
  z: number
  w: number
  d: number
  top: number
  roofH: number
  rotY?: number
  door?: { x: number; z: number; w: number; h: number; rotY: number }
  props?: { name: string; x: number; z: number; w: number; d: number; h: number; rotY?: number }[]
}

const SHELLS: Record<string, BuildingShell[]> = {
  'marsh-p0': [
    {
      roof: 'Roof_RoundTiles_4x6',
      x: -12,
      z: -10,
      w: 13.4,
      d: 17.4,
      top: 3.7,
      roofH: 2.2,
      door: { x: -12.8, z: -1.95, w: 2.7, h: 2.5, rotY: 0 },
      props: [
        { name: 'Prop_Chimney', x: -16.6, z: -5, w: 1.3, d: 1.3, h: 3.0 },
        { name: 'Balcony_Simple_Straight', x: -12.8, z: -1.4, w: 3.4, d: 1.2, h: 1.2 },
      ],
    },
    {
      roof: 'Roof_RoundTiles_4x6',
      x: 12,
      z: 16,
      w: 16.6,
      d: 12.6,
      top: 5.4,
      roofH: 2.8,
      door: { x: 4.05, z: 16, w: 3.3, h: 3.0, rotY: Math.PI / 2 },
      props: [
        { name: 'Prop_Wagon', x: -3.5, z: 7, w: 3.4, d: 1.7, h: 1.8, rotY: 0.45 },
        { name: 'Prop_Crate', x: 2.2, z: 8.2, w: 1.0, d: 1.0, h: 1.0, rotY: 0.2 },
        { name: 'Prop_Crate', x: 3.0, z: 9.0, w: 0.8, d: 0.8, h: 0.8, rotY: -0.3 },
      ],
    },
  ],
}

// 其余四图的 hero 建筑：坐标是各 zone 的局部坐标 + 区域偏移后的世界坐标。
SHELLS['marsh-p0'].push(...[
  // 磨坊：谷仓（世界 -78,-96，16×10，高 6）与主屋（-98,-75，8×6，高 3.2）
  {
    roof: 'Roof_RoundTiles_4x6',
    x: -78,
    z: -96,
    w: 16.6,
    d: 10.6,
    top: 7.6,
    roofH: 2.6,
    door: { x: -86.0, z: -96, w: 3.3, h: 3.0, rotY: Math.PI / 2 },
  },
  {
    roof: 'Roof_RoundTiles_4x6',
    x: -98,
    z: -75,
    w: 9.0,
    d: 7.0,
    top: 3.8,
    roofH: 1.8,
    door: { x: -98, z: -78, w: 2.7, h: 2.5, rotY: 0 },
  },
  // 教堂祠堂（104,-80，6×6，高 3.2）
  {
    roof: 'Roof_RoundTiles_4x6',
    x: 104,
    z: -80,
    w: 7.0,
    d: 7.0,
    top: 3.6,
    roofH: 1.8,
    door: { x: 104, z: -77, w: 2.7, h: 2.5, rotY: 0 },
  },
  // 采石场工具棚（70,68，8×8，高 2.8）
  {
    roof: 'Roof_RoundTiles_4x6',
    x: 70,
    z: 68,
    w: 9.0,
    d: 9.0,
    top: 3.2,
    roofH: 1.6,
    door: { x: 70, z: 72, w: 2.7, h: 2.5, rotY: 0 },
  },
  // 车站货棚（34,110，8×6，高 3.2）
  {
    roof: 'Roof_RoundTiles_4x6',
    x: 34,
    z: 110,
    w: 9.0,
    d: 7.0,
    top: 3.8,
    roofH: 1.8,
    door: { x: 30.05, z: 110, w: 2.7, h: 2.5, rotY: Math.PI / 2 },
  },
])

export function decorateVillage(
  parent: Group,
  level: LevelDef,
  assets: VillageAssets,
  materials: Materials,
): void {
  const shells = SHELLS[level.id]
  if (!shells) return
  for (const shell of shells) {
    const y = level.groundY + shell.top
    place(parent, assets[shell.roof], materials.roof, {
      x: shell.x,
      y,
      z: shell.z,
      w: shell.w,
      d: shell.d,
      h: shell.roofH,
      rotY: shell.rotY,
    })
    if (shell.door) {
      place(parent, assets.DoorFrame_Flat_WoodDark, materials.wood, {
        x: shell.door.x,
        y: level.groundY,
        z: shell.door.z,
        w: shell.door.w,
        d: 0.35,
        h: shell.door.h,
        rotY: shell.door.rotY,
      })
    }
    for (const prop of shell.props ?? []) {
      place(parent, assets[prop.name], materialFor(prop.name, materials), {
        x: prop.x,
        y: level.groundY,
        z: prop.z,
        w: prop.w,
        d: prop.d,
        h: prop.h,
        rotY: prop.rotY,
      })
    }
  }
}
