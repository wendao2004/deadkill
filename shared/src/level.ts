/**
 * 关卡几何：客户端画的和物理引擎碰的必须是**同一份数据**。
 *
 * 这是"我明明打中了却不算"的根治办法 —— 如果客户端从 .glb 里读模型、
 * 服务端从另一份手写碰撞体表里读盒子，两边的掩体尺寸必然慢慢漂移，
 * 玩家看到的是模型、被判定的是盒子，中间那道缝隙就是争吵的来源。
 *
 * 所以关卡先用"盒刷"（box brush）描述：一个数组，两端各自加工。
 * 客户端把这些盒子生成网格（现在是带描边的方块，将来换成 PBR 材质），
 * 服务端把它们生成 ColliderDesc.cuboid。等美术资源就位，再用 GLB 里
 * 导出的凸包/三角网格替换 box 列表 —— 而不是反过来。
 *
 * 本文件只放**类型与注册表**；几何本身在 maps/ 下的分图文件里：
 *   maps/kit.ts            积木工具（0.4m 吸附、开洞的墙、台阶、确定性 RNG）
 *   maps/zone_*.ts         一个区域一套建筑语汇（农舍/教堂/沼泽/磨坊/采石场/车站）
 *   maps/{marsh,chapel,quarry,station}.ts   把区域拼成一张可玩的图
 * 每张图都必须显式给 groundMaterial 与 fog 参数 —— 三张图如果只是盒子不一样，
 * 玩家会有"还是那张图"的错觉。
 */

import type { Vec3 } from './math.ts'
import { PLAYER_HALF_HEIGHT, PLAYER_RADIUS } from './constants.ts'
import { LEVEL_MARSH } from './maps/marsh.ts'
import { LEVEL_CHAPEL } from './maps/chapel.ts'
import { LEVEL_QUARRY } from './maps/quarry.ts'
import { LEVEL_STATION } from './maps/station.ts'
import { LEVEL_PINE_CAMP } from './maps/pine_camp.ts'

/**
 * 表面材质。决定脚步声、弹孔和客户端的地面颜色。
 *
 * 'water' 只用于地形上的水面区域（LevelDef.water），**不是**盒刷材质：
 * 水面没有碰撞体，也不该有人在里面跑 —— 它是"这里跑不快、声音更响"的提示。
 */
export type SurfaceMaterial = 'wood' | 'stone' | 'mud' | 'metal' | 'foliage' | 'water'

/** 盒刷能用的材质（水面除外）。 */
export type BoxMaterial = Exclude<SurfaceMaterial, 'water'>

export interface BoxBrush {
  /** 盒子中心。 */
  x: number
  y: number
  z: number
  /** 三轴半长。 */
  hx: number
  hy: number
  hz: number
  /** 绕 Y 轴旋转（弧度），0 表示轴对齐。 */
  rotY?: number
  /** 纯装饰的盒子不参与碰撞（例如天花板横梁）。 */
  noCollide?: boolean
  /**
   * 只参与碰撞与判定，客户端不画它。
   *
   * 给 GLB 建筑当"隐形骨架"用：木屋的墙、锯木厂的立柱由程序化模型负责外观，
   * 碰撞仍然由盒刷负责（Rapier、穿透、小地图、脚步材质全部同源）。和 noCollide
   * 正好互为反面 —— 一个"看得见摸不着"，一个"摸得着看不见"。
   */
  noRender?: boolean
  /** 材质提示，客户端据此选颜色/贴图。 */
  material?: BoxMaterial
}

/**
 * 地形上的水面矩形。**不生成碰撞体**，只影响渲染与脚步材质。
 *
 * 做成独立字段而不是盒刷：水面是负空间，一块"水做的方块"在物理里毫无意义。
 */
export interface WaterRect {
  x: number
  z: number
  hx: number
  hz: number
  /** 绕 Y 轴旋转（弧度）。用来做斜着的水洼/河沟，避免全是正交矩形。 */
  rotY?: number
}

/**
 * 可搜刮点的种类。决定战利品区间与客户端的模型/音效。
 *
 * 三种而不是一种：箱子是"值得绕路"的（现金多），袋子是"顺手翻"的（现金少但
 * 出现概率高），尸体是"这条路上刚死过人"的信号（现金最多，也最容易被别人
 * 一起盯上）。把它们合并成一种，玩家就没有任何理由在地图上做取舍。
 */
