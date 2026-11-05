import test from 'node:test'
import assert from 'node:assert/strict'

// 和其余测试一样走 index 桶文件：根 node_modules 里没有 @dk/* 的 workspace
// 链接，所以只能相对引用，不能写 '@dk/shared'。
import {
  AGGRO_WINDUP_MS,
  HOME_ARRIVE_RADIUS,
  MONSTER_SPECS,
  REPOSITION_SPEED_FACTOR,
  TICK_MS,
  damageMonster,
  monsterAtPosition,
  monsterHurtbox,
  mulberry32,
  spawnMonster,
  stepMonster,
  isBossKind,
  monsterKindFromCode,
  bossNameOf,
  LEVELS,
} from '../shared/src/index.ts'
import type { Monster, MonsterSenses } from '../shared/src/index.ts'

// ---------------------------------------------------------------- 夹具

/** 巢穴原点。所有用例都从"怪物站在自己家"开始，避免落入回家分支。 */
const HOME = { x: 0, y: 0, z: 0 }

function standingStill(id: number, x: number, z: number): MonsterSenses {
  return { id, x, z, alive: true }
}

/**
 * stepMonster 只写**期望速度**，位移由调用方积分（服务端交给 Rapier）。
 * 测试里用最朴素的显式欧拉积分代替物理引擎，这样轨迹完全可复现。
 */
function integrate(monster: Monster): void {
  monster.x += monster.vx * (TICK_MS / 1000)
  monster.z += monster.vz * (TICK_MS / 1000)
}

function homeDistance(monster: Monster): number {
  return Math.hypot(monster.x - monster.homeX, monster.z - monster.homeZ)
}

/**
 * 愣神窗口换算成 tick 数。AGGRO_WINDUP_MS 是毫秒阈值，而 aggroMs 每 tick
 * 累加 TICK_MS（浮点），所以判据是"累加到 >= 350 至少要多少个 tick"。
 */
const WINDUP_TICKS = Math.ceil(AGGRO_WINDUP_MS / TICK_MS)

// ---------------------------------------------------------------- 索敌与愣神

test('grunt 从 12 米外走进 attack，且在愣神走满之前一口都不咬', () => {
  const spec = MONSTER_SPECS.grunt
  assert.equal(AGGRO_WINDUP_MS, 350)
  assert.equal(WINDUP_TICKS, 21)

  const monster = monsterAtPosition('grunt', HOME, 1)
  const rng = mulberry32(7)
  const player = standingStill(7, 0, 12)

  let aggroTick = -1
  let attackTick = -1
  let chaseTick = -1
  const hitTicks: number[] = []
  let aggroMsAtFirstHit = -1
  let hitsBeforeWindup = 0

  for (let tick = 1; tick <= 400; tick++) {
    const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
    if (aggroTick < 0 && monster.targetId !== 0) aggroTick = tick
    if (chaseTick < 0 && monster.state === 'chase') chaseTick = tick
    if (attackTick < 0 && monster.state === 'attack') attackTick = tick

    if (result.hit) {
      // 用**决策当时**的 aggroMs 判断前摇，而不是事后回看状态机 ——
      // 状态一进 attack 就算"在攻击"，但伤害必须等愣神走完。
      if (monster.aggroMs < AGGRO_WINDUP_MS) hitsBeforeWindup++
      assert.equal(result.hit.playerId, 7, '咬的必须是当前目标')
      assert.equal(result.hit.damage, spec.attackDamage, '伤害必须等于 spec.attackDamage')
      if (hitTicks.length === 0) aggroMsAtFirstHit = monster.aggroMs
      hitTicks.push(tick)
    }
    assert.equal(result.aggroed, tick === aggroTick, 'aggroed 只在锁定的那一 tick 为 true')
    integrate(monster)
  }

  // 12 米 < aggroRange(16)，所以第 1 tick 就该锁定并开始追。
  assert.equal(aggroTick, 1)
  assert.equal(chaseTick, 1, '够不着的时候必须是 chase')
  assert.ok(attackTick > chaseTick, '必须先追到攻击距离内才进 attack，attackTick=' + attackTick)
  assert.ok(hitTicks.length >= 4, '400 tick 内至少要咬到 4 口，实际 ' + hitTicks.length)

  // 核心断言：愣神窗口内零伤害。
  assert.equal(hitsBeforeWindup, 0, '愣神窗口内出现了伤害，位置 ' + String(hitTicks))
  assert.ok(aggroMsAtFirstHit >= AGGRO_WINDUP_MS, '首口伤害时 aggroMs=' + aggroMsAtFirstHit)
  // 与 aggroMs 无关的独立判据：从锁定到第一口之间的 tick 数不少于愣神窗口。
  assert.ok(
    hitTicks[0]! - aggroTick + 1 >= WINDUP_TICKS,
    '首口在第 ' + hitTicks[0] + ' tick，锁定在第 ' + aggroTick + ' tick，不足 ' + WINDUP_TICKS + ' tick',
  )
  assert.ok(hitTicks[0]! >= attackTick, '进 attack 之前不可能有伤害')
})

