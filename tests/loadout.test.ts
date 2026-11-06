import test from 'node:test'
import assert from 'node:assert/strict'

// 相对路径的原因同 tests/protocol.test.ts：仓库根没有 @dk/* 的 workspace 链接。
import {
  DEFAULT_SECONDARY_ID,
  DEFAULT_SLOT_ORDER,
  DEFAULT_WEAPON_ID,
  MELEE_WEAPON_ID,
  StateFlags,
  TICK_MS,
  WEAPONS,
  canFire,
  canReload,
  addReserve,
  filledReserve,
  consumeAmmo,
  createLoadout,
  damageAt,
  heldAmmo,
  heldWeapon,
  isSwitching,
  meleeStrike,
  refillSlot,
  requestSwitch,
  resetLoadout,
  switchTicks,
  weaponForSlot,
} from '../shared/src/index.ts'
import type { MeleeCandidate } from '../shared/src/index.ts'

const RIFLE = WEAPONS[1]!
const REVOLVER = WEAPONS[DEFAULT_SECONDARY_ID]!
const SNIPER = WEAPONS[4]!
const KNIFE = WEAPONS[MELEE_WEAPON_ID]!

/** 站立玩家的受击胶囊：脚底 0、半径 0.35、圆柱段半高 0.6（与 Character 同一套）。 */
function playerAt(x: number, z: number, id = 2): MeleeCandidate {
  return {
    id,
    lower: { x, y: 0.35, z },
    upper: { x, y: 0.35 + 1.2, z },
    radius: 0.35,
    feetY: 0,
  }
}

// ---------------------------------------------------------------- 配装

test('配装: 槽位表与武器表互相自洽', () => {
  assert.deepEqual([...DEFAULT_SLOT_ORDER], [DEFAULT_WEAPON_ID, DEFAULT_SECONDARY_ID, MELEE_WEAPON_ID])
  assert.equal(WEAPONS[DEFAULT_WEAPON_ID]!.slot, 0)
  assert.equal(REVOLVER.slot, 1)
  assert.equal(KNIFE.slot, 2)
  assert.equal(KNIFE.kind, 'knife')
  // 近战不消耗弹药：magazine 0 + 不换弹。
  assert.equal(KNIFE.magazine, 0)
  assert.equal(KNIFE.reloadMs, 0)

  // 主武器可被玩家覆盖，非法输入必须回落到默认主武器，否则开火路径上会
  // 拿到 undefined 的 spec。
  assert.equal(weaponForSlot(1, 0), 1)
  assert.equal(weaponForSlot(4, 0), 4)
  assert.equal(weaponForSlot(4, 1), DEFAULT_SECONDARY_ID)
  assert.equal(weaponForSlot(4, 2), MELEE_WEAPON_ID)
  assert.equal(weaponForSlot(MELEE_WEAPON_ID, 0), DEFAULT_WEAPON_ID) // 刀不能当主武器
  assert.equal(weaponForSlot(999, 0), DEFAULT_WEAPON_ID)
})

test('配装: 出生时三个槽位各自满弹，弹药按槽位存', () => {
  const lo = createLoadout(1)
  assert.equal(lo.currentSlot, 0)
  assert.equal(heldWeapon(lo).id, 1)
  assert.deepEqual(lo.ammoBySlot, [RIFLE.magazine, REVOLVER.magazine, KNIFE.magazine])
  assert.equal(heldAmmo(lo), RIFLE.magazine)
})

// ---------------------------------------------------------------- 切枪

test('切枪: 计时没走完不能开火，走完就能开火', () => {
  const lo = createLoadout(1)
  assert.equal(canFire(lo, 0), true, '主武器出生即可开火')

  const tick = 100
  assert.equal(requestSwitch(lo, 1, tick), true)
  // 切到转轮手枪要 600ms —— 比步枪快，因为单手抽枪只有一个动作。
  const ticks = switchTicks(REVOLVER)
  assert.equal(ticks, Math.ceil(REVOLVER.switchMs / TICK_MS))
  assert.equal(lo.switchDoneTick, tick + ticks)

  assert.equal(isSwitching(lo, tick), true)
  assert.equal(canFire(lo, tick), false, '切枪期间不能开火')
  assert.equal(canFire(lo, tick + ticks - 1), false, '差一 tick 也不能开火')
  assert.equal(isSwitching(lo, tick + ticks), false)
  assert.equal(canFire(lo, tick + ticks), true, '举好之后可以开火')
})

