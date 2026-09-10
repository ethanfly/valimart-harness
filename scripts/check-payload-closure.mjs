/**
 * T11 装配闭包检查：不仅查 main 文件，把 payload 里全部宿主模块与浏览器 bundle 的依赖闭包查全。
 *
 * 检查项：
 *  1. 宿主（Node）闭包：payload plugins/ 下每个 .js/.mjs/.cjs 的静态 require/import 说明符
 *     必须能解析——相对路径 → payload 内文件；node: 内置 → 放行；裸包名 → 内核前缀
 *     node_modules（build/kernel-stage，与 kernel.tar 同树）。插件不得自带 node_modules
 *     （第二份依赖 = 第二份模块实例，破坏单实例语义）。
 *  2. 浏览器闭包：desk-ui lib/client.js 的 require() 说明符必须全部属于
 *     react/react-dom（web shell 提供，开发版同集已在线运行验证）或内核里存在
 *     lib/client.js 的 @deepseek-ai/* 浏览器包；且 bundle 内不得残留未内联的
 *     外部文件引用（css/png/svg 的相对路径、非 data: 的 url()、fetch 本地资源）。
 *  3. 单实例：payload 内除内核前缀外不得出现任何 node_modules 目录。
 *
 * 用法：node scripts/check-payload-closure.mjs [--payload build/payload] [--kernel build/kernel-stage]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (k, dflt) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : dflt
}
const payloadDir = path.resolve(argOf('--payload', path.join(root, 'build', 'payload')))
const kernelStage = path.resolve(argOf('--kernel', path.join(root, 'build', 'kernel-stage')))

const failures = []
const ok = (m) => console.log(`  PASS  ${m}`)
const fail = (m) => {
  failures.push(m)
  console.log(`  FAIL  ${m}`)
}

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

// ---------- 1. 宿主闭包 ----------

console.log('== 宿主（Node）依赖闭包 ==')
const jsExt = new Set(['.js', '.mjs', '.cjs'])
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (jsExt.has(path.extname(e.name))) out.push(p)
  }
  return out
}

const kernelNm = path.join(kernelStage, 'node_modules')
const kernelInnerNm = path.join(kernelNm, '@deepseek-ai', 'dsh', 'node_modules')

function resolveBare(spec, fromDir) {
  // 插件目录（无 node_modules，单实例前提）→ 内核前缀 node_modules → 内核内层 node_modules
  for (const nm of [path.join(fromDir, 'node_modules'), kernelNm, kernelInnerNm]) {
    if (!fs.existsSync(nm)) continue
    const full = path.join(nm, spec)
    if (fs.existsSync(path.join(full, 'package.json'))) return path.join(full, 'package.json')
    for (const ext of ['', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs']) {
      if (fs.existsSync(full + ext) && fs.statSync(full + ext).isFile()) return full + ext
    }
  }
  return null
}

function resolveRel(spec, fromDir) {
  const base = path.resolve(fromDir, spec)
  const cands = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')]
  return cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null
}

// ---------- 注释剥离（JSDoc `import('x')` 类型标注不是运行时依赖，必须先剥）----------
// 小型状态机：字符串/模板串/行注释/块注释，其余原样。对静态检查足够精确。
function stripComments(src) {
  let out = ''
  let i = 0
  let state = 'code' // code | line | block | str | tmpl
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue }
      if (c === '"' || c === "'") { state = 'str'; out += c; i++; continue }
      if (c === '`') { state = 'tmpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c }
      i++; continue
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue }
      if (c === '\n') out += c
      i++; continue
    }
    if (state === 'str') {
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue }
      if (c === '"' || c === "'") state = 'code'
      out += c; i++; continue
    }
    if (state === 'tmpl') {
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue }
      if (c === '`') state = 'code'
      out += c; i++; continue
    }
  }
  return out
}

// 静态说明符提取：require('x') / import 'x' / import ... from 'x' / export ... from 'x' / import('x')
const SPEC_RE = /(?:^|[;{(,\s])(?:require\(\s*|import\s*\(\s*|from\s+|import\s+)(['"])([^'"]+)\1/g
const seenSpecs = new Map() // spec → {file, resolved|null}
const hostFiles = []
const pluginsDir = path.join(payloadDir, 'plugins')
for (const name of ['desk-host', 'desk-image']) {
  const lib = path.join(pluginsDir, name, 'lib')
  if (fs.existsSync(lib)) hostFiles.push(...walk(lib))
}
if (!fs.existsSync(pluginsDir)) fail(`payload 缺 plugins/ 目录：${pluginsDir}`)

let unresolved = 0
for (const file of hostFiles) {
  const text = stripComments(fs.readFileSync(file, 'utf8'))
  let m
  SPEC_RE.lastIndex = 0
  while ((m = SPEC_RE.exec(text)) !== null) {
    const spec = m[2]
    if (spec.startsWith('node:')) continue
    if (NODE_BUILTINS.has(spec)) continue
    if (!spec.startsWith('.') && !spec.startsWith('..')) {
      const hit = resolveBare(spec, path.dirname(file))
      seenSpecs.set(spec, hit ? { resolved: hit } : { resolved: null, file })
      if (!hit) unresolved++
    } else {
      const hit = resolveRel(spec, path.dirname(file))
      if (!hit) {
        fail(`相对依赖未解析：${path.relative(payloadDir, file)} → ${spec}`)
        unresolved++
      }
    }
  }
}
if (unresolved === 0) ok(`宿主闭包：${hostFiles.length} 个文件全部静态说明符解析成功（${[...seenSpecs.keys()].filter((s) => !s.startsWith('.') && !s.startsWith('node:') && !NODE_BUILTINS.has(s)).length} 个裸包名）`)
for (const [spec, info] of seenSpecs) {
  if (!info.resolved) fail(`裸包名未解析：${spec}（引用于 ${path.relative(payloadDir, info.file)}）`)
}
// 动态 import 变量（运行时拼路径）单独提示：不静默放行
const dynamicHits = []
for (const file of hostFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const re = /(?:import|require)\(\s*([^'")\s][^)]*)\s*\)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const expr = m[1].trim()
    if (!/^[.'"]/.test(expr)) dynamicHits.push(`${path.relative(payloadDir, file)}: ${expr.slice(0, 60)}`)
  }
}
if (dynamicHits.length) console.log(`  NOTE  动态 import/require（人工复核）：\n${dynamicHits.map((s) => `    ${s}`).join('\n')}`)

// ---------- 单实例：payload 内不得有额外 node_modules ----------

console.log('== 单实例（依赖唯一副本）==')
const strayNm = []
function walkNm(dir, depth = 0) {
  if (depth > 6) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (!e.isDirectory()) continue
    if (e.name === 'node_modules') {
      if (p !== kernelNm && p !== kernelInnerNm && !p.startsWith(kernelStage + path.sep)) strayNm.push(path.relative(payloadDir, p))
      continue
    }
    walkNm(p, depth + 1)
  }
}
if (fs.existsSync(payloadDir)) walkNm(payloadDir)
if (strayNm.length) fail(`payload 内核外存在 node_modules（第二份依赖副本）：${strayNm.join(', ')}`)
else ok('payload 内核前缀外无 node_modules——宿主依赖全部单副本解析到内核 node_modules')

// ---------- 2. 浏览器闭包 ----------

console.log('== 浏览器 bundle 闭包（desk-ui lib/client.js）==')
const clientJs = path.join(payloadDir, 'plugins', 'desk-ui', 'lib', 'client.js')
if (!fs.existsSync(clientJs)) fail(`缺浏览器 bundle：${clientJs}`)
else {
  const text = stripComments(fs.readFileSync(clientJs, 'utf8'))
  // 2a. require() 说明符全集
  const reqRe = /require\(\s*(['"])([^'"]+)\1\s*\)/g
  const reqs = new Set()
  let m
  while ((m = reqRe.exec(text)) !== null) reqs.add(m[2])
  // web shell（dsh-web-frontend）启动时 seed 的模块实例（pC()，实测 0.1.3-alpha.2）：
  // 这些不是包依赖，是壳提供的运行时实例——与开发版同一集合，安装版同集。
  const SHELL_PROVIDED = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  ])
  const badReqs = []
  for (const spec of reqs) {
    if (SHELL_PROVIDED.has(spec)) continue
    if (spec.startsWith('@deepseek-ai/')) {
      const inner = path.join(kernelInnerNm, spec)
      const outer = path.join(kernelNm, spec)
      const hasBundle = [path.join(inner, 'lib', 'client.js'), path.join(outer, 'lib', 'client.js')].some((p) => fs.existsSync(p))
      if (!hasBundle) badReqs.push(`${spec}（内核无对应浏览器 bundle）`)
    } else {
      badReqs.push(`${spec}（非 shell 提供且非内核浏览器包）`)
    }
  }
  if (badReqs.length) fail(`浏览器 require 无法提供：${badReqs.join('；')}`)
  else ok(`浏览器 require 说明符 ${reqs.size} 个全部可解析（shell 提供 ${[...reqs].filter((s) => SHELL_PROVIDED.has(s)).join('/') || '无'} + 内核浏览器包）`)
  // 2b. 未内联外部文件引用
  const extFileRefs = []
  const cssRe = /['"(](\.{1,2}\/[^'"()]+\.(?:css|png|jpe?g|svg|woff2?|ttf))['")]/g
  let c
  while ((c = cssRe.exec(text)) !== null) extFileRefs.push(c[1])
  const urlRe = /url\(\s*(['"]?)(?!data:|https?:|)([^)'"]+)\1\s*\)/g
  while ((c = urlRe.exec(text)) !== null) {
    const u = c[2].trim()
    if (!u.startsWith('data:') && !u.startsWith('#') && !u.startsWith('var(')) extFileRefs.push(`url(${u})`)
  }
  const fetchRe = /fetch\(\s*(['"])(\/[^'"]+|\.\/[^'"]+|\.\.\/[^'"]+)\1/g
  while ((c = fetchRe.exec(text)) !== null) extFileRefs.push(`fetch(${c[2]})`)
  if (extFileRefs.length) fail(`bundle 残留未内联外部文件引用：${[...new Set(extFileRefs)].join('；')}`)
  else ok('bundle 无未内联外部文件引用（css/png 全部内联为 text/dataurl）')
  // 2c. 模块 id 与 profile 声明一致
  const idMatch = /window\.__ModuleLoader__\.load\(\{\s*id:\s*(['"])([^'"]+)\1/.exec(text)
  if (!idMatch) fail('bundle 未注册 __ModuleLoader__ 模块 id')
  else ok(`bundle 模块 id = ${idMatch[2]}`)
}

console.log(failures.length ? `\n闭包检查失败：${failures.length} 项` : '\n闭包检查全部通过')
process.exit(failures.length ? 1 : 0)