test('攻击冷却：两口伤害之间的间隔不小于 ceil(attackIntervalMs / TICK_MS) 个 tick', () => {
  for (const kind of ['grunt', 'hound'] as const) {
    const spec = MONSTER_SPECS[kind]
    const expected = Math.ceil(spec.attackIntervalMs / TICK_MS)
    assert.ok(expected > 1, kind + ' 的冷却换算异常: ' + expected)

    const monster = monsterAtPosition(kind, HOME, 1)
    const rng = mulberry32(3)
    const player = standingStill(7, 0, 12)

    const hitTicks: number[] = []
    for (let tick = 1; tick <= 600; tick++) {
      const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
      if (result.hit) hitTicks.push(tick)
      integrate(monster)
    }

    assert.ok(hitTicks.length >= 4, kind + ': 需要至少 4 口才能看间隔，实际 ' + hitTicks.length)
    const gaps = hitTicks.slice(1).map((t, i) => t - hitTicks[i]!)
    for (const gap of gaps) {
      assert.ok(
        gap >= expected,
        kind + ': 冷却被吃掉了，间隔 ' + gap + ' tick < ' + expected + ' tick（全部间隔 ' + String(gaps) + '）',
      )
    }
    // 节拍均匀：冷却不该忽长忽短（那是"漏算 tick"的另一种表现）。
    assert.equal(Math.max(...gaps), Math.min(...gaps), kind + ': 攻击节拍不均匀，间隔 ' + String(gaps))
  }
})

test('贴脸（0 距离）的玩家同样要等满愣神窗口才挨第一口', () => {
  for (const kind of ['grunt', 'hound'] as const) {
    const spec = MONSTER_SPECS[kind]
    // 玩家和怪物站在完全相同的水平坐标上：距离 0，一 tick 就到攻击距离内。
    const monster = monsterAtPosition(kind, HOME, 1)
    const rng = mulberry32(1)
    const player = standingStill(7, 0, 0)

    const hitTicks: number[] = []
    for (let tick = 1; tick <= 60; tick++) {
      const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
      if (result.hit) {
        assert.equal(result.hit.damage, spec.attackDamage)
        hitTicks.push(tick)
      }
      // 愣神窗口内一律不许有伤害，哪怕状态早就是 attack。注意只能对
      // tick < WINDUP_TICKS 断言"空手"：之后的空手属于正常冷却间隔。
      if (tick < WINDUP_TICKS) {
        assert.equal(result.hit, null, kind + ': 第 ' + tick + ' tick 就咬人了，愣神窗口没走完')
      }
      assert.equal(monster.state, 'attack', kind + ': 贴脸时应当直接是 attack（没有位移的必要）')
      integrate(monster)
    }

    // 首口必须恰好落在第 21 tick：20 * TICK_MS = 333.33 < 350，21 * TICK_MS = 350。
    assert.equal(hitTicks[0], WINDUP_TICKS, kind + ': 首口应当落在第 ' + WINDUP_TICKS + ' tick')
    assert.equal(hitTicks[0], 21)
    // 贴脸时不该有任何位移：goalSpeed 为 0，速度必须被清干净。
    assert.equal(monster.vx, 0)
    assert.equal(monster.vz, 0)
  }
})

// ---------------------------------------------------------------- 脱战与回家

