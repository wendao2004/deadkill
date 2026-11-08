import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * 客户端构建配置。
 *
 * 两个必须在这里定死的东西：
 *
 * 1. `base: './'` —— 产物会被宿主（WebLearning）挂在 `/game/` 这样的子路径下，
 *    而不是站根。绝对路径 `/assets/...` 会让它在子路径下 404。
 * 2. `worker`/`target` —— Rapier 的 WASM 是内联 base64 的 `compat` 版，
 *    不需要 wasm 插件；但它是 4MB 的 JS，必须让 Vite 单独切一个 chunk，
 *    否则每次改一行 HUD 代码，开发模式下都要重新编译这 4MB。
 */
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    proxy: {
      // 开发时同源：客户端只会写 `/ws/game`，由 Vite 转给本地服务端。
      // 这样 ws 的 URL 构造逻辑在开发和部署两种环境下完全一致
      // （部署时由宿主反代，客户端代码不用改）。
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Rapier 的 WASM 是 base64 内联在 JS 里的，单它就有 3MB 以上。
    // 不切开的话整个游戏是一个 5MB 的 chunk：改一行 HUD 文案，
    // 浏览器要重新下载并重新解析这 5MB。切出来之后物理包可以长期缓存。
    //
    // 注意 manualChunks 必须是函数：Vite 8 的打包器是 rolldown 而不是
    // rollup，对象形式（{ rapier: [...] }）会直接报
    // "Invalid type: Expected Function but received Object" 并中止构建。
    rollupOptions: {
      // 多页入口：游戏主页面 + 地图编辑器。编辑器是纯 2D canvas，
      // 不引 three/rapier，单独一个 chunk，不会拖慢游戏首包。
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        editor: fileURLToPath(new URL('./editor.html', import.meta.url)),
      },
      output: {
        manualChunks(id: string) {
          if (id.includes('@dimforge/rapier3d-compat')) return 'rapier'
          if (id.includes('/three/') || id.includes('\\three\\')) return 'three'
          return undefined
        },
      },
    },
    chunkSizeWarningLimit: 6000,
  },
  esbuild: {
    // 生产产物里不留注释；调试信息靠 sourcemap。
    legalComments: 'none',
  },
})
