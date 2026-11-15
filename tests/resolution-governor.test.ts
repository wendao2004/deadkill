import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createResolutionState,
  stepResolution,
  type QualityTier,
  type ResolutionAction,
  type ResolutionState,
} from '../client/src/resolution-governor.ts'

/**
 * 动态分辨率治理器是"慢降、稳升、防抖动"的唯一实现。这些用例把冷却、
 * 反抖动封锁、画质降档与上限都跑成几千帧的确定性序列，避免以后调常量
 * 时把某一条滞回悄悄删掉。
 */

const BUDGET = 1000 / 60

function near(actual: number | null, expected: number): void {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < 1e-9,
    `expected ${expected}, got ${String(actual)}`,
  )
}

interface RunOptions {
  minScale: number
  maxScale: number
  autoQuality: boolean
  tier: QualityTier
}

interface Ctx {
  frame: number
  scale: number
}

interface LoggedAction extends ResolutionAction {
  frame: number
}

function run(
  state: ResolutionState,
  ctx: Ctx,
  opts: RunOptions,
  ms: number,
  frames: number,
): LoggedAction[] {
  const out: LoggedAction[] = []
  for (let i = 0; i < frames; i++) {
    const action = stepResolution(state, {
      frameMs: ms,
      frame: ctx.frame,
      scale: ctx.scale,
      minScale: opts.minScale,
      maxScale: opts.maxScale,
      autoQuality: opts.autoQuality,
      tier: opts.tier,
    })
    if (action.scale !== null) ctx.scale = action.scale
    if (action.scale !== null || action.qualityDown) out.push({ ...action, frame: ctx.frame })
    ctx.frame++
  }
  return out
}

const BASE: RunOptions = {
  minScale: 0.65,
  maxScale: 1,
  autoQuality: false,
  tier: 'quality',
}

test('治理器：预热 2 秒内即使一直超时也不降档', () => {
  const state = createResolutionState(0)
  const ctx: Ctx = { frame: 0, scale: 1 }
  const actions = run(state, ctx, BASE, 40, 119)
  assert.deepEqual(actions, [])
  assert.equal(ctx.scale, 1)
})

test('治理器：连续 60 帧明显超标才降 0.1，且冷却期内不连续降', () => {
  const state = createResolutionState(0)
  const ctx: Ctx = { frame: 120, scale: 1 }
  const actions = run(state, ctx, BASE, 30, 200)
  assert.equal(actions.length, 1, '200 帧内只应降一次')
  near(actions[0]!.scale, 0.9)
  assert.equal(actions[0]!.reason, 'slow')
  near(ctx.scale, 0.9)
})

test('治理器：到本档下限仍超标，自动画质才降档；固定画质不降', () => {
  const autoState = createResolutionState(0)
  const autoCtx: Ctx = { frame: 120, scale: 0.65 }
  const autoActions = run(
    autoState,
    autoCtx,
    { ...BASE, minScale: 0.65, maxScale: 0.65, autoQuality: true, tier: 'balanced' },
    30,
    200,
  )
  assert.equal(autoActions.length, 1)
  assert.equal(autoActions[0]!.qualityDown, true)
  assert.equal(autoActions[0]!.scale, null)

  const fixedState = createResolutionState(0)
  const fixedCtx: Ctx = { frame: 120, scale: 0.65 }
  const fixedActions = run(
    fixedState,
    fixedCtx,
    { ...BASE, minScale: 0.65, maxScale: 0.65, autoQuality: false, tier: 'balanced' },
    30,
    200,
  )
  assert.deepEqual(fixedActions, [])
})

test('治理器：连续 5 秒有 headroom 才升 0.05', () => {
  const state = createResolutionState(0)
  const ctx: Ctx = { frame: 120, scale: 0.8 }
  const actions = run(state, ctx, BASE, 8, 400)
  assert.equal(actions.length, 1, '400 帧内应只升一次')
  near(actions[0]!.scale, 0.85)
  assert.equal(actions[0]!.reason, 'stable')
  near(ctx.scale, 0.85)
})

test('治理器：升档后 10 秒冷却内不会立刻再升', () => {
  const state = createResolutionState(0)
  const ctx: Ctx = { frame: 120, scale: 0.8 }
  const first = run(state, ctx, BASE, 8, 500)
  assert.equal(first.length, 1)
  const upFrame = first[0]!.frame
  // 冷却 600 帧 + 稳定 300 帧；只跑 700 帧不应出现第二次。
  const second = run(state, ctx, BASE, 8, 700)
  assert.deepEqual(second, [])
  assert.ok(ctx.frame > upFrame + 600)
})

test('治理器：升完很快又掉 → 封锁 60 秒，期间不再尝试回升', () => {
  const state = createResolutionState(0)
  const ctx: Ctx = { frame: 120, scale: 0.8 }
  const up = run(state, ctx, BASE, 8, 500)
  assert.equal(up.length, 1)
  const upFrame = up[0]!.frame
  // 先等到冷却结束，再持续慢帧直到降档。
  const down = run(state, ctx, BASE, 30, 1200)
  assert.ok(down.some((a) => a.reason === 'slow'), '升后慢帧没有触发降档')
  const downFrame = down.find((a) => a.reason === 'slow')!.frame
  assert.ok(downFrame - upFrame < 1800, '降档应落在 30 秒反抖动窗口内')
  // 封锁期内持续稳定帧：不应出现任何 stable 升档。
  const blocked = run(state, ctx, BASE, 8, 1200)
  assert.equal(blocked.filter((a) => a.reason === 'stable').length, 0)
  // 封锁结束后需要重新攒满 300 帧：再跑 4000 帧应恢复一次升档。
  const recovered = run(state, ctx, BASE, 8, 4000)
  assert.ok(recovered.some((a) => a.reason === 'stable'), '封锁结束后没有恢复升档')
})

test('治理器：已经顶到上限时不再升', () => {
  const state = createResolutionState(0)
  const ctx: Ctx = { frame: 120, scale: 1 }
  const actions = run(state, ctx, { ...BASE, maxScale: 1 }, 8, 500)
  assert.deepEqual(actions, [])
  assert.equal(ctx.scale, 1)
})

test('治理器：平滑帧时间随负载收敛，冷却期不产生动作', () => {
  const state = createResolutionState(0)
  const ctx: Ctx = { frame: 120, scale: 1 }
  run(state, ctx, BASE, 30, 60)
  assert.ok(state.smoothedMs > BUDGET)
  run(state, ctx, BASE, 8, 120)
  assert.ok(state.smoothedMs < BUDGET)
})
