import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { gatewayOptions, gatewayUrlFromChoice, MANUAL_GATEWAY_LABEL, suggestedGatewayUrl } from '../lib/gateway-choice.mjs'
import { parseDeskLoginArgs } from '../lib/login-args.mjs'
import { GATEWAY_COMPAT, inferModelInput, isChatModel, normalizeReasoningEfforts, thinkingLevelMap, toPiModels, v1BaseUrl } from '../lib/models.mjs'
import { normalizeGatewayUrl } from '../lib/gateway.mjs'
import { assertInside, zoneRoot } from '../lib/drive-paths.mjs'
import { peopleOptions, personIdFromChoice } from '../lib/people-options.mjs'
import { assertDecision, canFinalize, canReview, canSubmit, hasDeliverables, reviewerOptions, workflowHint } from '../lib/task-workflow.mjs'
import { driveLog, setDriveLogSink } from '../lib/drive-runtime.mjs'
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
    assert.equal(models[0].thinkingLevelMap.max, 'max')
    assert.equal(models[0].thinkingLevelMap.low, null)
    assert.equal('off' in models[0].thinkingLevelMap, false)
    assert.equal(models[0].compat.thinkingFormat, GATEWAY_COMPAT.thinkingFormat)
    assert.equal(models[0].compat.maxTokensField, 'max_tokens')
    assert.equal(models[0].compat.supportsReasoningEffort, true)
  })

  it('turns array-shaped reasoningEfforts into a thinkingLevelMap pi can cycle', () => {
    const [grok] = toPiModels([{ id: 'grok-4.6', reasoningEfforts: ['low', 'high'] }])
    assert.equal(grok.reasoning, true)
    assert.deepEqual(grok.thinkingLevelMap, {
      low: 'low',
      medium: null,
      high: 'high',
      minimal: null,
      xhigh: null,
      max: null,
    })
    assert.equal('off' in grok.thinkingLevelMap, false)
  })

  it('models without sendable efforts stay reasoning:false so the TUI does not fake a cycle', () => {
    const [echo] = toPiModels([{ id: 'mock-echo', reasoningEfforts: false }])
    assert.equal(echo.reasoning, false)
    assert.equal(echo.thinkingLevelMap, undefined)
    assert.equal(echo.compat.supportsReasoningEffort, undefined)
  })

  it('normalizeReasoningEfforts drops null off and unknown keys', () => {
    assert.deepEqual(normalizeReasoningEfforts({ off: null, high: 'high', max: 'max', bogus: 'x' }), {
      high: 'high',
      max: 'max',
    })
    assert.equal(normalizeReasoningEfforts(['low', 'high']).low, 'low')
    assert.equal(normalizeReasoningEfforts(false), null)
    assert.equal(thinkingLevelMap(null), undefined)
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

describe('peopleOptions', () => {
  const users = [
    { id: 'u1', username: 'emp-a', displayName: '员工A', department: '内容部', role: 'employee', online: true },
    { id: 'u2', username: 'boss', displayName: '老板', department: '管理层', role: 'admin', online: false },
  ]
  it('puts me first and restricts employees to self', () => {
    const emp = peopleOptions(users, users[0])
    assert.equal(emp.length, 1)
    assert.equal(emp[0].id, 'u1')
    assert.match(emp[0].label, /^我 ·/)
    const admin = peopleOptions(users, users[1])
    assert.equal(admin.length, 2)
    assert.equal(admin[0].id, 'u2')
    assert.equal(personIdFromChoice(admin[1].label, admin), 'u1')
  })
})

describe('task workflow', () => {
  const emp = { id: 'u1', username: 'emp-a', role: 'employee' }
  const boss = { id: 'u2', username: 'boss', role: 'admin' }
  const dir = { id: 'u3', username: 'dir', role: 'director' }
  const users = [
    { id: 'u1', username: 'emp-a', displayName: '员工A', role: 'employee' },
    { id: 'u2', username: 'boss', displayName: '老板', role: 'admin' },
    { id: 'u3', username: 'dir', displayName: '总监', role: 'director' },
  ]

  it('reviewerOptions drops employees and self', () => {
    const forEmp = reviewerOptions(users, emp)
    assert.deepEqual(forEmp.map((o) => o.id).sort(), ['u2', 'u3'])
    const forBoss = reviewerOptions(users, boss)
    assert.deepEqual(forBoss.map((o) => o.id), ['u3'])
  })

  it('canSubmit only draft/rejected by assignee or admin', () => {
    const draft = { status: 'draft', assigneeId: 'u1', deliverables: [{ name: 'a.md' }] }
    assert.equal(canSubmit(draft, emp), true)
    assert.equal(canSubmit(draft, dir), false)
    assert.equal(canSubmit(draft, boss), true)
    assert.equal(canSubmit({ ...draft, status: 'pending_review' }, emp), false)
    assert.equal(canSubmit({ ...draft, status: 'rejected' }, emp), true)
  })

  it('canReview / canFinalize match 四格', () => {
    const pending = { status: 'pending_review', reviewerId: 'u3', assigneeId: 'u1' }
    assert.equal(canReview(pending, dir), true)
    assert.equal(canReview(pending, emp), false)
    assert.equal(canReview(pending, boss), true)
    const fin = { status: 'pending_final', assignerId: 'u3', assigneeId: 'u1' }
    assert.equal(canFinalize(fin, boss), true)
    assert.equal(canFinalize(fin, dir), true)
    assert.equal(canFinalize(fin, emp), false)
  })

  it('workflowHint tells agent to submit, never that the channel cannot', () => {
    const empty = { status: 'draft', deliverables: [] }
    assert.match(workflowHint(empty), /company_task_attach/)
    assert.match(workflowHint({ status: 'draft', deliverables: [{ name: 'a' }], submission: 'done' }), /company_task_submit/)
    assert.equal(workflowHint(empty).includes('不能提交'), false)
    assert.match(workflowHint({ status: 'pending_review' }), /company_task_review/)
    assert.match(workflowHint({ status: 'pending_final' }), /company_task_final/)
    assert.equal(hasDeliverables({ deliverables: [] }), false)
    assert.equal(assertDecision('pass'), 'pass')
    assert.throws(() => assertDecision('ok'))
  })
})

describe('drive-paths', () => {
  it('maps zones and blocks path escape', () => {
    assert.equal(zoneRoot('personal', 'emp-a'), '_office/emp-a/_memory')
    assert.equal(zoneRoot('shared', 'emp-a'), '_shared/_memory')
    assert.equal(zoneRoot('handbook', 'x'), '_shared/handbook')
    assert.throws(() => zoneRoot('nope', 'x'))
    const root = path.join(os.tmpdir(), 'drive-root')
    const inside = assertInside(root, '_shared/handbook/a.md')
    assert.ok(inside.includes('handbook'))
    assert.throws(() => assertInside(root, path.join('..', '..', 'outside.txt')))
  })
})

describe('gatewayOptions', () => {
  const found = [
    { name: '本机', urls: ['http://127.0.0.1:8790'], source: 'http', needsSetup: false },
    { name: '树莓派', urls: ['http://10.56.41.60:8790', 'http://127.0.0.1:8790'], source: 'udp', needsSetup: true },
  ]

  it('dedupes urls and appends the manual fallback last', () => {
    const options = gatewayOptions(found)
    assert.deepEqual(
      options.map((o) => o.url),
      ['http://127.0.0.1:8790', 'http://10.56.41.60:8790', ''],
    )
    assert.equal(options.at(-1).label, MANUAL_GATEWAY_LABEL)
    assert.match(options[1].label, /待初始设置/)
    assert.equal(options[1].label.includes('[udp]'), false)
  })

  it('skips the manual row when asked, and can tag the source', () => {
    const options = gatewayOptions(found, { manual: '', withSource: true })
    assert.equal(options.length, 2)
    assert.match(options[0].label, /\[http\]/)
  })

  it('maps a selected label back to its url, empty for the fallback row', () => {
    const options = gatewayOptions(found)
    assert.equal(gatewayUrlFromChoice(options[1].label, options), 'http://10.56.41.60:8790')
    assert.equal(gatewayUrlFromChoice(MANUAL_GATEWAY_LABEL, options), '')
    assert.equal(gatewayUrlFromChoice(undefined, options), '')
  })

  it('suggestedGatewayUrl prefers the already-saved address, else the only find', () => {
    assert.equal(suggestedGatewayUrl(found, 'http://10.56.41.60:8790'), 'http://10.56.41.60:8790')
    assert.equal(suggestedGatewayUrl([found[0]], 'http://elsewhere:1'), 'http://127.0.0.1:8790')
    assert.equal(suggestedGatewayUrl(found, 'http://elsewhere:1'), 'http://elsewhere:1')
    assert.equal(suggestedGatewayUrl([], 'http://127.0.0.1:8790'), 'http://127.0.0.1:8790')
  })
})

describe('drive log sink', () => {
  it('routes messages to the installed sink; TUI can swallow them so they do not hit stdout', () => {
    const got = []
    setDriveLogSink((m) => got.push(m))
    driveLog('公司盘同步完成：256 个文件，下载 0 个')
    assert.deepEqual(got, ['公司盘同步完成：256 个文件，下载 0 个'])
    setDriveLogSink(() => {})
    driveLog('个人记忆回推 203 个文件')
    assert.deepEqual(got, ['公司盘同步完成：256 个文件，下载 0 个'])
    setDriveLogSink(null)
  })
})
