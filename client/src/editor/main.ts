/**
 * DEAD KILL 3D 地图编辑器。
 *
 * 数据模型和游戏完全同源：
 * - 盒刷 = BoxBrush（中心 + 半长 + 材质 + rotY/noCollide/noRender）；
 * - 标记 = LevelDef 的 spawns / nests / clues / extracts / zones / water；
 * - 模型 = LevelDef.heroes（asset + 位置/朝向/缩放），GLB 放在
 *   `client/public/models/imported/<asset>.glb`，加载器按 asset 名找它。
 *
 * 3D 视图用 three + OrbitControls + TransformControls：
 * - 右键拖动旋转、中键平移、滚轮缩放；
 * - 左键选择 / 画盒刷 / 放标记；
 * - 选中后用 W/E/R 切换移动/旋转/缩放，或直接在右侧改数值。
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

type Mat = 'wood' | 'stone' | 'mud' | 'metal' | 'foliage'
type Tool = 'select' | 'box' | 'spawn' | 'nest' | 'clue' | 'extract' | 'zone' | 'water'
type MarkerKind = 'spawn' | 'nest' | 'clue' | 'extract' | 'zone' | 'water'
type NestKind = 'grunt' | 'gunner' | 'hound'

interface EBox {
  x: number
  z: number
  hx: number
  hz: number
  bottom: number
  top: number
  rotY: number
  material: Mat
  noCollide: boolean
  noRender: boolean
}

interface EMarker {
  kind: MarkerKind
  x: number
  z: number
  name: string
  radius: number
  hx: number
  hz: number
  nestKind: NestKind
}

interface EModel {
  /** 资产名 = GLB 文件名（不含扩展名）。导出的 heroes.asset 用它。 */
  name: string
  /** 原始文件名，给"我该把哪个文件放进 imported/"的提示用。 */
  file: string
  x: number
  z: number
  y: number
  rotY: number
  scale: number
}

interface Doc {
  id: string
  name: string
  biome: string
  boundsHalf: number
  groundY: number
  groundMaterial: Mat
  fogColor: string
  fogDensity: number
  boxes: EBox[]
  markers: EMarker[]
  models: EModel[]
}

type Selection = { type: 'box' | 'marker' | 'model'; index: number } | null

const SNAP = 0.4
const MATERIALS: Mat[] = ['wood', 'stone', 'mud', 'metal', 'foliage']
const MAT_COLORS: Record<Mat, number> = {
  wood: 0x6b4a2e,
  stone: 0x6a6a62,
  mud: 0x51493a,
  metal: 0x4a4d50,
  foliage: 0x2f4a2a,
}
const MAT_LABEL: Record<Mat, string> = { wood: '木', stone: '石', mud: '泥', metal: '铁', foliage: '叶' }

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP
}

function newDoc(): Doc {
  return {
    id: 'my-map',
    name: '新地图',
    biome: 'forest',
    boundsHalf: 100,
    groundY: 0,
    groundMaterial: 'mud',
    fogColor: '#16202a',
    fogDensity: 0.0125,
    boxes: [],
    markers: [],
    models: [],
  }
}

// ---------------------------------------------------------------- DOM

const mapName = document.getElementById('mapName') as HTMLInputElement
const propsEl = document.getElementById('props') as HTMLDivElement
const settingsEl = document.getElementById('mapSettings') as HTMLDivElement
const reportEl = document.getElementById('report') as HTMLDivElement
const statusEls = {
  cur: document.getElementById('cur') as HTMLElement,
  zoom: document.getElementById('zoom') as HTMLElement,
  count: document.getElementById('count') as HTMLElement,
  sel: document.getElementById('sel') as HTMLElement,
}
const fileInput = document.getElementById('fileInput') as HTMLInputElement
const modelInput = document.getElementById('modelInput') as HTMLInputElement

// ---------------------------------------------------------------- 状态

let doc: Doc = newDoc()
let tool: Tool = 'select'
let selection: Selection = null
let transformMode: 'translate' | 'rotate' | 'scale' = 'translate'
const history: string[] = []
const future: string[] = []
/** 导入的原始文件：导出时提示用户把哪个文件拷到哪。 */
const modelFiles = new Map<string, File>()

// ---------------------------------------------------------------- three

const canvas = document.getElementById('view') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(0x0f1214, 1)

const scene = new THREE.Scene()
scene.fog = new THREE.FogExp2(0x0f1214, 0.0016)

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000)
camera.position.set(40, 55, 70)

const controls = new OrbitControls(camera, canvas)
controls.target.set(0, 0, 0)
controls.enableDamping = true
controls.dampingFactor = 0.12
controls.maxPolarAngle = Math.PI * 0.495
// 左键留给选择和画盒；旋转用右键，平移用中键。
controls.mouseButtons.LEFT = -1 as unknown as THREE.MOUSE
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE

const transform = new TransformControls(camera, canvas)
transform.setSize(0.9)
scene.add(transform.getHelper())
transform.addEventListener('dragging-changed', (e) => {
  controls.enabled = !(e as unknown as { value: boolean }).value
})
transform.addEventListener('objectChange', () => {
  syncDataFromObject()
  requestRender()
})

