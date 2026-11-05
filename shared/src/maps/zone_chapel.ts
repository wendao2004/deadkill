/**
 * 教堂与墓园区。
 *
 * 语汇：整块石头 + 铁。木头在这里几乎不出现 —— 这一区要和农舍区在**材质**
 * 上就区分开，玩家从木色走进灰色石板路时该有"换地方了"的感觉。
 *
 * 视线设计：
 * - 中殿是个 24m 的封闭盒子，两侧墙上的窗是**高窗**（离地 3.6m 起），只在
 *   站着的人头顶上留一条缝 —— 窗里射不出去，但屋里能感到外面更亮。
 * - 钟楼 14m 高，是整张图最高的垂直断点，站在墓园任何位置向东看都会被它切一刀。
 * - 墓碑阵列是"人能穿过、子弹不一定"的低障碍：0.8 / 1.2 两档，蹲着能藏，
 *   站起来只露上半身，让墓园成为全图唯一适合贴地推进的区域。
 * - 铁栅栏把墓园围起来，只留北面一个 4m 门洞：从外面看进去是"有进无出"的疑惑。
 */

import { BrushSet, translate, mulberry32 } from './kit.ts'

export interface ChapelOpts {
  /** 墓碑数量（显式可调：客户端每个盒子一个网格 + 描边）。默认 48。 */
  tablets?: number
  /** 随机种子。同一张图必须给同一个种子，否则两端摆出来的墓碑不重合。 */
  seed?: number
}

export function buildChapel(set: BrushSet, ox: number, oz: number, opts: ChapelOpts = {}): void {
  const s = new BrushSet()
  const rnd = mulberry32(opts.seed ?? 0x2c0ffee)
  const tablets = opts.tablets ?? 48

  // ---- 中殿：24 × 12，墙高 6.4m ----
  s.wallX(-18, -14, 10, 0, 6.4, { t: 0.8, material: 'stone', gaps: [[-6, -3], [3, 6]] }) // 北墙（两扇高窗）
  s.wallX(-6, -14, 10, 0, 6.4, { t: 0.8, material: 'stone', gaps: [[-2, 2]] }) // 南墙（正门 4m）
  s.wallZ(10, -18, -6, 0, 6.4, { t: 0.8, material: 'stone' }) // 东端半圆室（简化成直墙）
  // 窗台：把窗洞下半截补实，窗只剩 3.6~5.6m 那一段 —— 贴着墙也射不出去
  s.slab(-4.5, -18, 1.5, 0.4, 0, 3.6, 'stone')
  s.slab(4.5, -18, 1.5, 0.4, 0, 3.6, 'stone')
  s.slab(-4.5, -18, 1.5, 0.4, 5.6, 6.4, 'stone')
  s.slab(4.5, -18, 1.5, 0.4, 5.6, 6.4, 'stone')

  // 双坡屋顶：悬空板，底面 7.3m，不参与可攀爬高度
  s.span(-2, 7.6, -15.2, 12.4, 0.3, 4.2, 'stone')
  s.span(-2, 7.6, -8.8, 12.4, 0.3, 4.2, 'stone')
  s.span(-2, 9.2, -12, 12.4, 0.3, 0.3, 'stone') // 屋脊

  // 中殿内部：三排长椅（人绕得过去，子弹不一定）、祭坛台
  for (let i = 0; i < 3; i++) {
    s.slab(-6 + i * 5.2, -12, 0.4, 4.4, 0, 0.8, 'wood') // 长椅靠背
    s.slab(-6 + i * 5.2, -12, 1.4, 4.4, 0, 0.4, 'wood') // 长椅座：0.4m，正好一步踩上
  }
  s.slab(6, -12, 2.0, 4.0, 0, 0.8, 'stone') // 祭坛台

  // ---- 钟楼：西端 8×8 方塔，14m 高 ----
  s.slab(-18, -14, 4.0, 4.0, 0, 14.0, 'stone') // 塔身实心（不需要内部，也就不需要假门）
  s.slab(-18, -9.2, 1.6, 0.6, 0, 0.8, 'stone') // 塔脚台阶：坐上去刚好靠着塔身
  s.span(-18, 14.4, -14, 4.6, 0.4, 4.6, 'stone') // 钟室外挑
  s.span(-18, 15.6, -14, 3.0, 0.8, 3.0, 'stone', Math.PI / 4) // 钟室（转 45° 的八边形近似）
  s.span(-18, 17.6, -14, 1.6, 1.2, 1.6, 'stone', Math.PI / 4) // 尖顶
  s.span(-18, 19.2, -14, 0.4, 0.4, 0.4, 'metal', Math.PI / 4) // 塔尖

  // ---- 墓园：铁栅栏围出 44 × 26 的地块 ----
  s.fenceX(24, -24, 20, 1.6, { step: 3.4 }) // 南栅栏
  s.fenceZ(-24, -2, 24, 1.6, { step: 3.4 }) // 西栅栏
  s.fenceZ(20, -2, 24, 1.6, { step: 3.4 }) // 东栅栏
  // 北栅栏分两段：中间 4m 是唯一的门（整段做栅栏再"删柱子"的做法会留下挡人的横杆）
  s.fenceX(-2, -24, -3, 1.6, { step: 3.4 })
  s.fenceX(-2, 1, 20, 1.6, { step: 3.4 })

  // ---- 墓碑阵列：0.8 / 1.2 两档，确定性 RNG 摆，数量显式可调 ----
  // 行距 3.6 / 列距 3.0m：够两个人错身，也够让一排墓碑切碎一条长视线。
  const cols = Math.max(1, Math.ceil(Math.sqrt(tablets * 1.2)))
  let placed = 0
  for (let row = 0; row < 40 && placed < tablets; row++) {
    for (let col = 0; col < cols && placed < tablets; col++) {
      const x = -20 + col * 3.0 + (rnd() - 0.5) * 0.6
      const z = 2 + row * 3.6 + (rnd() - 0.5) * 0.6
      if (x > 17 || z > 21) continue
      if (Math.abs(x) < 1.6) continue // 中央石板路：留一条能跑的通道
      placed++
      const tall = rnd() < 0.5
      const rot = (rnd() - 0.5) * 0.22
      s.span(x, tall ? 0.6 : 0.4, z, tall ? 0.45 : 0.55, tall ? 0.6 : 0.4, 0.16, 'stone', rot)
    }
  }
  // 家族墓台：2.4 × 1.2、0.4m 高，能踩上去争一点高度
  for (let i = 0; i < 4; i++) s.slab(-16 + i * 10, 21.2, 1.2, 0.6, 0, 0.4, 'stone')

  // ---- 祠堂：墓园东侧的小屋，墓园里唯一的室内掩体 ----
  s.slab(16, 8, 3.0, 3.0, 0, 3.2, 'stone')
  s.slab(16, 11.2, 1.6, 0.4, 0, 2.0, 'wood') // 门廊
  s.span(16, 3.6, 8, 3.4, 0.4, 3.4, 'stone') // 平顶

  // ---- 柏树：瘦高的 foliage 柱（树干 0.8m 见方），替墓园挡住高处视线 ----
  const cypress: [number, number][] = [
    [-23.2, -1], [-23.2, 10], [20.8, 26.4], [22.4, -1], [-14, 26.4], [2, 26.4], [-6, 0.2], [10, 26.4],
  ]
  for (const [x, z] of cypress) s.tree(x, z, 5.6, 9.6, 'wood')

  set.list.push(...translate(s.list, ox, oz))
}
