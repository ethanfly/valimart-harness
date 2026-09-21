/**
 * company-desk 任务卡 client (sessionToken).
 * 四格验收：提交验收 → 待审 → 待终审 → 通过|驳回。口头完成不算。
 */
export const TASK_STATUS_LABELS = {
  draft: '进行中',
  pending_review: '待审',
  pending_final: '待终审',
  approved: '通过',
  rejected: '驳回',
}

export const TASK_QUAD = ['提交验收', '待审', '待终审', '通过/驳回']
export const TASK_OVERVIEW_FIELDS = ['提交信息', '任务内容', '提交内容', '交付物']

export class TaskClient {
  constructor(client) {
    this.client = client
  }

  #token() {
    return this.client.store.data.sessionToken
  }

  #req(method, apiPath, body) {
    return this.client.request(method, apiPath, { token: this.#token(), body, timeoutMs: 60_000 })
  }

  list() {
    return this.#req('GET', '/api/tasks')
  }

  create(body) {
    return this.#req('POST', '/api/tasks', body)
  }

  get(id) {
    return this.#req('GET', `/api/tasks/${encodeURIComponent(id)}`)
  }

  update(id, patch) {
    return this.#req('PATCH', `/api/tasks/${encodeURIComponent(id)}`, patch)
  }

  bindSession(id, { sessionId, title, device } = {}) {
    return this.#req('POST', `/api/tasks/${encodeURIComponent(id)}/sessions`, { sessionId, title, device })
  }

  addDeliverables(id, files) {
    return this.#req('POST', `/api/tasks/${encodeURIComponent(id)}/deliverables`, { files })
  }

  submit(id, { reviewerId } = {}) {
    return this.#req('POST', `/api/tasks/${encodeURIComponent(id)}/submit`, { reviewerId })
  }

  review(id, { decision, comment } = {}) {
    return this.#req('POST', `/api/tasks/${encodeURIComponent(id)}/review`, { decision, comment })
  }

  final(id, { decision, comment } = {}) {
    return this.#req('POST', `/api/tasks/${encodeURIComponent(id)}/final`, { decision, comment })
  }

  people() {
    return this.#req('GET', '/api/people')
  }
}
