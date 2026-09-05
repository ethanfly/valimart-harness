import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pluginsFromCordisPatch, toPluginInventorySnapshot, workspacePluginCatalog } from '../src/dsh-plugins.js'

const patch = fs.readFileSync(new URL('../../profile/cordis.patch.yml', import.meta.url), 'utf8')

test('cordis.patch 解析出公司插件与禁用的官方外壳', () => {
  const entries = pluginsFromCordisPatch(patch)
  assert.ok(entries.some((e) => e.id === 'desk-host' && e.name.includes('desk-host')))
  assert.ok(entries.some((e) => e.id === 'desk-ui'))
  assert.ok(entries.some((e) => e.id === 'ui-layout' && e.disabled))
  assert.ok(!entries.some((e) => e.id === 'ui-settings-plugin-inventory' && e.disabled), '官方插件列表应保持可用')
})

test('快照格式与 DSH pluginInventory.list 同形', () => {
  const snap = toPluginInventorySnapshot([{ id: 'desk-host', name: '@company-desk/desk-host' }])
  assert.deepEqual(snap.entries[0], {
    entryId: 'desk-host',
    moduleName: '@company-desk/desk-host',
    enabled: true,
    fiberPhase: 'active',
  })
  const cat = workspacePluginCatalog(patch)
  assert.ok(cat.entries.some((e) => e.entryId === 'plugin-inventory'))
  assert.ok(cat.entries.some((e) => e.entryId === 'desk-ui'))
})

test('fileURL 路径存在（避免测试读错仓库）', () => {
  assert.ok(fs.existsSync(fileURLToPath(new URL('../../profile/cordis.patch.yml', import.meta.url))))
})
