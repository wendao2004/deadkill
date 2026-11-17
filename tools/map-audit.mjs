#!/usr/bin/env node
/**
 * 地图审计：把"看不见的墙 / 穿得过去的墙 / 叠在一起的房子"变成可数的清单。
 *
 * 关卡是盒刷（`shared/src/level.ts`）：客户端画 `noRender !== true` 的，
 * 服务端给 `noCollide !== true` 的建碰撞体。两边一旦对不上，玩家就会撞到
 * 一堵没画出来的墙，或者走进一根本该挡路的柱子。
 *
 * 这里不靠截图，直接读同一份数据做静态检查：
 *
 * - `hidden-solid`  只碰不画（noRender 且参与碰撞）→ 潜在空气墙
 * - `ghost-solid`   画了但不碰（noCollide）→ 看得见走得过去
 * - `buried`        整个沉在地下 → 白建
 * - `floating`      悬空 >0.5m → 摆放不合理（吊脚楼请显式加桩）
 * - `overlap`       两个实体盒大面积重叠 → 建筑穿模
 * - `spawn-blocked` 出生点 2m 内有实体盒 → 一出生就贴脸
 *
 * 用法：`node tools/map-audit.mjs [--out docs/地图问题清单.md]`
 * 退出码：0 = 跑完（有问题也返回 0，这是清单不是门禁）；2 = 环境错误。
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { LEVELS } from '../shared/src/level.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outFlag = process.argv.indexOf('--out')
const outPath = outFlag === -1 ? join(here, '..', 'docs', '地图问题清单.md') : process.argv[outFlag + 1]

/** 两个盒在 XZ 平面的重叠面积占较小者的比例。只处理 rotY≈0 的盒。 */
function overlapRatio(a, b) {
  if (Math.abs(a.rotY ?? 0) > 1e-3 || Math.abs(b.rotY ?? 0) > 1e-3) return 0
  const ox = Math.min(a.x + a.hx, b.x + b.hx) - Math.max(a.x - a.hx, b.x - b.hx)
  const oz = Math.min(a.z + a.hz, b.z + b.hz) - Math.max(a.z - a.hz, b.z - b.hz)
  if (ox <= 0 || oz <= 0) return 0
  const oy = Math.min(a.y + a.hy, b.y + b.hy) - Math.max(a.y - a.hy, b.y - b.hy)
  if (oy <= 0.02) return 0
  const small = Math.min(a.hx * a.hz, b.hx * b.hz) * 4
  return (ox * oz) / small
}

function auditLevel(id, level) {
  const groundY = level.groundY ?? 0
  const solid = level.boxes.filter((b) => b.noCollide !== true)
  const hidden = solid.filter((b) => b.noRender === true)
  // 装饰性的可穿过件（草叶、树冠、横梁、窗框）是设计，不是问题。
  // 只报"像墙一样大、却穿得过去"的：高度 ≥1m、厚度 ≥15cm。
  const wallLike = (b) => b.hy >= 1.0 && Math.min(b.hx, b.hz) >= 0.15
  const ghost = level.boxes.filter((b) => b.noCollide === true && b.noRender !== true && wallLike(b))
  const buried = level.boxes.filter((b) => b.y + b.hy < groundY - 0.3)
  // 悬空同样只报"能站人的大件"：薄板/椽子天然离地。
  const floating = level.boxes.filter(
    (b) => b.noRender !== true && b.hy >= 0.3 && b.y - b.hy > groundY + 1.0 && b.material !== 'foliage',
  )

  const allOverlaps = []
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const ratio = overlapRatio(solid[i], solid[j])
      if (ratio > 0.6) allOverlaps.push({ a: solid[i], b: solid[j], ratio })
    }
  }

  // hero 锚点必须落在某个 noRender 骨架附近，否则"模型在这、碰撞在别处"。
  const heroOrphans = []
  for (const hero of level.heroes ?? []) {
    const near = level.boxes.some(
      (b) => b.noRender === true && Math.hypot(b.x - hero.x, b.z - hero.z) < 5.5,
    )
    if (!near) heroOrphans.push(hero)
  }

  const spawnBlocked = []
  for (const spawn of level.spawns) {
    for (const b of solid) {
      const d = Math.hypot(b.x - spawn.x, b.z - spawn.z)
      if (d < 2.0) spawnBlocked.push({ spawn, box: b, d })
    }
  }

  return {
    id,
    name: level.name ?? id,
    total: level.boxes.length,
    solid: solid.length,
    hidden,
    ghost,
    buried,
    floating,
    overlapCount: allOverlaps.length,
    overlaps: allOverlaps.sort((x, y) => y.ratio - x.ratio).slice(0, 12),
    spawnBlocked,
    heroOrphans,
  }
}

/** 一个盒子的可读描述，清单里每条都能直接回到源码改。 */
function fmt(b) {
  const rot = Math.abs(b.rotY ?? 0) > 1e-3 ? ` rotY=${(b.rotY * 180 / Math.PI).toFixed(0)}°` : ''
  return `(${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)}) 半长(${b.hx}, ${b.hy}, ${b.hz}) ${b.material ?? 'wood'}${rot}`
}

