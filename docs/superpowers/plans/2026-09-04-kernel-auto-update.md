# 内核自动更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 GitHub `deepseek-ai/deepseek-harness` 的 Release 发现新内核，公司侧试打 16 处补丁通过后发布到网关；员工机登录后后台下载，**下次启动**再切换。

**Architecture:** 纯函数在 `scripts/lib/kernel-update.mjs`（版本解析、清单、pending、sha256）。试打打 tar 在 `scripts/lib/kernel-prepare.mjs`（npm 装指定版本 + `applyKernelPatches` + `shouldPrune` + tar）。网关目录与指针在 `server/src/kernel-catalog.js`，HTTP 挂在现有 `api.js` 会话鉴权上。员工机 `desk-host` 登录后拉 tar；`bootstrap.mjs` 的 `applyPendingKernel` 在 `preparePackaged` / `ensureKernelDev` 之前切换。

**Tech Stack:** Node 26（`node:test`、`fetch`、`node:crypto`）、现有 `scripts/kernel/patches.mjs`、Windows `tar.exe`、无新 npm 依赖。

设计文档：`docs/superpowers/specs/2026-09-04-kernel-auto-update-design.md`。

## Global Constraints

- 上游只认 `https://github.com/deepseek-ai/deepseek-harness` 的 GitHub Release；tag `dsh-vX.Y.Z[-pre]` ↔ npm `@deepseek-ai/dsh@X.Y.Z[-pre]`。员工机不直连 GitHub / npm。
- 16 处补丁只能通过 `applyKernelPatches` / `missingPatches`；锚点失败不得写 `current`、不得切换员工机内核。
- `pin.json` 仍是安装包保底版本（现在 `0.1.1-rc.2`）。本轮**不**改 pin、不把生产升到 `0.1.2-rc.1`。
- 根 `package.json` 只有 `esbuild` 一个 devDependency。`scripts/kernel/patches.mjs` 的补丁正文不手改。
- 测试：`npm test` 全绿；只用 `os.tmpdir()`；不碰 `server/data/`、`~/.dsh`、`~/.company-desk/kernel`；不打真 GitHub（fixture）。
- 提交信息中文 UTF-8；PowerShell 5.1 不用 `&&`，commit 用 `git commit -F <utf8 文件>`。
- 首次启动仍不联网；下载挂在 desk-host **登录之后**；Electron `main.js` 不发 HTTP。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `scripts/lib/kernel-update.mjs`（新） | `SOURCE_REPO`、`parseReleaseTag`、`newerThan`、`filterDiscoverable`、`hashFile`、`readPending`、`writePending`、`pendingPaths`、`clearPending` |
| `scripts/lib/kernel-prepare.mjs`（新） | `prepareKernelTarball({ version, prefix, outDir, skillsDir, log })`：npm 装指定版本、打补丁、修剪、tar、写 manifest |
| `scripts/kernel/update.mjs`（新） | CLI：`discover` / `prepare` / `publish` |
| `scripts/test/kernel-update.test.mjs`（新） | 纯函数 + pending + applyPending（假 tar）+ prepare 失败路径 |
| `server/src/kernel-catalog.js`（新） | `data/kernels/` 读写、`current.json`、publish / rollback、listStored |
| `server/src/api.js`（改） | `/api/kernel/*`、`/api/admin/kernel*` |
| `server/src/admin-page.js`（改） | 管理页「内核」一节 |
| `server/test/gateway.test.js`（改） | 员工 401 / 已登录 current、admin publish/rollback |
| `scripts/lib/bootstrap.mjs`（改） | 导出 `applyPendingKernel`；`preparePackaged` / `ensureKernelDev` 开头调用 |
| `plugins/desk-host/lib/kernel-update.js`（新） | `fetchKernelUpdate({ gateway, pendingDir, localVersion, log })` |
| `plugins/desk-host/lib/index.js`（改） | 登录成功后与启动已登录时 fire-and-forget |
| `scripts/build-gateway-installer.mjs`（改） | 随包装 `scripts/kernel/{patches,locate,pin}.mjs/json`、`scripts/lib/{kernel-update,kernel-prepare,payload}.mjs`，以及构建机 Node 旁的 `node_modules/npm`（给网关 prepare 用） |
| `package.json`、`README.md`、`docs/HANDOFF.md`、`docs/sessions/2026-09-04.md`（改） | 脚本入口与文档 |

---

### Task 1: 纯函数 `scripts/lib/kernel-update.mjs`

