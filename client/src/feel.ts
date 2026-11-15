/**
 * 相机/武器共用的"手感数学"：弹簧、指数逼近、确定性噪声与参数表。
 *
 * 这些数值来自源码 player/tuning.js 的 120Hz 调校，但实现只依赖 dt，
 * 因此 60/144/240Hz 下观感一致。全部是纯函数/无分配状态，避免每帧 GC。
 */

export const DEG = Math.PI / 180
export const TAU = Math.PI * 2

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 指数逼近：tau 是达到 63% 的时间常数。 */
export function approach(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 1e-6) return target
  return target + (current - target) * Math.exp(-dt / tau)
}

/** 最短有向角差，弧度。 */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  else if (d < -Math.PI) d += TAU
  return d
}

/**
 * 确定性 1D 值噪声。相机抖动不能用 Math.random：截图/回放要可复现，
 * 而且随机数每帧跳变会读成"信号不好"。
 */
export function hashNoise(x: number, seed = 0): number {
  const xi = Math.floor(x)
  const f = x - xi
  const h = (i: number): number => {
    let n = (i | 0) ^ (seed * 374761393)
    n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d)
    n = Math.imul(n ^ (n >>> 12), 0x297a2d39)
    n ^= n >>> 15
    return ((n >>> 0) / 4294967296) * 2 - 1
  }
  const u = f * f * (3 - 2 * f)
  return h(xi) * (1 - u) + h(xi + 1) * u
}

const MAX_SUB_DT = 1 / 360

/**
 * 阻尼谐振子。zeta < 1 会过冲（后坐力要的"打一下再回来"），
 * zeta = 1 临界阻尼（FOV/ADS 要的干脆）。
 */
export class Spring {
  value = 0
  velocity = 0
  target = 0
  /**
   * 显式字段 + 赋值，而不是构造函数参数属性。
   *
   * Node 的 `--experimental-strip-types` 是 strip-only：参数属性（`public freq`）
   * 需要真正的 TS 编译器，测试会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
   * 这个类现在有单测（tests/feel.test.ts），所以必须保持可被 strip 解析。
   */
  freq: number
  damping: number

  constructor(freq = 8, damping = 0.7, value = 0) {
    this.freq = freq
    this.damping = damping
    this.value = value
  }

  reset(value = 0): this {
    this.value = value
    this.velocity = 0
    this.target = 0
    return this
  }

  /** 注入速度 —— 物理上正确的"踢一脚"。 */
  impulse(v: number): this {
    this.velocity += v
    return this
  }

  set(v: number): this {
    this.value = v
    return this
  }

  step(dt: number): number {
    if (dt <= 0) return this.value
    const w = TAU * this.freq
    const k = w * w
    const c = 2 * this.damping * w
    // 子步长：掉帧时硬弹簧也不炸。
    let remaining = dt
    let guard = 0
    while (remaining > 1e-7 && guard++ < 24) {
      const h = remaining > MAX_SUB_DT ? MAX_SUB_DT : remaining
      remaining -= h
      const a = -k * (this.value - this.target) - c * this.velocity
      this.velocity += a * h
      this.value += this.velocity * h
    }
    if (Math.abs(this.value - this.target) < 1e-7 && Math.abs(this.velocity) < 1e-6) {
      this.value = this.target
      this.velocity = 0
    }
    return this.value
  }
}

/**
 * 给定"想要的峰值位移"，反解出 Spring.impulse 需要的初速度。
 *
 * 直接写 impulse 的问题是没人知道 0.018 对应多少毫米 —— 旧代码注释说
 * "约 2~3px"，实际峰值只有 0.17mm（欠阻尼 9Hz 下位移 ≈ v0/ω × 衰减），
 * 于是五条后坐弹簧形同虚设。
 *
 * 这里不写解析式，而是用 Spring **同一套半隐式欧拉 + 1/360 子步**跑一次
 * 单位冲量，量出真实峰值再反解。原因：显式积分器本身有数值阻尼，
 * 解析解与代码实际跑出来的峰值差 ~9%（实测 5.5mm 只到 5.0mm）。
 * 调参要的是"代码里真的到 5.5mm"，不是"公式里是 5.5mm"。
 *
 * 每次开火每条轴调用一次（216 步），对每发子弹的耗时可以忽略；
 * 不在每帧路径上。
 */
export function impulseForPeak(peak: number, freq: number, damping: number): number {
  if (peak === 0) return 0
  const w = TAU * freq
  const k = w * w
  const c = 2 * Math.min(0.999, Math.max(0, damping)) * w
  const h = MAX_SUB_DT
  const steps = Math.ceil(0.6 / h)
  let x = 0
  let v = 1
  let max = 0
  for (let i = 0; i < steps; i++) {
    const a = -k * x - c * v
    v += a * h
    x += v * h
    const abs = Math.abs(x)
    if (abs > max) max = abs
  }
  return peak / Math.max(1e-9, max)
}

/** 源码 tuning.js 的 CAMERA 表（只保留本项目用到的部分）。 */
export const CAMERA_FEEL = {
  bob: {
    ampX: 0.0165,
    ampY: 0.0115,
    ampZ: 0.006,
    roll: 0.42 * DEG,
    pitch: 0.16 * DEG,
    speedExp: 0.85,
    speedCap: 1.55,
    adsScale: 0.22,
    airFade: 0.11,
  },
  step: {
    impulse: 0.085,
    freq: 5.4,
    damping: 0.62,
    sprintScale: 1.7,
  },
  land: {
    minSpeed: 2.2,
    fullSpeed: 12.5,
    dipImpulse: 2.35,
    pitch: 3.4 * DEG,
    roll: 0.9 * DEG,
    freq: 3.05,
    damping: 0.52,
    trauma: 0.34,
  },
  roll: {
    strafe: 1.05 * DEG,
    yawRate: 0.055,
    yawRateMax: 1.5 * DEG,
    tau: 0.11,
    air: 0.9 * DEG,
  },
  shake: {
    decay: 1.85,
    rot: 1.35 * DEG,
    pos: 0.022,
    freq: 22,
  },
  breath: {
    freqA: 0.235,
    freqB: 0.155,
    amp: 0.0021,
    posAmp: 0.0035,
    adsScale: 1.85,
    moveDamp: 0.78,
  },
  fov: {
    sprint: 1.055,
    air: 1.015,
    adsTau: 0.052,
    moveTau: 0.13,
  },
} as const
