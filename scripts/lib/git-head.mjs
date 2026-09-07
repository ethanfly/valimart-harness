/**
 * 读工作区当前 git 分支：只看 .git/HEAD（含 gitfile worktree），不 spawn git。
 */
import fs from 'node:fs'
import path from 'node:path'

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function resolveGitDir(workspacePath) {
  if (!workspacePath) return null
  const marker = path.join(workspacePath, '.git')
  try {
    const st = fs.statSync(marker)
    if (st.isDirectory()) return marker
    if (st.isFile()) {
      const text = readText(marker) ?? ''
      const m = /^\s*gitdir:\s*(.+)\s*$/m.exec(text)
      if (!m) return null
      const dir = m[1].trim()
      return path.isAbsolute(dir) ? dir : path.resolve(workspacePath, dir)
    }
  } catch {
    return null
  }
  return null
}

export function readGitBranch(workspacePath) {
  const gitDir = resolveGitDir(workspacePath)
  if (!gitDir) return null
  const head = readText(path.join(gitDir, 'HEAD'))
  if (!head) return null
  const ref = /^\s*ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head)
  if (ref) return ref[1]
  const sha = head.trim()
  if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 7).toLowerCase()
  return null
}

export function gitBranchesForWorkspaces(workspaces) {
  return (workspaces ?? []).map((w) => ({
    workspaceId: w.id ?? w.workspaceId ?? null,
    title: w.title ?? '',
    path: w.path ?? '',
    branch: readGitBranch(w.path),
  }))
}