test('切枪: 切到狙击枪要等更久，切到刀最快', () => {
  const toSniper = createLoadout(1)
  requestSwitch(toSniper, 0, 0)
  // 先回主武器（同一槽位请求会被拒），再切狙击不是可选槽位 —— 这里直接
  // 用 switchTicks 验证表里的手感值，避免把"主武器可选"混进判定测试。
  assert.equal(switchTicks(SNIPER), Math.ceil(SNIPER.switchMs / TICK_MS))
  assert.equal(switchTicks(KNIFE), Math.ceil(400 / TICK_MS))
  assert.equal(switchTicks(SNIPER) > switchTicks(RIFLE), true, '狙击仍然是最慢的主武器')
  assert.equal(switchTicks(RIFLE) > switchTicks(REVOLVER), true)
})

test('切枪: 同一个槽位重复请求不重开计时，非法槽位直接拒绝', () => {
  const lo = createLoadout(1)
  assert.equal(requestSwitch(lo, 2, 10), true)
  const done = lo.switchDoneTick
  assert.equal(requestSwitch(lo, 2, 20), false, '已经在刀上')
  assert.equal(lo.switchDoneTick, done)
  assert.equal(requestSwitch(lo, 5, 30), false, '没有第 5 个槽位')
  assert.equal(lo.currentSlot, 2)
})

test('切枪: 切枪期间只认刀的快照位（Switching），且不消耗弹药', () => {
  const lo = createLoadout(1)
  requestSwitch(lo, 2, 0)
  assert.equal(lo.ammoBySlot[2], 0, '刀没有弹药')
  assert.equal(canFire(lo, switchTicks(KNIFE) - 1), false)
  // 刀即使 ammo 是 0 也必须能挥 —— 近战不消耗弹药。
  assert.equal(canFire(lo, switchTicks(KNIFE)), true)
  consumeAmmo(lo)
  assert.equal(lo.ammoBySlot[2], 0)
  // 这里的位值也是线上契约：快照 flags 的 bit5。
  assert.equal(StateFlags.Switching, 1 << 5)
})

// ---------------------------------------------------------------- 弹药

test('弹药: 切走再切回不会白送子弹', () => {
  const lo = createLoadout(1)
  consumeAmmo(lo)
  consumeAmmo(lo)
  assert.equal(heldAmmo(lo), RIFLE.magazine - 2)

  assert.equal(requestSwitch(lo, 1, 100), true)
  assert.equal(heldAmmo(lo), REVOLVER.magazine, '副武器是自己的满弹')
  consumeAmmo(lo)
  assert.equal(heldAmmo(lo), REVOLVER.magazine - 1)

  assert.equal(requestSwitch(lo, 0, 200), true)
  assert.equal(heldAmmo(lo), RIFLE.magazine - 2, '切回来还是原来那 6 发')
  // 打空的枪不能开火，但切走再切回也不会因此恢复。
  lo.ammoBySlot[0] = 0
  assert.equal(canFire(lo, 1e6), false)
  assert.equal(requestSwitch(lo, 1, 300), true)
  assert.equal(requestSwitch(lo, 0, 400), true)
  assert.equal(canFire(lo, 1e6), false, '切槽不能当免费换弹用')
})

test('弹药: 换弹只补当前槽位，重生才补满所有槽位', () => {
  const lo = createLoadout(1)
  consumeAmmo(lo)
  consumeAmmo(lo)
  requestSwitch(lo, 1, 0)
  consumeAmmo(lo)
  refillSlot(lo)
  assert.equal(heldAmmo(lo), REVOLVER.magazine)
  assert.equal(lo.ammoBySlot[0], RIFLE.magazine - 2, '换弹不碰别的槽')

  resetLoadout(lo)
  assert.equal(lo.currentSlot, 0, '重生回到主武器')
  assert.deepEqual(lo.ammoBySlot, [RIFLE.magazine, REVOLVER.magazine, KNIFE.magazine])
  assert.equal(lo.switchDoneTick, 0)
})

// ---------------------------------------------------------------- 近战

test('近战: 2m 内的目标吃伤害，3m 外够不着', () => {
  // 眼睛在 1.62m，视线朝 -z。
  const eye = { x: 0, y: 1.62, z: 0 }
  const dir = { x: 0, y: 0, z: -1 }

  const near = meleeStrike(eye, dir, KNIFE, [playerAt(0, -2)])
  assert.ok(near, '2m 前的人必须被划到')
  assert.equal(near.id, 2)
  // 命中点在胶囊表面：水平 2 - 0.35 = 1.65m，竖直方向眼睛(1.62)被夹到
  // 胶囊顶端(1.55)，所以直线距离是 hypot(1.65, 0.07) ≈ 1.6515m。
  assert.ok(Math.abs(near.distance - 1.6515) < 1e-3, '实际距离 ' + near.distance)
  assert.ok(near.distance <= KNIFE.meleeRange!)

  const far = meleeStrike(eye, dir, KNIFE, [playerAt(0, -3)])
  assert.equal(far, null, '3m 外超出 meleeRange(2.4)，不该掉血')

  // 伤害按扁平值算：2.2m 的有效射程内不衰减。
  assert.equal(Math.round(damageAt(KNIFE, near.distance, false)), KNIFE.damage)
})

