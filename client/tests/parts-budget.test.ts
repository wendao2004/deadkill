import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Mesh, MeshBasicMaterial } from 'three'
import {
  createMagazineTube,
  createMuzzleBrake,
  createScope2x,
  createScope4x,
  createStockVariant,
} from '../src/parts/attachments.ts'
import type { WeaponMaterialSet } from '../src/weapon-models.ts'

/** 配件预算：单件 ≤3k 三角形（skill 的资产预算），低于 50 说明模型退化成空壳。 */
const BUDGET = 3000

function materials(): WeaponMaterialSet {
  const mat = new MeshBasicMaterial()
  return {
    steel: mat,
    darkSteel: mat,
    wood: mat,
    brass: mat,
    sight: mat,
    sightBead: mat,
    bore: mat,
    blade: mat,
    bladeEdge: mat,
    glove: mat,
    gloveDark: mat,
    sleeve: mat,
  }
}

function triangles(node: object): number {
  let total = 0
  ;(node as { traverse: (fn: (child: unknown) => void) => void }).traverse((child) => {
    if (!(child instanceof Mesh)) return
    const geo = child.geometry
    const index = geo.getIndex()
    const position = geo.getAttribute('position')
    total += index ? index.count / 3 : position ? position.count / 3 : 0
  })
  return Math.round(total)
}

const mats = materials()
const parts: Array<[string, () => object]> = [
  ['muzzle-brake', () => createMuzzleBrake(mats, -0.93)],
  ['magazine-tube', () => createMagazineTube(mats, { forendZ: -0.32, muzzleZ: -0.93, extension: 0.07 })],
  ['stock-heavy', () => createStockVariant(mats, 'heavy')],
  ['stock-light', () => createStockVariant(mats, 'light')],
  ['scope-2x', () => createScope2x(mats)],
  ['scope-4x', () => createScope4x(mats)],
]

for (const [name, build] of parts) {
  test(`配件 ${name} 在三角形预算内`, () => {
    const count = triangles(build())
    assert.ok(count > 50, `${name} 只有 ${count} 个三角形，模型像是空的`)
    assert.ok(count <= BUDGET, `${name} 有 ${count} 个三角形，超出预算 ${BUDGET}`)
  })
}
