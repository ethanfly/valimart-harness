/**
 * 把工作区当前 git 分支画到官方项目行标题左侧。
 * 不依赖内核 hashed class：用 treeitem + 标题文本对齐。
 */

export function applyGitBranchBadges(root, items) {
  if (!root) return
  const wanted = (items ?? []).filter((i) => i?.title)
  const titles = new Set(wanted.map((i) => i.title))
  const rows = root.querySelectorAll('[role="treeitem"][aria-expanded]')
  for (const row of rows) {
    const titleEl = [...row.querySelectorAll('span')].find((el) => titles.has(el.textContent.trim()))
    if (!titleEl) continue
    const parent = titleEl.parentElement
    if (!parent) continue
    const item = wanted.find((i) => i.title === titleEl.textContent.trim())
    const branch = item?.branch || ''
    let badge = parent.querySelector(':scope > .dk-git-branch')
    if (!branch) {
      badge?.remove()
      continue
    }
    if (!badge) {
      const doc = root.ownerDocument
      badge = doc.createElement('span')
      badge.className = 'dk-git-branch'
      parent.insertBefore(badge, titleEl)
    }
    if (badge.textContent !== branch) badge.textContent = branch
    badge.title = `当前分支 ${branch}`
  }
}