export type SearchKind = 'crate' | 'sack' | 'corpse'

/** 线上编码，客户端与服务端共用。**不要**改成字符串：这是二进制协议的一环。 */
export const SEARCH_KIND_CODE = { crate: 0, sack: 1, corpse: 2 } as const

/**
 * 一个可搜刮点。
 *
 * 只有 x/z：**y 由地形/地面决定**，不进数据。地图上的木台、门槛、坡地高度
 * 各不相同，把 y 写死在这里等于让每个改关卡的人手工重算一遍，而且一旦
 * 地面高度调整就会出现"箱子浮在半空"。客户端用射线贴地即可。
 *
 * rotY 纯视觉（模型朝向），服务端的判定只有水平距离，不读它。
 */
export interface SearchSpot {
  /** 世界坐标（米）。y 由地形/地面决定，不进数据。 */
  x: number
  z: number
  kind: SearchKind
  /** 模型朝向（弧度），视觉用。 */
  rotY?: number
}

/**
 * 生态/风貌标签。客户端 props.ts 靠它决定往这张图上撒什么装饰：
 * 芦苇与枯树（swamp）、谷仓与草捆（farm）、墓碑与十字架（church）、
 * 岩块与矿车（quarry）、铁轨与枕木（station）。
 * 没有这个字段，客户端只能把每张图都按沼泽长芦苇。
 */
export type LevelBiome = 'swamp' | 'farm' | 'church' | 'quarry' | 'station' | 'forest'

/**
 * 一个 GLB "主角资产"的摆放锚点（只影响客户端外观，不参与碰撞）。
 *
 * 碰撞永远由 level.boxes 负责；这里只回答"程序化模型摆在哪、朝哪"。
 * 放在 LevelDef 里而不是客户端常量表：坐标是地图设计数据，改图的人应该
 * 在同一处看到盒子和模型，否则两边一漂移就是"看得见的墙撞不到"。
 */
export interface HeroAnchor {
  /** 资产名，对应 client/public/models/generated/manifest.json 的键。 */
  asset: string
  x: number
  z: number
  /** 绝对高度（米）。缺省 = 关卡地面高度；塔尖、桅顶这类地标要抬高。 */
  y?: number
  rotY?: number
  /** 只缩放外观；碰撞盒不受影响。 */
  scale?: number
}

/**
 * 一扇可开关的门。
 *
 * 只描述门板本身：位置、半宽、高度、朝向。碰撞由服务端按它建一个固定
 * 碰撞体，开门 = 禁用碰撞体；客户端按同一份数据摆一块门板并做旋转动画。
 * 门框/门洞仍然由盒刷负责 —— 门只是"能堵住这个洞"的那一块板。
 */
/** 捕兽夹：踩中一次就弹开，不挡路、不参与射线。 */
export interface TrapDef {
  x: number
  z: number
  rotY?: number
  name?: string
}

export interface DoorDef {
  x: number
  z: number
  /** 门板半宽（沿本地 X）。 */
  hx: number
  /** 门板半厚（沿本地 Z）。 */
  hz: number
  height: number
  rotY?: number
  /** 给玩家看的名字（"中殿南门"），靠近时提示用。 */
  name?: string
}

