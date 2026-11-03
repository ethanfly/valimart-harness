/**
 * 公司盘同步索引落盘（.sync-index.json）。
 *
 * pi、桌面端（desk-host）、VS Code 插件各自有一份 DriveMirror，同步逻辑原本是内存索引加「先推后拉」：
 * 进程一重启索引就清空，本机旧副本被当成「本地新改」整盘回推（pi 每次启动要等一两分钟），
 * 还会盖掉别的电脑 / 别的客户端刚写的新版本。Claude 插件先修了（packages/claude-valimart-desk），
 * 这里是同一套做法，供另外三份复用，避免再各改一遍。
 *
 * 用法：`Object.assign(DriveMirror.prototype, persistedIndexMethods)`，宿主类自己提供
 * `abs(rel)`、`runExclusive(fn)`、`tomb` / `loadTomb()` / `saveTomb()` 和 `ensureLayout(snap)`。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 先写同目录隐藏临时文件再改名：进程被杀时文件要么是旧版要么是新版，不会留下半截被当成本地修改回推。 */
export function writeFileAtomic(full, data) {
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, full)
  } catch {
    // Windows 上目标文件被别的程序占用时改名会失败：退回直接覆盖
    fs.rmSync(tmp, { force: true })
    fs.writeFileSync(full, data)
  }
}

export const persistedIndexMethods = {
  /** 在构造函数末尾调用：从盘上读回上次同步的记录。 */
  initPersistedIndex() {
    this.indexPath = path.join(this.root, '.sync-index.json')
    this.index = this.loadIndex() ?? new Map() // rel -> sha256（上次同步时本机与远端一致的内容）
  },

  loadIndex() {
    try {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))))
    } catch {
      return null
    }
  },

  saveIndex() {
    try {
      writeFileAtomic(this.indexPath, JSON.stringify(Object.fromEntries(this.index)))
    } catch {
      /* 写不进就只在本进程生效 */
    }
  },

  /** 以盘上的为准：同一镜像目录可能有好几个进程在同步。 */
  reloadIndex() {
    const disk = this.loadIndex()
    if (disk) this.index = disk
  },

  async pull() {
    return this.runExclusive(() => {
      this.reloadIndex()
      return this.pullNow()
    })
  },

  async pullNow() {
    const snap = await this.gateway.get('/api/drive/snapshot')
    let downloaded = 0
    const remote = new Set()
    try {
      for (const f of snap.files ?? []) {
        remote.add(f.path)
        const full = this.abs(f.path)
        let localSha
        try {
          localSha = sha256(fs.readFileSync(full))
        } catch {
          localSha = undefined
        }
        if (localSha === f.sha256) {
          this.index.set(f.path, f.sha256)
          continue
        }
        // 本地被改过且远端没变：属于待回推，不覆盖
        if (localSha !== undefined && this.index.get(f.path) === f.sha256) continue
        const buf = await this.gateway.get(`/api/drive/file?path=${encodeURIComponent(f.path)}`)
        writeFileAtomic(full, buf)
        this.index.set(f.path, f.sha256)
        downloaded++
      }
      // 远端删除：本地保留副本但不再跟踪；个人区记墓碑，否则下一轮会被当成本地新增传回去
      const me = this.state.data.user?.username
      const myPrefix = `_office/${me}/`
      for (const rel of [...this.index.keys()]) {
        if (remote.has(rel)) {
          if (this.tomb.delete(rel)) this.saveTomb()
          continue
        }
        if (me && rel.startsWith(myPrefix)) {
          this.tomb.add(rel)
          this.saveTomb()
        }
        this.index.delete(rel)
      }
    } finally {
      this.saveIndex()
    }
    this.ensureLayout(snap)
    if (downloaded || !this.everSynced) this.log(`公司盘同步完成：${(snap.files ?? []).length} 个文件，下载 ${downloaded} 个`)
    this.everSynced = true
    return { files: (snap.files ?? []).length, downloaded }
  },

  async pushPersonal() {
    return this.runExclusive(() => {
      this.reloadIndex()
      return this.pushPersonalNow()
    })
  },

  async pushPersonalNow() {
    const me = this.state.data.user?.username
    if (!me) return { pushed: 0 }
    const base = `_office/${me}`
    const dir = this.abs(base)
    if (!fs.existsSync(dir)) return { pushed: 0 }
    let pushed = 0
    const pending = []
    const walk = (rel, tomb) => {
      for (const d of fs.readdirSync(this.abs(rel), { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue
        const childRel = `${rel}/${d.name}`
        if (d.isDirectory()) walk(childRel, tomb)
        else {
          // 墓碑是 Set：网关已删、本机旧副本不回推（先于读盘/哈希拦截）
          if (tomb.has(childRel)) continue
          const buf = fs.readFileSync(this.abs(childRel))
          if (buf.length > 20 * 1024 * 1024) continue
          const sha = sha256(buf)
          if (this.index.get(childRel) === sha) continue
          pushed++
          pending.push({ rel: childRel, buf, sha })
        }
      }
    }
    const liveTomb = new Set([...this.tomb].filter((r) => r.startsWith(`${base}/`)))
    walk(base, liveTomb)
    try {
      for (const p of pending) {
        await this.gateway.put(`/api/drive/file?path=${encodeURIComponent(p.rel)}`, p.buf, {
          raw: true,
          headers: { 'content-type': 'application/octet-stream' },
        })
        this.index.set(p.rel, p.sha)
        if (this.tomb.delete(p.rel)) this.saveTomb()
      }
    } finally {
      if (pending.length) this.saveIndex()
    }
    if (pushed) this.log(`个人记忆回推 ${pushed} 个文件`)
    return { pushed }
  },

  async sync() {
    return this.runExclusive(async () => {
      this.reloadIndex()
      let pushed
      let r
      if (this.index.size === 0) {
        // 没有任何同步记录（新镜像 / 索引丢了）：先拉后推，以远端为准，不把来路不明的旧副本推上去
        r = await this.pullNow()
        ;({ pushed } = await this.pushPersonalNow())
      } else {
        ;({ pushed } = await this.pushPersonalNow())
        r = await this.pullNow()
      }
      this.state.data.lastSyncAt = new Date().toISOString()
      this.state.save()
      return { ...r, pulled: r.downloaded, pushed }
    })
  },
}