test('玩家跑出牵引绳范围后立刻脱战（targetId 归零）并走回巢穴', () => {
  const monster = monsterAtPosition('grunt', HOME, 1)
  const rng = mulberry32(11)

  // 先在 12 米外勾住它，让它追出来一段。
  const bait = standingStill(7, 0, 12)
  for (let tick = 1; tick <= 120; tick++) {
    stepMonster(monster, { players: [bait], tick, dtMs: TICK_MS }, rng)
    integrate(monster)
  }
  assert.equal(monster.targetId, 7, '前置条件：怪物应当已经锁定目标')
  assert.ok(homeDistance(monster) > HOME_ARRIVE_RADIUS * 3, '前置条件：怪物应当已经离开巢穴')

  // 玩家被"传送"到 500 米外：超出 leashRange(26)，等同于跟丢。
  const far = standingStill(7, 0, -500)
  let dropTick = -1
  let arriveTick = -1
  let maxDistanceAfterArrive = 0

  for (let tick = 121; tick <= 3000; tick++) {
    const result = stepMonster(monster, { players: [far], tick, dtMs: TICK_MS }, rng)
    assert.equal(result.hit, null, '脱战途中不该再咬到任何人')
    assert.equal(result.attacked, false)

    if (dropTick < 0 && monster.targetId === 0 && monster.state === 'idle') dropTick = tick
    const distance = homeDistance(monster)
    if (arriveTick < 0 && distance <= HOME_ARRIVE_RADIUS) arriveTick = tick
    if (arriveTick > 0) maxDistanceAfterArrive = Math.max(maxDistanceAfterArrive, distance)
    integrate(monster)
  }

  // 目标一消失的下一 tick 就该脱战，不能带着 targetId 继续追。
  assert.equal(dropTick, 121, '脱战发生得太晚，dropTick=' + dropTick)
  assert.equal(monster.targetId, 0)
  assert.equal(monster.state, 'idle')
  assert.ok(arriveTick > 0, '3000 tick 内没走回巢穴')

  // 到家后会原地游荡（rng 驱动的缓慢漂移），所以判据是"回到
  // HOME_ARRIVE_RADIUS 附近并从此不再跑远"，而不是每一 tick 都严格 <= 半径。
  // 实测 10 个种子里的最大漂移是 1.2083（HOME_ARRIVE_RADIUS * 1.007），
  // 留 5% 余量。超出半径时 returningHome 会再次把它拉回来，是设计内行为。
  assert.ok(
    maxDistanceAfterArrive <= HOME_ARRIVE_RADIUS * 1.05,
    '到家后游荡跑太远: ' + maxDistanceAfterArrive + ' > ' + HOME_ARRIVE_RADIUS * 1.05,
  )
  assert.ok(homeDistance(monster) <= HOME_ARRIVE_RADIUS * 1.05, '结束时应当仍在巢穴附近')

  // 速度上限这条铁律：回家速度还要乘 RETURN_SPEED_FACTOR(0.55)，更不可能超速。
  assert.ok(Math.hypot(monster.vx, monster.vz) <= MONSTER_SPECS.grunt.speed + 1e-9)
})

test('被搬到离巢穴超过牵引绳距离的怪物不索敌，只顾着往家走', () => {
  // 这是 leash 的另一半语义：homeDist > leashRange 那个分支在选目标之前
  // 就把 targetId 清掉，所以哪怕玩家贴着它站，它也当没看见。
  const spec = MONSTER_SPECS.grunt
  const base = monsterAtPosition('grunt', HOME, 1)
  const monster: Monster = { ...base, x: 30, z: 0 } // 30 > leashRange(26)
  const rng = mulberry32(5)
  const player = standingStill(7, 30.5, 0) // 0.5 米，远在 attackRange 之内

  let anyHit = false
  let anyTarget = false
  const startDistance = homeDistance(monster)
  for (let tick = 1; tick <= 1200; tick++) {
    const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
    if (result.hit || result.attacked) anyHit = true
    if (monster.targetId !== 0) anyTarget = true
    assert.equal(monster.state, 'idle')
    integrate(monster)
  }

  assert.equal(anyHit, false, '牵引绳拉满时不许咬人')
  assert.equal(anyTarget, false, '牵引绳拉满时不许锁定目标')
  assert.ok(startDistance > spec.leashRange)
  assert.ok(homeDistance(monster) < HOME_ARRIVE_RADIUS * 1.05, '最终应当回到巢穴')
  assert.ok(Math.hypot(monster.vx, monster.vz) <= spec.speed + 1e-9)
})

// ---------------------------------------------------------------- 伤害与死亡