// 光：编辑不需要氛围，只要形体读得出来。
scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x2a2118, 1.4))
const sun = new THREE.DirectionalLight(0xfff1d6, 1.6)
sun.position.set(40, 80, 30)
scene.add(sun)

const groundGroup = new THREE.Group()
const boxGroup = new THREE.Group()
const markerGroup = new THREE.Group()
const modelGroup = new THREE.Group()
scene.add(groundGroup, boxGroup, markerGroup, modelGroup)

const raycaster = new THREE.Raycaster()
const pointerNdc = new THREE.Vector2()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const hitPoint = new THREE.Vector3()

let selectedObject: THREE.Object3D | null = null
let selectionHelper: THREE.BoxHelper | null = null
let down: { x: number; y: number } | null = null
let creating: { start: THREE.Vector3; mesh: THREE.Mesh } | null = null
let pointer = { x: 0, z: 0 }

// ---------------------------------------------------------------- 场景重建

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
    }
  })
}

function disposeGroup(group: THREE.Group): void {
  group.children.forEach((child) => disposeObject(child))
  group.clear()
}

function rebuildScene(): void {
  disposeGroup(boxGroup)
  disposeGroup(markerGroup)
  disposeGroup(groundGroup)
  transform.detach()
  selectedObject = null
  if (selectionHelper) {
    scene.remove(selectionHelper)
    selectionHelper.geometry.dispose()
    selectionHelper = null
  }

  groundPlane.constant = -doc.groundY
  buildGround()
  doc.boxes.forEach((b, i) => boxGroup.add(buildBoxMesh(b, i)))
  doc.markers.forEach((m, i) => markerGroup.add(buildMarker(m, i)))
  doc.models.forEach((m, i) => {
    const obj = modelGroup.children[i]
    if (obj) {
      obj.position.set(m.x, m.y, m.z)
      obj.rotation.y = m.rotY
      obj.scale.setScalar(m.scale)
      obj.userData = { kind: 'model', index: i }
    }
  })
  updateStatus()
  requestRender()
}

function buildGround(): void {
  const size = doc.boundsHalf * 2
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: 0x1a2024, roughness: 1, metalness: 0 }),
  )
  plane.rotation.x = -Math.PI / 2
  plane.position.y = doc.groundY - 0.01
  plane.userData = { kind: 'ground' }
  groundGroup.add(plane)

  const grid = new THREE.GridHelper(size, Math.max(2, Math.round(size / 2)), 0x3a4650, 0x243039)
  grid.position.y = doc.groundY
  groundGroup.add(grid)

  const h = doc.boundsHalf
  const points = [
    new THREE.Vector3(-h, doc.groundY, -h),
    new THREE.Vector3(h, doc.groundY, -h),
    new THREE.Vector3(h, doc.groundY, h),
    new THREE.Vector3(-h, doc.groundY, h),
    new THREE.Vector3(-h, doc.groundY, -h),
  ]
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xd99a4a }),
  )
  groundGroup.add(line)
}

function buildBoxMesh(b: EBox, index: number): THREE.Mesh {
  const height = Math.max(0.05, b.top - b.bottom)
  const geo = new THREE.BoxGeometry(b.hx * 2, height, b.hz * 2)
  const material = new THREE.MeshStandardMaterial({
    color: MAT_COLORS[b.material],
    roughness: 0.92,
    metalness: b.material === 'metal' ? 0.45 : 0.02,
    transparent: b.noRender,
    opacity: b.noRender ? 0.28 : 1,
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.set(b.x, (b.bottom + b.top) / 2, b.z)
  mesh.rotation.y = b.rotY
  mesh.userData = { kind: 'box', index }
  return mesh
}

function buildMarker(m: EMarker, index: number): THREE.Object3D {
  const group = new THREE.Group()
  group.position.set(m.x, doc.groundY, m.z)
  group.userData = { kind: 'marker', index }
  const color = m.kind === 'spawn' ? 0x6fbf73
    : m.kind === 'nest' ? 0xc0554a
      : m.kind === 'clue' ? 0xd9b64a
        : m.kind === 'extract' ? 0x5aa9c9
          : 0x8d8578
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, emissive: color, emissiveIntensity: 0.35 })

  if (m.kind === 'spawn') {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.8, 10), mat)
    mesh.position.y = 0.9
    group.add(mesh)
  } else if (m.kind === 'nest') {
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 6), mat)
    mesh.position.y = 1.1
    group.add(mesh)
  } else if (m.kind === 'clue') {
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.9, 0), mat)
    mesh.position.y = 1.1
    group.add(mesh)
  } else if (m.kind === 'extract') {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), mat)
    mesh.position.y = 0.8
    group.add(mesh)
  } else if (m.kind === 'zone') {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.5, m.radius - 0.2), m.radius, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.02
    group.add(ring)
  } else {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(m.hx * 2, m.hz * 2),
      new THREE.MeshBasicMaterial({ color: 0x2a6a8a, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
    )
    water.rotation.x = -Math.PI / 2
    water.position.y = 0.03
    group.add(water)
  }
  return group
}

