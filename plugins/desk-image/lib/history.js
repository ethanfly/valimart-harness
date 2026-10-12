/**
 * 生图 / 生视频历史：一个工作目录一份 .desk-media/history.json。
 * 只记元数据和产物相对路径，不复制文件。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = ['.desk-media', 'history.json']
const MAX = 200

export function historyFile(cwd) {
  return path.join(cwd, ...FILE)
}

export function readHistory(cwd) {
  try {
    const json = JSON.parse(fs.readFileSync(historyFile(cwd), 'utf8'))
    return {
      image: Array.isArray(json.image) ? json.image : [],
      video: Array.isArray(json.video) ? json.video : [],
    }
  } catch {
    return { image: [], video: [] }
  }
}

export function appendHistory(cwd, kind, entry) {
  const all = readHistory(cwd)
  const list = [{ ...entry, at: entry.at ?? new Date().toISOString() }, ...(all[kind] ?? [])].slice(0, MAX)
  const next = { ...all, [kind]: list }
  const file = historyFile(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
  return list
}
