import test from 'node:test'
import assert from 'node:assert/strict'

import { WEAPONS } from '../shared/src/constants.ts'
import {
  attachmentById,
  attachmentsForSlot,
  buildEntries,
  buildFlags,
  buildFromEntries,
  effectiveWeaponSpec,
  isCompatible,
  sanitizeBuild,
  type WeaponBuild,
} from '../shared/src/weapon-build.ts'

const rifle = WEAPONS[1]!
const revolver = WEAPONS[5]!
const shotgun = WEAPONS[2]!

test('build: 接口兼容 —— 步枪能装消音器，霰弹不能，转轮不能装枪口', () => {
  assert.equal(isCompatible(1, attachmentById(201)!), true)
  assert.equal(isCompatible(2, attachmentById(201)!), false)
  assert.equal(isCompatible(5, attachmentById(201)!), false)
  assert.equal(isCompatible(5, attachmentById(101)!), true)
  assert.equal(isCompatible(2, attachmentById(202)!), true)
  assert.deepEqual(
    attachmentsForSlot(1, 'sight').map((a) => a.key),
    ['iron', 'scope2', 'scope4'],
  )
})

test('build: 清洗槽位会丢掉未知/错槽/不兼容的配件', () => {
  const clean = sanitizeBuild(1, {
    sight: 101,
    muzzle: 201,
    magazine: 301,
    stock: 401,
  })
  assert.deepEqual(clean.slots, { sight: 101, muzzle: 201, magazine: 301, stock: 401 })

  const dirty = sanitizeBuild(1, {
    sight: 9999,
    muzzle: 301, // 供弹件塞进枪口
    magazine: 401, // 枪托件塞进供弹
    stock: 201, // 消音器塞进枪托
  } as unknown as WeaponBuild['slots'])
  assert.deepEqual(dirty.slots, {})

  const shotgunMuzzle = sanitizeBuild(2, { muzzle: 201 })
  assert.deepEqual(shotgunMuzzle.slots, {})
})

test('build: 有效数值按加法→乘法组合，弹匣/换弹/散布/倍率都变', () => {
  const base = rifle
  const build = sanitizeBuild(1, { sight: 101, muzzle: 202, magazine: 301, stock: 401 })
  const effective = effectiveWeaponSpec(base, build)
  assert.equal(effective.magazine, base.magazine + 2)
  assert.ok(effective.reloadMs > base.reloadMs)
  assert.ok(effective.spread < base.spread)
  assert.ok((effective.adsZoom ?? 1) > (base.adsZoom ?? 1))
  assert.ok(effective.switchMs > base.switchMs)
  // 不改静态表
  assert.equal(base.magazine, WEAPONS[1]!.magazine)
})

test('build: 快装弹仓牺牲容量换换弹速度', () => {
  const quick = effectiveWeaponSpec(rifle, sanitizeBuild(1, { magazine: 302 }))
  assert.equal(quick.magazine, rifle.magazine - 1)
  assert.ok(quick.reloadMs < rifle.reloadMs)
})

test('build: 视觉开关与槽位条目往返', () => {
  const build = sanitizeBuild(1, { sight: 102, muzzle: 201, magazine: 301 })
  assert.deepEqual(buildFlags(build), {
    scope: true,
    suppressor: true,
    extendedMagazine: true,
    heavyStock: false,
  })
  const entries = buildEntries(build)
  assert.equal(entries.length, 3)
  const round = buildFromEntries(1, entries)
  assert.deepEqual(round.slots, build.slots)
})

test('build: 转轮只能用转轮供弹，霰弹没有可用的枪口消音', () => {
  assert.deepEqual(
    attachmentsForSlot(5, 'magazine').map((a) => a.key),
    ['mag_none', 'extended', 'quick'],
  )
  const revolverBuild = sanitizeBuild(5, { muzzle: 202, magazine: 301, sight: 101 })
  assert.deepEqual(revolverBuild.slots, { sight: 101, magazine: 301 })
  assert.equal(revolver.magazine + 2, effectiveWeaponSpec(revolver, revolverBuild).magazine)
  assert.equal(sanitizeBuild(2, { muzzle: 201 }).slots.muzzle, undefined)
  assert.equal(shotgun.magazine + 0, effectiveWeaponSpec(shotgun, sanitizeBuild(2, {})).magazine)
})
