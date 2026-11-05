/**
 * 第一人称武器模型 + 全部程序化姿态动画。
 *
 * ## 为什么单独一个文件
 *
 * render.ts 已经 900 行，承担了场景、光照、墨线沸腾、曳光弹、角色、VFX 总线……
 * 而武器动画本质上**与场景渲染无关**：它只回答一个问题 —— "给定玩家的状态
 * （开镜混合 / 后坐力 / 速度 / 是否疾跑 / 是否离地 / 换弹进度 / 俯仰 / 举枪进度 /
 * 挥砍进度），这一帧枪该摆在哪、转多少"。输入是一组标量，输出是一个 Group 的
 * position / rotation。把它从场景代码里拆出来，动画可以单独调参、单独测（不需要
 * WebGL 上下文），也免得改一个换弹角度要在一千行的渲染器里翻找。
 *
 * ## 为什么四类武器全部在构造时就建好
 *
 * 切枪是玩家一秒钟里能做两次的操作。如果 setWeapon 时才 new BoxGeometry，
 * 那一次切枪会掉一帧 —— 而且掉在"正被人打"的那一帧上。几何总量很小（四类武器
 * 合计一百来个盒子），换来的是**切换零分配、零卡顿**。代价是内存里常驻几把
 * 看不到的枪，所以缓存组**不挂在 root 上**（见 setWeapon）：three 每帧要遍历
 * 整棵可见树做矩阵更新，把没在手上的枪挂在场景里等于白付遍历成本。
 *
 * ## 为什么换弹是"压枪"而不是拆弹匣
 *
 * 这把枪是 1890 年的杠杆步枪（温菲尔德），它**没有可拆卸弹匣** —— 换弹是拉开
 * 杠杆、一发一发往机匣里的管状弹仓塞。所以动画不能做成"弹匣掉下去、新弹匣插
 * 上来"：那在形制上是错的，而且管状弹仓的装填动作本来就发生在机匣附近、需要
 * 玩家把枪口压低、把机匣转过来对着自己。于是这一段动画做成：枪身向右下方压
 * （俯仰 -20°、偏航外摆、滚转让枪身歪向画面右侧），整把枪往画面右下退出一点，
 * 中段用手抖的高频小抖动表示"一发一发塞子弹"，最后抬回来并带一点过冲 ——
 * 过冲是在补偿手感：纯缓出收招会像一条滑轨，人手的收招总会甩过一点再回来。
 *
 * 这一段是**所有枪共用**的：换弹动作的形制来自"手上没有可拆弹匣"这个共性，
 * 差异留给各枪自己的 hip/ads 基准位。
 *
 * 所有几何数值最初来自 render.ts 的 buildViewmodel()（已在本次改造中整体迁入），
 * 颜色/描边宽度也照抄，所以画面上仍是当初那把枪，只是它开始动了、并且有了兄弟。
 */

import { AdditiveBlending, BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, PlaneGeometry } from 'three'
import type { BufferGeometry, Material, Object3D } from 'three'
import { wrapAngle } from '@dk/shared'

/** render.ts 提供，用来复用共享的卡通材质与墨线壳，本模块不自己造材质。 */
export interface ViewmodelKit {
  /** 造一个卡通材质（内部已经 applyComicInk）。 */
  toon(color: number, options?: { hatch?: number; hatchSpacing?: number }): Material
  /** 给 mesh 加墨线壳（BackSide），像素宽度由 render.ts 决定。 */
  addInk(mesh: Mesh, pixels?: number): void
}

/** 每帧喂进来的、与武器动画有关的全部状态。 */
export interface ViewmodelState {
  /** 开镜混合 0..1（0 腰射，1 完全贴腮）。 */
  ads: number
  /** 后坐力 0..1（开枪时置高，之后衰减）。 */
  recoil: number
  /** 水平移动速度（m/s），用来决定呼吸摆动幅度与疾跑倾斜。 */
  speed: number
  /** 是否在疾跑。 */
  sprinting: boolean
  /** 是否离地（跳跃/下落）。 */
  airborne: boolean
  /** 换弹进度 0..1；reloading === false 时忽略。 */
  reloadProgress: number
  reloading: boolean
  /** 累计时间（秒），动画的相位来源。 */
  time: number
  /** 抬头/低头幅度 -1..1（用于摆动与枪口下垂）。 */
  pitch: number
  /**
   * 当前相机 yaw（弧度）。给了才能算"转视角时枪追不上"的滞后层；
   * 旧调用方不传时滞后保持 0，行为与原来完全一致。
   */
  yaw?: number
  /** 镜头运动强度 0..1（可访问性设置）；缺省 1，旧调用方行为不变。 */
  motionScale?: number
  /**
   * 当前武器 id。**给了就等于调用 setWeapon**（给了不同的 id 时），
   * 没给就维持 setWeapon 定下的那一个 —— 这样旧调用方一行不改也能跑。
   */
  weaponId?: number
  /** 槽位 0 主 / 1 副 / 2 刀。只影响切枪动作的幅度（见 SWITCH_SLOT_*）。缺省取武器自己的槽位。 */
  slot?: number
  /** 举枪进度 0..1（0 = 旧的刚甩出去、新的还没举起来，1 = 新枪已就位）。缺省视为 1。 */
  switchProgress?: number
  /** 一次挥砍的进度 0..1（抬起 → 劈下 → 收回）。刀以外忽略。缺省 0。 */
  meleeProgress?: number
  /**
   * 是否正在透过镜筒看（带 2 倍以上倍镜且已开镜）。为 true 且举枪到位后，
   * 整个武器根节点会被摘掉 —— 镜筒遮罩已经画出视野，让枪身留在画面正中
   * 等于用一块铁挡住分划。缺省 false，旧调用方行为不变。
   */
  scoped?: boolean
  /**
   * 相机 FOV 的收缩倍数（带镜开镜时 > 1）。枪位整体乘它，屏幕上的枪大小与
   * 位置就保持不变 —— 镜筒放大的是世界，不该连手里那支枪一起放大成一堵墙。
   * 缺省 1。
   */
  viewScale?: number
}

export interface Viewmodel {
  /** 武器的根节点，调用方 `camera.add(viewmodel.root)`。 */
  readonly root: Group
  /**
   * 切换当前显示的武器根组（幂等）。四类模型在构造时就建好并缓存，
   * 这里只做"挂上/摘下"，不 new 任何几何。未知 id 回落到步枪。
   */
  setWeapon(weaponId: number): void
  /** 每帧调用。dt 秒。 */
  update(state: ViewmodelState, dt: number): void
  /**
   * 上一帧算出来的**相机滚转**（弧度），挥砍时不为 0（最大约 2°）。
   * 调用方每帧把它写进 `camera.rotation.z` 就得到"视野跟着刀一起甩"的那一下；
   * 不接也不影响正确性 —— 武器根节点自己也吃了一份（见 MELEE_ROOT_ROLL）。
   */
  readonly cameraRoll: number
  /** 释放它自己 new 出来的几何体与材质（由 ViewmodelKit 提供的材质不归它管）。 */
  dispose(): void
}

/** 举枪到多少才允许收起枪身进镜筒（见 ViewmodelState.scoped）。 */
const SCOPE_STOW_ADS = 0.72

// ---------------------------------------------------------------- 静态姿态

/**
 * 手持武器描边宽度（CSS 像素）。
 *
 * 原来跟关卡用同一档的 4.0，结果开镜时枪身只占屏幕 40×30px，四条 4px 的墨线
 * 把小零件全糊成一团糊的黑边，机匣读成"电视机"。2.6 让每个零件还留得住自己的
 * 面，轮廓线又不至于吃掉一半面积。
 */
const INK_PIXELS = 2.6

/**
 * 步枪（1 / 6）的腰射静态姿态。三项都是"为了看清"而不是"为了真实"：偏航 17°
 * 才露出侧面，俯仰抬起 3° 让枪托退出画面下缘，滚转 4° 破掉正交感。
 */
const RIFLE_YAW = 0.2
const RIFLE_PITCH = 0.05
const RIFLE_ROLL = 0.16

/** 腰射时枪根节点在相机局部空间里的位置（画面右下角）。 */
const RIFLE_HIP_X = 0.2
const RIFLE_HIP_Y = -0.2
const RIFLE_HIP_Z = -0.76

