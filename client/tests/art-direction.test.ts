import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEVEL_IDS } from '../../shared/src/level.ts'
import { artProfile, deployBrief, worldLine, SALT_LINE } from '../src/art-direction.ts'

test('每张猎场都有自己的美术配置（不能静默回落到默认档）', () => {
  // 回落的表现是"地标重复"：默认档的地标是半沉的谷仓，只有沼泽农舍该有它。
  // 地图名本身不能当判据 —— 沼泽农舍就是默认档，它本来就该叫这个名字。
  const landmarks = new Map<string, string>()
  for (const id of LEVEL_IDS) {
    const profile = artProfile(id)
    assert.ok(profile.place, `${id} 的 place 为空`)
    assert.ok(profile.landmark, `${id} 没有地标`)
    const seen = landmarks.get(profile.landmark)
    assert.equal(seen, undefined, `${id} 与 ${seen} 的地标重复，说明回落到了默认档`)
    landmarks.set(profile.landmark, id)
  }
  assert.equal(landmarks.size, LEVEL_IDS.length)
})

test('色彩脚本参数在可玩区间内', () => {
  for (const id of LEVEL_IDS) {
    const p = artProfile(id)
    // 低于 1.0 的曝光在夜戏里会把敌人吞掉；高于 1.5 会把"夜"洗成阴天。
    assert.ok(p.exposure >= 1.0 && p.exposure <= 1.45, `${id} 曝光 ${p.exposure} 越界`)
    assert.ok(p.grain >= 0 && p.grain <= 0.03, `${id} 颗粒 ${p.grain} 越界`)
    assert.ok(p.vignette >= 0.15 && p.vignette <= 0.45, `${id} 暗角 ${p.vignette} 越界`)
    assert.ok(p.chromatic >= 0 && p.chromatic <= 0.0015, `${id} 色差 ${p.chromatic} 越界`)
  }
})

test('五张图的曝光不是同一个值（否则色彩脚本等于没做）', () => {
  const values = new Set(LEVEL_IDS.map((id) => artProfile(id).exposure))
  assert.ok(values.size >= 4, `只有 ${values.size} 种曝光，太接近了`)
})

test('环境行包含盐线沼泽、1890 与天气', () => {
  const line = worldLine(null)
  assert.ok(line.includes(SALT_LINE), line)
  assert.ok(line.includes('1890'), line)
  assert.ok(line.includes(artProfile(null).weather), line)
})

test('简报：有合同时三段，无合同时只有日期与天气', () => {
  const withContract = deployBrief('chapel-night', '清剿')
  assert.equal(withContract.split(' · ').length, 3)
  assert.ok(withContract.includes('合同：清剿'))
  const without = deployBrief('chapel-night', null)
  assert.equal(without.split(' · ').length, 2)
  assert.ok(!without.includes('合同'))
})

test('未知关卡回落到默认档而不是抛错', () => {
  const profile = artProfile('no-such-map')
  assert.equal(profile.place, '沼泽农舍')
  assert.ok(profile.exposure > 0)
})
