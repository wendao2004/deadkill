/**
 * 程序化资产生成器：用 three 的 GLTFExporter 在 Node 里直接产出 .glb。
 *
 * 为什么不用 Blender：这批资产是**参数化**的（树高、木屋进深、原木堆数量），
 * 用代码生成能保证尺寸与 level.boxes 精确对齐，而且改一个参数就能重出全套，
 * 不需要美术在 Blender 里逐个量尺寸。作者资产上线后可以同名覆盖。
 *
 * 铁律（和引擎侧的约定一致）：
 * - 单位米，1:1；
 * - 原点在底面中心，模型正面朝 -Z；
 * - 每个资产尽量一个材质（顶点色承载配色），一个材质 = 一个 draw call；
 * - 不使用贴图，避免 CSP/加载器负担；需要细节时加几何，不加图。
 *
 * 用法：node tools/gen-models.mjs
 * 输出：client/public/models/generated/*.glb + manifest.json
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as THREE from '../client/node_modules/three/build/three.module.js'
import { GLTFExporter } from '../client/node_modules/three/examples/jsm/exporters/GLTFExporter.js'
import { mergeGeometries } from '../client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js'

const { BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Group, IcosahedronGeometry, Matrix4, Mesh, MeshStandardMaterial, Scene, Vector3, Quaternion, Euler } = THREE

/** GLTFExporter 的二进制导出路径用 FileReader；Node 只缺这一个全局。 */
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null
      this.onload = null
      this.onloadend = null
      this.onerror = null
    }
    #done() {
      this.onload?.({ target: this })
      this.onloadend?.({ target: this })
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf
        this.#done()
      }, (e) => this.onerror?.(e))
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`
        this.#done()
      }, (e) => this.onerror?.(e))
    }
  }
}

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public', 'models', 'generated')

// ------------------------------------------------------------------ 工具

/** mulberry32：与 shared/src/maps/kit.ts 同源，保证每次生成的资产完全一致。 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 给几何体写顶点色（linear 空间：Color 构造时已从 sRGB 转换）。 */
function paint(geo, hex, variance = 0, rand = null) {
  const base = new Color(hex)
  const count = geo.attributes.position.count
  const arr = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const k = variance && rand ? 1 + (rand() - 0.5) * variance : 1
    arr[i * 3] = base.r * k
    arr[i * 3 + 1] = base.g * k
    arr[i * 3 + 2] = base.b * k
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3))
  return geo
}

/**
 * 把一个图元变换后收进 parts。
 *
 * 全部转成非索引：不同图元的索引布局不一样，mergeGeometries 只接受属性集合
 * 完全一致的输入；非索引的代价是顶点多一点，GLB 还是几十 KB 量级。
 */
function part(parts, geo, opts = {}) {
  const { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = 0xffffff, variance = 0, rand = null, mat = 'main' } = opts
  let g = geo.index ? geo.toNonIndexed() : geo
  const m = new Matrix4().compose(
    new Vector3(pos[0], pos[1], pos[2]),
    new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2])),
    new Vector3(scale[0], scale[1], scale[2]),
  )
  g.applyMatrix4(m)
  paint(g, color, variance, rand)
  // 顶点色之外，统一补齐 uv，保证同一资产内所有几何属性集合一致。
  if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
  if (!g.attributes.normal) g.computeVertexNormals()
  parts.push({ geo: g, mat })
}

/** 三角形数（非索引）。 */
function triCount(geo) {
  return geo.attributes.position.count / 3
}

/** 把 parts 按材质合并成一个 Group（每个材质一个 Mesh）。 */
function assemble(name, parts, materials) {
  const byMat = new Map()
  for (const p of parts) {
    const list = byMat.get(p.mat) ?? []
    list.push(p.geo)
    byMat.set(p.mat, list)
  }
  const group = new Group()
  group.name = name
  let tris = 0
  const used = []
  for (const [key, geos] of byMat) {
    const merged = mergeGeometries(geos, false)
    if (!merged) throw new Error(`${name}: 合并 ${key} 失败（属性集合不一致）`)
    for (const g of geos) g.dispose()
    const mat = materials[key]
    if (!mat) throw new Error(`${name}: 未定义材质 ${key}`)
    const mesh = new Mesh(merged, mat)
    mesh.name = `${name}_${key}`
    group.add(mesh)
    tris += triCount(merged)
    used.push(key)
  }
  return { group, tris, materials: used }
}

/** 顶点抖动：让锥体/球体不再像机械件。 */
function jitter(geo, amount, rand, axis = [1, 1, 1]) {
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + (rand() - 0.5) * amount * axis[0],
      pos.getY(i) + (rand() - 0.5) * amount * axis[1],
      pos.getZ(i) + (rand() - 0.5) * amount * axis[2],
    )
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

/** 手工三角形（叶片、山墙）：verts 是 [x,y,z] 三元组，逆序也接受。 */
function triangle(a, b, c) {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array([...a, ...b, ...c]), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0]), 2))
  g.computeVertexNormals()
  return g
}

// ------------------------------------------------------------------ 材质

const MAT = {
  bark: new MeshStandardMaterial({ name: 'bark', color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0 }),
  needle: new MeshStandardMaterial({ name: 'needle', color: 0xffffff, vertexColors: true, roughness: 0.86, metalness: 0, side: THREE.DoubleSide }),
  timber: new MeshStandardMaterial({ name: 'timber', color: 0xffffff, vertexColors: true, roughness: 0.84, metalness: 0 }),
  stone: new MeshStandardMaterial({ name: 'stone', color: 0xffffff, vertexColors: true, roughness: 0.95, metalness: 0 }),
  iron: new MeshStandardMaterial({ name: 'iron', color: 0xffffff, vertexColors: true, roughness: 0.52, metalness: 0.72 }),
  glow: new MeshStandardMaterial({ name: 'glow', color: 0xffffff, emissive: 0xff8a2a, emissiveIntensity: 2.2, vertexColors: true, roughness: 0.6 }),
  ember: new MeshStandardMaterial({ name: 'ember', color: 0xffffff, emissive: 0xff5a12, emissiveIntensity: 1.6, vertexColors: true, roughness: 0.8 }),
}

// ------------------------------------------------------------------ 资产

function pine(seed, { height = 7.5, spread = 2.0, tiers = 7, needles = true }) {
  const rand = rng(seed)
  const parts = []
  // 树干必须**完全包住**关卡里的树干盒子（0.8m 见方）：盒子仍负责碰撞与
  // 断视线，模型细了就会从树皮里透出一根方柱。所以下半段用接近等径的
  // 0.47m 半径圆柱，上半段收细藏进树冠里。
  const trunkR = 0.47
  // 活树的下半段藏进树冠即可；枯树没有树冠，树干必须一直长到枝顶，
  // 否则 4m 以上的枝条会悬在半空，看起来像一群飘着的木棍。
  const trunkH = needles ? height * 0.58 : height * 0.94
  part(parts, new CylinderGeometry(needles ? trunkR * 0.62 : 0.09, trunkR, trunkH, 8), {
    pos: [0, trunkH / 2, 0], color: 0x4e3924, variance: 0.18, rand, mat: 'bark',
  })
  if (needles) {
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1)
      const y = height * (0.28 + t * 0.62)
      const r = spread * (1 - t * 0.72)
      const h = height * 0.16
      const cone = new ConeGeometry(r, h, 7)
      jitter(cone, r * 0.16, rand, [1, 0.25, 1])
      part(parts, cone, {
        pos: [(rand() - 0.5) * 0.12, y, (rand() - 0.5) * 0.12],
        rot: [0, rand() * Math.PI, 0],
        color: i % 2 === 0 ? 0x31502c : 0x274124,
        variance: 0.22,
        rand,
        mat: 'needle',
      })
    }
    // 顶梢
    part(parts, new ConeGeometry(spread * 0.22, height * 0.16, 6), {
      pos: [0, height * 0.95, 0], color: 0x3a5a30, variance: 0.2, rand, mat: 'needle',
    })
  } else {
    // 枯树：每根枝条必须**从树干长出去**。旧写法只绕 Z 转了 90°，所有枝条
    // 都朝同一个方向平飞，看起来像围着树干的碎木棍。现在先沿 +X 摆好
    // （根部在原点），再绕 Y 转到各自的方位角。
    const n = 8
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      const y = height * (0.3 + t * 0.62)
      const len = spread * 1.5 * (1 - t * 0.45)
      const ang = i * 2.39996 + (rand() - 0.5) * 0.5 // 黄金角：枝条不扎堆
      const tilt = 0.42 + rand() * 0.4
      const branch = new CylinderGeometry(0.035, 0.11, len, 5)
      branch.rotateZ(Math.PI / 2 - tilt)
      branch.translate(len / 2, 0, 0)
      part(parts, branch, {
        pos: [0, y, 0],
        rot: [0, -ang, 0],
        color: 0x4a4238, variance: 0.2, rand, mat: 'bark',
      })
    }
  }
  return { parts, tris: 0 }
}

function grassClump(seed) {
  const rand = rng(seed)
  const parts = []
  const blades = 9
  for (let i = 0; i < blades; i++) {
    const ang = (i / blades) * Math.PI * 2 + rand() * 0.5
    const r = 0.03 + rand() * 0.08
    const h = 0.28 + rand() * 0.34
    const bx = Math.cos(ang) * r
    const bz = Math.sin(ang) * r
    const lean = 0.12 + rand() * 0.22
    const tipX = bx + Math.cos(ang) * lean
    const tipZ = bz + Math.sin(ang) * lean
    const w = 0.035
    const px = Math.cos(ang + Math.PI / 2) * w
    const pz = Math.sin(ang + Math.PI / 2) * w
    const g = triangle([bx - px, 0, bz - pz], [bx + px, 0, bz + pz], [tipX, h, tipZ])
    const c0 = new Color(0x2c3a1d)
    const c1 = new Color(0x54672f)
    const colors = new Float32Array([c0.r, c0.g, c0.b, c0.r, c0.g, c0.b, c1.r, c1.g, c1.b])
    g.setAttribute('color', new BufferAttribute(colors, 3))
    if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2))
    parts.push({ geo: g, mat: 'needle' })
  }
  return { parts }
}

function logCabin(seed) {
  const rand = rng(seed)
  const parts = []
  const HX = 3.0
  const HZ = 2.25
  const WALL = 2.9
  const R = 0.19
  const rows = Math.max(4, Math.round(WALL / (R * 2 * 0.94)))
  const doorW = 0.65
  const doorH = rows * R * 2 * 0.62

  // 石基
  part(parts, new BoxGeometry(HX * 2 + 0.5, 0.42, HZ * 2 + 0.5), { pos: [0, 0.21, 0], color: 0x5b594f, variance: 0.12, rand, mat: 'stone' })

  // 原木墙：每根是一根完整的圆柱，转角自然互相咬合。
  for (let i = 0; i < rows; i++) {
    const y = 0.42 + R + i * R * 2 * 0.94
    const shade = i % 2 === 0 ? 0x6b4a2e : 0x5e3f27
    // 前后墙（沿 X）
    for (const z of [-HZ, HZ]) {
      const isFront = z > 0
      const start = isFront && i * R * 2 < doorH ? -doorW : -HX
      const end = isFront && i * R * 2 < doorH ? doorW : HX
      const len = end - start
      part(parts, new CylinderGeometry(R, R, len, 6), {
        pos: [(start + end) / 2, y, z],
        rot: [0, 0, Math.PI / 2],
        color: shade, variance: 0.16, rand, mat: 'timber',
      })
    }
    // 左右墙（沿 Z）
    for (const x of [-HX, HX]) {
      part(parts, new CylinderGeometry(R, R, HZ * 2, 6), {
        pos: [x, y, 0],
        rot: [Math.PI / 2, 0, 0],
        color: shade, variance: 0.16, rand, mat: 'timber',
      })
    }
  }

  // 门与门框
  part(parts, new BoxGeometry(doorW * 2, doorH, 0.1), { pos: [0, 0.42 + doorH / 2, HZ + R * 0.55], color: 0x2f2115, mat: 'timber' })
  part(parts, new BoxGeometry(doorW * 2 + 0.16, 0.12, 0.14), { pos: [0, 0.42 + doorH, HZ + R * 0.55], color: 0x3d2c1c, mat: 'timber' })
  part(parts, new CylinderGeometry(0.04, 0.04, 0.1, 6), { pos: [doorW * 0.7, 0.42 + doorH * 0.5, HZ + R * 0.7], rot: [Math.PI / 2, 0, 0], color: 0x8a7a55, mat: 'iron' })

  // 窗
  const wx = HX - 0.9
  part(parts, new BoxGeometry(1.0, 0.9, 0.08), { pos: [wx, 1.9, HZ + R * 0.55], color: 0x1b2326, mat: 'timber' })
  part(parts, new BoxGeometry(0.08, 0.9, 0.1), { pos: [wx, 1.9, HZ + R * 0.62], color: 0x3d2c1c, mat: 'timber' })
  part(parts, new BoxGeometry(1.0, 0.08, 0.1), { pos: [wx, 1.9, HZ + R * 0.62], color: 0x3d2c1c, mat: 'timber' })

  // 山墙（前后两块三角形）+ 双坡屋顶
  const ridgeY = 0.42 + rows * R * 2 * 0.94 + 1.15
  const eaveY = 0.42 + rows * R * 2 * 0.94
  for (const z of [-HZ, HZ]) {
    part(parts, triangle([-HX, eaveY, z], [HX, eaveY, z], [0, ridgeY, z]), { color: 0x5a3d26, mat: 'timber' })
  }
  const slope = Math.atan2(ridgeY - eaveY, HX)
  const slabLen = Math.hypot(HX + 0.4, ridgeY - eaveY)
  for (const sx of [-1, 1]) {
    part(parts, new BoxGeometry(slabLen, 0.14, HZ * 2 + 0.9), {
      pos: [sx * (HX + 0.4) * 0.5, (ridgeY + eaveY) / 2 + 0.08, 0],
      rot: [0, 0, -sx * slope],
      color: 0x3a2c1f, variance: 0.08, rand, mat: 'timber',
    })
  }
  part(parts, new BoxGeometry(0.32, 0.2, HZ * 2 + 1.0), { pos: [0, ridgeY + 0.16, 0], color: 0x2f2419, mat: 'timber' })

  // 烟囱
  part(parts, new BoxGeometry(0.62, 1.9, 0.62), { pos: [1.7, ridgeY - 0.1, -1.2], color: 0x5b594f, variance: 0.1, rand, mat: 'stone' })
  part(parts, new BoxGeometry(0.78, 0.14, 0.78), { pos: [1.7, ridgeY + 0.87, -1.2], color: 0x4b4a42, mat: 'stone' })

  return { parts }
}

function sawmill(seed) {
  const rand = rng(seed)
  const parts = []
  const HX = 4.2
  const HZ = 3.2
  const H = 3.6
  // 石基
  part(parts, new BoxGeometry(HX * 2 + 0.6, 0.3, HZ * 2 + 0.6), { pos: [0, 0.15, 0], color: 0x55534b, variance: 0.1, rand, mat: 'stone' })
  // 立柱
  for (const x of [-HX, -0.2, HX]) {
    for (const z of [-HZ, HZ]) {
      part(parts, new CylinderGeometry(0.13, 0.16, H, 6), { pos: [x, H / 2, z], color: 0x4d3826, variance: 0.12, rand, mat: 'timber' })
    }
  }
  // 横梁
  for (const z of [-HZ, HZ]) {
    part(parts, new BoxGeometry(HX * 2, 0.18, 0.18), { pos: [0, H - 0.25, z], color: 0x3f2e1f, mat: 'timber' })
  }
  // 单坡屋顶
  part(parts, new BoxGeometry(HX * 2 + 0.8, 0.14, HZ * 2 + 1.0), {
    pos: [0, H + 0.15, 0],
    rot: [0.1, 0, 0],
    color: 0x35291c, variance: 0.08, rand, mat: 'timber',
  })
  // 后墙木板
  for (let i = 0; i < 8; i++) {
    part(parts, new BoxGeometry(HX * 2, 0.3, 0.1), {
      pos: [0, 0.3 + i * 0.36, -HZ + 0.06], color: i % 2 ? 0x5a4128 : 0x4e3823, variance: 0.1, rand, mat: 'timber',
    })
  }
  // 锯片
  part(parts, new CylinderGeometry(0.95, 0.95, 0.06, 18), { pos: [0.6, 1.55, 0], rot: [Math.PI / 2, 0, 0], color: 0x8d9196, mat: 'iron' })
  part(parts, new CylinderGeometry(0.12, 0.12, 0.16, 8), { pos: [0.6, 1.55, 0], rot: [Math.PI / 2, 0, 0], color: 0x4a4d50, mat: 'iron' })
  // 送料台与木料
  part(parts, new BoxGeometry(3.0, 0.16, 1.0), { pos: [-1.6, 0.95, 0.9], color: 0x4d3826, mat: 'timber' })
  for (const z of [0.55, 1.25]) {
    part(parts, new CylinderGeometry(0.22, 0.24, 2.4, 6), { pos: [-1.8, 1.2, z], rot: [0, 0, Math.PI / 2], color: 0x6a4a2e, variance: 0.1, rand, mat: 'timber' })
  }
  // 锯末堆
  part(parts, new ConeGeometry(0.75, 0.5, 8), { pos: [1.9, 0.55, 1.4], color: 0xb9a67c, variance: 0.12, rand, mat: 'timber' })
  return { parts }
}


function waterWheel(seed) {
  const rand = rng(seed)
  const parts = []
  // 水车：轮圈 + 辐条 + 桨叶。轮面在 XY 平面（轴向 Z），直径 4.4m，
  // 是整个营地唯一"会转的轮廓" —— 模型不转，但形状一眼读得出是水车。
  const R = 2.15
  part(parts, new THREE.TorusGeometry(R, 0.14, 6, 20), { color: 0x4a3524, variance: 0.12, rand, mat: 'timber' })
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    part(parts, new BoxGeometry(R * 2, 0.12, 0.12), {
      rot: [0, 0, a],
      color: 0x5a4128, variance: 0.1, rand, mat: 'timber',
    })
    // 桨叶：沿轮缘切向的小板
    part(parts, new BoxGeometry(0.55, 0.12, 0.22), {
      pos: [Math.cos(a) * R, Math.sin(a) * R, 0],
      rot: [0, 0, a],
      color: 0x3f2e20, variance: 0.12, rand, mat: 'timber',
    })
  }
  // 轴与支架：把轮子撑在水面上
  part(parts, new CylinderGeometry(0.12, 0.12, 1.1, 8), { pos: [0, 0, 0.45], rot: [Math.PI / 2, 0, 0], color: 0x3a3d40, mat: 'iron' })
  part(parts, new CylinderGeometry(0.16, 0.2, 2.4, 6), { pos: [0, -1.2, 0.75], color: 0x4a3524, mat: 'timber' })
  part(parts, new CylinderGeometry(0.16, 0.2, 2.4, 6), { pos: [1.9, -1.2, 0.75], color: 0x4a3524, mat: 'timber' })
  // 水槽：从上方引水到轮顶
  part(parts, new BoxGeometry(0.5, 0.24, 2.2), { pos: [0, R + 0.35, 0.2], rot: [0.16, 0, 0], color: 0x5a4128, mat: 'timber' })
  return { parts }
}

function logPile(seed) {
  const rand = rng(seed)
  const parts = []
  const R = 0.24
  const LEN = 3.2
  const rows = [[5, 0], [4, R * 1.7], [3, R * 3.4]]
  for (const [count, y] of rows) {
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * R * 2.15
      part(parts, new CylinderGeometry(R, R * 1.05, LEN, 6), {
        pos: [x, R + y, (rand() - 0.5) * 0.16],
        rot: [Math.PI / 2, 0, 0],
        color: i % 2 ? 0x6b4a2e : 0x5a3d26,
        variance: 0.14,
        rand,
        mat: 'timber',
      })
    }
  }
  return { parts }
}

function stump(seed) {
  const rand = rng(seed)
  const parts = []
  part(parts, new CylinderGeometry(0.4, 0.58, 0.7, 7), { pos: [0, 0.35, 0], color: 0x4a3524, variance: 0.16, rand, mat: 'bark' })
  part(parts, new CylinderGeometry(0.4, 0.4, 0.05, 7), { pos: [0, 0.72, 0], color: 0x8a7048, variance: 0.1, rand, mat: 'timber' })
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rand()
    part(parts, new CylinderGeometry(0.06, 0.14, 0.8, 4), {
      pos: [Math.cos(a) * 0.5, 0.12, Math.sin(a) * 0.5],
      rot: [0, -a, Math.PI / 2 - 0.35],
      color: 0x3d2b1d, variance: 0.15, rand, mat: 'bark',
    })
  }
  return { parts }
}

function rock(seed, size = 1) {
  const rand = rng(seed)
  const parts = []
  const g = new IcosahedronGeometry(1, 0)
  jitter(g, 0.5, rand)
  part(parts, g, { pos: [0, size * 0.55, 0], scale: [size * 1.15, size * 0.8, size], color: 0x5f6059, variance: 0.16, rand, mat: 'stone' })
  return { parts }
}

function lanternPost(seed) {
  const rand = rng(seed)
  const parts = []
  part(parts, new CylinderGeometry(0.07, 0.1, 2.7, 6), { pos: [0, 1.35, 0], color: 0x4a4d50, variance: 0.08, rand, mat: 'iron' })
  part(parts, new BoxGeometry(0.62, 0.07, 0.07), { pos: [0.28, 2.63, 0], color: 0x4a4d50, mat: 'iron' })
  part(parts, new BoxGeometry(0.05, 0.18, 0.05), { pos: [0.56, 2.52, 0], color: 0x4a4d50, mat: 'iron' })
  part(parts, new BoxGeometry(0.26, 0.32, 0.26), { pos: [0.56, 2.3, 0], color: 0x2e3134, mat: 'iron' })
  part(parts, new BoxGeometry(0.18, 0.24, 0.18), { pos: [0.56, 2.29, 0], color: 0xffc27a, mat: 'glow' })
  part(parts, new ConeGeometry(0.22, 0.12, 4), { pos: [0.56, 2.5, 0], rot: [0, Math.PI / 4, 0], color: 0x2e3134, mat: 'iron' })
  return { parts }
}

/** 信号灯：铁柱 + 横臂 + 灯箱 + 灯罩。给车站信号塔/采石场吊臂当顶部剪影。 */
function signalLamp(seed) {
  const rand = rng(seed)
  const parts = []
  part(parts, new CylinderGeometry(0.05, 0.075, 1.6, 6), { pos: [0, 0.8, 0], color: 0x4a4d50, variance: 0.06, rand, mat: 'iron' })
  part(parts, new BoxGeometry(0.52, 0.06, 0.06), { pos: [0.26, 1.56, 0], color: 0x4a4d50, mat: 'iron' })
  part(parts, new BoxGeometry(0.26, 0.34, 0.26), { pos: [0.52, 1.38, 0], color: 0x2e3134, mat: 'iron' })
  part(parts, new BoxGeometry(0.17, 0.24, 0.17), { pos: [0.52, 1.38, 0], color: 0xff6a3a, mat: 'glow' })
  part(parts, new ConeGeometry(0.21, 0.12, 4), { pos: [0.52, 1.6, 0], rot: [0, Math.PI / 4, 0], color: 0x2e3134, mat: 'iron' })
  // 底座：插在塔顶/横臂上
  part(parts, new CylinderGeometry(0.12, 0.16, 0.22, 6), { pos: [0, 0.11, 0], color: 0x3a3d40, mat: 'iron' })
  return { parts }
}

/** 风向标：铁杆 + 十字臂 + 箭头 + 顶球。教堂塔尖的收尾。 */
function weatherVane(seed) {
  const rand = rng(seed)
  const parts = []
  part(parts, new CylinderGeometry(0.035, 0.05, 1.5, 6), { pos: [0, 0.75, 0], color: 0x4a4d50, variance: 0.05, rand, mat: 'iron' })
  part(parts, new BoxGeometry(0.86, 0.055, 0.055), { pos: [0, 1.0, 0], color: 0x4a4d50, mat: 'iron' })
  part(parts, new BoxGeometry(0.055, 0.55, 0.055), { pos: [0, 1.22, 0], color: 0x4a4d50, mat: 'iron' })
  part(parts, new BoxGeometry(0.5, 0.1, 0.035), { pos: [0.3, 1.26, 0], rot: [0, 0, -0.08], color: 0x8d9196, mat: 'iron' })
  part(parts, new ConeGeometry(0.11, 0.3, 4), { pos: [0.62, 1.28, 0], rot: [0, 0, -Math.PI / 2], color: 0x8d9196, mat: 'iron' })
  part(parts, new IcosahedronGeometry(0.1, 0), { pos: [0, 1.55, 0], color: 0x8d9196, mat: 'iron' })
  return { parts }
}

function bonfire(seed) {
  const rand = rng(seed)
  const parts = []
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2
    const g = new IcosahedronGeometry(0.2 + rand() * 0.09, 0)
    jitter(g, 0.08, rand)
    part(parts, g, { pos: [Math.cos(a) * 0.85, 0.15, Math.sin(a) * 0.85], color: 0x55564f, variance: 0.14, rand, mat: 'stone' })
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    part(parts, new CylinderGeometry(0.1, 0.12, 1.5, 5), {
      pos: [Math.cos(a) * 0.32, 0.3, Math.sin(a) * 0.32],
      rot: [Math.PI / 2 - 0.5, a, 0],
      color: 0x3a2a1b, variance: 0.12, rand, mat: 'timber',
    })
  }
  const flame = new ConeGeometry(0.38, 1.1, 6)
  jitter(flame, 0.12, rand, [1, 0.35, 1])
  part(parts, flame, { pos: [0, 0.75, 0], color: 0xff8a2a, mat: 'ember' })
  return { parts }
}

// ------------------------------------------------------------------ 资产表

const ASSETS = [
  { name: 'pine_a', build: () => pine(0x51a1, { height: 8.6, spread: 1.35, tiers: 10 }), tags: ['tree'] },
  { name: 'pine_b', build: () => pine(0x51a2, { height: 7.2, spread: 1.05, tiers: 9 }), tags: ['tree'] },
  { name: 'pine_dead', build: () => pine(0x51a3, { height: 7.4, spread: 1.2, needles: false }), tags: ['tree', 'dead'] },
  { name: 'grass_clump', build: () => grassClump(0x51a4), tags: ['grass'] },
  { name: 'log_cabin_a', build: () => logCabin(0x51a5), tags: ['building'] },
  { name: 'sawmill_a', build: () => sawmill(0x51a6), tags: ['building'] },
  { name: 'log_pile', build: () => logPile(0x51a7), tags: ['prop'] },
  { name: 'stump', build: () => stump(0x51a8), tags: ['prop'] },
  { name: 'rock_a', build: () => rock(0x51a9, 1.0), tags: ['prop'] },
  { name: 'water_wheel', build: () => waterWheel(0x51ac), tags: ['building'] },
  { name: 'signal_lamp', build: () => signalLamp(0x51ad), tags: ['prop', 'light'] },
  { name: 'weather_vane', build: () => weatherVane(0x51ae), tags: ['prop'] },
  { name: 'lantern_post', build: () => lanternPost(0x51aa), tags: ['prop', 'light'] },
  { name: 'bonfire', build: () => bonfire(0x51ab), tags: ['prop', 'light'] },
]

// ------------------------------------------------------------------ 导出

const exporter = new GLTFExporter()
const manifest = { generated: new Date().toISOString(), assets: {} }

async function exportGLB(group) {
  const scene = new Scene()
  scene.add(group)
  const buf = await new Promise((resolve, reject) => {
    exporter.parse(scene, resolve, reject, { binary: true, onlyVisible: false, includeCustomExtensions: false })
  })
  return Buffer.from(buf)
}

for (const asset of ASSETS) {
  const built = asset.build()
  const { group, tris, materials } = assemble(asset.name, built.parts, MAT)
  group.updateMatrixWorld(true)
  // 统一把底面压到 y=0：原点在脚底是引擎侧的硬约定，抖动/旋转会带来
  // 几厘米的误差，这里一次性归零，加载端就不需要逐个补偏移。
  const pre = new THREE.Box3().setFromObject(group)
  if (Math.abs(pre.min.y) > 1e-4) {
    for (const child of group.children) child.position.y -= pre.min.y
    group.updateMatrixWorld(true)
  }
  const box = new THREE.Box3().setFromObject(group)
  const size = new THREE.Vector3()
  box.getSize(size)

  const glb = await exportGLB(group)
  const file = `${asset.name}.glb`
  writeFileSync(join(OUT_DIR, file), glb)
  manifest.assets[asset.name] = {
    file,
    tags: asset.tags,
    triangles: Math.round(tris),
    materials,
    bytes: glb.length,
    /** 包围盒（米）。加载端用它做尺寸校验与自动居中。 */
    bounds: {
      min: [box.min.x, box.min.y, box.min.z].map((v) => +v.toFixed(3)),
      max: [box.max.x, box.max.y, box.max.z].map((v) => +v.toFixed(3)),
    },
    size: [size.x, size.y, size.z].map((v) => +v.toFixed(3)),
  }
  console.log(`${asset.name.padEnd(14)} ${String(Math.round(tris)).padStart(6)} tris  ${(glb.length / 1024).toFixed(1).padStart(6)} KB  ${materials.join('+')}  ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}m`)
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose()
    }
  })
}

writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\n写出 ${ASSETS.length} 个资产 → ${OUT_DIR}`)
