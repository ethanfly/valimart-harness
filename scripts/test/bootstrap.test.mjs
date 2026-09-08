import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertSafeAppDir, ensureProfile, findFreePort, needsExtract, pinSkillsRoot, preparePackaged, profileNeedsSetup, profilePluginBundles, readGatewayUrl } from '../lib/bootstrap.mjs'
import { ALL_MARKS, resolvePresetRel } from '../kernel/patches.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diva-bootstrap-'))
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

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
  fs.mkdirSync(path.join(profileDir, 'node_modules', '@company-desk', 'desk-host'), { recursive: true })
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

test('profilePluginBundles：只把已装进内核前缀的 pin 插件加进 bundle 列表', (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'kernel', 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  // 没装任何插件：不加
  assert.deepEqual(profilePluginBundles({ root: kernelRoot }), [])
  // 装了 better-sidebar、没装 browser：只加装了的
  const sidebar = path.join(dir, 'kernel', 'node_modules', 'dsh-better-sidebar')
  fs.mkdirSync(sidebar, { recursive: true })
  fs.writeFileSync(path.join(sidebar, 'package.json'), '{"name":"dsh-better-sidebar"}\n')
  // 内核嵌套的 @deepseek-ai/* peer：ensureProfile 会把它们链接到顶层 scope，插件才 import 得到
  const nestedPeer = path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-tools')
  fs.mkdirSync(nestedPeer, { recursive: true })
  fs.writeFileSync(path.join(nestedPeer, 'package.json'), '{"name":"@deepseek-ai/dsh-tools"}\n')
  assert.deepEqual(profilePluginBundles({ root: kernelRoot }), ['dsh-better-sidebar'])
  // 没有内核 root（旧调用/测试桩）时静默返回空，不炸
  assert.deepEqual(profilePluginBundles({ bin: 'unused' }), [])
  // ensureProfile 把插件写进 manifest.dsh.profile.bundles
  const dshHome = path.join(dir, 'dsh')
  const root = path.join(dir, 'root')
  const pluginsDir = path.join(root, 'plugins')
  for (const p of ['desk-host', 'desk-ui']) fs.mkdirSync(path.join(pluginsDir, p), { recursive: true })
  const patchFile = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(patchFile, "gatewayUrl: 'http://x:1'\n")
  fs.mkdirSync(path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'), { recursive: true })
  const { profileDir } = ensureProfile({ profileName: 'desk-plugins', dshHome, root, pluginsDir, patchFile, kernel: { root: kernelRoot }, selfHeal: false, log: () => {} })
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-better-sidebar'])
  // 插件还要链接到 profiles/node_modules（运行时 import 只沿 profile 目录向上找）
  assert.ok(fs.lstatSync(path.join(dshHome, 'profiles', 'node_modules', 'dsh-better-sidebar')).isSymbolicLink())
  // 内核嵌套的 @deepseek-ai/* peer 链接到顶层 scope（插件真实路径的 import 才找得到）
  assert.ok(fs.lstatSync(path.join(dir, 'kernel', 'node_modules', '@deepseek-ai', 'dsh-tools')).isSymbolicLink())
})

test('ensureProfile：全新 DSH_HOME 没有扁平回退目录时，从内核物化，不要求先跑过 dsh', () => {
  const dir = tmp()
  const dshHome = path.join(dir, 'dsh')
  const kernelRoot = path.join(dir, 'kernel', 'node_modules', '@deepseek-ai', 'dsh')
  const nested = path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-tools')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'package.json'), '{"name":"@deepseek-ai/dsh-tools"}\n')
  fs.writeFileSync(path.join(kernelRoot, 'package.json'), '{"name":"@deepseek-ai/dsh"}\n')
  const root = path.join(dir, 'root')
  const pluginsDir = path.join(root, 'plugins')
  for (const p of ['desk-host', 'desk-ui']) fs.mkdirSync(path.join(pluginsDir, p), { recursive: true })
  const patchFile = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(patchFile, "gatewayUrl: 'http://x:1'\n")
  const flat = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  assert.equal(fs.existsSync(flat), false)
  const { flatDir } = ensureProfile({
    profileName: 'desk-fresh',
    dshHome,
    root,
    pluginsDir,
    patchFile,
    kernel: { bin: path.join(kernelRoot, 'lib', 'bin.js'), root: kernelRoot },
    selfHeal: false,
    log: () => {},
  })
  assert.equal(flatDir, flat)
  assert.ok(fs.existsSync(path.join(flat, 'dsh-tools', 'package.json')))
  assert.ok(fs.existsSync(path.join(flat, 'dsh', 'package.json')))
  assert.ok(fs.lstatSync(path.join(root, 'node_modules', '@deepseek-ai')).isSymbolicLink())
})

test('pinSkillsRoot：戳记一致但补丁文件缺失 → 走重打分支，KernelPatchError 包成 PATCH_FAIL <code>', (t) => {
  // 假内核前缀只有戳记（skillsDir 已与目标一致）、没有任何补丁目标文件：
  // missingPatches 报缺 → 不能 skip → applyKernelPatches 抛 KernelPatchError(target-missing) → 包成 "PATCH_FAIL target-missing"
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  const skillsDir = path.join(dir, 'skills')
  fs.writeFileSync(path.join(dir, '.company-desk-kernel.json'), JSON.stringify({ skillsDir }))
  const logs = []
  assert.throws(() => pinSkillsRoot({ kernelPrefix: dir, kernel: { root: kernelRoot, bin: 'x', version: '0' }, skillsDir, log: (o) => logs.push(o) }), /PATCH_FAIL target-missing/)
  assert.deepEqual(logs.map((e) => [e.step, e.status]), [['kernel', 'start']], '进了重打分支才抛')
})

test('pinSkillsRoot：补丁齐但戳记里是构建机的技能根 → 预设改成本机路径并重写戳记；再跑一次跳过', (t) => {
  // 假内核：每个补丁文件只放 mark（代码补丁见 mark 即跳过），预设放 v2 骨架（只会同步技能根那两行）
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const kernelRoot = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const buildSkills = 'C:/Users/builder/.dsh/desk/drive/_shared/skills'
  const preset = (withSkills) =>
    [
      ...(withSkills
        ? [
            '- id: skill-filesystem',
            "  name: '@deepseek-ai/dsh-skill-filesystem'",
            '  config:',
            '    includeDefaultRoots: false',
            '    watch: false',
            `    bundledSkillDir: '${buildSkills}'   # company-desk skills root`,
            '    customSkillDirs:',
            `      - '${buildSkills}'   # company-desk skills root`,
            '# --- company-preset-skills-v1 ---',
            '# --- company-preset-skills-v2 ---',
          ]
        : []),
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      '  config:',
      '    fetch: true',
      '    searchTimeoutMs: 60000',
      '    fetchTimeoutMs: 90000',
      '# --- company-preset-web-fetch-v1 ---',
      '# --- company-preset-web-fetch-v2 ---',
      '# --- company-preset-instr-root-v1 ---',
      '',
    ].join('\n')
  for (const { file, marks } of ALL_MARKS) {
    const f = path.join(kernelRoot, file)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (file.endsWith('.yml')) fs.writeFileSync(f, preset(file.includes('standard')))
    else fs.appendFileSync(f, `// ${marks[0]}\n`)
  }
  const stampFile = path.join(dir, '.company-desk-kernel.json')
  fs.writeFileSync(stampFile, JSON.stringify({ skillsDir: buildSkills.replace(/\//g, '\\') }))
  const skillsDir = path.join(dir, 'dsh', 'desk', 'drive', '_shared', 'skills')
  const kernel = { root: kernelRoot, bin: path.join(kernelRoot, 'lib', 'bin.js'), version: '0.1.1-rc.2' }
  const events = []
  assert.equal(pinSkillsRoot({ kernelPrefix: dir, kernel, skillsDir, log: (o) => events.push(o) }), true)
  assert.deepEqual(events.map((e) => [e.step, e.status]), [['kernel', 'start'], ['kernel', 'ok']])
  const yaml = fs.readFileSync(path.join(kernelRoot, 'config', 'agent-presets', 'standard', 'agent.cordis.yml'), 'utf8')
  assert.ok(!yaml.includes(buildSkills), '构建机路径已被替换')
  assert.equal(yaml.split(`'${skillsDir.replace(/\\/g, '/')}'`).length - 1, 2, 'bundledSkillDir 与 customSkillDirs 都指向本机路径')
  const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'))
  assert.equal(stamp.skillsDir, skillsDir)
  assert.equal(stamp.version, '0.1.1-rc.2')
  assert.equal(stamp.kernelRoot, kernelRoot)
  assert.equal(stamp.marks.length, ALL_MARKS.length)
  // 第二次：戳记一致、补丁齐 → 不动
  const again = []
  assert.equal(pinSkillsRoot({ kernelPrefix: dir, kernel, skillsDir, log: (o) => again.push(o) }), false)
  assert.deepEqual(again.map((e) => [e.step, e.status]), [['kernel', 'skip']])
  assert.equal(fs.readFileSync(path.join(kernelRoot, 'config', 'agent-presets', 'standard', 'agent.cordis.yml'), 'utf8'), yaml)
})

test('needsExtract：无 state.json → 首次；buildId 不同 → 版本更新；有 package.json 没 bin → 目录不完整；齐了 → 不解压', (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const appDir = path.join(dir, 'app')
  const kernelPrefix = path.join(appDir, 'kernel')
  const stateFile = path.join(appDir, 'state.json')
  const kernelRoot = path.join(kernelPrefix, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(kernelRoot, { recursive: true })
  const decide = () => needsExtract({ stateFile, kernelPrefix, buildId: 'b2' })
  let r = decide()
  assert.equal(r.fresh, true)
  assert.match(r.reason, /首次/)
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify({ buildId: 'b1' }))
  r = decide()
  assert.equal(r.fresh, true)
  assert.match(r.reason, /版本更新（b1 → b2）/)
  // buildId 对上了，但内核只剩 package.json（解压中断 / 被误删）：locateKernel 认得，bin 却不在 → 必须重新解压
  fs.writeFileSync(stateFile, JSON.stringify({ buildId: 'b2' }))
  fs.writeFileSync(path.join(kernelRoot, 'package.json'), JSON.stringify({ version: '0' }))
  r = decide()
  assert.equal(r.fresh, true)
  assert.match(r.reason, /内核目录不完整/)
  fs.mkdirSync(path.join(kernelRoot, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(kernelRoot, 'lib', 'bin.js'), '')
  r = decide()
  assert.equal(r.fresh, true)
  assert.match(r.reason, /缺少必需插件/)
  for (const name of ['dsh-better-sidebar', '@anweat/dsh-browser']) {
    const plugin = path.join(kernelPrefix, 'node_modules', name)
    fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(plugin, 'package.json'), '{}')
    fs.writeFileSync(path.join(plugin, 'lib', 'index.js'), '')
    fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), '')
  }
  r = decide()
  assert.equal(r.fresh, false)
  assert.match(r.reason, /内核已就位（b2）/)
})

test('preparePackaged：appDir 里有 package.json / .git（项目目录，如 --app-dir .）→ 抛错提示 --app-dir，node_modules / scripts 一个都不删', (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // payload 完整可用（有 payload.json），确保抛错的是目录守卫而不是别的
  const payloadDir = path.join(dir, 'payload')
  fs.mkdirSync(payloadDir)
  fs.writeFileSync(path.join(payloadDir, 'payload.json'), JSON.stringify({ buildId: 'b1', kernel: { version: '0' } }))
  const proj = path.join(dir, 'proj')
  fs.mkdirSync(path.join(proj, 'node_modules', 'left-pad'), { recursive: true })
  fs.mkdirSync(path.join(proj, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'package.json'), '{}')
  fs.writeFileSync(path.join(proj, 'node_modules', 'left-pad', 'index.js'), '')
  fs.writeFileSync(path.join(proj, 'scripts', 'x.mjs'), '')
  // 误配目录里若已有 pending，守卫仍须先于 apply（apply 遇 hash 不对会打 log 并清 pending）
  const next = path.join(proj, 'kernel-next')
  fs.mkdirSync(next, { recursive: true })
  fs.writeFileSync(path.join(next, 'kernel.tar'), 'x')
  fs.writeFileSync(path.join(next, 'pending.json'), JSON.stringify({ version: '9.0.0', sha256: '0'.repeat(64) }))
  const events = []
  assert.throws(() => preparePackaged({ payloadDir, appDir: proj, dshHome: path.join(dir, 'dsh'), log: (o) => events.push(o) }), /--app-dir .*package\.json/)
  assert.deepEqual(events, [], '守卫在任何步骤之前')
  assert.ok(fs.existsSync(path.join(next, 'pending.json')), '守卫失败时不清理 pending')
  assert.ok(fs.existsSync(path.join(proj, 'node_modules', 'left-pad', 'index.js')), 'node_modules 完好')
  assert.ok(fs.existsSync(path.join(proj, 'scripts', 'x.mjs')), 'scripts 完好')
  assert.ok(!fs.existsSync(path.join(proj, 'state.json')) && !fs.existsSync(path.join(proj, 'kernel')), '没有开始解压')
  // .git 同理；专用目录（不存在 / 只有本模块的条目）放行
  const repoLike = path.join(dir, 'repo')
  fs.mkdirSync(path.join(repoLike, '.git'), { recursive: true })
  assert.throws(() => assertSafeAppDir(repoLike), /--app-dir .*\.git/)
  assert.doesNotThrow(() => assertSafeAppDir(path.join(dir, 'app')))
  fs.mkdirSync(path.join(dir, 'app', 'kernel'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'app', 'state.json'), '{}')
  assert.doesNotThrow(() => assertSafeAppDir(path.join(dir, 'app')))
})

test('CLI：缺参数 → 退出码 64；payload 目录不存在 → 退出码 1 且 stdout 最后一行是 error 事件', (t) => {
  const cli = path.join(repo, 'scripts', 'lib', 'bootstrap.mjs')
  const run = (argv) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [cli, ...argv], { encoding: 'utf8', stdio: 'pipe' }) }
    } catch (err) {
      return err
    }
  }
  assert.equal(run([]).status, 64)
  assert.equal(run(['--packaged']).status, 64)
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bad = run(['--packaged', '--payload', path.join(dir, 'nope'), '--app-dir', path.join(dir, 'app'), '--dsh-home', path.join(dir, 'dsh')])
  assert.equal(bad.status, 1)
  const events = bad.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l))
  assert.deepEqual([events.at(-1).step, events.at(-1).status], ['error', 'fail'])
  assert.match(events.at(-1).detail, /payload\.json/)
  assert.ok(!fs.existsSync(path.join(dir, 'app')), '读不到 payload.json 就不该动 app 目录')
})

