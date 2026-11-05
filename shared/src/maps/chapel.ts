/**
 * 教堂墓园（夜）：一张"少掩体、长读条"的图。
 *
 * 和沼泽农舍的差别必须一看就见：
 * - 材质：几乎全是石头（groundMaterial = 'stone'），木头只出现在长椅与门廊；
 * - 光照与雾：fogColor 压到 0x101620，雾密度 0.016（沼泽是 0.0092）——
 *   80m 外的钟楼只剩一个剪影，逼人靠地标而不是靠肉眼找人；
 * - 高度：整张图没有 1.6m 以上的可站立台面（除了墓台），赢得靠低姿推进而不是抢占高点；
 * - 出怪/线索/撤离全部压在图的四角，中殿是唯一的"安全屋"，但它的门只有两个。
 *
 * 视线：四面林带把外圈围起来，只在东、西各留一个口；中殿与钟楼把
 * 图心彻底堵死，墓园的墓碑阵列再把剩下那两条长视线切成 15~20m 的碎片。
 */

import { BrushSet, treelineX, treelineZ, perimeterBerm } from './kit.ts'
import { applyCover } from './cover.ts'
import type { LevelDef } from '../level.ts'
import { buildChapel } from './zone_chapel.ts'

const boxes = new BrushSet()
const water = undefined

buildChapel(boxes, 0, 0, { tablets: 64, seed: 0x7c31 })

const b = new BrushSet()
// ---- 外圈林带：只在正东、正西留口 -------------------------------------------------
treelineX(b, -60, -70, 70, { spacing: 6, gaps: [[-4, 4], [30, 36]], seed: 0x11a1 })
treelineX(b, 62, -70, 70, { spacing: 6, gaps: [[-30, -24], [10, 16]], seed: 0x22b2 })
treelineZ(b, -66, -58, 60, { spacing: 6.5, gaps: [[-20, -14]], seed: 0x33c3 })
treelineZ(b, 66, -58, 60, { spacing: 6.5, gaps: [[18, 24]], seed: 0x44d4 })

// 外缘土堤：墓园外面那圈空地不能变成可以贴边走的狙击带
perimeterBerm(b, 100, { material: 'stone', top: 3.2 })

// ---- 修士宿舍（西北）：唯一带屋顶的室内空间 ---------------------------------------
b.wallZ(-40, -26, -14, 0, 3.2, { t: 0.5, material: 'stone' })
b.wallZ(-26, -26, -14, 0, 3.2, { t: 0.5, material: 'stone' })
b.wallX(-26, -40, -26, 0, 3.2, { t: 0.5, material: 'stone', gaps: [[-34, -32]] })
b.wallX(-14, -40, -26, 0, 3.2, { t: 0.5, material: 'stone', gaps: [[-36, -30]] })
b.span(-33, 3.4, -20, 7.2, 0.2, 6.4, 'stone') // 屋顶（底面 3.2m）
b.slab(-30, -22, 1.6, 0.8, 0, 0.8, 'wood') // 宿舍里的床板
b.slab(-36, -16, 1.2, 1.2, 0, 0.4, 'wood') // 门外的柴堆

// ---- 地下墓室的入口土丘（东南）：三级 0.4m 台阶上一座石拱 -------------------------
b.stairX(40, 34, 1, 3, 5.0, 'stone', 1.2) // 地面 → 1.2m
b.slab(41, 40, 4.0, 4.0, 0, 1.2, 'stone')
b.slab(41, 40, 2.4, 3.0, 1.2, 2.4, 'stone')
b.slab(41, 37.4, 0.6, 0.6, 1.2, 3.6, 'stone') // 拱门左柱
b.slab(41, 42.6, 0.6, 0.6, 1.2, 3.6, 'stone') // 拱门右柱
b.span(41, 3.8, 40, 2.4, 0.4, 0.8, 'stone') // 门楣
b.slab(46, 40, 1.6, 1.6, 0, 0.8, 'stone') // 侧面的墓石

// ---- 小径两侧的石柱（指示主线，同时把长视线切成短段） ----------------------------
const posts: [number, number][] = [[-12, 34], [12, 34], [-12, 46], [12, 46], [-12, 58], [12, 58], [-46, 8], [-46, 20], [46, 8], [46, -8]]
for (const [x, z] of posts) b.slab(x, z, 0.5, 0.5, 0, 2.0, 'stone')

boxes.list.push(...b.list)

export const LEVEL_CHAPEL: LevelDef = {
  id: 'chapel-night',
  name: '教堂墓园（夜）',
  bossKind: 'bellkeeper',
  biome: 'church',
  groundY: 0,
  boundsHalf: 100,
  groundMaterial: 'stone',
  fogColor: 0x101620,
  fogDensity: 0.016,
  boxes: boxes.list,
  zones: [
    { name: '教堂与墓园', x: 0, z: 0, radius: 32 },
    { name: '修士宿舍', x: -33, z: -20, radius: 16 },
    { name: '地下墓室', x: 41, z: 40, radius: 14 },
    // 这个 marker 原来落在 z=66 林带的门洞 [18,24] 正前方，会形成一条 65m 直看穿的门缝；
    // 移到林带外侧（z=78）后，教堂 ↔ 林带这条视线必然被林带本身切断。
    { name: '外圈林带', x: 58, z: 60, radius: 14 },
  ],
  spawns: [
    { x: 0, y: 0, z: 80 },
    { x: 80, y: 0, z: 0 },
    { x: -80, y: 0, z: 0 },
    { x: -80, y: 0, z: -80 },
    { x: 80, y: 0, z: -80 },
  ],
  nests: [
    { kind: 'grunt', x: 58, z: 52 }, // 地下墓室侧后：拿线索的人必须贴脸过
    // 西南林带缺口：从缺口进墓地的人要先穿过他的射界。
    { kind: 'gunner', x: -52, z: 42 },
    { kind: 'hound', x: 0, z: -64 }, // 北侧：中殿背后的唯一退路
  ],
  clues: [
    { x: 0, z: 34, hint: '墓园南门外的石板上刻着新的名字，墨还没干' },
    { x: -50, z: -30, hint: '宿舍的床板被掀开，底下是一张画满箭头的图' },
    { x: 46, z: -14, hint: '钟楼下的碎石堆里有个铁盒，锁已经被人撬了' },
  ],
  extracts: [
    { name: '西林道', x: -84, z: 34 },
    { name: '东林道', x: 84, z: -34 },
    { name: '墓室后门', x: 0, z: -84 },
  ],
  water,
}

// 荒野断点：必须在 LEVEL_CHAPEL 建好之后撒，才能自动避开上面所有标记点
applyCover(LEVEL_CHAPEL, { spacing: 22, material: 'stone', seed: 0x7c31 })

