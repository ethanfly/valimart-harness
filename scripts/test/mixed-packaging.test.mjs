/**
 * T11 装配门禁：新 Mixed 模块进入 payload digest / 客户端源 / 闭包脚本，
 * 且未引入第二份 node_modules 或未消费的 integrity 字段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const MIXED_HOST = [
  'contracts.js', 'model-routes.js', 'store.js', 'service.js', 'scheduler.js',
  'dsh-driver.js', 'session-bridge.js', 'evidence.js', 'prompts.js', 'review.js',
  'host-api.js', 'host.js', 'owner.js', 'schemas.js', 'attribution-reporter.js',
]
const MIXED_UI = ['mixed-settings.jsx', 'mixed-mode.jsx', 'mixed-run-panel.jsx', 'mixed-store.js']

test('T11：宿主 mixed 模块齐全（计划 §9，recovery/api 已并入 host/service/host-api）', () => {
  const dir = path.join(root, 'plugins/desk-host/lib/mixed')
  for (const f of MIXED_HOST) {
    assert.ok(fs.existsSync(path.join(dir, f)), `缺少 ${f}`)
  }
  assert.equal(fs.existsSync(path.join(dir, 'recovery.js')), false, 'recovery 未拆独立文件（逻辑在 host/service）')
})

test('T11：客户端 Mixed 设置/开关/面板/store 源文件存在', () => {
  const dir = path.join(root, 'plugins/desk-ui/src/client')
  for (const f of MIXED_UI) {
    assert.ok(fs.existsSync(path.join(dir, f)), `缺少 ${f}`)
  }
})

test('T11：build-payload 把 mixed 全部 .js 纳入 digest，缺目录即失败', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/build-payload.mjs'), 'utf8')
  assert.match(src, /lib\/mixed/)
  assert.match(src, /缺少 plugins\/desk-host\/lib\/mixed/)
  assert.match(src, /mixedFiles/)
})

test('T11：bootstrap 链接内核 hoisted zod（单实例，插件不自带 node_modules）', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/lib/bootstrap.mjs'), 'utf8')
  assert.match(src, /locateZod/)
  assert.match(src, /kernel\.root.*node_modules.*zod|node_modules', 'zod'/)
  assert.match(src, /缺少 zod/)
  const pluginNm = path.join(root, 'plugins/desk-host/node_modules')
  assert.equal(fs.existsSync(pluginNm), false, 'desk-host 不得自带 node_modules（破坏单实例）')
})

test('T11：闭包检查脚本覆盖宿主 + 浏览器 bundle，不只查 main', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/check-payload-closure.mjs'), 'utf8')
  assert.match(src, /宿主（Node）依赖闭包/)
  assert.match(src, /浏览器闭包/)
  assert.match(src, /单实例/)
  assert.ok(fs.existsSync(path.join(root, 'scripts/verify-installer-nsis.mjs')), 'NSIS 真机验证脚本存在')
})

test('T11：pin.json 未新增未消费的 integrity 字段（T01 未选第三方 fork）', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts/kernel/pin.json'), 'utf8'))
  assert.equal(pin.integrity, undefined)
  for (const p of pin.profilePlugins ?? []) {
    assert.equal(p.integrity, undefined, `${p.name} 不应有未消费 integrity`)
  }
})