export interface LevelDef {
  id: string
  name: string
  /** 风貌标签：决定客户端撒哪一套装饰物。每张图必须显式填。 */
  biome?: LevelBiome
  /** 地面高度（一个无限大的平面碰撞体铺在这里）。 */
  groundY: number
  /** 世界边界半边长，防止玩家走出关卡。 */
  boundsHalf: number
  boxes: BoxBrush[]
  /** 可开关的门（可选）。碰撞与外观都由它驱动，不占 boxes。 */
  doors?: DoorDef[]
  /** 捕兽夹（可选）。踩中扣血并弹开，只有触发状态，没有碰撞体。 */
  traps?: TrapDef[]
  /**
   * 程序化 GLB 资产的摆放锚点（可选）。只影响外观，碰撞仍在 boxes 里。
   */
  heroes?: HeroAnchor[]
  /** 出生点，来自服务端的分配。 */
  spawns: Vec3[]
  /**
   * 怪物巢穴（可选）。每一条会在服务端生成一只怪，y 忽略 —— 怪物永远贴着地面走，
   * 由地面的碰撞体决定它的实际高度。
   *
   * 放在关卡里而不是硬编码在 world.ts：巢穴位置是**地图设计**的一部分，
   * 改关卡的人应该能顺手挪怪，而不必去改 tick 循环。
   */
  nests?: { kind: 'gunner' | 'grunt' | 'hound'; x: number; z: number }[]
  /** 线索点。玩家必须凑到跟前按住不放才能收集，集齐之后血巢位置暴露。
   *
   * 同样属于**地图设计**：线索摆在哪里决定了整局的行进路线，摆在开阔地
   * 正中央和摆在一间必须弯腰进的小屋里是两种完全不同的游戏。
   */
  clues?: { x: number; z: number; hint: string }[]
  /**
   * 这张图血巢里爬起来的是哪只 Boss。不填 = 屠夫（旧地图/测试关卡的默认值）。
   *
   * 与怪物巢穴一样，Boss 的选择是**地图设计**：教堂的钟声、采石场的砸地、
   * 车站的枪线，必须和当地的空间尺度对得上，所以不能只在服务端按 id 猜。
   */
  bossKind?: 'boss' | 'bellkeeper' | 'golem' | 'conductor'
  /**
   * 撤离点。赏金猎人拿到赏金后必须走到这里站住，才算把命换成了钱。
   *
   * name 会直接显示在 HUD 上（"灰烬渡口"），所以它得像个地名，不能叫 A/B/C。
   */
  extracts?: { name: string; x: number; z: number }[]
  /**
   * 地面（非盒刷）的材质。默认 'mud'。
   *
   * 必须每张图显式填：沼泽是泥、教堂墓园与采石场是石、农场与车站是木/渣土。
   * 这是玩家进图三秒内唯一能立刻感知到的"换地图了"信号（脚步声最先变）。
   */
  groundMaterial?: BoxMaterial
  /** 水面矩形：只做渲染与脚步，不生成碰撞。 */
  water?: WaterRect[]
  /**
   * 区域划分（**设计标注，不参与物理**）：给测试与调试用。
   *
   * 有了它，"任何两个区域之间至少有一处遮挡"才能被写成一条自动检查，
   * 而不是靠人拿尺子在地图上量。
   */
  zones?: { name: string; x: number; z: number; radius: number }[]
  /**
   * 可搜刮点（战利品的来源）。位置属于**地图设计**：哪里能搜到什么，
   * 决定了玩家愿意往哪走、以及"贪一个箱子"的代价有多大。
   *
   * 与线索点不同，搜刮点**全场共享**：一个点被任何人搜过就永久空掉
   * （见 server/src/world.ts 的 searchedSpots），所以"抢在别人前面把
   * 这片区域翻一遍"本身就是一种对抗。
   */
  searchSpots?: SearchSpot[]
  /** 环境光/雾的颜色，客户端渲染用。 */
  fogColor: number
  fogDensity: number
}

export function box(
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  material: BoxMaterial = 'wood',
  rotY?: number,
): BoxBrush {
  return rotY === undefined
    ? { x, y, z, hx, hy, hz, material }
    : { x, y, z, hx, hy, hz, material, rotY }
}

export { LEVEL_MARSH } from './maps/marsh.ts'
export { LEVEL_CHAPEL } from './maps/chapel.ts'
export { LEVEL_QUARRY } from './maps/quarry.ts'
export { LEVEL_STATION } from './maps/station.ts'
export { LEVEL_PINE_CAMP } from './maps/pine_camp.ts'

/**
 * 沼泽图的 16 个搜刮点。
 *
 * 摆在**已有建筑/木台/水边/巢穴与撤离点**旁边，而不是随机撒在地上：
 * 搜刮点如果凭空出现在旷野里，玩家学不会"往建筑走就有收获"这条地图语言，
 * 整张图就退化成"沿着圆圈捡东西"。所以每个点都能回答"它为什么在这里"。
 *
 * 硬约束（由 tests/loot.test.ts 校验，不是靠眼睛）：
 *  - 两两间距 >= 8m：两次搜刮之间必须是两段独立的决策，不是站着一个点
 *    就能连搜两个；
 *  - 落点周围 1.6m 内没有实心盒刷（含 applyCover 撒的荒野障碍）：否则
 *    玩家会被箱子顶住，或者干脆站在墙里搜；
 *  - 不落在水面矩形里：水是"跑不快、声音更响"的负空间，不是能蹲着翻东西的地方；
 *  - 在 boundsHalf 内、且靠近区域中心（远离地图边缘的树线）。
 *
 * 分区：农场 3、磨坊 3、教堂/墓园 3、沼泽 2、采石场 2、车站 2、渡口+猎犬巢 1。
 */
