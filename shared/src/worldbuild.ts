/**
 * 从关卡定义构建 Rapier 物理世界。
 *
 * 放在 shared 而不是服务端，是因为**客户端也必须用同一份构建逻辑**。
 * 客户端的移动预测就是"在本地跑一遍和服务端完全相同的物理"，只要有一行
 * 不同（重力常数、地面摩擦、围墙高度），预测就会慢慢偏离权威位置，
 * 表现为角色被不停"拽回"。
 *
 * 客户端不需要围墙（它不判命中），但为了一致性也一起建 —— 否则玩家会
 * 撞到服务端的一堵隐形墙却看不出原因。反正只有 4 个 cuboid。
 */

import type { ColliderDesc } from '@dimforge/rapier3d-compat'
import {
  ColliderDesc as ColliderDescValue,
  init as initRapier,
  RigidBodyDesc,
  World,
} from '@dimforge/rapier3d-compat'

import { GRAVITY } from './constants.ts'
import type { LevelDef } from './level.ts'

let ready = false

/**
 * 初始化 WASM。`compat` 版把 wasm 内联成 base64，所以不需要搬 .wasm 文件，
 * 也不需要 Vite 的 wasm 插件；但任何 `new World()` / `ColliderDesc.xxx()`
 * 之前都必须先 await 一次。
 */
export async function initPhysics(): Promise<void> {
  if (ready) return
  await initRapier()
  ready = true
}

/**
 * 把一个关卡定义变成物理世界。
 *
 * 重力用 `GRAVITY = -18` 而不是真实的 -9.81：真实重力下的跳跃有月球感，
 * 落地太飘，射击游戏的手感需要更"重"的落体。
 */
export function buildLevelWorld(level: LevelDef): World {
  const world = new World({ x: 0, y: GRAVITY, z: 0 })

  // 地面。做成厚板而不是 heightfield：P0 的地图是平的，
  // heightfield 只会在角色控制器上引入额外的边缘吸附问题。
  const ground = world.createRigidBody(
    RigidBodyDesc.fixed().setTranslation(0, level.groundY - 1, 0),
  )
  world.createCollider(
    ColliderDescValue.cuboid(level.boundsHalf * 2, 1, level.boundsHalf * 2).setFriction(1),
    ground,
  )

  for (const b of level.boxes) {
    if (b.noCollide) continue
    const desc: ColliderDesc = ColliderDescValue.cuboid(b.hx, b.hy, b.hz)
      .setTranslation(b.x, b.y, b.z)
      .setFriction(0.8)
    if (b.rotY) {
      const half = b.rotY / 2
      desc.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
    }
    // 不挂刚体 = 固定碰撞体，最省内存。
    world.createCollider(desc)
  }

  addBounds(world, level)
  return world
}

/**
 * 关卡边缘的隐形屏障，防止玩家跑出地图掉进虚空。
 * 单独函数是因为它不属于关卡数据（客户端不需要为它生成网格）。
 */
export function addBounds(world: World, level: LevelDef): void {
  const h = level.boundsHalf
  const wallHeight = 12
  const walls: [number, number, number, number, number, number][] = [
    [0, wallHeight / 2, -h, h, wallHeight / 2, 0.5],
    [0, wallHeight / 2, h, h, wallHeight / 2, 0.5],
    [-h, wallHeight / 2, 0, 0.5, wallHeight / 2, h],
    [h, wallHeight / 2, 0, 0.5, wallHeight / 2, h],
  ]
  for (const [x, y, z, hx, hy, hz] of walls) {
    world.createCollider(
      ColliderDescValue.cuboid(hx, hy, hz).setTranslation(x, y + level.groundY, z),
    )
  }
}
