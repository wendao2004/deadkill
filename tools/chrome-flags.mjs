import { spawnSync } from 'node:child_process'

/**
 * 无头 QA 的浏览器启动参数。
 *
 * 为什么单独抽出来：截图、主界面截图、冒烟、基准四个工具曾经各自写死
 * `--use-angle=swiftshader`，于是**所有**截图与帧时间证据其实都是 CPU
 * 软件渲染 —— 既不能代表真实画面性能，也让“核显/独显降级”路径永远测不到。
 *
 * 默认强制真实显卡；只有显式 `QA_GPU=0`（或 CI 没有 GPU）才回退 SwiftShader。
 * 回退时 qa-bench 会跳过硬件阈值，不会把无 GPU 的 CI 判红。
 */
export function gpuLaunchArgs(platform = process.platform, env = process.env) {
  if (env.QA_GPU === '0' || env.QA_SOFTWARE === '1') {
    return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  }
  return [
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    // 双显卡机器上让 Chrome 选高性能适配器（Windows 上是否生效取决于驱动/系统策略）。
    '--force_high_performance_gpu',
    // Windows 走 D3D11；其它平台交给 ANGLE 的 GL 后端。
    `--use-angle=${platform === 'win32' ? 'd3d11' : 'gl'}`,
    // GPU 初始化失败时不要静默落到 CPU：宁可测试失败，也不要在错误的前提下验收。
    '--disable-software-rasterizer',
    '--disable-gpu-sandbox',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
  ]
}

/** 从 __stats() 的 gpu 文案判断是否仍在软件渲染。 */
export function isSoftwareGpu(label) {
  return /软件|swiftshader|llvmpipe|software rasterizer|basic render/i.test(String(label ?? ''))
}

/**
 * 杀掉一次 QA 启动带来的整棵 Chrome 进程树。
 *
 * 只杀 spawn 返回的父 PID 不够：Windows 上 Chrome 可能让另一个进程当浏览器主
 * 进程，父 PID 的 `/T` 打不到；无头一个实例就是十几个进程，漏一次就会在后台
 * 累积，占内存和 GPU。这里按 `--user-data-dir` 的临时 profile 反查命令行兜底。
 */
const killedProfiles = new Set()

export function killChromeTree(child, profile) {
  if (child !== null && child !== undefined) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  if (!profile || killedProfiles.has(profile)) return
  killedProfiles.add(profile)
  if (process.platform === 'win32') {
    const escaped = String(profile).replace(/'/g, "''")
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 8000,
    })
  } else {
    spawnSync('pkill', ['-f', profile], { stdio: 'ignore' })
  }
}

/**
 * 给 QA 脚本装上“无论如何都清理”的钩子：正常退出、异常、Ctrl+C 都收掉浏览器。
 * 返回的 cleanup 仍应由脚本自己在成功/失败路径调用（信号钩子只是兜底）。
 */
export function installChromeCleanup(getChild, profile) {
  const cleanup = () => killChromeTree(getChild(), profile)
  process.once('exit', cleanup)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanup()
      process.exit(1)
    })
  }
  return cleanup
}
