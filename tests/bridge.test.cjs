'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { BrowserBridge } = require('../electron/bridge.cjs');

function request(port, { method = 'GET', path = '/v1/ping', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('browser bridge accepts the extension and rejects web pages', async (t) => {
  const received = [];
  const bridge = new BrowserBridge({
    version: '9.9.9',
    getInfo: () => ({ captureExtensions: 'zip iso' }),
    onDownload: async (info) => { received.push(info); return { action: 'prompted' }; },
    onBatch: async (info) => ({ action: 'prompted', count: info.items.length }),
  });
  const port = 40000 + Math.floor(Math.random() * 20000);
  const state = await bridge.start(port);
  t.after(() => bridge.stop());
  assert.equal(state.status, 'running');
  const ext = { 'X-Raijin-Client': 'test', Origin: 'chrome-extension://abcdef' };

  const ping = await request(port, { headers: ext });
  assert.equal(ping.status, 200);
  assert.equal(ping.body.version, '9.9.9');
  assert.equal(ping.body.captureExtensions, 'zip iso');

  const ok = await request(port, { method: 'POST', path: '/v1/download', headers: { ...ext, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/a.zip', cookies: 'a=1', fileSize: 10 }) });
  assert.equal(ok.status, 200);
  assert.equal(received[0].url, 'https://example.com/a.zip');
  assert.equal(received[0].cookies, 'a=1');

  const batch = await request(port, { method: 'POST', path: '/v1/batch', headers: { ...ext, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ url: 'https://x.test/1.zip' }, { url: 'javascript:alert(1)' }] }) });
  assert.equal(batch.body.count, 1);

  assert.equal((await request(port, { headers: { 'X-Raijin-Client': 'x', Origin: 'https://evil.example' } })).status, 403, 'web origins are refused');
  assert.equal((await request(port, { headers: { Origin: 'chrome-extension://abc' } })).status, 403, 'missing client header is refused');
  assert.equal((await request(port, { method: 'OPTIONS', headers: ext })).status, 403, 'pre-flight is refused');
  assert.equal((await request(port, { headers: { ...ext, Host: 'attacker.example:80' } })).status, 403, 'DNS-rebinding host is refused');
  assert.equal((await request(port, { method: 'POST', path: '/v1/download', headers: { ...ext, 'Content-Type': 'text/plain' }, body: '{"url":"https://a/b"}' })).status, 415);
  assert.equal((await request(port, { method: 'POST', path: '/v1/download', headers: { ...ext, 'Content-Type': 'application/json' }, body: '{"url":"file:///etc/passwd"}' })).status, 400);
});
