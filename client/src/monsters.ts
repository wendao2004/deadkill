/**
 * 怪物渲染层：把服务端快照里的怪物画成"4 级色阶 + 墨线"的手绘怪。
 *
 * 这一层和 render.ts 一样，刻意不认识网络与 AI —— 它只接收"本帧应该画成什么样"
 * 的列表。于是"怪看着卡"和"怪跑错位"能分开排查：卡看这里，错位看服务端。
 *
 * ## 四条硬约束，决定了代码长成这样
 *
 * 1. **零每帧分配**：sync 每秒跑 60~144 次，任何 new / 数组字面量 / 闭包都会在
 *    几分钟内把 GC 逼出来，表现是"每隔一阵卡一下"。所以骨架（每种怪各
 *    maxVisible 套）在构造时全部建好并池化，几何体按尺寸共享，材质按"套"复用；
 *    sync 里只有数字赋值，连一个临时对象都不建。
 *
 * 2. **插值**：服务端 20Hz，显示器 144Hz。直接把快照位置抄给模型 = 每 7 帧跳一次，
 *    6.1m/s 的狗看着像瞬移。这里做指数平滑（时间常数 50ms）：alpha = 1-exp(-dt/tau)，
 *    dt 变化时"同一段时间收敛同一比例"，所以 60Hz 和 144Hz 看起来一样顺。位移
 *    超过 3m 时**直接吸附**（复活/传送/被拉回巢穴），否则玩家会看到一只怪贴着
 *    地面飞来。
 *
 * 3. **脚底原点**：每套骨架的原点都在脚底（y=0），怪物的 y 直接来自快照。这样
 *    "站在地面上"这件事由服务端的一串数字负责，客户端不用去猜地形高度差，也
 *    不会出现"上坡时怪陷进土里"。
 *
 * 4. **yaw 约定**（依赖 shared/src/math.ts:38-40 的 yawToForward）：
 *    yaw = 0 时朝 -Z 看，forward = (-sin(yaw), 0, -cos(yaw))。所以骨架全部
 *    **朝 -Z 建模**（grunt 的脸/眼在 -Z 侧，hound 的鼻子和下颌在 -Z 侧），
 *    然后直接 root.rotation.y = yaw 即可 —— 正好与 three.js Object3D 的
 *    绕 Y 逆时针旋转一致，不需要额外加 PI 或取负。改了建模朝向就必须同步
 *    改这一条，否则所有怪会背对着你倒着走。
 *
 * ## 墨线为什么和 render.ts 长得一样
 *
 * 背面外壳（BackSide）+ 沿法线外扩，外扩量乘 pos.w —— 抵消透视除法后线宽是
 * **屏幕**尺度而不是世界尺度，远处不会细到消失、贴脸不会粗成一坨。区别只有一处：
 * 怪物要能淡出（尸体），所以这里的墨线材质多一个 uOpacity，且材质是"每套骨架
 * 一份"而不是全局共享（共享材质改 opacity 会把所有怪一起淡掉）。
 */

import {
  BackSide,
  Box3,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  PlaneGeometry,
  ShaderMaterial,
} from 'three'
import type { Camera, DataTexture, Object3D, Scene } from 'three'

import { applyComicInk } from './ink.ts'
import { OUTLINE_SHARED } from './outline.ts'
import { SHADOW_GEOMETRY, createShadowMaterial, createShadowTexture } from './shadows.ts'

// ------------------------------------------------------------------ 对外契约

export interface MonsterView {
  id: number
  /** 0 = grunt, 1 = hound, 2 = gunner, 3 = boss（shared/src/ai.ts 的 MonsterKind 下标）。 */
  kind: number
  /** 0 idle 1 chase 2 attack 3 dead */
  state: number
  x: number
  y: number
  z: number
  yaw: number
  health: number
}

export interface MonsterRendererOptions {
  /** render.ts 的共享 4 级阶梯 DataTexture，别自己再造一份。 */
  gradientMap: DataTexture
  /** 同时显示上限，默认 12。 */
  maxVisible?: number
  /**
   * 血条是 billboard（每帧抄相机四元数），所以需要相机。
   * 不传也不会崩，只是**不显示血条**（没有相机就无从谈"朝向观众"）；
   * 怪本体、动画、尸体全都照常工作。
   */
  camera?: Camera
  /**
   * 超过这个水平距离的怪不渲染（默认 70m）。
   *
   * 关卡只有 ~120m，夜雾在 45m 外已经吃掉大半轮廓；把远处的怪整个跳过，
   * 比让它们各画几十个零件更划算。弱 GPU 会把这条线压到 45m。
   */
  maxDistance?: number
}

export interface MonsterRenderer {
  /** 每帧调用。list 是服务端快照里的全部怪物（含 state=dead 的）。dt 秒。 */
  sync(list: MonsterView[], dt: number): void
  dispose(): void
  readonly root: Object3D
}

// ------------------------------------------------------------------ 常量

/** 怪物种类下标，与 shared/src/ai.ts 的 MonsterKind 顺序一一对应。 */
const KIND_GRUNT = 0
const KIND_HOUND = 1
const KIND_GUNNER = 2
const KIND_BOSS = 3
const KIND_BELLKEEPER = 4
const KIND_GOLEM = 5
const KIND_CONDUCTOR = 6

/** 快照里的状态码（shared/src/protocol.ts 的 MonsterSnapshot.state）。 */
const STATE_IDLE = 0
const STATE_CHASE = 1
const STATE_ATTACK = 2
const STATE_DEAD = 3
const STATE_SPECIAL = 4

/**
 * 每种怪的外观参数。
 *
 * 数值与 shared/src/ai.ts 的 MONSTER_SPECS 对齐，但**不 import 那张表**：
 * 渲染层不该依赖服务端 AI 常量（那边会为了平衡性随便调速度，调完不该连带
 * 影响画面）。height 是"站直时头顶到脚底"的米数，既是建模验收标准，也是
 * 头顶血条的锚点。
 */
interface KindStyle {
  height: number
  maxHealth: number
  /** 冲刺速度（米/秒），只用于把"实际速度"归一化成摆臂幅度。 */
  speed: number
  /** 攻击节奏（秒），lunge 动画按这个周期循环。 */
  attackInterval: number
  hide: number
  limb: number
  cloth: number
  eye: number
}

/**
 * grunt 骨架建模时的头顶高度（米）：buildGrunt 的躯干/头/腿就是照这个尺寸手写的
 * （头的枢轴 1.44 + 头中心 0.24 + 半高 0.17 = 1.85）。
 */
const GRUNT_SKELETON_HEIGHT = 1.85

/** 屠夫的总高（米），与 shared/src/ai.ts 的 MONSTER_SPECS.boss.height 对齐。 */
const BOSS_HEIGHT = 3.3
const BELLKEEPER_HEIGHT = 3.4
const GOLEM_HEIGHT = 3.9
const CONDUCTOR_HEIGHT = 3.4

/**
 * boss = 把整副 grunt 骨架放大这么多倍。
 *
 * 只缩放 bob（它的原点就在脚底），所以放大后脚底仍然落在 y=0，快照里的 y 照旧
 * 是地面 —— 不会浮空，也不会陷地。
 */
const BOSS_SCALE = BOSS_HEIGHT / GRUNT_SKELETON_HEIGHT
const BELLKEEPER_SCALE = BELLKEEPER_HEIGHT / GRUNT_SKELETON_HEIGHT
const GOLEM_SCALE = GOLEM_HEIGHT / GRUNT_SKELETON_HEIGHT
const CONDUCTOR_SCALE = CONDUCTOR_HEIGHT / GRUNT_SKELETON_HEIGHT

/** 屠夫长柄肉钩的静止角（rad）：柄略微后仰，钩头正好压在头顶后方。 */
const BOSS_HOOK_REST = 0.3

const STYLES: Partial<Record<number, KindStyle>> = {
  [KIND_GRUNT]: {
    height: GRUNT_SKELETON_HEIGHT,
    maxHealth: 120,
    speed: 4.4,
    attackInterval: 1.1,
    hide: 0x6f7a58,
    limb: 0x53604a,
    cloth: 0x594733,
    eye: 0xffc85a,
  },
  [KIND_HOUND]: {
    height: 1.0,
    maxHealth: 70,
    speed: 6.1,
    attackInterval: 0.75,
    hide: 0x7b6f61,
    limb: 0x4c443a,
    cloth: 0x3e3630,
    eye: 0xff7f3a,
  },
  /**
   * 枪手：身高/判定盒与 grunt 完全一致（1.85/120 里的 110 只是血少），
   * 但配色偏"晒白的尸体 + 深色呢布"，在沼泽的橄榄绿里是一块更亮的剪影 ——
   * 看见它的时候通常已经进了它 16m 射程，剪影辨识度比细节重要。
   */
  [KIND_GUNNER]: {
    height: GRUNT_SKELETON_HEIGHT,
    maxHealth: 110,
    speed: 3.6,
    attackInterval: 1.5,
    hide: 0x9a9078,
    limb: 0x45443d,
    cloth: 0x3a332c,
    eye: 0xf2e6b0,
  },
  /**
   * 屠夫（boss）：3.3m，血巢的最终目标。配色是"骨白的皮 + 暗血的围裙
   * + 锈铁的钩子"：在一群橄榄绿的杂兵里，它是一块又高又红的剪影。
   */
  [KIND_BOSS]: {
    height: BOSS_HEIGHT,
    maxHealth: 1200,
    speed: 4.6,
    attackInterval: 1.6,
    hide: 0xb8a68e,
    limb: 0x3e342c,
    cloth: 0x5c3a2c,
    eye: 0xff9a3c,
  },
  /**
   * 敲钟人：瘦高的黑袍。配色刻意压到近黑，只有提灯/钟口的一点冷黄 ——
   * 在墓园的蓝夜里，先看见的是一根会动的黑影，然后才看清钟。
   */
  [KIND_BELLKEEPER]: {
    height: 3.4,
    maxHealth: 1500,
    speed: 3.6,
    attackInterval: 1.5,
    hide: 0x796f63,
    limb: 0x2f2a24,
    cloth: 0x24242a,
    eye: 0xffe08a,
  },
  /**
   * 石心巨像：采石场的尘土黄 + 锈红关节，胸口一块自发光的矿核。
   * 它比屠夫矮胖得多，远看是一坨会动的石堆而不是人形。
   */
  [KIND_GOLEM]: {
    height: 3.9,
    maxHealth: 2200,
    speed: 3.1,
    attackInterval: 2.0,
    hide: 0x8a7f6a,
    limb: 0x5a5044,
    cloth: 0x6b341f,
    eye: 0x9fe0ff,
  },
  /**
   * 末班车长：深蓝制服、铜扣、手里一盏暖黄提灯。它是四只 Boss 里唯一
   * 自带"人形光源"的，玩家会先看见灯，再看见枪口。
   */
  [KIND_CONDUCTOR]: {
    height: 3.4,
    maxHealth: 1400,
    speed: 4.2,
    attackInterval: 1.5,
    hide: 0x9b9384,
    limb: 0x2b2f36,
    cloth: 0x1f2b3a,
    eye: 0xffb347,
  },
}