test('damageMonster：血还剩下时返回 false，正好打死时返回 true，并清空速度', () => {
  const spec = MONSTER_SPECS.grunt
  const monster = monsterAtPosition('grunt', HOME, 1)
  assert.equal(monster.health, spec.maxHealth)

  // 120 血 -> 50 -> 70，还活着
  assert.equal(damageMonster(monster, 50, 10), false)
  assert.equal(monster.health, 70)
  assert.equal(monster.state, 'idle')

  // 70 -> 1，只剩 1 血依旧是 false（不是"命中即死"）
  assert.equal(damageMonster(monster, 69, 11), false)
  assert.equal(monster.health, 1)
  assert.equal(monster.state, 'idle')

  // 1 -> 0：这一刀才算击杀
  monster.vx = 3
  monster.vz = -4
  assert.equal(damageMonster(monster, 1, 12), true)
  assert.equal(monster.health, 0)
  assert.equal(monster.state, 'dead')
  assert.equal(monster.vx, 0, '尸体不许保留速度')
  assert.equal(monster.vz, 0)
  assert.equal(monster.targetId, 0)
  assert.equal(monster.aggroMs, 0)
  // 冷却结算到"现在"，将来接复活机制时尸体站起来也不会白打一记。
  assert.equal(monster.nextAttackTick, 12)

  // 重复击杀必须是 false，不能重复触发死亡事件/掉落。
  assert.equal(damageMonster(monster, 1000, 13), false)
  assert.equal(monster.health, 0)
})

test('damageMonster：负伤害不会变成回血后门', () => {
  const monster = monsterAtPosition('grunt', HOME, 1)
  const before = monster.health
  const killed = damageMonster(monster, -50, 5)
  assert.equal(killed, false, '负伤害不可能致死')
  assert.equal(monster.health, before, '负伤害不许回血')
})

test('damageMonster：一刀正好打满血量就是击杀（含 hound 的 70 血）', () => {
  for (const kind of ['grunt', 'hound'] as const) {
    const spec = MONSTER_SPECS[kind]
    const monster = monsterAtPosition(kind, HOME, 1)
    assert.equal(damageMonster(monster, spec.maxHealth, 99), true, kind + ' 应当被满血伤害打死')
    assert.equal(monster.health, 0)
    assert.equal(monster.state, 'dead')
  }
  // 差 1 点血就不算死，边界不能差一。
  const survivor = monsterAtPosition('grunt', HOME, 1)
  assert.equal(damageMonster(survivor, MONSTER_SPECS.grunt.maxHealth - 1, 99), false)
  assert.equal(survivor.health, 1)
  assert.equal(survivor.state, 'idle')
})

test('死掉的怪物永远不再理会玩家（不咬、不锁、不动）', () => {
  const monster = monsterAtPosition('grunt', HOME, 1)
  assert.equal(damageMonster(monster, 1000, 50), true)
  const deadAt = { x: monster.x, y: monster.y, z: monster.z }

  const rng = mulberry32(1)
  const player = standingStill(7, 0, 0) // 贴脸站着
  for (let tick = 51; tick <= 400; tick++) {
    const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
    assert.equal(result.hit, null, '尸体咬了人，tick=' + tick)
    assert.equal(result.attacked, false)
    assert.equal(result.aggroed, false)
    assert.equal(monster.targetId, 0)
    assert.equal(monster.state, 'dead')
    assert.equal(monster.health, 0)
    assert.equal(monster.vx, 0)
    assert.equal(monster.vz, 0)
    integrate(monster)
  }

  // 死亡短路在函数最前面：位置一次都不许被这个分支写。
  assert.equal(monster.x, deadAt.x)
  assert.equal(monster.y, deadAt.y)
  assert.equal(monster.z, deadAt.z)
  // 死怪物再挨枪仍然是 false（不重复触发死亡事件）。
  assert.equal(damageMonster(monster, 10, 401), false)
})

// ---------------------------------------------------------------- 受击胶囊