// ---------------------------------------------------------------- 坐标 / 拾取

function updatePointer(e: PointerEvent): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect()
  pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointerNdc, camera)
  const hit = raycaster.ray.intersectPlane(groundPlane, hitPoint)
  if (!hit) return null
  pointer = { x: hit.x, z: hit.z }
  statusEls.cur.textContent = `${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}`
  return hit.clone()
}

function pick(): { kind: string; index: number; object: THREE.Object3D } | null {
  raycaster.setFromCamera(pointerNdc, camera)
  const hits = raycaster.intersectObjects([boxGroup, markerGroup, modelGroup], true)
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object
    while (obj && !obj.userData?.kind) obj = obj.parent
    if (obj && obj.userData.kind !== 'ground') {
      return { kind: obj.userData.kind as string, index: obj.userData.index as number, object: obj }
    }
  }
  return null
}

function select(item: { type: 'box' | 'marker' | 'model'; index: number } | null): void {
  selection = item
  transform.detach()
  if (selectionHelper) {
    scene.remove(selectionHelper)
    selectionHelper.geometry.dispose()
    selectionHelper = null
  }
  selectedObject = null
  if (item) {
    const root = item.type === 'box' ? boxGroup : item.type === 'marker' ? markerGroup : modelGroup
    const obj = root.children[item.index]
    if (obj) {
      selectedObject = obj
      transform.attach(obj)
      transform.setMode(item.type === 'model' ? transformMode : 'translate')
      transform.showY = false
      transform.showX = item.type !== 'marker'
      transform.showZ = item.type !== 'marker'
      if (item.type === 'box' || item.type === 'marker') {
        selectionHelper = new THREE.BoxHelper(obj, 0xffc86a)
        scene.add(selectionHelper)
      }
    }
  }
  rebuildProps()
  updateStatus()
  requestRender()
}

function syncDataFromObject(): void {
  if (!selection || !selectedObject) return
  if (selection.type === 'box') {
    const b = doc.boxes[selection.index]
    if (!b) return
    b.x = snap(selectedObject.position.x)
    b.z = snap(selectedObject.position.z)
    b.rotY = selectedObject.rotation.y
    selectedObject.position.x = b.x
    selectedObject.position.z = b.z
    selectedObject.position.y = (b.bottom + b.top) / 2
  } else if (selection.type === 'marker') {
    const m = doc.markers[selection.index]
    if (!m) return
    m.x = snap(selectedObject.position.x)
    m.z = snap(selectedObject.position.z)
    selectedObject.position.x = m.x
    selectedObject.position.z = m.z
  } else {
    const m = doc.models[selection.index]
    if (!m) return
    m.x = snap(selectedObject.position.x)
    m.z = snap(selectedObject.position.z)
    m.y = Math.round(selectedObject.position.y * 100) / 100
    m.rotY = selectedObject.rotation.y
    m.scale = Math.round(selectedObject.scale.x * 100) / 100
  }
  rebuildProps()
}

// ---------------------------------------------------------------- 指针交互

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  updatePointer(e)
  down = { x: e.clientX, y: e.clientY }
  if (tool === 'box') {
    creating = { start: hitPoint.clone(), mesh: createPreviewBox() }
    pushHistory()
  }
})

canvas.addEventListener('pointermove', (e) => {
  updatePointer(e)
  if (creating) {
    const x0 = Math.min(creating.start.x, pointer.x)
    const x1 = Math.max(creating.start.x, pointer.x)
    const z0 = Math.min(creating.start.z, pointer.z)
    const z1 = Math.max(creating.start.z, pointer.z)
    const hx = Math.max(SNAP / 2, (x1 - x0) / 2)
    const hz = Math.max(SNAP / 2, (z1 - z0) / 2)
    creating.mesh.position.set((x0 + x1) / 2, doc.groundY + 1, (z0 + z1) / 2)
    creating.mesh.scale.set(hx * 2, 2, hz * 2)
    requestRender()
  }
})

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !down) return
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)

  if (creating) {
    const x0 = Math.min(creating.start.x, pointer.x)
    const x1 = Math.max(creating.start.x, pointer.x)
    const z0 = Math.min(creating.start.z, pointer.z)
    const z1 = Math.max(creating.start.z, pointer.z)
    const hx = Math.max(SNAP / 2, (x1 - x0) / 2)
    const hz = Math.max(SNAP / 2, (z1 - z0) / 2)
    if (x1 - x0 >= SNAP && z1 - z0 >= SNAP) {
      doc.boxes.push({
        x: snap((x0 + x1) / 2),
        z: snap((z0 + z1) / 2),
        hx,
        hz,
        bottom: doc.groundY,
        top: doc.groundY + 2.0,
        rotY: 0,
        material: 'wood',
        noCollide: false,
        noRender: false,
      })
      boxGroup.add(buildBoxMesh(doc.boxes[doc.boxes.length - 1]!, doc.boxes.length - 1))
      select({ type: 'box', index: doc.boxes.length - 1 })
    }
    if (creating.mesh.parent) creating.mesh.parent.remove(creating.mesh)
    disposeObject(creating.mesh)
    creating = null
    down = null
    requestRender()
    return
  }

  if (moved <= 4) {
    if (tool === 'select') {
      const hit = pick()
      if (hit && (hit.kind === 'box' || hit.kind === 'marker' || hit.kind === 'model')) {
        select({ type: hit.kind, index: hit.index })
      } else {
        select(null)
      }
    } else if (tool !== 'box') {
      pushHistory()
      doc.markers.push(defaultMarker(tool, snap(pointer.x), snap(pointer.z)))
      markerGroup.add(buildMarker(doc.markers[doc.markers.length - 1]!, doc.markers.length - 1))
      select({ type: 'marker', index: doc.markers.length - 1 })
    }
  }
  down = null
  requestRender()
})

