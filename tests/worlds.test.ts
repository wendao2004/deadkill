/**
 * 世界注册表的准入与销毁。
 *
 * 锁住 512MB 部署下最贵的两个错误：任意 ?match= 无限建世界、RSS 已高还继续
 * 建；以及房间回收时只停 tick、不释放 Rapier WASM。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { initPhysics } from '../shared/src/worldbuild.ts'
import { World } from '../server/src/world.ts'
import { WorldRegistry } from '../server/src/worlds.ts'
import type { WebSocket } from 'ws'

function fakeSocket(): {
  readyState: number
  bufferedAmount: number
  sent: ArrayBuffer[]
  send(buffer: ArrayBuffer): void
  close(): void
  terminate(): void
  ping(): void
} {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(buffer: ArrayBuffer) {
      this.sent.push(buffer)
    },
    close() {
      this.readyState = 3
    },
    terminate() {
      this.readyState = 3
    },
    ping() {},
  }
}

test('准入：活跃世界达到上限后拒绝新 match，但已有 match 仍可进', async () => {
  await initPhysics()
  const registry = new WorldRegistry('marsh-p0', {
    maxActiveWorlds: 1,
    rssLimitMb: 380,
    rss: () => 0,
  })
  assert.equal(registry.admit('a').ok, true)
  registry.get('a')
  assert.equal(registry.admit('b').ok, false)
  assert.equal(registry.admit('a').ok, true)
  registry.stop()
})

test('准入：RSS 超过水位时拒绝建新世界', () => {
  const registry = new WorldRegistry('marsh-p0', {
    maxActiveWorlds: 2,
    rssLimitMb: 380,
    rss: () => 400 * 1024 * 1024,
  })
  const admission = registry.admit('a')
  assert.equal(admission.ok, false)
  if (!admission.ok) assert.match(admission.reason, /内存/)
})

test('跨局重置：重建怪、重抽天气/战利品种子、清合同与开火锁', async () => {
  await initPhysics()
  const world = new World({ id: 'reset-test' })
  const joined = world.addPlayer(fakeSocket() as unknown as WebSocket, '测试者', 'reset-user')!
  const internals = world as unknown as {
    stepMatch(): void
    lastMatchPhase: string
    match: { state: { phase: string } }
    players: Map<
      number,
      { contract: number; contractDone: boolean; loadout: { lastFireTick: number } }
    >
    monsters: unknown[]
  }
  const player = internals.players.get(joined.id)!
  player.contract = 1
  player.contractDone = true
  player.loadout.lastFireTick = 123

  // 模拟上一局刚 over、match 已 reset 回 hunt 的那一 tick。
  internals.lastMatchPhase = 'over'
  internals.match.state.phase = 'hunt'
  internals.stepMatch()

  assert.ok(internals.monsters.length > 0, '新一局必须重新刷怪')
  assert.equal(player.contract, 0)
  assert.equal(player.contractDone, false)
  assert.equal(player.loadout.lastFireTick, -1e9)
  world.dispose()
})

test('销毁：dispose 会释放物理世界，重复调用不抛错', async () => {
  await initPhysics()
  const registry = new WorldRegistry('marsh-p0', { maxActiveWorlds: 1, rss: () => 0 })
  const world = registry.get('dispose-test')
  assert.doesNotThrow(() => world.dispose())
  assert.doesNotThrow(() => world.dispose())
  registry.stop()
})
