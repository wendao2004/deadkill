/**
 * 固定路径基准：`?bench=1` 绕玩家 360° 巡游 600 帧，读 __bench。
 *
 * 用法：
 *   node tools/qa-bench.mjs --url "http://127.0.0.1:5173/?bench=1&q=quality&seed=4207&noaudio=1"
 *   node tools/qa-bench.mjs --p99 22 --avg 15
 *
 * 软件渲染（SwiftShader/llvmpipe/软件）只打印警告，不按硬件阈值失败：
 * CI 容器没有 GPU，用硬件阈值会把所有 PR 判红。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
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
  'http://127.0.0.1:5173/?bench=1&q=performance&seed=4207&noaudio=1&scale=1&dt=16.67'
const width = Number(readFlag('--w') ?? 1280)
const height = Number(readFlag('--h') ?? 720)
const p99Limit = Number(readFlag('--p99') ?? 25)
const avgLimit = Number(readFlag('--avg') ?? 16.7)
/** 软件渲染默认只警告；CI 需要“必须是独显”时传 --require-gpu，跳过时退出 3。 */
const requireGpu = process.argv.includes('--require-gpu')
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
  return async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.text)
    return reply.result?.result?.value
  }
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
  const evaluate = await connect()
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
  }
  const errorsArr = JSON.parse(errors)
  if (errorsArr.length > 0) {
    console.error(`qa-bench: __errors 非空（${errorsArr.length}）`)
    failed = true
  }
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error('qa-bench:', error.message)
  process.exitCode = 1
}).finally(cleanup)
