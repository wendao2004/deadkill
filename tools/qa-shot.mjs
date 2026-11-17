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

async function preflight() {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
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
  if (chrome !== null) {
    spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  }
}

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
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      url,
    ],
    { stdio: 'ignore' },
  )
  const page = await connect()

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
  const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const data = shot.result?.data
  if (!data) throw new Error('截图返回为空')
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(`qa-shot: ${out} ${width}x${height}`)
  console.log(`qa-shot: stats ${stats}`)
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
