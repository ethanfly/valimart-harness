/**
 * Mixed P0 探测环境：临时 DSH_HOME + 最小探测 profile。
 *
 * 绝不触碰现有 ~/.dsh（生产数据 / dev profile / 运行中内核）：
 *   <tmp>/home/profiles/mixed-probe/        探测 profile（dsh-base + dsh-web-app + 探测宿主插件）
 *   <tmp>/home/profiles/node_modules/@deepseek-ai/*  从内核前缀物化的 junction（扁平回退）
 *   <tmp>/work/                             各场景工作区
 *   <tmp>/provider.json                     模型路由配置（驱动进程可随时改写并通知宿主重载）
 *
 * 布局与 scripts/lib/bootstrap.mjs 的 ensureProfile 一致（junction 方式，不用 pnpm）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { locateKernel, defaultPrefix } from '../../kernel/locate.mjs'
import { linkJunction } from '../bootstrap.mjs'

export function setupProbeProfile({ root, tmpDir, kernelPrefix = defaultPrefix() } = {}) {
  const kernel = locateKernel(kernelPrefix)
  if (!kernel) throw new Error(`内核未安装：${kernelPrefix}（先跑 node scripts/setup-profile.mjs）`)
  const kernelModules = path.resolve(kernel.root, '..', '..') // <prefix>/node_modules

  const home = path.join(tmpDir, 'home')
  const profileName = 'mixed-probe'
  const profileDir = path.join(home, 'profiles', profileName)
  const probeHostDir = path.join(root, 'scripts', 'lib', 'mixed-probe', 'probe-host')

  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'work'), { recursive: true })

  // 1) 扁平回退：profile 内 @deepseek-ai/* 包 → 内核前缀（与 ensureFlatFallback 同一套）
  const flatDir = path.join(home, 'profiles', 'node_modules', '@deepseek-ai')
  fs.rmSync(flatDir, { recursive: true, force: true })
  fs.mkdirSync(flatDir, { recursive: true })
  const nested = path.join(kernel.root, 'node_modules', '@deepseek-ai')
  for (const name of fs.readdirSync(nested)) {
    linkJunction(path.join(flatDir, name), path.join(nested, name))
  }
  linkJunction(path.join(flatDir, 'dsh'), kernel.root)

  // 2) 探测宿主插件 junction
  const nmDir = path.join(profileDir, 'node_modules', '@company-desk')
  fs.mkdirSync(nmDir, { recursive: true })
  linkJunction(path.join(nmDir, 'mixed-probe-host'), probeHostDir)

  // 3) profile 三件套
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: `dsh-profile-${profileName}`,
        private: true,
        description: 'Mixed P0 contract probe (ephemeral)',
        dependencies: { '@company-desk/mixed-probe-host': `file:${probeHostDir.split(path.sep).join('/')}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      },
      null,
      2,
    ) + '\n',
  )
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n')
  fs.writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    [
      '# Mixed P0 探测 profile 补丁：只留跑契约所需的东西',
      '- id: permission',
      '  config:',
      '    defaultPreset: danger-full-access',
      '    presets:',
      '      danger-full-access:',
      '        sandbox: danger-full-access',
      '        approval: never',
      '# 关掉会话自动标题：它会多打模型请求，污染探测日志',
      '- id: session-title-llm',
      '  disabled: true',
      '',
      '- insert:',
      '  - id: mixed-probe-host',
      '    name: \'@company-desk/mixed-probe-host\'',
      '    config:',
      `      providerFile: '${path.join(tmpDir, 'provider.json').split(path.sep).join('/')}'`,
      '',
    ].join('\n'),
  )

  // 4) 默认 provider 配置（驱动进程会覆写）
  const providerFile = path.join(tmpDir, 'provider.json')
  fs.writeFileSync(
    providerFile,
    JSON.stringify({
      providers: {
        mock: {
          displayName: 'Mock Probe',
          apiKeyEnv: 'MIXED_PROBE_KEY',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:0/v1',
          models: [],
        },
      },
      defaultModel: null,
    }),
    null,
    2,
  )

  return {
    kernelBin: kernel.bin,
    kernelVersion: kernel.version,
    kernelModules,
    home,
    profileName,
    profileDir,
    providerFile,
    workDir: path.join(tmpDir, 'work'),
  }
}