test('monsterHurtbox：y = 脚底 + halfHeight + radius，总高恒等于 spec.height', () => {
  for (const kind of ['grunt', 'hound'] as const) {
    const spec = MONSTER_SPECS[kind]
    const monster = monsterAtPosition(kind, { x: 1, y: 2, z: 3 }, 1)
    const box = monsterHurtbox(monster)

    // 半径/半高全部由 spec 推导，不允许有第二套尺寸。
    assert.equal(box.radius, spec.radius, kind + ': radius 必须取自 spec')
    assert.equal(box.halfHeight, Math.max(0, spec.height / 2 - spec.radius), kind + ': halfHeight 必须由 spec 推导')
    // 胶囊总高 = 圆柱段 + 两个半球。
    assert.equal(box.halfHeight * 2 + box.radius * 2, spec.height, kind + ': 胶囊总高必须等于 spec.height')

    // y 是胶囊**中心**高度，约定与人物一致（脚底 + halfHeight + radius）。
    // 这条等式必须按位成立，否则 Rapier 的 collider 和模型会错开。
    assert.equal(box.y, monster.y + box.halfHeight + box.radius, kind + ': y 必须是脚底 + halfHeight + radius')
    assert.equal(box.x, monster.x)
    assert.equal(box.z, monster.z)

    // 具体数值也钉死，避免"改一半尺寸表"悄悄通过。
    // 1.85/2 - 0.45 在浮点里是 0.47500000000000003，所以具体数值只能按容差钉，
    // 上面按 spec 推导出来的等式才是逐位严格的那一条。
    if (kind === 'grunt') {
      assert.ok(Math.abs(box.halfHeight - 0.475) < 1e-12, 'grunt 半高应为 0.475，实际 ' + box.halfHeight)
      assert.ok(Math.abs(box.y - 2.925) < 1e-12, 'grunt 中心高应为 2.925，实际 ' + box.y)
    } else {
      assert.ok(Math.abs(box.halfHeight - 0.16) < 1e-12, 'hound 半高应为 0.16，实际 ' + box.halfHeight)
      assert.ok(Math.abs(box.y - 2.5) < 1e-12, 'hound 中心高应为 2.5，实际 ' + box.y)
    }
  }
})

test('monsterHurtbox：胶囊跟着怪物走，不吃缓存', () => {
  const monster = monsterAtPosition('grunt', HOME, 1)
  monster.y = 1
  const before = monsterHurtbox(monster)
  monster.x = 10
  monster.z = -10
  const after = monsterHurtbox(monster)
  assert.equal(after.x, 10)
  assert.equal(after.z, -10)
  // 只改了水平坐标，中心高不该变。
  assert.equal(after.y, before.y)
})

// ---------------------------------------------------------------- 确定性与副作用

test('同一个种子跑出逐位相同的轨迹，不同种子必然分叉', () => {
  const trace = (seed: number): number[] => {
    const monster = monsterAtPosition('grunt', HOME, 1)
    const rng = mulberry32(seed)
    const out: number[] = []
    // 没有玩家 -> 走游荡分支，这是 rng 唯一被读取的地方。
    for (let tick = 1; tick <= 600; tick++) {
      stepMonster(monster, { players: [], tick, dtMs: TICK_MS }, rng)
      integrate(monster)
      out.push(monster.x, monster.z, monster.vx, monster.vz)
    }
    return out
  }

  const a = trace(42)
  const b = trace(42)
  assert.equal(a.length, b.length)
  // 用 Object.is 而不是 ===，这样 -0 / NaN 的差异也逃不掉。
  for (let i = 0; i < a.length; i++) {
    assert.ok(Object.is(a[i], b[i]), '同种子在第 ' + i + ' 个分量分叉: ' + a[i] + ' vs ' + b[i])
  }

  const c = trace(43)
  assert.equal(c.length, a.length)
  const firstDiff = a.findIndex((value, i) => !Object.is(value, c[i]))
  assert.ok(firstDiff >= 0, '换种子后轨迹完全一致，说明种子根本没被用上')

  // 顺带钉死"游荡不会跑飞"：600 tick 后仍在巢穴附近（低速漂移是有阻尼的）。
  const drifting = monsterAtPosition('grunt', HOME, 1)
  const rng = mulberry32(42)
  for (let tick = 1; tick <= 600; tick++) {
    stepMonster(drifting, { players: [], tick, dtMs: TICK_MS }, rng)
    integrate(drifting)
  }
  assert.ok(
    homeDistance(drifting) <= HOME_ARRIVE_RADIUS * 1.05,
    '无玩家时游荡跑出了巢穴: ' + homeDistance(drifting),
  )
})

