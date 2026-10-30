/**
 * 响应压缩与 httpKeepAlive 开关：跨网段安全设备会卡住大响应 / 丢弃闲置连接。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createGateway } from '../src/index.js'

async function withGateway(overrides, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-gzip-test-'))
  const gw = createGateway({ host: '127.0.0.1', port: 0, dataDir: tmp, upstreams: {}, fetchReleases: async () => [], ...overrides })
  const base = await gw.listen()
  try {
    await fn(base)
  } finally {
    await gw.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers, agent: false }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      .on('error', reject)
  })
}

test('管理页：声明 gzip 时压缩返回，解压后与原文一致；未声明时原样返回', async () => {
  await withGateway({}, async (base) => {
    const plain = await get(`${base}/admin`)
    assert.equal(plain.status, 200)
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(Number(plain.headers['content-length']), plain.body.length)

    const zipped = await get(`${base}/admin`, { 'accept-encoding': 'gzip, deflate, br' })
    assert.equal(zipped.status, 200)
    assert.equal(zipped.headers['content-encoding'], 'gzip')
    assert.match(zipped.headers.vary, /accept-encoding/i)
    assert.equal(Number(zipped.headers['content-length']), zipped.body.length)
    assert.ok(zipped.body.length < plain.body.length / 2)
    assert.deepEqual(zlib.gunzipSync(zipped.body), plain.body)
  })
})

test('小 JSON 不压缩', async () => {
  await withGateway({}, async (base) => {
    const r = await get(`${base}/api/setup`, { 'accept-encoding': 'gzip' })
    assert.equal(r.status, 200)
    assert.equal(r.headers['content-encoding'], undefined)
    assert.equal(typeof JSON.parse(r.body.toString('utf8')), 'object')
  })
})

test('httpKeepAlive: false 时响应带 Connection: close；默认保持连接', async () => {
  await withGateway({ httpKeepAlive: false }, async (base) => {
    const r = await get(`${base}/health`)
    assert.equal(r.headers.connection, 'close')
  })
  await withGateway({}, async (base) => {
    const r = await get(`${base}/health`, { connection: 'keep-alive' })
    assert.notEqual(r.headers.connection, 'close')
  })
})