const results = Object.entries(LEVELS).map(([id, level]) => auditLevel(id, level))

const lines = []
lines.push('# 地图问题清单')
lines.push('')
lines.push('> 由 `pnpm qa:maps` 生成（`tools/map-audit.mjs`）。**不要手改**：改关卡数据后重跑。')
lines.push('> 判定规则见脚本头部注释；`?colliders=1` 的线框叠图用来人工复核。')
lines.push('')
lines.push('| 地图 | 盒刷 | 实体 | 只碰不画 | 画了不碰 | 埋地 | 悬空 | 重叠 | hero 脱节 | 出生点贴脸 |')
lines.push('|---|---|---|---|---|---|---|---|---|')
for (const r of results) {
  lines.push(
    `| ${r.name} | ${r.total} | ${r.solid} | ${r.hidden.length} | ${r.ghost.length} | ` +
      `${r.buried.length} | ${r.floating.length} | ${r.overlapCount} | ${r.heroOrphans.length} | ${r.spawnBlocked.length} |`,
  )
}
lines.push('')

for (const r of results) {
  const issues =
    r.hidden.length + r.ghost.length + r.buried.length + r.floating.length + r.overlapCount +
    r.heroOrphans.length + r.spawnBlocked.length
  if (issues === 0) {
    lines.push(`## ${r.name} — 干净`)
    lines.push('')
    continue
  }
  lines.push(`## ${r.name} — ${issues} 条`)
  lines.push('')
  if (r.hidden.length > 0) {
    lines.push('### 只碰不画（潜在空气墙）')
    lines.push('')
    lines.push('隐形骨架本身是设计（给 GLB/程序化建筑当碰撞）。判断标准是：它圈出来的范围内**有没有可见模型**。')
    lines.push('')
    for (const b of r.hidden.slice(0, 40)) lines.push(`- ${fmt(b)}`)
    if (r.hidden.length > 40) lines.push(`- …另有 ${r.hidden.length - 40} 条`)
    lines.push('')
  }
  if (r.ghost.length > 0) {
    lines.push('### 画了不碰（能穿过去）')
    lines.push('')
    for (const b of r.ghost.slice(0, 40)) lines.push(`- ${fmt(b)}`)
    if (r.ghost.length > 40) lines.push(`- …另有 ${r.ghost.length - 40} 条，见脚本输出`)
    lines.push('')
  }
  if (r.heroOrphans.length > 0) {
    lines.push('### hero 锚点附近没有隐形骨架（模型与碰撞脱节）')
    lines.push('')
    for (const h of r.heroOrphans) lines.push(`- ${h.asset} @ (${h.x.toFixed(1)}, ${h.z.toFixed(1)})`)
    lines.push('')
  }
  if (r.spawnBlocked.length > 0) {
    lines.push('### 出生点 2m 内有实体盒')
    lines.push('')
    for (const s of r.spawnBlocked) {
      lines.push(`- 出生点 (${s.spawn.x.toFixed(1)}, ${s.spawn.z.toFixed(1)}) ↔ ${fmt(s.box)} 距离 ${s.d.toFixed(2)}m`)
    }
    lines.push('')
  }
  if (r.buried.length > 0) {
    lines.push('### 整个埋在地下')
    lines.push('')
    for (const b of r.buried) lines.push(`- ${fmt(b)}`)
    lines.push('')
  }
  if (r.floating.length > 0) {
    lines.push('### 悬空 >0.5m')
    lines.push('')
    for (const b of r.floating) lines.push(`- ${fmt(b)}`)
    lines.push('')
  }
  if (r.overlapCount > 0) {
    lines.push('### 大面积重叠（建筑穿模）')
    lines.push('')
    for (const o of r.overlaps) {
      lines.push(`- ${(o.ratio * 100).toFixed(0)}%  ${fmt(o.a)}`)
      lines.push(`  ↔ ${fmt(o.b)}`)
    }
    lines.push('')
  }
}

const totalIssues = results.reduce(
  (sum, r) =>
    sum + r.hidden.length + r.ghost.length + r.buried.length + r.floating.length + r.overlapCount +
    r.heroOrphans.length + r.spawnBlocked.length,
  0,
)
lines.push('---')
lines.push('')
lines.push(`合计 ${totalIssues} 条。修完重跑本脚本，数字必须下降；新增数字必须在 PR 里说明理由。`)

try {
  writeFileSync(outPath, lines.join('\n'), 'utf8')
} catch (error) {
  console.error(`map-audit: 写不了 ${outPath}: ${error.message}`)
  process.exit(2)
}

console.log(`map-audit: ${outPath}`)
for (const r of results) {
  console.log(
    `  ${r.name}: hidden=${r.hidden.length} ghost=${r.ghost.length} buried=${r.buried.length} ` +
      `floating=${r.floating.length} overlap=${r.overlapCount} heroOrphan=${r.heroOrphans.length} spawn=${r.spawnBlocked.length}`,
  )
}
