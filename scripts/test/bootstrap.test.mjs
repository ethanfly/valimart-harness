import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureProfile, findFreePort, pinSkillsRoot, preparePackaged, profileNeedsSetup, readGatewayUrl } from '../lib/bootstrap.mjs'
import { ALL_MARKS } from '../kernel/patches.mjs'

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

test('pinSkillsRoot：补丁齐但戳记里是构建机的技能根 → 预设改成本机路径并重写戳记；再跑一次跳过', () => {
  // 假内核：每个补丁文件只放 mark（代码补丁见 mark 即跳过），预设放 v2 骨架（只会同步技能根那两行）
  const dir = tmp()
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
  fs.rmSync(dir, { recursive: true, force: true })
})

test('CLI：缺参数 → 退出码 64；payload 目录不存在 → 退出码 1 且 stdout 最后一行是 error 事件', () => {
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
  const bad = run(['--packaged', '--payload', path.join(dir, 'nope'), '--app-dir', path.join(dir, 'app'), '--dsh-home', path.join(dir, 'dsh')])
  assert.equal(bad.status, 1)
  const events = bad.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l))
  assert.deepEqual([events.at(-1).step, events.at(-1).status], ['error', 'fail'])
  assert.match(events.at(-1).detail, /payload\.json/)
  assert.ok(!fs.existsSync(path.join(dir, 'app')), '读不到 payload.json 就不该动 app 目录')
  fs.rmSync(dir, { recursive: true, force: true })
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
  // 构建机的技能根必须真的被换掉（missingPatches 只看 mark，看不出路径不对）
  const yaml = fs.readFileSync(path.join(res.kernelRoot, 'config', 'agent-presets', 'standard', 'agent.cordis.yml'), 'utf8')
  assert.equal(yaml.split(`'${stamp.skillsDir.replace(/\\/g, '/')}'`).length - 1, 2, '预设里两处技能根都指向本机 dshHome')
  assert.ok(events.some((e) => e.step === 'kernel' && e.status === 'ok'), '技能根被重新同步')
  assert.ok(fs.existsSync(path.join(dshHome, 'profiles', 'desk-app', 'cordis.patch.yml')))
  assert.ok(fs.lstatSync(path.join(appDir, 'node_modules', '@deepseek-ai')).isSymbolicLink())
  assert.ok(events.some((e) => e.step === 'extract' && e.status === 'ok'))
  // 第二次：全部 skip
  const again = []
  preparePackaged({ payloadDir: path.join(repo, 'build', 'payload'), appDir, dshHome, log: (o) => again.push(o) })
  assert.ok(again.every((e) => e.status === 'skip'), JSON.stringify(again))
  fs.rmSync(dir, { recursive: true, force: true })
})
