/**
 * 极简 JSON 持久化：每个集合一个文件，原子写（临时文件 + rename）。
 * 规模面向几十人的公司，不追求高并发；所有写操作串行化。
 */
import fs from 'node:fs'
import path from 'node:path'

export class JsonFile {
  /**
   * @param {string} file 绝对路径
   * @param {() => any} init 首次加载时的初始值
   */
  constructor(file, init) {
    this.file = file
    this.init = init
    this.data = undefined
    this.queue = Promise.resolve()
  }

  load() {
    if (this.data !== undefined) return this.data
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.data = JSON.parse(raw)
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err
      this.data = this.init()
    }
    return this.data
  }

  /** 同步写盘（原子）。 */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  /**
   * 读-改-写：mutator 直接修改 data，返回值透传。
   * @template T
   * @param {(data: any) => T} mutator
   * @returns {T}
   */
  update(mutator) {
    const data = this.load()
    const result = mutator(data)
    this.save()
    return result
  }
}

/** 追加型 JSONL 账本（用量流水）。 */
export class JsonlLog {
  constructor(file) {
    this.file = file
    this.cache = undefined
  }

  readAll() {
    if (this.cache !== undefined) return this.cache
    let lines = []
    try {
      lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err
    }
    this.cache = lines.map((line) => JSON.parse(line))
    return this.cache
  }

  append(entry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n')
    if (this.cache !== undefined) this.cache.push(entry)
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
