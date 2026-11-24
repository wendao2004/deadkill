/**
 * 固定路径基准：`?bench=1` 绕玩家 360° 巡游 600 帧，读 __bench。
 *
 * 用法：
 *   node tools/qa-bench.mjs --url "http://localhost:5173/?bench=1&q=quality&seed=4207&noaudio=1"
 *   node tools/qa-bench.mjs --p99 22 --avg 15
 *
 * 软件渲染（SwiftShader/llvmpipe/软件）只打印警告，不按硬件阈值失败：
 * CI 容器没有 GPU，用硬件阈值会把所有 PR 判红。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gpuLaunchArgs, installChromeCleanup, isSoftwareGpu, killChromeTree } from './chrome-flags.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const readFlag = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}
const url =
  readFlag('--url') ??
  // `localhost` 而非 `127.0.0.1`：Vite 在 IPv6 优先的机器上只监听 `::1`。
  'http://localhost:5173/?bench=1&q=performance&seed=4207&noaudio=1&scale=1&dt=16.67'
const width = Number(readFlag('--w') ?? 1280)
const height = Number(readFlag('--h') ?? 720)
const p99Limit = Number(readFlag('--p99') ?? 25)
const avgLimit = Number(readFlag('--avg') ?? 16.7)
const maxHitches = Number(readFlag('--max-hitches') ?? 0)
const outJson = readFlag('--out')
/** 软件渲染默认只警告；CI 需要“必须是独显”时传 --require-gpu，跳过时退出 3。 */
const requireGpu = process.argv.includes('--require-gpu')
/** 允许动态分辨率改档（默认不允许：基准必须固定 scale 才能跨版本比较）。 */
const allowAdaptive = process.argv.includes('--allow-adaptive')
const timeoutMs = Number(readFlag('--timeout') ?? 300000)
const port = 9500 + Math.floor(Math.random() * 300)
const profile = mkdtempSync(join(tmpdir(), 'dkqa-bench-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let chrome = null
let ws = null
function cleanup() {
  try { ws?.close() } catch {}
  killChromeTree(chrome, profile)
  ws = null
}
installChromeCleanup(() => chrome, profile)

async function preflight() {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (error) {
    console.error(`qa-bench: 无法访问 ${url}（先启动 server 与 client）：${error.message}`)
    process.exit(2)
  }
}

async function connect() {
  let target = null
  for (let i = 0; i < 120 && target === null; i++) {
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
  await new Promise((resolve) => { ws.onopen = resolve })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const next = ++id
      pending.set(next, resolve)
      ws.send(JSON.stringify({ id: next, method, params }))
    })
  await send('Runtime.enable')
  await send('Page.enable')
  try { await send('Page.bringToFront') } catch {}
  try { await send('Page.setWebLifecycleState', { state: 'active' }) } catch {}
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.text)
    return reply.result?.result?.value
  }
  return { evaluate, send }
}