const TAU = Math.PI * 2

/** 墨线颜色：和 render.ts 的描边、棱边线同一个近黑色，全游戏只有这一种"墨"。 */
const INK_COLOR = 0x12100e

/** 墨线基准宽度（NDC）。怪物比木箱大一圈，比玩家角色再粗一点点才压得住。 */
const INK_WIDTH = 3.0

/** 位置插值时间常数（秒）。50ms ≈ 一个 20Hz 快照周期的一半，够顺也不拖。 */
const INTERP_TAU = 0.05

/** 朝向插值时间常数（秒）。转身比平移慢一点，否则狗会"甩头"。 */
const YAW_TAU = 0.08

/** 超过这个位移就认为不是"走"而是"传送"：直接吸附，不插值。 */
const SNAP_DISTANCE = 3

/** 倒地动画时长（秒）。 */
const COLLAPSE_TIME = 0.45
/** 倒地角度：85°，不是 90° —— 完全躺平会看不见躯干厚度，像一块板。 */
const COLLAPSE_ANGLE = (85 * Math.PI) / 180
/** 尸体额外往泥里压一点（米），免得躺在草皮上像贴片。 */
const CORPSE_SINK = 0.02
/** 尸体保留时长（秒）：从死亡瞬间算起，玩家要能看清它死了。 */
const CORPSE_HOLD = 6
/** 尸体淡出时长（秒），接在 CORPSE_HOLD 之后。 */
const CORPSE_FADE = 0.7

const BAR_WIDTH = 0.5
const BAR_HEIGHT = 0.065
/** 血条离头顶的余量（米），避免和墨线打架。 */
const BAR_LIFT = 0.22
/** 血条底色（近黑的墨色，和描边同一族）。 */
const BAR_BACK_COLOR = 0x1b1712
/** 血条填充：漫画里的荧光酸绿，在土黄绿的沼泽里对比度最高。 */
const BAR_FILL_COLOR = 0xc8d94a

const DEFAULT_MAX_VISIBLE = 12

// ------------------------------------------------------------------ 骨架结构

interface RigMaterials {
  hide: MeshToonMaterial
  limb: MeshToonMaterial
  cloth: MeshToonMaterial
  eye: MeshBasicMaterial
  /** 常规墨线（躯干 / 四肢 / 破布）。 */
  ink: ShaderMaterial
  /**
   * 细墨线，只给眼球这种几厘米的零件用。
   *
   * 外扩量是**屏幕**尺度：一颗 6cm 的眼珠在 15m 外只有几个像素，套上常规
   * 墨线会被整圈黑边吃掉、变成一个黑点（render.ts 对 9mm 的准星也是同一个
   * 处理）。小零件单独用半宽墨线 —— 照样有描边，但不至于糊死。
   */
  inkThin: ShaderMaterial
}

/** grunt 的可动关节。腿臂都是"铰链 Group + 向下偏移的网格"，才能绕肩/胯转。 */
interface GruntNodes {
  head: Group
  armL: Group
  armR: Group
  legL: Group
  legR: Group
}

/** gunner 的可动关节：复用 grunt 的骨架，多一个端在胸前的枪。 */
interface GunnerNodes extends GruntNodes {
  gun: Group
}

/** Boss 的可动关节：复用 grunt 的骨架，再挂上各自的重型道具。 */
interface BossNodes extends GruntNodes {
  /** 3 = 屠夫 4 = 敲钟人 5 = 石心巨像 6 = 末班车长。 */
  variant: number
  /** 肉钩：枢轴在握把上，绕 X 抬起来再砸下去。 */
  hook: Group | null
  /** 钟：吊在胸前的横梁上，随敲击摆动。 */
  bell: Group | null
  /** 钟锤 / 信号杖：右手握持。 */
  hammer: Group | null
  /** 提灯：左手提着，也是车长的光源。 */
  lantern: Group | null
  /** 胸口矿核：石心巨像的弱点，受击时发亮。 */
  core: Mesh | null
}

/** hound 的可动关节：头、下颌、四条腿（顺序 FL, FR, BL, BR）。 */
interface HoundNodes {
  head: Group
  jaw: Group
  legs: Group[]
}

interface HealthBar {
  group: Group
  back: Mesh
  fill: Mesh
}

interface Rig {
  kind: number
  /** 位置 = 脚底，rotation.y = yaw（骨架朝 -Z 建模）。 */
  root: Group
  /** 死亡倒地枢轴：绕脚底旋转，整只怪一起倒。 */
  fall: Group
  /** 呼吸/冲刺的上下浮动与低血量压扁，绕脚底缩放。 */
  bob: Group
  grunt: GruntNodes | null
  hound: HoundNodes | null
  gunner: GunnerNodes | null
  boss: BossNodes | null
  mats: RigMaterials
  /** 需要淡出的常规材质（预先建好数组：淡出时不能临时拼数组，那是每帧分配）。 */
  fadeMats: { transparent: boolean; depthWrite: boolean; needsUpdate: boolean; opacity: number }[]
  /** 需要淡出的墨线材质（不透明度在 uOpacity 里，不在 .opacity）。 */
  fadeInks: ShaderMaterial[]
  bar: HealthBar
  /** 当前占用的怪物 id，0 = 空闲可被池子回收。 */
  assignedId: number
  /** 最近一次出现在快照里的帧号。 */
  lastSeenFrame: number
  /** 是否已经有目标位姿（第一次出现必须吸附，不能从原点飘过去）。 */
  hasTarget: boolean
  tx: number
  ty: number
  tz: number
  state: number
  health: number
  /** 程序化动画时钟（秒）。 */
  clock: number
  /** 当前状态已经持续多久（秒）。Boss 的攻击节拍按它算，避免和服务器判定错拍。 */
  stateAge: number
  /** 平滑后的水平速度（米/秒），驱动摆臂幅度。 */
  speed: number
  /** 已经死了多久（秒）。 */
  deadTime: number
  /** 正在淡出：透明通道已打开，需要在复用时关回去。 */
  fading: boolean
  /** 倒地后需要抬多高才能让最低点贴地（构造时用 Box3 量出来的）。 */
  corpseLift: number
  /** bob 的基准缩放（boss 靠它长到 3.3m，其它怪 = 1）。低血压扁时按它乘。 */
  baseScale: number
}

// ------------------------------------------------------------------ 实现

class MonsterLayer implements MonsterRenderer {
  readonly root = new Group()

  private readonly scene: Scene
  private readonly gradientMap: DataTexture
  private readonly camera: Camera | null
  private readonly maxVisible: number
  /** 水平距离平方；超过就不渲染，也不占可见名额。 */
  private readonly maxDistanceSq: number
  /** id → 骨架。只在出生/消失时写，每帧只读。 */
  private readonly byId = new Map<number, Rig>()
  /** 全部池化骨架（每种怪各 maxVisible 套），用于回收扫描。 */
  private readonly rigs: Rig[] = []
  /** 统一释放表：几何体、材质、贴图都往这里塞，dispose 时一把关掉。 */
  private readonly disposables: { dispose(): void }[] = []
  /** 同尺寸盒子共用一份几何体：几十套骨架的腿其实是同一个 BoxGeometry。 */
  private readonly boxCache = new Map<string, BoxGeometry>()
  private readonly barGeometry: PlaneGeometry
  private readonly barBackMaterial: MeshBasicMaterial
  private readonly barFillMaterial: MeshBasicMaterial
  private readonly shadowTexture = createShadowTexture()
  private readonly shadowMaterial = createShadowMaterial(this.shadowTexture, 0.46)
  /**
   * 建模期间"当前这一套骨架的墨线材质"。
   *
   * 只在一套骨架构建的那几毫秒里被写入，sync 期间恒为 null —— 这样 part()
   * 不必把墨线材质一路透传成参数，也不会在每帧里碰它。
   */
  private activeInk: ShaderMaterial | null = null
  private activeInkThin: ShaderMaterial | null = null
  private frame = 0

  constructor(scene: Scene, options: MonsterRendererOptions) {
    this.scene = scene
    // 渐变图是 render.ts 的共享资源，**不**加进 disposables：释放它会把整个
    // 场景的卡通材质一起打回默认渐变。
    this.gradientMap = options.gradientMap
    this.camera = options.camera ?? null
    const requested = options.maxVisible ?? DEFAULT_MAX_VISIBLE
    this.maxVisible = Math.max(1, Math.floor(requested))
    const maxDistance = Math.max(10, options.maxDistance ?? 70)
    this.maxDistanceSq = maxDistance * maxDistance

    // 血条几何体/材质全层共享：每只怪只改 scale.x，不占额外显存。
    this.barGeometry = new PlaneGeometry(1, 1)
    this.barBackMaterial = new MeshBasicMaterial({ color: BAR_BACK_COLOR, fog: false })
    this.barFillMaterial = new MeshBasicMaterial({ color: BAR_FILL_COLOR, fog: false })
    this.disposables.push(this.barGeometry, this.barBackMaterial, this.barFillMaterial)
    this.disposables.push(this.shadowTexture, this.shadowMaterial)

    // 池子一次性建满：每种怪最多同时占用 maxVisible 套骨架，建满之后
    // sync 里再也不会 new 任何东西。
    const kinds = [KIND_GRUNT, KIND_HOUND, KIND_GUNNER, KIND_BOSS, KIND_BELLKEEPER, KIND_GOLEM, KIND_CONDUCTOR]
    for (const kind of kinds) {
      const style = STYLES[kind]
      // Boss 一局最多一只，为每种 Boss 建满 maxVisible 套是白烧显存/建模时间；
      // 留 2 套只为覆盖"上一只尸体还没淡出、下一局同一张图又刷了"的极端情况。
      const pool = kind >= KIND_BOSS ? Math.min(2, this.maxVisible) : this.maxVisible
      if (style) for (let i = 0; i < pool; i++) this.rigs.push(this.createRig(kind, style))
    }

    scene.add(this.root)
  }

  // ---------------------------------------------------------------- 每帧

  sync(list: MonsterView[], dt: number): void {
    // 切标签页回来时 dt 可能是好几秒：夹住，否则插值一步到位、攻击循环连跳几个
    // 周期，画面像快进。
    const step = Math.min(Math.max(dt, 0), 0.25)
    this.frame++

    // 活着的先占位：快照里尸体可能排在前面，如果按顺序取前 maxVisible 个，
    // 被尸体挤掉的正好是那只正要咬人的。
    let slots = this.maxVisible
    for (let pass = 0; pass < 2 && slots > 0; pass++) {
      const wantDead = pass === 1
      for (let i = 0; i < list.length && slots > 0; i++) {
        const view = list[i]
        if ((view.state === STATE_DEAD) !== wantDead) continue
        if (this.applyView(view, step)) slots--
      }
    }

    // 本帧没出现的怪：隐藏 + 交还骨架。**不**销毁 —— 销毁再建就是每帧分配。
    for (let i = 0; i < this.rigs.length; i++) {
      const rig = this.rigs[i]
      if (rig.assignedId !== 0 && rig.lastSeenFrame !== this.frame) this.release(rig)
    }
  }

