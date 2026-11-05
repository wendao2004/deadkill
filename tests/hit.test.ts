import test from 'node:test'
import assert from 'node:assert/strict'

// 相对路径导入：仓库根 node_modules 下没有 @dk/* 的 workspace 链接。
// hit.ts 会 import Rapier，但只做类型/常量级的使用，运行时不触发 WASM 初始化。
import { damageAt, mulberry32, totalDamage, WEAPONS, type WeaponSpec } from '../shared/src/index.ts'

const RIFLE: WeaponSpec = WEAPONS[1]!
const SHOTGUN: WeaponSpec = WEAPONS[2]!

test('damageAt: 有效射程内是满伤害（与距离无关）', () => {
  assert.equal(RIFLE.effectiveRange, 60)
  for (const distance of [0, 0.5, 10, 30, 59, RIFLE.effectiveRange]) {
    assert.equal(damageAt(RIFLE, distance, false), RIFLE.damage, 'distance=' + distance)
  }
  for (const distance of [0, 5, SHOTGUN.effectiveRange]) {
    assert.equal(damageAt(SHOTGUN, distance, false), SHOTGUN.damage, 'shotgun distance=' + distance)
  }
})

test('damageAt: 超出有效射程后单调不增', () => {
  for (const weapon of [RIFLE, SHOTGUN]) {
    let previous = damageAt(weapon, weapon.effectiveRange, false)
    for (let distance = weapon.effectiveRange; distance <= weapon.effectiveRange * 5; distance += 0.25) {
      const damage = damageAt(weapon, distance, false)
      assert.ok(damage <= previous + 1e-12, weapon.name + ': distance=' + distance + ' 伤害回升 ' + previous + ' -> ' + damage)
      previous = damage
    }
  }
})

test('damageAt: 衰减到 40% 后不再下降，也绝不跌破这个下限', () => {
  for (const weapon of [RIFLE, SHOTGUN]) {
    const floor = weapon.damage * 0.4
    // falloff 在 distance = effectiveRange * 3 处归零，此后恒为 40%。
    const plateauFrom = weapon.effectiveRange * 3
    for (const distance of [plateauFrom, plateauFrom + 1, weapon.effectiveRange * 10, 1e6]) {
      const damage = damageAt(weapon, distance, false)
      assert.ok(Math.abs(damage - floor) <= 1e-9, weapon.name + ': distance=' + distance + ' 应停在 40% 下限，实际 ' + damage)
    }

    for (let distance = 0; distance <= plateauFrom * 2; distance += 1) {
      const damage = damageAt(weapon, distance, false)
      assert.ok(damage >= floor - 1e-9, weapon.name + ': distance=' + distance + ' 跌破 40% 下限')
    }
  }
})

test('damageAt: 半程衰减点符合线性插值', () => {
  // effectiveRange 之外 over 增加，falloff = 1 - over / (2 * effectiveRange)，
  // 伤害 = damage * (0.4 + 0.6 * falloff)。
  const over = RIFLE.effectiveRange / 2
  const expected = RIFLE.damage * (0.4 + 0.6 * (1 - over / (RIFLE.effectiveRange * 2)))
  assert.ok(Math.abs(damageAt(RIFLE, RIFLE.effectiveRange + over, false) - expected) <= 1e-9)
})

test('damageAt: 爆头按 headMultiplier 放大（射程内外都是乘法）', () => {
  assert.equal(RIFLE.headMultiplier, 2.2)
  for (const distance of [0, 30, RIFLE.effectiveRange, RIFLE.effectiveRange + 20, 1000]) {
    const body = damageAt(RIFLE, distance, false)
    const head = damageAt(RIFLE, distance, true)
    assert.ok(Math.abs(head - body * RIFLE.headMultiplier) <= 1e-9, 'distance=' + distance)
  }
  // 猎杀节奏的核心数值：一枪头致死（MAX_HEALTH = 150），两枪躯干致死。
  const oneHeadshot = damageAt(RIFLE, 10, true)
  assert.ok(oneHeadshot >= 150, '一枪头必须致死，实际 ' + oneHeadshot)
  assert.ok(damageAt(RIFLE, 10, false) * 2 >= 150, '两枪躯干必须致死')
  assert.ok(damageAt(RIFLE, 10, false) < 150, '一枪躯干不该致死')
})

test('totalDamage: 逐弹丸求和（霰弹枪多弹丸）', () => {
  assert.equal(SHOTGUN.pellets, 10)
  const hits = Array.from({ length: SHOTGUN.pellets }, () => ({ distance: 5, headshot: false }))
  assert.equal(totalDamage(SHOTGUN, hits), SHOTGUN.damage * SHOTGUN.pellets)
  assert.equal(totalDamage(SHOTGUN, []), 0)
  assert.equal(
    totalDamage(SHOTGUN, [{ distance: 5, headshot: true }, { distance: 5, headshot: false }]),
    SHOTGUN.damage * SHOTGUN.headMultiplier + SHOTGUN.damage,
  )
})

test('mulberry32: 同一颗种子产出同一串数', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  for (let i = 0; i < 64; i++) {
    assert.equal(b(), a(), '第 ' + i + ' 个数不一致')
  }
  // 重新创建生成器也必须从头再来（回放依赖这一点）。
  const c = mulberry32(42)
  const d = mulberry32(42)
  assert.deepEqual([c(), c(), c()], [d(), d(), d()])
})

test('mulberry32: 不同种子产出不同序列', () => {
  const sample = (seed: number): number[] => {
    const random = mulberry32(seed)
    return Array.from({ length: 8 }, () => random())
  }
  assert.notDeepEqual(sample(1), sample(2))
  assert.notDeepEqual(sample(0), sample(1))
  assert.notDeepEqual(sample(0xdeadbeef), sample(0xcafebabe))
  // 种子按 >>> 0 归一：-1 与 0xFFFFFFFF 是同一颗种子。
  assert.deepEqual(sample(-1), sample(0xffffffff))
})

test('mulberry32: 取值恒在 [0, 1)', () => {
  for (const seed of [0, 1, 42, 0xffffffff, 987654321]) {
    const random = mulberry32(seed)
    for (let i = 0; i < 2000; i++) {
      const value = random()
      assert.ok(value >= 0 && value < 1, 'seed=' + seed + ' 产出越界值 ' + value)
      assert.ok(!Number.isNaN(value), 'seed=' + seed + ' 产出 NaN')
    }
  }
})
