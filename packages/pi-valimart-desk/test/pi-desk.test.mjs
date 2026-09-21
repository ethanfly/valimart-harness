import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseDeskLoginArgs } from '../lib/login-args.mjs'
import { inferModelInput, isChatModel, toPiModels, v1BaseUrl } from '../lib/models.mjs'
import { normalizeGatewayUrl } from '../lib/gateway.mjs'
import { fileURLToPath } from 'node:url'
import { isLoggedIn, loadState, publicView, saveState, statePath } from '../lib/state.mjs'

describe('parseDeskLoginArgs', () => {
  it('reads url and user from args, password only from env', () => {
    const r = parseDeskLoginArgs('http://gw:8790 alice secret-in-args', { DESK_GATEWAY_PASSWORD: 'from-env' })
    assert.equal(r.url, 'http://gw:8790')
    assert.equal(r.username, 'alice')
    assert.equal(r.password, 'from-env')
  })

  it('falls back to env when args empty', () => {
    const r = parseDeskLoginArgs('', {
      DESK_GATEWAY_URL: 'http://127.0.0.1:8790',
      DESK_GATEWAY_USER: 'emp-a',
      DESK_GATEWAY_PASSWORD: 'x',
    })
    assert.equal(r.url, 'http://127.0.0.1:8790')
    assert.equal(r.username, 'emp-a')
    assert.equal(r.password, 'x')
  })
})

describe('models', () => {
  it('drops image/video ids from the chat catalog', () => {
    assert.equal(isChatModel('deepseek-v4-pro'), true)
    assert.equal(isChatModel('grok-imagine-image'), false)
    assert.equal(isChatModel('gpt-image-1'), false)
  })

  it('maps company catalog to pi models with zero USD cost', () => {
    const models = toPiModels(
      [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          contextWindow: 1000000,
          maxTokens: 384000,
          reasoningEfforts: { off: null, high: 'high', max: 'max' },
          priceCnyPerM: { input: 1, output: 2 },
        },
        { id: 'grok-imagine-image', name: 'Imagine' },
      ],
      { baseUrl: 'http://127.0.0.1:8790/v1' },
    )
    assert.equal(models.length, 1)
    assert.equal(models[0].id, 'deepseek-v4-flash')
    assert.equal(models[0].reasoning, true)
    assert.equal(models[0].cost.input, 0)
    assert.equal(models[0].baseUrl, 'http://127.0.0.1:8790/v1')
    assert.deepEqual(models[0].input, ['text', 'image'])
    assert.equal(models[0].thinkingLevelMap.high, 'high')
  })

  it('mock and gen-only models are text-only', () => {
    assert.deepEqual(inferModelInput('mock-echo'), ['text'])
    assert.deepEqual(inferModelInput('qwen-image'), ['text'])
  })

  it('builds /v1 base url', () => {
    assert.equal(v1BaseUrl('http://127.0.0.1:8790/'), 'http://127.0.0.1:8790/v1')
  })
})

describe('normalizeGatewayUrl', () => {
  it('keeps http origin and rejects junk', () => {
    assert.equal(normalizeGatewayUrl('http://10.0.0.2:8790/foo'), 'http://10.0.0.2:8790')
    assert.equal(normalizeGatewayUrl('ftp://x'), '')
    assert.equal(normalizeGatewayUrl('not a url'), '')
  })
})

describe('mark grid', () => {
  it('has a 10x10 RGBA grid for the 惠利玛 flower', () => {
    const grid = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../assets/mark-grid.json', import.meta.url)), 'utf8'))
    assert.equal(grid.w, 10)
    assert.equal(grid.h, 10)
    assert.equal(Buffer.from(grid.rgba, 'base64').length, 10 * 10 * 4)
  })
})

describe('state', () => {
  it('writes tokens under PI_AGENT_DIR and hides them in publicView', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desk-'))
    process.env.PI_AGENT_DIR = dir
    try {
      const saved = saveState({
        gatewayUrl: 'http://127.0.0.1:8790',
        sessionToken: 'sess',
        gatewayToken: 'gw',
        user: { username: 'emp-a', displayName: '员工A' },
        company: { name: 'Acme', plan: '团队版', seats: 9 },
        models: [{ id: 'mock-echo' }],
      })
      assert.equal(isLoggedIn(saved), true)
      assert.equal(fs.existsSync(statePath()), true)
      const view = publicView(loadState())
      assert.equal(view.loggedIn, true)
      assert.equal(view.user.username, 'emp-a')
      assert.equal(view.company.name, 'Acme')
      assert.equal(JSON.stringify(view).includes('sess'), false)
      assert.equal(JSON.stringify(view).includes('gw'), false)
    } finally {
      delete process.env.PI_AGENT_DIR
    }
  })
})
