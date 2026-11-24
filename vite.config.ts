import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mkcert from 'vite-plugin-mkcert'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

// Read plugin config from package.json
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'))
const PLUGIN_NAME: string = pkg.config.pluginName
const LOADER_PATH: string = pkg.config.loaderPath
const PLUGINS_DIR = path.resolve(LOADER_PATH, 'plugins', PLUGIN_NAME)
const EXPECTED_JS_FILES = new Set(['index.js', 'app.js'])
const MAX_ARTIFACT_SIZE = 8 * 1024 * 1024

/**
 * Pengu Loader Dev Server Plugin
 * - Generates an index.js entry in the plugins directory
 * - Points to the local Vite dev server for HMR
 */
function penguServe(): Plugin {
  let port: number

  return {
    name: 'pengu-serve',
    apply: 'serve',

    configureServer(server) {
      server.httpServer?.on('listening', () => {
        const addr = server.httpServer!.address()
        if (addr && typeof addr === 'object') {
          port = addr.port
        }

        // Ensure plugins directory exists
        fs.mkdirSync(PLUGINS_DIR, { recursive: true })

        // Write dev entry index.js
        // React Fast Refresh requires both the React preamble and `@vite/client`.
        // Since Pengu loads the module directly instead of via Vite-transformed HTML,
        // we must install the preamble manually before importing React modules.
        const devEntry = [
          `const reactPreamble = import("https://localhost:${port}/@react-refresh").then(({ injectIntoGlobalHook }) => {`,
          `  injectIntoGlobalHook(window);`,
          `  window.$RefreshReg$ = () => {};`,
          `  window.$RefreshSig$ = () => (type) => type;`,
          `  window.__vite_plugin_react_preamble_installed__ = true;`,
          `}).catch(e => {`,
          `  console.error("[Sona] Failed to install react preamble:", e);`,
          `  throw e;`,
          `});`,
          `const viteClient = reactPreamble.then(() => import("https://localhost:${port}/@vite/client")).catch(e => {`,
          `  console.error("[Sona] Failed to load vite client:", e);`,
          `  throw e;`,
          `});`,
          `const pluginModule = () => viteClient.then(() => import("https://localhost:${port}/src/index.tsx")).catch(e => {`,
          `  console.error("[Sona] Failed to load plugin module:", e);`,
          `  throw e;`,
          `});`,
          ``,
          `export function init(context) {`,
          `//  console.log("[Sona] init called");`,
          `  pluginModule().then(m => m.init(context)).catch(e => console.error("[Sona] init error:", e));`,
          `}`,
          ``,
          `export function load() {`,
          `//  console.log("[Sona] load called");`,
          `  pluginModule().then(m => m.load?.()).catch(e => console.error("[Sona] load error:", e));`,
          `}`,
        ].join('\n')

        fs.writeFileSync(path.join(PLUGINS_DIR, 'index.js'), devEntry)
        console.log(`\n  ⚡ Pengu plugin "${PLUGIN_NAME}" dev entry generated`)
        console.log(`  📁 ${PLUGINS_DIR}\n`)
      })
    },

    // Transform asset paths in non-JS files to point to dev server
    transform(code, id) {
      if (/\.(ts|tsx|js|jsx)$/.test(id)) return
      return code.replaceAll('/src/', `https://localhost:${port}/src/`)
    },
  }
}

/**
 * Pengu Loader Build Plugin
 * - 产出冻结引导器 index.js 与可更新应用包 app.js / app.css
 * - 生成 version.json / update.json，并校验自动更新契约
 * - Copies build output to plugins directory
 */