  /** 把一个快照记录套到骨架上。返回 true 表示这一条占掉了一个可见名额。 */
  private applyView(view: MonsterView, dt: number): boolean {
    const style = STYLES[view.kind]
    // 未知种类（将来加怪）：不画，但也不能崩。
    if (!style) return false

    // 远处不渲染，也不占 maxVisible 名额：否则一堆雾里的怪会把近处的
    // 那只挤掉，玩家反而看不见正在咬自己的目标。
    if (this.camera !== null) {
      const dx = view.x - this.camera.position.x
      const dz = view.z - this.camera.position.z
      if (dx * dx + dz * dz > this.maxDistanceSq) return false
    }

    let rig = this.byId.get(view.id)
    if (rig !== undefined && rig.kind !== view.kind) {
      // 服务端复用了同一个 id 换种类：旧骨架的比例对不上，换一套。
      this.release(rig)
      rig = undefined
    }
    if (rig === undefined) {
      const fresh = this.acquire(view.kind)
      if (fresh === null) return false
      rig = fresh
      rig.assignedId = view.id
      // 第一帧必须吸附到目标：否则新怪会从池子里的"上次死亡位置"飘过来。
      rig.hasTarget = false
      this.byId.set(view.id, rig)
    }

    rig.lastSeenFrame = this.frame
    this.updateRig(rig, view, style, dt)
    return true
  }

  private updateRig(rig: Rig, view: MonsterView, style: KindStyle, dt: number): void {
    // ---- 位置：指数平滑逼近最新快照点
    const jump = Math.sqrt(
      (view.x - rig.tx) * (view.x - rig.tx) +
        (view.y - rig.ty) * (view.y - rig.ty) +
        (view.z - rig.tz) * (view.z - rig.tz),
    )
    // 插值前的世界位置，用来量"这一帧屏幕上真的移动了多少"。
    const prevX = rig.root.position.x
    const prevZ = rig.root.position.z
    if (!rig.hasTarget || jump > SNAP_DISTANCE) {
      // 传送/复活：直接吸附。硬插值会让怪贴着地面飞过好几米。
      rig.root.position.set(view.x, view.y, view.z)
      // 直接赋值即可：骨架按 yaw 约定朝 -Z 建模（见文件头第 4 条）。
      rig.root.rotation.y = view.yaw
      rig.speed = 0
    } else {
      const alpha = 1 - Math.exp(-dt / INTERP_TAU)
      rig.root.position.x += (view.x - rig.root.position.x) * alpha
      rig.root.position.y += (view.y - rig.root.position.y) * alpha
      rig.root.position.z += (view.z - rig.root.position.z) * alpha
      // 摆臂幅度按"屏幕上真的跑多快"给，而不是按 state 给：一只被队友挤住、
      // 快照里几乎没位移的怪不该原地高抬腿。
      //
      // 用**插值后**的位移而不是快照位移量：快照 20Hz、渲染 144Hz，两个快照
      // 之间的差值全部压在每 7 帧里的一帧上，直接拿来算速度会得到一堆尖峰。
      if (dt > 1e-4) {
        const moved = Math.sqrt(
          (rig.root.position.x - prevX) * (rig.root.position.x - prevX) +
            (rig.root.position.z - prevZ) * (rig.root.position.z - prevZ),
        )
        const instant = moved / dt
        // 时间常数约 0.1s：够快跟上起跑/急停，又不会被单帧抖动带跑。
        rig.speed += (instant - rig.speed) * Math.min(1, dt * 10)
      }
      const dyaw = shortestDelta(rig.root.rotation.y, view.yaw)
      rig.root.rotation.y += dyaw * (1 - Math.exp(-dt / YAW_TAU))
    }
    rig.tx = view.x
    rig.ty = view.y
    rig.tz = view.z
    rig.hasTarget = true

    const prevState = rig.state
    rig.state = view.state
    rig.stateAge = prevState === view.state ? rig.stateAge + dt : 0
    rig.health = view.health

    // 从尸体变回活物（复活/重生）：把淡出状态还原，否则新身体是透明的。
    if (view.state !== STATE_DEAD && rig.deadTime > 0) {
      rig.deadTime = 0
      this.setRigFade(rig, 1)
    }
    // 已经淡出干净的尸体保持隐藏，别每帧被下面这行点亮一次。
    rig.root.visible = !(view.state === STATE_DEAD && rig.deadTime >= CORPSE_HOLD + CORPSE_FADE)

    this.animateRig(rig, style, dt)
    this.updateBar(rig, style)
  }

  private updateBar(rig: Rig, style: KindStyle): void {
    const cam = this.camera
    // 只在"挨过打且还活着"时显示：满血时挂一排血条会让画面变成 MMO。
    const show =
      cam !== null && rig.root.visible && rig.state !== STATE_DEAD && rig.health > 0 && rig.health < style.maxHealth
    const bar = rig.bar
    bar.group.visible = show
    if (!show) return

    const ratio = Math.min(Math.max(rig.health / style.maxHealth, 0), 1)
    // 血条是 layer root 的直接子节点（不是 rig.root 的子节点）：root 恒等变换，
    // 于是抄相机四元数就等于给它世界朝向，不用再乘父节点的 yaw 再求逆。
    bar.group.position.set(
      rig.root.position.x,
      rig.root.position.y + style.height + BAR_LIFT,
      rig.root.position.z,
    )
    bar.group.quaternion.copy(cam.quaternion)
    bar.back.scale.set(BAR_WIDTH, BAR_HEIGHT, 1)
    // 填充条左对齐：宽度按血量缩、位置补一半，锚点就钉死在左端。
    bar.fill.scale.set(BAR_WIDTH * Math.max(ratio, 0.001), BAR_HEIGHT * 0.6, 1)
    bar.fill.position.x = -BAR_WIDTH * (1 - ratio) * 0.5
  }

  // ---------------------------------------------------------------- 程序化动画

  private animateRig(rig: Rig, style: KindStyle, dt: number): void {
    rig.clock += dt
    const t = rig.clock

    // 低血量压矮一点点（最多 6%）：是"快倒了"的读条，幅度必须小 ——
    // 玩家对命中高的判断来自判定盒，视觉差太多就是骗人。
    const ratio = Math.min(Math.max(rig.health / style.maxHealth, 0), 1)
    rig.bob.scale.y = rig.baseScale * (1 - 0.06 * (1 - ratio))

    if (rig.state === STATE_DEAD) {
      this.animateDeath(rig, dt)
      return
    }

    // 活着时每帧复位"攻击/倒地"占用过的通道，各分支只管写自己要动的。
    rig.fall.position.set(0, 0, 0)
    rig.fall.rotation.x = 0
    rig.bob.position.y = 0
    rig.bob.rotation.z = 0

    if (rig.grunt !== null) this.animateGrunt(rig, rig.grunt, style, t)
    else if (rig.hound !== null) this.animateHound(rig, rig.hound, style, t)
    else if (rig.gunner !== null) this.animateGunner(rig, rig.gunner, style, t)
    else if (rig.boss !== null) this.animateBoss(rig, rig.boss, style, t)
  }

  /**
   * grunt：驼背两足，靠"上下颠 + 前后甩臂 + 躯干侧倾"三个正弦读出重量感。
   *
   * 正弦而不是随机：随机相位会让每只怪的动作和步频对不上，看起来像抽搐而不是
   * 走路。频率 9.2rad/s ≈ 1.46 步/秒，接近 4.4m/s 的步频。
   */
  private animateGrunt(rig: Rig, n: GruntNodes, style: KindStyle, t: number): void {
    if (rig.state === STATE_ATTACK) {
      // 攻击循环与 attackInterval 同步：动画节拍和真正咬下去的判定同频，
      // 玩家才能靠"它前倾了"预判该躲。
      const ph = (t % style.attackInterval) / style.attackInterval
      const windup = ph < 0.3 ? ph / 0.3 : 0
      const punch = ph >= 0.3 && ph < 0.62 ? Math.sin(((ph - 0.3) / 0.32) * Math.PI) : 0
      // -Z 是正前方，所以"向前扑"是 position.z 变小。
      rig.fall.position.z = -0.3 * punch
      rig.fall.rotation.x = 0.24 * windup - 0.2 * punch
      rig.bob.position.y = -0.06 * punch
      n.armL.rotation.x = -0.15 - 0.2 * windup - 1.25 * punch
      n.armR.rotation.x = -0.15 - 0.2 * windup - 1.25 * punch
      n.legL.rotation.x = -0.5 * punch
      n.legR.rotation.x = 0.35 * punch
      n.head.rotation.set(0.15 * punch, 0, 0)
      return
    }

    if (rig.state === STATE_CHASE) {
      const f = 9.2
      const amp = 0.35 + 0.65 * Math.min(rig.speed / style.speed, 1)
      const s = Math.sin(t * f)
      rig.bob.position.y = Math.abs(s) * 0.05 * amp
      rig.bob.rotation.z = s * 0.035 * amp
      n.legL.rotation.x = s * 0.75 * amp
      n.legR.rotation.x = -s * 0.75 * amp
      n.armL.rotation.x = -0.12 - s * 0.6 * amp
      n.armR.rotation.x = -0.12 + s * 0.6 * amp
      n.head.rotation.set(0.1, Math.sin(t * 2.3) * 0.06, 0)
      return
    }

    // idle：慢呼吸 + 缓慢张望。幅度只有一个多厘米，不动的怪像道具，
    // 动太多又像在抽搐。
    const breathe = Math.sin(t * 1.9)
    rig.bob.position.y = breathe * 0.016
    n.legL.rotation.x = 0
    n.legR.rotation.x = 0
    n.armL.rotation.x = -0.16 + Math.sin(t * 0.9) * 0.05
    n.armR.rotation.x = -0.16 - Math.sin(t * 0.9 + 1.1) * 0.05
    n.head.rotation.set(breathe * 0.03, Math.sin(t * 0.7) * 0.12, 0)
  }

