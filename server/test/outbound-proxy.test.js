import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { detectLocalProxy, proxyUrl } from '../src/outbound-proxy.js'

test('proxyUrl 优先环境变量，裸 host:port 补成 http', () => {
  const prev = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = '127.0.0.1:7897'
  try {
    assert.equal(proxyUrl(), 'http://127.0.0.1:7897')
    process.env.HTTPS_PROXY = 'http://10.0.0.1:8080'
    assert.equal(proxyUrl(), 'http://10.0.0.1:8080')
  } finally {
    if (prev == null) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = prev
  }
})

test('detectLocalProxy 找到正在监听的本地端口', async () => {
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  const prev = process.env.HTTPS_PROXY
  delete process.env.HTTPS_PROXY
  try {
    const seen = await detectLocalProxy()
    assert.equal(typeof seen, 'string')
    assert.equal(port > 0, true)
  } finally {
    if (prev == null) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = prev
    await new Promise((resolve) => srv.close(resolve))
  }
})
