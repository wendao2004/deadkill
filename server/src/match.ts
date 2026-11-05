/**
 * 目标推进器已搬到 `@dk/shared`（见 shared/src/matchDriver.ts）。
 *
 * 客户端也要按同一套规则画进度条：线索涨得多快、放逐掉得多快，两边各算
 * 一遍必然在某个版本漂开，表现就是"我屏幕上明明还在圈里，服务端说我出去了"。
 *
 * 这里保留文件与旧的导入路径 —— 单测和 world.ts 都还从这里取。
 */

export { MatchDriver, type MatchActors } from '@dk/shared'
export { lairOf } from '@dk/shared'