function createPreviewBox(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xd99a4a, transparent: true, opacity: 0.35, depthWrite: false }),
  )
  scene.add(mesh)
  return mesh
}

// ---------------------------------------------------------------- 面板

function defaultMarker(kind: MarkerKind, x: number, z: number): EMarker {
  return {
    kind,
    x,
    z,
    name: kind === 'extract' ? '撤离点' : kind === 'zone' ? '区域' : '',
    radius: 24,
    hx: 6,
    hz: 4,
    nestKind: 'grunt',
  }
}

function rebuildProps(): void {
  propsEl.innerHTML = ''
  const sel = selection
  if (!sel) {
    propsEl.innerHTML = '<p class="hint">选中盒刷 / 标记 / 模型后，在这里改属性。</p>'
    return
  }
  const h = document.createElement('h2')
  if (sel.type === 'box') {
    const b = doc.boxes[sel.index]
    if (!b) return
    h.textContent = '盒刷'
    propsEl.appendChild(h)
    field('中心 X', b.x, (v) => { b.x = snap(v); applyBoxTransform(sel.index) })
    field('中心 Z', b.z, (v) => { b.z = snap(v); applyBoxTransform(sel.index) })
    field('半宽 X', b.hx, (v) => { b.hx = Math.max(SNAP / 2, snap(v)); rebuildBox(sel.index) })
    field('半宽 Z', b.hz, (v) => { b.hz = Math.max(SNAP / 2, snap(v)); rebuildBox(sel.index) })
    field('底面 Y', b.bottom, (v) => { b.bottom = snap(v); rebuildBox(sel.index) })
    field('顶面 Y', b.top, (v) => { b.top = snap(v); rebuildBox(sel.index) })
    field('旋转°', (b.rotY * 180) / Math.PI, (v) => { b.rotY = (v * Math.PI) / 180; applyBoxTransform(sel.index) })
    const mat = document.createElement('select')
    for (const m of MATERIALS) {
      const o = document.createElement('option')
      o.value = m
      o.textContent = MAT_LABEL[m] + ' · ' + m
      if (m === b.material) o.selected = true
      mat.appendChild(o)
    }
    mat.addEventListener('change', () => { b.material = mat.value as Mat; rebuildBox(sel.index) })
    wrapField('材质', mat)
    check('不碰撞（noCollide）', b.noCollide, (v) => { b.noCollide = v })
    check('不渲染（noRender）', b.noRender, (v) => { b.noRender = v; rebuildBox(sel.index) })
  } else if (sel.type === 'marker') {
    const m = doc.markers[sel.index]
    if (!m) return
    h.textContent = '标记 · ' + markerLabel(m.kind)
    propsEl.appendChild(h)
    field('X', m.x, (v) => { m.x = snap(v); applyMarkerTransform(sel.index) })
    field('Z', m.z, (v) => { m.z = snap(v); applyMarkerTransform(sel.index) })
    if (m.kind === 'nest') {
      const sel2 = document.createElement('select')
      for (const k of ['grunt', 'gunner', 'hound']) {
        const o = document.createElement('option')
        o.value = k
        o.textContent = k
        if (k === m.nestKind) o.selected = true
        sel2.appendChild(o)
      }
      sel2.addEventListener('change', () => { m.nestKind = sel2.value as NestKind })
      wrapField('种类', sel2)
    }
    if (m.kind === 'extract' || m.kind === 'zone' || m.kind === 'clue') {
      const input = document.createElement('input')
      input.value = m.name
      input.placeholder = m.kind === 'clue' ? '线索文案' : '名称'
      input.addEventListener('input', () => { m.name = input.value })
      wrapField('名称', input)
    }
    if (m.kind === 'zone') field('半径', m.radius, (v) => { m.radius = Math.max(1, v); rebuildScene() })
    if (m.kind === 'water') {
      field('半宽 X', m.hx, (v) => { m.hx = Math.max(0.5, v); rebuildScene() })
      field('半宽 Z', m.hz, (v) => { m.hz = Math.max(0.5, v); rebuildScene() })
    }
  } else {
    const m = doc.models[sel.index]
    if (!m) return
    h.textContent = '模型 · ' + m.name
    propsEl.appendChild(h)
    field('X', m.x, (v) => { m.x = snap(v); applyModelTransform(sel.index) })
    field('Z', m.z, (v) => { m.z = snap(v); applyModelTransform(sel.index) })
    field('高度 Y', m.y, (v) => { m.y = v; applyModelTransform(sel.index) })
    field('旋转°', (m.rotY * 180) / Math.PI, (v) => { m.rotY = (v * Math.PI) / 180; applyModelTransform(sel.index) })
    field('缩放', m.scale, (v) => { m.scale = Math.max(0.01, v); applyModelTransform(sel.index) })
    const file = modelFiles.get(m.name)
    if (file) {
      const btn = document.createElement('button')
      btn.textContent = '下载模型文件'
      btn.style.marginTop = '8px'
      btn.addEventListener('click', () => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(file)
        a.download = file.name
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      })
      propsEl.appendChild(btn)
    }
  }
  const del = document.createElement('button')
  del.textContent = '删除选中（Delete）'
  del.style.marginTop = '10px'
  del.addEventListener('click', () => deleteSelected())
  propsEl.appendChild(del)
}