test('preparePackaged：解压 kernel.tar、复制 plugins/profile/scripts、写 state.json；第二次跳过；改 buildId 走升级路径且不碰 appDir 里的无关文件', { skip: !fs.existsSync(path.join(repo, 'build', 'payload', 'kernel.tar')) && '需要先 node scripts/build-payload.mjs' }, (t) => {
  const dir = tmp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const appDir = path.join(dir, 'app')
  const dshHome = path.join(dir, 'dsh')
  // appDir 里事先放一个无关文件：--app-dir 被误配到有用目录时，重新解压只能删自己创建的条目
  const sentinel = path.join(appDir, 'keep-me.txt')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(sentinel, 'keep')
  const events = []
  const res = preparePackaged({ payloadDir: path.join(repo, 'build', 'payload'), appDir, dshHome, log: (o) => events.push(o) })
  assert.ok(fs.existsSync(sentinel), '首次解压不能删 appDir 里的无关文件')
  assert.equal(res.profileName, 'desk-app')
  assert.ok(fs.existsSync(res.kernelBin), 'kernelBin 存在')
  assert.ok(res.kernelBin.startsWith(path.join(appDir, 'kernel')))
  const state = JSON.parse(fs.readFileSync(path.join(appDir, 'state.json'), 'utf8'))
  assert.equal(state.buildId, res.buildId)
  const stamp = JSON.parse(fs.readFileSync(path.join(appDir, 'kernel', '.company-desk-kernel.json'), 'utf8'))
  assert.equal(stamp.skillsDir, path.join(dshHome, 'desk', 'drive', '_shared', 'skills'))
  // 构建机的技能根必须真的被换掉（missingPatches 只看 mark，看不出路径不对）
  const yaml = fs.readFileSync(path.join(res.kernelRoot, resolvePresetRel(res.kernelRoot, 'standard')), 'utf8')
  assert.equal(yaml.split(`'${stamp.skillsDir.replace(/\\/g, '/')}'`).length - 1, 2, '预设里两处技能根都指向本机 dshHome')
  assert.ok(events.some((e) => e.step === 'kernel' && e.status === 'ok'), '技能根被重新同步')
  assert.ok(fs.existsSync(path.join(dshHome, 'profiles', 'desk-app', 'cordis.patch.yml')))
  assert.ok(fs.lstatSync(path.join(appDir, 'node_modules', '@deepseek-ai')).isSymbolicLink())
  assert.ok(events.some((e) => e.step === 'extract' && e.status === 'ok'))
  // 第二次：全部 skip
  const again = []
  preparePackaged({ payloadDir: path.join(repo, 'build', 'payload'), appDir, dshHome, log: (o) => again.push(o) })
  assert.ok(again.every((e) => e.status === 'skip'), JSON.stringify(again))
  // 第三次：state.json 的 buildId 过期 → 升级路径重新解压；无关文件与 junction 目标（dsh 回退目录）都要活着
  fs.writeFileSync(path.join(appDir, 'state.json'), JSON.stringify({ buildId: 'old-build' }))
  const flat = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  const flatCount = fs.readdirSync(flat).length
  assert.ok(flatCount > 0, 'dsh 回退目录非空')
  const upgrade = []
  const res3 = preparePackaged({ payloadDir: path.join(repo, 'build', 'payload'), appDir, dshHome, log: (o) => upgrade.push(o) })
  assert.match(upgrade.find((e) => e.step === 'extract' && e.status === 'start')?.detail ?? '', /版本更新/)
  assert.ok(fs.existsSync(sentinel), '升级重解压不能删 appDir 里的无关文件')
  assert.equal(fs.readdirSync(flat).length, flatCount, 'node_modules/@deepseek-ai 是 junction，删链接不能删目标')
  assert.equal(res3.buildId, JSON.parse(fs.readFileSync(path.join(repo, 'build', 'payload', 'payload.json'), 'utf8')).buildId)
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, 'state.json'), 'utf8')).buildId, res3.buildId)
})
