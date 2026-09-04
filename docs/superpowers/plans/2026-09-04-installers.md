# THE DIVA 安装包（客户端 + 服务端）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付两个不依赖目标机器有 Node 的 Windows 安装包：`THE-DIVA-Setup-<ver>.exe`（Electron 桌面客户端，按用户安装）与 `THE-DIVA-Gateway-Setup-<ver>.exe`（公司网关，注册为 Windows 服务）。

**Architecture:** Electron 只做窗口与进程编排；内核（打好 16 处补丁的 `@deepseek-ai/dsh` 前缀）以 `kernel.tar` 随包，首次启动用 Windows 自带 `tar.exe` 解到 `~/.company-desk/app/kernel`，再用随包的 `node.exe` 跑内核。`launch.mjs` / `setup-profile.mjs` 的编排逻辑抽到 `scripts/lib/bootstrap.mjs`，开发模式与安装版共用。服务端 = `node.exe` + `server/` + WinSW，NSIS 脚本只做复制与调用，配置生成放在可测试的 `init.mjs` 里。

**Tech Stack:** Node 26（`node:test`、`fs.cpSync`、`fetch`）、Electron 44 + electron-builder 26（NSIS 目标）、Windows `tar.exe`（bsdtar）、WinSW 2.12.0（.NET461 版）、NSIS 3（复用 electron-builder 缓存的 makensis）。

设计文档：`docs/superpowers/specs/2026-09-04-installers-design.md`。

## Global Constraints

- 仓库根 `package.json` 只有 `esbuild` 一个 devDependency；Electron / electron-builder 只能放在 `desktop/package.json`。服务端源码（`server/src/**`）不改。
- 内核锁定 `@deepseek-ai/dsh@0.1.1-rc.2`（`scripts/kernel/pin.json`），补丁 16 处，只能通过 `scripts/kernel/patches.mjs` 的 `applyKernelPatches` / `missingPatches` 处理，不手改内核文件。
- 目标机器：Windows 10 1803+ / Windows 11 x64。客户端首次启动**不联网**。
- 路径：客户端安装到 `%LOCALAPPDATA%\Programs\THE DIVA`（按用户，不提权）；运行期可变状态全部在 `~/.company-desk/app`、`~/.company-desk/logs`、`~/.dsh`。服务端安装到 `%ProgramFiles%\THE DIVA Gateway`，数据在 `%ProgramData%\THE DIVA Gateway\{data,logs}`，卸载保留。
- 命名：产品 `THE DIVA` / `THE DIVA Gateway`；服务 id `TheDivaGateway`；appId `team.ethan.thediva`；dsh profile 安装版 `desk-app`、开发版 `desk`；端口客户端 3470（顺延）、网关 8790。
- 所有提交信息用中文、UTF-8；本机 shell 是 Windows PowerShell 5.1（**不支持 `&&`**，多条命令用 `;`；含中文的 commit 用 `git commit -F <utf8 文件>`）。
- npm 11.19 默认跳过依赖的 install 脚本：安装 Electron 要 `--allow-scripts=electron`。
- 测试：`npm test` = `node --test server/test/*.test.js scripts/test/*.test.mjs`，必须保持全绿；测试只用临时目录，不碰 `server/data/`、`~/.dsh`、`~/.company-desk/kernel`。
- 本机已就位：`~/.company-desk/kernel`（16 处补丁齐）、仓库 `node_modules`（esbuild）、Electron 40.10.2 zip 缓存（`%LOCALAPPDATA%\electron\Cache`，若 44.1.1 下载过慢可改 pin）。网络经代理较慢（200 MB 约 17 分钟）。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `scripts/lib/bootstrap.mjs`（新） | 启动编排库：`findFreePort`、`waitHttp`、`readGatewayUrl`、`linkJunction`、`profileNeedsSetup`、`ensureProfile`、`ensureKernelDev`、`ensureBundle`、`spawnClient`、`killTree`、`findTar`、`pinSkillsRoot`、`preparePackaged`；作为 CLI 时 `--packaged` 输出 NDJSON |
| `scripts/lib/payload.mjs`（新） | 纯函数：`shouldPrune`、`patchGatewayUrl`、`makeBuildId`、`digestFiles` |
| `scripts/launch.mjs`、`scripts/setup-profile.mjs`（改） | 变成 bootstrap 的薄壳，行为不变 |
| `scripts/build-payload.mjs`（新） | 暂存 `build/payload/`：node.exe、kernel.tar（修剪 + 校验）、plugins、profile、scripts、payload.json |
| `scripts/build-client-installer.mjs`（新） | 用根版本号调用 `desktop/` 里的 electron-builder |
| `scripts/build-gateway-installer.mjs`（新） | 暂存 `build/gateway/`、下载校验 WinSW、找 makensis、出网关安装包 |
| `scripts/make-icon.mjs`（新） | 一次性：SVG → `desktop/build/icon.png`（512）+ `icon.ico`（256，PNG 封装） |
| `desktop/package.json`、`main.js`、`splash.html`、`electron-builder.yml`、`build/icon.*`（新） | Electron 子项目 |
| `installer/gateway.nsi`、`installer/gateway/init.mjs`、`installer/gateway/TheDivaGateway.xml.tpl`、`installer/pins.json`（新） | 网关安装包 |
| `scripts/test/bootstrap.test.mjs`、`payload.test.mjs`、`gateway-init.test.mjs`（新） | 单元测试 |
| `package.json`、`.gitignore`、`README.md`、`docs/HANDOFF.md`、`docs/sessions/2026-09-04.md`（改） | 脚本入口、忽略、文档 |

---

### Task 1: 抽出 `scripts/lib/bootstrap.mjs`，`launch.mjs` / `setup-profile.mjs` 改成薄壳

**Files:**
- Create: `scripts/lib/bootstrap.mjs`
- Create: `scripts/test/bootstrap.test.mjs`
- Modify: `scripts/launch.mjs`（第 46-86 行内核 / profile / bundle 段、第 109-121 行 `waitHttp`、第 157-172 行 `startClient`）
- Modify: `scripts/setup-profile.mjs`（整文件）
- Modify: `package.json`（`test` 脚本）

**Interfaces:**
- Produces（后续任务依赖的签名）：
  - `findFreePort(preferred = 3470, tries = 10): Promise<number>`
  - `waitHttp(url, { timeoutMs = 30000, label = url, intervalMs = 300 }): Promise<true>`，超时 `throw Error`
  - `readGatewayUrl(patchFile, fallback = 'http://127.0.0.1:8790'): string`（去尾斜杠）
  - `linkJunction(linkPath, target): 'kept' | 'linked'`
  - `profileNeedsSetup({ profileDir, patchFile }): boolean`
  - `ensureProfile({ profileName, dshHome, root, pluginsDir, patchFile, kernel, nodeExe = process.execPath, selfHeal = true, log }): { profileDir, flatDir }`
  - `ensureKernelDev({ prefix, dshHome, verify = false, log }): { root, bin, version }`
  - `ensureBundle({ log }): string`（bundle 路径）
  - `spawnClient({ nodeExe = process.execPath, kernelBin, profileName, port, dshHome, cwd, env = process.env, stdio = 'inherit' }): ChildProcess`
  - `killTree(child): void`
  - `findTar(): string`
  - `repoRoot: string`（本文件所在 `scripts/lib` 的上两级：仓库根，或安装版 payload 根）

- [ ] **Step 1: 写失败的测试 `scripts/test/bootstrap.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ensureProfile, findFreePort, profileNeedsSetup, readGatewayUrl } from '../lib/bootstrap.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diva-bootstrap-'))

test('findFreePort：首选端口被占就顺延', async () => {
  const srv = net.createServer()
  await new Promise((r) => srv.listen({ port: 0, host: '127.0.0.1' }, r))
  const busy = srv.address().port
  try {
    const p = await findFreePort(busy, 5)
    assert.notEqual(p, busy)
    assert.ok(p > busy && p < busy + 5, `期望 ${busy + 1}..${busy + 4}，得到 ${p}`)
  } finally {
    srv.close()
  }
})

test('findFreePort：首选端口空闲就用它', async () => {
  const srv = net.createServer()
  await new Promise((r) => srv.listen({ port: 0, host: '127.0.0.1' }, r))
  const free = srv.address().port
  await new Promise((r) => srv.close(r))
  assert.equal(await findFreePort(free, 3), free)
})

test('readGatewayUrl：从 cordis.patch.yml 里读 gatewayUrl 并去尾斜杠', () => {
  const dir = tmp()
  const f = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(f, "- insert:\n    - id: desk-host\n      config:\n        gatewayUrl: 'http://gw.local:8790/'\n")
  assert.equal(readGatewayUrl(f), 'http://gw.local:8790')
  fs.writeFileSync(f, '- id: x\n')
  assert.equal(readGatewayUrl(f, 'http://fallback:1'), 'http://fallback:1')
})

test('profileNeedsSetup：缺文件 / 补丁内容变了都要重装', () => {
  const dir = tmp()
  const patchFile = path.join(dir, 'repo.patch.yml')
  fs.writeFileSync(patchFile, 'a: 1\n')
  const profileDir = path.join(dir, 'profile')
  assert.equal(profileNeedsSetup({ profileDir, patchFile }), true)
  fs.mkdirSync(path.join(profileDir, 'node_modules', '@company-desk', 'desk-ui'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), 'a: 1\n')
  assert.equal(profileNeedsSetup({ profileDir, patchFile }), false)
  fs.writeFileSync(patchFile, 'a: 2\n')
  assert.equal(profileNeedsSetup({ profileDir, patchFile }), true)
})

test('ensureProfile：写 manifest、链接插件与 dsh 回退目录（selfHeal=false）', () => {
  const dir = tmp()
  const dshHome = path.join(dir, 'dsh')
  const flat = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  fs.mkdirSync(flat, { recursive: true })
  const root = path.join(dir, 'root')
  const pluginsDir = path.join(root, 'plugins')
  for (const p of ['desk-host', 'desk-ui']) fs.mkdirSync(path.join(pluginsDir, p), { recursive: true })
  const patchFile = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(patchFile, "gatewayUrl: 'http://x:1'\n")
  const logs = []
  const { profileDir, flatDir } = ensureProfile({ profileName: 'desk-test', dshHome, root, pluginsDir, patchFile, kernel: { bin: 'unused' }, selfHeal: false, log: (m) => logs.push(m) })
  assert.equal(profileDir, path.join(dshHome, 'profiles', 'desk-test'))
  assert.equal(flatDir, flat)
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-profile-desk-test')
  assert.match(manifest.dependencies['@company-desk/desk-host'], /^file:.*plugins\/desk-host$/)
  assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), "gatewayUrl: 'http://x:1'\n")
  assert.ok(fs.lstatSync(path.join(profileDir, 'node_modules', '@company-desk', 'desk-ui')).isSymbolicLink())
  assert.ok(fs.lstatSync(path.join(root, 'node_modules', '@deepseek-ai')).isSymbolicLink())
  assert.ok(fs.existsSync(path.join(dshHome, 'desk')))
  // 再跑一次：链接保持
  ensureProfile({ profileName: 'desk-test', dshHome, root, pluginsDir, patchFile, kernel: { bin: 'unused' }, selfHeal: false, log: (m) => logs.push(m) })
  assert.ok(logs.some((l) => /desk-ui kept/.test(l)))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/test/bootstrap.test.mjs`
Expected: 失败，`Cannot find module '.../scripts/lib/bootstrap.mjs'`

- [ ] **Step 3: 写 `scripts/lib/bootstrap.mjs`（开发模式部分）**

```js
/**
 * THE DIVA 启动编排库 —— launch.mjs / setup-profile.mjs（开发）与 desktop/main.js（安装版）共用。
 *
 * 开发模式：内核在 --prefix（默认 ~/.company-desk/kernel），缺了跑 install-kernel.mjs；profile 名 desk；插件链接到仓库 plugins/。
 * 安装版（--packaged，见 preparePackaged）：内核从 payload/kernel.tar 解到 ~/.company-desk/app/kernel；profile 名 desk-app；永不联网。
 *
 * 作为 CLI（安装版的 Electron 主进程用随包 node.exe 调用）：
 *   node scripts/lib/bootstrap.mjs --packaged --payload <dir> --app-dir <dir> [--dsh-home <dir>]
 * stdout 每行一个 JSON：{ step, status, detail }，最后一行 { step: "ready", kernelBin, profileName, ... }。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PIN, locateKernel, stampPath } from '../kernel/locate.mjs'
import { ALL_MARKS, KernelPatchError, applyKernelPatches, missingPatches } from '../kernel/patches.mjs'

export const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（开发模式）或 payload 根（安装版）：本文件永远在 <root>/scripts/lib/ 下。 */
export const repoRoot = path.resolve(here, '..', '..')

const noop = () => {}

// ---------- 通用 ----------

/** 首选端口空闲就用它，否则顺延 tries 个，再不行拿一个随机空闲端口。 */
export async function findFreePort(preferred = 3470, tries = 10) {
  const probe = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.unref()
      srv.once('error', () => resolve(false))
      srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)))
    })
  for (let p = preferred; p < preferred + tries; p++) if (await probe(p)) return p
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 轮询到 HTTP 可达（任何 < 500 的状态都算），超时抛错。 */
export async function waitHttp(url, { timeoutMs = 30000, label = url, intervalMs = 300 } = {}) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status < 500) return true
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${label} ${timeoutMs / 1000}s 内没有就绪`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 从 profile/cordis.patch.yml 里读 desk-host 的 gatewayUrl。 */
export function readGatewayUrl(patchFile, fallback = 'http://127.0.0.1:8790') {
  const m = /gatewayUrl:\s*'([^']+)'/.exec(fs.readFileSync(patchFile, 'utf8'))
  return (m?.[1] ?? fallback).replace(/\/+$/, '')
}

