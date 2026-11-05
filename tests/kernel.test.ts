import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EventBus,
  FixedClock,
  Kernel,
  Rng,
  SystemRegistry,
  forkFor,
  type FrameTime,
  type KernelContext,
} from '../shared/src/index.ts'

// ---------------------------------------------------------------- 固定时钟

test('时钟：60Hz 下 1 秒恰好 60 步，余量折成 alpha', () => {
  const clock = new FixedClock({ hz: 60 })
  let steps = 0
  for (let i = 0; i < 60; i++) steps += clock.advance(1 / 60)
  assert.equal(steps, 60)
  assert.ok(Math.abs(clock.time.elapsed - 1) < 1e-9)
  assert.ok(clock.time.alpha < 1e-6)
})

test('时钟：不同切分方式跑同样时长，总步数一致', () => {
  for (const chunks of [1, 2, 4, 10, 120]) {
    // 单帧上限放到 2s，才能测"总时长相同、步数相同"；默认 0.1s 是防死亡螺旋的。
    const clock = new FixedClock({ hz: 60, maxFrameDt: 2, maxSubsteps: 120 })
    let steps = 0
    for (let i = 0; i < chunks; i++) steps += clock.advance(1 / chunks)
    // 浮点余量允许差一步：最后一块可能落在边界前后。
    assert.ok(Math.abs(steps - 60) <= 1, `${chunks} 块得到 ${steps} 步`)
  }
})

test('时钟：单帧超时与最大补步数都会丢弃积压，不进入死亡螺旋', () => {
  const clock = new FixedClock({ hz: 60, maxFrameDt: 0.1, maxSubsteps: 8 })
  const steps = clock.advance(5)
  assert.equal(steps, 6, '0.1s 的夹紧只应产生 6 步')
  assert.equal(clock.pending, 0)

  const spiral = new FixedClock({ hz: 60, maxFrameDt: 1, maxSubsteps: 3 })
  assert.equal(spiral.advance(1), 3)
  assert.equal(spiral.pending, 0, '达到上限后必须丢弃积压')
  assert.equal(spiral.time.alpha, 0)
})

test('时钟：暂停时 dt 为 0，但帧号仍然推进', () => {
  const clock = new FixedClock({ hz: 60 })
  clock.setScale(0)
  assert.equal(clock.advance(0.05), 0)
  assert.equal(clock.time.frame, 1)
  assert.equal(clock.time.dt, 0)
  clock.setScale(1)
  assert.equal(clock.advance(1 / 60), 1)
})

// ---------------------------------------------------------------- 注册表

test('注册表：按 deps 拓扑排序，与注册顺序无关', () => {
  const registry = new SystemRegistry<Record<string, never>>()
  const calls: string[] = []
  registry.add('ui', { init: () => calls.push('ui') }, ['render'])
  registry.add('render', { init: () => calls.push('render') }, ['physics'])
  registry.add('physics', { init: () => calls.push('physics') })
  const order = registry.resolve().map((e) => e.id)
  assert.deepEqual(order, ['physics', 'render', 'ui'])
})

test('注册表：重复 id、缺失依赖、循环依赖都在启动时抛错', () => {
  const r = new SystemRegistry<Record<string, never>>()
  r.add('a', {})
  assert.throws(() => r.add('a', {}), /duplicate/)

  const missing = new SystemRegistry<Record<string, never>>()
  missing.add('a', {}, ['nope'])
  assert.throws(() => missing.resolve(), /unregistered/)

  const cycle = new SystemRegistry<Record<string, never>>()
  cycle.add('a', {}, ['b'])
  cycle.add('b', {}, ['a'])
  assert.throws(() => cycle.resolve(), /cycle/)
})

test('注册表：with() 只返回实现了该方法的系统并缓存', () => {
  const r = new SystemRegistry<Record<string, never>>()
  r.add('a', { update: () => {} })
  r.add('b', {})
  r.add('c', { update: () => {} }, ['b'])
  const updates = r.with('update').map((e) => e.id)
  assert.deepEqual(updates, ['a', 'c'])
  assert.equal(r.with('update'), r.with('update'), 'with() 必须返回缓存的同一个数组')
  assert.deepEqual(r.with('dispose'), [])
})

// ---------------------------------------------------------------- 事件

test('事件：退订、一次性订阅、派发期间退订都安全', () => {
  const bus = new EventBus<{ ping: number; pong: string }>()
  const seen: number[] = []
  const off = bus.on('ping', (n) => {
    seen.push(n)
    if (n === 2) off()
  })
  bus.emit('ping', 1)
  bus.emit('ping', 2)
  bus.emit('ping', 3)
  assert.deepEqual(seen, [1, 2])

  const once: string[] = []
  bus.once('pong', (s) => once.push(s))
  bus.emit('pong', 'a')
  bus.emit('pong', 'b')
  assert.deepEqual(once, ['a'])
})

