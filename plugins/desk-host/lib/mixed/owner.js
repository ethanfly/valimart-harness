/**
 * Mixed owner 规则（T02）。
 *
 * ownerKey = f(gatewayInstanceId, userId, profileId) 的稳定摘要：
 * - 只用「实例 + 账号 + 本机 profile」三个稳定维度；不使用公司名称、显示名或仅 URL
 *   （公司名可改、显示名可改、URL 随端口/局域网变化，都会让同一台机器上的 run 换身份）。
 * - 同名公司不同实例 → gatewayInstanceId 不同 → ownerKey 不同（A 实例的 run 不出现在 B 实例）。
 *
 * ownerEpoch = 同一 (profile, gatewayInstanceId) 下账号变化的栅栏计数：
 * - 账号不变 → epoch 不变，run 继续有效；
 * - 账号变化（同 profile 换了登录人 / 实例换了账号绑定）→ epoch +1，
 *   旧 owner 的进行中 run 被 fence（停止派发，保留记录），新 owner 从零开始。
 *
 * 纯规则模块：状态持久化在 mixed-store（T03），fence 动作由 run 控制器消费（T04）。
 */
import crypto from 'node:crypto'

/** 规范化各维度后拼接：去首尾空白；空维度视为非法（返回 null 而不是生成 'undefined' 这类脏键）。 */
export function computeOwnerKey({ gatewayInstanceId, userId, profileId }) {
  const gi = String(gatewayInstanceId ?? '').trim()
  const uid = String(userId ?? '').trim()
  const pid = String(profileId ?? '').trim()
  if (!gi || !uid || !pid) return null
  return 'owner:' + crypto.createHash('sha256').update([gi, uid, pid].join('\u0000'), 'utf8').digest('hex')
}

/** 账号维度是否变化：实例或账号任一不同即变化（profileId 由存储侧保证不变，不参与判断）。 */
export function ownerIdentityChanged(prev, next) {
  if (!prev || !next) return true
  return prev.gatewayInstanceId !== next.gatewayInstanceId || prev.userId !== next.userId
}

/**
 * 计算新的 ownerEpoch：
 * @param prevEpoch 当前 profile 已持久化的 epoch（number，首次 0）
 * @param changed   ownerIdentityChanged 的结果
 * @returns {epoch: number, fenced: boolean}  changed → epoch+1 且 fenced（旧 owner 的 run 需停止派发）
 */
export function nextOwnerEpoch(prevEpoch, changed) {
  const base = Number.isSafeInteger(prevEpoch) && prevEpoch >= 0 ? prevEpoch : 0
  return changed ? { epoch: base + 1, fenced: true } : { epoch: base, fenced: false }
}

/**
 * 账号变化 fence 钩子（T02 交付物之一；T04 的 run 控制器在登录用户变化时调用）。
 * @param events 已持久化的活跃 run 摘要 [{runId, ownerKey, ownerEpoch, status}]
 * @returns 需要 fence 的 run 列表（旧 owner 或旧 epoch 且未终结）
 */
const TERMINAL = new Set(['succeeded', 'blocked', 'cancelled', 'failed'])
export function fenceStaleRuns(events, { ownerKey, ownerEpoch }) {
  return (events ?? []).filter((r) => {
    if (!r || TERMINAL.has(r.status)) return false
    return r.ownerKey !== ownerKey || r.ownerEpoch !== ownerEpoch
  })
}
