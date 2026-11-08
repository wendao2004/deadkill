/**
 * DEAD KILL 地图编辑器（2D 俯视）。
 *
 * 为什么是纯 2D canvas 而不是 three 里做编辑器：画关卡时人看的是**平面关系**
 * —— 哪里能过、哪里断视线、出生点到巢穴多远。俯视图比第三人称漫游直观得多，
 * 而且不引 three/rapier，编辑器本身是几十 KB 的静态页。
 *
 * 数据模型和游戏完全同源：
 * - 盒刷 = `BoxBrush`（中心 + 半长 + 材质 + 可选 rotY/noCollide/noRender）；
 * - 标记 = LevelDef 的 spawns / nests / clues / extracts / zones / water。
 * 导出的是可以直接丢进 `shared/src/maps/` 的 `.ts`，不是另一套格式。
 */

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
}

type Selection = { type: 'box' | 'marker'; index: number } | null

const SNAP = 0.4
const MATERIALS: Mat[] = ['wood', 'stone', 'mud', 'metal', 'foliage']
const MAT_COLORS: Record<Mat, string> = {
  wood: '#6b4a2e',
  stone: '#6a6a62',
  mud: '#51493a',
  metal: '#4a4d50',
  foliage: '#2f4a2a',
}
const MAT_LABEL: Record<Mat, string> = {
  wood: '木',
  stone: '石',
  mud: '泥',
  metal: '铁',
  foliage: '叶',
}

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
  }
}

// ---------------------------------------------------------------- DOM

const canvas = document.getElementById('view') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
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

// ---------------------------------------------------------------- 状态

let doc: Doc = newDoc()
let tool: Tool = 'select'
let selection: Selection = null
let camera = { x: 0, z: 0, scale: 20 }
let pointer = { x: 0, z: 0, sx: 0, sy: 0 }
let spaceDown = false
let drag: null | {
  kind: 'pan' | 'create' | 'move-box' | 'move-marker'
  startX: number
  startZ: number
  lastX: number
  lastZ: number
  box?: EBox
  marker?: EMarker
} = null
const history: string[] = []
const future: string[] = []

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
  selection = null
  mapName.value = doc.name
  render()
  rebuildProps()
  rebuildSettings()
  updateStatus()
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

// ---------------------------------------------------------------- 坐标

function toScreen(x: number, z: number): [number, number] {
  return [
    (x - camera.x) * camera.scale + canvas.clientWidth / 2,
    (z - camera.z) * camera.scale + canvas.clientHeight / 2,
  ]
}
function toWorld(sx: number, sy: number): [number, number] {
  return [
    (sx - canvas.clientWidth / 2) / camera.scale + camera.x,
    (sy - canvas.clientHeight / 2) / camera.scale + camera.z,
  ]
}

// ---------------------------------------------------------------- 绘制

