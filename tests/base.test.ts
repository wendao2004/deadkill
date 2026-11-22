import test from 'node:test'
import assert from 'node:assert/strict'

import { pageBase } from '../client/src/base.ts'

test('页面目录：根路径、带斜杠子路径、无斜杠子路径、index.html', () => {
  assert.equal(pageBase('/'), '/')
  assert.equal(pageBase('/dead-kill/'), '/dead-kill/')
  assert.equal(pageBase('/dead-kill'), '/dead-kill/')
  assert.equal(pageBase('/dead-kill/index.html'), '/dead-kill/')
  assert.equal(pageBase('/a/b'), '/a/b/')
})
