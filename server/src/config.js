/**
 * 配置加载：config.json（默认，随仓库）+ config.local.json（本机覆盖，不入库）+ 环境变量。
 * 上游模型密钥只存在于服务端：从环境变量或 apiKeyFile（如 ~/.dsh/.credentials.yaml）读取，
 * 绝不会下发到任何客户端。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const serverRoot = path.resolve(here, '..')

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base
  if (typeof base !== 'object' || base === null) return patch ?? base
  if (typeof patch !== 'object' || patch === null) return patch ?? base
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = k in out ? deepMerge(out[k], v) : v
  return out
}

export function expandHome(p) {
  if (!p) return p
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
  return p
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return undefined
    throw new Error(`无法解析配置 ${file}: ${err.message}`)
  }
}

/** 从 YAML 风格的 `KEY: value` 文件里读取一个键（无需 YAML 依赖；兼容 dsh 的 `refs:` 缩进层级）。 */
export function readKeyFromSimpleYaml(file, key) {
  try {
    const text = fs.readFileSync(expandHome(file), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
      if (!m || m[1] !== key) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return v.length > 0 ? v : undefined
    }
  } catch {
    /* 文件不存在或不可读：按未配置处理 */
  }
  return undefined
}

export function loadConfig(overrides = {}) {
  const base = readJsonIfExists(path.join(serverRoot, 'config.json')) ?? {}
  const local = readJsonIfExists(path.join(serverRoot, 'config.local.json')) ?? {}
  const cfg = deepMerge(deepMerge(base, local), overrides)
  if (process.env.DESK_GATEWAY_PORT) cfg.port = Number(process.env.DESK_GATEWAY_PORT)
  if (process.env.DESK_GATEWAY_HOST) cfg.host = process.env.DESK_GATEWAY_HOST
  if (process.env.DESK_GATEWAY_DATA) cfg.dataDir = process.env.DESK_GATEWAY_DATA
  cfg.dataDir = path.resolve(serverRoot, expandHome(cfg.dataDir ?? './data'))
  cfg.publicUrl = cfg.publicUrl ?? `http://${cfg.host}:${cfg.port}`

  // 解析上游密钥（仅内存，不落盘、不下发）
  for (const [id, up] of Object.entries(cfg.upstreams ?? {})) {
    up.id = id
    if (up.kind === 'mock') {
      up.resolvedKey = 'mock'
      continue
    }
    let key = up.apiKey
    if (!key && up.apiKeyEnv && process.env[up.apiKeyEnv]) key = process.env[up.apiKeyEnv]
    if (!key && up.apiKeyFile && up.apiKeyEnv) key = readKeyFromSimpleYaml(up.apiKeyFile, up.apiKeyEnv)
    up.resolvedKey = key
    delete up.apiKey
  }
  return cfg
}

/** 模型目录：拉平所有上游的模型，附带上游信息（不含密钥）。 */
export function modelCatalog(cfg) {
  const out = []
  for (const up of Object.values(cfg.upstreams ?? {})) {
    if (up.kind !== 'mock' && !up.resolvedKey) continue // 未配置密钥的上游不对外提供
    for (const m of up.models ?? []) {
      out.push({
        id: m.id,
        name: m.name ?? m.id,
        provider: up.id,
        providerLabel: up.label ?? up.id,
        contextWindow: m.contextWindow ?? 128000,
        maxTokens: m.maxTokens ?? 8192,
        reasoningEfforts: m.reasoningEfforts ?? false,
        compat: { ...(up.compat ?? {}), ...(m.compat ?? {}) },
        priceCnyPerM: m.priceCnyPerM ?? { input: 0, output: 0, cachedInput: 0 },
        upstreamModel: m.upstreamModel ?? m.id,
      })
    }
  }
  return out
}