let renderQueued = false
function requestRender(): void {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

function applyTransform(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function render(): void {
  applyTransform()
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#0f1214'
  ctx.fillRect(0, 0, w, h)

  drawGrid(w, h)
  drawBounds()
  drawWater()
  drawZones()
  drawBoxes()
  drawMarkers()
  drawCrosshair()
  statusEls.count.textContent = String(doc.boxes.length)
}

function drawGrid(w: number, h: number): void {
  const step = camera.scale >= 26 ? SNAP : 2
  const [wx0, wz0] = toWorld(0, 0)
  const [wx1, wz1] = toWorld(w, h)
  const minX = Math.floor(Math.min(wx0, wx1) / step) * step
  const maxX = Math.ceil(Math.max(wx0, wx1) / step) * step
  const minZ = Math.floor(Math.min(wz0, wz1) / step) * step
  const maxZ = Math.ceil(Math.max(wz0, wz1) / step) * step

  ctx.lineWidth = 1
  for (let x = minX; x <= maxX; x += step) {
    const [sx] = toScreen(x, 0)
    ctx.strokeStyle = Math.abs(x % 2) < 1e-6 ? 'rgba(70,82,90,0.45)' : 'rgba(42,49,56,0.55)'
    ctx.beginPath()
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx, h)
    ctx.stroke()
  }
  for (let z = minZ; z <= maxZ; z += step) {
    const [, sy] = toScreen(0, z)
    ctx.strokeStyle = Math.abs(z % 2) < 1e-6 ? 'rgba(70,82,90,0.45)' : 'rgba(42,49,56,0.55)'
    ctx.beginPath()
    ctx.moveTo(0, sy)
    ctx.lineTo(w, sy)
    ctx.stroke()
  }
}

function drawBounds(): void {
  const [x0, z0] = toScreen(-doc.boundsHalf, -doc.boundsHalf)
  const [x1, z1] = toScreen(doc.boundsHalf, doc.boundsHalf)
  ctx.strokeStyle = 'rgba(217,154,74,0.55)'
  ctx.setLineDash([8, 6])
  ctx.lineWidth = 1.5
  ctx.strokeRect(x0, z0, x1 - x0, z1 - z0)
  ctx.setLineDash([])
}

function drawWater(): void {
  for (const m of doc.markers) {
    if (m.kind !== 'water') continue
    const [sx, sz] = toScreen(m.x, m.z)
    ctx.fillStyle = 'rgba(40,90,120,0.28)'
    ctx.strokeStyle = 'rgba(90,160,200,0.8)'
    ctx.lineWidth = 1.5
    const w = m.hx * 2 * camera.scale
    const h = m.hz * 2 * camera.scale
    ctx.fillRect(sx - w / 2, sz - h / 2, w, h)
    ctx.strokeRect(sx - w / 2, sz - h / 2, w, h)
  }
}

function drawZones(): void {
  for (const m of doc.markers) {
    if (m.kind !== 'zone') continue
    const [sx, sz] = toScreen(m.x, m.z)
    ctx.strokeStyle = 'rgba(141,133,120,0.5)'
    ctx.setLineDash([4, 5])
    ctx.beginPath()
    ctx.arc(sx, sz, m.radius * camera.scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(141,133,120,0.8)'
    ctx.font = '11px "Segoe UI", sans-serif'
    ctx.fillText(m.name || '区域', sx + 4, sz - m.radius * camera.scale - 4)
  }
}

function drawBoxes(): void {
  for (let i = 0; i < doc.boxes.length; i++) {
    const b = doc.boxes[i]!
    const [sx, sz] = toScreen(b.x, b.z)
    const w = b.hx * 2 * camera.scale
    const h = b.hz * 2 * camera.scale
    const selected = selection?.type === 'box' && selection.index === i
    const heightK = Math.min(1, Math.max(0, (b.top - b.bottom) / 8))
    ctx.save()
    ctx.translate(sx, sz)
    ctx.rotate(b.rotY)
    ctx.globalAlpha = b.noRender ? 0.22 : 0.45 + heightK * 0.45
    ctx.fillStyle = MAT_COLORS[b.material]
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.globalAlpha = 1
    ctx.lineWidth = selected ? 2.2 : 1
    ctx.strokeStyle = selected ? '#d99a4a' : b.noCollide ? 'rgba(141,133,120,0.5)' : 'rgba(12,11,10,0.9)'
    ctx.strokeRect(-w / 2, -h / 2, w, h)
    if (b.noCollide) {
      ctx.setLineDash([3, 4])
      ctx.strokeStyle = 'rgba(141,133,120,0.8)'
      ctx.strokeRect(-w / 2, -h / 2, w, h)
      ctx.setLineDash([])
    }
    ctx.restore()
  }
}

function drawMarkers(): void {
  for (let i = 0; i < doc.markers.length; i++) {
    const m = doc.markers[i]!
    if (m.kind === 'zone' || m.kind === 'water') continue
    const [sx, sz] = toScreen(m.x, m.z)
    const selected = selection?.type === 'marker' && selection.index === i
    const r = 7
    ctx.lineWidth = selected ? 2.4 : 1.4
    switch (m.kind) {
      case 'spawn':
        ctx.fillStyle = '#6fbf73'
        ctx.beginPath()
        ctx.arc(sx, sz, r, 0, Math.PI * 2)
        ctx.fill()
        break
      case 'nest':
        ctx.fillStyle = '#c0554a'
        ctx.beginPath()
        ctx.moveTo(sx, sz - r)
        ctx.lineTo(sx + r, sz + r)
        ctx.lineTo(sx - r, sz + r)
        ctx.closePath()
        ctx.fill()
        break
      case 'clue':
        ctx.fillStyle = '#d9b64a'
        ctx.beginPath()
        ctx.moveTo(sx, sz - r)
        ctx.lineTo(sx + r, sz)
        ctx.lineTo(sx, sz + r)
        ctx.lineTo(sx - r, sz)
        ctx.closePath()
        ctx.fill()
        break
      case 'extract':
        ctx.fillStyle = '#5aa9c9'
        ctx.fillRect(sx - r, sz - r, r * 2, r * 2)
        break
    }
    ctx.strokeStyle = selected ? '#ffffff' : 'rgba(12,11,10,0.9)'
    ctx.stroke()
    if (m.name) {
      ctx.fillStyle = '#d8cfba'
      ctx.font = '11px "Segoe UI", sans-serif'
      ctx.fillText(m.name, sx + r + 4, sz + 4)
    }
  }
}

function drawCrosshair(): void {
  const [sx, sy] = toScreen(pointer.x, pointer.z)
  ctx.strokeStyle = 'rgba(217,154,74,0.5)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(sx - 6, sy)
  ctx.lineTo(sx + 6, sy)
  ctx.moveTo(sx, sy - 6)
  ctx.lineTo(sx, sy + 6)
  ctx.stroke()
}

// ---------------------------------------------------------------- 命中测试

function hitBox(x: number, z: number): number {
  for (let i = doc.boxes.length - 1; i >= 0; i--) {
    const b = doc.boxes[i]!
    const dx = x - b.x
    const dz = z - b.z
    const c = Math.cos(-b.rotY)
    const s = Math.sin(-b.rotY)
    const lx = dx * c - dz * s
    const lz = dx * s + dz * c
    if (Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz) return i
  }
  return -1
}

function hitMarker(x: number, z: number): number {
  const limit = Math.max(0.4, 10 / camera.scale)
  for (let i = doc.markers.length - 1; i >= 0; i--) {
    const m = doc.markers[i]!
    if (m.kind === 'zone') {
      const d = Math.hypot(x - m.x, z - m.z)
      if (Math.abs(d - m.radius) < limit) return i
    } else if (Math.hypot(x - m.x, z - m.z) <= limit) {
      return i
    }
  }
  return -1
}

// ---------------------------------------------------------------- 交互

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId)
  const [wx, wz] = toWorld(e.offsetX, e.offsetY)
  const sx = snap(wx)
  const sz = snap(wz)

  if (e.button === 1 || spaceDown) {
    drag = { kind: 'pan', startX: wx, startZ: wz, lastX: wx, lastZ: wz }
    return
  }
  if (e.button !== 0) return

  if (tool === 'select') {
    const bi = hitBox(wx, wz)
    if (bi >= 0) {
      selection = { type: 'box', index: bi }
      pushHistory()
      drag = { kind: 'move-box', startX: wx, startZ: wz, lastX: wx, lastZ: wz, box: doc.boxes[bi] }
      rebuildProps()
      updateStatus()
      requestRender()
      return
    }
    const mi = hitMarker(wx, wz)
    if (mi >= 0) {
      selection = { type: 'marker', index: mi }
      pushHistory()
      drag = { kind: 'move-marker', startX: wx, startZ: wz, lastX: wx, lastZ: wz, marker: doc.markers[mi] }
      rebuildProps()
      updateStatus()
      requestRender()
      return
    }
    selection = null
    rebuildProps()
    updateStatus()
    requestRender()
    return
  }

  if (tool === 'box') {
    pushHistory()
    drag = { kind: 'create', startX: sx, startZ: sz, lastX: sx, lastZ: sz }
    return
  }

  // 标记工具：点一下放一个
  pushHistory()
  doc.markers.push(defaultMarker(tool, sx, sz))
  selection = { type: 'marker', index: doc.markers.length - 1 }
  rebuildProps()
  updateStatus()
  requestRender()
})

