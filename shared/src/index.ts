/**
 * `@dk/shared` 的公共出口。
 *
 * 这里导出的每一样东西都同时被 Node 服务端和浏览器客户端加载，
 * 所以这个包**不许**引入 Node 内置模块（`node:fs` 之类），也不许
 * 引入 DOM API。唯一的外部依赖是 Rapier，因为移动和命中判定必须两端同源。
 */

export * from './math.ts'
export * from './kernel/index.ts'
export * from './constants.ts'
export * from './loadout.ts'
export * from './protocol.ts'
export * from './loot.ts'
export * from './match.ts'
export * from './matchDriver.ts'
export * from './level.ts'
export * from './worldbuild.ts'
export * from './sim.ts'
export * from './character.ts'
export * from './hit.ts'
export * from './ai.ts'
export * from './traits.ts'
export * from './modifiers.ts'
export * from './lore.ts'
