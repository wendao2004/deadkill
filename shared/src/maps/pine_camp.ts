/**
 * 松林营地（夜）：木、水、火三种材料构成的图。
 *
 * 和另外四张图的区分不靠"再来一栋房子"，靠三件事：
 * - **木**：原木屋、锯木厂、原木堆、树桩，几乎每一条可交互的边都是圆的；
 * - **水**：锯木厂的沉木池是全图唯一的大水面，浮木把它切成 20m 以内的段；
 * - **火**：营地篝火与路灯是全图唯一的暖色，玩家在雾里先看见的是光。
 *
 * 布局（世界坐标）：
 *   主营地     (0, 0)      三栋木屋、水井、晾木架、篝火
 *   锯木厂     (58, -34)   开敞棚架 + 沉木池 + 吊臂
 *   伐木坡     (46, 54)    三层台地、滑木槽、树桩阵
 *   烧焦林     (-54, 40)   焚屋残墙、焦木、低能见度伏击带
 *   运输道     (-58, -46)  木桥、哨卡、错位路障
 *   北岭       (0, -72)    岩脊，能俯视营地但没有掩体
 *
 * 视线：南北主路是唯一 180m 级的直通线，靠三组原木堆与晾木架切碎；
 * 每个区域之间都有一条带缺口的林带，缺口位置互不相对，横穿全图必须换角度。
 */

import { BrushSet, treelineX, treelineZ, perimeterBerm } from './kit.ts'
import { applyCover } from './cover.ts'
import type { HeroAnchor, LevelDef, WaterRect } from '../level.ts'
import { buildPineCamp, pineWater } from './zone_pine.ts'

const boxes = new BrushSet()
buildPineCamp(boxes, 0, 0)

// 地面上的土路：纯装饰片（noCollide），把六个区域用'人走出来的路'串起来。
// 手绘场景里，路是最便宜的构图工具：它告诉玩家往哪看，也把空地切成有意义的块。
const paths = new BrushSet()
paths.decal(6, 48, 2.8, 36, 'mud', 0.06) // 南入口 → 营地
paths.decal(2, 16, 2.6, 8, 'mud', 0.06)
paths.decal(26, -12, 12, 2.2, 'mud', 0.06) // 营地 → 锯木厂
paths.decal(44, -22, 10, 2.0, 'mud', 0.06)
paths.decal(18, 30, 8, 2.2, 'mud', 0.06) // 营地 → 伐木坡
paths.decal(30, 44, 9, 2.0, 'mud', 0.06)
boxes.list.push(...paths.list)

// ---- 区域之间的林带：每个方向只留一个口子 ----
const b = new BrushSet()
treelineZ(b, 32, -52, -14, { spacing: 6.5, gaps: [[-36, -28]], seed: 0x1f01 }) // 营地 ↔ 锯木厂
treelineX(b, 30, 10, 42, { spacing: 6, gaps: [[20, 27]], seed: 0x1f02 }) // 营地 ↔ 伐木坡
treelineZ(b, -32, 12, 58, { spacing: 6.5, gaps: [[30, 37]], seed: 0x1f03 }) // 营地 ↔ 烧焦林
treelineX(b, -30, -52, -20, { spacing: 6, gaps: [[-41, -34]], seed: 0x1f04 }) // 营地 ↔ 运输道
treelineX(b, -58, -30, 30, { spacing: 6.5, gaps: [[-5, 7]], seed: 0x1f05 }) // 北岭南麓

// 锯木厂 ↔ 伐木坡之间是一条 91m 的斜线：光靠林带挡不住（树干只有 0.8m 宽，
// 三条平行视线里总有一条从树缝里穿过去），所以补一条 1.6m 土堤，只在东端留口。
b.wallX(14, 36, 74, 0, 1.6, { t: 1.0, material: 'mud', gaps: [[64, 70]] })
treelineX(b, 18, 34, 76, { spacing: 5.5, gaps: [[64, 70]], seed: 0x1f06 })

// ---- 外缘：林带 + 土堤。缺口对准出生点与撤离点 ----
treelineX(b, -92, -88, 88, { spacing: 7, gaps: [[-48, -34]], seed: 0x2a01 }) // 北
treelineX(b, 92, -88, 88, { spacing: 7, gaps: [[-8, 4], [10, 24]], seed: 0x2a02 }) // 南
treelineZ(b, 92, -88, 88, { spacing: 7, gaps: [[-8, 8], [32, 48]], seed: 0x2a03 }) // 东
treelineZ(b, -92, -88, 88, { spacing: 7, gaps: [[-32, -16], [-16, -2], [64, 80]], seed: 0x2a04 }) // 西

perimeterBerm(b, 100, { material: 'mud', top: 3.2 })

boxes.list.push(...b.list)

/** 沉木池：不生成碰撞体，只影响渲染与脚步材质。 */
const water: WaterRect[] = pineWater()

/**
 * GLB 主角资产。
 *
 * 坐标必须和 zone_pine.ts 里的 ghost 盒子重合：模型负责"看起来是什么"，
 * 盒子负责"能不能过"。两者之间只差一个 noRender。
 */