  /**
   * gunner：永远端着枪。站定的 attack 态举枪瞄准，chase 态把枪压在腰上跑。
   *
   * 后坐周期用 attackInterval 而不是真正的开火 tick：快照里没有"开火时刻"，而
   * 服务端的射击冷却就是 attackInterval —— 两边节拍天然同频，看起来就是每一枪
   * 都踹了一下肩膀，不需要额外同步一个字段。
   */
  private animateGunner(rig: Rig, n: GunnerNodes, style: KindStyle, t: number): void {
    // 手臂要抬到"前平举"：上臂建模时垂在 -Y，绕 X **正**转才朝 -Z 抬起来。
    if (rig.state === STATE_ATTACK) {
      const ph = (t % style.attackInterval) / style.attackInterval
      const kick = ph < 0.2 ? Math.sin((ph / 0.2) * Math.PI) : 0
      const sway = Math.sin(t * 1.15) * 0.01
      rig.bob.position.y = sway
      // 枪口上跳 = 绕 X 正转（枪身朝 -Z 建），后坐同时把枪往肩膀里推一寸。
      n.gun.rotation.x = 0.18 * kick + sway * 0.5
      n.gun.position.z = -0.2 + 0.1 * kick
      n.armR.rotation.x = 1.3 + 0.16 * kick
      n.armL.rotation.x = 1.46 + 0.12 * kick
      n.legL.rotation.x = -0.06 * kick
      n.legR.rotation.x = 0.06 * kick
      n.head.rotation.set(-0.08 - 0.1 * kick, 0, 0)
      return
    }

    if (rig.state === STATE_CHASE) {
      const f = 9.2
      const amp = 0.35 + 0.65 * Math.min(rig.speed / style.speed, 1)
      const s = Math.sin(t * f)
      rig.bob.position.y = Math.abs(s) * 0.05 * amp
      rig.bob.rotation.z = s * 0.035 * amp
      n.legL.rotation.x = s * 0.75 * amp
      n.legR.rotation.x = -s * 0.75 * amp
      // 抱着枪赶路：枪口压到腰线以下，手臂几乎不动 —— 它是在走位，不是在瞄。
      n.gun.rotation.x = -0.5
      n.gun.position.z = -0.2
      n.armR.rotation.x = 0.95 - s * 0.08 * amp
      n.armL.rotation.x = 1.1 + s * 0.08 * amp
      n.head.rotation.set(0.06, Math.sin(t * 2.1) * 0.05, 0)
      return
    }

    // idle：枪口戳向地面，整个人跟着呼吸晃 —— 远处看就是一根立着的黑影。
    const breathe = Math.sin(t * 1.8)
    rig.bob.position.y = breathe * 0.014
    n.legL.rotation.x = 0
    n.legR.rotation.x = 0
    n.gun.rotation.x = -0.86 + breathe * 0.012
    n.gun.position.z = -0.2
    n.armR.rotation.x = 0.34 + breathe * 0.02
    n.armL.rotation.x = 0.46 - breathe * 0.02
    n.head.rotation.set(breathe * 0.03, Math.sin(t * 0.62) * 0.14, 0)
  }

  /**
   * Boss 动画总入口：按种类分发。四只 Boss 共用 grunt 的关节语义，
   * 但各自的重量、武器和"危险信号"完全不同。
   */
  private animateBoss(rig: Rig, n: BossNodes, style: KindStyle, t: number): void {
    if (n.variant === KIND_BELLKEEPER) this.animateBellkeeper(rig, n, style, t)
    else if (n.variant === KIND_GOLEM) this.animateGolem(rig, n, style, t)
    else if (n.variant === KIND_CONDUCTOR) this.animateConductor(rig, n, style, t)
    else this.animateButcher(rig, n, style, t)
  }

  /**
   * 屠夫（boss）：一柄 2.2m 的长柄肉钩。
   *
   * 攻击循环按**进入 attack 之后的时间**算，而不是全局时钟：全局时钟与服务端
   * 的第一次攻击没有任何对齐关系，玩家会看到"钩子还没落，血先掉了"。
   */
  private animateButcher(rig: Rig, n: BossNodes, style: KindStyle, t: number): void {
    const hook = n.hook
    if (rig.state === STATE_SPECIAL) {
      // 冲锋：前半段压低身子、钩子拖在身后；后半段整个人向前扑。
      const age = rig.stateAge
      const windup = age < 0.55 ? age / 0.55 : 0
      const charge = age >= 0.55 ? Math.min(1, (age - 0.55) / 0.18) : 0
      rig.fall.rotation.x = -0.34 * windup - 0.12 * charge
      rig.fall.position.z = -0.35 * charge
      rig.bob.position.y = -0.12 * windup
      if (hook) hook.rotation.x = BOSS_HOOK_REST + 0.55 * windup - 0.9 * charge
      n.armR.rotation.x = -0.5 * windup - 0.8 * charge
      n.armL.rotation.x = -0.4 * windup + 0.7 * charge
      n.legL.rotation.x = -0.55 * windup + 0.8 * charge
      n.legR.rotation.x = 0.45 * windup - 0.8 * charge
      n.head.rotation.set(-0.18 * windup + 0.1 * charge, 0, 0)
      return
    }

    if (rig.state === STATE_ATTACK) {
      const ph = (rig.stateAge % style.attackInterval) / style.attackInterval
      const windup = ph < 0.25 ? ph / 0.25 : 0
      const slam = ph >= 0.25 && ph < 0.62 ? Math.sin(((ph - 0.25) / 0.37) * Math.PI) : 0
      // 抬头 -Z 是正前方：柄绕 X **正**转是往后翻（抬钩），**负**转是钩头朝 -Z 拍下。
      if (hook) hook.rotation.x = BOSS_HOOK_REST + 0.9 * windup - 1.4 * slam
      n.armR.rotation.x = -0.2 + 0.3 * windup - 0.45 * slam
      // 左臂反着甩，配重才像抡东西，而不是在原地打摆子。
      n.armL.rotation.x = -0.2 + 0.5 * windup - 0.7 * slam
      // 上身前倾 + 往 -Z 扑半步，和 grunt 的 lunge 同一套读法。
      rig.fall.rotation.x = 0.2 * windup - 0.28 * slam
      rig.fall.position.z = -0.3 * slam
      rig.bob.position.y = -0.05 * slam
      n.legL.rotation.x = -0.35 * slam
      n.legR.rotation.x = 0.25 * slam
      n.head.rotation.set(0.18 * windup - 0.2 * slam, 0, 0)
      return
    }

    if (rig.state === STATE_CHASE) {
      // 步频比 grunt 慢一眼：3.3m 的个子迈一步就是一米多。
      const f = 7.4
      const amp = 0.35 + 0.65 * Math.min(rig.speed / style.speed, 1)
      const s = Math.sin(t * f)
      // 身体前倾 0.18rad：一跑起来就是压着人扑过来。
      rig.fall.rotation.x = -0.18
      rig.bob.position.y = Math.abs(s) * 0.06 * amp
      rig.bob.rotation.z = s * 0.05 * amp
      n.legL.rotation.x = s * 0.8 * amp
      n.legR.rotation.x = -s * 0.8 * amp
      // 大幅摆臂：钩子跟着胳膊一起晃，远处一眼能看出"它冲过来了"。
      n.armL.rotation.x = -0.2 - s * 0.95 * amp
      n.armR.rotation.x = -0.2 + s * 0.8 * amp
      if (hook) hook.rotation.x = BOSS_HOOK_REST + s * 0.12
      n.head.rotation.set(0.12, Math.sin(t * 2.1) * 0.07, 0)
      return
    }

    // idle：只有缓慢呼吸，幅度是 grunt 的两倍（0.032 vs 0.016）—— 3.3m 的胸腔
    // 起伏得看得见，但它站着不动的时候必须完全没有别的动作。
    const breathe = Math.sin(t * 0.95)
    rig.bob.position.y = breathe * 0.032
    n.legL.rotation.x = 0
    n.legR.rotation.x = 0
    n.armL.rotation.x = -0.2 + breathe * 0.02
    n.armR.rotation.x = -0.2
    if (hook) hook.rotation.x = BOSS_HOOK_REST
    n.head.rotation.set(breathe * 0.05, Math.sin(t * 0.45) * 0.1, 0)
  }

  /** 敲钟人：钟是它的威胁指示器 —— 钟摆起来就是脉冲要落地的时刻。 */
  private animateBellkeeper(rig: Rig, n: BossNodes, style: KindStyle, t: number): void {
    if (rig.state === STATE_SPECIAL) {
      const age = rig.stateAge
      // 0..0.9s 举锤，0.9s 落下；与服务端 pulse.windupMs 对齐。
      const raise = age < 0.9 ? age / 0.9 : 1
      const strike = age >= 0.9 ? Math.min(1, (age - 0.9) / 0.16) : 0
      n.armR.rotation.x = -0.2 + 2.2 * raise - 2.7 * strike
      n.armL.rotation.x = -0.2 + 0.7 * raise - 0.9 * strike
      if (n.hammer) n.hammer.rotation.x = 0.15 + 0.5 * raise - 1.4 * strike
      if (n.bell) n.bell.rotation.x = 0.16 * raise - 0.5 * strike
      rig.fall.rotation.x = -0.1 * raise + 0.16 * strike
      rig.bob.position.y = -0.08 * strike
      n.legL.rotation.x = 0.25 * strike
      n.legR.rotation.x = -0.2 * strike
      n.head.rotation.set(0.1 * raise - 0.2 * strike, 0, 0)
      return
    }

    if (rig.state === STATE_ATTACK) {
      const ph = (rig.stateAge % style.attackInterval) / style.attackInterval
      const windup = ph < 0.28 ? ph / 0.28 : 0
      const swing = ph >= 0.28 && ph < 0.62 ? Math.sin(((ph - 0.28) / 0.34) * Math.PI) : 0
      n.armR.rotation.x = -0.2 + 1.5 * windup - 2.4 * swing
      n.armL.rotation.x = -0.2 + 0.4 * windup - 0.5 * swing
      if (n.hammer) n.hammer.rotation.x = 0.15 + 0.3 * windup - 1.1 * swing
      if (n.bell) n.bell.rotation.x = 0.1 * windup - 0.35 * swing
      rig.fall.rotation.x = 0.12 * windup - 0.2 * swing
      rig.fall.position.z = -0.18 * swing
      rig.bob.position.y = -0.04 * swing
      n.head.rotation.set(0.1 * windup, 0, 0)
      return
    }

    if (rig.state === STATE_CHASE) {
      const f = 7.8
      const amp = 0.35 + 0.65 * Math.min(rig.speed / style.speed, 1)
      const s = Math.sin(t * f)
      rig.fall.rotation.x = -0.1
      rig.bob.position.y = Math.abs(s) * 0.045 * amp
      rig.bob.rotation.z = s * 0.035 * amp
      n.legL.rotation.x = s * 0.7 * amp
      n.legR.rotation.x = -s * 0.7 * amp
      n.armL.rotation.x = -0.2 - s * 0.3 * amp
      n.armR.rotation.x = -0.2 + s * 0.45 * amp
      if (n.hammer) n.hammer.rotation.x = 0.15
      if (n.bell) n.bell.rotation.x = s * 0.12 * amp
      n.head.rotation.set(0.08, Math.sin(t * 1.7) * 0.06, 0)
      return
    }

    const breathe = Math.sin(t * 0.9)
    rig.bob.position.y = breathe * 0.024
    n.legL.rotation.x = 0
    n.legR.rotation.x = 0
    n.armL.rotation.x = -0.2 + breathe * 0.03
    n.armR.rotation.x = -0.2
    if (n.hammer) n.hammer.rotation.x = 0.15
    if (n.bell) n.bell.rotation.x = breathe * 0.06
    n.head.rotation.set(breathe * 0.03, Math.sin(t * 0.4) * 0.08, 0)
  }