test('stepMonster 从不写位置：它只输出 vx/vz', () => {
  // 用 spawnMonster 拿一个位置/冷却都带随机偏移的怪，避免"恰好是 0"这种空断言。
  const monster = spawnMonster('grunt', 3, { x: 5, y: 1, z: -5 }, mulberry32(99))
  const before = { x: monster.x, y: monster.y, z: monster.z }
  assert.ok(before.x !== 0 && before.z !== 0, '前置条件：出生点应当偏离原点')

  const rng = mulberry32(5)
  // 5 米外：超出 grunt attackRange(1.8)，它必须一边追一边写速度，
  // 否则"没写位置"会因为"什么都没写"而假通过。
  const player = standingStill(2, monster.x + 5, monster.z)
  let wroteVelocity = false

  for (let tick = 1; tick <= 200; tick++) {
    stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
    // 每一步都不许动位置 —— 位移是调用方（Rapier）的事。
    assert.equal(monster.x, before.x, '第 ' + tick + ' tick 写了 x')
    assert.equal(monster.y, before.y, '第 ' + tick + ' tick 写了 y')
    assert.equal(monster.z, before.z, '第 ' + tick + ' tick 写了 z')
    if (monster.vx !== 0 || monster.vz !== 0) wroteVelocity = true
  }

  // 反向断言，防止上面那三条因为"函数什么都没写"而空转通过。
  assert.equal(wroteVelocity, true, 'stepMonster 应当写 vx/vz，但它一个都没写')
})

test('stepMonster 不会让速度超过 spec.speed（唯一的夹紧点在出口）', () => {
  for (const kind of ['grunt', 'hound'] as const) {
    const spec = MONSTER_SPECS[kind]
    const monster = monsterAtPosition(kind, HOME, 1)
    const rng = mulberry32(8)
    const player = standingStill(7, 0, 12)
    for (let tick = 1; tick <= 400; tick++) {
      stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
      const speed = Math.hypot(monster.vx, monster.vz)
      assert.ok(speed <= spec.speed + 1e-9, kind + ': 第 ' + tick + ' tick 速度 ' + speed + ' > ' + spec.speed)
      integrate(monster)
    }
  }
})

test('枪手只对看得见的人开枪（近处那个被挡住就不算目标）', () => {
  const spec = MONSTER_SPECS.gunner
  assert.ok(spec.ranged !== undefined, '前置条件：gunner 必须是远程怪')
  assert.equal(spec.attackRange, 16)

  const monster = monsterAtPosition('gunner', HOME, 4)
  const rng = mulberry32(21)
  // 8 号站在 5 米外但"看不见"（墙后），7 号站在 12 米外看得见。
  const near: MonsterSenses = { id: 8, x: 0, z: 5, alive: true }
  const far: MonsterSenses = { id: 7, x: 0, z: 12, alive: true }
  const senses = {
    players: [near, far],
    tick: 0,
    dtMs: TICK_MS,
    visible: (p: MonsterSenses) => p.id !== 8,
  }

  let shots = 0
  for (let tick = 1; tick <= 300; tick++) {
    senses.tick = tick
    const result = stepMonster(monster, senses, rng)
    assert.equal(monster.targetId, 7, '墙后那个人不该被选中')
    if (result.shot) {
      shots++
      assert.equal(result.shot.playerId, 7, '只许朝看得见的人开枪')
    }
    assert.equal(result.hit, null, '12 米外不该触发近战')
  }
  assert.ok(shots >= 2, '300 tick 内应当开过好几枪，实际 ' + shots)
})

test('枪手的瞄准前摇是 900ms：愣神窗口走完也不开枪', () => {
  const ranged = MONSTER_SPECS.gunner.ranged
  assert.ok(ranged !== undefined)
  assert.equal(ranged.aimMs, 900)
  // 21 tick（AGGRO_WINDUP_MS）就够近战怪咬人了，枪手这时候还在抬枪。
  const gruntWindupTicks = Math.ceil(AGGRO_WINDUP_MS / TICK_MS)

  const monster = monsterAtPosition('gunner', HOME, 5)
  const rng = mulberry32(33)
  const player = standingStill(7, 0, 12)

  let firstShotTick = -1
  let aggroMsAtFirstShot = -1
  for (let tick = 1; tick <= 300; tick++) {
    const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
    if (result.shot) {
      firstShotTick = tick
      aggroMsAtFirstShot = monster.aggroMs
      break
    }
    if (tick <= gruntWindupTicks) assert.equal(result.shot, null)
  }

  assert.ok(firstShotTick > gruntWindupTicks, '第一枪来得比近战前摇还早: tick ' + firstShotTick)
  assert.ok(aggroMsAtFirstShot >= ranged.aimMs, '开火时愣神只有 ' + aggroMsAtFirstShot + 'ms')
  // 900ms / 16.67ms ≈ 54 tick，允许浮动 1 tick（浮点累加）。
  assert.ok(
    Math.abs(firstShotTick - Math.ceil(ranged.aimMs / TICK_MS)) <= 1,
    '首枪 tick=' + firstShotTick,
  )
})

