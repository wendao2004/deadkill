#!/usr/bin/env node
/**
 * 主界面定点截图。
 *
 * `?shot=1` 会隐含 `autostart`（qa.ts 的设计：验收要跑真实启动链），
 * 所以主界面拍不到。这里单独等 `.dk-menu` 出场动画结束再截，
 * 其余连接/清理逻辑与 `qa-shot.mjs` 一致。
 *
 * 用法：
 *   node tools/qa-menu-shot.mjs --out menu.png --w 1440 --h 900
 *   node tools/qa-menu-shot.mjs --out menu-arsenal.png --pane arsenal
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gpuLaunchArgs, installChromeCleanup, killChromeTree } from './chrome-flags.mjs'

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const base = readFlag('--url') ?? 'http://localhost:5173/?noaudio=1&q=quality'
const out = readFlag('--out') ?? 'menu.png'
const width = Number(readFlag('--w') ?? 1440)
const height = Number(readFlag('--h') ?? 900)
const pane = readFlag('--pane')
/** 进内页前先点首页第几项（0=进入沼泽 1=庇护所 2=设置）；null = 停在首页。 */
const home = readFlag('--home') === null ? null : Number(readFlag('--home'))
/** 出击向导当前步（1 = 地图，2 = 组队，3 = 房间）：点几次"下一步"。 */
const step = readFlag('--step') === null ? null : Number(readFlag('--step'))
/** 按下「进入猎场」，截黑场里的标题卡（它在真进场后 1~3s 内就没了）。 */
const stageShot = process.argv.includes('--stage')
const port = 9600 + Math.floor(Math.random() * 300)
const profile = mkdtempSync(join(tmpdir(), 'dkqa-menu-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readFlag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function sidecarPath(pngPath) {
  return pngPath.toLowerCase().endsWith('.png') ? pngPath.slice(0, -4) + '.json' : pngPath + '.json'
}

async function preflight() {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (error) {
    console.error(`qa-menu-shot: 无法访问 ${base}（先启动 client）：${error.message}`)
    process.exit(2)
  }
}

let chrome = null
let ws = null

function cleanup() {
  try {
    ws?.close()
  } catch {}
  killChromeTree(chrome, profile)
  ws = null
}
installChromeCleanup(() => chrome, profile)

async function connect() {
  let target = null
  for (let i = 0; i < 200 && target === null; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page' && entry.url.startsWith('http')) ?? null
    } catch {}
    if (target === null) await sleep(200)
  }
  if (target === null) throw new Error('没有连上 Chrome 的调试端口')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
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
      '--no-sandbox',
      `--window-size=${width},${height}`,
      ...gpuLaunchArgs(),
      '--autoplay-policy=no-user-gesture-required',
      '--hide-scrollbars',
      base,
    ],
    { stdio: 'ignore' },
  )

  await connect()

  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const next = ++id
      pending.set(next, resolve)
      ws.send(JSON.stringify({ id: next, method, params }))
    })

  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return result.result?.result?.value ?? result.result?.exceptionDetails?.text
  }

  // 昵称引导层会盖住整个菜单。预置存档是首选（reload 后仍然有效），
  // 但 headless 下首次导航时机不稳，所以再加一道"实在弹出来了就填掉"的兜底。
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluate(`(() => {
    localStorage.setItem('dk.nickname', 'QA')
    localStorage.setItem('dk.matchId', 'qa')
    localStorage.setItem('dk.coins', '480')
    return localStorage.getItem('dk.nickname')
  })()`)
  await send('Page.reload')
  await sleep(1200)
  await evaluate(`(() => {
    const onboard = document.querySelector('.dk-menu.is-onboarding .dk-onboard')
    if (!onboard) return false
    const input = onboard.querySelector('input')
    const confirm = onboard.querySelector('.dk-onboard__confirm')
    if (input) {
      input.value = 'QA'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (confirm) confirm.click()
    return true
  })()`)

  // 菜单入场动画（logo 860ms + 导航 300ms+）跑完再截；软件渲染下再宽限几帧。
  for (let i = 0; i < 240; i++) {
    const ready = await evaluate(
      `(() => {
         const menu = document.querySelector('.dk-menu')
         if (!menu || menu.classList.contains('is-hidden')) return false
         const logo = document.querySelector('.dk-logo')
         if (!logo) return false
         return getComputedStyle(logo).opacity === '1' && !!document.querySelector('.dk-pane.is-active')
       })()`,
    )
    if (ready === true) break
    await sleep(250)
  }

  if (home !== null) {
    await evaluate(
      `(() => {
         const items = [...document.querySelectorAll('.dk-home__item')]
         const target = items[${home}]
         if (target) target.click()
         return !!target
       })()`,
    )
    await sleep(700)
  }

  if (step !== null && step > 1) {
    for (let i = 1; i < step; i++) {
      await evaluate(`(() => {
        const next = document.querySelector('.dk-step-next')
        if (next) next.click()
        return !!next
      })()`)
      await sleep(600)
    }
  }

  if (pane !== null) {
    await evaluate(
      `(() => {
         const target = document.querySelector('#dk-tab-' + ${JSON.stringify(pane)})
         if (target) target.click()
         return !!target
       })()`,
    )
    await sleep(700)
  }

  if (stageShot) {
    await evaluate(`(() => {
      const cta = document.querySelector('.dk-cta')
      if (cta) cta.click()
      return !!cta
    })()`)
    // 标题卡在 iris 收满（820ms）之后才逐行浮出，1020ms 截最稳。
    await sleep(1020)
  } else {
    await sleep(900)
  }

  const stats = await evaluate('JSON.stringify(window.__stats ? window.__stats() : null)')
  const errors = JSON.parse((await evaluate('JSON.stringify(window.__errors ?? [])')) ?? '[]')
  const fatal = await evaluate('window.__fatal ?? null')
  if (fatal) throw new Error(`__fatal: ${fatal}`)
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`__errors=${errors.length}: ${errors[0]}`)
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const data = shot.result?.data
  if (!data) throw new Error('截图失败：没有返回图像数据')
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
        state: stats === null ? null : JSON.parse(stats).state,
        errors: 0,
      },
      null,
      2,
    ),
  )
  console.log(`qa-menu-shot: ${out} ${size.width}x${size.height}`)
  if (stats) console.log(`qa-menu-shot: stats ${stats}`)
  console.log(`qa-menu-shot: sidecar ${sidecarPath(out)}`)
}

main()
  .catch((error) => {
    console.error(`qa-menu-shot: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(cleanup)
