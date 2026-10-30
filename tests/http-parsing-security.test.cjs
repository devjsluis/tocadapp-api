const test = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const express = require('express');

// Exercise the upgraded production parser stack over loopback, without the
// application, credentials, database or any payment provider.
async function serverTest(run) {
  const app = express();
  app.post('/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    res.json({ raw: Buffer.isBuffer(req.body), body: req.body.toString('utf8') });
  });
  app.use(express.json());
  app.post('/verify', (req, res) => res.json(req.body));
  app.get('/health', (req, res) => res.json({ ok: true, ip: req.ip }));
  app.use((error, _req, res, _next) => res.status(error.status ?? 400).json({ error: 'invalid body' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await run(origin); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('patched compressed JSON parser survives trailing gzip bytes and remains available', async () => {
  await serverTest(async origin => {
    const body = Buffer.concat([gzipSync(Buffer.from('{"transactionId":"12345"}')), Buffer.from('trailing bytes')]);
    const response = await fetch(origin + '/verify', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Encoding': 'gzip',
    }, body });
    await response.text();
    assert.ok([200, 400].includes(response.status));
    await new Promise(resolve => setTimeout(resolve, 25));
    const health = await fetch(origin + '/health'); assert.equal(health.status, 200);
  });
});
test('parser updates preserve billing JSON bodies and exact Stripe webhook bytes', async () => {
  await serverTest(async origin => {
    const json = '{ "purchaseToken": "google-token", "transactionId": "12345" }';
    for (const route of ['/verify', '/stripe']) {
      const response = await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.deepEqual(value, route === '/stripe' ? { raw: true, body: json } : JSON.parse(json));
    }
  });
});
test('current proxy trust default does not accept forged X-Forwarded-For addresses', async () => {
  await serverTest(async origin => {
    const response = await fetch(origin + '/health', { headers: { 'X-Forwarded-For': '203.0.113.42' } });
    assert.notEqual((await response.json()).ip, '203.0.113.42');
  });
});