async function main() {
  await preflight()
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    `--window-size=${width},${height}`, '--hide-scrollbars',
    ...gpuLaunchArgs(),
    '--autoplay-policy=no-user-gesture-required', url,
  ], { stdio: 'ignore' })
  const { evaluate, send } = await connect()
  // 钉住视口：--window-size 只是外框，实际 canvas 会少掉浏览器边框。
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.reload')
  await sleep(500)
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate('window.__benchDone === true')) break
    if (await evaluate('window.__fatal !== null && window.__fatal !== undefined')) {
      throw new Error(`启动 fatal: ${await evaluate('String(window.__fatal)')}`)
    }
    await sleep(300)
  }
  if (!(await evaluate('window.__benchDone === true'))) {
    const debug = await evaluate(`JSON.stringify({
      href: location.href,
      ready: window.__ready,
      fatal: window.__fatal,
      errors: (window.__errors ?? []).slice(0, 5),
      inGame: window.__G ? window.__G.inGame : null,
      benchDone: window.__benchDone ?? null,
      bench: window.__bench ?? null,
      stats: window.__G && window.__G.game ? window.__G.game.diagnostics() : null,
      samples: window.__G && window.__G.game ? window.__G.game.benchSamples.length : null,
      benchFlag: window.__G && window.__G.game ? window.__G.game.benchDone : null,
      qaBench: window.__G && window.__G.qa ? window.__G.qa.bench : null,
      qaSource: window.__G && window.__G.qa ? window.__G.qa.source : null,
      benchAngle: window.__G && window.__G.game ? window.__G.game.benchAngle : null,
      frames: window.__G && window.__G.game ? window.__G.game.frameNow : null,
    })`)
    throw new Error(`基准超时（${timeoutMs}ms）：__benchDone 未置真 · ${debug}`)
  }
  const result = await evaluate('window.__bench')
  const errors = await evaluate('JSON.stringify(window.__errors ?? [])')
  const stats = await evaluate('JSON.stringify(window.__stats())')
  console.log(JSON.stringify({ bench: result, errors: JSON.parse(errors), stats: JSON.parse(stats) }, null, 2))

  const statsObj = JSON.parse(stats)
  const gpuName = String(statsObj?.gpuName ?? result?.gpuName ?? '')
  const gpuLabel = String(result?.gpu ?? '')
  const software = isSoftwareGpu(gpuName) || isSoftwareGpu(gpuLabel)
  let failed = false
  if (software || (requireGpu && gpuName.trim() === '')) {
    if (requireGpu) {
      console.error(`qa-bench: SKIPPED —— 要求独显，但当前是 ${gpuName || gpuLabel || '未知 GPU'}`)
      process.exitCode = 3
      return
    }
    console.warn(`qa-bench: 软件渲染（${gpuName || gpuLabel}），跳过硬件阈值`)
  } else {
    if (Number(result?.p99) > p99Limit) {
      console.error(`qa-bench: p99 ${result.p99}ms > ${p99Limit}ms`)
      failed = true
    }
    // 0.5ms 容差：vsync 下 16.67/16.8 的采样抖动不该把一次正常基准判红。
    if (Number(result?.avg) > avgLimit + 0.5) {
      console.error(`qa-bench: avg ${result.avg}ms > ${avgLimit}ms（+0.5ms 容差）`)
      failed = true
    }
    if (Number(result?.hitches) > maxHitches) {
      console.error(`qa-bench: hitches ${result.hitches} > ${maxHitches}（>50ms 的帧）`)
      failed = true
    }
  }
  const errorsArr = JSON.parse(errors)
  if (errorsArr.length > 0) {
    console.error(`qa-bench: __errors 非空（${errorsArr.length}）`)
    failed = true
  }
  // 基准必须固定分辨率：balanced/performance 档本来就有 0.85/0.65 的
  // 固定上限，scale 不一定是 1；关键是 governor 没有在采样期改档。
  // QA URL 仍应带 scale=1&dt=16.67，让实际 scale = 本档固定上限。
  const scale = Number(statsObj?.scale ?? NaN)
  const upscales = Number(statsObj?.resolution?.upscales ?? 0)
  const downscales = Number(statsObj?.resolution?.downscales ?? 0)
  const qualityDrops = Number(statsObj?.resolution?.qualityDrops ?? 0)
  if (!allowAdaptive && (upscales > 0 || downscales > 0 || qualityDrops > 0)) {
    console.error(
      `qa-bench: 动态分辨率改档（scale=${scale}, up=${upscales}, down=${downscales}, drops=${qualityDrops}）；` +
        '基准 URL 请加 scale=1&dt=16.67，或显式 --allow-adaptive',
    )
    failed = true
  }
  if (outJson) {
    writeFileSync(
      outJson,
      JSON.stringify(
        {
          url,
          width,
          height,
          bench: result,
          stats: statsObj,
          errors: errorsArr,
        },
        null,
        2,
      ),
    )
    console.log(`qa-bench: wrote ${outJson}`)
  }
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error('qa-bench:', error.message)
  process.exitCode = 1
}).finally(cleanup)
