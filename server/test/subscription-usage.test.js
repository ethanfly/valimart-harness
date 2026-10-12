import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queryOfficialSubscriptionUsage } from '../src/subscription-usage.js'

const mockFetch = (response, inspect = () => {}) => async (url, options) => {
  inspect(String(url), options)
  return Response.json(response)
}

test('ChatGPT：读取官方窗口并将已用百分比转换为剩余量', async () => {
  const result = await queryOfficialSubscriptionUsage({
    channelId: 'chatgpt',
    account: { credential: 'oauth-token', chatgptAccountId: 'acct-1' },
    fetchImpl: mockFetch({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 35, limit_window_seconds: 18000, reset_at: 1792000000 },
        secondary_window: { used_percent: 80, limit_window_seconds: 604800 },
      },
    }, (url, options) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage')
      assert.equal(options.headers.authorization, 'Bearer oauth-token')
      assert.equal(options.headers['chatgpt-account-id'], 'acct-1')
    }),
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.plan, 'plus')
  assert.equal(result.metrics[0].remainingPercent, 65)
  assert.equal(result.metrics[0].label, '5 小时窗口')
  assert.equal(result.metrics[1].remainingPercent, 20)
  assert.equal(result.metrics[1].label, '7 天窗口')
})

test('Claude：utilization 按官方百分比解析，保留多个限额窗口与恢复时间', async () => {
  const result = await queryOfficialSubscriptionUsage({
    channelId: 'claude',
    account: { credential: 'claude-token' },
    fetchImpl: mockFetch({
      five_hour: { utilization: 1, resets_at: '2026-10-12T12:00:00Z' },
      seven_day: { utilization: 63, resets_at: '2026-10-15T12:00:00Z' },
    }, (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer claude-token')
      assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20')
    }),
  })
  assert.equal(result.metrics[0].remainingPercent, 99)
  assert.equal(result.metrics[0].resetAt, '2026-10-12T12:00:00.000Z')
  assert.equal(result.metrics[1].remainingPercent, 37)
})

test('Claude：兼容 limits[].percent 且不把空字段当成满额', async () => {
  const result = await queryOfficialSubscriptionUsage({
    channelId: 'claude',
    account: { credential: 'claude-token' },
    fetchImpl: mockFetch({
      five_hour: { utilization: null },
      limits: [
        { kind: 'weekly_all', percent: 12.5, resets_at: '2026-10-20T12:00:00Z' },
        { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } } },
      ],
    }),
  })
  assert.equal(result.metrics.length, 2)
  assert.equal(result.metrics[0].remainingPercent, 87.5)
  assert.equal(result.metrics[1].label, 'weekly_scoped · Fable')
  assert.equal(result.metrics[1].remainingPercent, 100)
})

test('Grok：读取官方订阅与预付余额，账号令牌及用户 ID 只用于服务端请求', async () => {
  const result = await queryOfficialSubscriptionUsage({
    channelId: 'grok',
    account: { credential: 'grok-token', xaiUserId: 'user-1' },
    fetchImpl: mockFetch({
      subscriptionTier: 'supergrok',
      config: { creditUsagePercent: 27.5, currentPeriod: { type: 'weekly', end: 1792000000 }, prepaidBalance: { val: 1234 }, onDemandCap: {}, onDemandUsed: {} },
    }, (url, options) => {
      assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits')
      assert.equal(options.headers.authorization, 'Bearer grok-token')
      assert.equal(options.headers['x-userid'], 'user-1')
      assert.equal(options.headers['x-xai-token-auth'], 'xai-grok-cli')
    }),
  })
  assert.equal(result.plan, 'supergrok')
  assert.equal(result.metrics[0].remainingPercent, 72.5)
  assert.equal(result.metrics[1].detail, '$12.34 USD')
  assert.equal(result.metrics[2].detail, '$0.00 / $0.00 USD')
})

test('Gemini Code Assist：按已接入项目查询官方额度桶', async () => {
  const result = await queryOfficialSubscriptionUsage({
    channelId: 'gemini',
    account: { credential: 'google-token', googleProjectId: 'project-1' },
    fetchImpl: mockFetch({ buckets: [
      { modelId: 'gemini-pro', tokenType: 'REQUESTS', remainingFraction: 0.75, remainingAmount: '75', resetTime: '2026-10-13T12:00:00Z' },
    ] }, (url, options) => {
      assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota')
      assert.deepEqual(JSON.parse(options.body), { project: 'project-1' })
      assert.equal(options.headers.authorization, 'Bearer google-token')
    }),
  })
  assert.equal(result.metrics[0].remainingPercent, 75)
  assert.equal(result.metrics[0].detail, '剩余 75 次')
})

test('Antigravity：获取缺失项目后解析官方包装响应中的周额度', async () => {
  const calls = []
  const result = await queryOfficialSubscriptionUsage({
    channelId: 'antigravity',
    account: { credential: 'antigravity-token' },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      if (String(url).endsWith(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: { id: 'ag-project' } })
      return Response.json({ response: { groups: [{
        displayName: 'Gemini Models',
        buckets: [{ bucketId: 'gemini-weekly', displayName: 'Weekly Limit', window: 'weekly', remaining: { remainingFraction: 0.4 }, resetTime: '2026-10-19T12:00:00Z' }],
      }] } })
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')
  assert.equal(calls[1].url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary')
  assert.deepEqual(JSON.parse(calls[1].options.body), { project: 'ag-project' })
  assert.equal(calls[0].options.headers['user-agent'], 'antigravity')
  assert.equal(result.metrics[0].remainingPercent, 40)
  assert.equal(result.metrics[0].label, 'Gemini Models · Weekly Limit · weekly')
})

test('官方请求失败时不暴露令牌，也不伪造成功数据', async () => {
  await assert.rejects(queryOfficialSubscriptionUsage({
    channelId: 'claude',
    account: { credential: 'private-token' },
    fetchImpl: async () => Response.json({ error: { message: 'Bearer private-token expired' } }, { status: 401 }),
  }), /HTTP 401：Bearer \[redacted\] expired/)
})
