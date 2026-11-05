/**
 * 沼泽农舍（大厅图）：260m × 260m，六个区域。
 *
 * 为什么这么大还要能打：面积不是靠"把 40 个盒子乘 3"换来的，而是靠"六个
 * 各自成立的小场" + 连接它们的走廊。每个区域自己有一套完整的高度层次
 * （掩体 0.4~0.8 / 露头 1.2~1.6 / 绕行 2.4~3.6），区域之间用林带、土堤、
 * 站场这些"长条"打断，于是玩家在任何一点上看到的都还是一段 40~80m 的仗，
 * 但整局的移动范围是 260m。
 *
 * 布局（世界坐标，原点在农舍）：
 *   农舍        (0, 0)      中心锚点，唯一的人造院落
 *   磨坊谷仓    (-88, -88)  西北：风车塔 12.6m
 *   教堂墓园    (88, -88)   东北：钟楼 20m，全图最高
 *   沼泽栈桥    (-88, 88)   西南：唯一的低洼区 + 水面
 *   采石场      (88, 88)    东南：三层阶梯石壁
 *   火车站废墟  (0, 110)    南侧长条：把南半个图劈成两条互不相见的走廊
 *
 * 刻意的视线断点（每一条都是为了不出现 200m 长廊）：
 * - 磨坊↔教堂之间（z = -88）有一条 5.5m 间距的林带，只在 x = -6~0 留一个口子；
 * - 教堂↔采石场之间（x = 88）同样一条林带，口子在 z = -20~-14；
 * - 磨坊↔沼泽（x = -88）与沼泽↔采石场（z = 88）各留一个口子，位置互不相同，
 *   所以没有任何一条直线能同时穿过四个口子 —— 想横穿全图必须换角度；
 * - 南侧站场（110m 的月台 + 三节车厢）本身就是一道 1.2~3.6m 的长墙；
 * - 北带 z = -104 的水塔与石渣堆补齐了"两个角落区之间 120m 的空档"。
 */

import { BrushSet, treelineX, treelineZ, perimeterBerm } from './kit.ts'
import { applyCover } from './cover.ts'
import type { LevelDef, WaterRect } from '../level.ts'
import { buildFarm } from './zone_farm.ts'
import { buildMill } from './zone_mill.ts'
import { buildChapel } from './zone_chapel.ts'
import { buildSwamp } from './zone_swamp.ts'
import { buildQuarry } from './zone_quarry.ts'
import { buildStation } from './zone_station.ts'

const boxes = new BrushSet()
const water: WaterRect[] = []

buildFarm(boxes, 0, 0)
buildMill(boxes, -88, -88)
buildChapel(boxes, 88, -88)
buildSwamp(boxes, -88, 88, water)
buildQuarry(boxes, 88, 88)
buildStation(boxes, 0, 98)

// ---- 区域之间的视线断点 ----
const b = new BrushSet()
treelineX(b, -88, -58, 58, { spacing: 5.5, gaps: [[-6, 0]], seed: 0x1a01 }) // 北带：磨坊 ↔ 教堂
treelineZ(b, 88, -54, 56, { spacing: 6, gaps: [[-20, -14]], seed: 0x2b02 }) // 东带：教堂 ↔ 采石场
treelineX(b, 88, -56, 56, { spacing: 5.5, gaps: [[6, 12]], seed: 0x3c03 }) // 南带：沼泽 ↔ 采石场
treelineZ(b, -88, -56, 56, { spacing: 6, gaps: [[10, 16]], seed: 0x4d04 }) // 西带：磨坊 ↔ 沼泽

// 外缘土堤：贴边那圈 260m 的"隐形墙走廊"必须变成实体边界
perimeterBerm(b, 130, { material: 'mud', top: 3.2 })

// 北带中段的矮土堤：林带是"能钻过去"的，土堤是"必须绕"的，两种交替才有节奏
b.wallX(-96, -50, -8, 0, 1.2, { t: 1.2, material: 'mud', gaps: [[-28, -22]] })
b.wallX(-96, 8, 50, 0, 1.2, { t: 1.2, material: 'mud' })
// 南带的石渣堤：把沼泽到站场之间那条 30m 宽的"大路"掐成两段
b.wallX(56, -56, -18, 0, 1.6, { t: 1.2, material: 'stone', gaps: [[-40, -34]] })
b.wallX(56, -6, 56, 0, 1.6, { t: 1.2, material: 'stone' })

