/**
 * 极简 zip 读 / 写（零依赖）——只为在 Windows 上打出能在 macOS 跑的 .app。
 *
 * 为什么不用 7-Zip / electron-builder：
 *   Electron.app 的 .framework 里有符号链接（Versions/Current → A 等），Windows 的 7za 会把它们
 *   展开成普通文件，7z 生成的 zip 也不带 unix 权限位（可执行位丢失）——解到 macOS 上 app 直接起不来。
 *   electron-builder 26 干脆在 Windows 上拒绝 --mac（packager.js：Build for macOS is supported only on macOS）。
 * 所以这里自己读 Electron 官方 zip 的中央目录（拿到每个条目的 unix mode 和 symlink 标记），
 * 再按同样的 mode 写我们自己的 zip：symlink 条目写成 typeflag=link，可执行文件保留 0755。
 *
 * 只支持读 store / deflate，只写这两种；不支持加密、多卷、注释（够用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOC = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const SIG_EXTRA_ZIP64 = 0x0001

export const S_IFMT = 0o170000
export const S_IFLNK = 0o120000
export const S_IFDIR = 0o040000
export const S_IFREG = 0o100000

/** unix mode → 是否符号链接 */
export const isSymlinkMode = (mode) => (mode & S_IFMT) === S_IFLNK

// ---------- crc32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(buf, seed = 0) {
  let c = ~seed
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

