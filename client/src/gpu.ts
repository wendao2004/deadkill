/**
 * GPU 探测：只回答"现在这张 WebGL 上下文跑在哪张卡上"。
 *
 * 浏览器**不允许网页选择显卡** —— `WebGLRenderer({ powerPreference:
 * 'high-performance' })` 只是给浏览器的一个提示，最终由操作系统/浏览器
 * 的 GPU 偏好决定（双显卡笔记本默认经常仍走核显）。所以这里不尝试"切换"，
 * 只做两件能真正改善体验的事：
 *
 * 1. 认出核显 / 软件渲染（SwiftShader / Microsoft Basic Render Driver），
 *    让画质自动落到性能档；
 * 2. 把真实 GPU 名字挂到调试探针上，玩家/维护者能确认到底跑在哪张卡。
 *
 * 想强制独显，只能在系统/浏览器层面设置（见 docs/显卡与性能.md）。
 */
import type { WebGLRenderer } from 'three'

export interface GpuInfo {
  /** 驱动报告的厂商串（可能为空）。 */
  vendor: string
  /** 驱动报告的渲染器串，例如 "ANGLE (NVIDIA ...)"。 */
  renderer: string
  /** 看起来是核显（Intel、AMD APU 等）。 */
  integrated: boolean
  /** 软件光栅化（SwiftShader / llvmpipe / Basic Render Driver）。 */
  software: boolean
  /** 看起来是独立显卡。 */
  discrete: boolean
}

/** 读不到 UNMASKED_* 时返回空串，绝不抛错。 */
export function probeGpu(gl: WebGLRenderer): GpuInfo {
  let vendor = ''
  let renderer = ''
  try {
    const context = gl.getContext()
    const ext = context.getExtension('WEBGL_debug_renderer_info')
    if (ext) {
      vendor = String(context.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? '')
      renderer = String(context.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
    }
    if (!renderer) {
      renderer = String(context.getParameter(context.RENDERER) ?? '')
    }
  } catch {
    // 隐私模式/被扩展策略拦截：信息缺失不影响渲染，按"未知"处理。
  }

  const text = `${vendor} ${renderer}`.toLowerCase()
  const software = /swiftshader|llvmpipe|softpipe|software rasterizer|basic render|microsoft basic/.test(text)
  const discrete = /nvidia|geforce|rtx|gtx|quadro|radeon rx|rx \d|arc a|arc b|apple m\d/.test(text)
  const integrated =
    !discrete &&
    (/intel|uhd|iris|hd graphics|radeon graphics|vega \d|renoir|cezanne|rembrandt|phoenix/.test(text) ||
      (vendor.toLowerCase().includes('intel')))

  return { vendor, renderer, integrated, software, discrete }
}