/** Windows 上用 junction（不需要开发者模式）；已指向同一目标则保留。 */
export function linkJunction(linkPath, target) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      if (path.resolve(fs.readlinkSync(linkPath)) === path.resolve(target)) return 'kept'
      fs.unlinkSync(linkPath)
    } else if (st.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true })
    } else fs.unlinkSync(linkPath)
  } catch {
    /* 不存在 */
  }
  fs.symlinkSync(target, linkPath, 'junction')
  return 'linked'
}

/** Windows 10 1803+ 自带 bsdtar；找不到就抛错。 */
export function findTar() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (fs.existsSync(sys)) return sys
  }
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tar'], { stdio: 'pipe', encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split(/\r?\n/)[0].trim()
  throw new Error('找不到 tar.exe（需要 Windows 10 1803 及以上，或自行安装 bsdtar）')
}

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
}

// ---------- profile ----------

/** profile 缺文件、缺插件链接、或补丁内容与仓库不一致 → 需要重装。 */
export function profileNeedsSetup({ profileDir, patchFile }) {
  const profilePatch = path.join(profileDir, 'cordis.patch.yml')
  return (
    !fs.existsSync(profilePatch) ||
    !fs.existsSync(path.join(profileDir, 'node_modules', '@company-desk', 'desk-ui')) ||
    fs.readFileSync(profilePatch, 'utf8') !== fs.readFileSync(patchFile, 'utf8')
  )
}

/**
 * 安装 / 刷新一个 dsh profile：
 *   <dshHome>/profiles/<profileName>/{package.json, pnpm-workspace.yaml, cordis.patch.yml, node_modules/@company-desk/*}
 * 并让 <root>/node_modules/@deepseek-ai 指向 dsh 的扁平回退目录（插件靠它解析 dsh 内置包）。
 * selfHeal=true 时先跑一次 `dsh --dump-default-config` 让 dsh 创建回退目录（需要真内核）。
 */
export function ensureProfile({ profileName, dshHome, root, pluginsDir, patchFile, kernel, nodeExe = process.execPath, selfHeal = true, log = noop }) {
  const profileDir = path.join(dshHome, 'profiles', profileName)
  fs.mkdirSync(profileDir, { recursive: true })
  const manifest = {
    name: `dsh-profile-${profileName}`,
    private: true,
    description: 'THE DIVA · 企业交付工作台（company-desk）',
    dependencies: {
      '@company-desk/desk-host': `file:${path.join(pluginsDir, 'desk-host').replace(/\\/g, '/')}`,
      '@company-desk/desk-ui': `file:${path.join(pluginsDir, 'desk-ui').replace(/\\/g, '/')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  fs.copyFileSync(patchFile, path.join(profileDir, 'cordis.patch.yml'))
  log(`profile: ${profileDir}`)
  for (const name of ['desk-host', 'desk-ui']) {
    const r = linkJunction(path.join(profileDir, 'node_modules', '@company-desk', name), path.join(pluginsDir, name))
    log(`@company-desk/${name} ${r}`)
  }

  const flatDir = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  if (selfHeal) {
    try {
      execFileSync(nodeExe, [kernel.bin, '--profile', profileName, '--dump-default-config'], { stdio: 'ignore', env: { ...process.env, DSH_HOME: dshHome } })
    } catch (err) {
      log(`dsh 自检未通过（继续）：${err.message}`)
    }
  }
  if (!fs.existsSync(flatDir)) throw new Error(`缺少 dsh 扁平回退目录 ${flatDir}，请先成功启动一次 dsh。`)
  const r = linkJunction(path.join(root, 'node_modules', '@deepseek-ai'), flatDir)
  log(`node_modules/@deepseek-ai → ${flatDir} (${r})`)
  fs.mkdirSync(path.join(dshHome, 'desk'), { recursive: true })
  return { profileDir, flatDir }
}

// ---------- 开发模式 ----------

/** 开发模式内核：缺了就跑 install-kernel.mjs（要网络）；verify=true 时即使装好了也跑一遍（幂等校验 + 补缺的补丁）。 */
export function ensureKernelDev({ prefix, dshHome, verify = false, log = noop }) {
  let kernel = locateKernel(prefix)
  if (!kernel || verify) {
    if (!kernel) log(`${prefix} 里还没有 dsh 内核，先安装（需要网络）…`)
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'install-kernel.mjs'), '--prefix', prefix, '--dsh-home', dshHome], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('内核安装 / 校验失败')
    kernel = locateKernel(prefix)
    if (!kernel) throw new Error(`内核安装后仍找不到：${prefix}`)
  }
  return kernel
}

function newestMtime(dir) {
  let t = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs)
  }
  return t
}

/** 开发模式：desk-ui 源码比 bundle 新就重新打包。 */
export function ensureBundle({ log = noop } = {}) {
  const bundle = path.join(repoRoot, 'plugins', 'desk-ui', 'lib', 'client.js')
  const srcDir = path.join(repoRoot, 'plugins', 'desk-ui', 'src')
  if (!fs.existsSync(bundle) || fs.statSync(bundle).mtimeMs < newestMtime(srcDir)) {
    log('构建客户端 bundle …')
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-client.mjs')], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('build-client 失败')
  }
  return bundle
}

// ---------- 起客户端 ----------

export function spawnClient({ nodeExe = process.execPath, kernelBin, profileName, port, dshHome, cwd = process.cwd(), env = process.env, stdio = 'inherit' }) {
  return spawn(nodeExe, [kernelBin, '--profile', profileName, '--no-open', '--port', String(port)], { cwd, stdio, env: { ...env, DSH_HOME: dshHome }, windowsHide: true })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/test/bootstrap.test.mjs`
Expected: `# pass 5`，`# fail 0`

- [ ] **Step 5: `scripts/launch.mjs` 改成薄壳**

把第 20-23 行的导入改为：

```js
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultDshHome, defaultPrefix } from './kernel/locate.mjs'
import { ensureBundle, ensureKernelDev, ensureProfile, killTree, profileNeedsSetup, readGatewayUrl, spawnClient, waitHttp } from './lib/bootstrap.mjs'
```

把第 46-89 行（`// ---------- 0. 内核 ----------` 到 `const gatewayUrl = ...`）整段替换为：

```js
// ---------- 0. 内核 ----------
let kernel
try {
  kernel = ensureKernelDev({ prefix, dshHome, log })
} catch (err) {
  die(err.message)
}
const dshBin = kernel.bin

// ---------- 1. profile ----------
const profileDir = path.join(dshHome, 'profiles', 'desk')
const repoPatch = path.join(root, 'profile', 'cordis.patch.yml')
if (profileNeedsSetup({ profileDir, patchFile: repoPatch })) {
  log('安装/刷新 desk profile …')
  try {
    ensureProfile({ profileName: 'desk', dshHome, root, pluginsDir: path.join(root, 'plugins'), patchFile: repoPatch, kernel, log: (m) => log(`[profile] ${m}`) })
  } catch (err) {
    die(`setup-profile 失败：${err.message}`)
  }
}

// ---------- 2. 客户端 bundle ----------
try {
  ensureBundle({ log })
} catch (err) {
  die(err.message)
}

// ---------- 3. 网关地址 ----------
const gatewayUrl = (argOf('--gateway') ?? process.env.DESK_GATEWAY_URL ?? readGatewayUrl(repoPatch)).replace(/\/+$/, '')
```

把 `shutdown()` 里的循环体（原第 96-103 行）替换为 `for (const c of children) killTree(c)`。删掉原第 109-121 行的本地 `waitHttp`（用库里的），`ensureGateway` 里 `await waitHttp(health, { label: '网关' })` 外面套 `try { … } catch (err) { die(err.message) }`。`startClient()` 替换为：

```js
function startClient() {
  log(`启动客户端 ${url} …`)
  const child = spawnClient({ kernelBin: dshBin, profileName: 'desk', port, dshHome, cwd: root })
  children.push(child)
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[launch] 客户端退出（${code}）`)
      shutdown(code ?? 1)
    }
  })
  return waitHttp(url, { label: '客户端', timeoutMs: 60000 }).catch((err) => die(err.message))
}
```

`spawnSync` 只在 `openDesktopWindow`/`findBrowser` 里还用得到 → 导入保留 `spawn, spawnSync`。

- [ ] **Step 6: `scripts/setup-profile.mjs` 改成薄壳（整文件）**

```js
/**
 * 安装 THE DIVA 的 dsh profile（名为 desk）：
 *   $DSH_HOME/profiles/desk/{package.json, cordis.patch.yml, node_modules/@company-desk/*}
 * 并让本仓库的插件能解析到 dsh 内置包（company-desk/node_modules/@deepseek-ai → dsh 的扁平回退目录）。
 *
 * 内核：先跑 scripts/install-kernel.mjs（幂等）——把锁定版本的 @deepseek-ai/dsh 装进独立前缀并打公司补丁；
 * 已装好时只是校验一遍。不需要任何别的仓库。逻辑在 scripts/lib/bootstrap.mjs。
 * 用法：node scripts/setup-profile.mjs [--prefix <dir>] [--dsh-home <dir>]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDshHome, defaultPrefix } from './kernel/locate.mjs'
import { ensureKernelDev, ensureProfile } from './lib/bootstrap.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (k) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
const prefix = path.resolve(argOf('--prefix') ?? defaultPrefix())
const dshHome = path.resolve(argOf('--dsh-home') ?? defaultDshHome())
const log = (m) => console.log(`[setup-profile] ${m}`)

try {
  const kernel = ensureKernelDev({ prefix, dshHome, verify: true, log })
  ensureProfile({ profileName: 'desk', dshHome, root, pluginsDir: path.join(root, 'plugins'), patchFile: path.join(root, 'profile', 'cordis.patch.yml'), kernel, log })
  log(`完成。启动：node scripts/launch.mjs（或 node "${kernel.bin}" --profile desk --no-open）`)
} catch (err) {
  console.error(`[setup-profile] ${err.message}`)
  process.exit(1)
}
```

- [ ] **Step 7: `package.json` 的 `test` 脚本加上 scripts 测试**

```json
"test": "node --test server/test/*.test.js scripts/test/*.test.mjs"
```

- [ ] **Step 8: 全量验证**

Run: `npm test`
Expected: 17 个用例全过（服务端 12 + bootstrap 5）。

Run: `node scripts/setup-profile.mjs`
Expected: `[kernel] ✓`… `KERNEL_OK`，`[setup-profile] @company-desk/desk-host linked`、`desk-ui linked`、`node_modules/@deepseek-ai → … (linked)`、`完成。`（本机第一次装 profile）。

Run: `npm run build`
Expected: `[build-client] plugins\desk-ui\lib\client.js (… KB)`。若报 esbuild 二进制缺失，执行 `node node_modules/esbuild/install.js` 后重试（npm 11.19 跳过了 postinstall）。

Run（后台，60 秒后杀掉）: `node scripts/launch.mjs --with-server --no-open`
Expected: 日志依次 `[launch] 启动网关 …`、`网关就绪`、`启动客户端 …`、`THE DIVA 已就绪：http://127.0.0.1:3470/`；期间 `curl http://127.0.0.1:3470/` 返回 200。**不再出现**第二次 `[kernel]` 输出（原来 setup-profile 子进程会再跑一次 install-kernel）。

- [ ] **Step 9: 提交**

```powershell
git add scripts/lib/bootstrap.mjs scripts/test/bootstrap.test.mjs scripts/launch.mjs scripts/setup-profile.mjs package.json
git commit -F <utf8 文件："refactor(scripts): 启动编排抽成 scripts/lib/bootstrap.mjs，launch/setup-profile 变薄壳；install-kernel 不再跑两次">
```

---

### Task 2: `scripts/lib/payload.mjs` + `scripts/build-payload.mjs`：暂存 `build/payload/`

**Files:**
- Create: `scripts/lib/payload.mjs`
- Create: `scripts/test/payload.test.mjs`
- Create: `scripts/build-payload.mjs`
- Modify: `.gitignore`（追加）

**Interfaces:**
- Consumes：`findTar`、`readGatewayUrl`（Task 1）；`PIN`、`locateKernel`、`defaultPrefix`（`scripts/kernel/locate.mjs`）；`ALL_MARKS`、`missingPatches`（`scripts/kernel/patches.mjs`）
- Produces：
  - `shouldPrune(relPath): boolean`；`patchGatewayUrl(yamlText, url): string`；`makeBuildId({ version, kernelVersion, digest, now }): string`；`digestFiles(files): string`（sha1 hex）
  - `build/payload/` 布局：`payload.json`、`runtime/node.exe`、`kernel.tar`、`plugins/{desk-host,desk-ui}`、`profile/cordis.patch.yml`、`scripts/kernel/{patches.mjs,locate.mjs,pin.json}`、`scripts/lib/bootstrap.mjs`
  - `payload.json`：`{ buildId, version, builtAt, node, kernel: { package, version, root }, gatewayUrl, pruned: { files, bytes } }`，其中 `kernel.root` 是相对 `kernel.tar` 解压根的路径（如 `node_modules/@deepseek-ai/dsh`）

- [ ] **Step 1: 写失败的测试 `scripts/test/payload.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digestFiles, makeBuildId, patchGatewayUrl, shouldPrune } from '../lib/payload.mjs'

test('shouldPrune：只删类型声明、source map 与其他平台的 node-pty 预编译', () => {
  assert.equal(shouldPrune('node_modules/x/lib/index.d.ts'), true)
  assert.equal(shouldPrune('node_modules\\x\\lib\\index.d.ts.map'), true)
  assert.equal(shouldPrune('node_modules/x/lib/index.js.map'), true)
  assert.equal(shouldPrune('node_modules/x/lib/index.mjs.map'), true)
  assert.equal(shouldPrune('node_modules/@deepseek-ai/dsh/node_modules/node-pty/prebuilds/darwin-arm64/pty.node'), true)
  assert.equal(shouldPrune('node_modules/@deepseek-ai/dsh/node_modules/node-pty/prebuilds/win32-x64/conpty.node'), false)
  assert.equal(shouldPrune('node_modules/x/lib/index.js'), false)
  assert.equal(shouldPrune('node_modules/x/LICENSE'), false)
  assert.equal(shouldPrune('node_modules/x/README.md'), false)
  assert.equal(shouldPrune('node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node'), false)
})

test('patchGatewayUrl：替换 gatewayUrl、去尾斜杠；没给 url 原样返回；找不到键就抛', () => {
  const yml = "    - id: desk-host\n      config:\n        gatewayUrl: 'http://127.0.0.1:8790'\n        providerId: desk-gateway\n"
  assert.equal(patchGatewayUrl(yml, 'http://gw.company.local:8790/'), yml.replace("'http://127.0.0.1:8790'", "'http://gw.company.local:8790'"))
  assert.equal(patchGatewayUrl(yml, undefined), yml)
  assert.throws(() => patchGatewayUrl('- id: x\n', 'http://a'), /gatewayUrl/)
})

test('makeBuildId：版本+内核版本+时间戳+摘要前 8 位', () => {
  const id = makeBuildId({ version: '0.1.0', kernelVersion: '0.1.1-rc.2', digest: 'abcdef0123456789', now: new Date('2026-09-04T01:02:03Z') })
  assert.equal(id, '0.1.0+0.1.1-rc.2.20260904-0102.abcdef01')
})

test('digestFiles：内容相同摘要相同，顺序无关', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-payload-'))
  const a = path.join(dir, 'a.txt')
  const b = path.join(dir, 'b.txt')
  fs.writeFileSync(a, 'A')
  fs.writeFileSync(b, 'B')
  assert.equal(digestFiles([a, b]), digestFiles([b, a]))
  fs.writeFileSync(b, 'C')
  assert.notEqual(digestFiles([a, b]), digestFiles([a, a]))
  assert.match(digestFiles([a]), /^[0-9a-f]{40}$/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/test/payload.test.mjs`
Expected: `Cannot find module '.../scripts/lib/payload.mjs'`

- [ ] **Step 3: 写 `scripts/lib/payload.mjs`**

```js
/**
 * build-payload.mjs 用到的纯函数（单测覆盖）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 内核修剪：只删运行期绝不加载的东西。relPath 相对内核前缀根。 */