function field(label: string, value: number, onChange: (v: number) => void): void {
  const row = document.createElement('div')
  row.className = 'field'
  const lab = document.createElement('label')
  lab.textContent = label
  const input = document.createElement('input')
  input.type = 'number'
  input.step = String(SNAP)
  input.value = String(Math.round(value * 100) / 100)
  input.addEventListener('change', () => {
    pushHistory()
    onChange(Number(input.value))
    updateStatus()
    requestRender()
  })
  row.append(lab, input)
  propsEl.appendChild(row)
}

function wrapField(label: string, el: HTMLElement): void {
  const row = document.createElement('div')
  row.className = 'field'
  const lab = document.createElement('label')
  lab.textContent = label
  row.append(lab, el)
  propsEl.appendChild(row)
}

function check(label: string, value: boolean, onChange: (v: boolean) => void): void {
  const row = document.createElement('label')
  row.className = 'check'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = value
  input.addEventListener('change', () => { pushHistory(); onChange(input.checked); updateStatus() })
  row.append(input, document.createTextNode(label))
  propsEl.appendChild(row)
}

function markerLabel(kind: MarkerKind): string {
  return kind === 'spawn' ? '出生点' : kind === 'nest' ? '巢穴' : kind === 'clue' ? '线索'
    : kind === 'extract' ? '撤离' : kind === 'zone' ? '区域' : '水面'
}

function applyBoxTransform(index: number): void {
  const b = doc.boxes[index]
  const obj = boxGroup.children[index]
  if (!b || !obj) return
  obj.position.set(b.x, (b.bottom + b.top) / 2, b.z)
  obj.rotation.y = b.rotY
  requestRender()
}

function rebuildBox(index: number): void {
  const b = doc.boxes[index]
  if (!b) return
  const old = boxGroup.children[index]
  if (old) {
    boxGroup.remove(old)
    disposeObject(old)
  }
  boxGroup.add(buildBoxMesh(b, index))
  if (selection?.type === 'box' && selection.index === index) {
    if (selectionHelper) {
      scene.remove(selectionHelper)
      selectionHelper.geometry.dispose()
    }
    selectionHelper = new THREE.BoxHelper(boxGroup.children[index]!, 0xffc86a)
    scene.add(selectionHelper)
  }
  requestRender()
}

function applyMarkerTransform(index: number): void {
  const m = doc.markers[index]
  const obj = markerGroup.children[index]
  if (!m || !obj) return
  obj.position.set(m.x, doc.groundY, m.z)
  requestRender()
}

function applyModelTransform(index: number): void {
  const m = doc.models[index]
  const obj = modelGroup.children[index]
  if (!m || !obj) return
  obj.position.set(m.x, m.y, m.z)
  obj.rotation.y = m.rotY
  obj.scale.setScalar(m.scale)
  requestRender()
}

function deleteSelected(): void {
  if (!selection) return
  pushHistory()
  transform.detach()
  if (selection.type === 'box') {
    doc.boxes.splice(selection.index, 1)
    const obj = boxGroup.children[selection.index]
    if (obj) { boxGroup.remove(obj); disposeObject(obj) }
  } else if (selection.type === 'marker') {
    doc.markers.splice(selection.index, 1)
    const obj = markerGroup.children[selection.index]
    if (obj) { markerGroup.remove(obj); disposeObject(obj) }
  } else {
    doc.models.splice(selection.index, 1)
    const obj = modelGroup.children[selection.index]
    if (obj) modelGroup.remove(obj)
  }
  selection = null
  rebuildScene()
}

function updateStatus(): void {
  const sel = selection
  statusEls.count.textContent = String(doc.boxes.length)
  statusEls.sel.textContent = sel
    ? sel.type === 'box'
      ? `盒刷 #${sel.index}`
      : sel.type === 'marker'
        ? markerLabel(doc.markers[sel.index]?.kind ?? 'zone')
        : `模型 ${doc.models[sel.index]?.name ?? ''}`
    : '无'
}

// ---------------------------------------------------------------- 地图设置

