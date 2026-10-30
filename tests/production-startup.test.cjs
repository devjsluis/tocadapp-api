const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('production app boots without Apple variables and preserves existing authenticated routes without network or DB access', () => {
  const source = String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const Module = require('node:module');
    const ts = require('typescript');
    const originalLoad = Module._load;
    let queries = 0;
    class IsolatedPool {
      async query(sql) {
        queries++;
        if (/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)) throw Error('Unexpected database mutation');
        if (sql.includes('FROM users')) return { rows: [{ id: 7, email: 'test@example.invalid', role: 'musician', session_version: 1 }], rowCount: 1 };
        if (sql.includes('google_play_billing_identities')) return { rows: [{ obfuscated_account_id: 'a'.repeat(32) }], rowCount: 1 };
        if (sql.includes('FROM subscriptions')) return { rows: [], rowCount: 0 };
        throw Error('Unexpected query in isolated production startup test');
      }
      connect() { throw Error('No database connections are allowed'); }
    }
    Module._load = function(name, parent, main) {
      if (name === 'pg') return { Pool: IsolatedPool };
      if (name === 'dotenv' || name === 'dotenv/config') throw Error('Do not load .env files');
      return originalLoad.call(this, name, parent, main);
    };
    require.extensions['.ts'] = function(module, filename) {
      const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
      }, fileName: filename }).outputText;
      module._compile(source, filename);
    };
    assert.equal(Object.keys(process.env).some(key => key.startsWith('APPLE_')), false);
    const app = require('./src/app.ts').default;
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 7, type: 'access', sessionVersion: 1 }, process.env.JWT_SECRET);
    const server = app.listen(0, '127.0.0.1');
    (async () => {
      await new Promise(resolve => server.once('listening', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port;
      async function request(route, method = 'GET', authenticated = false) {
        const headers = { 'Content-Type': 'application/json' };
        if (authenticated) headers.Authorization = 'Bearer ' + token;
        const result = await fetch(origin + route, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
        return { status: result.status, body: await result.json() };
      }
      assert.equal((await request('/health')).status, 200);
      assert.equal((await request('/')).status, 200);
      for (const route of ['/gigs', '/bands', '/expenses', '/subscriptions/me', '/subscriptions/apple/identity']) {
        assert.equal((await request(route)).status, 401, route);
      }
      const current = await request('/subscriptions/me', 'GET', true);
      assert.equal(current.status, 200); assert.deepEqual(current.body, { hasAccess: false, subscription: null });
      const google = await request('/subscriptions/google-play/identity', 'GET', true);
      assert.equal(google.status, 200); assert.equal(google.body.obfuscatedAccountId, 'a'.repeat(32));
      assert.equal(google.body.purchasePolicy.newPurchasesEnabled, true);
      assert.equal((await request('/subscriptions/google-play/verify', 'POST', true)).status, 400);
      assert.equal((await request('/subscriptions/checkout', 'POST', true)).status, 400);
      assert.equal((await request('/webhooks/stripe', 'POST')).status, 400);
      const before = queries;
      const apple = await request('/subscriptions/apple/identity', 'GET', true);
      assert.equal(apple.status, 503); assert.equal(apple.body.code, 'APPLE_SERVICE_UNAVAILABLE');
      assert.equal(queries, before + 1, 'only the existing auth query runs; Apple never touches its tables');
      const verify = await fetch(origin + '/subscriptions/apple/verify', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{"transactionId":"12345"}' });
      assert.equal(verify.status, 503); await verify.text();
      assert.equal((await request('/health')).status, 200);
      console.log('Production startup and route compatibility passed with Apple unconfigured.');
    })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
      server.close(() => process.exit(process.exitCode ?? 0));
      server.closeAllConnections();
    });
  `;
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
      NODE_ENV: 'production', JWT_SECRET: 'isolated-test-access-secret', JWT_REFRESH_SECRET: 'isolated-test-refresh-secret',
      STRIPE_SECRET_KEY: 'sk_test_isolated_no_network', DATABASE_URL: 'postgresql://invalid@127.0.0.1:1/not_used',
      GOOGLE_PLAY_NEW_PURCHASES_ENABLED: 'true' },
  });
  if (result.error) assert.fail(result.error.code + '\n' + result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Production startup and route compatibility passed/);
});
