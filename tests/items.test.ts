import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ItemError,
  addItem,
  canPlace,
  createGrid,
  findSlot,
  itemDefByKey,
  moveBetween,
  removeItem,
  renderGrid,
  reposition,
  splitStack,
  totalValue,
  totalWeight,
  type ItemInstance,
} from '../shared/src/items.ts'

const def = (key: string): number => {
  const found = itemDefByKey(key)
  assert.ok(found, `missing def ${key}`)
  return found.id
}

function item(key: string, uid: number, count = 1): ItemInstance {
  return { uid, def: def(key), count }
}

test('空容器里能放下 4×2 的步枪', () => {
  const bag = createGrid(6, 6)
  assert.equal(canPlace(bag, item('weapon_winfield', 1), 0, 0), true)
  assert.equal(canPlace(bag, item('weapon_winfield', 1), 3, 0), false)
  assert.equal(canPlace(bag, item('weapon_winfield', 1), 0, 5), false)
})

test('放不进去会抛 ItemError，且不改动原容器', () => {
  const bag = createGrid(2, 2)
  assert.throws(() => addItem(bag, item('weapon_winfield', 1)), ItemError)
  assert.equal(bag.items.length, 0)
})

test('addItem 写进容器，占用格子后不能再放第二把', () => {
  const bag = addItem(createGrid(6, 6), item('weapon_winfield', 1))
  assert.equal(bag.items.length, 1)
  assert.throws(() => addItem(createGrid(2, 2), item('weapon_winfield', 2)), ItemError)
  const rows = renderGrid(bag)
  assert.equal(rows[0], '####..')
  assert.equal(rows[1], '####..')
  assert.equal(rows[2], '......')
})

test('堆叠上限：30 发一叠，超出部分进新格', () => {
  let bag = createGrid(2, 1)
  bag = addItem(bag, item('ammo_45lc', 1, 20))
  bag = addItem(bag, item('ammo_45lc', 2, 25))
  assert.equal(bag.items.length, 2)
  assert.equal(bag.items[0]!.item.count, 30)
  assert.equal(bag.items[1]!.item.count, 15)
})

test('堆叠满了装不下就抛错', () => {
  let bag = createGrid(2, 1)
  bag = addItem(bag, item('ammo_45lc', 1, 30))
  bag = addItem(bag, item('ammo_45lc', 2, 30))
  assert.throws(() => addItem(bag, item('ammo_45lc', 3, 1)), ItemError)
})

test('旋转：2×1 的镜子在 1 格宽的列里只能竖放', () => {
  const narrow = createGrid(1, 4)
  const slot = findSlot(narrow, item('part_scope4', 1))
  assert.ok(slot)
  assert.equal(slot.rotated, true)
  assert.equal(slot.x, 0)
})

test('reposition 不能压到别的物品', () => {
  let bag = createGrid(4, 4)
  bag = addItem(bag, item('medkit_large', 1))
  bag = addItem(bag, item('medkit_small', 2))
  assert.throws(() => reposition(bag, 2, 0, 0, false), ItemError)
  const moved = reposition(bag, 2, 2, 0, false)
  assert.equal(moved.items.find((entry) => entry.item.uid === 2)!.x, 2)
})

test('removeItem 取出整件并保留其它物品', () => {
  let bag = addItem(createGrid(4, 4), item('medkit_large', 1))
  bag = addItem(bag, item('valuable_watch', 2))
  const { container, item: taken } = removeItem(bag, 1)
  assert.equal(taken.uid, 1)
  assert.equal(container.items.length, 1)
  assert.equal(container.items[0]!.item.uid, 2)
})

test('splitStack 拆出的数量正确，源堆叠减到 0 就消失', () => {
  let bag = addItem(createGrid(2, 1), item('ammo_12g', 1, 12))
  const split = splitStack(bag, 1, 7)
  assert.equal(split.item.count, 7)
  assert.equal(split.container.items[0]!.item.count, 5)
  const rest = splitStack(bag, 1, 12)
  assert.equal(rest.container.items.length, 0)
  assert.throws(() => splitStack(bag, 1, 99), ItemError)
})

test('跨容器移动：目标满了就整体失败，源不变', () => {
  const from = addItem(createGrid(4, 4), item('medkit_large', 1))
  const full = addItem(createGrid(2, 2), item('medkit_large', 9))
  assert.throws(() => moveBetween(from, full, 1), ItemError)
  assert.equal(from.items.length, 1)
  const to = createGrid(2, 2)
  const moved = moveBetween(from, to, 1)
  assert.equal(moved.from.items.length, 0)
  assert.equal(moved.to.items.length, 1)
})

test('重量与身价递归统计子容器', () => {
  const inner = addItem(createGrid(2, 2), item('valuable_icon', 1))
  const bag: ItemInstance = { uid: 5, def: def('bag_small'), count: 1, inside: inner }
  const outer = addItem(createGrid(4, 4), bag)
  const watch = itemDefByKey('valuable_watch')!
  const icon = itemDefByKey('valuable_icon')!
  assert.equal(totalValue(outer), 80 + 320)
  assert.ok(Math.abs(totalWeight(outer) - (0.9 + icon.weight)) < 1e-9)
  assert.ok(watch.value > 0)
})
