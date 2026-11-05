/**
 * 服务端对物理世界的薄包装。
 *
 * 真正的构建逻辑在 `@dk/shared/worldbuild` —— 客户端预测必须和服务端跑
 * 同一份代码，否则玩家看到的位置和判定位置会慢慢错开。这个文件只保留
 * 服务端特有的部分，避免两边各写一份 `createLevelWorld`。
 */

export { addBounds, buildLevelWorld as createLevelWorld, initPhysics } from '@dk/shared'
