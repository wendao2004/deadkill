#!/usr/bin/env node
/**
 * 全路径冒烟：主界面 → 出击 → 入场 → 暂停 → 恢复 → 放弃回大厅 → 再次出击。
 *
 * 为什么用 DOM 点击而不是直接调 `enter()`：冒烟要证明的是**玩家能走通**，
 * 包括按钮禁用状态、转场、暂停层、确认框这些只有真实点击才会经过的分支。
 *
 * 前置：`pnpm --filter @dk/server dev` 与 `pnpm --filter @dk/client dev` 已启动。
 *
 * 用法：
 *   node tools/qa-smoke.mjs
 *   node tools/qa-smoke.mjs --url http://127.0.0.1:5173/
 *
 * 退出码：0 = 全部步骤通过；1 = 某一步失败；2 = 环境/启动错误。
 *
 * 明确不做的事：**强制玩家死亡**。死亡由服务端判定，客户端没有合法入口
 * 制造一次死亡；伪造它等于测了一条游戏里不存在的路径。死亡/结算仍靠人工
 * 或后续的录像回放。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const url = readFlag('--url') ?? 'http://127.0.0.1:5173/'
const port = 9300 + Math.floor(Math.random() * 500)
const profile = mkdtempSync(join(tmpdir(), 'dkqa-smoke-'))
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
    console.error(`qa-smoke: 无法访问 ${url}（先启动 server 与 client）：${error.message}`)
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
    // 同步等待：异步 taskkill 常常在 node 进程退出后才跑完，浏览器子进程
    // 会被留在后台。无头 Chrome 一个实例就是十几个进程，漏一次能明显拖慢机器。
    spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  // 兜底：Chrome 在 Windows 上可能用另一个进程当浏览器主进程，父 PID 的
  // /T 打不到它。按 user-data-dir 反查命令行，把整套子进程一起收掉。
  if (process.platform === 'win32') {
    const listing = spawnSync(
      'wmic',
      ['process', 'where', "name='chrome.exe'", 'get', 'processid,commandline'],
      { encoding: 'utf8' },
    )
    for (const line of (listing.stdout ?? '').split('\n')) {
      if (!line.includes(profile)) continue
      const pid = line.trim().match(/(\d+)\s*$/)
      if (pid !== null) spawnSync('taskkill', ['/PID', pid[1], '/T', '/F'], { stdio: 'ignore' })
    }
  } else {
    spawnSync('pkill', ['-f', profile], { stdio: 'ignore' })
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

  return async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (reply.result?.exceptionDetails) {
      throw new Error(`页面求值失败: ${reply.result.exceptionDetails.text}`)
    }
    return reply.result?.result?.value
  }
}

async function waitFor(evaluate, expression, label, timeoutMs = 90000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(`Boolean(${expression})`)) return
    await sleep(250)
  }
  const snapshot = await evaluate(
    `JSON.stringify({inGame: window.__G ? window.__G.inGame : null, fatal: window.__fatal, errors: (window.__errors||[]).slice(0,5)})`,
  )
  throw new Error(`等待超时：${label}（${timeoutMs}ms） 当前状态 ${snapshot}`)
}

const steps = []
function pass(name) {
  steps.push(name)
  console.log(`  ✔ ${name}`)
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
      '--window-size=1280,720',
      '--hide-scrollbars',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      url,
    ],
    { stdio: 'ignore' },
  )
  const evaluate = await connect()

  console.log(`qa-smoke: ${url}`)
  await waitFor(evaluate, "document.querySelector('.dk-cta')", '主界面出击按钮出现')
  if ((await evaluate('window.__fatal')) !== null) throw new Error(`启动即 fatal: ${await evaluate('window.__fatal')}`)
  pass('主界面加载')

  await evaluate("document.querySelector('.dk-cta').click()")
  await waitFor(evaluate, 'window.__G && window.__G.game && window.__ready', '进入游戏并渲染两帧')
  if ((await evaluate('window.__G.inGame')) !== true) throw new Error('enter() 完成但 inGame 仍为 false')
  pass('出击 → 入场')

  await evaluate(
    "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))",
  )
  await waitFor(evaluate, "document.querySelector('.dk-pause.is-on')", '暂停层出现')
  pass('Esc 暂停')

  await evaluate(
    "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))",
  )
  await waitFor(evaluate, "!document.querySelector('.dk-pause.is-on')", '暂停层关闭')
  pass('Esc 恢复')

  // 放弃本局：暂停层第二颗按钮 + 原生 confirm。无头环境先把它改成 true。
  await evaluate(
    "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))",
  )
  await waitFor(evaluate, "document.querySelector('.dk-pause.is-on')", '暂停层再次出现')
  await evaluate('window.confirm = () => true')
  await evaluate(
    "document.querySelectorAll('.dk-pause__btn')[1] ? document.querySelectorAll('.dk-pause__btn')[1].click() : document.querySelector('.dk-pause__btn:not(.dk-pause__btn--primary)').click()",
  )
  await waitFor(evaluate, 'window.__G && window.__G.inGame === false', '退回主界面')
  await waitFor(evaluate, "!document.querySelector('#menu').classList.contains('is-hidden')", '主界面重新可见')
  pass('放弃本局 → 回大厅')

  await waitFor(evaluate, "document.querySelector('.dk-cta') && !document.querySelector('.dk-cta').disabled", '出击按钮重新可用')
  await evaluate("document.querySelector('.dk-cta').click()")
  await waitFor(evaluate, 'window.__G && window.__G.game && window.__ready', '第二次进入游戏')
  pass('再次出击')

  const stats = await evaluate('JSON.stringify(window.__stats())')
  const errors = await evaluate('JSON.stringify(window.__errors)')
  const parsedErrors = JSON.parse(errors)
  if (parsedErrors.length > 0) throw new Error(`控制台有 ${parsedErrors.length} 条错误: ${errors}`)
  pass('控制台无错误')
  console.log(`  stats: ${stats}`)
  console.log(`qa-smoke: 通过 ${steps.length} 步`)
}

try {
  await main()
  cleanup()
  await sleep(400)
  process.exit(0)
} catch (error) {
  console.error(`qa-smoke: FAIL ${error instanceof Error ? error.message : String(error)}`)
  cleanup()
  await sleep(400)
  process.exit(1)
}
