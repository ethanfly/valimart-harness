/**
 * 从 subscriptions.yaml 生成 mihomo 配置（proxy-providers + 按地区自动选节点）。
 *
 *   node make-mihomo-config.mjs <subscriptions.yaml> <out-config.yaml> [external-ui-dir]
 */
import fs from 'node:fs'

const [, , subListPath, outPath, uiDir] = process.argv
if (!subListPath || !outPath) {
  console.error('用法：node make-mihomo-config.mjs <subscriptions.yaml> <out-config.yaml> [ui-dir]')
  process.exit(64)
}

const raw = fs.readFileSync(subListPath, 'utf8')
const items = parseItems(raw)
if (!items.length) throw new Error('subscriptions.yaml 里没有 items')

const q = (s) => JSON.stringify(s)
const uiLines = uiDir ? `\nexternal-ui: ${uiDir}\n` : ''

/** 地区分组：filter 匹配节点名，url-test 只在该地区内选延迟最低的，保证出口 IP 同区 */
const REGIONS = [
  { name: '新加坡', filter: '(?i)新加坡|狮城|singapore|\\bSG\\b|🇸🇬' },
  { name: '香港', filter: '(?i)香港|hong.?kong|\\bHK\\b|🇭🇰' },
  { name: '日本', filter: '(?i)日本|japan|tokyo|osaka|\\bJP\\b|🇯🇵' },
  { name: '美国', filter: '(?i)美国|united.?states|\\bUSA\\b|\\bUS\\b|洛杉矶|圣何塞|硅谷|西雅图|芝加哥|dallas|america|🇺🇸' },
  { name: '台湾', filter: '(?i)台湾|台灣|taiwan|\\bTW\\b|🇹🇼' },
  { name: '韩国', filter: '(?i)韩国|韓國|korea|seoul|\\bKR\\b|🇰🇷' },
  { name: '英国', filter: '(?i)英国|英國|london|\\bUK\\b|britain|🇬🇧' },
]

const providerIds = items.map((it) => it.id)
const useBlock = providerIds.map((id) => `      - ${id}`).join('\n')

const providerBlocks = items.map((it) => `  ${it.id}:
    type: http
    url: ${q(it.url)}
    path: ./providers/${it.id}.yaml
    interval: ${it.interval}
    header:
      User-Agent:
        - "clash-verge/v2.0.3"
    override:
      additional-prefix: ${q(it.prefix)}
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300
      lazy: true`).join('\n')

const regionGroups = REGIONS.map((r) => `  - name: ${q(r.name)}
    type: url-test
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 80
    lazy: true
    filter: ${q(r.filter)}
    use:
${useBlock}`).join('\n')

const subGroups = items.map((it) => `  - name: ${q(it.name)}
    type: select
    use:
      - ${it.id}`).join('\n')

const regionNames = REGIONS.map((r) => `      - ${q(r.name)}`).join('\n')
const subNames = items.map((it) => `      - ${q(it.name)}`).join('\n')

// 面板 secret：MIHOMO_SECRET env 可覆盖（轮换时设 env 再跑 apply-subscriptions.sh 重生配置）
const API_SECRET = process.env.MIHOMO_SECRET || 'valimart-clash-2026'

const config = `# ============================================================
# valimart 树莓派网关 · mihomo（自动生成）
# 改订阅：http://<Pi>:9091/?key=<admin.key 里的口令> 或编辑 subscriptions.yaml
# 切节点/地区：http://<Pi>:9090/ui/  secret 由 MIHOMO_SECRET env 提供
# PROXY 选「新加坡」等地区组 = 只在该地区 url-test，出口 IP 同区
# ============================================================
mixed-port: 7890
bind-address: '*'
allow-lan: true
mode: rule
log-level: warning
ipv6: false
unified-delay: true
tcp-concurrent: true
find-process-mode: 'off'
external-controller: 0.0.0.0:9090
secret: ${q(API_SECRET)}
${uiLines}
dns:
  enable: true
  ipv6: false
  # HTTP 代理用 redir-host。fake-ip 是给 TUN 的，会把解析打成 198.18.0.0/15，
  # 客户端 web_fetch/AnySearch 的公网 IP 校验会直接拒。
  enhanced-mode: redir-host
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
  proxy-server-nameserver:
    - 223.5.5.5
    - 119.29.29.29

proxy-providers:
${providerBlocks}

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - AUTO
${regionNames}
${subNames}
  - name: AUTO
    type: fallback
    url: https://www.gstatic.com/generate_204
    interval: 300
    lazy: true
    proxies:
${regionNames}
${regionGroups}
${subGroups}

rules:
  - DOMAIN-SUFFIX,openai.com,PROXY
  - DOMAIN-SUFFIX,x.ai,PROXY
  - DOMAIN-SUFFIX,chatgpt.com,PROXY
  - DOMAIN-SUFFIX,oaistatic.com,PROXY
  - DOMAIN-SUFFIX,oaiusercontent.com,PROXY
  - DOMAIN-SUFFIX,anthropic.com,PROXY
  - DOMAIN-SUFFIX,googleapis.com,PROXY
  - DOMAIN-SUFFIX,google.com,PROXY
  - DOMAIN-SUFFIX,youtube.com,PROXY
  - DOMAIN-SUFFIX,github.com,PROXY
  - DOMAIN-SUFFIX,githubusercontent.com,PROXY
  - DOMAIN-SUFFIX,deepseek.com,DIRECT
  - DOMAIN-SUFFIX,dashscope.aliyuncs.com,DIRECT
  - DOMAIN-SUFFIX,valimart.net,DIRECT
  - DOMAIN-SUFFIX,ethan.team,DIRECT
  - DOMAIN-SUFFIX,input.im,DIRECT
  - DOMAIN-SUFFIX,aliyuncs.com,DIRECT
  - DOMAIN-SUFFIX,cn,DIRECT
  - GEOIP,CN,DIRECT,no-resolve
  - MATCH,PROXY
`

fs.writeFileSync(outPath, config)
console.log(`已写入 ${outPath}（订阅 ${items.length}：${items.map((i) => i.name).join('、')}；地区 ${REGIONS.map((r) => r.name).join('/')}）`)

function parseItems(text) {
  const out = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('#') || !t) continue
    const mItem = /^-\s+id:\s*(\S+)/.exec(t)
    if (mItem) {
      if (cur) out.push(cur)
      cur = { id: mItem[1].replace(/^["']|["']$/g, ''), name: '', url: '', interval: 86400, prefix: '' }
      continue
    }
    if (!cur) continue
    const kv = /^(\w+):\s*(.*)$/.exec(t)
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (kv[1] === 'name') cur.name = v
    if (kv[1] === 'url') cur.url = v
    if (kv[1] === 'interval') cur.interval = Number(v) || 86400
    if (kv[1] === 'prefix') cur.prefix = v
  }
  if (cur) out.push(cur)
  return out.filter((x) => x.id && x.url)
}
