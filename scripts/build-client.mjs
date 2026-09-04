/**
 * 把 plugins/desk-ui/src/client/index.jsx 用 esbuild 打成 dsh 浏览器模块加载器需要的 CJS 工厂形态：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 * 外部依赖（react、@deepseek-ai/dsh-client-*）由宿主提供，不打进包。
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, 'plugins', 'desk-ui')
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const entry = path.join(pkgDir, 'src', 'client', 'index.jsx')
const outFile = path.join(pkgDir, 'lib', 'client.js')
const watch = process.argv.includes('--watch')

const externals = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*']

async function bundle() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    loader: { '.css': 'text' },
    external: externals,
    sourcemap: 'inline',
    logLevel: 'silent',
    minify: false,
    charset: 'utf8',
  })
  const code = result.outputFiles[0].text
  const wrapped = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${code}\n\t\treturn module.exports;\n\t}\n});\n`
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, wrapped)
  console.log(`[build-client] ${path.relative(root, outFile)} (${(wrapped.length / 1024).toFixed(1)} KB)`)
}

await bundle()
if (watch) {
  console.log('[build-client] watching src/client …')
  let timer
  fs.watch(path.join(pkgDir, 'src'), { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => bundle().catch((err) => console.error(err.message)), 150)
  })
}