export function shouldPrune(relPath) {
  const p = relPath.replace(/\\/g, '/')
  if (/\.d\.(ts|mts|cts)$/.test(p)) return true
  if (/\.(js|cjs|mjs|d\.ts|d\.mts|d\.cts)\.map$/.test(p)) return true
  const m = /\/node-pty\/prebuilds\/([^/]+)\//.exec(p)
  if (m && m[1] !== 'win32-x64') return true
  return false
}

/** 把 cordis.patch.yml 里 desk-host 的 gatewayUrl 换成公司地址；url 为空则不改。 */
export function patchGatewayUrl(yamlText, url) {
  if (!url) return yamlText
  const clean = url.replace(/\/+$/, '')
  if (!/gatewayUrl:\s*'[^']*'/.test(yamlText)) throw new Error('cordis.patch.yml 里找不到 gatewayUrl')
  return yamlText.replace(/gatewayUrl:\s*'[^']*'/, `gatewayUrl: '${clean}'`)
}

/** 例：0.1.0+0.1.1-rc.2.20260904-0102.abcdef01 */
export function makeBuildId({ version, kernelVersion, digest, now = new Date() }) {
  const iso = now.toISOString() // 2026-09-04T01:02:03.000Z
  const ts = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`
  return `${version}+${kernelVersion}.${ts}.${digest.slice(0, 8)}`
}

/** 若干文件内容的 sha1（按文件名排序后逐个喂进去，顺序无关）。 */
export function digestFiles(files) {
  const h = crypto.createHash('sha1')
  for (const f of [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b)))) {
    h.update(path.basename(f))
    h.update(fs.readFileSync(f))
  }
  return h.digest('hex')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/test/payload.test.mjs`
Expected: `# pass 4`

- [ ] **Step 5: 写 `scripts/build-payload.mjs`**

```js
/**
 * 把客户端安装包要带的东西暂存到 build/payload/（electron-builder 的 extraResources 直接打包这个目录）：
 *   runtime/node.exe          构建机的 node（process.execPath）
 *   kernel.tar                打好补丁的内核前缀（修剪 .d.ts / source map / 其他平台 node-pty 预编译后 tar）
 *   plugins/                  desk-host、desk-ui（含已构建的 lib/client.js，不带 src/）
 *   profile/cordis.patch.yml  gatewayUrl 按 --gateway 替换
 *   scripts/                  kernel/{patches,locate}.mjs、kernel/pin.json、lib/bootstrap.mjs
 *   payload.json              buildId / 版本 / 内核版本 / node 版本 / 默认网关
 *
 *   node scripts/build-payload.mjs [--gateway <url>] [--kernel-prefix <dir>] [--out <dir>] [--no-prune]
 *
 * 内核来源：本机前缀（默认 ~/.company-desk/kernel）版本等于 pin 且补丁齐 → 复制；否则重新 install-kernel 到 build/kernel-stage（要网络）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PIN, defaultPrefix, locateKernel } from './kernel/locate.mjs'
import { ALL_MARKS, missingPatches } from './kernel/patches.mjs'
import { findTar, readGatewayUrl } from './lib/bootstrap.mjs'
import { digestFiles, makeBuildId, patchGatewayUrl, shouldPrune } from './lib/payload.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const argOf = (k, dflt) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const log = (m) => console.log(`[payload] ${m}`)
const die = (m) => {
  console.error(`[payload] ${m}`)
  process.exit(1)
}

const out = path.resolve(argOf('--out', path.join(root, 'build', 'payload')))
const stage = path.join(root, 'build', 'kernel-stage')
const gateway = argOf('--gateway', process.env.DESK_GATEWAY_URL)
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// 1. node.exe
fs.mkdirSync(path.join(out, 'runtime'))
fs.copyFileSync(process.execPath, path.join(out, 'runtime', path.basename(process.execPath)))
log(`runtime: ${path.basename(process.execPath)} ${process.version}`)

// 2. 内核 → build/kernel-stage
let prefix = argOf('--kernel-prefix') ? path.resolve(argOf('--kernel-prefix')) : defaultPrefix()
let kernel = locateKernel(prefix)
fs.rmSync(stage, { recursive: true, force: true })
if (!kernel || kernel.version !== PIN.version || missingPatches(kernel.root).length) {
  log(`本机前缀 ${prefix} 不可用（${!kernel ? '没有内核' : kernel.version !== PIN.version ? `版本 ${kernel.version} ≠ ${PIN.version}` : '补丁不齐'}），重新安装到 ${stage}（需要网络）`)
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-kernel.mjs'), '--prefix', stage, '--dsh-home', path.join(root, 'build', 'dsh-home-tmp')], { stdio: 'inherit' })
  if (r.status !== 0) die('内核安装失败')
} else {
  log(`复制内核 ${prefix} → ${stage}`)
  fs.cpSync(prefix, stage, { recursive: true, force: true })
}
kernel = locateKernel(stage)
if (!kernel) die(`暂存目录里找不到内核：${stage}`)

// 3. 修剪
const pruned = { files: 0, bytes: 0 }
if (!has('--no-prune')) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        if (fs.readdirSync(p).length === 0) fs.rmdirSync(p)
      } else if (shouldPrune(path.relative(stage, p))) {
        pruned.bytes += fs.statSync(p).size
        pruned.files++
        fs.unlinkSync(p)
      }
    }
  }
  walk(stage)
  log(`修剪 ${pruned.files} 个文件，${(pruned.bytes / 1024 / 1024).toFixed(1)} MB`)
}

// 4. 校验：补丁齐、补丁文件语法完好
const left = missingPatches(kernel.root)
if (left.length) die(`修剪后缺补丁：${left.join(', ')}`)
for (const { file } of ALL_MARKS) {
  if (!file.endsWith('.js')) continue
  try {
    execFileSync(process.execPath, ['--check', path.join(kernel.root, file)], { stdio: 'pipe' })
  } catch (err) {
    die(`补丁文件语法检查失败 ${file}: ${err.stderr || err.message}`)
  }
}
log(`内核 ${kernel.version}，${ALL_MARKS.length} 处补丁齐全`)

// 5. kernel.tar
const tarFile = path.join(out, 'kernel.tar')
const r = spawnSync(findTar(), ['-cf', tarFile, '-C', stage, '.'], { stdio: 'inherit' })
if (r.status !== 0) die(`tar 失败（${r.status}）`)
log(`kernel.tar ${(fs.statSync(tarFile).size / 1024 / 1024).toFixed(1)} MB`)

// 6. 插件（先构建浏览器端 bundle）
{
  const b = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-client.mjs')], { stdio: 'inherit' })
  if (b.status !== 0) die('build-client 失败')
  fs.cpSync(path.join(root, 'plugins', 'desk-host'), path.join(out, 'plugins', 'desk-host'), { recursive: true })
  const uiSrc = path.join(root, 'plugins', 'desk-ui')
  fs.cpSync(uiSrc, path.join(out, 'plugins', 'desk-ui'), { recursive: true, filter: (s) => path.relative(uiSrc, s).split(path.sep)[0] !== 'src' })
}

// 7. profile（预置网关地址）
fs.mkdirSync(path.join(out, 'profile'))
const repoPatch = path.join(root, 'profile', 'cordis.patch.yml')
fs.writeFileSync(path.join(out, 'profile', 'cordis.patch.yml'), patchGatewayUrl(fs.readFileSync(repoPatch, 'utf8'), gateway))

// 8. 脚本
for (const rel of ['scripts/kernel/patches.mjs', 'scripts/kernel/locate.mjs', 'scripts/kernel/pin.json', 'scripts/lib/bootstrap.mjs']) {
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true })
  fs.copyFileSync(path.join(root, rel), path.join(out, rel))
}

// 9. payload.json
const digest = digestFiles([path.join(out, 'profile', 'cordis.patch.yml'), path.join(out, 'plugins', 'desk-ui', 'lib', 'client.js'), path.join(out, 'plugins', 'desk-host', 'lib', 'index.js'), path.join(out, 'scripts', 'lib', 'bootstrap.mjs'), path.join(out, 'scripts', 'kernel', 'patches.mjs')])
const payload = {
  buildId: makeBuildId({ version, kernelVersion: kernel.version, digest }),
  version,
  builtAt: new Date().toISOString(),
  node: process.version,
  kernel: { package: PIN.package, version: kernel.version, root: path.relative(stage, kernel.root).replace(/\\/g, '/') },
  gatewayUrl: readGatewayUrl(path.join(out, 'profile', 'cordis.patch.yml')),
  pruned,
}
fs.writeFileSync(path.join(out, 'payload.json'), JSON.stringify(payload, null, 2) + '\n')
log(`payload.json buildId=${payload.buildId} gateway=${payload.gatewayUrl}`)
log(`完成：${out}`)
```

- [ ] **Step 6: `.gitignore` 追加**

```
# 安装包构建产物
build/
dist/
desktop/dist/
```

- [ ] **Step 7: 跑一次并做长路径解压实测**

Run: `node scripts/build-payload.mjs`
Expected：`runtime: node.exe v26.7.0`、`复制内核 …`、`修剪 N 个文件，M MB`（预期几千个文件、几十 MB）、`内核 0.1.1-rc.2，16 处补丁齐全`、`kernel.tar ~150 MB`、`[build-client] …`、`payload.json buildId=0.1.0+0.1.1-rc.2.… gateway=http://127.0.0.1:8790`。

Run（PowerShell，验证 bsdtar 长路径）:

```powershell
$base = Join-Path $env:TEMP ("l" * 120)   # 刻意很长的基路径
New-Item -ItemType Directory -Force $base | Out-Null
tar -xf build\payload\kernel.tar -C $base
node scripts\install-kernel.mjs --check --prefix $base
(Get-ChildItem -Recurse -File $base | Measure-Object).Count
Remove-Item -Recurse -Force $base
```

Expected：`tar` 无报错；`--check` 输出 `✓ 版本正确、16 处补丁齐全`；文件数等于 `build/kernel-stage` 的文件数。若 tar 报 `Can't create` / 路径过长 → 改用 Node 自写 tar 读取器（pax 头），此时先停下来报告。

Run: `npm test`
Expected: 21 个用例全过（+4）。

- [ ] **Step 8: 提交**

```powershell
git add scripts/lib/payload.mjs scripts/test/payload.test.mjs scripts/build-payload.mjs .gitignore
git commit -F <utf8："build(payload): 暂存客户端安装包内容（node.exe / 修剪后的 kernel.tar / 插件 / profile / payload.json）">
```

---

### Task 3: `preparePackaged` —— 安装版首次启动准备 + NDJSON CLI

**Files:**
- Modify: `scripts/lib/bootstrap.mjs`（追加 `pinSkillsRoot`、`preparePackaged`、CLI main）
- Modify: `scripts/test/bootstrap.test.mjs`（追加 2 个用例）

**Interfaces:**
- Consumes：`build/payload/`（Task 2）
- Produces：
  - `pinSkillsRoot({ kernelPrefix, kernel, skillsDir, log }): boolean`（是否改动）
  - `preparePackaged({ payloadDir, appDir, dshHome, log }): { kernelBin, kernelRoot, kernelVersion, profileName: 'desk-app', appDir, buildId, nodeExe }`
  - CLI：`node bootstrap.mjs --packaged --payload <dir> --app-dir <dir> [--dsh-home <dir>]`，stdout NDJSON，`step ∈ extract|kernel|profile|log|ready|error`，`status ∈ start|ok|skip|info|fail`；退出码 0 / 1（失败）/ 64（用法）
  - `log` 回调接收**对象** `{ step, status, detail }`；`ensureProfile` 的字符串日志会被包成 `{ step:'profile', status:'info', detail }`

- [ ] **Step 1: 追加失败的测试**

在 `scripts/test/bootstrap.test.mjs` 末尾追加（导入行加上 `pinSkillsRoot, preparePackaged`）：

```js
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('pinSkillsRoot：戳记里的技能根与目标一致且补丁齐 → 不动；不一致 → 重写戳记', () => {
  // 用一个假内核前缀：只需要 stamp 文件 + missingPatches 能跑（缺补丁文件会抛，所以这里只测 skip 分支）
  const dir = tmp()
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  const skillsDir = path.join(dir, 'skills')
  fs.writeFileSync(path.join(dir, '.company-desk-kernel.json'), JSON.stringify({ skillsDir }))
  const logs = []
  // missingPatches 对不存在的补丁文件会报缺 → 走"重打"分支 → applyKernelPatches 抛 target-missing
  assert.throws(() => pinSkillsRoot({ kernelPrefix: dir, kernel: { root: kernelRoot, bin: 'x', version: '0' }, skillsDir, log: (o) => logs.push(o) }), /PATCH_FAIL target-missing/)
})

test('preparePackaged：解压 kernel.tar、复制 plugins/profile/scripts、写 state.json；第二次跳过', { skip: !fs.existsSync(path.join(repo, 'build', 'payload', 'kernel.tar')) && '需要先 node scripts/build-payload.mjs' }, () => {
  const dir = tmp()
  const appDir = path.join(dir, 'app')
  const dshHome = path.join(dir, 'dsh')
  const events = []
  const res = preparePackaged({ payloadDir: path.join(repo, 'build', 'payload'), appDir, dshHome, log: (o) => events.push(o) })
  assert.equal(res.profileName, 'desk-app')
  assert.ok(fs.existsSync(res.kernelBin), 'kernelBin 存在')
  assert.ok(res.kernelBin.startsWith(path.join(appDir, 'kernel')))
  const state = JSON.parse(fs.readFileSync(path.join(appDir, 'state.json'), 'utf8'))
  assert.equal(state.buildId, res.buildId)
  const stamp = JSON.parse(fs.readFileSync(path.join(appDir, 'kernel', '.company-desk-kernel.json'), 'utf8'))
  assert.equal(stamp.skillsDir, path.join(dshHome, 'desk', 'drive', '_shared', 'skills'))
  assert.ok(fs.existsSync(path.join(dshHome, 'profiles', 'desk-app', 'cordis.patch.yml')))
  assert.ok(fs.lstatSync(path.join(appDir, 'node_modules', '@deepseek-ai')).isSymbolicLink())
  assert.ok(events.some((e) => e.step === 'extract' && e.status === 'ok'))
  // 第二次：全部 skip
  const again = []
  preparePackaged({ payloadDir: path.join(repo, 'build', 'payload'), appDir, dshHome, log: (o) => again.push(o) })
  assert.ok(again.every((e) => e.status === 'skip'), JSON.stringify(again))
  fs.rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/test/bootstrap.test.mjs`
Expected: `SyntaxError: The requested module '../lib/bootstrap.mjs' does not provide an export named 'pinSkillsRoot'`

- [ ] **Step 3: 在 `scripts/lib/bootstrap.mjs` 末尾追加安装版逻辑与 CLI**

```js
// ---------- 安装版 ----------

/**
 * 让内核预设里的技能根指向当前用户的公司盘镜像。戳记一致且补丁齐 → 不动；否则跑一遍 applyKernelPatches
 * （16 处 mark 都在时只会同步技能根路径）并重写戳记。返回是否改动。
 */
export function pinSkillsRoot({ kernelPrefix, kernel, skillsDir, log = noop }) {
  const stamp = stampPath(kernelPrefix)
  let current = null
  try {
    current = JSON.parse(fs.readFileSync(stamp, 'utf8'))
  } catch {
    /* 无戳记 */
  }
  if (current && current.skillsDir === skillsDir && missingPatches(kernel.root).length === 0) {
    log({ step: 'kernel', status: 'skip', detail: `技能根已是 ${skillsDir}` })
    return false
  }
  log({ step: 'kernel', status: 'start', detail: `同步技能根 → ${skillsDir}` })
  let counters
  try {
    counters = applyKernelPatches({ kernelRoot: kernel.root, skillsDir, log: noop })
  } catch (err) {
    if (err instanceof KernelPatchError) throw new Error(`PATCH_FAIL ${err.code}: ${err.detail}`)
    throw err
  }
  const left = missingPatches(kernel.root)
  if (left.length) throw new Error(`打完补丁仍缺：${left.join(', ')}`)
  fs.writeFileSync(
    stamp,
    JSON.stringify({ package: PIN.package, version: kernel.version, kernelRoot: kernel.root, skillsDir, patchedAt: new Date().toISOString(), marks: ALL_MARKS.map((m) => m.marks[0]) }, null, 2) + '\n',
  )
  log({ step: 'kernel', status: 'ok', detail: `新打 ${counters.applied} 处，已有 ${counters.skipped} 处` })
  return true
}

/**
 * 安装版首次启动 / 升级后的准备：
 *   1) appDir/state.json 的 buildId ≠ payload.json 的 → 删 appDir 重建：tar 解 kernel.tar 到 appDir/kernel，复制 plugins/profile/scripts；
 *   2) 技能根同步到 <dshHome>/desk/drive/_shared/skills；
 *   3) profile desk-app（插件链接到 appDir/plugins，appDir/node_modules/@deepseek-ai → dsh 回退目录）。
 * 只做准备，不长驻；内核由调用方（Electron 主进程）用 nodeExe 启动。
 */
export function preparePackaged({ payloadDir, appDir, dshHome, log = noop }) {
  const payload = JSON.parse(fs.readFileSync(path.join(payloadDir, 'payload.json'), 'utf8'))
  const kernelPrefix = path.join(appDir, 'kernel')
  const stateFile = path.join(appDir, 'state.json')
  let state = null
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    /* 首次 */
  }
  const fresh = !state || state.buildId !== payload.buildId || !locateKernel(kernelPrefix)
  if (fresh) {
    log({ step: 'extract', status: 'start', detail: state ? `版本更新（${state.buildId} → ${payload.buildId}），重新解压内核` : '首次启动，解压内核（约半分钟）' })
    fs.rmSync(appDir, { recursive: true, force: true })
    fs.mkdirSync(kernelPrefix, { recursive: true })
    const r = spawnSync(findTar(), ['-xf', path.join(payloadDir, 'kernel.tar'), '-C', kernelPrefix], { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) {
      fs.rmSync(appDir, { recursive: true, force: true })
      throw new Error(`解压内核失败（${r.status ?? r.signal}）：${(r.stderr || '').trim()}`)
    }
    for (const d of ['plugins', 'profile', 'scripts']) fs.cpSync(path.join(payloadDir, d), path.join(appDir, d), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ buildId: payload.buildId, extractedAt: new Date().toISOString() }, null, 2) + '\n')
    log({ step: 'extract', status: 'ok', detail: `内核 ${payload.kernel.version}` })
  } else log({ step: 'extract', status: 'skip', detail: `内核已就位（${payload.buildId}）` })

  const kernel = locateKernel(kernelPrefix)
  if (!kernel) throw new Error(`解压后找不到内核：${kernelPrefix}`)
  pinSkillsRoot({ kernelPrefix, kernel, skillsDir: path.join(dshHome, 'desk', 'drive', '_shared', 'skills'), log })

  const profileName = 'desk-app'
  const profileDir = path.join(dshHome, 'profiles', profileName)
  const patchFile = path.join(appDir, 'profile', 'cordis.patch.yml')
  if (fresh || profileNeedsSetup({ profileDir, patchFile }) || !fs.existsSync(path.join(appDir, 'node_modules', '@deepseek-ai'))) {
    log({ step: 'profile', status: 'start', detail: '安装工作台配置（desk-app）' })
    ensureProfile({ profileName, dshHome, root: appDir, pluginsDir: path.join(appDir, 'plugins'), patchFile, kernel, log: (m) => log({ step: 'profile', status: 'info', detail: m }) })
    log({ step: 'profile', status: 'ok' })
  } else log({ step: 'profile', status: 'skip' })

  return { kernelBin: kernel.bin, kernelRoot: kernel.root, kernelVersion: kernel.version, profileName, appDir, buildId: payload.buildId, nodeExe: process.execPath }
}

// ---------- CLI ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const argOf = (k, dflt) => {
    const i = args.indexOf(k)
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt
  }
  const emit = (o) => process.stdout.write(JSON.stringify(typeof o === 'string' ? { step: 'log', status: 'info', detail: o } : o) + '\n')
  if (!args.includes('--packaged') || !argOf('--payload')) {
    console.error('用法：node bootstrap.mjs --packaged --payload <dir> [--app-dir <dir>] [--dsh-home <dir>]')
    process.exit(64)
  }
  try {
    const result = preparePackaged({
      payloadDir: path.resolve(argOf('--payload')),
      appDir: path.resolve(argOf('--app-dir', path.join(os.homedir(), '.company-desk', 'app'))),
      dshHome: path.resolve(argOf('--dsh-home', process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))),
      log: emit,
    })
    emit({ step: 'ready', status: 'ok', ...result })
  } catch (err) {
    emit({ step: 'error', status: 'fail', detail: err.message })
    process.exit(1)
  }
}
```

- [ ] **Step 4: 跑测试确认通过（含真解压，约 30-60 秒）**

Run: `node --test scripts/test/bootstrap.test.mjs`
Expected: `# pass 7`。`preparePackaged` 用例里 `ensureProfile` 会用 `process.execPath`（本机 node）跑一次内核 `--dump-default-config` —— 这就是安装版的真实路径。

- [ ] **Step 5: 手工跑 CLI 并用它起一次内核**

```powershell
$app = "$env:TEMP\diva-app"; $dsh = "$env:TEMP\diva-dsh"
Remove-Item -Recurse -Force $app, $dsh -ErrorAction SilentlyContinue
node scripts\lib\bootstrap.mjs --packaged --payload build\payload --app-dir $app --dsh-home $dsh
```

Expected：NDJSON 若干行，最后一行 `{"step":"ready","status":"ok","kernelBin":"…\\diva-app\\kernel\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js","profileName":"desk-app",…}`。

```powershell
$env:DSH_HOME = $dsh
Start-Process -PassThru node -ArgumentList "$app\kernel\node_modules\@deepseek-ai\dsh\lib\bin.js","--profile","desk-app","--no-open","--port","3499" | Tee-Object -Variable p
Start-Sleep 15; (Invoke-WebRequest http://127.0.0.1:3499/ -UseBasicParsing).StatusCode
Stop-Process -Id $p.Id -Force; Remove-Item Env:\DSH_HOME
```

Expected：`200`。

- [ ] **Step 6: 提交**

```powershell
git add scripts/lib/bootstrap.mjs scripts/test/bootstrap.test.mjs
git commit -F <utf8："feat(bootstrap): 安装版首次启动准备 preparePackaged（解 kernel.tar、同步技能根、desk-app profile）+ NDJSON CLI">
```

---

### Task 4: 应用图标 `desktop/build/icon.png` + `icon.ico`

**Files:**
- Create: `scripts/make-icon.mjs`
- Create（生成并提交）: `desktop/build/icon.png`（512×512）、`desktop/build/icon.ico`（256×256，PNG 封装）
- Modify: `package.json`（`icon` 脚本）

**Interfaces:**
- Produces：两个图标文件；electron-builder 用 `icon.png`（自动转 ico），NSIS 用 `icon.ico`

- [ ] **Step 1: 写 `scripts/make-icon.mjs`**

```js
/**
 * 一次性生成应用图标（提交进仓库）：用本机 Edge/Chrome 无头截图把 SVG 渲成 PNG，再把 256px 的 PNG 封进 ICO。
 *   node scripts/make-icon.mjs
 * 产物：desktop/build/icon.png（512×512，electron-builder 用）、desktop/build/icon.ico（256×256 PNG 封装，NSIS 用）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'desktop', 'build')
fs.mkdirSync(outDir, { recursive: true })

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="52" fill="#1b1b1f"/>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="none" stroke="#4d6bfe" stroke-width="6" opacity="0.9"/>
  <text x="128" y="172" text-anchor="middle" font-family="Georgia, 'Times New Roman', 'Songti SC', serif" font-size="150" font-weight="700" fill="#f6f1e7" letter-spacing="-4">D</text>
  <text x="128" y="222" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="22" fill="#9aa8ff" letter-spacing="6">THE DIVA</text>
</svg>`

function findBrowser() {
  const c = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  const hit = c.find((p) => fs.existsSync(p))
  if (!hit) throw new Error('找不到 Edge/Chrome，无法渲染图标')
  return hit
}

function render(size, outPng) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-icon-'))
  const html = path.join(tmp, 'icon.html')
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${svg(size)}</body></html>`)
  const r = spawnSync(findBrowser(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--window-size=${size},${size}`, `--screenshot=${outPng}`, `--user-data-dir=${path.join(tmp, 'ud')}`, pathToFileURL(html).href], { stdio: 'pipe', encoding: 'utf8', timeout: 60000 })
  if (!fs.existsSync(outPng)) throw new Error(`截图失败：${r.stderr}`)
  fs.rmSync(tmp, { recursive: true, force: true })
}

