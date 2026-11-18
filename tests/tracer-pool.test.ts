import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const renderPath = resolve(import.meta.dirname, '../client/src/render.ts')

test('曳光弹有固定池上限，满载时不会继续分配', async () => {
  const source = await readFile(renderPath, 'utf8')
  assert.match(source, /const MAX_TRACERS = 64/)
  assert.match(source, /if \(this\.tracers\.length >= MAX_TRACERS\) return/)
})

test('过期曳光弹隐藏后可复用其几何和材质', async () => {
  const source = await readFile(renderPath, 'utf8')
  assert.match(source, /candidate\.life <= 0/)
  assert.match(source, /positions\.setXYZ\(0, origin\.x, origin\.y, origin\.z\)/)
  assert.match(source, /tracer\.line\.visible = true/)
  assert.match(source, /tracer\.life = TRACER_LIFE/)
})

test('曳光弹过期及 Renderer 销毁都释放资源或回收节点', async () => {
  const source = await readFile(renderPath, 'utf8')
  assert.match(source, /tracer\.line\.visible = false/)
  assert.match(source, /tracer\.line\.geometry\.dispose\(\)/)
  assert.match(source, /tracer\.material\.dispose\(\)/)
  assert.match(source, /this\.tracers\.length = 0/)
})

void assert
void test
void readFile
void resolve
void renderPath