test('近战: 背身与侧身超过 meleeArc 的目标砍不到', () => {
  const eye = { x: 0, y: 1.62, z: 0 }
  const dir = { x: 0, y: 0, z: -1 }

  assert.equal(meleeStrike(eye, dir, KNIFE, [playerAt(0, 1.5)]), null, '背后不砍')
  // 正侧方 90°：cos 90° = 0 < cos(0.9) ≈ 0.62，超出扇形。
  assert.equal(meleeStrike(eye, dir, KNIFE, [playerAt(1.5, 0)]), null, '正侧方不砍')

  // 扇形边缘内侧（~20° 偏移、2m 远）仍然要砍到。
  const inside = meleeStrike(eye, dir, KNIFE, [playerAt(0.7, -1.9)])
  assert.ok(inside, '视线偏 20° 内的目标必须能砍到')
})

test('近战: 多人同时进入扇形时只结算最近的一个', () => {
  const eye = { x: 0, y: 1.62, z: 0 }
  const dir = { x: 0, y: 0, z: -1 }
  const hit = meleeStrike(eye, dir, KNIFE, [playerAt(0, -2.3, 7), playerAt(0, -1.2, 9)])
  assert.ok(hit)
  assert.equal(hit.id, 9, '一刀只砍最近的那个，不能穿过他去打后面的人')
})

test('近战: 蹲下/矮目标落在头肩线以下就按躯干算（沿用 HEAD_MIN_HEIGHT）', () => {
  const eye = { x: 0, y: 1.62, z: 0 }
  const dir = { x: 0, y: 0, z: -1 }
  const standing = meleeStrike(eye, dir, KNIFE, [playerAt(0, -2)])
  assert.ok(standing)
  assert.equal(standing.headshot, true, '眼睛高度落在头肩线，站着挥刀算爆头')

  // 一只 1m 高的猎犬：轴线最高 0.9m，永远够不到 1.45m 的爆头线。
  const hound: MeleeCandidate = {
    id: 42,
    lower: { x: 0, y: 0.1, z: -1.5 },
    upper: { x: 0, y: 0.9, z: -1.5 },
    radius: 0.4,
    feetY: 0,
  }
  const low = meleeStrike(eye, dir, KNIFE, [hound])
  assert.ok(low)
  assert.equal(low.headshot, false)
  // 爆头伤害 112（两刀带走 150 血的人），躯干 70。
  assert.equal(Math.round(damageAt(KNIFE, low.distance, true)), 112)
  assert.equal(Math.round(damageAt(KNIFE, low.distance, false)), 70)
})

test('备弹：换弹从备弹池扣，备弹为 0 时不能再装填', () => {
  const lo = createLoadout(DEFAULT_WEAPON_ID)
  assert.deepEqual(lo.reserveBySlot, filledReserve(DEFAULT_WEAPON_ID))
  assert.equal(lo.reserveBySlot[0], RIFLE.reserve)

  lo.ammoBySlot[0] = 0
  assert.equal(canReload(lo), true)
  const loaded = refillSlot(lo)
  assert.equal(loaded, RIFLE.magazine, '空弹匣应装满')
  assert.equal(lo.ammoBySlot[0], RIFLE.magazine)
  assert.equal(lo.reserveBySlot[0], RIFLE.reserve! - RIFLE.magazine)

  // 打空后反复装填，直到备弹见底；之后 canReload 必须为 false，refill 返回 0。
  lo.ammoBySlot[0] = 0
  lo.reserveBySlot[0] = 0
  assert.equal(canReload(lo), false, '没有备弹不许起换弹')
  assert.equal(refillSlot(lo), 0)

  // 捡弹药进备弹池，不是直接塞满弹匣。
  addReserve(lo, 10)
  assert.equal(lo.ammoBySlot[0], 0)
  assert.equal(lo.reserveBySlot[0], 10)
  assert.equal(canReload(lo), true)

  resetLoadout(lo)
  assert.deepEqual(lo.reserveBySlot, filledReserve(DEFAULT_WEAPON_ID), '重生补满备弹')
})
