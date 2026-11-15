#!/usr/bin/env node
/**
 * QA 截图对比：同一机位、同一 seed 的两张 PNG 差多少。
 *
 * 为什么自己解 PNG 而不装 sharp/canvas：
 * 1. 仓库的运行时依赖是刻意压到最小的（Three + Rapier + Fastify），
 *    QA 工具不该为了看一眼像素就拖进一个 native 依赖；
 * 2. 只需要 Chrome `Page.captureScreenshot` 产出的 8-bit RGB/RGBA、非隔行 PNG，
 *    用 `node:zlib` 解 IDAT 就够，PNG 规范里这几条格式很稳定。
 *
 * 用法：
 *   node tools/qa-diff.mjs before.png after.png
 *   node tools/qa-diff.mjs before.png after.png --threshold 0.01 --tolerance 12
 *   node tools/qa-diff.mjs before.png after.png --json
 *
 * 退出码：0 = 在阈值内；1 = 超出阈值；2 = 参数/解码错误。
 *
 * 指标说明：
 * - `ratio`：有差异的像素占比。比"平均色差"更接近人眼判断 —— 整屏轻微偏色
 *   与一个小物体挪位，平均值可能相同，但后者通常才是回归。
 * - `mean`：平均通道绝对差（0..255），用来描述"整体偏了多少"。
 * - `max`：最大通道差，用来区分"噪点/抖动"与"真的少了一块几何"。
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** 解 8-bit、非隔行、RGB/RGBA 的 PNG（Chrome 截图就是这两种）。 */
function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是 PNG 文件')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (width <= 0 || height <= 0) throw new Error('PNG 缺少 IHDR')
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  if (bitDepth !== 8) throw new Error(`不支持 bitDepth=${bitDepth}（只支持 8）`)

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) {
    throw new Error(`不支持 colorType=${colorType}（只支持 RGB=2 / RGBA=6）`)
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      switch (filter) {
        case 0:
          break
        case 1:
          v = (v + a) & 0xff
          break
        case 2:
          v = (v + b) & 0xff
          break
        case 3:
          v = (v + ((a + b) >> 1)) & 0xff
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          v = (v + pr) & 0xff
          break
        }
        default:
          throw new Error(`未知的 PNG 行过滤器 ${filter}（行 ${y}）`)
      }
      cur[x] = v
    }
    prev = cur
  }
  return { width, height, channels, pixels: out }
}

/**
 * 逐像素比较。只看 RGB：Chrome 截图的 alpha 恒为 255，把它算进去只会稀释信号。
 *
 * `tolerance` 是"单通道差超过多少才算一个坏像素"。默认 8/255 用来吃掉
 * 颗粒/抖动/压缩带来的 ±2~3 波动；要看更细的差别就把它调小。
 * `threshold` 是允许的坏像素占比，和 tolerance 是两个独立的旋钮。
 */
function compare(a, b, tolerance) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`尺寸不同：${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const total = a.width * a.height
  let diffPixels = 0
  let sum = 0
  let max = 0
  let ax = 0
  let bx = 0
  for (let i = 0; i < total; i++) {
    let pixelMax = 0
    for (let ch = 0; ch < 3; ch++) {
      const d = Math.abs(a.pixels[ax + ch] - b.pixels[bx + ch])
      sum += d
      if (d > pixelMax) pixelMax = d
    }
    if (pixelMax > max) max = pixelMax
    if (pixelMax > tolerance) diffPixels++
    ax += a.channels
    bx += b.channels
  }
  return {
    width: a.width,
    height: a.height,
    pixels: total,
    diffPixels,
    ratio: diffPixels / total,
    mean: sum / (total * 3),
    max,
    tolerance,
  }
}

function parseArgs(argv) {
  const files = []
  let threshold = 0.002
  let tolerance = 8
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--threshold') {
      threshold = Number(argv[++i])
    } else if (arg.startsWith('--threshold=')) {
      threshold = Number(arg.slice('--threshold='.length))
    } else if (arg === '--tolerance') {
      tolerance = Number(argv[++i])
    } else if (arg.startsWith('--tolerance=')) {
      tolerance = Number(arg.slice('--tolerance='.length))
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      files.length = 0
      break
    } else {
      files.push(arg)
    }
  }
  return { files, threshold, tolerance, json }
}

const { files, threshold, tolerance, json } = parseArgs(process.argv.slice(2))
if (files.length !== 2 || !Number.isFinite(threshold) || !Number.isFinite(tolerance)) {
  console.error(
    '用法: node tools/qa-diff.mjs <before.png> <after.png> [--threshold 0.002] [--tolerance 8] [--json]',
  )
  process.exit(2)
}

try {
  const before = decodePng(readFileSync(files[0]))
  const after = decodePng(readFileSync(files[1]))
  const result = compare(before, after, Math.max(0, tolerance))
  const pass = result.ratio <= threshold
  if (json) {
    console.log(JSON.stringify({ ...result, pass }, null, 2))
  } else {
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${result.width}x${result.height}  ` +
        `差异像素 ${result.diffPixels}/${result.pixels} (${(result.ratio * 100).toFixed(3)}%)  ` +
        `平均差 ${result.mean.toFixed(3)}  最大差 ${result.max}  ` +
        `通道容差 ${result.tolerance}  占比阈值 ${(threshold * 100).toFixed(2)}%`,
    )
  }
  process.exit(pass ? 0 : 1)
} catch (error) {
  console.error(`qa-diff: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
