/**
 * 程序化生成资产（tools/gen-models.mjs 产出）的加载与实例化。
 *
 * 和 village-assets / nature-assets 的分工：
 * - 那两个加载的是外部 CC0 包，模型带着自己的材质和层级；
 * - 这里的资产是**我们自己生成的**，所以约定更硬：原点在脚底、正面朝 -Z、
 *   单位米、每个资产 1~3 个材质。加载端因此可以放心地批量实例化。
 *
 * 所有资产都用 InstancedMesh 落位，并按 64m 网格分块：整张图一个 InstancedMesh
 * 会让视锥剔除完全失效（一个包围球罩住整張图），分块之后背对玩家的那一片
 * 真的不会被提交。分块只增加几个 draw call，换来的是可预测的顶点率。
 */

import {
  Box3,
  Color,
  Group,
  InstancedMesh,
  LoadingManager,
  Matrix4,
  Mesh,
  Quaternion,
  StaticDrawUsage,
  Vector3,
} from 'three'
import type { BufferGeometry, Material, Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export interface GeneratedManifestEntry {
  file: string
  tags: string[]
  triangles: number
  materials: string[]
  bytes: number
  bounds: { min: [number, number, number]; max: [number, number, number] }
  size: [number, number, number]
}

export interface GeneratedManifest {
  generated: string
  assets: Record<string, GeneratedManifestEntry>
}

export interface GeneratedAsset {
  name: string
  scene: Group
  size: Vector3
  tags: string[]
  triangles: number
}

export type GeneratedAssets = Map<string, GeneratedAsset>

/** 一个实例的落位。y 默认 0（资产原点就在脚底）。 */
export interface Placement {
  x: number
  z: number
  y?: number
  rotY?: number
  scale?: number
  /** 0xRRGGBB；实例色与顶点色相乘，用来打破"一片树一个绿"。 */
  tint?: number
}

export interface InstanceOptions {
  /** 空间分块边长（米）。0 = 不分块（只适合少量、集中摆放的资产）。 */
  chunk?: number
  castShadow?: boolean
  receiveShadow?: boolean
  /**
   * 墨线材质。手绘档下每个实例会再挂一份同矩阵的 InstancedMesh 画背面外壳；
   * 写实档或草这类细碎物件不传。
   */
  outline?: Material
}

const MANIFEST_URL = './models/generated/manifest.json'

/** 加载清单与全部 GLB。任何一个资产失败只跳过它，不拖垮整张图。 */
export async function loadGeneratedAssets(): Promise<GeneratedAssets> {
  const manifestUrl = new URL(MANIFEST_URL, document.baseURI).href
  const res = await fetch(manifestUrl)
  if (!res.ok) throw new Error(`manifest ${res.status}`)
  const manifest = (await res.json()) as GeneratedManifest

  const manager = new LoadingManager()
  const loader = new GLTFLoader(manager)
  const assets: GeneratedAssets = new Map()

  await Promise.all(
    Object.entries(manifest.assets).map(async ([name, entry]) => {
      try {
        const url = new URL(`./models/generated/${entry.file}`, document.baseURI).href
        const gltf = await loader.loadAsync(url)
        gltf.scene.updateMatrixWorld(true)
        const box = new Box3().setFromObject(gltf.scene)
        const size = new Vector3()
        box.getSize(size)
        assets.set(name, {
          name,
          scene: gltf.scene,
          size,
          tags: entry.tags ?? [],
          triangles: entry.triangles ?? 0,
        })
      } catch (error) {
        console.warn(`[generated] ${name} 加载失败`, error)
      }
    }),
  )
  return assets
}

/** 取某个资产的所有网格（已带好资产内部的世界矩阵）。 */
function meshesOf(asset: GeneratedAsset): { mesh: Mesh; matrix: Matrix4 }[] {
  const out: { mesh: Mesh; matrix: Matrix4 }[] = []
  asset.scene.updateMatrixWorld(true)
  asset.scene.traverse((child: Object3D) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    out.push({ mesh, matrix: mesh.matrixWorld.clone() })
  })
  return out
}

/**
 * 把一批落位烘成 InstancedMesh 挂到 parent 上。
 *
 * 返回创建出来的实例网格，调用方一般不需要它们（销毁随场景一起走）。
 */
export function instanceAsset(
  parent: Object3D,
  asset: GeneratedAsset,
  placements: Placement[],
  options: InstanceOptions = {},
): InstancedMesh[] {
  if (placements.length === 0) return []
  const chunk = options.chunk ?? 0
  const buckets = new Map<string, Placement[]>()
  for (const p of placements) {
    const key = chunk > 0 ? `${Math.floor(p.x / chunk)}:${Math.floor(p.z / chunk)}` : 'all'
    const list = buckets.get(key)
    if (list) list.push(p)
    else buckets.set(key, [p])
  }

  const meshes = meshesOf(asset)
  const result: InstancedMesh[] = []
  const pos = new Vector3()
  const quat = new Quaternion()
  const scl = new Vector3()
  const matrix = new Matrix4()
  const tint = new Color()

  for (const list of buckets.values()) {
    for (const { mesh, matrix: local } of meshes) {
      const inst = new InstancedMesh(mesh.geometry as BufferGeometry, mesh.material as Material, list.length)
      inst.name = `${asset.name}:${inst.id}`
      inst.instanceMatrix.setUsage(StaticDrawUsage)
      inst.castShadow = options.castShadow ?? true
      inst.receiveShadow = options.receiveShadow ?? true
      let tinted = false
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!
        pos.set(p.x, p.y ?? 0, p.z)
        quat.setFromAxisAngle(new Vector3(0, 1, 0), p.rotY ?? 0)
        const s = p.scale ?? 1
        scl.set(s, s, s)
        matrix.compose(pos, quat, scl)
        matrix.multiply(local)
        inst.setMatrixAt(i, matrix)
        if (p.tint !== undefined) {
          tint.setHex(p.tint)
          inst.setColorAt(i, tint)
          tinted = true
        }
      }
      inst.instanceMatrix.needsUpdate = true
      if (tinted && inst.instanceColor) inst.instanceColor.needsUpdate = true
      inst.computeBoundingSphere()
      parent.add(inst)
      result.push(inst)

      if (options.outline) {
        // 描边实例与本体共享矩阵：只多一次 draw call，不复制顶点数据。
        const hull = new InstancedMesh(mesh.geometry as BufferGeometry, options.outline, list.length)
        hull.instanceMatrix = inst.instanceMatrix
        hull.castShadow = false
        hull.receiveShadow = false
        hull.raycast = () => {}
        hull.computeBoundingSphere()
        parent.add(hull)
      }
    }
  }
  return result
}