  /** 石心巨像：所有动作都慢半拍，前摇靠"整块身体抬起来"表达。 */
  private animateGolem(rig: Rig, n: BossNodes, style: KindStyle, t: number): void {
    if (rig.state === STATE_SPECIAL) {
      const age = rig.stateAge
      const raise = age < 1.1 ? age / 1.1 : 1
      const slam = age >= 1.1 ? Math.min(1, (age - 1.1) / 0.18) : 0
      rig.fall.rotation.x = -0.14 * raise + 0.34 * slam
      rig.fall.position.z = -0.2 * slam
      rig.bob.position.y = 0.1 * raise - 0.16 * slam
      n.armL.rotation.x = -0.2 + 2.0 * raise - 2.6 * slam
      n.armR.rotation.x = -0.2 + 2.0 * raise - 2.6 * slam
      n.legL.rotation.x = -0.25 * raise + 0.4 * slam
      n.legR.rotation.x = 0.25 * raise - 0.4 * slam
      n.head.rotation.set(-0.25 * raise + 0.2 * slam, 0, 0)
      if (n.core) n.core.scale.setScalar(1 + 0.7 * raise)
      return
    }

    if (rig.state === STATE_ATTACK) {
      const ph = (rig.stateAge % style.attackInterval) / style.attackInterval
      const windup = ph < 0.34 ? ph / 0.34 : 0
      const slam = ph >= 0.34 && ph < 0.64 ? Math.sin(((ph - 0.34) / 0.3) * Math.PI) : 0
      // 攻击只抬右拳，左拳做配重：两只一起动会像举手投降。
      n.armR.rotation.x = -0.2 + 1.8 * windup - 2.5 * slam
      n.armL.rotation.x = -0.2 + 0.3 * windup - 0.5 * slam
      rig.fall.rotation.x = 0.18 * windup - 0.3 * slam
      rig.fall.position.z = -0.16 * slam
      rig.bob.position.y = -0.1 * slam
      n.legL.rotation.x = 0.2 * slam
      n.legR.rotation.x = -0.15 * slam
      n.head.rotation.set(0.12 * windup, 0, 0)
      return
    }

    if (rig.state === STATE_CHASE) {
      const f = 5.8
      const amp = 0.35 + 0.65 * Math.min(rig.speed / style.speed, 1)
      const s = Math.sin(t * f)
      rig.fall.rotation.x = -0.08
      rig.bob.position.y = Math.abs(s) * 0.05 * amp
      rig.bob.rotation.z = s * 0.06 * amp
      n.legL.rotation.x = s * 0.55 * amp
      n.legR.rotation.x = -s * 0.55 * amp
      n.armL.rotation.x = -0.2 - s * 0.28 * amp
      n.armR.rotation.x = -0.2 + s * 0.28 * amp
      n.head.rotation.set(0.08, Math.sin(t * 1.2) * 0.04, 0)
      if (n.core) n.core.scale.setScalar(1)
      return
    }

    const breathe = Math.sin(t * 0.7)
    rig.bob.position.y = breathe * 0.03
    n.legL.rotation.x = 0
    n.legR.rotation.x = 0
    n.armL.rotation.x = -0.2 + breathe * 0.02
    n.armR.rotation.x = -0.2 - breathe * 0.02
    n.head.rotation.set(breathe * 0.02, Math.sin(t * 0.35) * 0.06, 0)
    if (n.core) n.core.scale.setScalar(1 + breathe * 0.04)
  }

  /** 末班车长：枪线和提灯是两条独立的信号；召唤时把灯举过头顶。 */
  private animateConductor(rig: Rig, n: BossNodes, style: KindStyle, t: number): void {
    if (rig.state === STATE_SPECIAL) {
      const age = rig.stateAge
      const raise = Math.min(1, age / 0.35)
      n.armL.rotation.x = -0.2 + 2.5 * raise
      n.armR.rotation.x = -0.2 + 0.8 * raise
      if (n.lantern) n.lantern.rotation.x = -0.2 * raise
      rig.fall.rotation.x = -0.06 * raise
      n.head.rotation.set(-0.2 * raise, 0, 0)
      return
    }

    if (rig.state === STATE_ATTACK) {
      const ph = (rig.stateAge % style.attackInterval) / style.attackInterval
      const aim = ph < 0.6 ? Math.min(1, ph / 0.25) : Math.max(0, 1 - (ph - 0.6) / 0.2)
      const kick = ph >= 0.6 && ph < 0.78 ? Math.sin(((ph - 0.6) / 0.18) * Math.PI) : 0
      n.armR.rotation.x = -0.2 + (1.45 + 0.16 * kick) * aim
      n.armL.rotation.x = -0.2 + 1.2 * aim
      if (n.hammer) {
        n.hammer.rotation.x = 0.2 + (1.2 + 0.22 * kick) * aim
        n.hammer.position.z = -0.1 * aim
      }
      if (n.lantern) n.lantern.rotation.x = 0.18 * aim
      rig.fall.rotation.x = -0.04 * aim
      rig.bob.position.y = 0.008 * kick
      n.legL.rotation.x = -0.05 * kick
      n.legR.rotation.x = 0.05 * kick
      n.head.rotation.set(-0.08 * aim, 0, 0)
      return
    }

    if (rig.state === STATE_CHASE) {
      const f = 8.8
      const amp = 0.35 + 0.65 * Math.min(rig.speed / style.speed, 1)
      const s = Math.sin(t * f)
      rig.fall.rotation.x = -0.1
      rig.bob.position.y = Math.abs(s) * 0.04 * amp
      rig.bob.rotation.z = s * 0.03 * amp
      n.legL.rotation.x = s * 0.7 * amp
      n.legR.rotation.x = -s * 0.7 * amp
      n.armL.rotation.x = -0.2 - s * 0.35 * amp
      n.armR.rotation.x = -0.2 + s * 0.55 * amp
      if (n.hammer) n.hammer.rotation.x = 0.2
      if (n.lantern) n.lantern.rotation.x = s * 0.1 * amp
      n.head.rotation.set(0.06, Math.sin(t * 1.9) * 0.05, 0)
      return
    }

    const breathe = Math.sin(t * 1.1)
    rig.bob.position.y = breathe * 0.018
    n.legL.rotation.x = 0
    n.legR.rotation.x = 0
    n.armL.rotation.x = -0.2 + breathe * 0.02
    n.armR.rotation.x = -0.2
    if (n.hammer) n.hammer.rotation.x = 0.2
    if (n.lantern) n.lantern.rotation.x = breathe * 0.03
    n.head.rotation.set(breathe * 0.02, Math.sin(t * 0.5) * 0.1, 0)
  }

  /**
   * hound：低矮四足，对角腿成对摆动（小跑），头一直微微前探。
   * 频率 13rad/s ≈ 2.07 步/秒，比 grunt 快得多，才对得上 6.1m/s 的冲刺。
   */
  private animateHound(rig: Rig, n: HoundNodes, style: KindStyle, t: number): void {
    const legs = n.legs
    if (rig.state === STATE_ATTACK) {
      const ph = (t % style.attackInterval) / style.attackInterval
      const bite = ph < 0.45 ? Math.sin((ph / 0.45) * Math.PI) : 0
      rig.fall.position.z = -0.2 * bite
      rig.fall.rotation.x = -0.1 * bite
      rig.bob.position.y = -0.03 * bite
      // 下颌张开的角度就是"要咬了"的唯一提示，所以它比身体动作大。
      n.jaw.rotation.x = 0.12 + 0.6 * bite
      n.head.rotation.set(-0.12 * bite, 0, 0)
      for (let i = 0; i < legs.length; i++) legs[i].rotation.x = (i % 2 === 0 ? -0.35 : 0.3) * bite
      return
    }

    if (rig.state === STATE_CHASE) {
      const f = 13
      const amp = 0.35 + 0.65 * Math.min(rig.speed / style.speed, 1)
      const s = Math.sin(t * f)
      rig.bob.position.y = Math.abs(s) * 0.045 * amp
      // 对角小跑：FL 与 BR 同相，FR 与 BL 反相。
      legs[0].rotation.x = s * 0.8 * amp
      legs[1].rotation.x = -s * 0.8 * amp
      legs[2].rotation.x = -s * 0.8 * amp
      legs[3].rotation.x = s * 0.8 * amp
      n.jaw.rotation.x = 0.1 + Math.abs(s) * 0.12
      n.head.rotation.set(-0.06 + s * 0.05, Math.sin(t * 1.7) * 0.08, 0)
      return
    }

    // idle：头左右摆，下颌随喘气微微开合；身体几乎不动（低伏的猎食姿态）。
    rig.bob.position.y = Math.sin(t * 1.3) * 0.012
    for (let i = 0; i < legs.length; i++) legs[i].rotation.x = 0
    n.jaw.rotation.x = 0.06 + 0.05 * Math.sin(t * 2.2)
    n.head.rotation.set(Math.sin(t * 1.5) * 0.04, Math.sin(t * 0.9) * 0.18, 0)
  }

  /**
   * 倒地姿势的唯一来源：整体后倒 + 四肢松掉摊在地上。
   *
   * 构造期量 corpseLift 时也用这一段（ease=1），否则会出现"按站姿量、按躺姿用"
   * 的错位 —— 手臂一松，包围盒最低点就比站姿深十几厘米，尸体于是陷进地里。
   */
  private poseCollapse(rig: Rig, ease: number): void {
    rig.fall.rotation.x = COLLAPSE_ANGLE * ease
    // 四肢松掉摊在地上，之后不再动。
    if (rig.grunt !== null) {
      const n = rig.grunt
      n.armL.rotation.x = -1.1 * ease
      n.armR.rotation.x = -1.2 * ease
      n.legL.rotation.x = 0.3 * ease
      n.legR.rotation.x = -0.25 * ease
      n.head.rotation.set(0.35 * ease, 0.2 * ease, 0)
    } else if (rig.hound !== null) {
      const n = rig.hound
      for (let i = 0; i < n.legs.length; i++) n.legs[i].rotation.x = (i % 2 === 0 ? 0.45 : -0.4) * ease
      n.head.rotation.set(0.5 * ease, 0.15 * ease, 0)
      n.jaw.rotation.x = 0.3 * ease
    } else if (rig.boss !== null) {
      const n = rig.boss
      n.armL.rotation.x = -0.9 * ease
      n.armR.rotation.x = -0.7 * ease
      n.legL.rotation.x = 0.3 * ease
      n.legR.rotation.x = -0.25 * ease
      n.head.rotation.set(0.35 * ease, 0.2 * ease, 0)
      // 2.2m 的长柄必须跟着躺下去（臂角 + 钩角 + 倒地角 ≈ 90°），否则柄会插进
      // 地里，被 corpseLift 当成"整具尸体悬空"抬起来。ease=0 时正好回到静止角。
      if (n.hook) {
        n.hook.rotation.x =
          BOSS_HOOK_REST + (Math.PI / 2 - COLLAPSE_ANGLE + 0.7 - BOSS_HOOK_REST) * ease
      }
      if (n.bell) n.bell.rotation.x = -0.4 * ease
      if (n.hammer) n.hammer.rotation.x = 0.2 + 1.1 * ease
      if (n.lantern) n.lantern.rotation.x = 0.6 * ease
    }
  }