**Files:**
- Create: `scripts/lib/kernel-update.mjs`
- Create: `scripts/test/kernel-update.test.mjs`

**Interfaces:**
- Consumes: `node:crypto`、`node:fs`、`node:path`、`node:os`
- Produces:
  - `SOURCE_REPO = 'https://github.com/deepseek-ai/deepseek-harness'`
  - `SOURCE_API = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=20'`
  - `parseReleaseTag(tag: string): { version: string } | null`
  - `newerThan(a: string, b: string): boolean`（`a` 比 `b` 新）
  - `filterDiscoverable(releases: object[], currentVersion: string | null): { tag, version, name, prerelease }[]`
  - `hashFile(file: string): string`（sha256 hex）
  - `defaultPendingDir(): string` → `~/.company-desk/app/kernel-next`
  - `pendingPaths(dir): { dir, tar, partial, json }`
  - `readPending(dir): { version, sha256, downloadedAt } | null`
  - `writePending(dir, { version, sha256 })`
  - `clearPending(dir): void`

- [ ] **Step 1: 写失败测试**

`scripts/test/kernel-update.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseReleaseTag, newerThan, filterDiscoverable, hashFile,
  pendingPaths, readPending, writePending, clearPending,
} from '../lib/kernel-update.mjs'

test('parseReleaseTag：只认 dsh-v 前缀', () => {
  assert.deepEqual(parseReleaseTag('dsh-v0.1.2-rc.1'), { version: '0.1.2-rc.1' })
  assert.deepEqual(parseReleaseTag('dsh-v0.1.1-rc.2'), { version: '0.1.1-rc.2' })
  assert.equal(parseReleaseTag('v0.1.2-rc.1'), null)
  assert.equal(parseReleaseTag('dsh-0.1.2'), null)
})

test('newerThan：核心版本与预发布', () => {
  assert.equal(newerThan('0.1.2-rc.1', '0.1.1-rc.2'), true)
  assert.equal(newerThan('0.1.2', '0.1.2-rc.1'), true)
  assert.equal(newerThan('0.1.2-rc.1', '0.1.2-alpha.5'), true)
  assert.equal(newerThan('0.1.1-rc.2', '0.1.2-rc.1'), false)
  assert.equal(newerThan('0.1.1-rc.2', '0.1.1-rc.2'), false)
})

test('filterDiscoverable：丢掉 draft / 旧版 / 坏 tag', () => {
  const rel = [
    { tag_name: 'dsh-v0.1.2-rc.1', draft: false, prerelease: true, name: 'v0.1.2-rc.1' },
    { tag_name: 'dsh-v0.1.1-rc.2', draft: false, prerelease: true, name: 'v0.1.1-rc.2' },
    { tag_name: 'dsh-v0.1.3', draft: true, prerelease: false, name: 'draft' },
    { tag_name: 'other-v1', draft: false, name: 'nope' },
  ]
  const out = filterDiscoverable(rel, '0.1.1-rc.2')
  assert.deepEqual(out.map((x) => x.version), ['0.1.2-rc.1'])
  assert.equal(filterDiscoverable(rel, null).length, 2) // 0.1.2-rc.1 + 0.1.1-rc.2
})

test('pending：读写、hash、清理', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diva-kup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'a.bin')
  fs.writeFileSync(file, 'hello')
  const sha = hashFile(file)
  assert.equal(sha, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  assert.equal(readPending(dir), null)
  writePending(dir, { version: '0.1.2-rc.1', sha256: sha })
  const p = readPending(dir)
  assert.equal(p.version, '0.1.2-rc.1')
  assert.equal(p.sha256, sha)
  assert.ok(p.downloadedAt)
  assert.equal(pendingPaths(dir).json, path.join(dir, 'pending.json'))
  clearPending(dir)
  assert.equal(readPending(dir), null)
  assert.equal(fs.existsSync(dir), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/test/kernel-update.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND` 或 `does not provide an export named 'parseReleaseTag'`。

- [ ] **Step 3: 实现**

`scripts/lib/kernel-update.mjs`：