/**
 * 枪整体缩放。几何尺寸都是真枪量级。
 *
 * 0.8 时枪身横跨屏幕近 40% 宽度，读起来像一块贴在镜头前的木板 —— 一把 1.1m 的
 * 步枪在真实 FPS 里只占画面右下角一小块。0.68 让机匣与护木都还在，但枪退出画面
 * 中线，视野交还给场景。开镜不受影响：ADS_Y 由 solveAdsY 带着 scale 反解。
 */
const GUN_SCALE = 0.68

/**
 * 步枪开镜位。
 *
 * 这里有个坑：准星（z = -0.9）与照门（z = -0.06）的局部高度**都是 0.026**，
 * 也就是说在枪的局部空间里它们连成一条**平行于枪管**的直线。想让这条线在屏幕
 * 上落成一条（而不是一高一低），相机的原点必须**正好落在这条直线上** —— 只把
 * 根节点上下平移是做不出来的：近处的照门和远处的准星会按各自的深度投影，
 * 相差 1.8 倍，屏幕上就是"前准星浮在照门上方"的错位。
 *
 * 所以开镜姿态给一个很小的俯仰 ADS_PITCH（0.7°），再把角色位置 ADS_Y 反解出来：
 * 令 P_rear（照门在相机空间的位置）与视轴方向 (0, sinθ, -cosθ) 平行。这样
 * 相机原点、照门、准星三点共线，两者投影到**同一个屏幕点**，且这个点在画面
 * 正中偏上 0.7°（1080p 下约 12px）—— 枪身不挡目标，玩家也能一眼确认"我在瞄"。
 */
const RIFLE_ADS_Z = -0.5
const RIFLE_ADS_PITCH = 0.006
/** 照门/准星在枪局部空间的共同高度与 z（供下面那条反解式用，与 buildRifle 的零件坐标一致）。 */
const SIGHT_Y = 0.026
const SIGHT_REAR_Z = -0.06

/**
 * 由"照门—准星共线"反解开镜时的枪根 y（米）。
 *
 * 设根节点在相机空间为 (0, y, adsZ)、俯仰 adsPitch，缩放 scale，照门局部坐标
 * (0, sightY, sightRearZ)。要求照门落在视轴 (0, sinθ, -cosθ) 上，即
 *   P.y = -tanθ · P.z
 * 展开 P = root + R_x(θ)·(scale · sight) 后解出：
 *
 *   y = -tanθ·(adsZ + S·(sightY·sinθ + sightRearZ·cosθ)) - S·(sightY·cosθ - sightRearZ·sinθ)
 *
 * **每把有机械瞄具的枪都必须走这个式子**，不许手写 adsY：手写出来的值只要差
 * 1mm，开镜时准星就会浮在照门上，玩家第一反应是"这游戏打不准"。
 */
function solveAdsY(pitch: number, adsZ: number, sightHeight: number, sightRearZ: number, scale: number): number {
  const s = Math.sin(pitch)
  const c = Math.cos(pitch)
  return -Math.tan(pitch) * (adsZ + (sightHeight * s + sightRearZ * c) * scale) - (sightHeight * c - sightRearZ * s) * scale
}

/**
 * 开镜时枪托下摆量（米）。0.3 让托底在 0.7m 处的屏幕坐标落到画面下缘之外，
 * 只剩机匣+准星组成的"瞄准图"；0.12 的后移是让它顺带缩一点，摆出去时不像平移。
 */
const STOCK_TUCK_Y = 0.3
const STOCK_TUCK_Z = 0.12

// ---------------------------------------------------------------- 换弹

/** 三段式换弹的相位分界：压下去 / 保持 / 抬回来。 */
const RELOAD_DOWN_END = 0.15
const RELOAD_HOLD_END = 0.75
/** 抬回段结束在这里，剩下 3% 用来越过静止位（过冲会停在这个值上）。 */
const RELOAD_OVERSHOOT_END = 0.97

/**
 * 过冲量。-0.12 表示压枪量的 12% 反向：抬回时越过静止位约 12%，
 * 换算到俯仰是 0.3991 × 0.12 ≈ 0.048rad ≈ 2.7°，视觉上"甩一下再落定"。
 */
const RELOAD_OVERSHOOT = -0.12

/**
 * 完全压枪时枪管的绝对俯角：20°。
 *
 * 多给的 0.0148rad（0.85°）是**欧拉顺序的补偿**。three 的 Object3D.rotation 默认
 * 是 'YXZ'，roll 先作用、yaw 后作用、pitch 最后 —— 在 yaw = -24°、roll = 31° 同时
 * 存在时，"绕局部 x 转 20°"经 yaw/roll 串起来后，枪管在世界里只下沉了 19.15°。
 * 只写 Math.PI/9 的话实测是 19.15°，补这一笔才真的是"枪口朝下 20°"。
 */
const RELOAD_PITCH_DOWN = Math.PI / 9 + 0.0148
/** 压枪时的偏航（枪口往右甩 24°）与滚转（枪身歪向画面右下）。 */
const RELOAD_YAW = -0.42
const RELOAD_ROLL = 0.55
/** 压枪时的整体位移：向右下退出画面，并略微拉近。 */
const RELOAD_X = 0.06
const RELOAD_Y = -0.1
const RELOAD_Z = 0.04
/** 中段塞子弹的手抖：位移与滚转的高频抖动幅度。 */
const RELOAD_JITTER_X = 0.0035
const RELOAD_JITTER_Y = 0.0025
const RELOAD_JITTER_ROLL = 0.009

// ---------------------------------------------------------------- 疾跑

/** 疾跑摆动频率（Hz）。人跑动时上半身的固有节律大约就在 1.1Hz 附近。 */
const SPRINT_HZ = 1.1
/** 疾跑姿态：枪口朝左下、枪身更贴画面右下边缘（"拎着枪在跑"）。 */
const SPRINT_X = 0.075
const SPRINT_Y = -0.085
const SPRINT_Z = 0.06
const SPRINT_YAW = 0.34
const SPRINT_PITCH = -0.3
const SPRINT_ROLL = -0.18
/** 疾跑摆动幅度（椭圆：横摆 3.5cm，竖摆 2.6cm，滚转 3.4°）。 */
const SPRINT_SWAY_X = 0.035
const SPRINT_SWAY_Y = 0.026
const SPRINT_SWAY_ROLL = 0.06

// ---------------------------------------------------------------- 落地

/** 落地下沉幅度（米，向下）与指数衰减时间常数（秒）。 */
const LAND_DIP = 0.06
const LAND_DECAY = 0.18

/** 呼吸摆动的基础幅度（与旧 render.ts 一致，保证腰射手感不变）。 */
const SWAY_X = 0.004
const SWAY_Y = 0.003
/** 走动起伏：频率与幅度都和旧 updateCamera 的对枪位补偿一致。 */
const BOB_FREQ = 10.5
const BOB_AMP = 0.018

// ---------------------------------------------------------------- 切枪

/**
 * 切枪的"甩出去"段占多大比例（按 switchProgress 计）。
 *
 * 前 50% 旧武器往下甩、后 50% 新武器升到就位 —— 两者**不同时出现在画面里**
 * （重叠会让人以为是双持）。50/50 而不是 30/70：手上那件东西从"在手里"到
 * "出了画面"需要的位移最短，而新枪从画面外升到贴腮位要走完整个行程，五五开
 * 正好让两段看起来一样长。
 */
const SWITCH_EXIT_END = 0.5

/**
 * 举枪段的三段拼法。**六个自由度用六个不同的指数**，这是关键：
 * 如果 x/y/俯仰 用同一个缓动，插出来的轨迹就是一条直线位移（"电梯"）。
 * 人抬手是把枪绕肩关节**转**上来的 —— 越靠近起始姿态，角速度在屏幕上贡献的
 * 位移越小。给 y 二次、x 一点三五次、俯仰一点六次、滚转一点九次，合出来的
 * 轨迹是一段向外的弧：先贴着画面右下角冒头，再斜插回中线。
 */
const SWITCH_DIP = 0.36 // 米，向下压出画面（0.36m 在 0.7m 处的张角远超过半屏）
const SWITCH_SIDE = 0.17 // 米，向右外摆（顺手把枪从画面右缘带进来）
const SWITCH_PULL = 0.12 // 米，向相机拉近（举起的过程中枪离眼睛最近）
const SWITCH_PITCH = 0.86 // rad ≈ 49°，枪口朝下
const SWITCH_YAW = 0.62 // rad ≈ 36°，枪身先侧过来再转正
const SWITCH_ROLL = 0.72 // rad ≈ 41°

