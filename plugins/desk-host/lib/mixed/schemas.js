/**
 * Mixed structured_output JSON schema（T08 生产装配）。
 *
 * 与 prompts.js 的输出契约一一对应；宿主事后仍逐条复核
 * （contracts.validatePlanGraph + service.#parsePlan + review.validateReviewOutput），
 * schema 只是让内核 structured_output 通道拿到合法形状。
 * additionalProperties: false 防止模型多嘴字段触发 ToolArgsError。
 */

export const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    interpretation: { type: 'string' },
    knownFacts: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    acceptance: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          checkable: { type: 'boolean' },
        },
        required: ['id', 'description', 'checkable'],
        additionalProperties: false,
      },
    },
    verificationMethods: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          title: { type: 'string' },
          goal: { type: 'string' },
          scope: { type: 'string' },
          dependsOnTaskIds: { type: 'array', items: { type: 'string' } },
          inputRefs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['text', 'attachment', 'mention'] },
                messageId: { type: 'string' },
              },
              required: ['kind', 'messageId'],
              additionalProperties: false,
            },
          },
          expectedOutputs: { type: 'array', items: { type: 'string' } },
          pathScope: { type: 'array', items: { type: 'string' } },
          acceptanceIds: { type: 'array', items: { type: 'string' } },
          verificationHints: { type: 'array', items: { type: 'string' } },
          role: { type: 'string' },
          status: { type: 'string' },
          attemptIds: { type: 'array', items: { type: 'string' } },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['taskId', 'title', 'goal', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['goal', 'acceptance', 'tasks'],
  additionalProperties: false,
}

export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes_requested', 'blocked'] },
    planVersion: { type: 'number' },
    evidenceManifestHash: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          acceptanceId: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'unverified'] },
          evidenceIds: { type: 'array', items: { type: 'string' } },
          // 必须与 store 记录 schema（contracts.reviewCriteriaSchema.explanation，必填 string）一致：
          // 曾误写 note（可选）→ 结构化输出永远缺 explanation → 审核轮回填写被 store zod 拒收
          // → 存储误判 unhealthy → run 冻结在 reviewing（真内核 v9–v12 五次确定性复现的根因）。
          explanation: { type: 'string' },
        },
        required: ['acceptanceId', 'status', 'evidenceIds', 'explanation'],
        additionalProperties: false,
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: { type: 'string' },
          taskIds: { type: 'array', items: { type: 'string' } },
          evidenceIds: { type: 'array', items: { type: 'string' } },
          // 与 store 记录 schema（contracts.reviewFindingSchema）一致：severity 只有
          // blocking/nonblocking（曾误写 minor/info → 非阻塞 finding 永远过不了 store 校验），
          // expected/actual/repairInstruction 均必填 string（store 侧无 description 字段，
          // 多嘴字段被 additionalProperties:false 挡住）。
          severity: { type: 'string', enum: ['blocking', 'nonblocking'] },
          expected: { type: 'string' },
          actual: { type: 'string' },
          repairInstruction: { type: 'string' },
        },
        required: ['findingId', 'taskIds', 'severity', 'expected', 'actual', 'repairInstruction'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['verdict', 'planVersion', 'evidenceManifestHash', 'criteria'],
  additionalProperties: false,
}
