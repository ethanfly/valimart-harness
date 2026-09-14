/**
 * 官方右侧栏 ExpandButton → setExpanded(true) 后，
 * ui-sidebar-right 若 shown && !canShow 会立刻收回。
 * canShow 必须表示「列放得下」，不能绑 rightbarShown。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/desk-ui/src/client/layout.jsx'),
  'utf8',
)

test('rightbar canShow 只看视口是否放得下，不看 rightbarShown', () => {
  assert.match(src, /canShow: !taskMode && rightbarPref > 0 && viewport - sidebarWidth >= 300/)
  assert.equal(/canShow:[^\n]*rightbarShown/.test(src), false)
})
