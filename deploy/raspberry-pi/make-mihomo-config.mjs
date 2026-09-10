/**
 * 从 Clash 订阅里抽取节点，生成 mihomo 配置（树莓派网关专用，含网页管理面板）。
 *
 *   node make-mihomo-config.mjs <subscription.yaml> <out-config.yaml> [external-ui-dir]
 *
 * 关键设计：
 *   - 规则用 DOMAIN-SUFFIX 精确匹配已知上游，GEOIP 加 no-resolve 防 DNS 投毒
 *   - 健康检查用 HTTPS（HTTP 会被运营商劫持导致误判）
 *   - PROXY 用 select 类型（面板可手动切节点），AUTO 用 fallback（自动容错）
 *   - lazy: true 减少 72 节点在 1.8G 内存 Pi 上的资源占用
 */
import fs from 'node:fs'

const [, , subPath, outPath, uiDir] = process.argv
if (!subPath || !outPath) {
  console.error('用法：node make-mihomo-config.mjs <subscription.yaml> <out-config.yaml> [external-ui-dir]')
  process.exit(64)
}

const lines = fs.readFileSync(subPath, 'utf8').split(/\r?\n/)

// ---- 1. 定位 proxies 顶级段 ----
let start = -1
for (let i = 0; i < lines.length; i++) {
  if (/^proxies:\s*$/.test(lines[i])) { start = i; break }
}
if (start < 0) throw new Error('订阅里找不到顶级的 proxies: 段')

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  const l = lines[i]
  if (l.trim() === '' || l.trimStart().startsWith('#')) continue
  if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(l)) { end = i; break }
}

// ---- 2. 取节点行（跳过 proxies: 头）----
const entries = lines.slice(start + 1, end).map((l) => l.trim()).filter((l) => l.startsWith('- '))
if (!entries.length) throw new Error('proxies 段里没有节点条目')

// 节点名（单引号或双引号）
const names = entries.map((raw) => {
  const m = /^-\s*\{?\s*name:\s*/.exec(raw)
  if (!m) throw new Error(`无法解析: ${raw.slice(0, 60)}`)
  const rest = raw.slice(m[0].length)
  const q = rest[0]
  if (q === '"' || q === "'") {
    let i = 1
    while (i < rest.length && rest[i] !== q) { if (rest[i] === '\\') i++; i++ }
    return rest.slice(1, i)
  }
  const c = rest.indexOf(',')
  return (c < 0 ? rest : rest.slice(0, c)).trim()
})
console.log(`抽到节点 ${names.length} 个`)

// ---- 3. 生成配置 ----
const q = (s) => JSON.stringify(s)
const allNodes = names.map((n) => `      - ${q(n)}`).join('\n')
// 已知可用节点放前面（fallback 按顺序尝试）
const knownGood = names.filter((n) => /东京02|AWS日本0[1-8]/.test(n))
const fallbackList = [...knownGood, ...names.filter((n) => !knownGood.includes(n))]
  .map((n) => `      - ${q(n)}`).join('\n')

const uiLines = uiDir ? `\nexternal-ui: ${uiDir}\n` : ''

const config = `# ============================================================
# valimart 树莓派网关 · mihomo 配置（自动生成，勿手改）
# mixed-port 7890 = HTTP 代理（给网关容器）
# external-controller 9090 = 网页管理面板（可切换节点）
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
secret: "valimart-clash-2026"
${uiLines}
dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - '*.lan'
    - '*.local'
    - '+.valimart.net'
    - '+.ethan.team'
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
  proxy-server-nameserver:
    - 223.5.5.5
    - 119.29.29.29

proxies:
${entries.map((l) => '  ' + l).join('\n')}

proxy-groups:
  # 面板可手动切换（select 类型）
  - name: PROXY
    type: select
    proxies:
      - AUTO
${knownGood.slice(0, 5).map((n) => `      - ${q(n)}`).join('\n')}
  # 自动容错：按顺序尝试，失败立即切下一个
  - name: AUTO
    type: fallback
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 100
    lazy: true
    proxies:
${fallbackList}

rules:
  # ===== 必须走代理的（被墙）=====
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
  # ===== 国内/内网直连（不走代理）=====
  - DOMAIN-SUFFIX,deepseek.com,DIRECT
  - DOMAIN-SUFFIX,dashscope.aliyuncs.com,DIRECT
  - DOMAIN-SUFFIX,valimart.net,DIRECT
  - DOMAIN-SUFFIX,ethan.team,DIRECT
  - DOMAIN-SUFFIX,input.im,DIRECT
  - DOMAIN-SUFFIX,aliyuncs.com,DIRECT
  - DOMAIN-SUFFIX,cn,DIRECT
  # ===== 兜底 =====
  - GEOIP,CN,DIRECT,no-resolve
  - MATCH,PROXY
`

fs.writeFileSync(outPath, config)
console.log(`已写入 ${outPath}（${config.length} 字节，${entries.length} 节点，fallback 优先 ${knownGood.length} 个已知可用）`)