const heroes: HeroAnchor[] = [
  // 营地：主屋可进入，两侧实心屋提供剪影层次
  { asset: 'log_cabin_a', x: -10, z: -5, rotY: Math.PI },
  { asset: 'log_cabin_a', x: 9, z: -9, rotY: -0.35 },
  { asset: 'log_cabin_a', x: 12, z: 5, rotY: 2.5 },
  { asset: 'bonfire', x: 0, z: 0 },
  { asset: 'lantern_post', x: -6, z: 2, rotY: Math.PI / 2 },
  { asset: 'lantern_post', x: 6, z: -2, rotY: -Math.PI / 2 },
  { asset: 'lantern_post', x: 0, z: 10 },
  { asset: 'log_pile', x: 5, z: 4, rotY: 0.3 },
  { asset: 'log_pile', x: -13, z: 2, rotY: 1.4 },

  // 锯木厂
  { asset: 'sawmill_a', x: 58, z: -36 },
  // 水车：斜对着沉木池，从主营地就能看见这个 5m 高的轮子。
  { asset: 'water_wheel', x: 66, z: -45, rotY: 0.35 },
  { asset: 'log_pile', x: 64, z: -45, rotY: Math.PI / 2 },
  { asset: 'log_pile', x: 68.5, z: -47, rotY: Math.PI / 2 + 0.25 },
  { asset: 'log_pile', x: 61, z: -47.5, rotY: 0.1 },
  { asset: 'lantern_post', x: 53, z: -33, rotY: Math.PI },

  // 伐木坡
  { asset: 'stump', x: 40, z: 52 },
  { asset: 'stump', x: 44, z: 60 },
  { asset: 'stump', x: 50, z: 48 },
  { asset: 'stump', x: 55, z: 62 },
  { asset: 'log_pile', x: 42, z: 58, rotY: 1.2 },
  { asset: 'rock_a', x: 52, z: 66, scale: 0.8 },

  // 烧焦林
  { asset: 'pine_dead', x: -60, z: 34, scale: 1.1 },
  { asset: 'pine_dead', x: -48, z: 46, scale: 1.3 },
  { asset: 'pine_dead', x: -57, z: 50, scale: 0.9 },
  { asset: 'log_pile', x: -50, z: 36, rotY: -0.6 },
  { asset: 'rock_a', x: -46, z: 42, scale: 0.7 },

  // 运输道
  { asset: 'log_pile', x: -55, z: -42, rotY: 0.2 },
  { asset: 'lantern_post', x: -61, z: -50, rotY: 0.4 },
  { asset: 'rock_a', x: -66, z: -38, scale: 0.6 },

  // 北岭
  { asset: 'rock_a', x: -5, z: -74, scale: 1.2 },
  { asset: 'rock_a', x: 6, z: -70, scale: 0.9 },
  { asset: 'pine_dead', x: 2, z: -76, scale: 1.2 },
]

export const LEVEL_PINE_CAMP: LevelDef = {
  id: 'pine-camp-night',
  name: '松林营地（夜）',
  bossKind: 'golem',
  biome: 'forest',
  groundY: 0,
  boundsHalf: 100,
  groundMaterial: 'mud',
  // 雾比教堂淡一档：松林要靠树干的层次读距离，雾太浓会糊成一块。
  fogColor: 0x141b1a,
  fogDensity: 0.0125,
  boxes: boxes.list,
  heroes,
  water,
  zones: [
    { name: '主营地', x: 0, z: 0, radius: 30 },
    { name: '锯木厂', x: 58, z: -36, radius: 22 },
    { name: '伐木坡', x: 46, z: 54, radius: 24 },
    { name: '烧焦林', x: -54, z: 40, radius: 24 },
    { name: '运输道', x: -58, z: -46, radius: 24 },
    { name: '北岭', x: 0, z: -72, radius: 20 },
  ],
  spawns: [
    { x: 16, y: 0, z: 88 },
    { x: 88, y: 0, z: 0 },
    { x: -88, y: 0, z: -8 },
    { x: -40, y: 0, z: -88 },
    { x: 88, y: 0, z: 60 },
    { x: -88, y: 0, z: 72 },
  ],
  nests: [
    { kind: 'grunt', x: -6, z: 12 }, // 营地西侧晾木架后
    { kind: 'gunner', x: 62, z: -30 }, // 锯木厂送料台
    { kind: 'hound', x: -56, z: 44 }, // 焚屋残墙
    { kind: 'grunt', x: 38, z: 58 }, // 伐木坡脚下
    { kind: 'gunner', x: -58, z: -30 }, // 运输道桥头
    { kind: 'hound', x: 14, z: -72 }, // 北岭东侧岩脊
  ],
  clues: [
    { x: -4, z: 4, hint: '篝火边的雪地上有一串拖痕，通向晾木架后面' },
    { x: 58, z: -26, hint: '锯木厂的送料台上钉着一张伐木队的排班表，最后一行被人划掉了' },
    { x: -52, z: 40, hint: '焚屋里只剩半面墙，墙上的影子比人多了两个' },
  ],
  extracts: [
    { name: '南林道', x: 0, z: 86 },
    { name: '西渡口', x: -86, z: -24 },
    { name: '东岭道', x: 84, z: 40 },
  ],
}

// 荒野断点：必须在所有标记点建好之后撒，才能自动避开它们
applyCover(LEVEL_PINE_CAMP, { spacing: 24, material: 'mud', seed: 0x0f0e5a })
