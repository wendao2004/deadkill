/**
 * 采石场（尘土）：阶梯坑 + 矿石溜槽 + 矿车道 + 工人棚屋。
 *
 * 与沼泽图的区别不靠"盒子多"，靠三件事：
 * 1) groundMaterial='stone'，脚下一步一响，进图就换耳朵；
 * 2) 全图高差是**三层 1.2m 的石台**，中间只有 0.4m 级的踏步坡道能上去；
 * 3) 雾是暖灰（0x3a3a30）而不是沼泽的冷蓝，太阳像是被石粉糊住了。
 */
import type { LevelDef } from '../level.ts'
import { BrushSet, treelineX, treelineZ, mulberry32, perimeterBerm } from './kit.ts'
import { applyCover } from './cover.ts'
import { buildQuarry } from './zone_quarry.ts'

const boxes = new BrushSet()
const rnd = mulberry32(0x60d5)

// 坑体本体：三层石台 + 吊臂 + 碎石（rubble 是可调数量，别超过 1100 的红线）
buildQuarry(boxes, 0, -18, { rubble: 64, seed: 0x951 })

const b = new BrushSet()

// 外缘土堤：采石场天然是被"围起来"的地形，边缘不能有顺边的枪线
perimeterBerm(b, 100, { material: 'stone', top: 3.2 })

// ---- 矿石溜槽：从坑口东沿斜下到南侧矿车道，一条 56m 的木+铁长桥 ----------------
b.slab(10, 26, 2.4, 8.0, 0, 0.4, 'wood') // 起坡台（0.4m，唯一一处能直接迈上去的口）
b.slabR(14, 34, 10.0, 2.0, 0, 1.2, 0.28, 'wood') // 溜槽下段（斜放，断面 4m 宽）
b.slabR(24, 44, 10.0, 2.0, 0, 1.6, 0.30, 'wood') // 溜槽上段
for (const [x, z] of [[8, 30], [18, 38], [28, 47]]) b.slab(x, z, 0.4, 0.4, 0, 3.2, 'metal') // 支腿
b.span(20, 3.6, 40, 14.0, 0.3, 1.2, 'metal', 0.3) // 槽顶铁皮（悬空，抬头才看得见）

// ---- 矿车道：两条窄轨 + 挡块，是全图唯一"平坦但没有掩体"的地带 ------------------
b.decal(0, 62, 58, 2.2, 'mud', 0.12) // 道砟（纯装饰片：0.12m 贴地，不参与碰撞，所以不会破坏 0.4 网格）
for (let i = 0; i < 8; i++) {
  b.slab(-42 + i * 12, 62, 0.5, 2.4, 0, 0.8, 'wood') // 枕木堆
}
b.slab(0, 58, 3.0, 0.6, 0, 1.6, 'stone') // 卸料台
b.slab(0, 66, 3.0, 0.6, 0, 1.6, 'stone')

// ---- 工人棚屋（西南）：全图唯一有屋顶的室内空间 ---------------------------------
b.wallZ(-52, 40, 56, 0, 2.8, { t: 0.5, material: 'wood' }) // 西墙
b.wallZ(-60, 40, 56, 0, 2.8, { t: 0.5, material: 'wood', gaps: [[47, 51]] }) // 东墙（留门）
b.wallX(40, -60, -52, 0, 2.8, { t: 0.5, material: 'wood' }) // 北墙
b.wallX(56, -60, -52, 0, 2.8, { t: 0.5, material: 'wood' }) // 南墙
b.span(-56, 3.2, 48, 4.4, 0.4, 8.4, 'metal', 0.06) // 石棉瓦屋顶
b.slab(-56, 44, 1.2, 0.8, 0, 0.4, 'wood') // 屋内的长凳