const MARSH_SEARCH_SPOTS: SearchSpot[] = [
  // ---- 农场(0,0)：农舍/谷仓/青贮塔，全图最"有人气"的一片，新手第一波搜刮在这里
  // 农舍东侧储物间内：门口被后仓木台占住，这块是房间里唯一能站直的角落。
  { x: -8.8, z: -11, kind: 'crate', rotY: 0.3 },
  // 谷仓西门外的干草堆旁：谷仓本身是实心的（里面不给进），所以货只能堆在门口。
  { x: 10, z: 6.4, kind: 'sack', rotY: -0.6 },
  // 青贮塔爬梯脚下：塔基 6.4×6.4 的实心柱，只有外面这一圈能站人。
  { x: 24.6, z: -34, kind: 'sack', rotY: 2.1 },

  // ---- 磨坊(-88,-88)：风车塔门台阶、院子里的打包机与草捆
  // 风车塔正南的木台阶前：塔门朝南，进屋前必须先经过这个点（也意味着必经之地）。
  { x: -96, z: -105.5, kind: 'sack', rotY: 0 },
  // 院子里的干草打包机旁：打包机是实心的，箱子摆在它北侧的过道上。
  { x: -88, z: -73, kind: 'crate', rotY: 0.9 },
  // 院子西南角草捆堆旁的尸体：磨坊是"打到一半"的地方，尸体比箱子更像证据。
  { x: -108, z: -92, kind: 'corpse', rotY: -1.2 },

  // ---- 教堂与墓园(88,-88)：中殿/钟楼/祠堂
  // 墓园中央石板路（墓碑刻意让开 |x|<1.6，形成一条直通祭坛的走道）。
  { x: 88, z: -78, kind: 'corpse', rotY: 1.6 },
  // 钟楼东侧的塔脚：钟楼是 8×8 的实心塔，货压在它背风的东面。
  { x: 76.5, z: -97.5, kind: 'crate', rotY: -0.4 },
  // 祠堂与家族墓台之间：墓园最深的一角，搜完要走很久才能回到大门。
  { x: 104, z: -73.5, kind: 'sack', rotY: 2.6 },

  // ---- 沼泽(-88,88)：码头与水边
  // 木码头南侧的货堆：码头顶面 0.8m 是能走上去的，货只能摆在码头外的泥地上。
  { x: -77, z: 100.5, kind: 'sack', rotY: 0.2 },
  // 西部水洼东岸、泥堤与之字栈道之间的干泥地：沼泽里唯一不用下水就能翻的一箱。
  { x: -98.5, z: 100.5, kind: 'crate', rotY: 1.1 },

  // ---- 采石场(88,88)：料场与吊臂塔
  // 南料墙前的空地：三层台面都在北边，这里是台面下唯一开阔的落脚点。
  { x: 88, z: 98, kind: 'crate', rotY: -0.8 },
  // 吊臂塔南侧的碎石空地：塔座 4×4 实心、配重压在西南、碎石山堵住东北，
  // 这里是塔下一整圈里唯一能站人的缺口。
  { x: 94, z: 60, kind: 'sack', rotY: 0.7 },

  // ---- 车站(0,98)：月台尽头与铁轨
  // 月台西尽头堆货旁：再往西就是站房废墟，这个点正好卡在两片建筑中间。
  { x: -21, z: 99, kind: 'crate', rotY: -0.3 },
  // 铁轨南侧：车厢与月台之间的道砟带，是伏击月台上的人最好的位置。
  { x: 10, z: 97, kind: 'corpse', rotY: 3.0 },

  // ---- 灰烬渡口(-112,30) + 猎犬巢(-104,40)：撤离点与巢穴之间
  // 撤退路线上最后一块能搜的地方：搜它就等于把后背留给追兵 —— 这是全图
  // 赌注最大的一个点，所以给 corpse（现金最高）。
  { x: -108, z: 35, kind: 'corpse', rotY: -2.4 },
]

