// 在树莓派容器内校验迁移后的 gateway.sqlite
import { DatabaseSync } from 'node:sqlite'
const dir = process.argv[2] || '/data'
const db = new DatabaseSync(dir + '/gateway.sqlite', { readOnly: true })
const raw = (n) => { const r = db.prepare('select json from kv where name=?').get(n); return r ? r.json : null }
const get = (n) => { const s = raw(n); return s ? JSON.parse(s) : null }

console.log('=== 完整性 ===')
console.log(JSON.stringify(db.prepare('PRAGMA integrity_check').all()))

console.log('\n=== kv 集合 ===')
for (const r of db.prepare('select name, length(json) as len from kv order by name').all()) {
  console.log(`  ${r.name}  ${r.len} B`)
}

const users = get('users.json')?.items ?? []
console.log(`\n=== 员工 (${users.length}) ===`)
for (const u of users) console.log(`  ${u.username} | ${u.role} | ${u.department ?? '-'} | ${u.displayName ?? ''}`)

const ch = get('channels.json')?.items ?? {}
const chIds = Object.keys(ch)
console.log(`\n=== 模型通道 (${chIds.length}) ===`)
for (const id of chIds) {
  const c = ch[id]
  const accounts = c.accounts?.length ?? 0
  const models = c.models?.length ?? 0
  const hasKey = !!(c.apiKey || c.key || accounts)
  console.log(`  ${id} | 模型 ${models} | 账号 ${accounts} | 有凭据 ${hasKey}`)
}

const custom = get('channels.json')?.custom
if (Array.isArray(custom)) {
  console.log(`\n=== custom 通道 (${custom.length}) ===`)
  for (const c of custom) console.log(`  ${c.id ?? c.label} | ${c.baseUrl ?? ''}`)
}

const tk = get('gateway-tokens.json')?.items ?? []
console.log(`\n=== 网关令牌 (${tk.length}) 台设备 ===`)
console.log('  ' + tk.map((t) => t.deviceName ?? t.platform ?? t.id?.slice(0, 8)).join(', '))

const ls = get('login-sessions.json')?.items ?? []
console.log(`=== 登录会话 (${ls.length}) ===`)

const tasks = get('tasks.json')?.items ?? []
console.log(`=== 任务 (${tasks.length}) ===`)
for (const t of tasks) console.log(`  ${t.title} | ${t.status}`)

const settings = get('settings.json')
console.log(`\n=== 公司 / 岗位 ===`)
console.log('  公司名: ' + settings?.company?.name)
console.log('  岗位: ' + (settings?.company?.positions ?? []).map((p) => `${p.name}(${p.quotaKind})`).join(', '))
console.log('  部门: ' + ((settings?.company?.departments ?? []).map((d) => d.name).join(', ') || '(未单独存)'))

const usage = db.prepare("select count(*) as n from logs where name='usage.jsonl'").get().n
const lastUsage = db.prepare("select json from logs where name='usage.jsonl' order by seq desc limit 1").get()
console.log(`\n=== 用量账本: ${usage} 条 ===`)
if (lastUsage) console.log('  最后一条: ' + String(lastUsage.json).slice(0, 200))

console.log('\n=== AnySearch 搜索密钥 ===')
const s = raw('search.json')
console.log('  ' + (s ? (JSON.parse(s).anysearch?.apiKey ? '已配置 ' + String(JSON.parse(s).anysearch.apiKey).slice(0, 12) + '…' : '未配置') : '(无)'))

db.close()