  /**
   * 死亡：绕脚底整体后倒 85°，然后原地躺 6 秒再淡出。
   *
   * 尸体**不隐藏**（玩家需要确认击杀），也不回收去画新怪 —— 它一直占着一个
   * 池位，直到服务端把它从快照里删掉。
   */
  private animateDeath(rig: Rig, dt: number): void {
    rig.deadTime += dt
    const p = Math.min(rig.deadTime / COLLAPSE_TIME, 1)
    // smoothstep：砸到地面那一下慢下来，有重量；线性看起来像被人推倒的纸板。
    const ease = p * p * (3 - 2 * p)
    this.poseCollapse(rig, ease)
    // corpseLift 是构造时用 Box3 量出来的"最低点贴地需要抬多高"：85° 旋转会让
    // 躯干插进地里十几厘米，硬编码一个数会在改模型比例后立刻失效。
    rig.fall.position.set(0, (rig.corpseLift - CORPSE_SINK) * ease, 0)
    rig.bob.position.y = 0
    rig.bob.rotation.z = 0
    rig.bob.scale.y = rig.baseScale

    const fade = (rig.deadTime - CORPSE_HOLD) / CORPSE_FADE
    if (fade <= 0) return
    const k = Math.min(fade, 1)
    this.setRigFade(rig, 1 - k)
    // 淡出的同时往下沉一点：被沼泽吃掉，比原地"啪"地消失干净。
    rig.fall.position.y -= 0.3 * k
    if (k >= 1) rig.root.visible = false
  }

  // ---------------------------------------------------------------- 池化

  private acquire(kind: number): Rig | null {
    for (let i = 0; i < this.rigs.length; i++) {
      const rig = this.rigs[i]
      if (rig.assignedId === 0 && rig.kind === kind) return rig
    }
    // 池子理论上永不耗尽（每种怪都建满 maxVisible 套）。真耗尽就少画一只，
    // 总之不能在 sync 里临时 new 一套骨架出来。
    return null
  }

  private release(rig: Rig): void {
    if (rig.assignedId !== 0) this.byId.delete(rig.assignedId)
    rig.assignedId = 0
    rig.root.visible = false
    rig.bar.group.visible = false
    rig.hasTarget = false
    rig.clock = 0
    rig.stateAge = 0
    rig.speed = 0
    rig.deadTime = 0
    rig.health = 0
    rig.state = 0
    rig.fall.position.set(0, 0, 0)
    rig.fall.rotation.set(0, 0, 0)
    rig.bob.position.set(0, 0, 0)
    rig.bob.rotation.set(0, 0, 0)
    rig.bob.scale.setScalar(rig.baseScale)
    this.setRigFade(rig, 1)
  }

  // ---------------------------------------------------------------- 淡出

  /**
   * 设整套骨架的不透明度（1 = 不透明）。
   *
   * 只有真的开始淡出时把 transparent 打开：常态让整层怪物留在**不透明**队列里
   * （少一遍透明排序，也不会和场景里其它半透明物件纠缠）。切换 transparent 会
   * 触发一次 program 重编译，但 program 是全局缓存的，只有全场第一次死亡付这笔钱。
   */
  private setRigFade(rig: Rig, value: number): void {
    const transparent = value < 1
    // 只在跨过 1 的边界时改 transparent：常态留在不透明队列里少一遍排序。
    if (rig.fading !== transparent) {
      rig.fading = transparent
      const mats = rig.fadeMats
      for (let i = 0; i < mats.length; i++) {
        const mat = mats[i]
        mat.transparent = transparent
        mat.depthWrite = !transparent
        mat.needsUpdate = true
      }
      const inks = rig.fadeInks
      for (let i = 0; i < inks.length; i++) inks[i].transparent = transparent
    }
    const mats = rig.fadeMats
    for (let i = 0; i < mats.length; i++) mats[i].opacity = value
    const inks = rig.fadeInks
    for (let i = 0; i < inks.length; i++) inks[i].uniforms.uOpacity.value = value
  }

  // ---------------------------------------------------------------- 建模

  private createRig(kind: number, style: KindStyle): Rig {
    const mats = this.makeRigMaterials(style)
    const rig: Rig = {
      kind,
      root: new Group(),
      fall: new Group(),
      bob: new Group(),
      grunt: null,
      hound: null,
      gunner: null,
      boss: null,
      mats,
      fadeMats: [mats.hide, mats.limb, mats.cloth, mats.eye],
      fadeInks: [mats.ink, mats.inkThin],
      bar: this.buildBar(style),
      assignedId: 0,
      lastSeenFrame: -1,
      hasTarget: false,
      tx: 0,
      ty: 0,
      tz: 0,
      state: 0,
      health: 0,
      clock: 0,
      stateAge: 0,
      speed: 0,
      deadTime: 0,
      fading: false,
      corpseLift: 0,
      baseScale: 1,
    }
    rig.root.add(rig.fall)
    rig.fall.add(rig.bob)
    const shadow = new Mesh(SHADOW_GEOMETRY, this.shadowMaterial)
    shadow.scale.set(style.height * 0.52, 1, style.height * 0.78)
    shadow.position.y = 0.02
    rig.root.add(shadow)
    this.activeInk = mats.ink
    this.activeInkThin = mats.inkThin
    if (kind === KIND_GRUNT) rig.grunt = this.buildGrunt(rig, mats)
    else if (kind === KIND_HOUND) rig.hound = this.buildHound(rig, mats)
    else if (kind === KIND_GUNNER) rig.gunner = this.buildGunner(rig, mats)
    else if (kind === KIND_BOSS) rig.boss = this.buildBoss(rig, mats)
    else if (kind === KIND_BELLKEEPER) rig.boss = this.buildBellkeeper(rig, mats)
    else if (kind === KIND_GOLEM) rig.boss = this.buildGolem(rig, mats)
    else if (kind === KIND_CONDUCTOR) rig.boss = this.buildConductor(rig, mats)
    this.activeInk = null
    this.activeInkThin = null

    // 量一次"倒下去之后最低点在哪"，换算成需要抬多高。用 Box3 而不是手调魔法数：
    // 以后改比例，尸体照样正好压在泥地上。
    this.poseCollapse(rig, 1)
    rig.root.updateMatrixWorld(true)
    const box = new Box3().setFromObject(rig.bob)
    rig.corpseLift = Number.isFinite(box.min.y) ? -box.min.y : 0
    this.poseCollapse(rig, 0)
    rig.root.updateMatrixWorld(true)

    rig.root.visible = false
    this.root.add(rig.root)
    return rig
  }

  private buildGrunt(rig: Rig, mats: RigMaterials): GruntNodes {
    const body = rig.bob

    // 躯干：向前倾 0.2rad。-Z 是正前方，所以"前倾"= 负角度。驼背是这类蛮子
    // 唯一能在中距离读出来的剪影特征。
    const torso = this.part(body, mats.hide, 0.64, 0.8, 0.46, 0, 1.06, 0)
    torso.rotation.x = -0.2

    // 头挂在颈部枢轴上，才能单独张望/低头。
    const head = this.hinge(body, 0, 1.44, -0.1)
    this.part(head, mats.hide, 0.36, 0.34, 0.36, 0, 0.24, -0.06)
    // 灯笼眼：MeshBasicMaterial 不受光照影响，永远是亮的 —— 卡通渲染里
    // "自发光"就该是纯色块。墨线用半宽的：6cm 的眼珠套常规墨线会在十几米外
    // 缩成一个黑点，灯笼眼就没了。
    this.part(head, mats.eye, 0.06, 0.06, 0.03, -0.095, 0.26, -0.235, true)
    this.part(head, mats.eye, 0.06, 0.06, 0.03, 0.095, 0.26, -0.235, true)

    // 臂：肩在 1.34m、臂长 0.78m —— 垂下来到膝盖附近，猩猩比例。
    const armL = this.hinge(body, -0.36, 1.34, -0.04)
    this.part(armL, mats.limb, 0.16, 0.78, 0.18, 0, -0.33, 0)
    armL.rotation.x = -0.16
    const armR = this.hinge(body, 0.36, 1.34, -0.04)
    this.part(armR, mats.limb, 0.16, 0.78, 0.18, 0, -0.33, 0)
    armR.rotation.x = -0.16

    // 腿：胯在 0.72m、腿长 0.72m、网格下移一半 = 0.36 → 脚底正好落在 y=0。
    // 这是"脚底原点"的手工保证，改腿长必须同步改胯高。
    const legL = this.hinge(body, -0.17, 0.72, 0)
    this.part(legL, mats.limb, 0.18, 0.72, 0.2, 0, -0.36, 0)
    const legR = this.hinge(body, 0.17, 0.72, 0)
    this.part(legR, mats.limb, 0.18, 0.72, 0.2, 0, -0.36, 0)

    // 破布：两片薄板挂在背后（+Z），错开高度/宽度/倾角，读起来是"撕烂的披风"
    // 而不是一块板。不做布料模拟，它跟着躯干走就够了。
    const clothA = this.part(body, mats.cloth, 0.5, 0.46, 0.05, 0, 0.92, 0.22)
    clothA.rotation.x = 0.12
    const clothB = this.part(body, mats.cloth, 0.22, 0.34, 0.05, 0.19, 0.86, 0.24)
    clothB.rotation.set(0.2, 0.25, -0.12)

    return { head, armL, armR, legL, legR }
  }

  /**
   * gunner：grunt 的身体 + 一杆端在胸前的步枪 + 一顶宽檐帽。
   *
   * 复用 buildGrunt 而不是重画一个人：判定盒、站姿比例、"倒下去最低点"全都已经
   * 对上了，换一套骨架等于把踩过的坑再踩一遍。帽子是**唯一**能在三十米外把它和
   * 普通行尸分开的东西 —— 没有它，玩家会以为远处那只也会走过来咬人，于是被枪打。
   */
  private buildGunner(rig: Rig, mats: RigMaterials): GunnerNodes {
    const grunt = this.buildGrunt(rig, mats)
    const head = grunt.head

    // 宽檐帽挂在头枢轴下（跟着张望转）。檐 0.5m 比头宽一圈，剪影立刻不一样。
    this.part(head, mats.cloth, 0.52, 0.04, 0.52, 0, 0.34, 0)
    this.part(head, mats.cloth, 0.26, 0.2, 0.28, 0, 0.44, 0)

    // 枪挂在自己的枢轴上，不挂在手臂上：手臂角度一动枪就跟着歪，而它必须始终
    // 指向它真正在打的方向。枢轴放在右肩前方，枪身朝 -Z 延伸。
    const gun = this.hinge(rig.bob, 0.18, 1.14, -0.2)
    // 枪托（+Z，抵肩）、机匣、护木、枪管（-Z）。
    this.part(gun, mats.cloth, 0.09, 0.14, 0.34, 0, -0.03, 0.2)
    this.part(gun, mats.limb, 0.08, 0.1, 0.3, 0, 0, -0.06)
    this.part(gun, mats.cloth, 0.07, 0.07, 0.3, 0, -0.02, -0.34)
    this.part(gun, mats.limb, 0.035, 0.035, 0.56, 0, 0.01, -0.72)
    // 准星与照门：一根针一样的小竖块，开镜时才看得见，但它在剪影上正好让枪口"断"一下。
    this.part(gun, mats.limb, 0.02, 0.05, 0.02, 0, 0.05, -0.96, true)

    return { ...grunt, gun }
  }

