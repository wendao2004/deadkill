/**
 * M 键猎场地图：地形轮廓 + 线索 + 血巢 + 携带者看到的撤离点 + 自己的朝向。
 *
 * 为什么用两块 Canvas：
 * - 静态层（944 个盒刷、水域、目标点）只在打开或目标状态变化时重画；
 * - 动态层只画自己的箭头，每帧只清 900×900 的一块，成本远低于重绘整张图。
 *
 * 地图**不显示其他玩家**：那是雷达，不是地图。信息稀缺仍然靠声音与视野。
 */
import type { LevelDef } from '@dk/shared'

export interface MapObjective {
  clueMask: number
  lairRevealed: boolean
  carrierIsMe: boolean
  phase: string
}

export interface MapOverlay {
  readonly visible: boolean
  toggle(): void
  show(): void
  hide(): void
  update(x: number, z: number, yaw: number, objective: MapObjective): void
  dispose(): void
}

const SIZE = 900
const PAD = 36

const MATERIAL_FILL: Record<string, string> = {
  wood: '#6b5942',
  stone: '#5a6169',
  metal: '#7f8a95',
  mud: '#746349',
  foliage: '#5f7248',
}

function el(tag: string, cls: string, text = ''): HTMLElement {
  const node = document.createElement(tag)
  node.className = cls
  if (text) node.textContent = text
  return node
}