/** ICO 容器里放一张 PNG（Vista+ 支持；256 在目录项里写 0）。 */
function pngToIco(png, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}

const png512 = path.join(outDir, 'icon.png')
const png256 = path.join(os.tmpdir(), `diva-icon-256-${process.pid}.png`)
render(512, png512)
render(256, png256)
fs.writeFileSync(path.join(outDir, 'icon.ico'), pngToIco(fs.readFileSync(png256), 256))
fs.unlinkSync(png256)
console.log(`[icon] ${png512} (${fs.statSync(png512).size} B), icon.ico`)
```

- [ ] **Step 2: `package.json` 加脚本并运行**

`"icon": "node scripts/make-icon.mjs"`

Run: `npm run icon`
Expected: `[icon] …\desktop\build\icon.png (… B), icon.ico`。用 Read 工具打开 `desktop/build/icon.png` 看一眼：深色圆角方块、白色衬线 D、下方 THE DIVA。

- [ ] **Step 3: 提交**

```powershell
git add scripts/make-icon.mjs desktop/build/icon.png desktop/build/icon.ico package.json
git commit -F <utf8："build(icon): THE DIVA 应用图标（脚本生成，PNG + ICO）">
```

---

### Task 5: Electron 子项目 `desktop/`（开发模式可跑）

**Files:**
- Create: `desktop/package.json`、`desktop/main.js`、`desktop/splash.html`、`desktop/electron-builder.yml`

**Interfaces:**
- Consumes：`build/payload/`（Task 2）、`bootstrap.mjs --packaged` 的 NDJSON（Task 3）
- Produces：`electron desktop --payload <dir> [--app-dir <dir>] [--dsh-home <dir>]` 可开窗；打包后 payload 在 `process.resourcesPath/payload`

- [ ] **Step 1: `desktop/package.json`**

```json
{
  "name": "the-diva-desktop",
  "productName": "THE DIVA",
  "version": "0.1.0",
  "private": true,
  "description": "THE DIVA · 企业交付工作台 桌面客户端",
  "author": "THE DIVA",
  "main": "main.js",
  "scripts": {
    "start": "electron . --payload ../build/payload",
    "dist": "electron-builder --win nsis"
  },
  "devDependencies": {
    "electron": "44.1.1",
    "electron-builder": "26.15.3"
  }
}
```

- [ ] **Step 2: `desktop/splash.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>THE DIVA</title>
<style>
  html, body { margin: 0; height: 100%; background: #ffffff; color: #1b1b1f; font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; user-select: none; -webkit-app-region: drag; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
  .motto { font-size: 9px; letter-spacing: 3px; color: #8a8a93; font-style: italic; }
  .brand { font-family: 'Cormorant Garamond', 'Playfair Display', Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif; font-size: 40px; font-weight: 700; letter-spacing: 4px; }
  .tag { font-size: 12px; color: #56565c; }
  .status { margin-top: 18px; font-size: 12px; color: #56565c; display: flex; align-items: center; gap: 8px; max-width: 360px; text-align: center; }
  .spin { width: 12px; height: 12px; border: 2px solid #e4e4e7; border-top-color: #4d6bfe; border-radius: 50%; animation: r 0.9s linear infinite; flex: none; }
  @keyframes r { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="motto">BORN IN SPOTLIGHT · RAISED IN STARDUST</div>
  <div class="brand">THE DIVA</div>
  <div class="tag">企业交付工作台</div>
  <div class="status"><span class="spin"></span><span id="s">正在启动…</span></div>
</div>
<script>
  window.__setStatus = (t) => { document.getElementById('s').textContent = t }
</script>
</body>
</html>
```

- [ ] **Step 3: `desktop/main.js`**

```js
/**
 * THE DIVA 桌面客户端（Electron 主进程）：只做窗口与进程编排，业务都在 dsh 内核 + 公司插件里。
 *
 * 启动：单实例锁 → 启动页 → 用随包 node.exe 跑 payload/scripts/lib/bootstrap.mjs --packaged（解内核 / 同步技能根 / 装 profile）
 *      → 选端口 → node.exe 起内核 → 等 HTTP 就绪 → 主窗口 loadURL。关窗 → taskkill 内核进程树 → 退出。
 * 参数（开发时）：--payload <dir>（默认 resources/payload）、--app-dir <dir>（默认 ~/.company-desk/app）、--dsh-home <dir>（默认 $DSH_HOME 或 ~/.dsh）
 * 日志：~/.company-desk/logs/desktop.log（5 MB 滚动保留 3 份）
 */
'use strict'
const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const APP_ID = 'team.ethan.thediva'
const args = process.argv.slice(app.isPackaged ? 1 : 2)
const argOf = (k, dflt) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const payloadDir = path.resolve(argOf('--payload', path.join(process.resourcesPath, 'payload')))
const appDir = path.resolve(argOf('--app-dir', path.join(os.homedir(), '.company-desk', 'app')))
const dshHome = path.resolve(argOf('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const logDir = path.join(os.homedir(), '.company-desk', 'logs')
const nodeExe = path.join(payloadDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')

// ---------- 日志 ----------
class Log {
  constructor(file) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.rotate()
  }
  rotate() {
    try {
      if (fs.statSync(this.file).size <= 5 * 1024 * 1024) return
      for (let i = 2; i >= 1; i--) if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`)
      fs.renameSync(this.file, `${this.file}.1`)
    } catch {
      /* 不存在 */
    }
  }
  write(tag, text) {
    const line = `${new Date().toISOString()} [${tag}] ${String(text).replace(/\s+$/, '')}\n`
    try {
      fs.appendFileSync(this.file, line)
    } catch {
      /* 磁盘问题不影响运行 */
    }
    if (!app.isPackaged) process.stdout.write(line)
  }
}
const log = new Log(path.join(logDir, 'desktop.log'))

// ---------- 小工具（与 scripts/lib/bootstrap.mjs 同逻辑；主进程是 CJS，不直接 import 那个 ESM）----------
async function findFreePort(preferred, tries) {
  const probe = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.unref()
      srv.once('error', () => resolve(false))
      srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)))
    })
  for (let p = preferred; p < preferred + tries; p++) if (await probe(p)) return p
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}
async function waitHttp(url, timeoutMs) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status < 500) return
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`内核 ${timeoutMs / 1000} 秒内没有就绪（${url}）`)
    await new Promise((r) => setTimeout(r, 300))
  }
}
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
}

// ---------- 启动页 ----------
function createSplash() {
  const win = new BrowserWindow({ width: 420, height: 260, frame: false, resizable: false, show: false, backgroundColor: '#ffffff', webPreferences: { contextIsolation: true, sandbox: true } })
  win.loadFile(path.join(__dirname, 'splash.html'))
  win.once('ready-to-show', () => win.show())
  return win
}
function setStatus(text) {
  log.write('status', text)
  if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(`window.__setStatus && window.__setStatus(${JSON.stringify(text)})`).catch(() => {})
}

// ---------- bootstrap（准备内核 / profile）----------
const STEP_LABEL = { extract: '解压内核', kernel: '校验内核补丁', profile: '安装工作台配置', log: '' }
function describe(ev) {
  const label = STEP_LABEL[ev.step] ?? ev.step
  if (ev.status === 'skip') return `${label}：已就位`
  return ev.detail ? `${label}：${ev.detail}` : `${label}…`
}
function runBootstrap() {
  return new Promise((resolve, reject) => {
    const script = path.join(payloadDir, 'scripts', 'lib', 'bootstrap.mjs')
    const child = spawn(nodeExe, [script, '--packaged', '--payload', payloadDir, '--app-dir', appDir, '--dsh-home', dshHome], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let ready = null
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        log.write('bootstrap', line)
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.step === 'ready') ready = ev
        else if (ev.step === 'error') reject(new Error(ev.detail))
        else setStatus(describe(ev))
      }
    })
    child.stderr.on('data', (d) => log.write('bootstrap:err', d.toString('utf8')))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0 && ready) resolve(ready)
      else reject(new Error(`启动准备失败（退出码 ${code}）`))
    })
  })
}

// ---------- 内核 ----------
function startKernel(ready, port) {
  const child = spawn(nodeExe, [ready.kernelBin, '--profile', ready.profileName, '--no-open', '--port', String(port)], {
    cwd: appDir,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (d) => log.write('dsh', d.toString('utf8')))
  child.stderr.on('data', (d) => log.write('dsh:err', d.toString('utf8')))
  child.on('exit', (code, signal) => {
    log.write('dsh', `exit code=${code} signal=${signal}`)
    if (!quitting) fatal(new Error(`内核进程意外退出（${code ?? signal}）`))
  })
  return child
}

// ---------- 主流程 ----------
let splash = null
let mainWin = null
let kernel = null
let quitting = false

async function main() {
  app.setAppUserModelId(APP_ID)
  log.write('app', `THE DIVA ${app.getVersion()} packaged=${app.isPackaged} payload=${payloadDir} appDir=${appDir} dshHome=${dshHome}`)
  if (!fs.existsSync(nodeExe)) throw new Error(`缺少运行时 ${nodeExe}`)
  if (!fs.existsSync(path.join(payloadDir, 'payload.json'))) throw new Error(`缺少 ${path.join(payloadDir, 'payload.json')}（开发时先 node scripts/build-payload.mjs）`)
  splash = createSplash()
  setStatus('正在准备工作台…')
  const ready = await runBootstrap()
  const port = await findFreePort(3470, 10)
  setStatus(`启动内核（端口 ${port}）…`)
  kernel = startKernel(ready, port)
  const url = `http://127.0.0.1:${port}/`
  await waitHttp(url, 60000)

  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'THE DIVA',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  mainWin.setMenu(null)
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith(url)) return { action: 'allow' }
    shell.openExternal(u)
    return { action: 'deny' }
  })
  mainWin.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(url)) {
      e.preventDefault()
      shell.openExternal(u)
    }
  })
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      mainWin.webContents.toggleDevTools()
      e.preventDefault()
    } else if (input.key === 'F5') {
      mainWin.webContents.reload()
      e.preventDefault()
    }
  })
  mainWin.on('page-title-updated', (e) => e.preventDefault())
  mainWin.once('ready-to-show', () => {
    mainWin.show()
    if (splash && !splash.isDestroyed()) splash.close()
    splash = null
  })
  mainWin.on('closed', () => {
    mainWin = null
    shutdown(0)
  })
  await mainWin.loadURL(url)
  log.write('app', `就绪 ${url}`)
}

function shutdown(code) {
  if (quitting) return
  quitting = true
  killTree(kernel)
  setTimeout(() => app.exit(code), 200)
}

async function fatal(err) {
  log.write('app', `FATAL ${err && err.stack ? err.stack : err}`)
  if (quitting) return
  quitting = true
  killTree(kernel)
  if (splash && !splash.isDestroyed()) splash.hide()
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'THE DIVA 无法启动',
    message: 'THE DIVA 无法启动',
    detail: `${err.message}\n\n日志：${log.file}`,
    buttons: ['打开日志目录', '退出'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) await shell.openPath(logDir)
  app.exit(1)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })
  app.on('window-all-closed', () => shutdown(0))
  app.on('before-quit', () => {
    quitting = true
    killTree(kernel)
  })
  app.whenReady().then(main).catch(fatal)
}
```

- [ ] **Step 4: `desktop/electron-builder.yml`**

```yaml
appId: team.ethan.thediva
productName: THE DIVA
copyright: THE DIVA
directories:
  output: ../dist
  buildResources: build