```js
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SOURCE_REPO = 'https://github.com/deepseek-ai/deepseek-harness'
export const SOURCE_API = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=20'

export function parseReleaseTag(tag) {
  const m = /^dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag ?? ''))
  return m ? { version: m[1] } : null
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? ''))
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre }
}

function cmpPre(a, b) {
  // 无预发布 > 有预发布；alpha < rc < 数字标识；逐段比较
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const rank = (p) => (p === 'alpha' ? 1 : p === 'rc' ? 2 : typeof p === 'number' ? 10 : 0)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    const rx = rank(x), ry = rank(y)
    if (rx !== ry) return rx - ry
    return String(x).localeCompare(String(y))
  }
  return 0
}

export function newerThan(a, b) {
  const A = parseSemver(a), B = parseSemver(b)
  if (!A || !B) return false
  if (A.major !== B.major) return A.major > B.major
  if (A.minor !== B.minor) return A.minor > B.minor
  if (A.patch !== B.patch) return A.patch > B.patch
  return cmpPre(A.pre, B.pre) > 0
}

export function filterDiscoverable(releases, currentVersion) {
  const out = []
  for (const r of releases ?? []) {
    if (r?.draft) continue
    const parsed = parseReleaseTag(r.tag_name)
    if (!parsed) continue
    if (currentVersion && !newerThan(parsed.version, currentVersion)) continue
    out.push({ tag: r.tag_name, version: parsed.version, name: r.name ?? r.tag_name, prerelease: !!r.prerelease })
  }
  return out.sort((x, y) => (newerThan(x.version, y.version) ? -1 : newerThan(y.version, x.version) ? 1 : 0))
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function defaultPendingDir() {
  return path.join(os.homedir(), '.company-desk', 'app', 'kernel-next')
}

export function pendingPaths(dir) {
  return {
    dir,
    tar: path.join(dir, 'kernel.tar'),
    partial: path.join(dir, 'kernel.tar.partial'),
    json: path.join(dir, 'pending.json'),
  }
}

export function readPending(dir) {
  const f = pendingPaths(dir).json
  if (!fs.existsSync(f)) return null
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!j.version || !j.sha256) return null
    return j
  } catch {
    return null
  }
}

export function writePending(dir, { version, sha256 }) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(pendingPaths(dir).json, JSON.stringify({ version, sha256, downloadedAt: new Date().toISOString() }, null, 2) + '\n')
}

export function clearPending(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/test/kernel-update.test.mjs`

Expected: 4/4 pass。

- [ ] **Step 5: Commit**

```
feat(kernel): 版本发现与 pending 纯函数（GitHub tag dsh-v*、sha256、kernel-next）
```

---

### Task 2: 网关目录 `kernel-catalog.js` + HTTP

**Files:**
- Create: `server/src/kernel-catalog.js`
- Modify: `server/src/api.js`（在 `registerApi` 里挂路由；`KERNEL_LABEL` 保留给 `/api/status`）
- Modify: `server/test/gateway.test.js`（追加用例，不改已有用例）

**Interfaces:**
- Consumes: Task 1 的 `SOURCE_REPO`、`hashFile`、`filterDiscoverable`、`parseReleaseTag`（catalog 的 discover 可注入 `fetchReleases`）
- Produces:
  - `openKernelCatalog(dataDir, { pinVersion, fetchReleases })`
  - `catalog.readCurrent()` → `current.json` 对象或 `null`
  - `catalog.employeeView()` → `{ version, sha256, sourceTag, bundled, tarball }`
  - `catalog.listStored()` → `{ version, sha256, bytes }[]`
  - `catalog.saveArtifact({ version, tarPath, manifest })`
  - `catalog.publish(version)` → 新 `current`（旧的进 `previous`）
  - `catalog.rollback()` → 对调；无 previous 抛 `{ code: 'no_previous' }`
  - `catalog.tarballPath()` → current 的 tar 绝对路径或 `null`
  - `catalog.adminView()` → `{ current, stored, discover, discoverError, pinVersion }`
  - HTTP 见下

路由（均走现有 `auth()`；admin 再 `requireAdmin`）：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/kernel/current` | `employeeView()` |
| GET | `/api/kernel/tarball` | 有 current 则 `application/octet-stream`；否则 404 |
| GET | `/api/admin/kernel` | `adminView()`（discover 失败只填 `discoverError`） |
| POST | `/api/admin/kernel/publish` | JSON `{ version }` 发布已存目录；或 `content-type: application/octet-stream` + 头 `x-kernel-version` / `x-kernel-sha256` / `x-kernel-source-tag` 上传后发布 |
| POST | `/api/admin/kernel/rollback` | `rollback()`；无 previous → 400 |
| POST | `/api/admin/kernel/prepare` | **本任务先返回 501** `{ error: { message: 'prepare 尚未接入', code: 'not_implemented' } }`，Task 3 再接上（避免本任务去跑 npm） |

`current.json` 字段必须是：`version`、`sha256`、`sourceTag`、`sourceRepo`、`publishedAt`、`previous`（`null` 或 `{ version, sha256 }`）。

无 `current.json` 时 `employeeView()`：`{ version: pinVersion, sha256: null, sourceTag: null, bundled: true, tarball: false }`。

- [ ] **Step 1: 在 `gateway.test.js` 末尾追加失败用例**（先写断言，catalog 还不存在时这些会 404）

```js
test('内核：未登录读 current 是 401；登录后无 current 则 bundled', async () => {
  const no = await api('GET', '/api/kernel/current')
  assert.equal(no.status, 401)
  const ok = await api('GET', '/api/kernel/current', { token: ctx.boss })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.bundled, true)
  assert.equal(ok.json.tarball, false)
  const tar = await api('GET', '/api/kernel/tarball', { token: ctx.boss })
  assert.equal(tar.status, 404)
})

