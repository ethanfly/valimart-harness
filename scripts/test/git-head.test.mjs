/**
 * 从工作区 .git/HEAD 读当前分支（不 spawn git）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGitBranch, gitBranchesForWorkspaces } from '../lib/git-head.mjs'

function makeRepo(headText, { gitfile = false, gitdirHead } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-git-head-'))
  if (gitfile) {
    const gitdir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-git-dir-'))
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitdir}\n`)
    fs.writeFileSync(path.join(gitdir, 'HEAD'), gitdirHead ?? headText)
    return { root, gitdir }
  }
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), headText)
  return { root }
}

test('readGitBranch：普通分支', () => {
  const { root } = makeRepo('ref: refs/heads/main\n')
  try {
    assert.equal(readGitBranch(root), 'main')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readGitBranch：带斜线的功能分支', () => {
  const { root } = makeRepo('ref: refs/heads/feat/lan-discover\n')
  try {
    assert.equal(readGitBranch(root), 'feat/lan-discover')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readGitBranch：detached HEAD 用短 hash', () => {
  const { root } = makeRepo('de2f8056abc123def4567890abcdef1234567890\n')
  try {
    assert.equal(readGitBranch(root), 'de2f805')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readGitBranch：gitfile worktree', () => {
  const { root, gitdir } = makeRepo('', { gitfile: true, gitdirHead: 'ref: refs/heads/release\n' })
  try {
    assert.equal(readGitBranch(root), 'release')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(gitdir, { recursive: true, force: true })
  }
})

test('readGitBranch：不是 git 仓库返回 null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-not-git-'))
  try {
    assert.equal(readGitBranch(root), null)
    assert.equal(readGitBranch(''), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('gitBranchesForWorkspaces：按工作区列出分支', () => {
  const { root } = makeRepo('ref: refs/heads/dev\n')
  try {
    const items = gitBranchesForWorkspaces([
      { id: 'w1', title: 'company-harness', path: root },
      { id: 'w2', title: '个人', path: path.join(root, 'missing') },
    ])
    assert.deepEqual(items, [
      { workspaceId: 'w1', title: 'company-harness', path: root, branch: 'dev' },
      { workspaceId: 'w2', title: '个人', path: path.join(root, 'missing'), branch: null },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