function rebuildSettings(): void {
  settingsEl.innerHTML = ''
  const add = (label: string, input: HTMLElement): void => {
    const row = document.createElement('div')
    row.className = 'field'
    const lab = document.createElement('label')
    lab.textContent = label
    row.append(lab, input)
    settingsEl.appendChild(row)
  }
  const text = (label: string, key: 'id' | 'name' | 'biome'): void => {
    const input = document.createElement('input')
    input.value = doc[key]
    input.addEventListener('input', () => {
      doc[key] = input.value
      if (key === 'name') mapName.value = input.value
    })
    add(label, input)
  }
  text('id', 'id')
  text('名称', 'name')
  text('群系', 'biome')

  const bounds = document.createElement('input')
  bounds.type = 'number'
  bounds.value = String(doc.boundsHalf)
  bounds.addEventListener('change', () => { doc.boundsHalf = Math.max(20, Number(bounds.value)); rebuildScene() })
  add('半边长', bounds)

  const groundY = document.createElement('input')
  groundY.type = 'number'
  groundY.value = String(doc.groundY)
  groundY.addEventListener('change', () => { doc.groundY = Number(groundY.value); rebuildScene() })
  add('地面 Y', groundY)

  const gm = document.createElement('select')
  for (const m of MATERIALS) {
    const o = document.createElement('option')
    o.value = m
    o.textContent = MAT_LABEL[m] + ' · ' + m
    if (m === doc.groundMaterial) o.selected = true
    gm.appendChild(o)
  }
  gm.addEventListener('change', () => { doc.groundMaterial = gm.value as Mat })
  add('地面材质', gm)

  const fog = document.createElement('input')
  fog.type = 'color'
  fog.value = doc.fogColor
  fog.addEventListener('input', () => { doc.fogColor = fog.value })
  add('雾色', fog)

  const fogD = document.createElement('input')
  fogD.type = 'number'
  fogD.step = '0.0005'
  fogD.value = String(doc.fogDensity)
  fogD.addEventListener('change', () => { doc.fogDensity = Number(fogD.value) })
  add('雾密度', fogD)
}

// ---------------------------------------------------------------- 导入模型

document.getElementById('importModels')!.addEventListener('click', () => modelInput.click())
modelInput.addEventListener('change', () => {
  const files = Array.from(modelInput.files ?? [])
  modelInput.value = ''
  if (files.length === 0) return
  pushHistory()
  for (const file of files) {
    const base = file.name.replace(/\.(glb|gltf)$/i, '')
    let name = base
    let n = 2
    while (doc.models.some((m) => m.name === name)) name = `${base}_${n++}`
    const url = URL.createObjectURL(file)
    new GLTFLoader().load(
      url,
      (gltf) => {
        URL.revokeObjectURL(url)
        const obj = gltf.scene
        obj.position.set(0, doc.groundY, 0)
        obj.userData = { kind: 'model', index: doc.models.length }
        modelGroup.add(obj)
        doc.models.push({ name, file: file.name, x: 0, z: 0, y: doc.groundY, rotY: 0, scale: 1 })
        modelFiles.set(name, file)
        select({ type: 'model', index: doc.models.length - 1 })
        reportEl.innerHTML = `已导入模型 <b>${name}</b>。<br>导出时把 <b>${file.name}</b> 放进 <b>client/public/models/imported/${name}.glb</b>。`
        requestRender()
      },
      undefined,
      (err) => {
        URL.revokeObjectURL(url)
        reportEl.textContent = `模型 ${file.name} 加载失败：${String(err)}`
      },
    )
  }
})

// ---------------------------------------------------------------- 工具栏

document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    tool = btn.dataset.tool as Tool
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair'
  })
})
document.querySelector<HTMLButtonElement>('#tools [data-tool="select"]')!.classList.add('active')
document.querySelectorAll<HTMLButtonElement>('#tools [data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode as 'translate' | 'rotate' | 'scale'))
})
document.getElementById('undo')!.addEventListener('click', undo)
document.getElementById('redo')!.addEventListener('click', redo)
mapName.addEventListener('input', () => { doc.name = mapName.value })

// ---------------------------------------------------------------- 历史

function snapshot(): string {
  return JSON.stringify(doc)
}
function pushHistory(): void {
  history.push(snapshot())
  if (history.length > 120) history.shift()
  future.length = 0
}
function restore(json: string): void {
  doc = JSON.parse(json) as Doc
  if (!doc.models) doc.models = []
  selection = null
  mapName.value = doc.name
  rebuildScene()
  rebuildProps()
  rebuildSettings()
}
function undo(): void {
  const prev = history.pop()
  if (!prev) return
  future.push(snapshot())
  restore(prev)
}
function redo(): void {
  const next = future.pop()
  if (!next) return
  history.push(snapshot())
  restore(next)
}

// ---------------------------------------------------------------- 文件

document.getElementById('newMap')!.addEventListener('click', () => {
  if (!confirm('清空当前地图？未导出的内容会丢失。')) return
  pushHistory()
  doc = newDoc()
  selection = null
  mapName.value = doc.name
  disposeGroup(modelGroup)
  rebuildScene()
  rebuildProps()
  rebuildSettings()
})