// 直接挂在关卡对象上：坐标是**沼泽图**的设计数据，放在这里是因为
// maps/marsh.ts 只负责几何，而搜刮点是"玩法标注"，注册表文件才是它的家。
LEVEL_MARSH.searchSpots = MARSH_SEARCH_SPOTS

/**
 * 给没有手工搜刮点的地图补一套确定性点位。
 *
 * 不是随机撒：先在每个 zone 的环上有序试位（两个点/区域），再补一层全图
 * 网格兜底；每一步都用与 `tests/loot.test.ts` 同一套几何硬约束（离实心盒
 * 1.6m、离水面 0.5m、离其它点 8m、离线索/撤离/出生点够远）。这样 3 张图
 * 立刻有 12+ 个可搜点，且不会出现"箱子里在墙里/水里"。
 *
 * 之后的正式美术/关卡阶段可以逐张替换成手工点位；这里只保证玩法闭环。
 */
const AUTO_KINDS: SearchKind[] = ['crate', 'sack', 'corpse', 'sack', 'crate', 'corpse']

export function boxFootprintDistance(b: BoxBrush, x: number, z: number): number {
  const dx = x - b.x
  const dz = z - b.z
  const c = Math.cos(b.rotY ?? 0)
  const s = Math.sin(b.rotY ?? 0)
  // 世界点转到盒子的局部坐标：x' = dx*c + dz*s, z' = -dx*s + dz*c
  const lx = dx * c + dz * s
  const lz = -dx * s + dz * c
  return Math.hypot(Math.max(0, Math.abs(lx) - b.hx), Math.max(0, Math.abs(lz) - b.hz))
}

export function waterDistance(w: WaterRect, x: number, z: number): number {
  return boxFootprintDistance({ x: w.x, y: 0, z: w.z, hx: w.hx, hy: 1, hz: w.hz, rotY: w.rotY }, x, z)
}

function nearObjective(level: LevelDef, x: number, z: number): boolean {
  const points = [
    ...(level.clues ?? []),
    ...(level.extracts ?? []),
    ...(level.nests ?? []),
    ...(level.spawns ?? []),
  ]
  return points.some((p) => Math.hypot(p.x - x, p.z - z) < 4)
}

function autoSpotValid(level: LevelDef, x: number, z: number): boolean {
  if (Math.abs(x) > level.boundsHalf - 4 || Math.abs(z) > level.boundsHalf - 4) return false
  // 只有横跨"人站得住的高度带"的盒子才真的会卡人：屋檐、头顶横梁、
  // 地面以下的装饰块不该把一块可站的地面判死。
  const bandLow = level.groundY + 0.05
  const bandHigh = level.groundY + PLAYER_HALF_HEIGHT * 2 + PLAYER_RADIUS * 2
  for (const b of level.boxes) {
    if (b.noCollide) continue
    if (b.y + b.hy <= bandLow || b.y - b.hy >= bandHigh) continue
    if (boxFootprintDistance(b, x, z) < 1.6) return false
  }
  for (const w of level.water ?? []) {
    if (waterDistance(w, x, z) < 0.5) return false
  }
  return !nearObjective(level, x, z)
}

/** 给每张图的每条线索补一个"守线索"的巢穴；已经有近巢就不动。 */
const AUTO_NEST_KINDS: ('grunt' | 'hound' | 'gunner')[] = ['grunt', 'hound', 'gunner']

export function autoClueNests(level: LevelDef): void {
  const nests = level.nests ?? (level.nests = [])
  for (const clue of level.clues ?? []) {
    if (nests.some((n) => Math.hypot(n.x - clue.x, n.z - clue.z) < 14)) continue
    let placed = false
    for (const r of [9, 11, 13]) {
      for (const angle of [0.4, 1.1, 1.8, 2.5, 3.2, 3.9, 4.6, 5.3]) {
        const x = clue.x + Math.cos(angle) * r
        const z = clue.z + Math.sin(angle) * r
        if (!autoSpotValid(level, x, z)) continue
        if (level.spawns.some((s) => Math.hypot(s.x - x, s.z - z) < 35)) continue
        if (nests.some((n) => Math.hypot(n.x - x, n.z - z) < 8)) continue
        nests.push({
          kind: AUTO_NEST_KINDS[nests.length % AUTO_NEST_KINDS.length]!,
          x: Math.round(x * 10) / 10,
          z: Math.round(z * 10) / 10,
        })
        placed = true
        break
      }
      if (placed) break
    }
  }
}
/**
 * 给一张没有 `searchSpots` 的图生成 12–16 个点位；确定性，同一张图每次一样。
 */