// ---- 独立地标：水塔 + 农机残骸，用来补齐角落区之间的空档 ----
b.slab(-4, -104, 3.0, 3.0, 0, 9.6, 'metal') // 水塔塔身：北带正中唯一的 9.6m 竖体
b.span(-4, 10.4, -104, 4.2, 1.2, 4.2, 'metal') // 水箱
b.slab(-4, -100.4, 1.2, 0.4, 0, 1.2, 'metal') // 塔基爬梯
b.slab(34, -104, 4.0, 2.0, 0, 1.6, 'wood') // 报废收割机（北带东段）
b.slab(30, -104, 2.0, 2.0, 0, 0.8, 'metal')
b.slab(-34, 62, 3.0, 2.4, 0, 1.2, 'wood') // 沉船的散落船板（南带西段）
b.slab(20, 60, 2.4, 2.4, 0, 0.8, 'mud') // 泥滩上的车辙痕

boxes.list.push(...b.list)

// 荒野断点：applyCover 在关卡建成后统一撒（它需要看到所有标记点才能避开）
export const LEVEL_MARSH: LevelDef = {
  id: 'marsh-p0',
  name: '沼泽农舍（大厅）',
  bossKind: 'boss',
  biome: 'swamp',
  groundY: 0,
  boundsHalf: 130,
  groundMaterial: 'mud',
  fogColor: 0x232c35,
  fogDensity: 0.0092,
  boxes: boxes.list,
  water,
  zones: [
    { name: '农舍', x: 0, z: 0, radius: 40 },
    { name: '磨坊谷仓', x: -88, z: -88, radius: 27 },
    { name: '教堂墓园', x: 88, z: -88, radius: 31 },
    { name: '沼泽栈桥', x: -88, z: 88, radius: 32 },
    { name: '采石场', x: 88, z: 88, radius: 29 },
    { name: '火车站废墟', x: 0, z: 98, radius: 20 },
  ],
  spawns: [
    { x: 0, y: 0, z: -114 }, // 北缘正中（外缘土堤内侧 8m）
    { x: 114, y: 0, z: 0 }, // 东缘
    { x: -114, y: 0, z: 0 }, // 西缘
    { x: 0, y: 0, z: 118 }, // 南缘（站场外，站场尽头与土堤之间）
    { x: -44, y: 0, z: -56 }, // 北带西段走廊
    { x: 44, y: 0, z: -56 }, // 北带东段走廊
    { x: -52, y: 0, z: 44 }, // 西南走廊
    { x: 52, y: 0, z: 44 }, // 东南走廊
    { x: -100, y: 0, z: -20 }, // 西带中段
    { x: 96, y: 0, z: -30 }, // 东带中段
  ],
  nests: [
    { kind: 'grunt', x: 112, z: -108 }, // 教堂区东南角：绕钟楼的必经点
    // 东带中段是教堂 ↔ 采石场的唯一通道：一条没有掩体的长走廊，正是一个枪手
    // 该站的位置 —— 逼玩家要么绕远、要么先把他打掉。
    { kind: 'gunner', x: 110, z: 40 },
    { kind: 'hound', x: -104, z: 40 }, // 西带中段：磨坊 ↔ 沼泽之间
  ],
  clues: [
    { x: -88, z: -64, hint: '磨坊院门外的车辙里嵌着半截人骨，一路拖向东北' },
    { x: 46, z: 84, hint: '站场东侧的碎石被血泡软了，脚印通向采石场的碎石堆' },
    { x: -36, z: 96, hint: '芦苇被压倒一片，泥水里浮着一件撕烂的猎装' },
  ],
  extracts: [
    { name: '灰烬渡口', x: -112, z: 30 }, // 西缘：沼泽边的老渡口
    { name: '沉钟栈桥', x: 112, z: -30 }, // 东缘：教堂地下的旧栈桥
    { name: '白骨滩', x: 0, z: -118 }, // 北缘：水塔背后
  ],
}

// 荒野断点：必须在 LEVEL_MARSH 建好之后撒，才能自动避开上面所有标记点
applyCover(LEVEL_MARSH, { spacing: 20, material: 'mud', seed: 0x51de })
