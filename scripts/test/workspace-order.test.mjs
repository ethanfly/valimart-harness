import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinWorkspaceOrder } from '../../plugins/desk-host/lib/workspace-order.js'

/** 内核同款：insertBefore 同步返回、内部排队，后一次按调用瞬间的旧顺序计算。 */
function registry(ids) {
  let order = [...ids]
  let tail = Promise.resolve()
  return {
    list: () => order.map((id) => ({ id })),
    insertBefore(id, beforeId) {
      const seen = [...order]
      const job = tail.then(async () => {
        const without = order.filter((x) => x !== id)
        const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
        order = [...without.slice(0, at), id, ...without.slice(at)]
      })
      tail = job
      return job.then(() => seen)
    },
    order: () => order,
  }
}

test('个人、团队钉到最前，其余保持原顺序', async () => {
  const reg = registry(['new-a', 'personal', 'new-b', 'team'])
  await pinWorkspaceOrder(reg, ['personal', 'team'])
  assert.deepEqual(reg.order(), ['personal', 'team', 'new-a', 'new-b'])
})

test('已经在最前时不再移动', async () => {
  const reg = registry(['personal', 'team', 'other'])
  let calls = 0
  const orig = reg.insertBefore
  reg.insertBefore = (...args) => { calls++; return orig(...args) }
  await pinWorkspaceOrder(reg, ['personal', 'team'])
  assert.equal(calls, 0)
  assert.deepEqual(reg.order(), ['personal', 'team', 'other'])
})

test('缺一个钉住目标时跳过，不把另一个插错', async () => {
  const reg = registry(['other', 'team'])
  await pinWorkspaceOrder(reg, ['personal', 'team'])
  assert.deepEqual(reg.order(), ['team', 'other'])
})