export function autoSearchSpots(level: LevelDef): SearchSpot[] {
  const spots: SearchSpot[] = []
  const tryAdd = (x: number, z: number, minDist: number): boolean => {
    if (!autoSpotValid(level, x, z)) return false
    if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < minDist)) return false
    spots.push({
      x: Math.round(x * 10) / 10,
      z: Math.round(z * 10) / 10,
      kind: AUTO_KINDS[spots.length % AUTO_KINDS.length]!,
      rotY: Math.round((spots.length * 0.9 + x * 0.01) * 100) / 100,
    })
    return true
  }

  const zones = level.zones ?? []
  const angles = [0.3, 1.2, 2.1, 3.0, 3.9, 4.8, 5.7]
  for (const zone of zones) {
    let placed = 0
    for (const ring of [0.5, 0.72, 0.92]) {
      const r = Math.max(9, Math.min(zone.radius * ring, 26))
      for (const angle of angles) {
        if (placed >= 2) break
        if (tryAdd(zone.x + Math.cos(angle) * r, zone.z + Math.sin(angle) * r, 8)) placed++
      }
      if (placed >= 2) break
    }
  }

  // 兜底网格：区域没覆盖到的角落（或某个 zone 全被实心盒占满）也要有点。
  const step = 16
  for (let z = -level.boundsHalf + 8; z <= level.boundsHalf - 8 && spots.length < 14; z += step) {
    for (let x = -level.boundsHalf + 8; x <= level.boundsHalf - 8 && spots.length < 14; x += step) {
      tryAdd(x, z, 8)
    }
  }
  if (spots.length < 12) {
    for (let z = -level.boundsHalf + 8; z <= level.boundsHalf - 8 && spots.length < 12; z += 10) {
      for (let x = -level.boundsHalf + 8; x <= level.boundsHalf - 8 && spots.length < 12; x += 10) {
        tryAdd(x, z, 6)
      }
    }
  }
  return spots
}

/**
 * 全部关卡，按 id 索引。
 *
 * 服务端按 id 选图（房间配置、调试指令、回放），所以 id 一旦发布就不能再改；
 * 想换内容就改名字与几何，id 保持不动。
 */
export const LEVELS: Record<string, LevelDef> = {
  [LEVEL_MARSH.id]: LEVEL_MARSH,
  [LEVEL_CHAPEL.id]: LEVEL_CHAPEL,
  [LEVEL_QUARRY.id]: LEVEL_QUARRY,
  [LEVEL_STATION.id]: LEVEL_STATION,
  [LEVEL_PINE_CAMP.id]: LEVEL_PINE_CAMP,
}

// 没有手工点位的图在加载时补一套自动点位。放在 LEVELS 之后、其它模块导入之前：
// 客户端要画搜刮点、服务端要判最近点，两份必须看到同一份数组。
for (const level of Object.values(LEVELS)) {
  if (!level.searchSpots || level.searchSpots.length === 0) {
    level.searchSpots = autoSearchSpots(level)
  }
  // 每条线索 14m 内至少一个巢穴：PvE 从"背景板"变成"必经点的压力"。
  autoClueNests(level)
}

/** 可选关卡的 id 列表（顺序稳定，便于 UI 直接渲染）。 */
export const LEVEL_IDS: string[] = Object.keys(LEVELS)

/** 默认关卡 id。 */
export const DEFAULT_LEVEL_ID = 'marsh-p0'

/**
 * 按 id 取关卡。未知 id 直接抛错，而不是悄悄退化成默认图：
 * 悄悄退化会让"我在调试 chapel，怎么进来是沼泽"这种问题花掉半小时。
 */
export function getLevel(id: string): LevelDef {
  const level = LEVELS[id]
  if (!level) throw new Error(`未知关卡 id: ${id}（可选: ${LEVEL_IDS.join(', ')}）`)
  return level
}

/** 默认关卡对象。服务端/客户端在没有指定关卡时用它。 */
export const DEFAULT_LEVEL: LevelDef = LEVELS[DEFAULT_LEVEL_ID]
