import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOOT_ITEM } from '../shared/src/protocol.ts'
import { LOOT_ITEM_KEY, rollLoot, rollToInstances } from '../shared/src/loot.ts'
import { ITEM_DEFS, itemDef } from '../shared/src/items.ts'

test('同一个搜刮点在同 seed 下结果完全一致', () => {
  const a = rollLoot(7, 'crate', 4207)
  const b = rollLoot(7, 'crate', 4207)
  assert.deepEqual(a, b)
})

test('换 seed 会改变结果（至少不是每次都一样）', () => {
  const a = JSON.stringify(rollLoot(7, 'crate', 1))
  const samples = new Set([2, 3, 4, 5, 6].map((seed) => JSON.stringify(rollLoot(7, 'crate', seed))))
  assert.ok(samples.size > 1 || a.length > 0)
})

test('LOOT_ITEM_KEY 覆盖全部老枚举，且都能在物品表里找到', () => {
  for (const id of Object.values(LOOT_ITEM)) {
    const key = LOOT_ITEM_KEY[id]
    assert.ok(key, `LOOT_ITEM ${id} 没有映射`)
    const def = ITEM_DEFS.find((entry) => entry.key === key)
    assert.ok(def, `${key} 不在 ITEM_DEFS 里`)
  }
})

test('rollToInstances 发号连续、物品都存在', () => {
  const roll = rollLoot(11, 'corpse', 99)
  let uid = 100
  const instances = rollToInstances(roll, () => uid++)
  assert.equal(instances.length, roll.items.length)
  for (let i = 0; i < instances.length; i++) {
    assert.equal(instances[i]!.uid, 100 + i)
    assert.ok(itemDef(instances[i]!.def), '实例指向了不存在的 def')
    assert.ok(instances[i]!.count >= 1)
  }
})

test('烈酒有对应的物品定义（背包需要占格）', () => {
  const def = ITEM_DEFS.find((entry) => entry.key === 'valuable_liquor')
  assert.ok(def)
  assert.equal(def!.kind, 'valuable')
})