document.getElementById('saveLocal')!.addEventListener('click', () => {
  localStorage.setItem('dk.editor.map', JSON.stringify(doc))
  reportEl.textContent = '已保存到浏览器。'
})
document.getElementById('loadLocal')!.addEventListener('click', () => {
  const raw = localStorage.getItem('dk.editor.map')
  if (!raw) {
    reportEl.textContent = '浏览器里没有保存的地图。'
    return
  }
  pushHistory()
  restore(raw)
  reportEl.textContent = '已读取。'
})
document.getElementById('exportJson')!.addEventListener('click', () => {
  download(`${doc.id || 'map'}.json`, JSON.stringify(doc, null, 2), 'application/json')
})
document.getElementById('importJson')!.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  try {
    const raw = await file.text()
    pushHistory()
    restore(raw)
    reportEl.textContent = `已导入 ${file.name}`
  } catch {
    reportEl.textContent = '导入失败：不是合法的地图 JSON。'
  }
  fileInput.value = ''
})
document.getElementById('exportTs')!.addEventListener('click', () => {
  download(`${doc.id || 'map'}.ts`, buildTs(), 'text/typescript')
})
document.getElementById('validate')!.addEventListener('click', () => {
  reportEl.innerHTML = validate().join('<br>')
})

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// ---------------------------------------------------------------- 导出 TS

