/**
 * 万相 / MiniMax / Seedance 的视频协议翻译与轮询（不打公网）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCreate, parsePoll, runVendorVideo, toVendorBody, videoVendor } from '../src/upstream-video.js'

test('videoVendor 按主机名识别三家，Grok 不进', () => {
  assert.equal(videoVendor({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-compatible' }), 'dashscope')
  assert.equal(videoVendor({ baseUrl: 'https://api.minimax.io/v1' }), 'minimax')
  assert.equal(videoVendor({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }), 'volcengine')
  assert.equal(videoVendor({ baseUrl: 'https://api.x.ai/v1' }), '')
  assert.equal(videoVendor({ api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }), '')
})

test('toVendorBody：万相多参考图、海螺首帧、Seedance content', () => {
  const wan = toVendorBody('dashscope', { prompt: '猫', duration: 5, aspect_ratio: '9:16', images: ['aaa', 'bbb'] }, 'wan2.6-r2v')
  assert.equal(wan.model, 'wan2.6-r2v')
  assert.deepEqual(wan.input.reference_urls, ['data:image/png;base64,aaa', 'data:image/png;base64,bbb'])
  assert.equal(wan.parameters.size, '720*1280')

  const mini = toVendorBody('minimax', { prompt: '猫', image: 'ccc', duration: 6 }, 'MiniMax-Hailuo-02')
  assert.equal(mini.first_frame_image, 'data:image/png;base64,ccc')
  assert.equal(mini.duration, 6)

  const seed = toVendorBody('volcengine', { prompt: '猫', images: ['http://img/a.png'], duration: 8, aspect_ratio: '1:1' }, 'doubao-seedance-1-0-pro')
  assert.equal(seed.content[0].type, 'text')
  assert.equal(seed.content[1].image_url.url, 'http://img/a.png')
  assert.equal(seed.ratio, '1:1')
})

test('parseCreate / parsePoll 归一三家状态', () => {
  assert.equal(parseCreate('dashscope', { output: { task_id: 't1', task_status: 'PENDING' } }).id, 't1')
  assert.equal(parsePoll('dashscope', { output: { task_status: 'SUCCEEDED', video_url: 'https://v/a.mp4' } }).status, 'succeeded')
  assert.equal(parsePoll('dashscope', { output: { task_status: 'FAILED' }, message: 'boom' }).status, 'failed')
  assert.equal(parsePoll('minimax', { status: 'Success', file_id: 'f1' }).fileId, 'f1')
  assert.equal(parsePoll('volcengine', { status: 'running' }).status, 'pending')
  assert.equal(parseCreate('minimax', { base_resp: { status_code: 1004, status_msg: '没额度' } }).status, 'failed')
})

test('runVendorVideo：提交、轮询、MiniMax 取下载地址', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.endsWith('/video_generation')) return json(200, { task_id: 'task-9' })
    if (url.includes('/query/')) return json(200, { status: 'Success', file_id: 'file-9' })
    return json(200, { file: { download_url: 'https://cdn.example/hailuo.mp4' } })
  }
  const res = await runVendorVideo(
    { baseUrl: 'https://api.minimax.io/v1', resolvedKey: 'k' },
    { prompt: '猫', duration: 6 },
    { id: 'MiniMax-Hailuo-02' },
    { fetchImpl, sleep: async () => {}, now: () => 0 },
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.data[0].url, 'https://cdn.example/hailuo.mp4')
  assert.equal(seen.length, 3)
  assert.match(seen[1], /task_id=task-9/)
})

test('runVendorVideo：万相一次轮询成功', async () => {
  let n = 0
  const fetchImpl = async (url, init) => {
    n += 1
    if (init?.method === 'POST') {
      assert.equal(init.headers['x-dashscope-async'], 'enable')
      return json(200, { output: { task_id: 'w1', task_status: 'PENDING' } })
    }
    assert.match(url, /\/tasks\/w1$/)
    return json(200, { output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example/wan.mp4' } })
  }
  const res = await runVendorVideo(
    { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', resolvedKey: 'k', api: 'openai-compatible' },
    { prompt: '雨', duration: 5, aspect_ratio: '16:9' },
    { id: 'wan2.6-t2v' },
    { fetchImpl, sleep: async () => {}, now: () => 0 },
  )
  assert.equal((await res.json()).data[0].url, 'https://cdn.example/wan.mp4')
  assert.equal(n, 2)
})

function json(status, payload) {
  return { ok: status < 400, status, text: async () => JSON.stringify(payload), json: async () => payload }
}