function penguBuild(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'pengu-build',
    apply: 'build',

    configResolved(resolvedConfig) {
      config = resolvedConfig
    },

    closeBundle() {
      const outDir = path.resolve(config.build.outDir)
      const builtAt = Date.now()
      const appPath = path.join(outDir, 'app.js')
      const cssPath = path.join(outDir, 'app.css')
      const entryPath = path.join(outDir, 'index.js')

      // Remove index.html (not needed for plugins)
      const htmlPath = path.join(outDir, 'index.html')
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath)

      if (!fs.existsSync(appPath)) throw new Error('[pengu-build] 缺少 app.js，检查 Vite 多入口配置')
      if (!fs.existsSync(cssPath)) throw new Error('[pengu-build] 缺少 app.css，检查 CSS 输出配置')
      if (!fs.existsSync(entryPath)) throw new Error('[pengu-build] 缺少引导器 index.js')

      // app.js：改写资源路径 + 版本 banner（CSS 由引导器注入，绝不在此 import）
      let app = fs.readFileSync(appPath, 'utf-8')
      app = app.replaceAll('"/assets/', `"//plugins/${PLUGIN_NAME}/assets/`)
      app = app.replaceAll("'/assets/", `'//plugins/${PLUGIN_NAME}/assets/`)
      app = buildAppBanner(builtAt) + app
      fs.writeFileSync(appPath, app)

      // app.css：相对资源路径（内置资源仍应内联，构建校验会兜底）
      let css = fs.readFileSync(cssPath, 'utf-8')
      css = css.replaceAll('url(/assets/', 'url(./assets/')
      fs.writeFileSync(cssPath, css)

      // index.js：Pengu 插件头注释
      const entry = fs.readFileSync(entryPath, 'utf-8')
      fs.writeFileSync(entryPath, buildEntryBanner() + entry)

      assertBuildLayout(outDir)

      // version.json：本地版本（引导器读取；builtAt 用于 CSS 缓存击穿）
      fs.writeFileSync(
        path.join(outDir, 'version.json'),
        `${JSON.stringify({ version: pkg.version, builtAt }, null, 2)}\n`,
      )

      // update.json：发布到 dist-v<version> 标签的更新清单
      fs.writeFileSync(
        path.join(outDir, 'update.json'),
        `${JSON.stringify({
          version: pkg.version,
          files: {
            'app.js': describeArtifact(appPath),
            'app.css': describeArtifact(cssPath),
          },
        }, null, 2)}\n`,
      )

      // Copy build output to plugins directory (skip if it's the project root)
      const projectRoot = path.resolve(__dirname)
      if (path.resolve(PLUGINS_DIR) === projectRoot) {
        copyDirSync(outDir, projectRoot)
        console.log(`\n  ✅ Plugin "${PLUGIN_NAME}" built in-place (project root)\n`)
      } else {
        if (fs.existsSync(PLUGINS_DIR)) fs.rmSync(PLUGINS_DIR, { recursive: true })
        fs.mkdirSync(PLUGINS_DIR, { recursive: true })
        copyDirSync(outDir, PLUGINS_DIR)
        console.log(`\n  ✅ Plugin "${PLUGIN_NAME}" built to ${PLUGINS_DIR}\n`)
      }
    },
  }
}

function buildAppBanner(builtAt: number): string {
  return [
    '/**',
    ' * Sona application bundle',
    ` * @version ${pkg.version}`,
    ` * @builtAt ${builtAt}`,
    ' */',
    '',
  ].join('\n')
}

function buildEntryBanner(): string {
  return [
    '/**',
    ' * @name Sona',
    ` * @version ${pkg.version}`,
    ' * @description 基于 Pengu Loader 的全服可用英雄联盟客户端增强插件',
    ' * @author gyyst',
    ' * @link https://github.com/gyyst/sona',
    ' */',
    '',
  ].join('\n')
}

function describeArtifact(filePath: string): { sha256: string; size: number } {
  const buffer = fs.readFileSync(filePath)
  if (buffer.byteLength > MAX_ARTIFACT_SIZE) {
    throw new Error(`[pengu-build] ${path.basename(filePath)} 超过 8 MB，更新清单拒绝该文件`)
  }
  return { sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.byteLength }
}

function listFiles(dir: string, prefix = ''): string[] {
  const result: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...listFiles(path.join(dir, entry.name), relativePath))
    else result.push(relativePath)
  }
  return result
}

/** 构建不变量：任何违反自动更新契约的产物都必须让构建失败 */
function assertBuildLayout(outDir: string) {
  const files = listFiles(outDir)
  const unexpectedJs = files.filter((file) => file.endsWith('.js') && !EXPECTED_JS_FILES.has(file))
  if (unexpectedJs.length > 0) {
    throw new Error(`[pengu-build] 出现共享 chunk 或预期外 JS：${unexpectedJs.join(', ')}`)
  }

  const assetsDir = path.join(outDir, 'assets')
  if (fs.existsSync(assetsDir) && listFiles(assetsDir).length > 0) {
    throw new Error('[pengu-build] dist/assets 中存在外部资源；自动更新负载必须是纯文本')
  }

  const app = fs.readFileSync(path.join(outDir, 'app.js'), 'utf-8')
  if (/(?:import|from)\s*["'][^"']+\.css["']/.test(app)) {
    throw new Error('[pengu-build] app.js 中仍存在 CSS import；CSS 必须由引导器注入')
  }
  if (/["']\/assets\//.test(app)) {
    throw new Error('[pengu-build] app.js 中仍存在 /assets/ 绝对路径；资源路径改写失败')
  }

  const css = fs.readFileSync(path.join(outDir, 'app.css'), 'utf-8')
  if (/url\(\s*["']?[^)"']*assets\//.test(css)) {
    throw new Error('[pengu-build] app.css 引用了外部 assets 资源；内置资源必须内联')
  }
}

function copyDirSync(src: string, dest: string) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true })
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export default defineConfig({
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  plugins: [
    react(),
    mkcert(),
    penguServe(),
    penguBuild(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    https: {},
    origin: 'https://localhost:3000',// 必须加这个，否则引入图片资源等会失败
  },
  build: {
    outDir: 'dist',
    cssCodeSplit: false,
    lib: {
      entry: {
        app: path.resolve(__dirname, 'src/index.tsx'),
        index: path.resolve(__dirname, 'src/bootstrap/index.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      output: {
        manualChunks: undefined,
        chunkFileNames: 'chunk-[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith('.css'))) return 'app.css'
          return 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
  publicDir: false,
})
