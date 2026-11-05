/**
 * 荒野断点：把"空地里的低矮障碍"撒到一张已经建好的图上。
 *
 * 为什么必须在关卡定义**之后**执行：只有这时才知道所有区域与标记点的位置，
 * 障碍物才不会长在出生点、线索点或撤离点上面（那种 bug 在测试里表现为
 * "人在方块里面出生"，很难从坐标上肉眼发现）。
 *
 * 这份数据同样是纯函数：同一个 seed + 同一份关卡 = 同一批障碍物，
 * 客户端与服务端各自 import 一次得到的是同一张图。
 */
import type { LevelDef } from '../level.ts'
import { BrushSet, scatterCover } from './kit.ts'

export function applyCover(
  level: LevelDef,
  opts: { spacing?: number; material?: 'wood' | 'stone' | 'mud' | 'metal' | 'foliage'; seed?: number; pad?: number } = {},
): number {
  const pad = opts.pad ?? 4
  const spots = [
    ...(level.zones ?? []).map((z) => ({ x: z.x, z: z.z, r: z.radius + 2 })),
    ...level.spawns.map((p) => ({ x: p.x, z: p.z, r: pad })),
    ...(level.nests ?? []).map((p) => ({ x: p.x, z: p.z, r: pad })),
    ...(level.clues ?? []).map((p) => ({ x: p.x, z: p.z, r: pad })),
    ...(level.extracts ?? []).map((p) => ({ x: p.x, z: p.z, r: pad })),
  ]
  const set = new BrushSet()
  const n = scatterCover(set, level.boundsHalf, {
    spacing: opts.spacing ?? 34,
    avoid: spots,
    material: opts.material ?? 'mud',
    seed: opts.seed ?? 0x51de,
  })
  level.boxes.push(...set.list)
  return n
}
