/**
 * 纯数学工具。
 *
 * 刻意不用 three.js 的 Vector3 —— shared 会同时被服务端 Node 进程和浏览器
 * 加载，服务端不需要（也不应该）为了几个向量运算拉进整个渲染库。
 * 这里全部是普通对象 / 数字，零依赖，两端计算结果按位一致。
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 角度归一化到 [-PI, PI]。 */
export function wrapAngle(a: number): number {
  const tau = Math.PI * 2
  let r = a % tau
  if (r > Math.PI) r -= tau
  if (r < -Math.PI) r += tau
  return r
}

/**
 * 朝向角 → 水平前向量。
 *
 * 约定与 three.js 相机一致：yaw = 0 时朝 -Z 看。两端必须用同一个约定，
 * 否则客户端看到自己朝前走、服务端认为在横着走。
 */
export function yawToForward(yaw: number): Vec3 {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) }
}

export function yawToRight(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) }
}

/** 视线方向（含俯仰）。pitch 正数朝上看。 */
export function lookDirection(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch)
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  }
}

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function vecScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s }
}

export function vecDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

export function vecLength(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

export function vecNormalize(a: Vec3): Vec3 {
  const len = vecLength(a)
  return len > 1e-6 ? vecScale(a, 1 / len) : { x: 0, y: 0, z: 0 }
}

/** 只在水平面上归一化，用于移动意图（y 分量始终为 0）。 */
export function vecNormalizeXZ(a: Vec3): Vec3 {
  const len = Math.hypot(a.x, a.z)
  return len > 1e-6 ? { x: a.x / len, y: 0, z: a.z / len } : { x: 0, y: 0, z: 0 }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }
}

/** 把 [-PI, PI] 的弧度量化成 u16，用于网络传输。 */
export function quantizeAngle(a: number): number {
  const n = Math.round(((wrapAngle(a) + Math.PI) / (Math.PI * 2)) * 65535)
  return n & 0xffff
}

export function dequantizeAngle(q: number): number {
  return (q / 65535) * Math.PI * 2 - Math.PI
}