  /**
   * 屠夫（boss）：grunt 的身体 + 兜帽 / 血围裙 + 胸口挂的一串肉钩 + 右手的长柄肉钩。
   *
   * 复用 buildGrunt 而不是重画一个人：判定盒、站姿比例、"倒下去最低点"全都已经
   * 对上了。3.3m 靠把 bob 整体放大 BOSS_SCALE 倍得到 —— 放大只在这里写一次
   * （记进 rig.baseScale），之后 sync 那条路径只改 scale.y 做低血压扁。
   */
  private buildBoss(rig: Rig, mats: RigMaterials): BossNodes {
    const grunt = this.buildGrunt(rig, mats)
    const head = grunt.head
    const body = rig.bob

    // bob 的原点在脚底，所以放大之后脚底仍然在 y=0：快照的 y 直接就是地面。
    rig.baseScale = BOSS_SCALE
    body.scale.setScalar(BOSS_SCALE)

    // 兜帽：压住头顶、包住后脑，正面（-Z）留出灯笼眼的位置 —— 屠夫靠这一圈布
    // 就能和普通行尸分开。
    this.part(head, mats.cloth, 0.44, 0.26, 0.44, 0, 0.3, 0.02)
    this.part(head, mats.cloth, 0.34, 0.42, 0.16, 0, 0.14, 0.22)

    // 血围裙：一片挂在胸前（-Z）的布，比躯干宽一圈，边缘微微前倾。
    const apron = this.part(body, mats.cloth, 0.56, 0.66, 0.06, 0, 0.84, -0.26)
    apron.rotation.x = -0.08

    // 腰上挂的一串肉钩：三块小铁片，钩尖朝下 —— 剪影就够了，不用真做成钩形。
    this.part(body, mats.limb, 0.06, 0.34, 0.06, -0.14, 0.98, -0.3)
    this.part(body, mats.limb, 0.06, 0.26, 0.06, 0.14, 1.02, -0.3)
    this.part(body, mats.limb, 0.22, 0.07, 0.06, -0.14, 0.8, -0.3)

    // 长柄肉钩挂在右手上：armR 是肩铰链，手臂网格往下 0.78，握把就在 -0.7 处。
    //
    // 整组除以 BOSS_SCALE：下面这些尺寸按**世界米**写（3.3m 的屠夫配 2.2m 的长柄），
    // 不抵消 bob 的放大会变成一根 3.9m 的杆子，比它自己还高。
    const hook = this.hinge(grunt.armR, 0, -0.7, 0)
    hook.scale.setScalar(1 / BOSS_SCALE)
    hook.rotation.x = BOSS_HOOK_REST
    // 柄：从握点往上长（握把在 y=0，杆顶在 2.08m）。
    // 杆用暗红布缠（比纯黑铁更容易在夜里读出轮廓），钩头用骨白皮色。
    this.part(hook, mats.cloth, 0.14, 2.2, 0.14, 0, 0.98, 0)
    this.part(hook, mats.limb, 0.2, 0.2, 0.2, 0, 0.04, 0)
    // 钩头：一根横杆 + 一根垂杆拼成的 L，竖杆从横杆末端往下坠。
    this.part(hook, mats.hide, 0.5, 0.14, 0.14, 0.19, 2.02, 0)
    this.part(hook, mats.hide, 0.3, 0.52, 0.14, 0.3, 1.7, 0)
    // 钩尖朝内收一点，剪影才像"钩"而不是"L"。
    this.part(hook, mats.hide, 0.2, 0.12, 0.14, 0.12, 1.46, 0)

    return {
      ...grunt,
      variant: KIND_BOSS,
      hook,
      bell: null,
      hammer: null,
      lantern: null,
      core: null,
    }
  }

  /**
   * 敲钟人：grunt 的骨架放大之后披上一件及地的黑法衣，胸前吊一口钟，
   * 右手一柄长锤。法衣盖住腿，剪影从"人形"变成"立着的钟形"。
   */
  private buildBellkeeper(rig: Rig, mats: RigMaterials): BossNodes {
    const grunt = this.buildGrunt(rig, mats)
    const body = rig.bob
    rig.baseScale = BELLKEEPER_SCALE
    body.scale.setScalar(BELLKEEPER_SCALE)

    // 法衣：三段向下张开的布，最后一段几乎拖地。腿被完全盖住。
    const robeTop = this.part(body, mats.cloth, 0.56, 0.7, 0.44, 0, 0.82, 0.02)
    robeTop.rotation.x = -0.06
    const robeMid = this.part(body, mats.cloth, 0.66, 0.5, 0.5, 0, 0.4, 0.03)
    robeMid.rotation.x = -0.04
    const robeLow = this.part(body, mats.cloth, 0.78, 0.26, 0.58, 0, 0.13, 0.04)
    // 前襟一道浅色滚边：远看能把钟形剪影和普通行尸分开。
    this.part(body, mats.limb, 0.07, 0.95, 0.03, 0, 0.68, -0.24)

    // 兜帽：压得很低，只露出两点冷黄的眼。
    this.part(grunt.head, mats.cloth, 0.46, 0.34, 0.44, 0, 0.26, 0.02)
    this.part(grunt.head, mats.cloth, 0.32, 0.42, 0.16, 0, 0.1, 0.24)

    // 钟：吊在胸前的木梁上。枢轴在梁中心，钟体绕它摆动。
    const yoke = this.hinge(body, 0, 1.62, -0.28)
    this.part(yoke, mats.limb, 0.78, 0.1, 0.12, 0, 0, 0)
    const bell = this.hinge(yoke, 0, -0.08, 0)
    // 钟体用浅石色：黑袍中间必须有一块亮的东西，玩家才知道"危险来自这口钟"。
    this.part(bell, mats.hide, 0.34, 0.14, 0.34, 0, -0.06, 0)
    this.part(bell, mats.hide, 0.44, 0.3, 0.44, 0, -0.26, 0)
    const rim = this.part(bell, mats.hide, 0.58, 0.14, 0.58, 0, -0.46, 0)
    rim.rotation.x = 0.02
    this.part(bell, mats.eye, 0.12, 0.12, 0.12, 0, -0.54, 0, true)

    // 长锤：柄挂在右手握点。尺寸按世界米写，所以除以骨架缩放。
    const hammer = this.hinge(grunt.armR, 0, -0.7, 0)
    hammer.scale.setScalar(1 / BELLKEEPER_SCALE)
    hammer.rotation.x = 0.15
    this.part(hammer, mats.cloth, 0.1, 2.1, 0.1, 0, 1.0, 0)
    this.part(hammer, mats.hide, 0.54, 0.32, 0.34, 0, 2.0, 0)
    this.part(hammer, mats.limb, 0.5, 0.1, 0.34, 0, 1.84, 0)

    return {
      ...grunt,
      variant: KIND_BELLKEEPER,
      hook: null,
      bell,
      hammer,
      lantern: null,
      core: null,
    }
  }

  /**
   * 石心巨像：仍用 grunt 的关节，但把躯干堆宽一倍、加肩岩/拳岩/腿甲，
   * 胸口嵌一块发光的矿核。它的剪影是四只里最宽的，转身慢得像一堵墙。
   */
  private buildGolem(rig: Rig, mats: RigMaterials): BossNodes {
    const grunt = this.buildGrunt(rig, mats)
    const body = rig.bob
    rig.baseScale = GOLEM_SCALE
    body.scale.setScalar(GOLEM_SCALE)

    // 胸甲 + 后背石板：把人形躯干撑成一块碑。
    this.part(body, mats.hide, 0.98, 0.78, 0.66, 0, 1.08, 0)
    this.part(body, mats.limb, 0.86, 0.34, 0.5, 0, 1.52, 0.12)
    // 肩岩：两块向外挑出的石块，宽出躯干半米。
    this.part(body, mats.hide, 0.5, 0.42, 0.6, -0.64, 1.44, 0.02)
    this.part(body, mats.hide, 0.5, 0.42, 0.6, 0.64, 1.44, 0.02)
    // 腰/胯石块。
    this.part(body, mats.limb, 0.8, 0.32, 0.56, 0, 0.7, 0)

    // 手臂：把原来的细臂包进石柱，拳头是一块方石。
    this.part(grunt.armL, mats.hide, 0.34, 0.62, 0.4, 0, -0.3, 0)
    this.part(grunt.armR, mats.hide, 0.34, 0.62, 0.4, 0, -0.3, 0)
    this.part(grunt.armL, mats.limb, 0.46, 0.4, 0.44, 0, -0.7, 0)
    this.part(grunt.armR, mats.limb, 0.46, 0.4, 0.44, 0, -0.7, 0)
    // 腿甲：加粗到能托住上面的重量。
    this.part(grunt.legL, mats.hide, 0.26, 0.62, 0.3, 0, -0.28, 0)
    this.part(grunt.legR, mats.hide, 0.26, 0.62, 0.3, 0, -0.28, 0)

    // 头缩在肩岩之间，只剩一道发光的眼缝。
    this.part(grunt.head, mats.limb, 0.3, 0.24, 0.3, 0, 0.2, 0)
    this.part(grunt.head, mats.eye, 0.18, 0.05, 0.03, 0, 0.24, -0.18, true)

    // 矿核：放在胸口正中，受击/蓄力时会亮。
    const core = this.part(body, mats.eye, 0.2, 0.2, 0.1, 0, 1.12, -0.36, true)
    this.part(body, mats.limb, 0.34, 0.34, 0.06, 0, 1.12, -0.32)

    return {
      ...grunt,
      variant: KIND_GOLEM,
      hook: null,
      bell: null,
      hammer: null,
      lantern: null,
      core,
    }
  }

