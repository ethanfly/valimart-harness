/**
 * 模型输入模态：聊天模型默认可看图，生图/视频模型只收文本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferModelInput, resolveModelInput } from '../lib/model-input.mjs'
import { modelCatalog } from '../../server/src/config.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('inferModelInput：Grok / Claude / DeepSeek 聊天模型可看图，生图模型不行', () => {
  assert.deepEqual(inferModelInput('grok-4.6'), ['text', 'image'])
  assert.deepEqual(inferModelInput('claude-opus-4-6'), ['text', 'image'])
  assert.deepEqual(inferModelInput('deepseek-v4-flash-vision-exp'), ['text', 'image'])
  assert.deepEqual(inferModelInput('grok-imagine-image-2.0'), ['text'])
  assert.deepEqual(inferModelInput('grok-imagine-video-1.5'), ['text'])
  assert.deepEqual(inferModelInput('mock-echo'), ['text'])
})

test('resolveModelInput：显式 input / vision 优先于猜测', () => {
  assert.deepEqual(resolveModelInput({ id: 'grok-4.6', vision: false }), ['text'])
  assert.deepEqual(resolveModelInput({ id: 'grok-imagine-image-2.0', vision: true }), ['text', 'image'])
  assert.deepEqual(resolveModelInput({ id: 'custom', input: ['image'] }), ['text', 'image'])
  assert.deepEqual(resolveModelInput({ id: 'custom', input: ['text'] }), ['text'])
})

test('modelCatalog / desk-host 把 input 带给内核', () => {
  const cat = modelCatalog({
    upstreams: {
      grok: { id: 'grok', label: 'Grok', kind: 'openai-compatible', resolvedKey: 'x', models: [{ id: 'grok-4.6', name: 'Grok 4.6' }] },
      imagine: { id: 'xai', label: 'xAI', kind: 'openai-compatible', resolvedKey: 'x', models: [{ id: 'grok-imagine-image-2.0', name: 'Imagine' }] },
    },
  })
  assert.deepEqual(cat.find((m) => m.id === 'grok-4.6').input, ['text', 'image'])
  assert.equal(cat.find((m) => m.id === 'grok-4.6').vision, true)
  assert.deepEqual(cat.find((m) => m.id === 'grok-imagine-image-2.0').input, ['text'])
  assert.equal(cat.find((m) => m.id === 'grok-imagine-image-2.0').vision, false)
  const host = fs.readFileSync(path.join(repo, 'plugins/desk-host/lib/index.js'), 'utf8')
  assert.match(host, /resolveModelInput/)
  assert.match(host, /input: resolveModelInput/)
})

test('modelCatalog：跨上游重复 id 分流，两边都可选，上游仍用原 id', () => {
  const cat = modelCatalog({
    upstreams: {
      ethanapi: { id: 'custom-ethanapi', label: 'EthanApi', kind: 'openai-compatible', resolvedKey: 'x', models: [{ id: 'qwen3.8-27b', name: 'Qwen3.8 27b' }] },
      vllm: { id: 'custom-vllm', label: 'vllm', kind: 'openai-compatible', resolvedKey: 'x', models: [{ id: 'qwen3.8-27b', name: 'Qwen3.8 27b' }] },
    },
  })
  const first = cat.find((m) => m.provider === 'custom-ethanapi')
  const second = cat.find((m) => m.provider === 'custom-vllm')
  assert.equal(first.id, 'qwen3.8-27b')
  assert.equal(first.upstreamModel, 'qwen3.8-27b')
  assert.equal(second.id, 'qwen3.8-27b--custom-vllm')
  assert.equal(second.upstreamModel, 'qwen3.8-27b')
  assert.equal(second.name, 'Qwen3.8 27b')
  assert.notEqual(first.id, second.id)
})
