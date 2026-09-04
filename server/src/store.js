/**
 * 网关持久化：默认 SQLite（`node:sqlite`，Node 22+ 自带），可用 DESK_GATEWAY_STORE=json 回退。
 * 集合接口仍是 JsonFile / JsonlLog 那套 load / save / update / append。
 * 首次打开空库时，把同目录遗留的 *.json / *.jsonl 迁进去，旧文件不删。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const persistCache = new Map()

const KV_FILES = ['users.json', 'login-sessions.json', 'gateway-tokens.json', 'tasks.json', 'settings.json', 'channels.json']
const LOG_FILES = ['usage.jsonl']

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

export class SqliteFile {
  constructor(db, name, init) {
    this.db = db
    this.name = name
    this.init = init
    this.data = undefined
  }

  load() {
    if (this.data !== undefined) return this.data
    const row = this.db.prepare('SELECT json FROM kv WHERE name = ?').get(this.name)
    this.data = row ? JSON.parse(row.json) : this.init()
    return this.data
  }

  save() {
    this.db.prepare('INSERT INTO kv(name, json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json').run(this.name, JSON.stringify(this.data))
  }

  update(mutator) {
    const data = this.load()
    const result = mutator(data)
    this.save()
    return result
  }
}

export class SqliteLog {
  constructor(db, name) {
    this.db = db
    this.name = name
    this.cache = undefined
  }

  readAll() {
    if (this.cache !== undefined) return this.cache
    const rows = this.db.prepare('SELECT json FROM logs WHERE name = ? ORDER BY seq').all(this.name)
    this.cache = rows.map((r) => JSON.parse(r.json))
    return this.cache
  }

  append(entry) {
    const next = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM logs WHERE name = ?').get(this.name).n
    this.db.prepare('INSERT INTO logs(name, seq, json) VALUES (?, ?, ?)').run(this.name, next, JSON.stringify(entry))
    if (this.cache !== undefined) this.cache.push(entry)
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function sqlitePath(dataDir) {
  return path.join(dataDir, 'gateway.sqlite')
}

export function openSqlite(dataDir) {
  ensureDir(dataDir)
  const db = new DatabaseSync(sqlitePath(dataDir))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logs (name TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (name, seq));
  `)
  migrateJsonIfNeeded(dataDir, db)
  return db
}

/** 空库 + 同目录有旧 JSON/JSONL → 迁入。旧文件保留。 */
export function migrateJsonIfNeeded(dataDir, db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM kv').get().n
  const logCount = db.prepare('SELECT COUNT(*) AS n FROM logs').get().n
  if (count > 0 || logCount > 0) return { migrated: false, reason: 'already-populated' }
  let files = 0
  const insertKv = db.prepare('INSERT INTO kv(name, json) VALUES (?, ?)')
  for (const name of KV_FILES) {
    const file = path.join(dataDir, name)
    if (!fs.existsSync(file)) continue
    insertKv.run(name, fs.readFileSync(file, 'utf8'))
    files++
  }
  const insertLog = db.prepare('INSERT INTO logs(name, seq, json) VALUES (?, ?, ?)')
  for (const name of LOG_FILES) {
    const file = path.join(dataDir, name)
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    let seq = 1
    for (const line of lines) {
      JSON.parse(line)
      insertLog.run(name, seq++, line)
    }
    if (lines.length) files++
  }
  return { migrated: files > 0, files }
}

/**
 * @param {string} dataDir
 * @param {{ driver?: 'sqlite' | 'json' }} [opts]
 */
export function createPersistence(dataDir, opts = {}) {
  const resolved = path.resolve(dataDir)
  const driver = opts.driver ?? process.env.DESK_GATEWAY_STORE ?? 'sqlite'
  const key = `${driver}:${resolved}`
  const hit = persistCache.get(key)
  if (hit) return hit

  ensureDir(resolved)
  if (driver === 'json') {
    const persist = {
      driver: 'json',
      file: (basename, init) => new JsonFile(path.join(resolved, basename), init),
      log: (basename) => new JsonlLog(path.join(resolved, basename)),
      close() {
        persistCache.delete(key)
      },
    }
    persistCache.set(key, persist)
    return persist
  }

  const db = openSqlite(resolved)
  const persist = {
    driver: 'sqlite',
    db,
    file: (basename, init) => new SqliteFile(db, basename, init),
    log: (basename) => new SqliteLog(db, basename),
    close() {
      try {
        db.close()
      } catch {
        /* 重复 close */
      }
      persistCache.delete(key)
    },
  }
  persistCache.set(key, persist)
  return persist
}
