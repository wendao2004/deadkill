#!/usr/bin/env node
/**
 * 定点截图：打开一个固定参数的 URL，等 `window.__shotReady` 后存 PNG，
 * 并把 `__stats()` 一起打到标准输出（画质对比/回归时随手可用）。
 *
 * 前置：`pnpm --filter @dk/server dev` 与 `pnpm --filter @dk/client dev` 已启动。
 *
 * 用法：
 *   node tools/qa-shot.mjs --out shot.png --url "http://localhost:5173/?autostart=1&shot=1&show=weapon"
 *   node tools/qa-shot.mjs --out a.png --w 1600 --h 900 --url "...&map=pinery"
 *
 * 等待条件只有两个：`window.__shotReady === true` 与 `window.__stats()` 可读，
 * 不用固定 sleep —— 软件渲染下页面可能只有 2~3 fps，sleep 会拍到半成品。
 *
 * 退出码：0 = 拍到图；1 = 页面报错/超时；2 = 环境问题。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gpuLaunchArgs, installChromeCleanup, isSoftwareGpu, killChromeTree } from './chrome-flags.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const url = readFlag('--url') ?? 'http://localhost:5173/?autostart=1&shot=1&show=weapon'
const out = readFlag('--out') ?? 'shot.png'
const width = Number(readFlag('--w') ?? 1280)
const height = Number(readFlag('--h') ?? 720)
const port = 9600 + Math.floor(Math.random() * 300)
const profile = mkdtempSync(join(tmpdir(), 'dkqa-shot-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readFlag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

const expectLevel = readFlag('--expect-level')
const expectModifierRaw = readFlag('--expect-modifier')
const expectModifier = expectModifierRaw === null ? null : Number(expectModifierRaw)

/** PNG IHDR 宽高：截图落盘前确认不是 1584×749 这种“窗口边框版”。 */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function sidecarPath(pngPath) {
  return pngPath.toLowerCase().endsWith('.png') ? pngPath.slice(0, -4) + '.json' : pngPath + '.json'
}

function assertHealthy(stats) {
  if (!stats) throw new Error('__stats() 不可读')
  if (stats.fatal) throw new Error(`__fatal: ${stats.fatal}`)
  if (Number(stats.errors) > 0) throw new Error(`__errors=${stats.errors}`)
  if (Number(stats.kernelErrors) > 0) throw new Error(`kernelErrors=${stats.kernelErrors}`)
}

async function preflight() {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (error) {
    console.error(`qa-shot: 无法访问 ${url}（先启动 server 与 client）：${error.message}`)
    process.exit(2)
  }
}

let chrome = null
let ws = null

function cleanup() {
  try {
    ws?.close()
  } catch {}
  // 杀掉浏览器后再断开 CDP，避免 WS 重连拖住进程退出。
  killChromeTree(chrome, profile)
  ws = null
}
// 正常/异常路径由 main 调用 cleanup；这里兜底 Ctrl+C 与意外退出。
installChromeCleanup(() => chrome, profile)

async function connect() {
  let target = null
  for (let i = 0; i < 160 && target === null; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page' && entry.url.startsWith('http')) ?? null
    } catch {}
    if (target === null) await sleep(200)
  }
  if (target === null) throw new Error('Chrome 没有给出页面 target')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  await new Promise((resolve) => {
    ws.onopen = resolve
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const next = ++id
      pending.set(next, resolve)
      ws.send(JSON.stringify({ id: next, method, params }))
    })
  await send('Runtime.enable')
  await send('Page.enable')

  return {
    send,
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (reply.result?.exceptionDetails) {
        throw new Error(`页面求值失败: ${reply.result.exceptionDetails.text}`)
      }
      return reply.result?.result?.value
    },
  }
}

async function main() {
  await preflight()
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      ...gpuLaunchArgs(),
      '--autoplay-policy=no-user-gesture-required',
      url,
    ],
    { stdio: 'ignore' },
  )
  const page = await connect()

  // 钉住视口再重载：--window-size 是外框，直接截会少掉浏览器边框的高度，
  // 产出 1584×749 而不是 1600×900；qa-diff 会因尺寸不同直接失败。
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await page.send('Page.reload')
  await sleep(500)

  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (await page.evaluate('window.__shotReady === true')) break
    if (await page.evaluate('Boolean(window.__fatal)')) {
      throw new Error(`页面 fatal: ${await page.evaluate('window.__fatal')}`)
    }
    await sleep(250)
  }
  if (!(await page.evaluate('window.__shotReady === true'))) {
    const snapshot = await page.evaluate(
      'JSON.stringify({fatal: window.__fatal, errors: (window.__errors||[]).slice(0,5)})',
    )
    throw new Error(`等待 __shotReady 超时：${snapshot}`)
  }

  const stats = await page.evaluate('JSON.stringify(window.__stats ? window.__stats() : null)')
  const parsed = stats === null ? null : JSON.parse(stats)
  assertHealthy(parsed)
  // GPU 模式下的静默回退是最坏的：截图看起来正常，但所有性能/画质判断都建立在 CPU 上。
  if (process.env.QA_GPU !== '0' && isSoftwareGpu(parsed?.gpu)) {
    throw new Error(`期望独显但仍在软件渲染：${parsed?.gpu ?? 'unknown'}（QA_GPU=0 才允许 CPU）`)
  }
  if (expectLevel !== null && parsed.levelId !== expectLevel) {
    throw new Error(`期望关卡 ${expectLevel}，实际 ${parsed.levelId}`)
  }
  if (expectModifier !== null && Number(parsed.modifier) !== expectModifier) {
    throw new Error(`期望天气 ${expectModifier}，实际 ${parsed.modifier}`)
  }
  const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const data = shot.result?.data
  if (!data) throw new Error('截图返回为空')
  const png = Buffer.from(data, 'base64')
  const size = pngSize(png)
  if (!size || size.width !== width || size.height !== height) {
    throw new Error(`截图尺寸 ${size?.width ?? '?'}x${size?.height ?? '?'}，期望 ${width}x${height}`)
  }
  writeFileSync(out, png)
  writeFileSync(
    sidecarPath(out),
    JSON.stringify(
      {
        file: out,
        width: size.width,
        height: size.height,
        gpu: parsed.gpuName ?? parsed.gpu,
        levelId: parsed.levelId,
        modifier: parsed.modifier,
        modifierHour: parsed.modifierHour,
        seed: parsed.seed,
        quality: parsed.quality,
        scale: parsed.scale,
        calls: parsed.calls,
        triangles: parsed.triangles,
        programs: parsed.programs,
        textures: parsed.textures,
        sceneHash: parsed.scene?.hash,
        errors: parsed.errors,
        kernelErrors: parsed.kernelErrors,
      },
      null,
      2,
    ),
  )
  console.log(`qa-shot: ${out} ${size.width}x${size.height}`)
  console.log(`qa-shot: stats ${stats}`)
  console.log(`qa-shot: sidecar ${sidecarPath(out)}`)
}

main()
  .then(() => {
    cleanup()
    process.exit(0)
  })
  .catch((error) => {
    console.error(`qa-shot: ${error.message}`)
    cleanup()
    process.exit(1)
  })
