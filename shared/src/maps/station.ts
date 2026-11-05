/**
 * 火车站废墟（黄昏）：一条 110m 的站场横穿整张图。
 *
 * 与另外三张的差别：
 * - 材质：木头与铁为主（groundMaterial = 'wood'），石料只出现在站房里；
 * - 雾：0x2a2f33、密度 0.012，比沼泽浓、比夜战淡 —— 黄昏的能见度；
 * - 地形：全图**几乎完全平坦**（最高只有月台 1.2m 与信号塔基座），胜负靠
 *   车厢与车皮的切分，而不是靠高度。这是"平地也难打"的那张图。
 *
 * 视线：三节车厢摆成三种角度（正放 / 侧翻 13m / 斜插），加上货场里成排的
 * 集装箱，站场南北两侧各自形成 30~50m 的短视线；北侧用机车库 + 水塔补断点。
 */

import { BrushSet, treelineX, treelineZ, mulberry32, perimeterBerm } from './kit.ts'
import { applyCover } from './cover.ts'
import type { LevelDef } from '../level.ts'
import { buildStation } from './zone_station.ts'

const boxes = new BrushSet()
const rnd = mulberry32(0x7ee1)

buildStation(boxes, 0, 0, { coal: 34, seed: 0x51b0 })

const b = new BrushSet()

// 外缘土堤：站场外的荒地不能有 200m 的顺轨枪线
perimeterBerm(b, 110, { material: 'mud', top: 3.2 })

// ---- 货运场（南侧）：两排集装箱，排间只留 3m 的过道 ------------------------------
const rows = [-46, 30]
for (const z of rows) {
  for (let i = 0; i < 7; i++) {
    const x = -48 + i * 16
    if (i === 5) continue // 东侧留一个 16m 的车场口（中线不留口，否则货运场能斜着看穿到机车库）
    b.slab(x, z, 3.2, 2.4, 0, rnd() < 0.5 ? 2.4 : 3.2, 'metal')
    b.slab(x, z, 3.4, 2.6, 0, 0.4, 'metal') // 底座
  }
}
// 散装货堆：0.4 / 0.8m 的麻袋与煤堆，把过道切成碎片
for (let i = 0; i < 14; i++) {
  b.slab(-60 + rnd() * 120, 12 + rnd() * 44, 0.9 + rnd(), 0.9 + rnd(), 0, rnd() < 0.5 ? 0.4 : 0.8, 'mud')
}

// ---- 机车库（北侧）：24 × 14 的敞棚，一根横梁塌下来 ---------------------------------
b.wallZ(-62, -34, -20, 0, 6.0, { t: 0.6, material: 'stone' })
b.wallZ(-38, -34, -20, 0, 6.0, { t: 0.6, material: 'stone' })
b.wallX(-34, -62, -38, 0, 6.0, { t: 0.6, material: 'stone', gaps: [[-53, -47]] })
b.span(-50, 6.4, -27, 12.4, 0.3, 7.4, 'metal') // 屋顶（底面 6.1m）
b.span(-50, 4.6, -27, 10.0, 0.3, 0.5, 'metal') // 塌下来的横梁（悬空，穿过整个棚）
b.slab(-56, -22, 1.6, 1.2, 0, 0.8, 'wood') // 检修台

// ---- 水塔：给的北带一个 11m 的竖向断点 -------------------------------------------
b.slab(28, -46, 2.4, 2.4, 0, 10.0, 'metal')
b.span(28, 10.8, -46, 3.6, 1.2, 3.6, 'metal')
b.slab(24, -46, 2.0, 1.6, 0, 0.4, 'stone') // 塔基

// ---- 信号所（西端）：小砖房，把西侧 100m 的直线切断 ------------------------------
b.wallZ(-84, -12, 6, 0, 3.6, { t: 0.6, material: 'stone' })
b.wallZ(-70, -12, 6, 0, 3.6, { t: 0.6, material: 'stone' })
b.wallX(-12, -84, -70, 0, 3.6, { t: 0.6, material: 'stone', gaps: [[-80, -76]] })
b.wallX(6, -84, -70, 0, 3.6, { t: 0.6, material: 'stone' })
b.span(-77, 3.8, -3, 7.4, 0.2, 9.4, 'stone')

treelineX(b, 84, -80, 80, { spacing: 6.5, gaps: [[-10, -4]], seed: 0x8a8a })
treelineZ(b, -94, -50, 60, { spacing: 7, gaps: [[14, 20]], seed: 0x9b9b })
treelineZ(b, 94, -50, 60, { spacing: 7, gaps: [[-30, -24]], seed: 0xacac })

boxes.list.push(...b.list)

export const LEVEL_STATION: LevelDef = {
  id: 'station-dusk',
  name: '火车站废墟（黄昏）',
  bossKind: 'conductor',
  biome: 'station',
  groundY: 0,
  boundsHalf: 110,
  groundMaterial: 'wood',
  fogColor: 0x2a2f33,
  fogDensity: 0.012,
  boxes: boxes.list,
  zones: [
    { name: '月台与站台', x: 0, z: 5, radius: 24 },
    { name: '货运场', x: 0, z: 30, radius: 40 },
    { name: '机车库', x: -50, z: -27, radius: 16 },
    { name: '信号所', x: -77, z: -3, radius: 12 },
  ],
  spawns: [
    { x: 0, y: 0, z: 84 },
    { x: 86, y: 0, z: 20 },
    { x: -86, y: 0, z: 20 },
    { x: 48, y: 0, z: -84 },
    { x: -48, y: 0, z: -84 },
  ],
  nests: [
    { kind: 'grunt', x: 8, z: -38 }, // 站场背后的调度台（集装箱排后面）
    // 货场东角：集装箱之间的一整片空地，枪手在这里能把装卸区封住。
    { kind: 'gunner', x: 74, z: 62 },
    { kind: 'hound', x: -74, z: 62 }, // 货场西角
  ],
  clues: [
    { x: 0, z: -70, hint: '调度台上摊着一本行车日志，最后一页被撕走了' },
    { x: -60, z: 44, hint: '集装箱缝里有血腥味，铁皮上全是爪子印' },
    { x: 60, z: 44, hint: '煤堆被刨开一个洞，里面有啃剩的骨头' },
  ],
  extracts: [
    { name: '西场门', x: -96, z: -20 },
    { name: '东场门', x: 96, z: -20 },
    { name: '岔道尽头', x: 0, z: 96 },
  ],
}

// 荒野断点：必须在 LEVEL_STATION 建好之后撒，才能自动避开上面所有标记点
applyCover(LEVEL_STATION, { spacing: 22, material: 'mud', seed: 0x51af })