canvas.addEventListener('pointermove', (e) => {
  const [wx, wz] = toWorld(e.offsetX, e.offsetY)
  pointer = { x: wx, z: wz, sx: e.offsetX, sy: e.offsetY }
  statusEls.cur.textContent = `${wx.toFixed(1)}, ${wz.toFixed(1)}`

  if (!drag) {
    requestRender()
    return
  }
  if (drag.kind === 'pan') {
    camera.x -= wx - drag.lastX
    camera.z -= wz - drag.lastZ
    drag.lastX = wx
    drag.lastZ = wz
  } else if (drag.kind === 'move-box' && drag.box) {
    drag.box.x = snap(drag.box.x + (wx - drag.lastX))
    drag.box.z = snap(drag.box.z + (wz - drag.lastZ))
    drag.lastX = wx
    drag.lastZ = wz
  } else if (drag.kind === 'move-marker' && drag.marker) {
    drag.marker.x = snap(wx)
    drag.marker.z = snap(wz)
  }
  requestRender()
})

canvas.addEventListener('pointerup', (e) => {
  if (drag?.kind === 'create') {
    const x0 = Math.min(drag.startX, snap(pointer.x))
    const x1 = Math.max(drag.startX, snap(pointer.x))
    const z0 = Math.min(drag.startZ, snap(pointer.z))
    const z1 = Math.max(drag.startZ, snap(pointer.z))
    const hx = Math.max(SNAP / 2, (x1 - x0) / 2)
    const hz = Math.max(SNAP / 2, (z1 - z0) / 2)
    doc.boxes.push({
      x: snap((x0 + x1) / 2),
      z: snap((z0 + z1) / 2),
      hx,
      hz,
      bottom: 0,
      top: 2.0,
      rotY: 0,
      material: 'wood',
      noCollide: false,
      noRender: false,
    })
    selection = { type: 'box', index: doc.boxes.length - 1 }
    rebuildProps()
  }
  drag = null
  updateStatus()
  requestRender()
})

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const [wx, wz] = toWorld(e.offsetX, e.offsetY)
  const factor = Math.exp(-e.deltaY * 0.0016)
  camera.scale = Math.min(120, Math.max(4, camera.scale * factor))
  const [nx, nz] = toWorld(e.offsetX, e.offsetY)
  camera.x += wx - nx
  camera.z += wz - nz
  statusEls.zoom.textContent = String(Math.round(camera.scale))
  requestRender()
}, { passive: false })

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    spaceDown = true
    e.preventDefault()
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const sel = selection
    if (!sel) return
    pushHistory()
    if (sel.type === 'box') doc.boxes.splice(sel.index, 1)
    else doc.markers.splice(sel.index, 1)
    selection = null
    rebuildProps()
    updateStatus()
    requestRender()
  }
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
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceDown = false
})

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
    propsEl.innerHTML = '<p class="hint">选中一个盒刷或标记后，在这里改属性。</p>'
    return
  }
  if (sel.type === 'box') {
    const b = doc.boxes[sel.index]
    if (!b) return
    const h = document.createElement('h2')
    h.textContent = '盒刷'
    propsEl.appendChild(h)
    field(propsEl, '中心 X', b.x, (v) => { b.x = snap(v); requestRender() })
    field(propsEl, '中心 Z', b.z, (v) => { b.z = snap(v); requestRender() })
    field(propsEl, '半宽 X', b.hx, (v) => { b.hx = Math.max(SNAP / 2, snap(v)); requestRender() })
    field(propsEl, '半宽 Z', b.hz, (v) => { b.hz = Math.max(SNAP / 2, snap(v)); requestRender() })
    field(propsEl, '底面 Y', b.bottom, (v) => { b.bottom = snap(v); requestRender() })
    field(propsEl, '顶面 Y', b.top, (v) => { b.top = snap(v); requestRender() })
    field(propsEl, '旋转°', (b.rotY * 180) / Math.PI, (v) => { b.rotY = (v * Math.PI) / 180; requestRender() })
    const mat = document.createElement('select')
    for (const m of MATERIALS) {
      const o = document.createElement('option')
      o.value = m
      o.textContent = MAT_LABEL[m] + ' · ' + m
      if (m === b.material) o.selected = true
      mat.appendChild(o)
    }
    mat.addEventListener('change', () => { b.material = mat.value as Mat; requestRender() })
    wrapField(propsEl, '材质', mat)
    check(propsEl, '不碰撞（noCollide）', b.noCollide, (v) => { b.noCollide = v; requestRender() })
    check(propsEl, '不渲染（noRender）', b.noRender, (v) => { b.noRender = v; requestRender() })
  } else {
    const m = doc.markers[sel.index]
    if (!m) return
    const h = document.createElement('h2')
    h.textContent = '标记 · ' + markerLabel(m.kind)
    propsEl.appendChild(h)
    field(propsEl, 'X', m.x, (v) => { m.x = snap(v); requestRender() })
    field(propsEl, 'Z', m.z, (v) => { m.z = snap(v); requestRender() })
    if (m.kind === 'nest') {
      const sel = document.createElement('select')
      for (const k of ['grunt', 'gunner', 'hound']) {
        const o = document.createElement('option')
        o.value = k
        o.textContent = k
        if (k === m.nestKind) o.selected = true
        sel.appendChild(o)
      }
      sel.addEventListener('change', () => { m.nestKind = sel.value as NestKind })
      wrapField(propsEl, '种类', sel)
    }
    if (m.kind === 'extract' || m.kind === 'zone') {
      const input = document.createElement('input')
      input.value = m.name
      input.addEventListener('input', () => { m.name = input.value })
      wrapField(propsEl, '名称', input)
    }
    if (m.kind === 'clue') {
      const input = document.createElement('input')
      input.value = m.name
      input.placeholder = '线索文案'
      input.addEventListener('input', () => { m.name = input.value })
      wrapField(propsEl, '文案', input)
    }
    if (m.kind === 'zone') field(propsEl, '半径', m.radius, (v) => { m.radius = Math.max(1, v); requestRender() })
    if (m.kind === 'water') {
      field(propsEl, '半宽 X', m.hx, (v) => { m.hx = Math.max(0.5, v); requestRender() })
      field(propsEl, '半宽 Z', m.hz, (v) => { m.hz = Math.max(0.5, v); requestRender() })
    }
  }
  const del = document.createElement('button')
  del.textContent = '删除选中（Delete）'
  del.style.marginTop = '10px'
  del.addEventListener('click', () => {
    pushHistory()
    if (sel.type === 'box') doc.boxes.splice(sel.index, 1)
    else doc.markers.splice(sel.index, 1)
    selection = null
    rebuildProps()
    updateStatus()
    requestRender()
  })
  propsEl.appendChild(del)
}

