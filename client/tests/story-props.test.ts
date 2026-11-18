import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Box3, Vector3 } from 'three'
import { narrativeGeometryFor, STORY_BIOMES } from '../src/props.ts'

/**
 * 叙事静物的验收底线。
 *
 * 这些道具是"让玩家停下来半秒"的东西，所以三件事不能错：
 * 1. 不能是空壳（几何得真的建出来了）；
 * 2. 不能穿地（原点在底部中心，所有顶点 y ≥ 0）；
 * 3. 不能大得离谱（一张餐桌比房子宽就是资产事故）。
 *
 * 预算给到 6000 三角形：一组静物实例化 3~4 次，整图多出不到 2 万面，
 * 在 11 万面的场景里可以忽略。
 */
const BUDGET = 6000

for (const biome of STORY_BIOMES) {
  test(`叙事静物 ${biome} 有实体、贴地、尺寸合理`, () => {
    const geo = narrativeGeometryFor(biome)
    const position = geo.getAttribute('position')
    assert.ok(position, `${biome} 没有 position 属性`)
    const tris = Math.round((geo.getIndex()?.count ?? position.count) / 3)
    // 下限只防"空壳"：盒子是 12 面，一组 12~16 个部件也有 90~200 面，
    // 拿 200 当门槛会把合理的低多边形道具判死。
    assert.ok(tris > 80, `${biome} 只有 ${tris} 个三角形，像空壳`)
    assert.ok(tris <= BUDGET, `${biome} 有 ${tris} 个三角形，超出 ${BUDGET}`)

    // 顶点色是这套静物的唯一材质来源：丢了它整组会变成纯白。
    assert.ok(geo.getAttribute('color'), `${biome} 缺少顶点色`)

    geo.computeBoundingBox()
    const box = geo.boundingBox as Box3
    const size = box.getSize(new Vector3())
    assert.ok(size.y >= 0.6, `${biome} 只有 ${size.y.toFixed(2)}m 高，近景看不出是什么`)
    assert.ok(Math.max(size.x, size.z) <= 2.2, `${biome} 宽 ${Math.max(size.x, size.z).toFixed(2)}m，太占地方`)
    // 允许 -3cm：有些零件（鞋头）故意压进土里一点，但不该出现整块沉下去。
    assert.ok(box.min.y >= -0.03, `${biome} 最低点 ${box.min.y.toFixed(3)}，穿地了`)
  })
}

test('不同 biome 的叙事静物互不相同（不能又回到"一条长椅走遍五张图"）', () => {
  const sizes = STORY_BIOMES.map((biome) => {
    const geo = narrativeGeometryFor(biome)
    return geo.getAttribute('position').count
  })
  // swamp/farm 共用餐桌是刻意的，所以只要求至少 4 种不同规模。
  assert.ok(new Set(sizes).size >= 4, `只有 ${new Set(sizes).size} 种几何规模，重复太多`)
})
