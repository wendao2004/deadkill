/**
 * 军械库里的 3D 枪模展示。
 *
 * 它**不碰游戏世界**：自己的 canvas、自己的相机、自己的暖色三点布光。
 * 复用 `weapon-models.ts` 的程序化枪模，保证工作台看到的枪和第一人称里
 * 是同一套几何；配件只改枪模上的镜筒/消音器，其余槽位用数值预览表达。
 */

import {
  ACESFilmicToneMapping,
  Box3,
  CircleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
import {
  attachmentById, buildFlags,
  type WeaponBuild,
} from '@dk/shared'
import { createMagazineTube, createMuzzleBrake, createScope2x, createScope4x, createStockVariant, createSuppressor } from './parts/attachments.ts'
import {
  buildKnife,
  buildRevolver,
  buildRifle,
  buildShotgun,
  type WeaponMaterialSet,
} from './weapon-models.ts'

const MAT_COLORS: Record<keyof WeaponMaterialSet, [number, number, number, number]> = {
  // color, metalness, roughness, emissive
  steel: [0x68727e, 0.86, 0.34, 0],
  darkSteel: [0x2c333b, 0.8, 0.46, 0],
  wood: [0x5a3a22, 0.06, 0.72, 0],
  brass: [0xb08a45, 0.82, 0.3, 0],
  sight: [0xfff1c8, 0.3, 0.45, 0.2],
  sightBead: [0xffb347, 0, 0.4, 1],
  bore: [0x080b0f, 0.2, 0.8, 0],
  blade: [0x9aa5b1, 0.92, 0.18, 0],
  bladeEdge: [0xd9e1ea, 0.95, 0.1, 0.18],
  glove: [0x4a3424, 0.02, 0.85, 0],
  gloveDark: [0x2d2118, 0.02, 0.9, 0],
  sleeve: [0x2b3138, 0.02, 0.9, 0],
}

function previewMaterials(): WeaponMaterialSet {
  const set = {} as WeaponMaterialSet
  for (const key of Object.keys(MAT_COLORS) as (keyof WeaponMaterialSet)[]) {
    const [color, metalness, roughness, emissive] = MAT_COLORS[key]
    const mat =
      key === 'sightBead'
        ? new MeshBasicMaterial({ color, toneMapped: false })
        : new MeshStandardMaterial({ color, metalness, roughness })
    if (mat instanceof MeshStandardMaterial && emissive > 0) {
      mat.emissive = new Color(color)
      mat.emissiveIntensity = emissive
    }
    set[key] = mat
  }
  return set
}

export class WeaponPreview {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(25, 1, 0.01, 30)
  private readonly turntable = new Group()
  private readonly modelRoot = new Group()
  private readonly materials: WeaponMaterialSet
  private readonly floor: Mesh
  private readonly ring: Mesh
  private readonly key: DirectionalLight
  private readonly rim: PointLight
  private modelDispose: (() => void) | null = null
  private raf = 0
  private last = 0
  private dragging = false
  private lastX = 0
  private lastY = 0
  private yaw = 0.38
  private pitch = -0.05
  private autoSpin = true
  private active = true
  private readonly baseYaw = 0.38
  private readonly resizeObserver: ResizeObserver
  private readonly onPointerDown: (event: PointerEvent) => void
  private readonly onPointerMove: (event: PointerEvent) => void
  private readonly onPointerUp: () => void
  private readonly onWheel: (event: WheelEvent) => void

  constructor(host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.12
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.domElement.className = 'dk-preview__canvas'
    host.appendChild(this.renderer.domElement)

    this.camera.position.set(0, 0.24, 1.45)
    this.camera.lookAt(0, 0.02, 0)

    this.scene.add(new HemisphereLight(0x9db2c8, 0x120e0a, 1.15))
    this.key = new DirectionalLight(0xffd0a0, 3.4)
    this.key.position.set(1.6, 2.2, 1.2)
    this.scene.add(this.key)
    const fill = new DirectionalLight(0x8fb6e0, 1.1)
    fill.position.set(-2, 0.6, 1.4)
    this.scene.add(fill)
    this.rim = new PointLight(0x6fa8ff, 8, 4, 2)
    this.rim.position.set(-0.4, 0.3, -1.4)
    this.scene.add(this.rim)

    this.floor = new Mesh(
      new CircleGeometry(1.25, 64),
      new MeshStandardMaterial({ color: 0x090c10, roughness: 0.92, metalness: 0.08 }),
    )
    this.floor.rotation.x = -Math.PI / 2
    this.floor.scale.setScalar(0.52)
    this.floor.position.y = -0.2
    this.scene.add(this.floor)
    this.ring = new Mesh(
      new RingGeometry(0.72, 0.735, 72),
      new MeshBasicMaterial({ color: 0xd99a4a, transparent: true, opacity: 0.5, toneMapped: false }),
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.scale.setScalar(0.52)
    this.ring.position.y = -0.195
    this.scene.add(this.ring)

    this.turntable.add(this.modelRoot)
    this.scene.add(this.turntable)

    this.materials = previewMaterials()

    this.onPointerDown = (event) => {
      this.dragging = true
      this.autoSpin = false
      this.lastX = event.clientX
      this.lastY = event.clientY
      this.renderer.domElement.setPointerCapture?.(event.pointerId)
    }
    this.onPointerMove = (event) => {
      if (!this.dragging) return
      const dx = event.clientX - this.lastX
      const dy = event.clientY - this.lastY
      this.lastX = event.clientX
      this.lastY = event.clientY
      this.yaw += dx * 0.008
      this.pitch = MathUtils.clamp(this.pitch + dy * 0.004, -0.35, 0.28)
    }
    this.onPointerUp = () => {
      this.dragging = false
      this.autoSpin = true
    }
    this.onWheel = (event) => {
      event.preventDefault()
      const next = this.camera.position.length() + event.deltaY * 0.0012
      const dist = MathUtils.clamp(next, 0.9, 2.6)
      this.camera.position.normalize().multiplyScalar(dist)
      this.camera.lookAt(0, 0.02, 0)
    }
    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })

    this.resizeObserver = new ResizeObserver(() => this.resize(host))
    this.resizeObserver.observe(host)
    this.resize(host)
    this.last = performance.now()
    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
  }

  setActive(active: boolean): void {
    this.active = active
  }

  setWeapon(weaponId: number, build: WeaponBuild | null | undefined): void {
    this.modelRoot.clear()
    this.modelDispose?.()
    this.modelDispose = null
    const flags = buildFlags(build)
    let dispose: (() => void) | null = null
    let group: Group | null = null

    if (weaponId === 1) {
      const built = buildRifle(
        { barrelLen: 0.62, forendLen: 0.34, sightBack: 0, scope: false, suppressor: false },
        this.materials,
      )
      group = built.group
      dispose = () => built.dispose()
    } else if (weaponId === 6) {
      const built = buildRifle(
        { barrelLen: 0.56, forendLen: 0.30, sightBack: 0.06, scope: false, suppressor: false },
        this.materials,
      )
      group = built.group
      dispose = () => built.dispose()
    } else if (weaponId === 4) {
      const built = buildRifle(
        { barrelLen: 0.74, forendLen: 0.40, sightBack: 0, scope: false, suppressor: false },
        this.materials,
      )
      group = built.group
      dispose = () => built.dispose()
    } else if (weaponId === 2 || weaponId === 3) {
      const built = buildShotgun(this.materials)
      group = built.group
      dispose = () => built.dispose()
    } else if (weaponId === 5) {
      const built = buildRevolver(this.materials)
      group = built.group
      dispose = () => built.dispose()
    } else if (weaponId === 10) {
      const built = buildKnife(this.materials)
      group = built.group
      dispose = () => built.dispose()
    }

    if (!group) return

    // 军械库与局内共用 `parts/attachments.ts` 的同一批 builder：
    // 工作台里看到的件，就是进局后手里的那件。buildRifle 的内置配件
    // 已经通过 scope:false / suppressor:false 关掉，避免出现两套模型。
    const barrelOf: Record<number, number> = { 1: 0.62, 6: 0.56, 4: 0.74 }
    const forendOf: Record<number, number> = { 1: 0.34, 6: 0.30, 4: 0.40 }
    if (barrelOf[weaponId] !== undefined && group) {
      const slots = (build as WeaponBuild | null | undefined)?.slots ?? {}
      const modelOf = (key: 'sight' | 'muzzle' | 'magazine' | 'stock'): string | null => {
        const id = slots[key]
        return id ? (attachmentById(id)?.model ?? null) : null
      }
      const muzzleZ = -0.31 - barrelOf[weaponId]!
      if (modelOf('muzzle') === 'brake') group.add(createMuzzleBrake(this.materials, muzzleZ))
      if (modelOf('magazine') === 'extended' || modelOf('magazine') === 'quick') {
        group.add(
          createMagazineTube(this.materials, {
            forendZ: -0.15 - forendOf[weaponId]! / 2,
            muzzleZ,
            extension: modelOf('magazine') === 'extended' ? 0.07 : 0.03,
          }),
        )
      }
      const stockModel = modelOf('stock')
      if (stockModel === 'heavy' || stockModel === 'light') {
        group.add(createStockVariant(this.materials, stockModel))
      }
      if (modelOf('muzzle') === 'suppressor') group.add(createSuppressor(this.materials, muzzleZ))
      const sightModel = modelOf('sight')
      if (sightModel === 'scope4') group.add(createScope4x(this.materials))
      else if (sightModel === 'scope2') group.add(createScope2x(this.materials))
    }

    // 模型局部坐标可能从枪托到枪口偏在一侧；**先缩放、再按缩放后的包围盒
    // 居中**。反过来（先减 center 再 scale）会把偏移也乘上缩放，枪会被甩出画面。
    group.updateMatrixWorld(true)
    const rawBox = new Box3().setFromObject(group)
    const rawSize = rawBox.getSize(new Vector3())
    const fit = 0.68 / Math.max(rawSize.x, rawSize.y, rawSize.z, 0.2)
    group.scale.setScalar(fit)
    group.updateMatrixWorld(true)
    const box = new Box3().setFromObject(group)
    const center = box.getCenter(new Vector3())
    const size = box.getSize(new Vector3())
    group.position.sub(center)
    this.modelRoot.add(group)
    this.floor.position.y = -Math.max(0.16, size.y / 2 + 0.06)
    this.ring.position.y = this.floor.position.y + 0.005
    this.camera.position.set(0, Math.max(0.1, size.y * 0.1), 0.95)
    this.camera.lookAt(0, 0, 0)
    this.modelDispose = dispose
    this.yaw = this.baseYaw
    this.turntable.rotation.y = this.yaw
    this.turntable.rotation.x = this.pitch
  }

  private loop(now: number): void {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    if (!this.active) return
    if (this.autoSpin && !this.dragging) this.yaw += dt * 0.32
    this.turntable.rotation.y = this.yaw
    this.turntable.rotation.x = this.pitch
    this.ring.rotation.z += dt * 0.08
    this.renderer.render(this.scene, this.camera)
  }

  private resize(host: HTMLElement): void {
    const width = Math.max(1, host.clientWidth || 1)
    const height = Math.max(1, host.clientHeight || 1)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('wheel', this.onWheel)
    this.modelRoot.clear()
    this.modelDispose?.()
    this.modelDispose = null
    for (const material of Object.values(this.materials)) material.dispose()
    this.floor.geometry.dispose()
    ;(this.floor.material as MeshStandardMaterial).dispose()
    this.ring.geometry.dispose()
    ;(this.ring.material as MeshBasicMaterial).dispose()
    this.renderer.dispose()
  }
}