function field(parent: HTMLElement, label: string, value: number, onChange: (v: number) => void): void {
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
  })
  row.append(lab, input)
  parent.appendChild(row)
}

function wrapField(parent: HTMLElement, label: string, el: HTMLElement): void {
  const row = document.createElement('div')
  row.className = 'field'
  const lab = document.createElement('label')
  lab.textContent = label
  row.append(lab, el)
  parent.appendChild(row)
}

function check(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): void {
  const row = document.createElement('label')
  row.className = 'check'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = value
  input.addEventListener('change', () => { pushHistory(); onChange(input.checked); updateStatus() })
  row.append(input, document.createTextNode(label))
  parent.appendChild(row)
}

function markerLabel(kind: MarkerKind): string {
  return kind === 'spawn' ? '出生点'
    : kind === 'nest' ? '巢穴'
      : kind === 'clue' ? '线索'
        : kind === 'extract' ? '撤离'
          : kind === 'zone' ? '区域'
            : '水面'
}

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
  const text = (label: string, key: 'id' | 'name' | 'biome', transform: (v: string) => void = () => {}): void => {
    const input = document.createElement('input')
    input.value = doc[key]
    input.addEventListener('input', () => { doc[key] = input.value; transform(input.value); if (key === 'name') mapName.value = input.value })
    add(label, input)
  }
  text('id', 'id')
  text('名称', 'name')
  text('群系', 'biome')

  const bounds = document.createElement('input')
  bounds.type = 'number'
  bounds.value = String(doc.boundsHalf)
  bounds.addEventListener('change', () => { doc.boundsHalf = Math.max(20, Number(bounds.value)); requestRender() })
  add('半边长', bounds)

  const groundY = document.createElement('input')
  groundY.type = 'number'
  groundY.value = String(doc.groundY)
  groundY.addEventListener('change', () => { doc.groundY = Number(groundY.value) })
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

