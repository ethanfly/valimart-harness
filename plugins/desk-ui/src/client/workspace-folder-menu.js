/**
 * 官方工作区「…」菜单只有重命名 / 删除。打开后插入「打开工作区文件夹」，
 * 路径来自行上的 data-dk-workspace-path（workspace-git 刷新时打上）。
 */

export function isWorkspaceActionsButton(el) {
  const label = el?.getAttribute?.('aria-label') ?? ''
  return /的操作$/.test(label) || / actions$/i.test(label)
}

export function findWorkspaceActionMenu(doc) {
  if (!doc?.querySelectorAll) return null
  return [...doc.querySelectorAll('[role="menu"]')].find((menu) => {
    const text = menu.textContent ?? ''
    return (/重命名/.test(text) || /\bRename\b/.test(text)) && (/删除工作区/.test(text) || /Delete workspace/.test(text))
  }) ?? null
}

const FOLDER_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 4.5A1.5 1.5 0 0 1 3.25 3h3l1.5 1.5h5A1.5 1.5 0 0 1 14.25 6v5.5a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5z"/></svg>'

export function injectOpenFolderItem(menu, { folder, openPath, label = '打开工作区文件夹' } = {}) {
  if (!menu || !folder) return null
  const existing = menu.querySelector('[data-dk-open-folder]')
  if (existing) return existing
  const doc = menu.ownerDocument
  const proto = menu.querySelector('[role="menuitem"]')
  const item = proto ? proto.cloneNode(true) : doc.createElement('button')
  item.dataset.dkOpenFolder = '1'
  item.setAttribute('role', 'menuitem')
  if (!proto) {
    item.type = 'button'
    item.className = 'dk-ws-open-folder'
  }
  const svg = item.querySelector('svg')
  if (svg && typeof svg.outerHTML === 'string') svg.outerHTML = FOLDER_SVG
  const labelEl = [...item.querySelectorAll('span')].find((el) => el.textContent.trim() && !el.querySelector('svg'))
  const texts = [...(item.childNodes ?? [])].filter((n) => n.nodeType === 3 && String(n.textContent).trim())
  if (labelEl) labelEl.textContent = label
  else if (texts[0]) texts[0].textContent = label
  else item.append(doc.createTextNode(label))
  item.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openPath?.(folder)
  })
  menu.insertBefore(item, menu.firstChild)
  return item
}

export function bindWorkspaceFolderMenu(root, { openPath } = {}) {
  const doc = root.ownerDocument ?? globalThis.document
  let folder = ''
  const sync = () => {
    if (!folder) return
    const menu = findWorkspaceActionMenu(doc)
    if (menu) injectOpenFolderItem(menu, { folder, openPath })
  }
  const onClick = (e) => {
    const btn = e.target?.closest?.('button[aria-label]')
    if (!btn || !root.contains(btn) || !isWorkspaceActionsButton(btn)) return
    const row = btn.closest('[role="treeitem"][aria-expanded]')
    folder = row?.dataset?.dkWorkspacePath || ''
    queueMicrotask(sync)
  }
  const mo = new MutationObserver(sync)
  mo.observe(doc.body ?? root, { childList: true, subtree: true })
  root.addEventListener('click', onClick)
  return () => {
    root.removeEventListener('click', onClick)
    mo.disconnect()
  }
}