// ---- 手写料堆：把矿车道的两端堵死，逼所有人从卸料台中间过 ----------------------
b.slab(-66, 62, 5.0, 3.0, 0, 2.4, 'stone')
b.slab(-58, 68, 3.0, 2.0, 0, 1.6, 'stone')
b.slab(60, 62, 5.0, 3.0, 0, 2.4, 'stone')
b.slab(52, 68, 3.0, 2.0, 0, 1.6, 'stone')
b.slab(-18, 70, 4.0, 2.4, 0, 1.2, 'mud') // 泥渣堆（1.2m：站直露头，蹲下全藏）
b.slab(18, 70, 4.0, 2.4, 0, 1.2, 'mud')
b.slab(-70, -10, 3.0, 6.0, 0, 1.6, 'stone') // 西侧料墙的断头
b.slab(70, 20, 3.0, 6.0, 0, 1.6, 'stone')

// ---- 林带：只在外圈，把"料场边缘 ↔ 矿车道"的长斜线切断 --------------------------
treelineX(b, -84, -60, 60, { spacing: 6.5, gaps: [[20, 26]], seed: 0x6f6f })
treelineX(b, 76, -70, 70, { spacing: 6, gaps: [[-8, -2]], seed: 0x5e5e })
treelineZ(b, 88, -50, 50, { spacing: 7, gaps: [[-16, -10]], seed: 0x7070 })
treelineZ(b, -88, -40, 40, { spacing: 7, gaps: [[-6, 0]], seed: 0x8181 })

// 散落的矿车挡块（确定性 RNG，数量 12）：矿车道上唯一的高低差
for (let i = 0; i < 12; i++) {
  const x = -50 + rnd() * 100
  const z = 54 + rnd() * 16
  b.slab(x, z, 0.8 + rnd(), 0.6 + rnd() * 0.6, 0, rnd() < 0.5 ? 0.4 : 0.8, 'metal')
}

boxes.list.push(...b.list)

export const LEVEL_QUARRY: LevelDef = {
  id: 'quarry-dust',
  name: '采石场（尘土）',
  bossKind: 'golem',
  biome: 'quarry',
  groundY: 0,
  boundsHalf: 100,
  groundMaterial: 'stone',
  fogColor: 0x3a3a30,
  fogDensity: 0.011,
  boxes: boxes.list,
  // 吊臂顶的警示灯：10m 高的铁塔在石粉雾里本来只是一根灰柱，红点给它一个"顶"。
  heroes: [{ asset: 'signal_lamp', x: 16, z: -34, y: 10.0 }],
  zones: [
    { name: '三层阶梯石台', x: 0, z: -24, radius: 20 },
    { name: '矿石溜槽', x: 20, z: 40, radius: 18 },
    { name: '工人棚屋', x: -56, z: 48, radius: 12 },
    { name: '矿车道', x: 0, z: 62, radius: 40 },
  ],
  spawns: [
    { x: 66, y: 0, z: 20 }, // 东料场
    { x: -66, y: 0, z: 20 }, // 西料场
    { x: -62, y: 0, z: -56 }, // 西北角
    { x: 62, y: 0, z: -56 }, // 东北角
    { x: 0, y: 0, z: 78 }, // 矿车道尽头
  ],
  nests: [
    // 溜槽脚下：坑内少见的开阔面，站在这儿能把整条溜槽通道压住。
    { kind: 'gunner', x: 34, z: 44 },
    { kind: 'grunt', x: -36, z: 46 }, // 棚屋北侧
    { kind: 'hound', x: -20, z: -66 }, // 坑口背后的死角（离西北/东北出生点都 >43m）
  ],
  clues: [
    { x: 0, z: 30, hint: '溜槽的木板上全是新抓痕，一路通向坑口' },
    { x: -26, z: -46, hint: '碎石堆里压着半只靴子，鞋带被人解开了' },
    { x: 44, z: -10, hint: '炮眼里塞着一张纸条：它不在坑底' },
  ],
  extracts: [
    { name: '西料道', x: -84, z: -8 },
    { name: '东料道', x: 84, z: 8 },
    { name: '弃坑口', x: 0, z: -80 },
  ],
}

// 荒野断点：必须在 LEVEL_QUARRY 建好之后撒，才能自动避开上面所有标记点
applyCover(LEVEL_QUARRY, { spacing: 22, material: 'stone', seed: 0x9e37 })
