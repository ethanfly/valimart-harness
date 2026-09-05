/**
 * 企业交付工作台 · 网关服务端入口。
 *
 *   node server/src/index.js            # 读取 server/config.json (+ config.local.json)
 *
 * 职责：公司账号登录 → 按人签发网关令牌（吊销即时生效）→ /v1 模型代理（真实密钥不出服务端）
 *      → 按人记账/周额度 → 任务卡与四格验收 → 公司盘（共享经验 / 个人记忆 / 任务收件箱）。
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSeedAdmin, loadConfig, modelCatalog, shouldSeedDriveSamples } from './config.js'
import { Db, ROLE_LABELS } from './db.js'
import { Ledger } from './ledger.js'
import { Drive } from './drive.js'
import { Tasks } from './tasks.js'
import { LlmProxy } from './llm-proxy.js'
import { Channels } from './channels.js'
import { OAuthSubscribe } from './oauth-subscribe.js'
import { Knowledge } from './knowledge.js'
import { registerApi } from './api.js'
import { registerAdminPage } from './admin-page.js'
import { createLanBeacon, shouldStartLanBeacon } from './lan-beacon.js'
import { LAN_PRODUCT } from '../../scripts/lib/lan-protocol.mjs'
import { createRouter, parseUrl, sendError, sendJson, HttpError } from './http.js'

const startedAt = Date.now()

export function createGateway(overrides = {}) {
  const { fetchReleases, kernels, fetchNpmVersions, prepareInstaller, fetchModels, ...cfgOverrides } = overrides
  const cfg = loadConfig(cfgOverrides)
  const db = new Db(cfg.dataDir)
  const ledger = new Ledger(db, cfg)
  const tasksRef = { current: undefined }
  const drive = new Drive(db.driveRoot, (taskId) => tasksRef.current?.get(taskId))
  const tasks = new Tasks(db, drive)
  tasksRef.current = tasks
  const channels = new Channels(cfg, cfg.dataDir) // 界面上接入的通道合并进 cfg.upstreams
  const knowledge = new Knowledge({ drive, tasks, db }) // 第四层通道：检索「公司里有没有人做过」
  const catalog = () => modelCatalog(cfg)
  const oauth = new OAuthSubscribe({ cfg, channels })
  const proxy = new LlmProxy({ db, cfg, ledger, catalog, oauth, channels })

  // 在线状态：登录会话心跳（客户端本机 host 每 30s 一次）
  const lastSeen = new Map()
  const presence = {
    touch(userId) {
      lastSeen.set(userId, Date.now())
    },
    leave(userId) {
      lastSeen.delete(userId)
    },
    isOnline(user) {
      const seen = lastSeen.get(user.id)
      return seen !== undefined && Date.now() - seen < (cfg.presenceOnlineSeconds ?? 90) * 1000
    },
  }

  bootstrap({ db, cfg, drive })

  const router = createRouter()
  registerApi(router, {
    db,
    cfg,
    ledger,
    tasks,
    drive,
    proxy,
    catalog,
    presence,
    channels,
    knowledge,
    startedAt,
    fetchReleases,
    kernels,
    fetchNpmVersions,
    prepareInstaller,
    oauth,
    fetchModels,
  })
  registerAdminPage(router, { cfg })
  router.get('/v1/models', (req, res) => proxy.handleModels(req, res))
  router.post('/v1/chat/completions', (req, res) => proxy.handleChat(req, res))
  router.get('/health', (_req, res) => {
    const addr = server.address()
    sendJson(res, 200, {
      ok: true,
      product: LAN_PRODUCT,
      name: db.companySettings().name ?? cfg.company?.name,
      port: addr?.port ?? cfg.port,
      publicUrl: cfg.publicUrl,
      needsSetup: db.listUsers().length === 0,
      time: new Date().toISOString(),
    })
  })

  let beacon = null
  const server = http.createServer(async (req, res) => {
    const url = parseUrl(req)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }
    const matched = router.match(req.method ?? 'GET', url.pathname)
    try {
      if (!matched) throw new HttpError(404, `no route ${req.method} ${url.pathname}`, 'not_found')
      req.params = matched.params
      for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v)
      await matched.handler(req, res)
    } catch (err) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendError(res, err)
    }
  })

  return {
    cfg,
    db,
    ledger,
    tasks,
    drive,
    proxy,
    channels,
    oauth,
    knowledge,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.listen(cfg.port, cfg.host, () => {
          const addr = server.address()
          const url = `http://${cfg.host}:${addr.port}`
          console.log(`[gateway] ${cfg.company?.name ?? ''} 网关已启动 ${url}（管理页 ${url}/admin）`)
          console.log(`[gateway] 模型目录: ${catalog().map((m) => `${m.id}(${m.providerLabel})`).join(', ') || '（无可用上游：请配置密钥）'}`)
          const startBeacon = async () => {
            if (!shouldStartLanBeacon(cfg)) return
            beacon = createLanBeacon({
              httpPort: addr.port,
              publicUrl: cfg.publicUrl,
              companyName: () => db.companySettings().name ?? cfg.company?.name,
              needsSetup: () => db.listUsers().length === 0,
              udpPort: cfg.lanDiscoverPort ?? undefined,
              log: console.log,
            })
            await beacon.start()
          }
          startBeacon().then(() => resolve(url), reject)
        })
      })
    },
    close() {
      return new Promise((resolve) => {
        const done = () => {
          server.close(() => {
            db.persist?.close()
            resolve()
          })
        }
        if (beacon) beacon.close().then(done, done)
        else done()
      })
    },
  }
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-kernel-version, x-kernel-sha256, x-kernel-source-tag',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  }
}

function bootstrap({ db, cfg, drive }) {
  drive.ensureLayout({ seedSamples: shouldSeedDriveSamples(cfg) })
  if (db.listUsers().length === 0) {
    const seed = cfg.seedAdmin
    if (!isSeedAdmin(seed)) {
      console.log('[gateway] 首次启动：库里没有账号。打开管理页或客户端完成引导（设置公司名、初始管理员）。')
    } else {
      const admin = db.createUser({ ...seed, role: 'admin', seed: true })
      drive.ensureOffice(admin.username)
      console.log(`[gateway] 首次启动：已创建种子管理员 ${admin.username} / ${seed.password}（请尽快修改密码）`)
      for (const u of cfg.seedUsers ?? []) {
        try {
          const created = db.createUser({ ...u, role: u.role ?? 'employee' })
          drive.ensureOffice(created.username)
          console.log(`[gateway] 演示账号 ${created.username} / ${u.password} (${ROLE_LABELS[created.role]} · ${created.department})`)
        } catch (err) {
          console.warn(`[gateway] 跳过演示账号 ${u.username}: ${err.message}`)
        }
      }
    }
  } else {
    for (const u of db.listUsers()) drive.ensureOffice(u.username)
  }
  for (const [id, up] of Object.entries(cfg.upstreams ?? {})) {
    if (up.kind !== 'mock' && !up.resolvedKey) console.warn(`[gateway] 上游 ${id} 未配置密钥（${up.apiKeyEnv ?? 'apiKey'}），其模型不会出现在目录中`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  createGateway()
    .listen()
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