test('贴到脸上的枪手改用近战：不浪费一颗子弹', () => {
  const spec = MONSTER_SPECS.gunner
  const monster = monsterAtPosition('gunner', HOME, 6)
  const rng = mulberry32(44)
  // 1.5 米：在 MELEE_PANIC_RANGE(2.2) 之内。
  const player = standingStill(7, 0, 1.5)

  let melee = 0
  for (let tick = 1; tick <= 300; tick++) {
    const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
    assert.equal(result.shot, null, '贴脸不该开枪')
    if (result.hit) {
      melee++
      assert.equal(result.hit.playerId, 7)
      assert.equal(result.hit.damage, spec.attackDamage)
    }
  }
  assert.ok(melee >= 2, '300 tick 内应当咬过好几口，实际 ' + melee)
})

test('枪手跟丢视线时压速挪向最后位置，不再放空枪', () => {
  const spec = MONSTER_SPECS.gunner
  const monster = monsterAtPosition('gunner', HOME, 7)
  const rng = mulberry32(55)
  const player = standingStill(7, 0, 10)
  let visible = true
  const senses = {
    players: [player],
    tick: 0,
    dtMs: TICK_MS,
    visible: () => visible,
  }

  let shotsWhileVisible = 0
  let shotsAfterLost = 0
  let speedAfterLost = -1
  for (let tick = 1; tick <= 200; tick++) {
    senses.tick = tick
    if (tick === 90) visible = false
    const result = stepMonster(monster, senses, rng)
    if (result.shot) {
      if (visible) shotsWhileVisible++
      else shotsAfterLost++
    }
    if (tick >= 120 && speedAfterLost < 0) speedAfterLost = Math.hypot(monster.vx, monster.vz)
    integrate(monster)
  }

  assert.ok(shotsWhileVisible >= 1, '看得见的时候一枪没开')
  assert.equal(shotsAfterLost, 0, '丢了视线还在开枪：' + shotsAfterLost)
  assert.equal(monster.state, 'chase', '丢了视线应当去追，实际 state=' + monster.state)
  assert.ok(
    Math.abs(speedAfterLost - spec.speed * REPOSITION_SPEED_FACTOR) < 1e-6,
    '挪窝速度应当是 ' + spec.speed * REPOSITION_SPEED_FACTOR + '，实际 ' + speedAfterLost,
  )
})

// ---------------------------------------------------------------- 四图 Boss

test('boss: 四张地图各有一只不同的 Boss，且都是 isBossKind', () => {
  const expected: Record<string, string> = {
    'marsh-p0': '屠夫',
    'chapel-night': '敲钟人',
    'quarry-dust': '石心巨像',
    'station-dusk': '末班车长',
  }
  for (const [id, name] of Object.entries(expected)) {
    const level = LEVELS[id]
    assert.ok(level, '缺少地图 ' + id)
    assert.ok(level.bossKind, id + ' 没配 bossKind')
    assert.equal(bossNameOf(level.bossKind!), name)
    assert.equal(isBossKind(level.bossKind!), true)
  }
  // 线上种类码必须和 ai.ts 的 MonsterKind 对得上，否则客户端会画错模型。
  assert.equal(monsterKindFromCode(3), 'boss')
  assert.equal(monsterKindFromCode(4), 'bellkeeper')
  assert.equal(monsterKindFromCode(5), 'golem')
  assert.equal(monsterKindFromCode(6), 'conductor')
  assert.equal(monsterKindFromCode(7), null)
})

