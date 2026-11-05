/**
 * 服务端 tick 顺序的守卫测试。
 *
 * 这九段的先后本身就是玩法契约，不是风格问题：
 * - 怪必须在玩家输入之前动，否则射线永远比怪慢一 tick（"擦边打过去却不命中"）；
 * - 物理必须在**所有**角色提交 next kinematic translation 之后只 step 一次，
 *   每角色各 step 一次会把物理时间乘上玩家数；
 * - 搜索/包扎必须在物理推进之后，否则用上一 tick 的脚底位置判"有没有走开"；
 * - 快照必须在目标状态机推进之后，HUD 才不会永远慢一帧。
 *
 * 以前这个顺序只写在 `step()` 的注释里，改一行调用就可能悄悄换掉它。现在顺序
 * 由 SystemRegistry 的 deps 算出来，这条测试把结果钉住：谁要改，谁先改这里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { initPhysics } from '../shared/src/worldbuild.ts'
import { World } from '../server/src/world.ts'

test('服务端 tick 阶段顺序固定：生命周期 → 怪 → 输入 → 物理 → 交互 → 历史 → 目标 → Boss → 出网', async () => {
  await initPhysics()
  const world = new World({ id: 'phase-order' })
  const internals = world as unknown as { phases: { ordered: { id: string }[] } }

  assert.deepEqual(
    internals.phases.ordered.map((entry) => entry.id),
    [
      'lifecycle',
      'monsters',
      'inputs',
      'physics',
      'interactions',
      'history',
      'match',
      'objective',
      'broadcast',
    ],
  )
})
