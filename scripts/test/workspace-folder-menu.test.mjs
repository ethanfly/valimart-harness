/**
 * 工作区「…」菜单：识别官方菜单并插入「打开工作区文件夹」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isWorkspaceActionsButton,
  findWorkspaceActionMenu,
  injectOpenFolderItem,
} from '../../plugins/desk-ui/src/client/workspace-folder-menu.js'
import { applyGitBranchBadges } from '../../plugins/desk-ui/src/client/workspace-git.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function el(tag, attrs = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(),
    className: attrs.className ?? '',
    textContent: attrs.textContent ?? '',
    title: attrs.title ?? '',
    attrs: { ...attrs },
    dataset: {},
    children: [],
    parentElement: null,
    ownerDocument: null,
    listeners: {},
    nodeType: 1,
    get firstChild() {
      return this.children[0] ?? null
    },
    getAttribute(name) {
      if (name === 'role') return this.attrs.role
      if (name === 'aria-expanded') return this.attrs.ariaExpanded
      if (name === 'aria-label') return this.attrs.ariaLabel
      return this.attrs[name]
    },
    setAttribute(name, value) {
      if (name === 'role') this.attrs.role = value
      else this.attrs[name] = value
    },
    querySelectorAll(sel) {
      if (sel === 'span') return collect(this, (n) => n.tagName === 'SPAN')
      if (sel === '[role="treeitem"][aria-expanded]') {
        return collect(this, (n) => n.getAttribute('role') === 'treeitem' && n.getAttribute('aria-expanded') != null)
      }
      if (sel === '[role="menu"]') return collect(this, (n) => n.getAttribute('role') === 'menu')
      if (sel === '[role="menuitem"]') return collect(this, (n) => n.getAttribute('role') === 'menuitem')
      if (sel === '[data-dk-open-folder]') return collect(this, (n) => n.dataset.dkOpenFolder)
      if (sel === 'svg') return collect(this, (n) => n.tagName === 'SVG')
      return []
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    },
    cloneNode() {
      const copy = el(this.tagName.toLowerCase(), { ...this.attrs, className: this.className, textContent: '' }, this.children.map((c) => c.cloneNode(true)))
      copy.ownerDocument = this.ownerDocument
      const label = this.querySelector('span')
      if (label) copy.querySelector('span').textContent = label.textContent
      return copy
    },
    insertBefore(child, ref) {
      child.parentElement = this
      const i = this.children.indexOf(ref)
      this.children.splice(i < 0 ? this.children.length : i, 0, child)
    },
    append(child) {
      if (typeof child === 'string') {
        this.textContent += child
        return
      }
      child.parentElement = this
      this.children.push(child)
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn
    },
    click() {
      this.listeners.click?.({ preventDefault() {}, stopPropagation() {} })
    },
    remove() {
      const p = this.parentElement
      if (!p) return
      const i = p.children.indexOf(this)
      if (i >= 0) p.children.splice(i, 1)
    },
  }
  for (const c of children) {
    c.parentElement = node
    node.children.push(c)
  }
  return node
}

function collect(root, pred, out = []) {
  if (pred(root)) out.push(root)
  for (const c of root.children) collect(c, pred, out)
  return out
}

function makeDoc() {
  const titleEl = el('span', { className: 'title', textContent: 'company-harness' })
  const row = el('div', { role: 'treeitem', ariaExpanded: 'true' }, [
    el('span', { className: 'projectText' }, [titleEl]),
    el('button', { ariaLabel: '工作区“company-harness”的操作' }),
  ])
  const root = el('div', {}, [row])
  const doc = {
    createElement: (tag) => el(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  }
  const walk = (n) => {
    n.ownerDocument = doc
    for (const c of n.children) walk(c)
  }
  walk(root)
  return { root, row, doc }
}

test('isWorkspaceActionsButton：中英 aria-label', () => {
  assert.equal(isWorkspaceActionsButton({ getAttribute: () => '工作区“x”的操作' }), true)
  assert.equal(isWorkspaceActionsButton({ getAttribute: () => 'Workspace “foo” actions' }), true)
  assert.equal(isWorkspaceActionsButton({ getAttribute: () => '在“foo”中新建会话' }), false)
})

test('findWorkspaceActionMenu：只要同时有重命名和删除工作区', () => {
  const session = el('div', { role: 'menu', textContent: '分叉会话归档会话' })
  const workspace = el('div', { role: 'menu', textContent: '重命名删除工作区' })
  const doc = { querySelectorAll: () => [session, workspace] }
  assert.equal(findWorkspaceActionMenu(doc), workspace)
  assert.equal(findWorkspaceActionMenu({ querySelectorAll: () => [session] }), null)
})

test('injectOpenFolderItem：插到第一项，点击打开路径，重复插入幂等', () => {
  const rename = el('button', { role: 'menuitem' }, [el('svg'), el('span', { textContent: '重命名' })])
  const del = el('button', { role: 'menuitem' }, [el('span', { textContent: '删除工作区' })])
  const menu = el('div', { role: 'menu', textContent: '重命名删除工作区' }, [rename, del])
  const doc = { createElement: (tag) => el(tag), createTextNode: (t) => ({ nodeType: 3, textContent: t }) }
  menu.ownerDocument = doc
  const opened = []
  const first = injectOpenFolderItem(menu, { folder: 'E:/repo', openPath: (p) => opened.push(p) })
  assert.equal(menu.firstChild, first)
  assert.equal(first.dataset.dkOpenFolder, '1')
  assert.match(first.querySelector('span').textContent, /打开工作区文件夹/)
  first.click()
  assert.deepEqual(opened, ['E:/repo'])
  assert.equal(injectOpenFolderItem(menu, { folder: 'E:/repo', openPath: () => {} }), first)
  assert.equal(menu.querySelectorAll('[data-dk-open-folder]').length, 1)
})

test('applyGitBranchBadges：把工作区路径打到 treeitem 上', () => {
  const { root, row } = makeDoc()
  applyGitBranchBadges(root, [{ title: 'company-harness', path: 'E:/orca/company-harness', branch: null }])
  assert.equal(row.dataset.dkWorkspacePath, 'E:/orca/company-harness')
})

test('顶栏 utilities 隐藏，侧栏绑定打开文件夹菜单', () => {
  const css = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/styles.css'), 'utf8')
  assert.match(css, /\[data-slot='conversation\.session\.header\.utilities'\]/)
  assert.match(css, /display:\s*none\s*!important/)
  const sidebar = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/sidebar.jsx'), 'utf8')
  assert.match(sidebar, /bindWorkspaceFolderMenu/)
  assert.match(sidebar, /打开工作区文件夹|openPath/)
  const index = fs.readFileSync(path.join(repo, 'plugins/desk-ui/src/client/index.jsx'), 'utf8')
  assert.doesNotMatch(index, /session log tooltip/)
})