function buildTs(): string {
  const id = doc.id || 'my-map'
  const constName = 'LEVEL_' + id.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()
  const file = id.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.ts'
  const boxes = doc.boxes.map((b) => {
    const y = (b.bottom + b.top) / 2
    const hy = Math.max(0.01, (b.top - b.bottom) / 2)
    const parts = [
      `x: ${round(b.x)}, y: ${round(y)}, z: ${round(b.z)}`,
      `hx: ${round(b.hx)}, hy: ${round(hy)}, hz: ${round(b.hz)}`,
      `material: '${b.material}'`,
    ]
    if (b.rotY) parts.push(`rotY: ${round(b.rotY)}`)
    if (b.noCollide) parts.push('noCollide: true')
    if (b.noRender) parts.push('noRender: true')
    return '  { ' + parts.join(', ') + ' },'
  })
  const spawns = doc.markers.filter((m) => m.kind === 'spawn')
    .map((m) => `    { x: ${round(m.x)}, y: ${round(doc.groundY)}, z: ${round(m.z)} },`)
  const nests = doc.markers.filter((m) => m.kind === 'nest')
    .map((m) => `    { kind: '${m.nestKind}', x: ${round(m.x)}, z: ${round(m.z)} },`)
  const clues = doc.markers.filter((m) => m.kind === 'clue')
    .map((m) => `    { x: ${round(m.x)}, z: ${round(m.z)}, hint: ${JSON.stringify(m.name || '线索')} },`)
  const extracts = doc.markers.filter((m) => m.kind === 'extract')
    .map((m) => `    { name: ${JSON.stringify(m.name || '撤离点')}, x: ${round(m.x)}, z: ${round(m.z)} },`)
  const zones = doc.markers.filter((m) => m.kind === 'zone')
    .map((m) => `    { name: ${JSON.stringify(m.name || '区域')}, x: ${round(m.x)}, z: ${round(m.z)}, radius: ${round(m.radius)} },`)
  const water = doc.markers.filter((m) => m.kind === 'water')
    .map((m) => `    { x: ${round(m.x)}, z: ${round(m.z)}, hx: ${round(m.hx)}, hz: ${round(m.hz)} },`)
  const heroes = doc.models
    .map((m) => `    { asset: ${JSON.stringify(m.name)}, x: ${round(m.x)}, z: ${round(m.z)}, y: ${round(m.y)}, rotY: ${round(m.rotY)}, scale: ${round(m.scale)} },`)
  const modelNote = doc.models.length > 0
    ? `\n * 模型文件（放到 client/public/models/imported/，文件名必须和 asset 一致）：\n${doc.models.map((m) => ` *   ${m.name}.glb  ←  ${m.file}`).join('\n')}\n`
    : ''

  return `/**
 * ${doc.name}
 *
 * 由 3D 地图编辑器（client/editor.html）导出。
 *${modelNote}
 * 使用方法：
 *   1. 把本文件放进 shared/src/maps/${file}
 *   2. 在 shared/src/level.ts 里注册：
 *        import { ${constName} } from './maps/${file}'
 *        [${constName}.id]: ${constName},
 *   3. 跑 pnpm test —— 关卡约束（线索/巢穴/撤离/0.4m 网格）会替你检查。
 */

import { applyCover } from './cover.ts'
import type { BoxBrush, LevelDef } from '../level.ts'

const boxes: BoxBrush[] = [
${boxes.join('\n')}
]

export const ${constName}: LevelDef = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(doc.name)},
  biome: ${JSON.stringify(doc.biome)} as LevelDef['biome'],
  groundY: ${round(doc.groundY)},
  boundsHalf: ${round(doc.boundsHalf)},
  groundMaterial: '${doc.groundMaterial}',
  fogColor: 0x${doc.fogColor.replace('#', '')},
  fogDensity: ${doc.fogDensity},
  boxes,
  heroes: [
${heroes.join('\n')}
  ],
  spawns: [
${spawns.join('\n')}
  ],
  nests: [
${nests.join('\n')}
  ],
  clues: [
${clues.join('\n')}
  ],
  extracts: [
${extracts.join('\n')}
  ],
  zones: [
${zones.join('\n')}
  ],
  water: [
${water.join('\n')}
  ],
}

// 荒野断点：避开出生点/巢穴/线索/撤离后再撒低矮障碍。
applyCover(${constName}, { spacing: 22, material: '${doc.groundMaterial}', seed: 0x51de })
`
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

// ---------------------------------------------------------------- 校验

function validate(): string[] {
  const out: string[] = []
  const ok = (s: string): void => { out.push(`<span class="ok">✓</span> ${s}`) }
  const bad = (s: string): void => { out.push(`<span class="bad">✗</span> ${s}`) }

  if (doc.boxes.length <= 1800) ok(`盒刷 ${doc.boxes.length} / 1800`)
  else bad(`盒刷 ${doc.boxes.length} 超过 1800 红线`)

  const solid = doc.boxes.filter((b) => !b.noCollide)
  const offGrid = solid.filter((b) => {
    if (b.bottom > doc.groundY + SNAP + 1e-6) return false
    const k = (b.top - doc.groundY) / SNAP
    return Math.abs(k - Math.round(k)) > 1e-4
  })
  if (offGrid.length === 0) ok('可攀爬盒顶都在 0.4m 网格上')
  else bad(`${offGrid.length} 个盒顶不在 0.4m 网格上（例如 ${offGrid[0]!.x},${offGrid[0]!.z}）`)

  const clues = doc.markers.filter((m) => m.kind === 'clue')
  const nests = doc.markers.filter((m) => m.kind === 'nest')
  const spawns = doc.markers.filter((m) => m.kind === 'spawn')
  const extracts = doc.markers.filter((m) => m.kind === 'extract')
  const zones = doc.markers.filter((m) => m.kind === 'zone')

  if (clues.length === 3) ok('线索正好 3 条')
  else bad(`线索 ${clues.length} 条，必须正好 3 条`)
  if (nests.length >= 6) ok(`巢穴 ${nests.length} 处（≥6）`)
  else bad(`巢穴 ${nests.length} 处，至少 6 处`)
  if (spawns.length >= 4) ok(`出生点 ${spawns.length} 个（≥4）`)
  else bad(`出生点 ${spawns.length} 个，至少 4 个`)
  if (extracts.length >= 2) ok(`撤离点 ${extracts.length} 处（≥2）`)
  else bad(`撤离点 ${extracts.length} 处，至少 2 处`)
  if (zones.length >= 4) ok(`区域 ${zones.length} 个（≥4）`)
  else bad(`区域 ${zones.length} 个，至少 4 个`)

  for (const c of clues) {
    const near = nests.some((n) => Math.hypot(n.x - c.x, n.z - c.z) <= 14)
    if (!near) bad(`线索 (${c.x},${c.z}) 14m 内没有巢穴`)
  }
  for (const s of spawns) {
    for (const n of [...nests, ...clues]) {
      const d = Math.hypot(n.x - s.x, n.z - s.z)
      if (d < 35) bad(`出生点 (${s.x},${s.z}) 离标记 (${n.x},${n.z}) 只有 ${d.toFixed(1)}m（<35m）`)
    }
  }
  for (const e of extracts) {
    const d = Math.hypot(e.x, e.z)
    if (d < 60) bad(`撤离点「${e.name}」离中心 ${d.toFixed(1)}m（<60m）`)
  }
  if (doc.models.length > 0) {
    ok(`${doc.models.length} 个导入模型`)
    for (const m of doc.models) out.push(`<span class="hint">  ${m.name}.glb ← ${m.file}（放进 client/public/models/imported/）</span>`)
  }
  return out
}

// ---------------------------------------------------------------- 每帧

function resize(): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', () => { resize(); requestRender() })

let renderQueued = false
function requestRender(): void {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    renderer.render(scene, camera)
  })
}

function tick(): void {
  controls.update()
  statusEls.zoom.textContent = String(Math.round(camera.position.distanceTo(controls.target)))
  selectionHelper?.update()
  renderer.render(scene, camera)
  requestAnimationFrame(tick)
}

function setMode(mode: 'translate' | 'rotate' | 'scale'): void {
  transformMode = mode
  document.querySelectorAll('#tools [data-mode]').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode)
  })
  if (selection?.type === 'model') transform.setMode(mode)
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return
  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
  if (e.key.toLowerCase() === 'w') setMode('translate')
  if (e.key.toLowerCase() === 'e') setMode('rotate')
  if (e.key.toLowerCase() === 'r') setMode('scale')
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    redo()
  }
})

// ---------------------------------------------------------------- 启动

function boot(): void {
  resize()
  mapName.value = doc.name
  rebuildScene()
  rebuildProps()
  rebuildSettings()
  updateStatus()
  tick()
}

boot()
