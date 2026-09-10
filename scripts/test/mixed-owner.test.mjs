/**
 * Mixed owner 规则单元测试（T02）：ownerKey 稳定性、ownerEpoch 栅栏、fenceStaleRuns。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeOwnerKey,
  ownerIdentityChanged,
  nextOwnerEpoch,
  fenceStaleRuns,
} from '../../plugins/desk-host/lib/mixed/owner.js'

test('ownerKey：同输入稳定，维度顺序无关，任一维度变化即变化', () => {
  const a = computeOwnerKey({ gatewayInstanceId: 'gi-1', userId: 'u-1', profileId: 'p-1' })
  const b = computeOwnerKey({ gatewayInstanceId: 'gi-1', userId: 'u-1', profileId: 'p-1' })
  assert.equal(a, b)
  assert.match(a, /^owner:[0-9a-f]{64}$/)
  // 任一维度变化 → 不同键
  assert.notEqual(a, computeOwnerKey({ gatewayInstanceId: 'gi-2', userId: 'u-1', profileId: 'p-1' }))
  assert.notEqual(a, computeOwnerKey({ gatewayInstanceId: 'gi-1', userId: 'u-2', profileId: 'p-1' }))
  assert.notEqual(a, computeOwnerKey({ gatewayInstanceId: 'gi-1', userId: 'u-1', profileId: 'p-2' }))
})

test('ownerKey：不使用公司名称/显示名/URL——空维度返回 null（不生成脏键）', () => {
  assert.equal(computeOwnerKey({ gatewayInstanceId: '', userId: 'u', profileId: 'p' }), null)
  assert.equal(computeOwnerKey({ gatewayInstanceId: 'gi', userId: '  ', profileId: 'p' }), null)
  assert.equal(computeOwnerKey({ userId: 'u', profileId: 'p' }), null) // 缺 gatewayInstanceId
})

test('ownerKey：同名公司不同实例 → 不同键（实例维度隔离）', () => {
  const k1 = computeOwnerKey({ gatewayInstanceId: 'instance-A', userId: 'admin', profileId: 'prof' })
  const k2 = computeOwnerKey({ gatewayInstanceId: 'instance-B', userId: 'admin', profileId: 'prof' })
  assert.notEqual(k1, k2)
})

test('ownerIdentityChanged：实例或账号任一不同即变化；缺省视为变化', () => {
  assert.equal(ownerIdentityChanged({ gatewayInstanceId: 'gi', userId: 'u' }, { gatewayInstanceId: 'gi', userId: 'u' }), false)
  assert.equal(ownerIdentityChanged({ gatewayInstanceId: 'gi', userId: 'u' }, { gatewayInstanceId: 'gi', userId: 'v' }), true)
  assert.equal(ownerIdentityChanged({ gatewayInstanceId: 'gi', userId: 'u' }, { gatewayInstanceId: 'gj', userId: 'u' }), true)
  assert.equal(ownerIdentityChanged(null, { gatewayInstanceId: 'gi', userId: 'u' }), true)
  assert.equal(ownerIdentityChanged({ gatewayInstanceId: 'gi', userId: 'u' }, null), true)
})

test('nextOwnerEpoch：不变→同 epoch 不 fence；变化→epoch+1 且 fence', () => {
  assert.deepEqual(nextOwnerEpoch(0, false), { epoch: 0, fenced: false })
  assert.deepEqual(nextOwnerEpoch(5, false), { epoch: 5, fenced: false })
  assert.deepEqual(nextOwnerEpoch(5, true), { epoch: 6, fenced: true })
  assert.deepEqual(nextOwnerEpoch(undefined, true), { epoch: 1, fenced: true }) // 首次变化从 0→1
  assert.deepEqual(nextOwnerEpoch(-1, true), { epoch: 1, fenced: true }) // 非法 epoch 归 0 再 +1
})

test('fenceStaleRuns：只标记旧 owner/旧 epoch 且未终结的 run', () => {
  const runs = [
    { runId: 'current', ownerKey: 'ok-1', ownerEpoch: 2, status: 'executing' },
    { runId: 'old-owner', ownerKey: 'ok-0', ownerEpoch: 2, status: 'planning' },
    { runId: 'old-epoch', ownerKey: 'ok-1', ownerEpoch: 1, status: 'reviewing' },
    { runId: 'done', ownerKey: 'ok-0', ownerEpoch: 1, status: 'succeeded' },
    { runId: 'blocked', ownerKey: 'ok-0', ownerEpoch: 1, status: 'blocked' },
    { runId: 'cancelled', ownerKey: 'ok-0', ownerEpoch: 1, status: 'cancelled' },
    { runId: 'failed', ownerKey: 'ok-0', ownerEpoch: 1, status: 'failed' },
  ]
  const stale = fenceStaleRuns(runs, { ownerKey: 'ok-1', ownerEpoch: 2 })
  assert.deepEqual(stale.map((r) => r.runId).sort(), ['old-epoch', 'old-owner'])
})
