/**
 * 侧栏项目行：把当前 git 分支插到项目名左侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyGitBranchBadges } from '../../plugins/desk-ui/src/client/workspace-git.js'

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
    getAttribute(name) {
      if (name === 'role') return this.attrs.role
      if (name === 'aria-expanded') return this.attrs.ariaExpanded
      return this.attrs[name]
    },
    querySelectorAll(sel) {
      if (sel === 'span') return collect(this, (n) => n.tagName === 'SPAN')
      if (sel === '[role="treeitem"][aria-expanded]') {
        return collect(this, (n) => n.getAttribute('role') === 'treeitem' && n.getAttribute('aria-expanded') != null)
      }
      return []
    },
    querySelector(sel) {
      if (sel === ':scope > .dk-git-branch') return this.children.find((c) => c.className === 'dk-git-branch') ?? null
      return this.querySelectorAll(sel)[0] ?? null
    },
    insertBefore(child, ref) {
      child.parentElement = this
      const i = this.children.indexOf(ref)
      this.children.splice(i < 0 ? this.children.length : i, 0, child)
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

function makeSidebar(title) {
  const titleEl = el('span', { className: 'title', textContent: title })
  const projectText = el('span', { className: 'projectText' }, [titleEl])
  const row = el('div', { role: 'treeitem', ariaExpanded: 'true' }, [
    el('span', { className: 'folder' }),
    projectText,
  ])
  const root = el('div', {}, [row])
  root.ownerDocument = {
    createElement: (tag) => el(tag),
  }
  const walk = (n) => {
    n.ownerDocument = root.ownerDocument
    for (const c of n.children) walk(c)
  }
  walk(root)
  return { root, projectText, titleEl }
}

test('applyGitBranchBadges：分支插在项目名左侧', () => {
  const { root, projectText, titleEl } = makeSidebar('company-harness')
  applyGitBranchBadges(root, [{ title: 'company-harness', branch: 'feat/lan' }])
  assert.equal(projectText.children[0].className, 'dk-git-branch')
  assert.equal(projectText.children[0].textContent, 'feat/lan')
  assert.equal(projectText.children[1], titleEl)
  assert.equal(projectText.children[0].title, '当前分支 feat/lan')
})

test('applyGitBranchBadges：没有 git 仓库不插徽标', () => {
  const { root, projectText } = makeSidebar('个人')
  applyGitBranchBadges(root, [{ title: '个人', branch: null }])
  assert.equal(projectText.children.length, 1)
  assert.equal(projectText.children[0].className, 'title')
})

test('applyGitBranchBadges：幂等，已有徽标只更新文案', () => {
  const { root, projectText } = makeSidebar('company-harness')
  applyGitBranchBadges(root, [{ title: 'company-harness', branch: 'main' }])
  const badge = projectText.children[0]
  applyGitBranchBadges(root, [{ title: 'company-harness', branch: 'dev' }])
  assert.equal(projectText.children[0], badge)
  assert.equal(badge.textContent, 'dev')
})
