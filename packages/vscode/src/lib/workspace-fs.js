/**
 * Workspace file tools. `workspaceRoot` is injectable so tests write real temp files
 * without the VS Code Extension Host.
 */
import fs from 'node:fs'
import path from 'node:path'
import { assertInside, isCompanyDriveRel } from './drive-paths.js'

export function resolveSafe(workspaceRoot, relPath) {
  if (!workspaceRoot) throw new Error('没有工作区根目录')
  if (relPath == null || String(relPath).length === 0) throw new Error('缺少路径')
  const raw = String(relPath)
  if (raw.includes('\0')) throw new Error('非法路径')
  const root = path.resolve(workspaceRoot)
  const abs = path.resolve(root, raw)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越出工作区: ${raw}`)
  return abs
}

/** 工作区路径，或公司盘镜像相对路径（_shared / _office / projects）。写共享区请走 company_memory_write。 */
export function resolveWorkOrDrive(workspaceRoot, relPath, { driveRoot, username, write = false } = {}) {
  const raw = String(relPath ?? '')
  if (driveRoot && isCompanyDriveRel(raw)) {
    const n = raw.replaceAll('\\', '/').replace(/^\.\//, '')
    if (write) {
      const mine = username ? `_office/${username}/` : ''
      if (!mine || !n.startsWith(mine)) throw new Error('公司盘共享/手册请用 company_memory_write')
    }
    return assertInside(driveRoot, n)
  }
  return resolveSafe(workspaceRoot, relPath)
}

/**
 * 读取要覆盖的内容（不存在就是新建）。工具只把 before/after 交给回调，
 * 不放进返回给模型的结果里，免得把整个文件塞进上下文。
 */
function snapshot(abs) {
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { exists: false, text: '' }
    return { exists: true, text: fs.readFileSync(abs, 'utf8') }
  } catch {
    return { exists: false, text: '' }
  }
}

export function applyWrite(workspaceRoot, relPath, contents, onFileChange, driveOpts) {
  const abs = resolveWorkOrDrive(workspaceRoot, relPath, { ...driveOpts, write: true })
  const text = contents == null ? '' : String(contents)
  const before = snapshot(abs)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
  const change = { path: relPath, abs, before: before.text, after: text, created: !before.exists }
  onFileChange?.(change)
  return { path: relPath, bytes: Buffer.byteLength(text), abs }
}

export function applyPatch(workspaceRoot, relPath, oldText, newText, onFileChange, driveOpts) {
  const abs = resolveWorkOrDrive(workspaceRoot, relPath, { ...driveOpts, write: true })
  const nextNew = newText == null ? '' : String(newText)
  const before = snapshot(abs)
  if (!before.exists) {
    if (oldText) throw new Error(`文件不存在，无法打补丁: ${relPath}`)
    return applyWrite(workspaceRoot, relPath, nextNew, onFileChange, driveOpts)
  }
  const cur = before.text
  const old = oldText == null ? '' : String(oldText)
  if (old.length === 0) {
    fs.writeFileSync(abs, nextNew, 'utf8')
    onFileChange?.({ path: relPath, abs, before: cur, after: nextNew, created: false })
    return { path: relPath, abs, replaced: 0 }
  }
  const idx = cur.indexOf(old)
  if (idx < 0) throw new Error(`补丁未匹配到原文: ${relPath}`)
  const next = cur.slice(0, idx) + nextNew + cur.slice(idx + old.length)
  fs.writeFileSync(abs, next, 'utf8')
  onFileChange?.({ path: relPath, abs, before: cur, after: next, created: false })
  return { path: relPath, abs, replaced: 1 }
}

export function readWorkspaceFile(workspaceRoot, relPath, driveOpts) {
  const abs = resolveWorkOrDrive(workspaceRoot, relPath, driveOpts)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`文件不存在: ${relPath}`)
  return { path: relPath, contents: fs.readFileSync(abs, 'utf8'), abs }
}

export function listDir(workspaceRoot, relPath = '.', driveOpts) {
  const abs = resolveWorkOrDrive(workspaceRoot, relPath, driveOpts)
  if (!fs.existsSync(abs)) throw new Error(`目录不存在: ${relPath}`)
  const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : 'file',
  }))
  return { path: relPath, entries }
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Path is relative to the workspace, or a company-drive path (_shared/…, _office/…, projects/…).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative or company-drive path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          contents: { type: 'string' },
        },
        required: ['path', 'contents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Replace the first occurrence of oldText with newText in a workspace file. If the file does not exist and oldText is empty, create it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'newText'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories under a workspace path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
]

export function createWorkspaceTools({ workspaceRoot, driveRoot, username, onFileChange } = {}) {
  const driveOpts = { driveRoot, username }
  return {
    workspaceRoot,
    driveRoot,
    definitions: TOOL_DEFINITIONS,
    execute(name, args = {}) {
      switch (name) {
        case 'read_file':
          return readWorkspaceFile(workspaceRoot, args.path, driveOpts)
        case 'write_file':
          return applyWrite(workspaceRoot, args.path, args.contents, onFileChange, driveOpts)
        case 'apply_patch':
          return applyPatch(workspaceRoot, args.path, args.oldText, args.newText, onFileChange, driveOpts)
        case 'list_dir':
          return listDir(workspaceRoot, args.path ?? '.', driveOpts)
        default:
          throw new Error(`未知工具 ${name}`)
      }
    },
  }
}