test('内核：员工不能 publish；管理员 publish / rollback', async () => {
  const emp = await api('POST', '/api/auth/login', { body: { username: 'ada', password: 'ada123456', device: 'test' } })
  const forbidden = await api('POST', '/api/admin/kernel/publish', { token: emp.json.sessionToken, body: { version: '9.9.9' } })
  assert.equal(forbidden.status, 403)

  const dir = path.join(tmp, 'kernels', '0.1.9-test')
  fs.mkdirSync(dir, { recursive: true })
  const tar = path.join(dir, 'kernel.tar')
  fs.writeFileSync(tar, 'FAKE-TAR')
  const sha = crypto.createHash('sha256').update('FAKE-TAR').digest('hex')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    package: '@deepseek-ai/dsh', version: '0.1.9-test', sha256: sha, bytes: 8,
    sourceTag: 'dsh-v0.1.9-test', sourceRepo: 'https://github.com/deepseek-ai/deepseek-harness',
    patched: 'test', builtAt: new Date().toISOString(),
  }))

  const pub = await api('POST', '/api/admin/kernel/publish', { token: ctx.boss, body: { version: '0.1.9-test' } })
  assert.equal(pub.status, 200)
  assert.equal(pub.json.version, '0.1.9-test')
  assert.equal(pub.json.previous, null)

  const cur = await api('GET', '/api/kernel/current', { token: ctx.boss })
  assert.equal(cur.json.bundled, false)
  assert.equal(cur.json.version, '0.1.9-test')
  assert.equal(cur.json.sha256, sha)

  const bin = await fetch(base + '/api/kernel/tarball', { headers: { authorization: 'Bearer ' + ctx.boss } })
  assert.equal(bin.status, 200)
  assert.equal(Buffer.from(await bin.arrayBuffer()).toString(), 'FAKE-TAR')

  const rb0 = await api('POST', '/api/admin/kernel/rollback', { token: ctx.boss })
  assert.equal(rb0.status, 400)

  fs.mkdirSync(path.join(tmp, 'kernels', '0.1.8-test'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'kernels', '0.1.8-test', 'kernel.tar'), 'OLD')
  const sha8 = crypto.createHash('sha256').update('OLD').digest('hex')
  fs.writeFileSync(path.join(tmp, 'kernels', '0.1.8-test', 'manifest.json'), JSON.stringify({
    package: '@deepseek-ai/dsh', version: '0.1.8-test', sha256: sha8, bytes: 3,
    sourceTag: 'dsh-v0.1.8-test', sourceRepo: 'https://github.com/deepseek-ai/deepseek-harness',
    patched: 'test', builtAt: new Date().toISOString(),
  }))
  await api('POST', '/api/admin/kernel/publish', { token: ctx.boss, body: { version: '0.1.8-test' } })
  const after = await api('GET', '/api/kernel/current', { token: ctx.boss })
  assert.equal(after.json.version, '0.1.8-test')
  assert.equal(after.json.sha256, sha8)

  const rb = await api('POST', '/api/admin/kernel/rollback', { token: ctx.boss })
  assert.equal(rb.status, 200)
  assert.equal(rb.json.version, '0.1.9-test')
})
```

在文件顶部补 `import crypto from 'node:crypto'`。`ctx.boss` 已有第一个登录用例赋值的话就用它；若现有测试把 token 放在 `ctx.admin` / 局部变量，**对照文件里实际名字**，不要臆造。第一个用例里是 `boss.json.sessionToken`——在那个用例末尾加 `ctx.boss = boss.json.sessionToken`（若还没有）。

- [ ] **Step 2: 跑这些测试确认失败**

Run: `node --test server/test/gateway.test.js`

Expected: `/api/kernel/current` 404 或未登录以外的失败。

- [ ] **Step 3: 实现 catalog + 路由**

`server/src/kernel-catalog.js`：根目录 `path.join(dataDir, 'kernels')`；`current.json` 在该根下。`publish(version)` 读 `<ver>/manifest.json` + 校验 tar 的 `hashFile` === manifest.sha256，再写 current（把旧 current 的 `{version,sha256}` 放进 `previous`）。`rollback` 要求 `previous` 对应目录仍在。`fetchReleases` 默认 `async () => { const r = await fetch(SOURCE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'the-diva-gateway', ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}) }, signal: AbortSignal.timeout(15_000) }); if (!r.ok) throw new Error('GitHub HTTP ' + r.status); return r.json() }`。

`api.js`：`createGateway` / `registerApi` 里 `const kernels = openKernelCatalog(cfg.dataDir, { pinVersion: 从 pin.json 读 version })`。二进制上传用现有 `readBody`（看 `http.js` 是否已有 raw buffer；没有就 `readBody(req)` 收满再校验 sha256）。

GET tarball：`fs.createReadStream` + `content-type: application/octet-stream` + `content-length`。

- [ ] **Step 4: 跑 `npm test`**

Expected: 原有用例 + 新用例全绿。

- [ ] **Step 5: Commit**

```
feat(gateway): 内核目录 current.json 与员工/管理员 HTTP（publish / rollback / tarball）
```

---

### Task 3: `prepareKernelTarball` + CLI `update.mjs`

**Files:**
- Create: `scripts/lib/kernel-prepare.mjs`
- Create: `scripts/kernel/update.mjs`
- Modify: `server/src/api.js`（`POST /api/admin/kernel/prepare` 改为真做）
- Modify: `package.json`（加 `kernel:discover` / `kernel:prepare` / `kernel:publish`）
- Modify: `scripts/test/kernel-update.test.mjs`（prepare 失败路径）
- Modify: `scripts/build-gateway-installer.mjs`（复制 prepare 所需脚本 + 构建机 `node_modules/npm`）

**Interfaces:**
- Consumes: `applyKernelPatches`、`missingPatches`、`KernelPatchError`、`locateKernel`、`stampPath`、`ALL_MARKS`、`shouldPrune`、`findTar`（`bootstrap.mjs`）、Task 1/2
- Produces:
  - `prepareKernelTarball({ version, prefix, outDir, skillsDir, log })` → `{ tarPath, manifest }`
  - 失败抛 `Error` 或 `KernelPatchError`；**不**写 `outDir/<ver>/` 半成品（先写 staging 再 rename）
  - CLI 退出码：用法 64；业务失败 1；成功 0
  - `POST /prepare` body `{ version }`：在 `dataDir/kernels/.stage-<ver>` 上跑 prepare，成功后 `saveArtifact`，**不** publish

`prepareKernelTarball` 步骤（与 `install-kernel.mjs` 同构，但版本是参数，**不**和 `PIN.version` 比较）：

1. `npm install -g @deepseek-ai/dsh@<version> --prefix <prefix> --no-fund --no-audit`（复用 `install-kernel.mjs` 的 `npmInvocation` 逻辑；可把 `npmInvocation` 抽到 `scripts/lib/npm-cli.mjs` 两边 import，避免复制。若抽取，本任务一起做。）
2. `locateKernel(prefix)`，`kernel.version === version` 否则抛错
3. `applyKernelPatches`；`missingPatches` 非空则抛错
4. 写戳记（`package: '@deepseek-ai/dsh'`、`version: kernel.version`，不要写死 PIN.version）
5. 复制到 staging，按 `shouldPrune` 删文件，`tar -cf` 到 `outDir/<ver>/kernel.tar`，`hashFile`，写 `manifest.json`：`package, version, sha256, bytes, sourceTag: 'dsh-v'+version, sourceRepo, patched: '新打 N 处，已有 M 处', builtAt`

测试（**不**跑真 npm）：给 `prepareKernelTarball` 增加可选 `installer` 注入，默认才 spawn npm。测试传入 `installer: () => { throw new KernelPatchError('target-missing', 'x') }` 或在假 prefix 里不装包直接调内部 `patchAndPack`——更干净的拆法：

- 导出 `packPatchedPrefix({ prefix, version, outDir, skillsDir, log })`：假定 prefix 里已有内核，只打补丁 + tar
- `prepareKernelTarball` = npm 安装 + `packPatchedPrefix`

测试只测 `packPatchedPrefix`：假 prefix 缺补丁文件 → 抛 `KernelPatchError`，`outDir/<ver>` 不存在。

CLI：

```
node scripts/kernel/update.mjs discover [--current 0.1.1-rc.2]
node scripts/kernel/update.mjs prepare --version 0.1.2-rc.1 [--out build/kernel-update] [--prefix <tmp>]
node scripts/kernel/update.mjs publish --gateway http://127.0.0.1:8790 --user boss --password … --from build/kernel-update/0.1.2-rc.1
```

`publish`：`POST /api/auth/login` `{ gatewayToken: false }` → `POST /api/admin/kernel/publish` 二进制（读 `--from/kernel.tar`，头带 version/sha256/sourceTag）。`--from` 目录必须有 `manifest.json`。

`discover` 默认 `--current`：若设了 `DESK_GATEWAY_URL` 且能登录则用网关 current.version，否则 `PIN.version`。为免 CLI 强制要密码，**默认只读 pin.json**；`--gateway` 可选去拉 current。

网关 installer：把 `scripts/kernel/patches.mjs`、`locate.mjs`、`pin.json` 和 `scripts/lib/{kernel-update,kernel-prepare,payload,npm-cli}.mjs` 拷到 stage（与 `server/src` 的 `../../scripts/...` 相对位置一致）。若构建机 `path.join(path.dirname(process.execPath), 'node_modules', 'npm')` 存在，拷到 `runtime/node_modules/npm`，这样安装版 `process.execPath` 旁有 npm-cli。没有 npm 时 prepare 返回 501 `npm_missing`。

- [ ] **Step 1: 写 `packPatchedPrefix` 失败测试并看它红**
- [ ] **Step 2: 实现 prepare + CLI + 接上 `/prepare`**
- [ ] **Step 3: `node --test scripts/test/kernel-update.test.mjs` + `npm test`**
- [ ] **Step 4: 手工（可在报告里写跳过原因）：** `node scripts/kernel/update.mjs discover` 应列出 `dsh-v0.1.2-rc.1`。对 `0.1.1-rc.2` 跑 `prepare`（复用 `~/.company-desk/kernel` 当 `--prefix` 若版本匹配，否则会联网数分钟）。**不要**对 `0.1.2-rc.1` 自动 publish。
- [ ] **Step 5: Commit**

```
feat(kernel): prepare 打指定版本 tar + CLI discover/prepare/publish；网关 /prepare 接入
```

---

### Task 4: `applyPendingKernel`（下次启动切换）

**Files:**
- Modify: `scripts/lib/bootstrap.mjs`
- Modify: `scripts/test/kernel-update.test.mjs` 或 `scripts/test/bootstrap.test.mjs`（pending 切换用例放 kernel-update 测试里即可，避免 20s payload 用例）

**Interfaces:**
- Consumes: `pendingPaths`、`readPending`、`clearPending`、`hashFile`、`findTar`、`locateKernel`、`pinSkillsRoot`、`missingPatches`
- Produces:
  - `applyPendingKernel({ pendingDir, targetPrefix, skillsDir, log }): { applied: boolean, version?: string, detail: string }`
  - `preparePackaged`：在判断 `fresh` / 解 tar **之前**调用；`targetPrefix = path.join(appDir, 'kernel')`，`pendingDir = path.join(path.dirname(appDir), 'kernel-next')` 当 `appDir` 是 `~/.company-desk/app` 时即 spec 的位置。实现写成：`pendingDir = path.join(path.dirname(appDir), 'kernel-next')`（与 `app` 并列，不是 `app/kernel-next`）。

等一下——spec 写的是 `~/.company-desk/app/kernel-next/`。安装版 `appDir` 默认就是 `~/.company-desk/app`，所以 pending 应在 **`path.join(appDir, 'kernel-next')`**，与 `kernel/` 并列在 app 下。开发版 `ensureKernelDev` 传入 `pendingDir = defaultPendingDir()`（仍是 `~/.company-desk/app/kernel-next`），`targetPrefix = prefix`（`~/.company-desk/kernel`）。

**纠正：** `pendingDir = path.join(appDir, 'kernel-next')`（安装版）；开发版用 `defaultPendingDir()`。与 spec 第 3.3 节一致。

逻辑：

```
export function applyPendingKernel({ pendingDir, targetPrefix, skillsDir, log = noop }) {
  const pending = readPending(pendingDir)
  const paths = pendingPaths(pendingDir)
  if (!pending || !fs.existsSync(paths.tar)) return { applied: false, detail: 'no-pending' }
  if (hashFile(paths.tar) !== pending.sha256) {
    clearPending(pendingDir)
    log('内核更新未生效，校验失败，仍用旧内核')
    return { applied: false, detail: 'hash-mismatch' }
  }
  const staging = targetPrefix + '-staging'
  const prev = targetPrefix + '-prev'
  try {
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    const r = spawnSync(findTar(), ['-xf', paths.tar, '-C', staging], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) throw new Error(r.stderr || r.error?.message || 'tar')
    const kernel = locateKernel(staging)
    if (!kernel?.bin || !fs.existsSync(kernel.bin)) throw new Error('no-bin')
    pinSkillsRoot({ kernelPrefix: staging, kernel, skillsDir, log })
    if (missingPatches(kernel.root).length) throw new Error('patches')
    fs.rmSync(prev, { recursive: true, force: true })
    if (fs.existsSync(targetPrefix)) fs.renameSync(targetPrefix, prev)
    fs.renameSync(staging, targetPrefix)
    clearPending(pendingDir)
    log(`内核已更新到 ${pending.version}`)
    return { applied: true, version: pending.version, detail: 'ok' }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    clearPending(pendingDir)
    const old = locateKernel(targetPrefix)
    log(`内核更新未生效，仍用 ${old?.version ?? '旧版本'}`)
    return { applied: false, detail: String(err.message) }
  }
}
```

`preparePackaged` 第一行：`applyPendingKernel({ pendingDir: path.join(appDir, 'kernel-next'), targetPrefix: path.join(appDir, 'kernel'), skillsDir: path.join(dshHome, 'desk', 'drive', '_shared', 'skills'), log })`。

`ensureKernelDev` 第一行同样，`pendingDir: defaultPendingDir()`，`targetPrefix: prefix`。

测试：临时 prefix + 一个最小 tar（里面放 `node_modules/@deepseek-ai/dsh/package.json` `{version:"9.0.0"}` 和 `lib/bin.js` 空文件）。hash 对但 `missingPatches` 会因缺补丁文件失败 → `applied: false`、原 prefix 若已有内容则保留。再测 hash 不对 → 不切换。再测：tar 里带齐 `ALL_MARKS` 每个 file 只写 mark（与现有 `pinSkillsRoot` 假内核用例相同）→ `applied: true`，`locateKernel(target).version === '9.0.0'`。

- [ ] **Step 1–4: TDD + 实现 + `npm test`**
- [ ] **Step 5: Commit**

```
feat(bootstrap): 下次启动应用 kernel-next（校验 sha256 / 补丁，失败回退旧内核）
```

---

### Task 5: desk-host 登录后后台下载

**Files:**
- Create: `plugins/desk-host/lib/kernel-update.js`
- Modify: `plugins/desk-host/lib/index.js`（`login` 成功后、以及启动时已登录的 `ctx.effect` 里，`fetchKernelUpdate(...).catch(log)`，不 await 挡住登录返回）

**Interfaces:**
- Consumes: `GatewayClient.request`（GET current 走 json；GET tarball 已返回 Buffer）、Task 1 pending helpers
- Produces:
  - `fetchKernelUpdate({ gateway, pendingDir, localVersion, log })` → `{ action: 'skip'|'downloaded'|'cleared'|'error', detail: string }`
  - skip：`bundled` 或 `version === localVersion` 或无 sha256
  - 若已有 pending 且 `pending.sha256 !== current.sha256` → `clearPending`
  - 若已有 pending 且 hash 相同 → skip
  - 否则 GET tarball，写入 `kernel.tar.partial`，`hashFile` 对上再 rename 成 `kernel.tar` 并 `writePending`；不对则 `clearPending` 并 log
  - 超时：tarball 用 `timeoutMs: 600_000`（10 分钟）；失败 catch 后 `{ action:'error' }`，不抛给登录

`localVersion`：安装版读 `~/.company-desk/app/kernel` 的 `locateKernel`；开发版读 `defaultPrefix()`。desk-host 不要 import `scripts/`（安装版 host 在 `appDir/plugins`，scripts 在 `appDir/scripts`）。**把 pending 的读写小函数在 host 里复述一份会违反 DRY**——改为 host 用相对路径 import `../../../scripts/lib/kernel-update.mjs` 在开发仓库成立，安装版 payload 已带 `scripts/lib/bootstrap.mjs` 等同目录。desk-host 在 profile 的 `node_modules/@company-desk/desk-host` junction 到 `appDir/plugins/desk-host`，从 `lib/kernel-update.js` 无法稳定指到 `appDir/scripts`。

**裁定：** pending 读写只留在 `scripts/lib/kernel-update.mjs`。host 用 **动态 import**：`path.join(process.env.DESK_APP_DIR ?? path.join(os.homedir(), '.company-desk', 'app'), 'scripts', 'lib', 'kernel-update.mjs')`，失败再 fallback `fileURLToPath(new URL('../../../scripts/lib/kernel-update.mjs', import.meta.url))`（开发仓库）。Electron / launch 给安装版设 `DESK_APP_DIR=appDir`（`spawnClient` 的 `env` 加这一项）。开发模式不设，走 fallback。

`spawnClient` 现有签名加：调用方已传 `env`。改 `bootstrap.spawnClient`：若 `cwd` 或新增 `appDir` 有值，设 `DESK_APP_DIR`。`preparePackaged` 返回的 `appDir` 已被 Electron 用来 spawn——改 `desktop/main.js` 里 spawn 内核的 env 加上 `DESK_APP_DIR=ready.appDir`。`launch.mjs` 开发模式不设。

- [ ] **Step 1: 给 `fetchKernelUpdate` 写单测**（mock gateway：`{ get(p) {…}, request(method,p,o){…} }`），放 `scripts/test/kernel-update.test.mjs` 或 `plugins/desk-host` 没有测试目录——**放 `scripts/test/kernel-update.test.mjs`**，import host 模块。
- [ ] **Step 2–4: 实现 + 接 login/effect + `npm test`**
- [ ] **Step 5: Commit**

```
feat(desk-host): 登录后从网关后台拉取内核 tar 到 kernel-next
```

---

### Task 6: 管理页 + 文档

**Files:**
- Modify: `server/src/admin-page.js`（`renderMain` 在「服务器」section 后插入「内核」；仅 `isAdmin` 显示按钮）
- Modify: `README.md`（§2.5 附近加「内核更新」：三条 CLI、管理页、员工下次启动、不升 0.1.2 除非 prepare 过）
- Modify: `docs/HANDOFF.md`（自动更新：内核有门禁；壳没有）
- Modify: `docs/sessions/2026-09-04.md` 或新建 `docs/sessions/2026-09-04-kernel-update.md` 追加本项
- Modify: `docs/superpowers/specs/2026-09-04-kernel-auto-update-design.md` 状态改为已实现（等代码合入后改）

管理页 UI（字符串拼进现有 template，风格与「模型通道」相同）：

- 当前：`current.version` 或「随包保底 `pinVersion`」
- 已存版本表 + 「发布」按钮（`POST publish {version}`）
- 发现列表（`discover[]`）+ 「试打补丁」→ `POST prepare {version}`（按钮 disable + toast「可能需要几分钟」）
- 「回滚到上一版」→ `POST rollback`
- `discoverError` 红字

总监只读（与通道一节相同：`isAdmin` 才有按钮）。`GET /api/admin/kernel` 对总监：现在 `requireAdmin` 会 403——**改为总监也可 GET**（`user.role === 'employee'` 才 403），POST 仍要 admin。改 Task 2 的 `GET /api/admin/kernel` 鉴权：`if (user.role === 'employee') throw 403`。若 Task 2 已写成 requireAdmin，本任务改掉并补一条总监 GET 200 的测试。

- [ ] **Step 1: 改 GET 鉴权 + 管理页 HTML + 测试**
- [ ] **Step 2: 文档**
- [ ] **Step 3: `npm test`**
- [ ] **Step 4: Commit**

```
docs: 内核门禁更新的管理页与 README / HANDOFF
```

---

## 自检（对照 spec）

| spec | 任务 |
|---|---|
| GitHub Release 发现、tag → npm 版本 | 1 + 3 |
| prepare 打补丁，失败不发布 | 3 |
| 网关 current / tarball / publish / rollback / prepare | 2 + 3 |
| 管理页 | 6 |
| CLI discover/prepare/publish | 3 |
| 员工下次启动切换、hash 失败回退 | 4 |
| 登录后后台下载、未登录不拉 | 5 |
| 首次启动不联网、Electron 不 HTTP | 4/5（不改 main.js 发请求；只加 DESK_APP_DIR） |
| 不改 pin、不自动升 0.1.2 | Global + Task 3 手工步骤 |
| 网关随包 scripts + npm | 3 |
| README / HANDOFF | 6 |

无 TBD。`pendingDir` 安装版 = `appDir/kernel-next`（已在 Task 4 写死，与 spec `~/.company-desk/app/kernel-next` 对齐）。
