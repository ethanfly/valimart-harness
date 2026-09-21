/**
 * Local login state. Stores the company-desk sessionToken + gatewayToken only.
 * Upstream model API keys must never appear here.
 */
import fs from 'node:fs'
import path from 'node:path'

const FORBIDDEN_KEY = /^(api[_-]?key|openai_api_key|anthropic_api_key|deepseek_api_key|xai_api_key)$/i

export function isForbiddenKey(name) {
  return FORBIDDEN_KEY.test(String(name ?? ''))
}

export function stripForbiddenKeys(value) {
  if (Array.isArray(value)) return value.map(stripForbiddenKeys)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (isForbiddenKey(k)) continue
    out[k] = stripForbiddenKeys(v)
  }
  return out
}

function defaults() {
  return {
    gatewayUrl: null,
    sessionToken: null,
    gatewayToken: null,
    user: null,
    company: null,
    quota: null,
    loggedInAt: null,
    lastError: null,
    device: null,
  }
}

export class TokenStore {
  constructor(stateDir) {
    this.dir = stateDir
    this.file = path.join(stateDir, 'desk-state.json')
    this.data = this.#load()
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return { ...defaults(), ...stripForbiddenKeys(raw) }
    } catch {
      return defaults()
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true })
    const payload = stripForbiddenKeys(this.data)
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
    try {
      fs.renameSync(tmp, this.file)
    } catch {
      fs.copyFileSync(tmp, this.file)
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  }

  get loggedIn() {
    return !!(this.data.sessionToken && this.data.user)
  }

  setLogin({ gatewayUrl, sessionToken, gatewayToken, user, company, quota, device }) {
    Object.assign(this.data, {
      gatewayUrl,
      sessionToken,
      gatewayToken,
      user: stripForbiddenKeys(user),
      company: stripForbiddenKeys(company),
      quota: stripForbiddenKeys(quota),
      device: device ?? this.data.device,
      loggedInAt: new Date().toISOString(),
      lastError: null,
    })
    this.save()
  }

  clearLogin(reason) {
    Object.assign(this.data, {
      sessionToken: null,
      gatewayToken: null,
      user: null,
      quota: null,
      lastError: reason ?? null,
    })
    this.save()
  }

  publicView() {
    const d = this.data
    const tok = d.gatewayToken
    return {
      loggedIn: this.loggedIn,
      gatewayUrl: d.gatewayUrl,
      user: d.user,
      company: d.company,
      quota: d.quota,
      loggedInAt: d.loggedInAt,
      lastError: d.lastError,
      tokenHint: tok ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : null,
      modelCount: d.company?.models?.length ?? 0,
      defaultModel: d.company?.defaultModel ?? null,
    }
  }
}

export { catalogModelId } from './models.js'