/**
 * 槽位对切枪幅度打折。
 *
 * 副武器 0.8：它是"步枪打空了才掏出来"的东西，掏出来必须比换步枪快、
 * 贴得更低更右（那部分由转轮手枪自己的 hip 基准位给），甩幅小一点读起来才
 * 不像"又换了一把长枪"。刀 0.72：刀比枪短、比枪轻，同样的手感参数套上去
 * 会显得甩得过头，像在挥一根钢管。
 */
const SWITCH_SLOT_SECONDARY = 0.8
const SWITCH_SLOT_MELEE = 0.72

/** 旧武器甩出去的方向（局部空间）：往右下、往镜头方向、枪口朝下。 */
const SWITCH_EXIT_X = 0.1
const SWITCH_EXIT_DROP = 0.5
const SWITCH_EXIT_Z = 0.1
const SWITCH_EXIT_PITCH = 1.1
const SWITCH_EXIT_YAW = -0.5
const SWITCH_EXIT_ROLL = 0.6

// ---------------------------------------------------------------- 挥砍

/**
 * 一次斜劈的三段分界：抬起（0~0.34）/ 劈下（0.34~0.62）/ 收回（0.62~1）。
 *
 * 0.34 的抬手段偏长是有意的：挥砍的"力"全在蓄力那一下的**停顿**里，
 * 抬手和劈下一样长会读成一个匀速的钟摆。劈下段最短（0.28）—— 它必须是
 * 全程最快的一段，玩家在按下的瞬间就该看到刀已经到低了。
 */
const MELEE_WIND_END = 0.34
const MELEE_SLASH_END = 0.62

/** 蓄力位：刀举到左上，刃口向上翻（rx 正 = 刀尖抬起来）。 */
const MELEE_WIND_RX = 0.62
const MELEE_WIND_RY = -0.42
const MELEE_WIND_RZ = 0.36
const MELEE_WIND_PX = 0.018
const MELEE_WIND_PY = 0.052
const MELEE_WIND_PZ = 0.028

/** 劈到位：刀甩到右下，同时往前送出去一点（pz 为负 = 递向敌人）。 */
const MELEE_SLASH_RX = -1.02
const MELEE_SLASH_RY = 0.64
const MELEE_SLASH_RZ = -0.54
const MELEE_SLASH_PX = -0.072
const MELEE_SLASH_PY = -0.098
const MELEE_SLASH_PZ = -0.086

/** 收招过冲：回程在俯仰上多抬 0.1rad，像"甩回来再落定"。 */
const MELEE_RECOVER_RX = 0.1

/**
 * 刀光面片的最大不透明度与它的"速度包络"。0.62 是加色混合下的上限：
 * 再亮就不是刀留下的残影，而是有人在屏幕右下角开了个手电筒。
 */
const GLOW_PEAK = 0.62

/**
 * 挥砍时相机滚转的最大值（弧度）= 2.0°。
 *
 * 上限压在 2° 是有原因的：滚转会真实地转地平线，超过 2° 就开始让人晕，
 * 而且开镜压枪时的"水平"参考也跟着歪了。斜劈从左上到右下，所以取负值
 * （画面顺时针歪），与刀的运动方向一致。
 */
const MELEE_CAM_ROLL = 0.035
/** 武器自己再吃一份滚转（1.3°）：调用方没接 cameraRoll 时也能看出"有力"。 */
const MELEE_ROOT_ROLL = -0.022

/** 把 t 夹到 0..1 再做 smoothstep（缓入缓出）。 */
function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** 一维 value noise（-1..1）：用来替代 sin，待机摆动不会听出循环。 */
function hashNoise(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}

function noise1(x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hashNoise(i) + (hashNoise(i + 1) - hashNoise(i)) * u
}

/**
 * 一把武器的缓存：几何根组 + 它的静态姿态基准 + 刀专用件。
 *
 * 全部是**只读标量**，update 里只读不建 —— 切换武器不改这里的任何东西，
 * 所以不存在"切两次枪，基准位漂了"这种 bug。
 */
interface WeaponRig {
  readonly group: Group
  /** 枪托子组（刀、转轮手枪没有需要下摆的托，为 null）。 */
  readonly stock: Group | null
  readonly hipX: number
  readonly hipY: number
  readonly hipZ: number
  readonly yaw: number
  readonly pitch: number
  readonly roll: number
  /** 开镜基准位；adsY 一律由 solveAdsY 反解（刀没有开镜线，是例外，见 KNIFE_HIP）。 */
  readonly adsX: number
  readonly adsY: number
  readonly adsZ: number
  readonly adsPitch: number
  /** 开镜时枪托的下摆量。 */
  readonly tuckY: number
  readonly tuckZ: number
  readonly scale: number
  /** 0 主 / 1 副 / 2 刀（state.slot 没给时的缺省值）。 */
  readonly slot: number
  readonly isMelee: boolean
  /** 刀专用：刀光面片与自己的材质（不是刀为 null）。 */
  readonly glow: Mesh | null
  readonly glowMat: Material | null
  /** 换弹/后坐驱动的局部零件；没有就不动。 */
  readonly parts?: {
    hammer?: Mesh
    hammers?: Mesh[]
    cylinder?: Group
  }
}