// ---------- 时间 ----------
/** JS Date → DOS 时间/日期（zip 用本地时间） */
export function toDosTime(date = new Date()) {
  const y = Math.max(1980, date.getFullYear())
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dosDate: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

// ---------- 读 ----------

/**
 * 读一个 zip 的中央目录（整个文件进内存；我们只处理百来 MB 的 Electron 包）。
 * @returns {{entries: object[], read(entry): Buffer, byName: Map<string, object>, close(): void}}
 */
export function openZip(file) {
  const buf = fs.readFileSync(file)
  return openZipBuffer(buf)
}

export function openZipBuffer(buf) {
  // 找 EOCD：从尾部往前扫，注释最长 64K
  let eocd = -1
  const min = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD')

  let count = buf.readUInt16LE(eocd + 10)
  let cdSize = buf.readUInt32LE(eocd + 12)
  let cdOffset = buf.readUInt32LE(eocd + 16)

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64：定位 zip64 EOCD locator（EOCD 前 20 字节）
    const loc = eocd - 20
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOC) throw new Error('zip64 缺少 EOCD locator')
    const z64 = Number(buf.readBigUInt64LE(loc + 8))
    if (buf.readUInt32LE(z64) !== SIG_EOCD64) throw new Error('zip64 EOCD 签名不对')
    count = Number(buf.readBigUInt64LE(z64 + 32))
    cdSize = Number(buf.readBigUInt64LE(z64 + 40))
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48))
  }

  const entries = []
  const byName = new Map()
  let off = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== SIG_CENTRAL) throw new Error(`中央目录第 ${i} 条签名不对 @${off}`)
    const versionMadeBy = buf.readUInt16LE(off + 4)
    const method = buf.readUInt16LE(off + 10)
    const dosTime = buf.readUInt16LE(off + 12)
    const dosDate = buf.readUInt16LE(off + 14)
    const crc = buf.readUInt32LE(off + 16)
    let compSize = buf.readUInt32LE(off + 20)
    let uncompSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const extAttrs = buf.readUInt32LE(off + 38)
    let localOffset = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    // zip64 扩展字段：按顺序补齐被写成 0xffffffff 的字段
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let p = off + 46 + nameLen
      const end = p + extraLen
      while (p + 4 <= end) {
        const id = buf.readUInt16LE(p)
        const len = buf.readUInt16LE(p + 2)
        if (id === SIG_EXTRA_ZIP64) {
          let q = p + 4
          if (uncompSize === 0xffffffff) {
            uncompSize = Number(buf.readBigUInt64LE(q))
            q += 8
          }
          if (compSize === 0xffffffff) {
            compSize = Number(buf.readBigUInt64LE(q))
            q += 8
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(buf.readBigUInt64LE(q))
            q += 8
          }
          break
        }
        p += 4 + len
      }
    }

    const unix = versionMadeBy >> 8 === 3
    const rawMode = unix ? extAttrs >>> 16 : 0
    const isDir = name.endsWith('/') || (extAttrs & 0x10) !== 0
    const mode = rawMode || (isDir ? 0o40755 : 0o100644)
    const entry = {
      name,
      method,
      crc,
      compSize,
      uncompSize,
      localOffset,
      dosTime,
      dosDate,
      extAttrs,
      unix,
      mode,
      isDir,
      isSymlink: isSymlinkMode(mode),
      /** 源 zip 没写 unix mode（versionMadeBy 不是 unix）时为 true，写出时按路径猜 */
      modeInferred: !unix || rawMode === 0,
    }
    entries.push(entry)
    byName.set(name, entry)
    off += 46 + nameLen + extraLen + commentLen
  }

  const read = (entry) => {
    if (buf.readUInt32LE(entry.localOffset) !== SIG_LOCAL) throw new Error(`本地头签名不对：${entry.name}`)
    const nameLen = buf.readUInt16LE(entry.localOffset + 26)
    const extraLen = buf.readUInt16LE(entry.localOffset + 28)
    const start = entry.localOffset + 30 + nameLen + extraLen
    const raw = buf.subarray(start, start + entry.compSize)
    if (entry.method === 0) return Buffer.from(raw)
    if (entry.method === 8) return zlib.inflateRawSync(raw)
    throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`)
  }

  return { entries, byName, read, close: () => {} }
}

// ---------- 写 ----------

/**
 * 顺序写 zip。每条目：本地头 + 数据；最后写中央目录。
 * addFile/addSymlink/addDir 都返回 this，方便链式。
 */
export class ZipWriter {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.file = file
    this.fd = fs.openSync(file, 'w')
    this.offset = 0
    this.central = []
    this.finished = false
  }

  #write(buf) {
    let written = 0
    while (written < buf.length) written += fs.writeSync(this.fd, buf, written, buf.length - written)
    this.offset += buf.length
  }

  /**
   * @param {string} name zip 内路径（/ 分隔，目录以 / 结尾）
   * @param {Buffer} data
   * @param {{mode?: number, dosTime?: number, dosDate?: number, compress?: boolean}} opts
   */
  add(name, data, opts = {}) {
    const mode = opts.mode ?? 0o100644
    const { dosTime, dosDate } = opts.dosTime === undefined ? toDosTime() : { dosTime: opts.dosTime, dosDate: opts.dosDate }
    const crc = crc32(data)
    let method = 0
    let body = data
    if (opts.compress !== false && data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level: 6 })
      if (deflated.length < data.length) {
        method = 8
        body = deflated
      }
    }
    const nameBuf = Buffer.from(name, 'utf8')
    const localOffset = this.offset
    const header = Buffer.alloc(30)
    header.writeUInt32LE(SIG_LOCAL, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x800, 6) // UTF-8 文件名
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(dosTime, 10)
    header.writeUInt16LE(dosDate, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)
    this.#write(header)
    this.#write(nameBuf)
    this.#write(body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(SIG_CENTRAL, 0)
    cd.writeUInt16LE((3 << 8) | 20, 4) // versionMadeBy：unix + 2.0
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(dosTime, 12)
    cd.writeUInt16LE(dosDate, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    const dosDirBit = name.endsWith('/') || (mode & S_IFMT) === S_IFDIR ? 0x10 : 0
    cd.writeUInt32LE((((mode & 0xffff) << 16) | dosDirBit) >>> 0, 38)
    cd.writeUInt32LE(localOffset, 42)
    this.central.push({ cd, nameBuf })
    return this
  }

  /** 普通文件 */
  addFile(name, data, opts = {}) {
    return this.add(name, data, { mode: opts.mode ?? 0o100644, ...opts })
  }

  /** 目录条目 */
  addDir(name, opts = {}) {
    const n = name.endsWith('/') ? name : `${name}/`
    return this.add(n, Buffer.alloc(0), { mode: opts.mode ?? 0o40755, compress: false, ...opts })
  }

  /** 符号链接：data 是链接目标 */
  addSymlink(name, target, opts = {}) {
    return this.add(name, Buffer.from(target, 'utf8'), { mode: 0o120777, compress: false, ...opts })
  }

  finalize() {
    if (this.finished) return this.file
    this.finished = true
    const cdStart = this.offset
    for (const { cd, nameBuf } of this.central) {
      this.#write(cd)
      this.#write(nameBuf)
    }
    const cdSize = this.offset - cdStart
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this.central.length, 8)
    eocd.writeUInt16LE(this.central.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)
    this.#write(eocd)
    fs.closeSync(this.fd)
    return this.file
  }
}
