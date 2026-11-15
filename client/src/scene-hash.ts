/**
 * 静态场景指纹：同一张图、同一个资源集，两次启动必须得到同一个 hash。
 *
 * ## 为什么不用对象 UUID / id
 *
 * Three 的 `uuid` 每次运行随机，`id` 按创建顺序递增。异步加载（GLB 村庄、
 * 自然资产）完成的先后顺序可能不同，对象的 id/遍历顺序都会变，但它们描述
 * 的是**同一张图**。所以指纹只取内容：几何顶点、实例矩阵、世界变换、
 * 材质参数；每个对象单独算一个 hash，最后排序再合并 —— 顺序无关。
 *
 * ## 为什么不哈希贴图像素
 *
 * 程序化贴图/烘焙贴图的内容由代码决定；真要逐像素哈希，一张 1024² 图就是
 * 几 MB 的读取，而它变没变在材质名/尺寸/使用方式上通常已经能看出来。
 * 这里的指纹用来抓"同 seed 两次启动，几何/摆放/材质参数是否一致"，
 * 不负责像素级回归（那是 `pnpm qa:diff` 的职责）。
 *
 * ## 量化
 *
 * 世界矩阵用 1e-4 量化：不同机器/不同 JS 引擎的三角函数可能差最后几位，
 * 但 0.1mm 的差异不该让指纹失败。顶点缓冲直接按位哈希 —— 同一份关卡数据
 * 生成的 Float32 必须逐位一致，这里正是要抓"不一致"。
 */

export interface SceneSignature {
  /** 16 位十六进制（两个 32 位哈希拼接）。 */
  hash: string
  /** 参与哈希的 Mesh/Line 数。 */
  nodes: number
  /** 唯一几何顶点数（实例化按 count 展开）。 */
  vertices: number
  /** 唯一材质描述数。 */
  materials: number
}

/** 浮点矩阵量化步长（米）。 */
const MATRIX_STEP = 1e-4

/**
 * 双通道 32 位哈希。单通道 FNV 在几十万顶点上碰撞概率不可忽略；
 * 两个不同混合函数的 32 位拼成 64 位，足够区分两次启动。
 */
export class SceneHasher {
  private a = 0x811c9dc5
  private b = 0x9e3779b9
  private readonly scratch = new Float64Array(1)
  private readonly scratchBytes = new Uint8Array(this.scratch.buffer)

  addByte(byte: number): void {
    this.a ^= byte & 0xff
    this.a = Math.imul(this.a, 0x01000193)
    this.b ^= byte & 0xff
    this.b = Math.imul(this.b, 0x85ebca6b)
    this.b = (this.b << 13) | (this.b >>> 19)
  }

  addBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.addByte(bytes[i]!)
  }

  addNumber(value: number): void {
    this.scratch[0] = value
    this.addBytes(this.scratchBytes)
  }

  /** 矩阵/位置用：量化后按 float64 的位模式哈希。 */
  addQuantized(value: number): void {
    this.addNumber(Math.round(value / MATRIX_STEP))
  }

  addString(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      this.addByte(code & 0xff)
      this.addByte(code >>> 8)
    }
  }

  digest(): string {
    const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
    return hex(this.a) + hex(this.b)
  }
}

/** 把一组独立对象 hash 排序后合并；遍历顺序/异步加载顺序不影响结果。 */
export function combineHashes(parts: readonly string[]): string {
  const sorted = [...parts].sort()
  const hasher = new SceneHasher()
  for (const part of sorted) hasher.addString(part)
  return hasher.digest()
}
