/**
 * 逐实例的"手涂色差"。
 *
 * 手绘场景里没有两块完全相同的木头/石头/叶子：同一棵树的树干和枝、同一段
 * 栅栏的桩和横杆，都该有轻微色差。实例化之后所有副本共用一个几何与材质，
 * 唯一能低成本区分它们的就是 `InstancedMesh.instanceColor`。
 *
 * ## 为什么不消耗 rng
 *
 * 道具的摆放已经用了种子 rng。如果这里再抽随机数，同一 seed 下所有后续
 * 树叶/栅栏的位置都会整体挪位 —— 截图、回放和"这张图我熟"的肌肉记忆全部
 * 失效。所以色差只用**实例序号哈希**，与布局互不影响。
 *
 * ## 为什么不直接调 setColorAt 传 new Color()
 *
 * 一个关卡可能有上千个实例，每实例 new 一个 Color 是纯垃圾。调用方传一个
 * 复用的 out 对象；批量入口内部也复用同一个。
 */

import { Color, type InstancedMesh } from 'three'

/** 0..1 确定性哈希：只用 imul，Node 与浏览器结果一致。 */
export function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/**
 * 第 index 个实例的色差。明度围绕 1.0 波动 ±strength/2，冷暖 ±warm/2。
 *
 * 强度上限刻意压得很低：手绘色块只有 4 级色阶，±15% 以上就会把同一块材质
 * 拆成两种颜色。植被可以到 ±12%，木头 ±10%，金属 ±6%。
 */
export function handTint(
  index: number,
  strength: number,
  warm: number,
  out = new Color(),
): Color {
  const a = hash01(index * 2 + 1)
  const b = hash01(index * 2 + 2)
  const value = 1 - strength * 0.5 + a * strength
  const shift = (b - 0.5) * warm
  return out.setRGB(value * (1 + shift), value, value * (1 - shift))
}

/** 给整个 InstancedMesh 写逐实例色差。必须在 setMatrixAt 之后调用。 */
export function tintInstances(
  mesh: InstancedMesh,
  count: number,
  strength: number,
  warm: number,
): void {
  const color = new Color()
  for (let i = 0; i < count; i++) {
    handTint(i, strength, warm, color)
    mesh.setColorAt(i, color)
  }
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
}