files:
  - main.js
  - splash.html
  - build/icon.png
  - package.json
extraResources:
  - from: ../build/payload
    to: payload
asar: true
compression: normal
npmRebuild: false
win:
  target:
    - nsis
  icon: build/icon.png
  artifactName: THE-DIVA-Setup-${version}.${ext}
nsis:
  oneClick: true
  perMachine: false
  allowElevation: false
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: THE DIVA
  deleteAppDataOnUninstall: false
  runAfterFinish: true
  language: "2052"
```

- [ ] **Step 5: 安装依赖（Electron 下载慢，后台跑）**

Run: `npm --prefix desktop install --no-fund --no-audit --allow-scripts=electron`
Expected: `added N packages`，且 `desktop/node_modules/electron/dist/electron.exe` 存在。若 Electron 44.1.1 下载超时：先试 `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"` 重跑；仍不行就把 `desktop/package.json` 的 electron 改成本机已缓存的 `40.10.2` 再装，并在提交信息里注明。

- [ ] **Step 6: 开发模式开窗验证**

Run（后台）: `npm --prefix desktop start -- --app-dir "$env:TEMP\diva-app2" --dsh-home "$env:TEMP\diva-dsh2"`
Expected：先出启动页（状态行依次 解压内核 → 校验内核补丁 → 安装工作台配置 → 启动内核），约 30-60 秒后主窗口出现 THE DIVA 登录遮罩。`~/.company-desk/logs/desktop.log` 有 `[bootstrap]`、`[dsh]`、`就绪 http://127.0.0.1:3470/`。此时若本机 8790 网关在跑，用 `boss / boss123456` 登录成功。关窗后 `Get-Process node` 里没有指向 `diva-app2\kernel` 的进程。