test('屠夫冲锋：有前摇、方向锁定、命中一次且速度不超过 spec.speed * speedScale', () => {
  const spec = MONSTER_SPECS.boss
  assert.ok(spec.charge)
  const monster = monsterAtPosition('boss', HOME, 1)
  const rng = mulberry32(21)
  const player = standingStill(7, 0, 12)

  let specialAt = -1
  let firstMoveAt = -1
  let maxSpeed = 0
  let hits = 0
  for (let tick = 1; tick <= 500; tick++) {
    const speedBefore = Math.hypot(monster.vx, monster.vz)
    if (specialAt < 0 && monster.state === 'special') specialAt = tick
    const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
    if (result.hit) hits++
    if (monster.state === 'special' && speedBefore === 0 && Math.hypot(monster.vx, monster.vz) > 0) {
      firstMoveAt = tick
    }
    maxSpeed = Math.max(maxSpeed, Math.hypot(monster.vx, monster.vz))
    integrate(monster)
  }

  assert.ok(specialAt > 0, '12m 外的玩家没有触发冲锋')
  assert.ok(firstMoveAt > specialAt, '冲锋前摇里就已经开始移动了')
  const windupTicks = Math.ceil(spec.charge!.windupMs / TICK_MS)
  assert.ok(
    firstMoveAt - specialAt >= windupTicks - 1,
    '前摇不足：' + (firstMoveAt - specialAt) + ' < ' + (windupTicks - 1),
  )
  assert.ok(hits >= 1, '冲到脸上一次都没撞到')
  assert.ok(maxSpeed <= spec.speed * spec.charge!.speedScale + 1e-6, '冲锋超速：' + maxSpeed)
})

test('敲钟人 / 石心巨像：范围脉冲在蓄力结束时只落一次，之后走冷却', () => {
  for (const kind of ['bellkeeper', 'golem'] as const) {
    const spec = MONSTER_SPECS[kind]
    assert.ok(spec.pulse, kind + ' 缺少 pulse')
    const monster = monsterAtPosition(kind, HOME, 3)
    const rng = mulberry32(9)
    const player = standingStill(7, 0, 6)
    const pulseTicks: number[] = []
    for (let tick = 1; tick <= 700; tick++) {
      const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
      if (result.pulse) {
        pulseTicks.push(tick)
        assert.equal(result.pulse.radius, spec.pulse!.radius)
        assert.equal(result.pulse.damage, spec.pulse!.damage)
      }
      integrate(monster)
    }
    assert.ok(pulseTicks.length >= 2, kind + ' 一次脉冲都没放')
    const windupTicks = Math.ceil(spec.pulse!.windupMs / TICK_MS)
    assert.ok(pulseTicks[0]! >= windupTicks, kind + ' 脉冲早于前摇')
    const gap = pulseTicks[1]! - pulseTicks[0]!
    assert.ok(gap >= Math.ceil(spec.pulse!.cooldownMs / TICK_MS) - 2, kind + ' 脉冲冷却不足：' + gap)
  }
})

test('末班车长：半血只召唤一次，贴脸会后撤而不是站着对枪', () => {
  const spec = MONSTER_SPECS.conductor
  assert.ok(spec.summon)
  const monster = monsterAtPosition('conductor', HOME, 4)
  const rng = mulberry32(33)
  // 先放在 6m：进入 keepDistance 内，它应当主动拉开距离。
  const player = standingStill(7, 0, 6)
  let retreat = false
  let summonCount = 0
  let summonResult: { kind: string; count: number } | null = null
  for (let tick = 1; tick <= 300; tick++) {
    if (tick === 120) monster.health = spec.maxHealth * 0.5
    const before = Math.hypot(monster.x - player.x, monster.z - player.z)
    const result = stepMonster(monster, { players: [player], tick, dtMs: TICK_MS }, rng)
    if (result.summon) {
      summonCount++
      summonResult = result.summon
    }
    integrate(monster)
    const after = Math.hypot(monster.x - player.x, monster.z - player.z)
    if (after > before + 0.01) retreat = true
    player.x = monster.x
    player.z = monster.z + Math.hypot(monster.x, monster.z + 6)
    // 把玩家保持在车长周围 6m 左右，避免它跑出 leash。
    player.x = monster.x
    player.z = monster.z + 6
  }
  assert.ok(retreat, '贴到 keepDistance 内仍然不后撤')
  assert.equal(summonCount, 1, '召唤次数应为 1，实际 ' + summonCount)
  assert.deepEqual(summonResult, { kind: 'hound', count: 2 })
})