test('事件：单个 handler 抛错不阻断其它 handler', () => {
  const bus = new EventBus<{ x: number }>()
  const seen: number[] = []
  const originalError = console.error
  console.error = () => {}
  try {
    bus.on('x', () => {
      throw new Error('boom')
    })
    bus.on('x', (n) => seen.push(n))
    bus.emit('x', 7)
  } finally {
    console.error = originalError
  }
  assert.deepEqual(seen, [7])
})

// ---------------------------------------------------------------- 随机数

test('RNG：同种子逐位复现，不同种子不同', () => {
  const a = new Rng(0x12345678)
  const b = new Rng(0x12345678)
  const c = new Rng(0x12345679)
  const seqA = Array.from({ length: 16 }, () => a.u32())
  const seqB = Array.from({ length: 16 }, () => b.u32())
  const seqC = Array.from({ length: 16 }, () => c.u32())
  assert.deepEqual(seqA, seqB)
  assert.notDeepEqual(seqA, seqC)
})

test('RNG：fork 出的流互不扰动，状态恢复后继续同一条序列', () => {
  const root = new Rng(7)
  const child = root.fork()
  const rootFirst = root.u32()
  const childFirst = child.u32()
  assert.equal(typeof rootFirst, 'number')
  assert.equal(typeof childFirst, 'number')

  const replay = new Rng(7)
  const state = replay.state()
  const want = Array.from({ length: 8 }, () => replay.u32())
  replay.restore(state)
  const got = Array.from({ length: 8 }, () => replay.u32())
  assert.deepEqual(got, want)
})

test('RNG：范围与圆盘都在约定区间内', () => {
  const rng = new Rng(99)
  for (let i = 0; i < 500; i++) {
    const f = rng.float()
    assert.ok(f >= 0 && f < 1)
    const n = rng.int(-3, 3)
    assert.ok(n >= -3 && n <= 3)
    const d = rng.disc()
    assert.ok(d.x * d.x + d.y * d.y <= 1 + 1e-9)
  }
  assert.throws(() => rng.pick([]), /empty/)
})

// ---------------------------------------------------------------- 内核

test('内核：init 按拓扑序，fixed/update/late/render 顺序固定，dispose 逆序', async () => {
  const events = new EventBus<{ resize: { width: number; height: number } }>()
  const clock = new FixedClock({ hz: 60 })
  const ctx: KernelContext & { events: typeof events } = { events, time: clock.time }
  const kernel = new Kernel<typeof ctx>({ hz: 60 })
  const calls: string[] = []

  kernel.add('render', {
    init: () => calls.push('init:render'),
    update: () => calls.push('update:render'),
    render: () => calls.push('render'),
    dispose: () => calls.push('dispose:render'),
  })
  kernel.add(
    'sim',
    {
      init: () => calls.push('init:sim'),
      fixedUpdate: () => calls.push('fixed'),
      lateUpdate: () => calls.push('late'),
      resize: (w, h) => calls.push(`resize:${w}x${h}`),
      dispose: () => calls.push('dispose:sim'),
    },
    ['render'],
  )

  await kernel.init(ctx)
  const steps = kernel.advance(ctx, 1 / 60)
  assert.equal(steps, 1)
  assert.deepEqual(calls, [
    'init:render',
    'init:sim',
    'fixed',
    'update:render',
    'late',
    'render',
  ])

  kernel.resize(1280, 720, ctx)
  assert.ok(calls.includes('resize:1280x720'))
  kernel.dispose(ctx)
  assert.deepEqual(calls.slice(-2), ['dispose:sim', 'dispose:render'])
})

test('内核：上下文必须使用 kernel.clock.time，否则固定步推进的是另一只时钟', async () => {
  const events = new EventBus<{ resize: { width: number; height: number } }>()
  const kernel = new Kernel<{ events: typeof events; time: FrameTime }>({ hz: 60 })
  await kernel.init({ events, time: kernel.clock.time })
  assert.equal(kernel.clock.time, kernel.clock.time)
  assert.equal(kernel.clock.time.fixed, 1 / 60)
})

test('内核随机：forkFor 只取决于 (种子, 标签)，与派生顺序无关', () => {
  const seed = 0xdeadbeef
  const initial = forkFor(seed, 'spawn').state()

  // 先派生别的系统、消耗掉一堆随机数，spawn 这条流必须一点没变 ——
  // 这就是"加一个粒子系统不会让 AI 换个走法"的技术保证。
  const other = forkFor(seed, 'fx')
  for (let i = 0; i < 32; i++) other.float()
  assert.deepEqual(forkFor(seed, 'spawn').state(), initial)

  // 同一 (种子, 标签) 派生两次，头三个数必须逐个相同。
  const a = forkFor(seed, 'spawn')
  const b = forkFor(seed, 'spawn')
  assert.deepEqual(a.state(), b.state())
  for (let i = 0; i < 3; i++) assert.equal(a.float(), b.float())

  // 不同标签、不同种子必须分到不同的流，否则等于共用一条。
  assert.notEqual(forkFor(seed, 'spawn').u32(), forkFor(seed, 'ai').u32())
  assert.notEqual(forkFor(seed, 'spawn').state()[0], forkFor(seed + 1, 'spawn').state()[0])
})