- [ ] **Step 7: 提交**

```powershell
git add desktop/package.json desktop/main.js desktop/splash.html desktop/electron-builder.yml
git commit -F <utf8："feat(desktop): Electron 壳（启动页 / bootstrap / 随包 node.exe 起内核 / 单实例 / 日志）">
```

---

### Task 6: 客户端安装包 `npm run dist:client` + 本机安装验证

**Files:**
- Create: `scripts/build-client-installer.mjs`
- Modify: `package.json`（`dist:client`、`dist` 脚本）

**Interfaces:**
- Consumes：`build/payload/`（Task 2）、`desktop/`（Task 5）
- Produces：`dist/THE-DIVA-Setup-<ver>.exe`

- [ ] **Step 1: `scripts/build-client-installer.mjs`**

```js
/**
 * 用根 package.json 的版本号跑 desktop/ 里的 electron-builder（NSIS，按用户安装）。
 *   node scripts/build-client-installer.mjs
 * 前提：build/payload/ 已由 build-payload.mjs 生成；desktop/node_modules 已安装（npm --prefix desktop install --allow-scripts=electron）。
 * 镜像：ELECTRON_MIRROR、ELECTRON_BUILDER_BINARIES_MIRROR（见 README）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.join(root, 'desktop')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const die = (m) => {
  console.error(`[dist:client] ${m}`)
  process.exit(1)
}

if (!fs.existsSync(path.join(root, 'build', 'payload', 'payload.json'))) die('缺 build/payload/，先跑 node scripts/build-payload.mjs')
const cli = path.join(desktop, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
if (!fs.existsSync(cli)) die('缺 desktop/node_modules，先跑 npm --prefix desktop install --allow-scripts=electron')

console.log(`[dist:client] electron-builder --win nsis  version=${version}`)
const r = spawnSync(process.execPath, [cli, '--win', 'nsis', `--config.extraMetadata.version=${version}`], { cwd: desktop, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
if (r.status !== 0) die(`electron-builder 退出码 ${r.status}`)
const outFile = path.join(root, 'dist', `THE-DIVA-Setup-${version}.exe`)
if (!fs.existsSync(outFile)) die(`没找到产物 ${outFile}`)
console.log(`[dist:client] ${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB)`)
```

- [ ] **Step 2: `package.json` 脚本**

```json
"dist:client": "node scripts/build-payload.mjs && node scripts/build-client-installer.mjs",
"dist:gateway": "node scripts/build-gateway-installer.mjs",
"dist": "npm run dist:client && npm run dist:gateway"
```

（`dist:gateway` 的脚本文件在 Task 8 创建；此处先登记。）

- [ ] **Step 3: 出包**

Run: `npm run dist:client`（首次 electron-builder 要下载 nsis / winCodeSign 工具到 `%LOCALAPPDATA%\electron-builder\Cache`，慢时设 `$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`）
Expected：`• building target=nsis file=..\dist\THE-DIVA-Setup-0.1.0.exe`，最后 `[dist:client] …\dist\THE-DIVA-Setup-0.1.0.exe (~120 MB)`。同时 `%LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-*\Bin\makensis.exe` 出现（Task 8 要用）。

- [ ] **Step 4: 本机安装 → 跑 → 卸载**

```powershell
Start-Process dist\THE-DIVA-Setup-0.1.0.exe -Wait     # 一键安装，装完自动启动
```

Expected：
1. `%LOCALAPPDATA%\Programs\THE DIVA\THE DIVA.exe` 存在，桌面有「THE DIVA」快捷方式。
2. 首次启动：启动页显示解压进度 → 主窗口登录遮罩。`Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*desk-app*' } | select CommandLine` 显示内核进程的可执行文件是 `…\Programs\THE DIVA\resources\payload\runtime\node.exe`（**不是** `D:\service\nodejs`）。
3. 网关在跑时登录 `boss / boss123456` → 新会话发一句话 → 有回复（mock-echo 或 DeepSeek）。
4. 关窗 → 上一条命令查不到内核进程。再双击快捷方式 → 无解压步骤，数秒开窗。
5. 「设置 → 应用 → THE DIVA → 卸载」→ 程序目录消失；`~/.company-desk/app`、`~/.dsh` 保留。

- [ ] **Step 5: 提交**

```powershell
git add scripts/build-client-installer.mjs package.json
git commit -F <utf8："build(dist): npm run dist:client 出 THE-DIVA-Setup-<ver>.exe（NSIS 一键按用户安装）">
```

---

### Task 7: 网关安装脚本 `installer/gateway/init.mjs` + 服务定义模板

**Files:**
- Create: `installer/gateway/init.mjs`
- Create: `installer/gateway/TheDivaGateway.xml.tpl`
- Create: `scripts/test/gateway-init.test.mjs`

**Interfaces:**
- Produces：
  - `init(instDir, { programData?, computerName? }): { dataDir, logDir, configFile, wroteConfig, port, publicUrl }`
  - CLI：`node init.mjs <INSTDIR>`，退出码 0 / 1 / 64；stdout 三行 `[init] …`
  - 环境变量覆盖（测试用）：`DIVA_PROGRAMDATA`、`DIVA_COMPUTERNAME`
  - 模板占位符：`{{INSTDIR}}`、`{{DATA_DIR}}`、`{{LOG_DIR}}`（XML 转义）

- [ ] **Step 1: 写失败的测试 `scripts/test/gateway-init.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { init } from '../../installer/gateway/init.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function fakeInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-gw-'))
  const inst = path.join(dir, 'THE DIVA Gateway')
  fs.mkdirSync(path.join(inst, 'server'), { recursive: true })
  fs.mkdirSync(path.join(inst, 'service'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'installer', 'gateway', 'TheDivaGateway.xml.tpl'), path.join(inst, 'service', 'TheDivaGateway.xml.tpl'))
  return { dir, inst, programData: path.join(dir, 'ProgramData') }
}

test('init：建数据目录、写默认 config.local.json、渲染服务 XML', () => {
  const { inst, programData } = fakeInstall()
  const r = init(inst, { programData, computerName: 'GW-HOST' })
  assert.equal(r.dataDir, path.join(programData, 'THE DIVA Gateway', 'data'))
  assert.ok(fs.existsSync(r.dataDir))
  assert.ok(fs.existsSync(r.logDir))
  assert.equal(r.wroteConfig, true)
  assert.equal(r.port, 8790)
  assert.equal(r.publicUrl, 'http://gw-host:8790')
  const cfg = JSON.parse(fs.readFileSync(path.join(inst, 'server', 'config.local.json'), 'utf8'))
  assert.deepEqual(cfg, { host: '0.0.0.0', port: 8790, publicUrl: 'http://gw-host:8790', dataDir: r.dataDir })
  const xml = fs.readFileSync(path.join(inst, 'service', 'TheDivaGateway.xml'), 'utf8')
  assert.match(xml, /<id>TheDivaGateway<\/id>/)
  assert.ok(xml.includes(`<executable>${inst}\\runtime\\node.exe</executable>`))
  assert.ok(xml.includes(`<env name="DESK_GATEWAY_DATA" value="${r.dataDir}"/>`))
  assert.ok(xml.includes(`<logpath>${r.logDir}</logpath>`))
  assert.ok(!xml.includes('{{'), '没有残留占位符')
})

test('init：已有 config.local.json 不覆盖，但端口从里面读；XML 每次重写', () => {
  const { inst, programData } = fakeInstall()
  fs.writeFileSync(path.join(inst, 'server', 'config.local.json'), JSON.stringify({ host: '0.0.0.0', port: 9000, company: { name: 'X' } }))
  const r = init(inst, { programData, computerName: 'A' })
  assert.equal(r.wroteConfig, false)
  assert.equal(r.port, 9000)
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst, 'server', 'config.local.json'), 'utf8')).company.name, 'X')
  fs.writeFileSync(path.join(inst, 'service', 'TheDivaGateway.xml'), 'stale')
  init(inst, { programData, computerName: 'A' })
  assert.match(fs.readFileSync(path.join(inst, 'service', 'TheDivaGateway.xml'), 'utf8'), /<service>/)
})

test('init：路径里的 & 会被 XML 转义', () => {
  const { dir, programData } = fakeInstall()
  const inst = path.join(dir, 'A & B')
  fs.mkdirSync(path.join(inst, 'server'), { recursive: true })
  fs.mkdirSync(path.join(inst, 'service'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'installer', 'gateway', 'TheDivaGateway.xml.tpl'), path.join(inst, 'service', 'TheDivaGateway.xml.tpl'))
  init(inst, { programData, computerName: 'A' })
  const xml = fs.readFileSync(path.join(inst, 'service', 'TheDivaGateway.xml'), 'utf8')
  assert.ok(xml.includes('A &amp; B\\runtime\\node.exe'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/test/gateway-init.test.mjs`
Expected: `Cannot find module '.../installer/gateway/init.mjs'`

- [ ] **Step 3: `installer/gateway/TheDivaGateway.xml.tpl`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- WinSW 服务定义；由 init.mjs 在安装时渲染，占位符：INSTDIR / DATA_DIR / LOG_DIR -->
<service>
  <id>TheDivaGateway</id>
  <name>THE DIVA 公司网关</name>
  <description>THE DIVA 企业交付工作台的公司网关：公司账号与网关令牌、模型代理与按人记账、任务验收流、公司盘。</description>
  <executable>{{INSTDIR}}\runtime\node.exe</executable>
  <arguments>"{{INSTDIR}}\server\src\index.js"</arguments>
  <workingdirectory>{{INSTDIR}}\server</workingdirectory>
  <env name="DESK_GATEWAY_DATA" value="{{DATA_DIR}}"/>
  <env name="NODE_ENV" value="production"/>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>{{LOG_DIR}}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
