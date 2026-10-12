import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 直接执行工作流中的清理脚本，验证删包范围和上传失败时的保护。
const workflow = fs.readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const block = workflow.split('      - name: Keep only the latest Windows client')[1]
const script = block.split('          script: |\n')[1].split('\n  npm-pi:')[0]
  .split('\n').map(line => line.replace(/^            /, '')).join('\n')
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('require', 'github', 'context', 'core', script)

async function run({ files = ['valimart-harness-Setup-new.exe'], uploaded = true } = {}) {
  const deleted = []
  const assets = [
    { id: 1, name: 'valimart-harness-Setup-old.exe', state: 'uploaded' },
    { id: 2, name: files[0], state: uploaded ? 'uploaded' : 'open' },
    { id: 3, name: 'valimart-harness-Gateway-Setup-0.1.0.exe', state: 'uploaded' },
    { id: 4, name: 'valimart-harness-0.3.1.vsix', state: 'uploaded' },
  ]
  const repos = {
    getReleaseByTag: async () => ({ data: { id: 10 } }),
    listReleaseAssets() {},
    deleteReleaseAsset: async ({ asset_id }) => deleted.push(['asset', asset_id]),
  }
  const actions = {
    listArtifactsForRepo() {},
    deleteArtifact: async ({ artifact_id }) => deleted.push(['artifact', artifact_id]),
  }
  const github = {
    rest: { repos, actions },
    paginate: async (method) => method === repos.listReleaseAssets ? assets : [
      { id: 5, name: 'windows-installers', workflow_run: { id: 99 } },
      { id: 6, name: 'windows-installers', workflow_run: { id: 100 } },
      { id: 7, name: 'windows-installers', workflow_run: { id: 101 } },
      { id: 8, name: 'vscode-vsix', workflow_run: { id: 99 } },
      { id: 9, name: 'windows-installers' },
    ],
  }
  try {
    await execute(() => ({ readdirSync: () => files }), github,
      { repo: { owner: 'test', repo: 'test' }, runId: 100 }, { info() {} })
    return { deleted }
  } catch (error) {
    return { deleted, error }
  }
}

test('发布成功只删旧客户端及更早 Windows 产物，保留其他附件和当前/更新运行', async () => {
  const { deleted, error } = await run()
  assert.equal(error, undefined)
  assert.deepEqual(deleted, [['asset', 1], ['artifact', 5]])
})

test('新客户端未完整上传时不删任何历史包', async () => {
  const { deleted, error } = await run({ uploaded: false })
  assert.match(error.message, /not uploaded/)
  assert.deepEqual(deleted, [])
})

test('缺少客户端或多个客户端时停止清理', async () => {
  for (const files of [[], ['valimart-harness-Setup-a.exe', 'valimart-harness-Setup-b.exe']]) {
    const { deleted, error } = await run({ files })
    assert.match(error.message, /Expected one client installer/)
    assert.deepEqual(deleted, [])
  }
})