export function createMapOverlay(level: LevelDef): MapOverlay {
  const host = el('div', 'dko-map')
  host.setAttribute('aria-hidden', 'true')

  const card = el('div', 'dko-map__card')
  const head = el('div', 'dko-map__head')
  head.append(el('span', 'dko-map__title', '猎 场 地 图'), el('span', 'dko-map__hint', 'M 关闭'))
  const wrap = el('div', 'dko-map__wrap')
  const staticCanvas = document.createElement('canvas')
  staticCanvas.className = 'dko-map__canvas dko-map__canvas--static'
  staticCanvas.width = SIZE
  staticCanvas.height = SIZE
  const dynCanvas = document.createElement('canvas')
  dynCanvas.className = 'dko-map__canvas dko-map__canvas--dyn'
  dynCanvas.width = SIZE
  dynCanvas.height = SIZE
  wrap.append(staticCanvas, dynCanvas)
  const legend = el('div', 'dko-map__legend')
  legend.append(
    el('span', 'dko-map__key dko-map__key--clue', '◆ 线索'),
    el('span', 'dko-map__key dko-map__key--lair', '● 血巢'),
    el('span', 'dko-map__key dko-map__key--extract', '▲ 撤离'),
    el('span', 'dko-map__key dko-map__key--self', '▲ 你'),
  )
  card.append(head, wrap, legend)
  host.append(card)
  document.body.append(host)

  const sctx = staticCanvas.getContext('2d')!
  const dctx = dynCanvas.getContext('2d')!
  const half = level.boundsHalf
  const scale = (SIZE - PAD * 2) / (half * 2)
  const toX = (x: number): number => SIZE / 2 + x * scale
  const toY = (z: number): number => SIZE / 2 + z * scale

  let visible = false
  let staticKey = ''
  let dynKey = ''
  let lastX = 0
  let lastZ = 0
  let lastYaw = 0
  let lastObjective: MapObjective | null = null

  function drawStatic(objective: MapObjective): void {
    const ctx = sctx
    ctx.clearRect(0, 0, SIZE, SIZE)
    // 纸底 + 每 20m 一条淡网格。
    ctx.fillStyle = '#101310'
    ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.strokeStyle = 'rgba(216,207,186,0.06)'
    ctx.lineWidth = 1
    for (let m = -Math.floor(half / 20) * 20; m <= half; m += 20) {
      const px = toX(m)
      const py = toY(m)
      ctx.beginPath()
      ctx.moveTo(px, PAD)
      ctx.lineTo(px, SIZE - PAD)
      ctx.moveTo(PAD, py)
      ctx.lineTo(SIZE - PAD, py)
      ctx.stroke()
    }

    // 水域（画在盒刷下方）。
    ctx.fillStyle = 'rgba(63,86,82,0.45)'
    for (const w of level.water ?? []) {
      ctx.save()
      ctx.translate(toX(w.x), toY(w.z))
      ctx.rotate(-(w.rotY ?? 0))
      ctx.fillRect(-w.hx * scale, -w.hz * scale, w.hx * 2 * scale, w.hz * 2 * scale)
      ctx.restore()
    }

    // 盒刷：静态几何画成半透明块，能读出街道/院子/房间的轮廓。
    for (const b of level.boxes) {
      // 门窗框/檐口这类纯视觉细节不进小地图：它们薄而多，画上去只会把
      // 900px 的地图糊成一层噪点。贴地装饰片（hy 很小）仍然保留。
      if (b.noCollide && Math.min(b.hx, b.hz) < 0.18 && b.hy > 0.1) continue
      ctx.save()
      ctx.translate(toX(b.x), toY(b.z))
      ctx.rotate(-(b.rotY ?? 0))
      ctx.fillStyle = MATERIAL_FILL[b.material ?? 'wood'] ?? '#6b5942'
      ctx.globalAlpha = b.noCollide ? 0.18 : 0.52
      ctx.fillRect(-b.hx * scale, -b.hz * scale, b.hx * 2 * scale, b.hz * 2 * scale)
      ctx.globalAlpha = b.noCollide ? 0.2 : 0.75
      ctx.strokeStyle = 'rgba(12,11,10,0.7)'
      ctx.lineWidth = 0.6
      ctx.strokeRect(-b.hx * scale, -b.hz * scale, b.hx * 2 * scale, b.hz * 2 * scale)
      ctx.restore()
    }

    // 线索：未收集的琥珀菱形；已收集的暗色小点。
    const clues = level.clues ?? []
    for (let i = 0; i < clues.length; i++) {
      const c = clues[i]!
      const found = (objective.clueMask & (1 << i)) !== 0
      const x = toX(c.x)
      const y = toY(c.z)
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = found ? 'rgba(216,207,186,0.22)' : '#d99a4a'
      ctx.fillRect(-7, -7, 14, 14)
      ctx.strokeStyle = '#0c0b0a'
      ctx.lineWidth = 2
      ctx.strokeRect(-7, -7, 14, 14)
      ctx.restore()
      if (!found) {
        ctx.fillStyle = '#0c0b0a'
        ctx.font = 'bold 12px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(i + 1), x, y + 1)
      }
    }

    // 血巢：揭示后才画。
    if (objective.lairRevealed && clues.length > 0) {
      const sx = clues.reduce((sum, c) => sum + c.x, 0) / clues.length
      const sz = clues.reduce((sum, c) => sum + c.z, 0) / clues.length
      ctx.beginPath()
      ctx.arc(toX(sx), toY(sz), 18, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(155,179,106,0.28)'
      ctx.fill()
      ctx.strokeStyle = '#9bb36a'
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.fillStyle = '#c9d3a1'
      ctx.font = 'bold 14px monospace'
      ctx.textAlign = 'center'
      ctx.fillText('血巢', toX(sx), toY(sz) + 5)
    }

    // 撤离点：只有携带者看得见；其他玩家看到的是"不知道出口"。
    if (objective.carrierIsMe) {
      for (const e of level.extracts ?? []) {
        const x = toX(e.x)
        const y = toY(e.z)
        ctx.beginPath()
        ctx.moveTo(x, y - 12)
        ctx.lineTo(x + 10, y + 8)
        ctx.lineTo(x - 10, y + 8)
        ctx.closePath()
        ctx.fillStyle = '#d8cfba'
        ctx.fill()
        ctx.strokeStyle = '#0c0b0a'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.fillStyle = '#d8cfba'
        ctx.font = 'bold 13px monospace'
        ctx.textAlign = 'center'
        ctx.fillText(e.name, x, y + 26)
      }
    }

    // 北向标记。
    ctx.fillStyle = 'rgba(216,207,186,0.55)'
    ctx.font = 'bold 16px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('N', SIZE / 2, 22)
  }

  function drawDynamic(x: number, z: number, yaw: number): void {
    const ctx = dctx
    ctx.clearRect(0, 0, SIZE, SIZE)
    const px = toX(x)
    const py = toY(z)
    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(-yaw)
    // 箭头：底宽 14、长 22，默认朝上（北）。
    ctx.beginPath()
    ctx.moveTo(0, -14)
    ctx.lineTo(9, 10)
    ctx.lineTo(0, 5)
    ctx.lineTo(-9, 10)
    ctx.closePath()
    ctx.fillStyle = '#f0c063'
    ctx.fill()
    ctx.strokeStyle = '#0c0b0a'
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.restore()
    // 视野扇形：让"我朝哪"比一个三角更明显。
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.arc(px, py, 52, -Math.PI / 2 - yaw - 0.5, -Math.PI / 2 - yaw + 0.5)
    ctx.closePath()
    ctx.fillStyle = 'rgba(240,192,99,0.10)'
    ctx.fill()
  }

  function drawIfNeeded(objective: MapObjective): void {
    const key = `${objective.clueMask}|${objective.lairRevealed}|${objective.carrierIsMe}|${objective.phase}`
    if (key !== staticKey) {
      staticKey = key
      drawStatic(objective)
    }
    // 位置/朝向量化，避免每帧重画箭头。
    const qx = Math.round(lastX * 2) / 2
    const qz = Math.round(lastZ * 2) / 2
    const qy = Math.round(lastYaw * 20) / 20
    const dkey = `${qx}|${qz}|${qy}`
    if (dkey !== dynKey) {
      dynKey = dkey
      drawDynamic(lastX, lastZ, lastYaw)
    }
  }

  return {
    get visible(): boolean {
      return visible
    },
    show(): void {
      if (visible) return
      visible = true
      host.classList.add('is-on')
      if (lastObjective) drawIfNeeded(lastObjective)
    },
    hide(): void {
      if (!visible) return
      visible = false
      host.classList.remove('is-on')
    },
    toggle(): void {
      if (visible) this.hide()
      else this.show()
    },
    update(x: number, z: number, yaw: number, objective: MapObjective): void {
      lastX = x
      lastZ = z
      lastYaw = yaw
      lastObjective = objective
      if (!visible) return
      drawIfNeeded(objective)
    },
    dispose(): void {
      host.remove()
    },
  }
}
