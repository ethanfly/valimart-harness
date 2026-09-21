/**
 * Persistent /goal loop: keep taking agent turns until the condition holds or is cleared.
 */
import fs from 'node:fs'
import path from 'node:path'

export function workspaceGoalCheck(workspaceRoot, condition) {
  const text = String(condition ?? '')
  const m =
    /(?:file|path)\s+[「"'`]?([^\s"'`]+)/i.exec(text) ||
    /([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)\s+exists/i.exec(text)
  if (!m || !workspaceRoot) return false
  const rel = m[1]
  const abs = path.resolve(workspaceRoot, rel)
  const root = path.resolve(workspaceRoot)
  const relToRoot = path.relative(root, abs)
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return false
  return fs.existsSync(abs)
}

export async function runUntilGoal({
  getGoal,
  sendTurn,
  check,
  maxRounds = 12,
  onEvent,
} = {}) {
  if (typeof sendTurn !== 'function') throw new Error('runUntilGoal requires sendTurn')
  if (typeof check !== 'function') throw new Error('runUntilGoal requires check')
  for (let i = 0; i < maxRounds; i++) {
    const goal = getGoal?.()
    if (!goal || goal.cleared) return { stopped: 'cleared', rounds: i, goal }
    const condition = goal.condition
    if (await check(condition)) {
      return { stopped: 'condition_held', rounds: i, condition, goal }
    }
    onEvent?.({ type: 'goal-turn', round: i, condition })
    const prompt =
      i === 0
        ? `Work until this goal holds: ${condition}`
        : `Goal not yet satisfied: ${condition}. Continue.`
    await sendTurn(prompt)
    if (await check(condition)) {
      return { stopped: 'condition_held', rounds: i + 1, condition, goal }
    }
  }
  return { stopped: 'max_rounds', rounds: maxRounds, goal: getGoal?.() }
}