```

- [ ] **Step 4: `installer/gateway/init.mjs`**

```js
/**
 * 网关安装脚本 —— NSIS 安装 / 升级时用随包 node.exe 调用，幂等：
 *   node init.mjs <INSTDIR>
 *   1) 建 %ProgramData%\THE DIVA Gateway\{data,logs}
 *   2) <INSTDIR>\server\config.local.json 不存在才写：host 0.0.0.0 / port 8790 / publicUrl http://<主机名>:8790 / dataDir
 *      （server/src/config.js 只认 server/ 目录下的 config.local.json）
 *   3) 渲染 <INSTDIR>\service\TheDivaGateway.xml（每次重写，路径以 INSTDIR 为准）
 * 测试用环境变量：DIVA_PROGRAMDATA 覆盖 ProgramData，DIVA_COMPUTERNAME 覆盖主机名。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRODUCT_DIR = 'THE DIVA Gateway'
export const DEFAULT_PORT = 8790

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function init(instDir, { programData = process.env.DIVA_PROGRAMDATA || process.env.ProgramData || 'C:\\ProgramData', computerName = process.env.DIVA_COMPUTERNAME || process.env.COMPUTERNAME || os.hostname() } = {}) {
  const dataRoot = path.join(programData, PRODUCT_DIR)
  const dataDir = path.join(dataRoot, 'data')
  const logDir = path.join(dataRoot, 'logs')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })

  const configFile = path.join(instDir, 'server', 'config.local.json')
  let wroteConfig = false
  if (!fs.existsSync(configFile)) {
    const cfg = { host: '0.0.0.0', port: DEFAULT_PORT, publicUrl: `http://${computerName.toLowerCase()}:${DEFAULT_PORT}`, dataDir }
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n')
    wroteConfig = true
  }
  let port = DEFAULT_PORT
  let publicUrl = `http://${computerName.toLowerCase()}:${DEFAULT_PORT}`
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    port = Number(cfg.port ?? DEFAULT_PORT)
    publicUrl = cfg.publicUrl ?? `http://${computerName.toLowerCase()}:${port}`
  } catch (err) {
    throw new Error(`无法解析 ${configFile}: ${err.message}`)
  }

  const vars = { INSTDIR: instDir, DATA_DIR: dataDir, LOG_DIR: logDir }
  const tpl = fs.readFileSync(path.join(instDir, 'service', 'TheDivaGateway.xml.tpl'), 'utf8')
  const xml = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`模板里有未知占位符 {{${k}}}`)
    return xmlEscape(vars[k])
  })
  fs.writeFileSync(path.join(instDir, 'service', 'TheDivaGateway.xml'), xml)
  return { dataDir, logDir, configFile, wroteConfig, port, publicUrl }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const instDir = process.argv[2]
  if (!instDir) {
    console.error('用法：node init.mjs <INSTDIR>')
    process.exit(64)
  }
  try {
    const r = init(path.resolve(instDir))
    console.log(`[init] 数据目录 ${r.dataDir}`)
    console.log(`[init] 配置 ${r.configFile}${r.wroteConfig ? '（新建）' : '（保留现有）'}`)
    console.log(`[init] 端口 ${r.port}  管理页 ${r.publicUrl}/admin`)
  } catch (err) {
    console.error(`[init] ${err.message}`)
    process.exit(1)
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test scripts/test/gateway-init.test.mjs`
Expected: `# pass 3`

Run: `npm test`
Expected: 26 个用例全过。

- [ ] **Step 6: 提交**

```powershell
git add installer/gateway/init.mjs installer/gateway/TheDivaGateway.xml.tpl scripts/test/gateway-init.test.mjs
git commit -F <utf8："feat(installer): 网关安装脚本 init.mjs（ProgramData 数据目录 / config.local.json / WinSW 服务定义）">
```

---

### Task 8: 网关安装包：NSIS 脚本 + `scripts/build-gateway-installer.mjs`

**Files:**
- Create: `installer/pins.json`
- Create: `installer/gateway.nsi`
- Create: `scripts/build-gateway-installer.mjs`

**Interfaces:**
- Consumes：`installer/gateway/init.mjs`、`TheDivaGateway.xml.tpl`（Task 7）；`desktop/build/icon.ico`（Task 4）；`makensis.exe`（Task 6 的 electron-builder 缓存）
- Produces：`dist/THE-DIVA-Gateway-Setup-<ver>.exe`；暂存 `build/gateway/{runtime/node.exe, server/{src,config.json,package.json}, service/{TheDivaGateway.exe, TheDivaGateway.xml.tpl, init.mjs}, README.txt}`；缓存 `build/cache/WinSW-2.12.0.exe`

- [ ] **Step 1: `installer/pins.json`**

```json
{
  "$comment": "网关安装包携带的第三方二进制。改版本要同时改 sha256。",
  "winsw": {
    "version": "2.12.0",
    "url": "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe",
    "sha256": "b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f",
    "size": 655872,
    "license": "MIT",
    "note": ".NET Framework 4.6.1 版（Windows 10/11、Server 2016+ 自带）。自包含的 WinSW-x64.exe 有 18 MB，没必要。"
  }
}
```

- [ ] **Step 2: `installer/gateway.nsi`**

```nsis
; THE DIVA 公司网关 安装程序（NSIS 3，UTF-8）。由 scripts/build-gateway-installer.mjs 调用：
;   makensis /INPUTCHARSET UTF8 /DVERSION=x.y.z /DSTAGE=<暂存目录> /DOUTFILE=<输出 exe> [/DICON=<ico>] installer\gateway.nsi
; NSIS 只做：复制文件 → node init.mjs 生成配置与服务定义 → WinSW 注册并启动服务 → 防火墙放行。逻辑都在 init.mjs 里。
Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef VERSION
  !error "需要 /DVERSION=x.y.z"
!endif
!ifndef STAGE
  !error "需要 /DSTAGE=<暂存目录>"
!endif
!ifndef OUTFILE
  !define OUTFILE "THE-DIVA-Gateway-Setup-${VERSION}.exe"
!endif

!define PRODUCT "THE DIVA Gateway"
!define SERVICE "TheDivaGateway"
!define PORT "8790"
!define FWRULE "THE DIVA Gateway"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE}"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${PRODUCT}"
InstallDirRegKey HKLM "${REGKEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!ifdef ICON
  !define MUI_ICON "${ICON}"
  !define MUI_UNICON "${ICON}"
!endif

Var PublicUrl
Var ProgramDataDir

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 ${PRODUCT} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "将安装 THE DIVA 公司网关，并注册为 Windows 服务（${SERVICE}），随系统自动启动。$\r$\n$\r$\n不需要预装 Node.js。安装后员工在客户端登录页填写本机地址即可使用。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "服务 ${SERVICE} 已启动。$\r$\n$\r$\n管理页：$PublicUrl/admin$\r$\n种子管理员：boss / boss123456（请尽快修改密码）$\r$\n$\r$\n数据目录（卸载保留）：$ProgramDataDir\${PRODUCT}\data$\r$\n配置：$INSTDIR\server\config.local.json（改端口 / 公司名 / 额度后重启服务）"
!define MUI_FINISHPAGE_RUN ""
!define MUI_FINISHPAGE_RUN_TEXT "打开管理页"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenAdmin
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function OpenAdmin
  ExecShell "open" "$PublicUrl/admin"
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "需要 64 位 Windows。"
    Abort
  ${EndIf}
  ReadEnvStr $0 COMPUTERNAME
  StrCpy $PublicUrl "http://$0:${PORT}"
  ReadEnvStr $ProgramDataDir ProgramData
FunctionEnd

Function un.onInit
  ReadEnvStr $ProgramDataDir ProgramData
FunctionEnd

Section "网关" SecMain
  ${If} ${FileExists} "$INSTDIR\service\${SERVICE}.exe"
    DetailPrint "停止已有服务…"
    nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" stop'
    Pop $0
  ${EndIf}

  SetOutPath "$INSTDIR\runtime"
  File /r "${STAGE}\runtime\*.*"
  SetOutPath "$INSTDIR\server"
  File /r "${STAGE}\server\*.*"
  SetOutPath "$INSTDIR\service"
  File /r "${STAGE}\service\*.*"
  SetOutPath "$INSTDIR"
  File "${STAGE}\README.txt"

  DetailPrint "生成配置与服务定义…"
  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\service\init.mjs" "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "初始化失败（退出码 $0），未注册服务。请查看上方日志。"
    Abort
  ${EndIf}

  DetailPrint "注册并启动服务 ${SERVICE}…"
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" uninstall'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "注册服务失败（退出码 $0）。"
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" start'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "服务已注册但启动失败（退出码 $0）。请查看 $ProgramDataDir\${PRODUCT}\logs。"
  ${EndIf}

  DetailPrint "防火墙放行 TCP ${PORT}…"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FWRULE}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FWRULE}" dir=in action=allow protocol=TCP localport=${PORT}'
  Pop $0

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${REGKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${REGKEY}" "Publisher" "THE DIVA"
  WriteRegStr HKLM "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${REGKEY}" "DisplayIcon" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${REGKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  DetailPrint "停止并注销服务…"
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" stop'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\service\${SERVICE}.exe" uninstall'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FWRULE}"'
  Pop $0
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${REGKEY}"
  MessageBox MB_ICONINFORMATION "已卸载 ${PRODUCT}。$\r$\n数据（账号 / 令牌 / 任务 / 通道凭据 / 公司盘）仍保留在：$\r$\n$ProgramDataDir\${PRODUCT}$\r$\n不再需要请手动删除。"
SectionEnd
```

- [ ] **Step 3: `scripts/build-gateway-installer.mjs`**

```js
/**
 * 出网关安装包：暂存 build/gateway/ → makensis installer/gateway.nsi → dist/THE-DIVA-Gateway-Setup-<ver>.exe
 *   node scripts/build-gateway-installer.mjs
 * makensis 来源：MAKENSIS 环境变量 → electron-builder 缓存（%LOCALAPPDATA%\electron-builder\Cache\nsis\*\Bin\makensis.exe，跑过 dist:client 就有）→ PATH。
 * WinSW 按 installer/pins.json 下载到 build/cache/ 并校验 SHA256（下载不了就把文件手动放到那里）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const pins = JSON.parse(fs.readFileSync(path.join(root, 'installer', 'pins.json'), 'utf8'))
const stage = path.join(root, 'build', 'gateway')
const cache = path.join(root, 'build', 'cache')
const dist = path.join(root, 'dist')
const log = (m) => console.log(`[dist:gateway] ${m}`)
const die = (m) => {
  console.error(`[dist:gateway] ${m}`)
  process.exit(1)
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

async function ensureWinsw() {
  const pin = pins.winsw
  fs.mkdirSync(cache, { recursive: true })
  const file = path.join(cache, `WinSW-${pin.version}.exe`)
  if (fs.existsSync(file) && sha256(file) === pin.sha256) return file
  log(`下载 WinSW ${pin.version} ← ${pin.url}`)
  let res
  try {
    res = await fetch(pin.url)
  } catch (err) {
    die(`下载失败：${err.message}。可手动下载后放到 ${file}`)
  }
  if (!res.ok) die(`下载失败：HTTP ${res.status}。可手动下载后放到 ${file}`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  const got = sha256(file)
  if (got !== pin.sha256) {
    fs.unlinkSync(file)
    die(`WinSW SHA256 不匹配：期望 ${pin.sha256}，得到 ${got}`)
  }
  return file
}

function findMakensis() {
  if (process.env.MAKENSIS && fs.existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS
  const cacheRoot = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis')
  if (fs.existsSync(cacheRoot)) {
    for (const d of fs.readdirSync(cacheRoot)) {
      const p = path.join(cacheRoot, d, 'Bin', 'makensis.exe')
      if (fs.existsSync(p)) return p
    }
  }
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], { stdio: 'pipe', encoding: 'utf8' })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split(/\r?\n/)[0].trim()
  die('找不到 makensis.exe：先跑 npm run dist:client（electron-builder 会把 NSIS 下载到 %LOCALAPPDATA%\\electron-builder\\Cache\\nsis），或安装 NSIS 3 并设置 MAKENSIS 环境变量')
}

// 1. 暂存
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true })
fs.mkdirSync(path.join(stage, 'server', 'src'), { recursive: true })
fs.mkdirSync(path.join(stage, 'service'), { recursive: true })
fs.copyFileSync(process.execPath, path.join(stage, 'runtime', 'node.exe'))
for (const f of fs.readdirSync(path.join(root, 'server', 'src'))) fs.copyFileSync(path.join(root, 'server', 'src', f), path.join(stage, 'server', 'src', f))
fs.copyFileSync(path.join(root, 'server', 'config.json'), path.join(stage, 'server', 'config.json'))
// server/src 是 ESM：安装目录里没有根 package.json，要在 server/ 放一个声明 type=module
fs.writeFileSync(path.join(stage, 'server', 'package.json'), JSON.stringify({ name: 'the-diva-gateway', version, private: true, type: 'module' }, null, 2) + '\n')
fs.copyFileSync(path.join(root, 'installer', 'gateway', 'init.mjs'), path.join(stage, 'service', 'init.mjs'))
fs.copyFileSync(path.join(root, 'installer', 'gateway', 'TheDivaGateway.xml.tpl'), path.join(stage, 'service', 'TheDivaGateway.xml.tpl'))
fs.copyFileSync(await ensureWinsw(), path.join(stage, 'service', 'TheDivaGateway.exe'))
fs.writeFileSync(
  path.join(stage, 'README.txt'),
  [
    `THE DIVA 公司网关 ${version}`,
    '',
    '服务：TheDivaGateway（services.msc 里可启停；命令行：service\\TheDivaGateway.exe start|stop|restart|status）',
    '配置：server\\config.local.json（host / port / publicUrl / dataDir / company / quota …，改完重启服务）',
    '数据：%ProgramData%\\THE DIVA Gateway\\data（账号、令牌、任务、账本、通道凭据、公司盘）；日志：…\\logs',
    '上游模型密钥：管理员在客户端「设置 → 同事 → 模型通道」接入，或在 config.local.json 的 upstreams.<id>.apiKey，或在 service\\TheDivaGateway.xml 加 <env>。',
    '端口改了要同步改防火墙规则「THE DIVA Gateway」。',
    '管理页：http://<本机名>:8790/admin（种子管理员 boss / boss123456，请尽快修改）',
    '',
    `运行时：node ${process.version}；服务封装：WinSW ${pins.winsw.version}（MIT）`,
  ].join('\r\n') + '\r\n',
)
log(`暂存 ${stage}`)

// 2. makensis
fs.mkdirSync(dist, { recursive: true })
const outFile = path.join(dist, `THE-DIVA-Gateway-Setup-${version}.exe`)
const icon = path.join(root, 'desktop', 'build', 'icon.ico')
const makensis = findMakensis()
log(`makensis: ${makensis}`)
const nsisArgs = ['/INPUTCHARSET', 'UTF8', `/DVERSION=${version}`, `/DSTAGE=${stage}`, `/DOUTFILE=${outFile}`]
if (fs.existsSync(icon)) nsisArgs.push(`/DICON=${icon}`)
nsisArgs.push(path.join(root, 'installer', 'gateway.nsi'))
const r = spawnSync(makensis, nsisArgs, { stdio: 'inherit' })
if (r.status !== 0) die(`makensis 退出码 ${r.status}`)
if (!fs.existsSync(outFile)) die(`没找到产物 ${outFile}`)
log(`${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB)`)
```

- [ ] **Step 4: 出包**

Run: `npm run dist:gateway`
Expected：`下载 WinSW 2.12.0 ←…`（第二次跑命中缓存）、`暂存 …\build\gateway`、`makensis: …\electron-builder\Cache\nsis\nsis-3.0.4.1\Bin\makensis.exe`、makensis 输出以 `Output: "…THE-DIVA-Gateway-Setup-0.1.0.exe"` 结尾、`[dist:gateway] … (~30 MB)`。若 makensis 报 ICON 格式错误（不认 PNG 封装的 ICO）→ 去掉 `/DICON` 先出包，把图标问题记到 HANDOFF。

- [ ] **Step 5: 用暂存目录验证不需要管理员的部分**

```powershell
$inst = "$env:TEMP\gw-inst"; Remove-Item -Recurse -Force $inst -ErrorAction SilentlyContinue
Copy-Item -Recurse build\gateway $inst
$env:DIVA_PROGRAMDATA = "$env:TEMP\gw-pd"
& "$inst\runtime\node.exe" "$inst\service\init.mjs" $inst
Get-Content "$inst\server\config.local.json"
$env:DESK_GATEWAY_PORT = "8799"
$p = Start-Process -PassThru "$inst\runtime\node.exe" -ArgumentList "$inst\server\src\index.js" -WorkingDirectory "$inst\server"
Start-Sleep 3; (Invoke-WebRequest http://127.0.0.1:8799/health -UseBasicParsing).Content
Stop-Process -Id $p.Id -Force; Remove-Item Env:\DESK_GATEWAY_PORT, Env:\DIVA_PROGRAMDATA
```

Expected：`[init] 数据目录 …\gw-pd\THE DIVA Gateway\data`、config 内容 host 0.0.0.0；`/health` 返回 `{"ok":true,"name":"THE DIVA",…}`（证明暂存的 server/ + package.json type=module 能跑）。`…\gw-pd\THE DIVA Gateway\data` 下没有文件（数据目录来自 DESK_GATEWAY_DATA 只有服务 XML 才带，这里只是验证服务端可启动）。

- [ ] **Step 6: 请用户安装服务（需 UAC）——在计划外由用户执行，我给 checklist**

```
1. 双击 dist\THE-DIVA-Gateway-Setup-0.1.0.exe → 下一步到完成（勾"打开管理页"）
2. services.msc：TheDivaGateway 运行中；%ProgramData%\THE DIVA Gateway\data 出现 users.json
3. 浏览器 http://<本机名>:8790/admin 用 boss 登录
4. 客户端登录页网关地址填 http://<本机名>:8790 → 登录 → 发消息
5. 设置 → 应用 → THE DIVA Gateway → 卸载 → 服务消失、ProgramData 仍在
```

- [ ] **Step 7: 提交**

```powershell
git add installer/pins.json installer/gateway.nsi scripts/build-gateway-installer.mjs
git commit -F <utf8："build(dist): npm run dist:gateway 出 THE-DIVA-Gateway-Setup-<ver>.exe（NSIS + node.exe + WinSW 服务）">
```

---

### Task 9: 文档：README「安装包」、HANDOFF、会话记录

**Files:**
- Modify: `README.md`（§2 安装 后新增 §2.5 安装包；§3 启动 加一句）
- Modify: `docs/HANDOFF.md`（「现在在哪」加安装包状态；「下次该干嘛」第 1 项改为已完成 + 剩余验收；注意事项加构建相关）
- Modify: `docs/sessions/2026-09-04.md`（追加本次会话小节）

- [ ] **Step 1: README 新增「安装包」一节**（放在 §2 与 §3 之间）

```markdown
## 2.5 安装包（不依赖目标机器有 Node）

两个安装包，设计见 `docs/superpowers/specs/2026-09-04-installers-design.md`：

| 产物 | 给谁 | 安装方式 |
| --- | --- | --- |
| `dist/THE-DIVA-Setup-<ver>.exe` | 员工电脑 | 一键**按用户**安装到 `%LOCALAPPDATA%\Programs\THE DIVA`，不需要管理员；首次启动解压内核到 `~/.company-desk/app`（约半分钟，之后秒开） |
| `dist/THE-DIVA-Gateway-Setup-<ver>.exe` | 公司服务器 | 需管理员；装到 `%ProgramFiles%\THE DIVA Gateway`，注册 Windows 服务 `TheDivaGateway`，数据在 `%ProgramData%\THE DIVA Gateway\data`（卸载保留） |

构建（在有 Node 的开发机上）：

```powershell
npm --prefix desktop install --allow-scripts=electron   # 首次：装 Electron / electron-builder（npm 11.19 默认跳过 install 脚本，要显式允许）
npm run dist:client        # build/payload → dist/THE-DIVA-Setup-<ver>.exe
npm run dist:gateway       # build/gateway → dist/THE-DIVA-Gateway-Setup-<ver>.exe（复用 electron-builder 缓存的 NSIS）
npm run dist               # 两个都出
node scripts/build-payload.mjs --gateway http://gw.company.local:8790   # 把公司网关地址做成客户端默认值
```

- 网络慢时设镜像：`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`、
  `$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`；WinSW 下载不了就把
  `installer/pins.json` 里那个文件手动放到 `build/cache/WinSW-2.12.0.exe`。
- 安装包**未签名**：首次运行 SmartScreen 会拦，「更多信息 → 仍要运行」。
- 客户端：登录页「公司网关」填 `http://<服务器名或 IP>:8790`；端口 3470 被占会顺延（页面偏好按端口存，换端口会重置主题等）；
  日志在 `~/.company-desk/logs/desktop.log`；F12 开 DevTools。卸载不删 `~/.company-desk/app` 与 `~/.dsh`。
- 服务端：配置 `server\config.local.json`（改端口后同步改防火墙规则「THE DIVA Gateway」并重启服务）；服务跑在 LocalSystem，
  `~/.dsh/.credentials.yaml` 这条路不可用，上游密钥用客户端「模型通道」接入或写 `config.local.json` 的 `upstreams.<id>.apiKey`；
  `services.msc` 或 `service\TheDivaGateway.exe start|stop|restart|status`。
- 开发机上安装版与 `npm run dev` 并存：安装版用 profile `desk-app` 与 `~/.company-desk/app/kernel`，开发版用 `desk` 与 `~/.company-desk/kernel`，
  登录态 / 公司盘镜像 / 会话（`~/.dsh/desk`、`~/.dsh/sessions`）共用。
- 无 Node 机器验收 checklist：双击客户端安装包 → 桌面快捷方式启动 → 登录页填服务器地址 → `boss / boss123456` → 新会话发一句 → 有回复 →
  任务管理器里内核进程是 `…\THE DIVA\resources\payload\runtime\node.exe`。
```

- [ ] **Step 2: HANDOFF 更新**

「现在在哪」加一行：`- 安装包：\`npm run dist\` 出客户端 / 服务端两个 Windows 安装包（Electron + 随包 node.exe + kernel.tar；NSIS + WinSW 服务），本机装卸验证过；无 Node 机器的最终验收待做`。

「下次该干嘛」第 1 项替换为：

```markdown
### 1. 安装包：剩余验收与小项

- 在一台没有 Node 的 Windows 机器上按 README §2.5 的 checklist 走一遍（客户端 + 服务端）
- 图标 / 签名 / 自动更新都没做；内核 tar 还能再瘦（去掉 @opentelemetry 等未用依赖要动内核，慎）
- 切入点：`scripts/lib/bootstrap.mjs`（启动编排，开发与安装版共用）、`desktop/main.js`、`scripts/build-payload.mjs`、`installer/gateway.nsi` + `installer/gateway/init.mjs`
```

「注意事项」加：`- 改了 scripts/lib/bootstrap.mjs 或 scripts/kernel/* 要重新 \`npm run dist:client\`（它们随包）；\`build/\`、\`dist/\` 不入库`。「小项」里删掉「install-kernel 会被跑两次」。

- [ ] **Step 3: 会话记录追加**

在 `docs/sessions/2026-09-04.md` 末尾追加 `## 第二个会话（09-04 上午起）` 小节：用户要求（四项都做、两个安装包、A+S1、main 分支）、做了什么（按任务列）、踩过的坑（npm 11.19 allowScripts 跳过 install 脚本；MAX_PATH → kernel.tar 解到短路径；PowerShell 5.1 无 `&&`；网络慢 200 MB 17 分钟）、验证证据。

- [ ] **Step 4: 最终验证与提交**

Run: `npm test` → 全绿；`git status` 干净除了本次改动。

```powershell
git add README.md docs/HANDOFF.md docs/sessions/2026-09-04.md
git commit -F <utf8："docs: 安装包构建与使用说明、HANDOFF 与会话记录更新">
```

---

## 自查

**Spec 覆盖**：§3 决策（Electron/node.exe/kernel.tar/`desk-app`/WinSW/makensis 复用/网关地址）→ Task 2、3、5、8；§4 产物与版本 → Task 6、8；§5.1-5.3 客户端布局 / 流程 / 修剪 → Task 2、3、5；§6 服务端布局 / 安装升级卸载 → Task 7、8；§7 流水线与 `.gitignore` → Task 2、6、8；§8 代码改动（bootstrap 抽取、消掉两次 install-kernel）→ Task 1；§9 错误处理 → Task 3（tar 缺失 / 解压失败 / PATCH_FAIL）、Task 5（对话框 + 日志）、Task 8（init 失败中止）；§10 验证 → 各任务验证步骤 + Task 8 Step 6 用户 checklist；§11 风险（Electron 下载 / bsdtar 长路径 / 体积）→ Task 5 Step 5、Task 2 Step 7、README。

**占位符**：无 TBD；所有代码步骤有完整代码；提交信息给出全文。

**类型一致性**：`ensureProfile` 参数名（`profileName, dshHome, root, pluginsDir, patchFile, kernel, nodeExe, selfHeal, log`）在 Task 1 / 3 / 测试一致；`preparePackaged` 返回字段 `kernelBin / profileName` 与 `main.js` 的 `ready.kernelBin / ready.profileName` 一致；NDJSON `step` 集合与 `main.js` 的 `STEP_LABEL` 一致；`init()` 返回 `{ dataDir, logDir, configFile, wroteConfig, port, publicUrl }` 与测试一致；`payload.json` 字段 `buildId / kernel.version` 与 `preparePackaged` 读取一致。