export function createViewmodel(kit: ViewmodelKit): Viewmodel {
  const root = new Group()
  root.position.set(RIFLE_HIP_X, RIFLE_HIP_Y, RIFLE_HIP_Z)
  root.scale.setScalar(GUN_SCALE)
  root.rotation.set(RIFLE_PITCH, RIFLE_YAW, RIFLE_ROLL)

  // 相机滞后：转视角时枪追不上，停手后靠欠阻尼弹簧回弹一次。
  // 状态是每把枪实例一份，切枪不清零（枪本来就在手上）；只在第一次收到
  // state.yaw 时把 last 对齐，避免开局从 0 到实际朝向甩一下。
  let lookInitialized = false
  let lastYaw = 0
  let lastPitch = 0
  let lagYaw = 0
  let lagPitch = 0
  let lagVYaw = 0
  let lagVPitch = 0

  /**
   * 本模块自己 new 出来的几何体。材质全部由 kit 提供（render.ts 统一登记、
   * 统一释放），所以这里只记几何体 —— 释放别人的材质会让整个场景的卡通材质
   * 失效。唯一例外是刀光材质（从 kit 借一份再 clone，见 buildKnife）。
   */
  const disposables: BufferGeometry[] = []
  /** 我们自己 clone 出来的材质（刀光），dispose 时也要放。 */
  const ownedMaterials: Material[] = []

  // fog: false 是必须的：枪离相机 0.5m，但指数雾按世界坐标距离算，靠近沼泽
  // 中心时整把枪会被雾压成一片灰。发蓝钢 + 胡桃木 + 黄铜三色。
  const steel = kit.toon(0x4f5a6b, { hatch: 0.2 })
  const wood = kit.toon(0x53331c, { hatch: 0.2 })
  const brass = kit.toon(0x8f6f2c, { hatch: 0.2 })
  // 准星/照门单独一档亮灰：和枪身同色时，开镜看到的只是一个带刻痕的蓝块，
  // 缺口和前准星都糊在里面 —— 瞄准图必须比枪身亮两档才认得出。
  const sight = kit.toon(0x8d99a8, { hatch: 0 })
  // 转轮弹巢凹槽用的一档近黑：它要读成"洞"，而洞不吃光。
  const bore = kit.toon(0x1a1f26, { hatch: 0 })
  // 刀身比枪身亮一档（打磨过的碳钢 vs 发蓝钢），亮边再亮两档 —— 挥砍时刀面
  // 翻过来能吃到一次高光，那一下反光就是"这是把刀"的全部说服力。
  const bladeSteel = kit.toon(0x707c8c, { hatch: 0.15 })
  const bladeEdge = kit.toon(0xe9f2fb, { hatch: 0 })
  // 手套/袖口：比枪木更暖一档，靠近镜头时不会和胡桃木/阴影糊成一块。
  const glove = kit.toon(0x7a5b47, { hatch: 0.08 })
  const gloveDark = kit.toon(0x5a4434, { hatch: 0.12 })
  const sleeve = kit.toon(0x3d3933, { hatch: 0.16 })
  // 只有手掌/指节压在枪身之上；袖子和前臂仍吃深度，避免整条胳膊糊在枪上。
  glove.depthTest = false
  gloveDark.depthTest = false

  /** 造一个盒子零件并挂到父节点上。ink 为 false 的零件（薄板、准星、刀光）不描边。 */
  const box = (
    w: number,
    h: number,
    d: number,
    mat: Material,
    x: number,
    y: number,
    z: number,
    ink: boolean,
    parent: Object3D,
  ): Mesh => {
    const geo = new BoxGeometry(w, h, d)
    disposables.push(geo)
    const mesh = new Mesh(geo, mat)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    if (ink) kit.addInk(mesh, INK_PIXELS)
    return mesh
  }

  /** 造一个圆柱零件（轴烘焙成沿 z，和枪管同向，免得每个零件再手动转一次）。 */
  const cyl = (r: number, h: number, seg: number, mat: Material, x: number, y: number, z: number, parent: Object3D): Mesh => {
    const geo = new CylinderGeometry(r, r, h, seg)
    geo.rotateX(Math.PI / 2)
    disposables.push(geo)
    const mesh = new Mesh(geo, mat)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  /**
   * 一只握枪的手：手套掌 + 四根指节 + 拇指 + 袖口 + 一段前臂。
   *
   * 不做二骨 IK、不做接触 AO（调研结论：先消除"悬空木板"就够）。手直接
   * 焊在握把/护木上，整把枪运动时手跟着走；换弹/开镜时不会出现"手留在原地"。
   * mirror = 1 右手（拇指在 +x），-1 左手。
   */
  const addArm = (
    parent: Object3D,
    x: number,
    y: number,
    z: number,
    mirror: 1 | -1,
  ): Group => {
    const hand = new Group()
    hand.position.set(x, y, z)
    // 一块完整的手掌 + 一条指节，不再用四根独立手指：在 0.5m 的透视里
    // 四根 11mm 的盒子只会变成一撮黑色描边，读不出"手"。
    const palm = box(0.07, 0.06, 0.095, glove, 0, 0, 0, true, hand)
    palm.rotation.x = 0.12
    palm.renderOrder = 9999
    const knuckle = box(0.064, 0.018, 0.078, gloveDark, 0, 0.032, -0.014, false, hand)
    knuckle.renderOrder = 9999
    // 拇指从内侧压住枪身，是"在握"而不是"贴着一块木头"的关键。
    const thumb = box(0.02, 0.03, 0.055, gloveDark, -mirror * 0.036, 0.01, -0.004, false, hand)
    thumb.rotation.z = -mirror * 0.5
    thumb.renderOrder = 9999
    // 袖口与前臂用圆柱：少一层描边黑边，近看才像胳膊而不是另一把枪。
    cyl(0.044, 0.045, 8, sleeve, 0, -0.004, 0.058, hand)
    const fore = cyl(0.032, 0.15, 8, sleeve, mirror * 0.012, -0.055, 0.13, hand)
    fore.rotation.x = -0.5
    fore.rotation.z = mirror * 0.15
    parent.add(hand)
    return hand
  }

  // ------------------------------------------------------------ 步枪系（1 / 6 / 4）

  /**
   * 杠杆步枪。1（温菲尔德）与 6（消音卡宾）是同一套零件、只换枪管长度；
   * 4（夏普斯狙击）加一段镜筒 —— 镜筒做成**四壁围成的方框**而不是一根实心筒：
   * 实心筒会把开镜视线堵死，而中空的框既是"从镜筒里看出去"的剪影，又让照门—
   * 准星那条线原封不动地穿过去，共线约束一个字都不用改。
   */
  const buildRifle = (o: { barrelLen: number; forendLen: number; sightBack: number; scope: boolean; suppressor: boolean }): {
    group: Group
    stock: Group
    hammer: Mesh
  } => {
    const group = new Group()
    const stock = new Group()
    group.add(stock)

    // 几何关系的关键：**离相机最近的那一点必须在 0.5m 之外**。枪托背面落在相机
    // 前 13cm 时，75° FOV 的透视会把它放大成半屏宽的白板。
    box(0.024, 0.024, o.barrelLen, steel, 0, 0.004, -0.31 - o.barrelLen / 2, true, group) // 枪管
    box(0.019, 0.019, 0.34, steel, 0, -0.026, -0.5, true, group) // 枪管下管（弹仓）
    box(0.038, 0.04, o.forendLen, wood, 0, -0.016, -0.11 - o.forendLen / 2, true, group) // 前护木
    box(0.04, 0.038, 0.24, steel, 0, -0.008, -0.02, true, group) // 机匣
    // 杠杆枪的扳机护圈：一个细黄铜环比再堆一个盒子更能读成"温菲尔德"。
    box(0.014, 0.03, 0.014, brass, 0, -0.036, 0.02, true, group)
    // 枪机拉柄与击锤：开镜时镜头正对枪身背面，一整块对称的机匣背面读不出任何
    // 机械结构。右侧伸出的拉柄与后上方的击锤小舌让这块剪影变成"一把上了膛的枪"。
    box(0.022, 0.01, 0.016, steel, 0.026, 0.0, -0.02, true, group)
    const hammer = box(0.012, 0.028, 0.014, brass, 0, 0.004, 0.048, true, group)
    hammer.rotation.x = -0.35
    hammer.userData.baseX = -0.35

    // 枪托拆两段：细的"脖颈"接机匣，高的"托底"抵肩 —— 等截面的盒子在侧视里
    // 就是一块木板，缺了由窄到宽的轮廓玩家认不出那是枪托。
    const wrist = box(0.05, 0.044, 0.16, wood, 0, -0.026, 0.11, true, stock)
    wrist.rotation.x = -0.06
    const butt = box(0.032, 0.086, 0.13, wood, 0, -0.044, 0.235, true, stock)
    butt.rotation.x = -0.1
    // 托底板：比枪托窄一圈的深色薄片，做满尺寸会变成独立方块。
    const plate = box(0.026, 0.072, 0.012, steel, 0, -0.048, 0.3, false, stock)
    plate.rotation.x = -0.1

    // 准星（细竖片）与照门（横条）：两者局部高度都是 0.026、x 都是 0，局部空间里
    // 连成一条平行于枪管的直线。开镜姿态让相机原点落在这条线上（见 solveAdsY），
    // 两者才会投影到同一个屏幕点 —— 这是"我真的在瞄"唯一的视觉依据。
    box(0.008, 0.022, 0.006, sight, 0, SIGHT_Y, -0.28 - o.barrelLen + o.sightBack, false, group)
    box(0.05, 0.005, 0.008, sight, 0, 0.019, SIGHT_REAR_Z, false, group)
    box(0.015, 0.024, 0.008, sight, -0.0145, SIGHT_Y, SIGHT_REAR_Z, false, group)
    box(0.015, 0.024, 0.008, sight, 0.0145, SIGHT_Y, SIGHT_REAR_Z, false, group)

    if (o.scope) {
      // 方框中空镜筒：四壁围在照门—准星那条线的上下左右，视线从中间穿过。
      const half = 0.034
      box(0.09, 0.008, 0.3, steel, 0, SIGHT_Y + half, -0.42, true, group)
      box(0.09, 0.008, 0.3, steel, 0, SIGHT_Y - half, -0.42, true, group)
      box(0.008, 0.076, 0.3, steel, -0.041, SIGHT_Y, -0.42, true, group)
      box(0.008, 0.076, 0.3, steel, 0.041, SIGHT_Y, -0.42, true, group)
      // 底座：把镜筒和机匣连起来，否则镜筒看着是浮在半空的。
      box(0.032, 0.022, 0.05, steel, 0, -0.006, -0.34, true, group)
    }

    if (o.suppressor) {
      // 消音器：比枪管粗一圈的短筒，挂在枪口。
      box(0.05, 0.05, 0.2, steel, 0, 0.004, -0.31 - o.barrelLen - 0.05, true, group)
    }

    // 双手：右手握在枪托脖颈（挂在 stock 上，开镜收托时跟着走），左手托护木。
    addArm(stock, 0.04, -0.03, 0.06, 1)
    // 带镜的枪（夏普斯）镜筒低、体积大：左手再压低/往前一点，别让拇指
    // 顶进镜筒下壁。机械瞄具的温菲尔德保持原来的托举位。
    addArm(
      group,
      -0.04,
      o.scope ? -0.075 : -0.02,
      -0.11 - o.forendLen * (o.scope ? 0.82 : 0.62),
      -1,
    )

    return { group, stock, hammer }
  }

  // ------------------------------------------------------------ 双管霰弹（2 / 3）

  /**
   * 双管霰弹：两根并排的粗短枪管 + 折叠机匣 + 双扳机 + 双外露击锤。
   *
   * 双扳机的两根扳机是**前后排列**而不是左右排列（左右排列是后来的单扳机
   * 选择器的位置），双外露击锤是 1878 年那批枪最容易识别的剪影特征 ——
   * 霰弹枪的辨识度全在这两个"多余"的零件上，去掉就成了一把普通猎枪。
   */
  const buildShotgun = (): { group: Group; stock: Group; hammers: Mesh[] } => {
    const group = new Group()
    const stock = new Group()
    group.add(stock)

    box(0.03, 0.03, 0.46, steel, -0.017, 0.002, -0.3, true, group) // 左枪管
    box(0.03, 0.03, 0.46, steel, 0.017, 0.002, -0.3, true, group) // 右枪管
    box(0.01, 0.006, 0.44, steel, 0, 0.021, -0.3, false, group) // 上肋条（并排双管的接缝）
    box(0.064, 0.052, 0.18, wood, 0, -0.028, -0.2, true, group) // 前护木：又短又粗
    box(0.05, 0.052, 0.13, steel, 0, -0.012, 0.0, true, group) // 折叠机匣
    box(0.056, 0.014, 0.014, brass, 0, -0.032, -0.045, true, group) // 铰链销（折叠枪的标志）
    box(0.008, 0.024, 0.008, brass, 0, -0.044, 0.026, true, group) // 前扳机
    box(0.008, 0.024, 0.008, brass, 0, -0.044, 0.052, true, group) // 后扳机
    box(0.014, 0.024, 0.07, brass, 0, -0.062, 0.04, true, group) // 扳机护圈
    const hammerL = box(0.012, 0.03, 0.014, brass, -0.019, 0.022, 0.078, true, group)
    hammerL.rotation.x = -0.45
    hammerL.userData.baseX = -0.45
    const hammerR = box(0.012, 0.03, 0.014, brass, 0.019, 0.022, 0.078, true, group)
    hammerR.rotation.x = -0.45
    hammerR.userData.baseX = -0.45
    // 缺口 = 两片竖起的照门耳，前准星是一颗珠子，两者高度同为 SIGHT_Y。
    box(0.007, 0.026, 0.007, sight, -0.011, SIGHT_Y, 0.02, false, group)
    box(0.007, 0.026, 0.007, sight, 0.011, SIGHT_Y, 0.02, false, group)
    box(0.008, 0.014, 0.008, sight, 0, SIGHT_Y, -0.52, false, group)

    const wrist = box(0.046, 0.042, 0.15, wood, 0, -0.028, 0.135, true, stock)
    wrist.rotation.x = -0.06
    const butt = box(0.034, 0.082, 0.12, wood, 0, -0.046, 0.25, true, stock)
    butt.rotation.x = -0.12
    const plate = box(0.028, 0.068, 0.012, steel, 0, -0.05, 0.31, false, stock)
    plate.rotation.x = -0.12

    // 右手握托颈，左手托粗护木。
    addArm(stock, 0.036, -0.035, 0.07, 1)
    addArm(group, -0.036, -0.025, -0.2, -1)

    return { group, stock, hammers: [hammerL, hammerR] }
  }

  // ------------------------------------------------------------ 转轮手枪（5）

  /**
   * 柯尔特 M1873 转轮：小机匣 + 六孔转轮 + 短枪管。
   *
   * 六个弹巢孔放在**转轮侧壁**（沿轴向排布的凹槽）而不是端面：从第一人称
   * 看过去，转轮的端面几乎是侧对镜头的，孔开在端面上什么都看不见；开在侧壁
   * 上，六条暗槽跟着转轮轮廓一起转，才读得出"这是个能转的弹巢"。
   */
  const buildRevolver = (): { group: Group; cylinder: Group; hammer: Mesh } => {
    const group = new Group()

    box(0.032, 0.046, 0.1, steel, 0, -0.004, 0.0, true, group) // 机匣
    // 转轮与六个弹巢孔放进同一个子组：换弹时整组绕枪管轴（z）旋转，
    // 侧壁的暗槽会跟着转，玩家才看得出"这是转轮在转"。
    const cylinder = new Group()
    group.add(cylinder)
    cyl(0.036, 0.062, 8, steel, 0, -0.01, -0.02, cylinder) // 转轮本体（八棱，卡通感更强）
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 + Math.PI / 6
      const slot = box(0.008, 0.018, 0.05, bore, 0.0315 * Math.sin(a), -0.01 + 0.0315 * Math.cos(a), -0.02, false, cylinder)
      slot.rotation.z = -a
    }
    box(0.026, 0.028, 0.3, steel, 0, 0.002, -0.22, true, group) // 枪管：短
    box(0.012, 0.012, 0.26, steel, 0, -0.026, -0.22, true, group) // 抽壳杆
    const grip = box(0.034, 0.09, 0.052, wood, 0, -0.058, 0.075, true, group) // 木握把
    grip.rotation.x = -0.32
    const hammer = box(0.01, 0.028, 0.014, brass, 0, 0.016, 0.058, true, group)
    hammer.rotation.x = -0.5
    hammer.userData.baseX = -0.5
    box(0.014, 0.028, 0.05, brass, 0, -0.04, 0.055, true, group) // 扳机护圈
    box(0.007, 0.022, 0.007, brass, 0, -0.03, 0.048, true, group) // 扳机
    box(0.007, 0.022, 0.006, sight, 0, SIGHT_Y, -0.35, false, group) // 前准星
    box(0.006, 0.024, 0.006, sight, -0.011, SIGHT_Y, 0.03, false, group) // 照门缺口左耳
    box(0.006, 0.024, 0.006, sight, 0.011, SIGHT_Y, 0.03, false, group) // 照门缺口右耳

    // 单手：副武器只有右手握把，前臂从右下出画。
    addArm(group, 0.03, -0.035, 0.06, 1)

    return { group, cylinder, hammer }
  }

  // ------------------------------------------------------------ 猎刀（10）

  /**
   * 猎刀：握把 + 护手 + 刀身（带亮边）。
   *
   * 刀身**不能是一块黑片** —— 它必须有两档：打磨过的刀面（bladeSteel）和一条
   * 几乎白的刃口（bladeEdge）。挥砍时整个模型绕手转，刃口那条亮线会先扫过
   * 画面，那一下就是"反光"。刀刃指向 -z（和枪管同向），握把落在原点附近，
   * 这样整把刀绕组的原点转 = 绕手腕转，挥砍不需要额外的枢轴节点。
   */
  const buildKnife = (): { group: Group; glow: Mesh; glowMat: Material } => {
    const group = new Group()
    box(0.024, 0.032, 0.11, wood, 0, 0, 0.02, true, group) // 握把
    box(0.052, 0.014, 0.014, brass, 0, 0, -0.04, true, group) // 护手
    box(0.028, 0.008, 0.008, brass, 0, 0.002, 0.035, true, group) // 铆钉
    box(0.009, 0.036, 0.3, bladeSteel, 0, 0.006, -0.2, true, group) // 刀身
    box(0.01, 0.007, 0.3, bladeEdge, 0, -0.016, -0.2, false, group) // 亮边（刃口）

    /**
     * 刀光：一片很薄的半透明白色面片，贴在刀身侧面。
     *
     * 它是一张**双面加色混合**的平面，法线朝 ±x —— 刀挂在画面右侧（x ≈ +0.19），
     * 相机相对它偏在 -x 一侧，所以这张面片是侧着被看到的：正好铺开成一条
     * 沿刀身方向的带子，而不是一个正对镜头的方块。
     */
    const glowGeo = new PlaneGeometry(0.34, 0.1)
    glowGeo.rotateY(Math.PI / 2)
    disposables.push(glowGeo)
    const glowMat = kit.toon(0xffffff, { hatch: 0 }).clone()
    glowMat.transparent = true
    glowMat.opacity = 0
    glowMat.depthWrite = false
    glowMat.blending = AdditiveBlending
    glowMat.side = DoubleSide
    glowMat.needsUpdate = true
    ownedMaterials.push(glowMat)
    const glow = new Mesh(glowGeo, glowMat)
    glow.position.set(0, 0.004, -0.2)
    glow.visible = false
    // 刀光不能挡子弹、也不能被拾取：它是一层纯画面效果。
    glow.raycast = () => {}
    group.add(glow)

    // 握拳：整把刀绕手的原点转，挥砍时手和刀一起走。
    addArm(group, 0.0, -0.004, 0.02, 1)

    return { group, glow, glowMat }
  }

  // ------------------------------------------------------------ 缓存表

  const rigs = new Map<number, WeaponRig>()

  const register = (id: number, rig: WeaponRig): void => {
    rigs.set(id, rig)
  }

  /** 步枪的静态姿态（1 / 6 / 4 共用一套基准位，只在 z 上按枪长微调）。 */
  const rifleRig = (id: number, built: { group: Group; stock: Group; hammer: Mesh }, extra: Partial<WeaponRig>): WeaponRig => {
    void id
    return {
      group: built.group,
      stock: built.stock,
      parts: { hammer: built.hammer },
      hipX: RIFLE_HIP_X,
      hipY: RIFLE_HIP_Y,
      hipZ: RIFLE_HIP_Z,
      yaw: RIFLE_YAW,
      pitch: RIFLE_PITCH,
      roll: RIFLE_ROLL,
      adsX: 0,
      adsY: solveAdsY(RIFLE_ADS_PITCH, RIFLE_ADS_Z, SIGHT_Y, SIGHT_REAR_Z, GUN_SCALE),
      adsZ: RIFLE_ADS_Z,
      adsPitch: RIFLE_ADS_PITCH,
      tuckY: STOCK_TUCK_Y,
      tuckZ: STOCK_TUCK_Z,
      scale: GUN_SCALE,
      slot: 0,
      isMelee: false,
      glow: null,
      glowMat: null,
      ...extra,
    }
  }

  // 温菲尔德走机械瞄具（SCOPE_MIN_ZOOM=3，1.7 倍不进镜筒），所以模型上
  // 只有准星/照门，没有镜筒；3.8 倍神射手才装 scope。
  const rifle = buildRifle({ barrelLen: 0.62, forendLen: 0.34, sightBack: 0, scope: false, suppressor: false })
  register(1, rifleRig(1, rifle, {}))

  // 消音卡宾：枪管略短（卡宾），护木相应缩短，准星往后挪一点给消音器让位。
  const carbine = buildRifle({ barrelLen: 0.56, forendLen: 0.3, sightBack: 0.06, scope: false, suppressor: true })
  register(6, rifleRig(6, carbine, { hipZ: RIFLE_HIP_Z + 0.02 }))

  // 狙击：枪管最长、镜筒最重，所以整把枪往前推 4cm、往右多让 1cm（长枪身别顶脸）。
  const sniper = buildRifle({ barrelLen: 0.74, forendLen: 0.4, sightBack: 0, scope: true, suppressor: false })
  register(
    4,
    rifleRig(4, sniper, {
      hipX: RIFLE_HIP_X + 0.01,
      hipY: RIFLE_HIP_Y - 0.005,
      hipZ: RIFLE_HIP_Z - 0.04,
      roll: RIFLE_ROLL + 0.01,
      adsZ: -0.55,
      adsPitch: 0.008,
      adsY: solveAdsY(0.008, -0.55, SIGHT_Y, SIGHT_REAR_Z, GUN_SCALE),
    }),
  )

  /**
   * 双管霰弹：比步枪更近、更靠中间（枪短，贴近脸才看得见枪管），
   * 照门缺口在 z = +0.02（机匣顶），所以 adsY 用 0.02 反解。
   */
  const shotgun = buildShotgun()
  register(2, {
    group: shotgun.group,
    stock: shotgun.stock,
    hipX: 0.19,
    hipY: -0.185,
    hipZ: -0.66,
    yaw: 0.1,
    pitch: 0.06,
    roll: 0.06,
    adsX: 0,
    adsY: solveAdsY(0.006, -0.47, SIGHT_Y, 0.02, GUN_SCALE),
    adsZ: -0.47,
    adsPitch: 0.006,
    tuckY: STOCK_TUCK_Y * 0.85,
    tuckZ: STOCK_TUCK_Z * 0.8,
    scale: GUN_SCALE,
    slot: 0,
    isMelee: false,
    glow: null,
    glowMat: null,
    parts: { hammers: shotgun.hammers },
  })
  // 柯尔特 1878 更短更粗：同一个模型的第二份实例，位置再压低 8mm（"短管"重心更低）。
  const shotgun2 = buildShotgun()
  register(3, {
    group: shotgun2.group,
    stock: shotgun2.stock,
    hipX: 0.19,
    hipY: -0.193,
    hipZ: -0.64,
    yaw: 0.11,
    pitch: 0.07,
    roll: 0.055,
    adsX: 0,
    adsY: solveAdsY(0.006, -0.46, SIGHT_Y, 0.02, GUN_SCALE),
    adsZ: -0.46,
    adsPitch: 0.006,
    tuckY: STOCK_TUCK_Y * 0.85,
    tuckZ: STOCK_TUCK_Z * 0.8,
    scale: GUN_SCALE,
    slot: 0,
    isMelee: false,
    glow: null,
    glowMat: null,
    parts: { hammers: shotgun2.hammers },
  })

  /**
   * 转轮手枪 = 副武器：**位置更低、更靠右、更靠外**。
   *
   * - hipY 比步枪低 4.5cm、hipX 多 3cm：副武器的出现语境是"步枪打空了"，玩家
   *   此刻的注意力在画面中心的敌人身上，枪压在右下角才不挡人也不被误认成主武器。
   * - adsZ -0.40（步枪 -0.5）：臂短，贴到眼前才有"贴在脸上"的感觉。
   * - adsPitch 0.012（0.7°）：转轮的照门在机匣后端、离眼睛更近，同样的 1° 会让
   *   准星跳出画面，所以俯仰角只能给到步枪的一半。
   */
  const revolver = buildRevolver()
  register(5, {
    group: revolver.group,
    stock: null,
    hipX: 0.23,
    hipY: -0.245,
    hipZ: -0.6,
    yaw: 0.12,
    pitch: 0.06,
    roll: 0.09,
    adsX: 0,
    adsY: solveAdsY(0.012, -0.4, SIGHT_Y, 0.03, GUN_SCALE),
    adsZ: -0.4,
    adsPitch: 0.012,
    tuckY: 0,
    tuckZ: 0,
    scale: GUN_SCALE,
    slot: 1,
    isMelee: false,
    glow: null,
    glowMat: null,
    parts: { cylinder: revolver.cylinder, hammer: revolver.hammer },
  })

  /**
   * 猎刀：没有机械瞄具，所以**没有 collinear 反解** —— 开镜时直接把刀往下压出
   * 画面（adsY -0.95）。这是刻意的：刀没有射程，"瞄准"对它毫无意义，抬手就是
   * 挥砍（meleeProgress）。
   */
  const knife = buildKnife()
  register(10, {
    group: knife.group,
    stock: null,
    hipX: 0.19,
    hipY: -0.185,
    hipZ: -0.52,
    yaw: 0.42,
    pitch: 0.2,
    roll: 0.16,
    adsX: 0.05,
    adsY: -0.95,
    adsZ: -0.34,
    adsPitch: -0.75,
    tuckY: 0,
    tuckZ: 0,
    scale: 0.9,
    slot: 2,
    isMelee: true,
    glow: knife.glow,
    glowMat: knife.glowMat,
  })

  // ------------------------------------------------------------ 动画状态

  let current: WeaponRig = rigs.get(1)!
  let currentId = 1
  /** 正在往画面外甩的那把（切枪期间同时挂在 root 上，甩完即摘下）。 */
  let outgoing: WeaponRig | null = null

  root.add(current.group)

  /** 疾跑混合 0..1。进入用指数逼近（有加速度感），退出用线性（"线性和回"）。 */
  let sprintBlend = 0
  /** 换弹混合。换弹进行中直接跟随相位，结束后指数回落，避免最后一帧硬跳。 */
  let reloadBlend = 0
  /** 落地冲击的 y 偏移（米，负数 = 下沉）。 */
  let landOffset = 0
  /** 上一帧的离地状态，用来检测落地那一下的边沿。 */
  let wasAirborne = false
  /** 上一帧算出的相机滚转（挥砍用）。 */
  let camRoll = 0

  /** 把当前正在甩的那把摘掉、归位（切枪结束、或又一次切枪打断它时用）。 */
  const dropOutgoing = (): void => {
    if (outgoing === null) return
    const g = outgoing.group
    root.remove(g)
    g.visible = false
    g.position.set(0, 0, 0)
    g.rotation.set(0, 0, 0)
    outgoing = null
  }

  /**
   * 切换当前显示的武器。
   *
   * 两件事：新的挂上（并且**从零位开始**，不然会继承上次残留的挥砍/甩出姿态），
   * 旧的降级成 outgoing 交给 update 去做"甩出去"的动画。旧的那把在
   * switchProgress 走完 SWITCH_EXIT_END 之后就摘下 —— 让没在手上的枪离开场景图
   * 是纯性能考虑：three 每帧要遍历所有可见节点做矩阵更新。
   */
  const setWeapon = (weaponId: number): void => {
    const next = rigs.get(weaponId) ?? rigs.get(1)!
    currentId = weaponId
    if (next === current) return
    // 连切两次时把更早那件直接丢掉，只有一件允许"正在甩出去"。
    dropOutgoing()
    outgoing = current
    current = next
    next.group.position.set(0, 0, 0)
    next.group.rotation.set(0, 0, 0)
    next.group.visible = true
    root.scale.setScalar(next.scale)
    if (next.group.parent !== root) root.add(next.group)
  }

  /**
   * 每帧更新。**稳态零分配**：这个函数里没有 new、没有对象/数组字面量、
   * 没有闭包，所有中间量都是局部标量，最终只写 root.position / root.rotation
   * 以及当前武器组的 position / rotation。
   */
  const update = (state: ViewmodelState, dt: number): void => {
    // 状态里带了 weaponId 且和当前不同 —— 等于调用方已经切了枪。
    if (state.weaponId !== undefined && state.weaponId !== currentId) setWeapon(state.weaponId)

    const rig = current
    const ads = clamp01(state.ads)
    const sw = state.switchProgress === undefined ? 1 : clamp01(state.switchProgress)
    // settled：0 = 还在举枪 / 1 = 已经完全就位。切枪期间一切"自由"动画都要乘它。
    const settled = smoothstep01(sw)
    // 一切"呼吸/摆动"类动画都乘 motion：开镜混合到 1 时它们必须严格为 0，
    // 否则玩家盯着照门会看到枪在自己晃，"我真的在瞄"的反馈就废了。
    const motion = (1 - ads) * settled
    const motionScale = state.motionScale === undefined ? 1 : clamp01(state.motionScale)
    const time = state.time
    const speed = state.speed
    const slot = state.slot === undefined ? rig.slot : state.slot
    // 副武器/刀的切枪幅度打折（见 SWITCH_SLOT_* 的注释）。
    const slotK = slot === 1 ? SWITCH_SLOT_SECONDARY : slot === 2 ? SWITCH_SLOT_MELEE : 1

    // 疾跑：进入指数逼近，退出线性回落（不瞬间跳）。
    if (state.sprinting) sprintBlend += (1 - sprintBlend) * Math.min(1, dt * 7)
    else sprintBlend = Math.max(0, sprintBlend - dt * 3.2)
    const sprint = sprintBlend * motion * motionScale

    // 换弹：三段式。phase 是 0..1 的换弹进度。
    const phase = clamp01(state.reloadProgress)
    let jitter = 0
    if (state.reloading) {
      if (phase < RELOAD_DOWN_END) {
        // 0~0.15：压下去，缓入缓出。
        reloadBlend = smoothstep01(phase / RELOAD_DOWN_END)
      } else if (phase < RELOAD_HOLD_END) {
        // 0.15~0.75：保持在压枪位，中段叠一点高频手抖（往弹仓里塞子弹）。
        reloadBlend = 1
        jitter = Math.sin(((phase - RELOAD_DOWN_END) / (RELOAD_HOLD_END - RELOAD_DOWN_END)) * Math.PI)
      } else if (phase < RELOAD_OVERSHOOT_END) {
        // 0.75~0.97：抬回来。乘 (1 - 过冲) 让它在终点越过静止位。
        reloadBlend = 1 - smoothstep01((phase - RELOAD_HOLD_END) / (RELOAD_OVERSHOOT_END - RELOAD_HOLD_END)) * (1 - RELOAD_OVERSHOOT)
      } else {
        // 最后 3%：停在略高于静止位的地方（过冲的顶点）。
        reloadBlend = RELOAD_OVERSHOOT
      }
    } else {
      // 换弹结束 / 取消：把残余的过冲指数抹平，落回静止位。
      reloadBlend -= reloadBlend * Math.min(1, dt * 16)
    }
    // 切枪期间换弹姿态必须归零：两个动画同时存在会互相抵消，看起来像枪在抽搐。
    const reload = reloadBlend * settled

    // ---- 局部机械：击锤/转轮跟着换弹与后坐动起来。
    // 以前这些零件只在构造时写死一个角度，整把枪像一块焊死的木板；现在
    // 由纯标量驱动，不引入 AnimationMixer，也不破坏确定性。
    if (rig.parts) {
      const cycle = state.reloading ? Math.sin(phase * Math.PI) : 0
      const kick = state.recoil * 0.35
      const hammers = rig.parts.hammers ?? (rig.parts.hammer ? [rig.parts.hammer] : [])
      for (const hammer of hammers) {
        const base = (hammer.userData.baseX as number | undefined) ?? 0
        hammer.rotation.x = base - cycle * 0.55 - kick
      }
      if (rig.parts.cylinder) {
        rig.parts.cylinder.rotation.z = state.reloading ? phase * Math.PI * 2 : 0
      }
    }

    // 落地：airborne 由 true 变 false 的那一帧给一次冲击，之后指数衰减。
    if (wasAirborne && !state.airborne) landOffset = -LAND_DIP
    wasAirborne = state.airborne
    landOffset *= Math.exp(-dt / LAND_DECAY)
    const land = landOffset * settled

    // 呼吸摆动：用 value noise 而不是 sin —— 站桩时看不出循环。
    const swayScale = (0.6 + Math.min(speed / 6, 1) * 0.8) * motion * motionScale
    const swayX = noise1(time * 0.33) * SWAY_X * swayScale
    const swayY = noise1(time * 0.27 + 13.7) * SWAY_Y * swayScale
    const bob = Math.sin(time * BOB_FREQ) * Math.min(speed / 6, 1) * BOB_AMP * motion * motionScale

    // 疾跑摆动：1.1Hz 的椭圆摆动（横摆 sin、竖摆 cos），另有同频滚转。
    const sprintPhase = time * SPRINT_HZ * Math.PI * 2
    const swaySprintX = Math.sin(sprintPhase) * SPRINT_SWAY_X * sprint
    const swaySprintY = Math.cos(sprintPhase) * SPRINT_SWAY_Y * sprint
    const swaySprintRoll = Math.sin(sprintPhase) * SPRINT_SWAY_ROLL * sprint

    // 手抖：两路不同频率的正弦相加，读起来才不像节拍器。
    const shakeX = Math.sin(time * 71) * RELOAD_JITTER_X * jitter * settled
    const shakeY = Math.sin(time * 97 + 1.7) * RELOAD_JITTER_Y * jitter * settled
    const shakeRoll = Math.sin(time * 83 + 0.9) * RELOAD_JITTER_ROLL * jitter * settled

    // ---- 挥砍（只在刀上算，刀以外的武器 meleeProgress 一律忽略）
    const melee = rig.isMelee && state.meleeProgress !== undefined ? clamp01(state.meleeProgress) : 0
    let mx = 0
    let my = 0
    let mz = 0
    let mrx = 0
    let mry = 0
    let mrz = 0
    // punch：这一下挥砍"当前有多快"，刀光和相机滚转都吃它。
    let punch = 0
    if (melee > 0 && melee < 1) {
      if (melee < MELEE_WIND_END) {
        // 抬起：快起慢停 —— 手抬到位会停一下再劈，那一下停留就是"力"。
        const x = melee / MELEE_WIND_END
        const t = 1 - (1 - x) * (1 - x)
        mrx = MELEE_WIND_RX * t
        mry = MELEE_WIND_RY * t
        mrz = MELEE_WIND_RZ * t
        mx = MELEE_WIND_PX * t
        my = MELEE_WIND_PY * t
        mz = MELEE_WIND_PZ * t
      } else if (melee < MELEE_SLASH_END) {
        // 劈下：t = x²，越劈越快 —— 全程最快的一段，按下的瞬间刀就该到低。
        const x = (melee - MELEE_WIND_END) / (MELEE_SLASH_END - MELEE_WIND_END)
        const t = x * x
        mrx = MELEE_WIND_RX + (MELEE_SLASH_RX - MELEE_WIND_RX) * t
        mry = MELEE_WIND_RY + (MELEE_SLASH_RY - MELEE_WIND_RY) * t
        mrz = MELEE_WIND_RZ + (MELEE_SLASH_RZ - MELEE_WIND_RZ) * t
        mx = MELEE_WIND_PX + (MELEE_SLASH_PX - MELEE_WIND_PX) * t
        my = MELEE_WIND_PY + (MELEE_SLASH_PY - MELEE_WIND_PY) * t
        mz = MELEE_WIND_PZ + (MELEE_SLASH_PZ - MELEE_WIND_PZ) * t
        punch = Math.sin(x * Math.PI)
      } else {
        // 收回：从劈到位缓回零位，俯仰上再多抬一点（收招过冲）。
        const x = (melee - MELEE_SLASH_END) / (1 - MELEE_SLASH_END)
        const k = 1 - smoothstep01(x)
        mrx = MELEE_SLASH_RX * k + MELEE_RECOVER_RX * Math.sin(x * Math.PI)
        mry = MELEE_SLASH_RY * k
        mrz = MELEE_SLASH_RZ * k
        mx = MELEE_SLASH_PX * k
        my = MELEE_SLASH_PY * k
        mz = MELEE_SLASH_PZ * k
      }
    }

    // ---- 切枪：u 是"离就位还有多远"。六个自由度六个指数，合出来是一段弧。
    const u = 1 - sw
    const dip = u * u
    const side = Math.pow(u, 1.35)
    const pull = Math.pow(u, 2.2)
    const pitchK = Math.pow(u, 1.6)
    const yawK = Math.pow(u, 1.15)
    const rollK = Math.pow(u, 1.9)

    // 位置：腰射位 → 开镜位按 ads 线性插值（ads 已经由调用方平滑过），
    // 再依次叠加摆动、疾跑、换弹、落地、切枪。
    const px =
      rig.hipX +
      (rig.adsX - rig.hipX) * ads +
      swayX +
      swaySprintX +
      SPRINT_X * sprint +
      RELOAD_X * reload +
      shakeX +
      SWITCH_SIDE * slotK * side
    const py =
      rig.hipY +
      (rig.adsY - rig.hipY) * ads +
      swayY +
      bob * 0.6 +
      swaySprintY +
      SPRINT_Y * sprint +
      RELOAD_Y * reload +
      land +
      shakeY -
      SWITCH_DIP * slotK * dip
    const pz = rig.hipZ + (rig.adsZ - rig.hipZ) * ads + SPRINT_Z * sprint + RELOAD_Z * reload + SWITCH_PULL * slotK * pull

    // 相机滞后弹簧：目标由"这一帧转了多少"决定，欠阻尼让停手后有过冲。
    // 开镜时压到 30%，否则镜心会跟着手臂一起飘。
    if (state.yaw !== undefined) {
      if (!lookInitialized) {
        lookInitialized = true
        lastYaw = state.yaw
        lastPitch = state.pitch
      }
      const dYaw = wrapAngle(state.yaw - lastYaw)
      const dPitch = state.pitch - lastPitch
      lastYaw = state.yaw
      lastPitch = state.pitch
      const targetYaw = Math.max(-0.045, Math.min(0.045, -dYaw * 5))
      const targetPitch = Math.max(-0.035, Math.min(0.035, -dPitch * 4))
      const stiffness = 120
      const damping = 16
      // 固定子步 + 速度钳制：dt=0.1（10fps/切标签回来）时显式欧拉的特征值
      // 会超过 1，弹簧发散成永久抖动。子步不超过 1/120s，位置/速度双夹。
      let remaining = Math.min(dt, 0.1)
      while (remaining > 1e-6) {
        const h = Math.min(remaining, 1 / 120)
        remaining -= h
        lagVYaw += ((targetYaw - lagYaw) * stiffness - lagVYaw * damping) * h
        lagVPitch += ((targetPitch - lagPitch) * stiffness - lagVPitch * damping) * h
        lagVYaw = Math.max(-1.2, Math.min(1.2, lagVYaw))
        lagVPitch = Math.max(-1.2, Math.min(1.2, lagVPitch))
        lagYaw = Math.max(-0.07, Math.min(0.07, lagYaw + lagVYaw * h))
        lagPitch = Math.max(-0.05, Math.min(0.05, lagPitch + lagVPitch * h))
      }
    }
    const lagScale = settled * (1 - ads * 0.7) * motionScale

    // 旋转：静态姿态随 ads 收敛到 0（开镜时枪身与视轴严格对齐，照门-准星
    // 连线才是水平的），再加后坐力、低头下垂、疾跑、换弹、手抖、切枪、挥砍滚转。
    const rx =
      rig.pitch * motion +
      rig.adsPitch * ads +
      state.recoil * 0.22 * settled +
      state.pitch * 0.06 * motion +
      SPRINT_PITCH * sprint -
      (RELOAD_PITCH_DOWN + rig.pitch * motion) * reload +
      shakeRoll * 0.4 -
      SWITCH_PITCH * slotK * pitchK +
      lagPitch * lagScale
    const ry =
      rig.yaw * motion +
      SPRINT_YAW * sprint +
      RELOAD_YAW * reload -
      SWITCH_YAW * slotK * yawK +
      lagYaw * lagScale
    const rz =
      rig.roll * motion +
      SPRINT_ROLL * sprint +
      swaySprintRoll +
      RELOAD_ROLL * reload +
      shakeRoll -
      SWITCH_ROLL * slotK * rollK +
      MELEE_ROOT_ROLL * punch

    // viewScale：FOV 收窄时把枪位按同样比例推远，屏幕投影大小不变。
    const vs = state.viewScale === undefined ? 1 : state.viewScale
    root.position.set(px * vs, py * vs, pz * vs)
    root.rotation.set(rx, ry, rz)

    // 进镜筒时收起枪身：阈值取在举枪过半之后（0.72），此时视野已经收窄、
    // 遮罩也在淡入，换掉整把枪不会被看成"枪凭空消失"。
    const stowed = state.scoped === true && ads > SCOPE_STOW_ADS
    if (root.visible === stowed) root.visible = !stowed

    // 提枪抵肩：托从中线摆出去。乘 ads 而不是 step，过渡里托是"扫"出去的。
    if (rig.stock !== null) rig.stock.position.set(0, -rig.tuckY * ads, rig.tuckZ * ads)

    // 武器组自己的局部姿态：平时是恒等（每帧写一次，代价是 6 个赋值），
    // 挥砍时是那一刀。
    rig.group.position.set(mx, my, mz)
    rig.group.rotation.set(mrx, mry, mrz)

    // 刀光：只在"劈下"的时段可见，透明度跟着速度包络走，长度随速度拉长。
    if (rig.glow !== null && rig.glowMat !== null) {
      const alpha = punch * GLOW_PEAK
      const on = alpha > 0.015
      if (rig.glow.visible !== on) rig.glow.visible = on
      if (on) {
        rig.glowMat.opacity = alpha
        rig.glow.scale.set(1, 1, 0.72 + 0.5 * punch)
      }
    }

    camRoll = -MELEE_CAM_ROLL * punch

    // ---- 旧武器甩出去
    if (outgoing !== null) {
      if (sw >= SWITCH_EXIT_END) {
        dropOutgoing()
      } else {
        // sw=0 时 e=0（贴着上一帧的手内姿态），随 sw→0.5 甩到画面外；
        // 反过来会让旧枪第一帧瞬移到最大位移，再倒着飞回来。
        const e = sw / SWITCH_EXIT_END
        const g = outgoing.group
        g.position.set(SWITCH_EXIT_X * e, -SWITCH_EXIT_DROP * e, SWITCH_EXIT_Z * e)
        g.rotation.set(-SWITCH_EXIT_PITCH * e, SWITCH_EXIT_YAW * e, SWITCH_EXIT_ROLL * e)
      }
    }
  }

  return {
    root,
    setWeapon,
    update,
    get cameraRoll(): number {
      return camRoll
    },
    dispose(): void {
      for (const geo of disposables) geo.dispose()
      for (const mat of ownedMaterials) mat.dispose()
      disposables.length = 0
      ownedMaterials.length = 0
      outgoing = null
      root.clear()
    },
  }
}
