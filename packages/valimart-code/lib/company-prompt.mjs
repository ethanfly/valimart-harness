/**
 * 给 Agent 的公司上下文：登录身份、公司盘镜像分区、任务卡规则、当前绑定任务。
 * 与 pi 包 companyDrivePrompt、Claude 插件同一套口径；只读本机文件、不走网络（SessionStart hook 每次开会话 / /clear / 压缩后都会跑）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { assertInside } from './drive-paths.mjs'
import { defaultDriveDir, isLoggedIn, loadState } from './state.mjs'
import { workflowHint } from './task-workflow.mjs'

/** MCP initialize 里的 instructions：工具怎么配合用。身份和绑定任务走 SessionStart。 */
export const MCP_INSTRUCTIONS = [
  'valimart 公司网关工具（企业交付工作台）。',
  '开工前用 company_knowledge 问「公司里有没有人做过」；值得复用的做法、踩过的坑用 company_memory_write 写进记忆。',
  '任务卡不强制，也不要自动绑定。只有用户已经手动绑定后才走四格：company_task_attach 挂交付物 → company_task_update 写提交内容 → company_task_submit 选审核人提交验收 → company_task_review 初审 → company_task_final 终审。没绑定就按普通会话继续，不要提醒用户去挂。口头完成不算完成只对已绑定的任务卡生效。',
  '公司盘本机镜像由本服务每 30 秒自动同步，可以直接用普通文件工具读；要立刻同步用 company_drive_sync。',
].join('\n')

export function companyDrivePrompt(state = loadState()) {
  if (!isLoggedIn(state)) return ''
  const u = state.user
  const c = state.company
  const drive = state.driveDir || defaultDriveDir()
  const lines = [
    `## 企业交付工作台（${c?.name ?? '公司'}）`,
    `你在为 ${u.displayName || u.username}（账号 ${u.username}，${u.roleLabel ?? u.role ?? ''}，${u.department ?? ''}）工作，通过公司网关使用模型，用量按人记账。`,
    `公司盘本机镜像：${drive}（${state.lastSyncAt ? `上次同步 ${state.lastSyncAt}` : '尚未同步，desk MCP 服务启动后会自动同步'}）`,
    `- _shared/_memory/ 共享经验（全员只读；01-projects 项目、02-methods 方法、03-evidence 证据、04-reviews 复盘、05-logs 日志(追加)、90-system 系统/规定(追加)）`,
    `- _shared/handbook/ 岗位手册 / 公司技能手册：地图上的 how 已经是结论，有就按那条做，没有就说明没有。`,
    `- _office/${u.username}/_memory/ 你的个人记忆（跟人走）。值得复用的做法、踩过的坑，用 company_memory_write 写进去。`,
    `- projects/inbox/<任务ID>/ 任务交付物；每个任务目录里的 _task-card.md / _worklog.md 是任务卡与工作日志。`,
    `- 第四层是检索，不是知识库本身：开工前用 company_knowledge 问「公司里有没有人做过」，只拿到谁/何时/在哪，不拷贝别人的会话。`,
    `company_* 工具由 desk MCP 服务提供；工具没出现时让用户运行 /mcp 检查，镜像可用 /desk-sync 手动同步。`,
  ]
  const taskId = state.currentTaskId
  if (!taskId) {
    lines.push('任务卡不强制。用户没有手动绑定就不要提任务卡，不要要求绑定，也不要调用 company_task_*。')
    return lines.join('\n')
  }
  lines.push('规则：口头完成不算完成。交付必须是文件（company_task_attach）；结论写进提交内容（company_task_update）；过程记进工作日志（company_task_log）；交活用 company_task_submit 选审核人提交验收（进入待审）。初审 company_task_review，终审 company_task_final。不要让用户去桌面客户端点按钮。')
  let dir
  try {
    dir = assertInside(drive, `projects/inbox/${taskId}`)
  } catch {
    return lines.join('\n')
  }
  lines.push('', `当前绑定任务卡 ${taskId}。任务格子（本机目录）：${dir}`, `- 交付物写到这个目录，再用 company_task_attach 挂卡。`)
  try {
    const card = JSON.parse(fs.readFileSync(path.join(dir, '_task-card.json'), 'utf8'))
    lines.push(`- 下一步：${workflowHint(card)}`)
  } catch {
    /* 尚未同步 json */
  }
  try {
    lines.push('', fs.readFileSync(path.join(dir, '_task-card.md'), 'utf8'))
  } catch {
    /* 尚未同步 */
  }
  return lines.join('\n')
}