function updateStatus(): void {
  const sel = selection
  statusEls.sel.textContent = sel
    ? sel.type === 'box'
      ? `盒刷 #${sel.index}`
      : markerLabel(doc.markers[sel.index]?.kind ?? 'zone')
    : '无'
}

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
document.getElementById('undo')!.addEventListener('click', undo)
document.getElementById('redo')!.addEventListener('click', redo)
mapName.addEventListener('input', () => { doc.name = mapName.value })

// ---------------------------------------------------------------- 文件

document.getElementById('newMap')!.addEventListener('click', () => {
  if (!confirm('清空当前地图？未导出的内容会丢失。')) return
  pushHistory()
  doc = newDoc()
  selection = null
  mapName.value = doc.name
  rebuildProps()
  rebuildSettings()
  requestRender()
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

  return `/**
 * ${doc.name}
 *
 * 由地图编辑器（client/editor.html）导出。
 * 使用方法：
 *   1. 把本文件放进 shared/src/maps/${file}
 *   2. 在 shared/src/level.ts 里注册：
 *        import { ${constName} } from './maps/${file.replace(/\.ts$/, '.ts')}'
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
  const sel = selection
  if (sel) {
    if (sel.type === 'box') {
      const b = doc.boxes[sel.index]
      if (b) out.push(`<span class="hint">选中盒刷：x=${b.x} z=${b.z} ${b.hx * 2}×${b.hz * 2}m，高 ${b.top - b.bottom}m</span>`)
    }
  }
  return out
}

// ---------------------------------------------------------------- 启动

function boot(): void {
  mapName.value = doc.name
  rebuildProps()
  rebuildSettings()
  updateStatus()
  requestRender()
}

window.addEventListener('resize', requestRender)
boot()

export {}