  /**
   * 末班车长：高瘦的制服人影，帽檐压着眼睛，左手提灯，右手信号杖。
   * 衣摆向后裂成两片，跑起来会跟着甩 —— 这是它和屠夫最直观的区别。
   */
  private buildConductor(rig: Rig, mats: RigMaterials): BossNodes {
    const grunt = this.buildGrunt(rig, mats)
    const body = rig.bob
    rig.baseScale = CONDUCTOR_SCALE
    body.scale.setScalar(CONDUCTOR_SCALE)

    // 制服：收腰的长外套，肩线比 grunt 平。
    this.part(body, mats.cloth, 0.62, 0.86, 0.44, 0, 1.04, 0)
    this.part(body, mats.cloth, 0.56, 0.3, 0.42, 0, 0.6, 0)
    // 衣摆两片，挂在腰后（+Z）。
    const tailL = this.part(body, mats.cloth, 0.24, 0.9, 0.06, -0.16, 0.36, 0.24)
    tailL.rotation.x = 0.1
    const tailR = this.part(body, mats.cloth, 0.24, 0.9, 0.06, 0.16, 0.36, 0.24)
    tailR.rotation.x = 0.1
    // 铜扣：一排三个小亮点。
    this.part(body, mats.eye, 0.05, 0.05, 0.03, 0, 1.12, -0.23, true)
    this.part(body, mats.eye, 0.05, 0.05, 0.03, 0, 0.98, -0.23, true)
    this.part(body, mats.eye, 0.05, 0.05, 0.03, 0, 0.84, -0.23, true)

    // 列车员帽：帽檐一圈 + 直筒帽身。
    this.part(grunt.head, mats.cloth, 0.44, 0.1, 0.46, 0, 0.4, -0.02)
    this.part(grunt.head, mats.cloth, 0.34, 0.18, 0.34, 0, 0.52, 0)
    this.part(grunt.head, mats.eye, 0.08, 0.04, 0.02, 0, 0.44, -0.2, true)

    // 提灯：挂在左手的短杆上。灯芯用自发光的眼材质。
    const lantern = this.hinge(grunt.armL, -0.2, -0.74, 0)
    lantern.scale.setScalar(1 / CONDUCTOR_SCALE)
    lantern.rotation.z = 0.12
    this.part(lantern, mats.limb, 0.06, 0.34, 0.06, 0, -0.17, 0)
    this.part(lantern, mats.hide, 0.3, 0.06, 0.3, 0, -0.35, 0)
    this.part(lantern, mats.eye, 0.2, 0.28, 0.2, 0, -0.52, 0, true)
    this.part(lantern, mats.hide, 0.28, 0.06, 0.28, 0, -0.7, 0)

    // 信号杖：右手，一杆带小旗的铜杖。
    const hammer = this.hinge(grunt.armR, 0.2, -0.7, 0)
    hammer.scale.setScalar(1 / CONDUCTOR_SCALE)
    hammer.rotation.x = 0.2
    hammer.rotation.z = -0.1
    this.part(hammer, mats.hide, 0.08, 1.9, 0.08, 0, 0.6, 0)
    this.part(hammer, mats.cloth, 0.42, 0.34, 0.03, 0.22, 1.24, 0)
    this.part(hammer, mats.eye, 0.12, 0.12, 0.12, 0, 1.56, 0, true)

    return {
      ...grunt,
      variant: KIND_CONDUCTOR,
      hook: null,
      bell: null,
      hammer,
      lantern,
      core: null,
    }
  }

  private buildHound(rig: Rig, mats: RigMaterials): HoundNodes {
    const body = rig.bob

    // 身体：压得很低、拉得很长（0.92m）。四足猎犬的剪影全靠这个长条。
    const torso = this.part(body, mats.hide, 0.36, 0.34, 0.92, 0, 0.62, 0)
    torso.rotation.x = -0.04

    // 头在前（-Z），带一节下巴。枢轴 0.73 + 半高 0.15 + 中心 0.12 = 头顶正好 1.0m，
    // 这就是 spec 里 hound 的身高（也是判定盒的高度），差几厘米玩家就会打空。
    const head = this.hinge(body, 0, 0.73, -0.5)
    this.part(head, mats.hide, 0.3, 0.3, 0.42, 0, 0.12, -0.14)
    this.part(head, mats.eye, 0.05, 0.05, 0.03, -0.085, 0.17, -0.36, true)
    this.part(head, mats.eye, 0.05, 0.05, 0.03, 0.085, 0.17, -0.36, true)
    const jaw = this.hinge(head, 0, 0.02, -0.02)
    this.part(jaw, mats.limb, 0.24, 0.1, 0.34, 0, -0.02, -0.16)

    // 四条腿：前腿在 -0.3、后腿在 +0.3，胯高 0.5 → 腿长 0.5 正好踩到地面。
    const legs: Group[] = []
    const legXs = [-0.16, 0.16, -0.16, 0.16]
    const legZs = [-0.3, -0.3, 0.3, 0.3]
    for (let i = 0; i < 4; i++) {
      const leg = this.hinge(body, legXs[i], 0.5, legZs[i])
      this.part(leg, mats.limb, 0.11, 0.5, 0.13, 0, -0.25, 0)
      legs.push(leg)
    }

    return { head, jaw, legs }
  }

  /** 建一个铰链：Group 定位在关节处，网格挂在它下面，绕它转就是绕关节转。 */
  private hinge(parent: Group, x: number, y: number, z: number): Group {
    const g = new Group()
    g.position.set(x, y, z)
    parent.add(g)
    return g
  }

  /** 建一个盒子零件，一律挂墨线外壳；thinInk 给眼球那种小零件用。只在建模时调用。 */
  private part(
    parent: Group,
    material: MeshToonMaterial | MeshBasicMaterial,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    thinInk = false,
  ): Mesh {
    const mesh = new Mesh(this.box(w, h, d), material)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    this.addInk(mesh, thinInk)
    return mesh
  }

  /**
   * 墨线外壳作为**子节点**：父网格的位移/旋转/缩放自动继承，所以摆臂时描边
   * 跟着手臂走，不会出现"手臂甩出去了、墨线还挂在原地"。
   */
  private addInk(mesh: Mesh, thin: boolean): void {
    const ink = thin ? this.activeInkThin : this.activeInk
    if (ink === null) return
    const hull = new Mesh(mesh.geometry, ink)
    // 外壳不参与射线：它纯粹是画面上的一圈墨，不该挡子弹也不该被拾取。
    hull.raycast = () => {}
    mesh.add(hull)
  }

  /** 同尺寸盒子共用一份几何体，避免几十套骨架各建一份一模一样的 BoxGeometry。 */
  private box(w: number, h: number, d: number): BoxGeometry {
    const key = w.toFixed(3) + 'x' + h.toFixed(3) + 'x' + d.toFixed(3)
    const cached = this.boxCache.get(key)
    if (cached !== undefined) return cached
    const geo = new BoxGeometry(w, h, d)
    this.boxCache.set(key, geo)
    this.disposables.push(geo)
    return geo
  }

  private buildBar(style: KindStyle): HealthBar {
    const group = new Group()
    const back = new Mesh(this.barGeometry, this.barBackMaterial)
    back.scale.set(BAR_WIDTH, BAR_HEIGHT, 1)
    group.add(back)
    const fill = new Mesh(this.barGeometry, this.barFillMaterial)
    fill.scale.set(BAR_WIDTH, BAR_HEIGHT * 0.6, 1)
    // 抬 2mm 避开 z-fighting；billboard 之后这个 z 直接朝相机。
    fill.position.z = 0.002
    group.add(fill)
    group.position.y = style.height + BAR_LIFT
    group.visible = false
    this.root.add(group)
    return { group, back, fill }
  }

  // ---------------------------------------------------------------- 资源

  private makeRigMaterials(style: KindStyle): RigMaterials {
    const hide = this.toon(style.hide)
    const limb = this.toon(style.limb)
    const cloth = this.toon(style.cloth)
    const eye = new MeshBasicMaterial({ color: style.eye })
    const ink = this.makeInkMaterial(INK_WIDTH)
    const inkThin = this.makeInkMaterial(INK_WIDTH * 0.5)
    this.disposables.push(eye, ink, inkThin)
    return { hide, limb, cloth, eye, ink, inkThin }
  }

  private toon(color: number): MeshToonMaterial {
    const mat = new MeshToonMaterial({ color, gradientMap: this.gradientMap })
    // 排线强度 0.45：怪物是中距离目标，拉满会和 4 级色阶互相吃掉，变成一团条纹。
    // 线距比关卡密一档（30px vs 36px）：怪物只有 1~2m 高，用关卡那一档一根都落不到身上。
    applyComicInk(mat, {
      hatchSpacing: 15,
      hatchStrength: 0.45,
      hatchThreshold: 0.44,
      grime: 0.06,
      // 逆光时给怪物一圈冷边：HDR + 泛光之后，暗处的剪影容易和背景糊成
      // 一块，这圈边缘光是"那里有东西在动"的最便宜的提示。
      rim: 0.12,
      specular: 0.04,
    })
    this.disposables.push(mat)
    return mat
  }

  /**
   * 墨线材质：背面外壳 + 沿法线外扩，外扩量乘 pos.w。
   *
   * pos.w 是关键：NDC 是除以 w 之后的结果，乘回 w 就抵消了透视除法，线宽变成
   * **屏幕**尺度。不乘 w 的话 20m 外的怪描边细到看不见、贴脸时又粗到吞掉半个屏幕。
   * uRes 把「屏幕」细化成「CSS 像素」—— 没有它 16:9 下横向线会比纵向粗一倍。
   * uBoil / uRes 是 outline.ts 的模块级单例（按引用塞进来），所以屏幕 resize 与
   * 线条沸腾不需要这个模块参与。
   * 多出来的 uOpacity 专门给尸体淡出用。
   */
  private makeInkMaterial(width: number): ShaderMaterial {
    return new ShaderMaterial({
      side: BackSide,
      uniforms: {
        uWidth: { value: width },
        uBoil: OUTLINE_SHARED.boil,
        uRes: OUTLINE_SHARED.resolution,
        uColor: { value: new Color(INK_COLOR) },
        uOpacity: { value: 1 },
      },
      vertexShader: [
        'uniform float uWidth;',
        'uniform float uBoil;',
        'uniform vec2 uRes;',
        'void main() {',
        '  vec3 nrm = normalize(normalMatrix * normal);',
        '  vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '  pos.xy += nrm.xy * uWidth * uBoil * uRes * pos.w;',
        '  gl_Position = pos;',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uOpacity;',
        'void main() {',
        '  gl_FragColor = vec4(uColor, uOpacity);',
        '}',
      ].join('\n'),
    })
  }

  dispose(): void {
    this.scene.remove(this.root)
    for (let i = 0; i < this.disposables.length; i++) this.disposables[i].dispose()
    this.disposables.length = 0
    this.boxCache.clear()
    this.byId.clear()
    this.rigs.length = 0
  }
}

/** 目标角度减当前角度，按最短弧归一到 [-PI, PI]。 */
function shortestDelta(current: number, target: number): number {
  let d = (target - current) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

export function createMonsterRenderer(scene: Scene, options: MonsterRendererOptions): MonsterRenderer {
  return new MonsterLayer(scene, options)
}
