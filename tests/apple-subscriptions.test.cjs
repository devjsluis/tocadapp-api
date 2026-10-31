const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`)(name => {
    if (name in mocks) return mocks[name];
    throw Error('Unexpected dependency: ' + name);
  }, module, module.exports);
  return module.exports;
}
const original = '100001';
const token = '11111111-1111-4111-8111-111111111111';
const SIGNED = 'header.' + Buffer.from(JSON.stringify({ data: { environment: 'Sandbox' } })).toString('base64url') + '.signature';
const tx = () => ({ transactionId: '100002', originalTransactionId: original, appAccountToken: token,
  bundleId: 'com.tocadapp.mobile', environment: 'Sandbox', type: 'Auto-Renewable Subscription',
  inAppOwnershipType: 'PURCHASED', productId: 'com.tocadapp.mobile.premium.monthly',
  purchaseDate: Date.now() - 60_000, expiresDate: Date.now() + 3_600_000, price: 79000, currency: 'MXN' });
function setup(options = {}) {
  const submitted = { ...tx(), ...options.submitted };
  const latest = { ...submitted, ...options.latest };
  const renewal = { originalTransactionId: original, autoRenewStatus: 1, ...options.renewal };
  const calls = [];
  const db = { async query(sql, args = []) {
    sql = sql.replace(/\s+/g, ' ').trim(); calls.push([sql, args]);
    let rows = [];
    if (sql.includes('JOIN users')) rows = options.ownerMissing ? [] : [{ user_id: options.owner ?? 7 }];
    else if (sql.startsWith('SELECT user_id FROM apple_subscription_chains')) rows = options.chainOwner ? [{ user_id: options.chainOwner }] : [];
    else if (sql.startsWith('SELECT id, deleted_at FROM users')) rows = options.accountDeletedDuringLock ? [{ deleted_at: new Date() }] : [{ deleted_at: null }];
    else if (sql.includes('FROM plans')) rows = options.noPlan ? [] : [{ id: '1', price_amount: 7900, currency: 'MXN' }];
    else if (sql.startsWith('SELECT id, user_id FROM subscriptions')) rows = options.existing ?? [];
    else if (sql.startsWith('SELECT id, provider, current_period_end')) rows = options.open ?? [];
    if (options.failCommit && sql === 'COMMIT') throw Error('commit failed');
    return { rows, rowCount: rows.length };
  }, release() { calls.push(['RELEASE']); } };
  const apple = {
    appleEnvironment: () => 'Sandbox',
    APPLE_PRODUCTS: { 'com.tocadapp.mobile.premium.monthly': 'TOCADAPP_MONTHLY', 'com.tocadapp.mobile.premium.yearly': 'TOCADAPP_YEARLY' },
    appleStore: () => ({ client: {
      async getTransactionInfo(id) { calls.push(['APPLE_TRANSACTION', id]); return { signedTransactionInfo: 'submitted' }; },
      async getAllSubscriptionStatuses(id) { calls.push(['APPLE_STATUS', id]); return { data: [{ lastTransactions: options.empty ? [] : [{
        originalTransactionId: original, status: options.status ?? 1, signedTransactionInfo: 'latest', signedRenewalInfo: 'renewal',
      }] }] }; },
    }, verifier: {
      async verifyAndDecodeTransaction(jws) { if (options.invalidSignature) throw Error('bad signature'); return jws === 'submitted' ? submitted : latest; },
      async verifyAndDecodeRenewalInfo() { return renewal; },
    } }),
  };
  const service = load('services/appleSubscription.service.ts', {
    'node:crypto': require('node:crypto'), '../lib/db': { pool: { connect: async () => db } }, '../lib/apple': apple,
    './subscriptions.service': { getCurrentSubscriptionByUserId: async () => null, subscriptionGrantsAccess: () => false },
  });
  return { service, calls, submitted, latest, renewal };
}
test('signed Apple ownership and authoritative latest status persist before successful verification', async () => {
  const h = setup({ latest: { transactionId: '100003' } });
  const result = await h.service.syncAppleSubscription('100002', 7);
  assert.equal(result.purchaseResult.persisted, true); assert.equal(result.purchaseResult.transactionId, '100002');
  assert.equal(result.purchaseResult.state, 'ACTIVE');
  const saved = h.calls.find(([sql]) => sql.startsWith('INSERT INTO subscriptions'));
  assert.equal(saved[1][2], 'Sandbox:100001'); assert.equal(saved[1][4], 7900);
  const chain = h.calls.find(([sql]) => sql.startsWith('INSERT INTO apple_subscription_chains'));
  assert.equal(chain[1][3], '100003');
  assert.ok(h.calls.findIndex(([sql]) => sql.includes('pg_advisory_xact_lock')) < h.calls.findIndex(([sql]) => sql === 'APPLE_STATUS'));
  assert.equal(h.calls.at(-2)[0], 'COMMIT'); assert.equal(h.calls.at(-1)[0], 'RELEASE');
});
for (const options of [{ accountDeletedDuringLock: true }, { owner: 8 }, { chainOwner: 8 }, { ownerMissing: true }, { existing: [{ id: '3', user_id: 8 }] }]) {
  test('cross-account or unverifiable ownership rolls back without writing entitlement: ' + JSON.stringify(options), async () => {
    const h = setup(options);
    await assert.rejects(h.service.syncAppleSubscription('100002', 7), /APPLE_PURCHASE_ACCOUNT_CONFLICT/);
    assert.equal(h.calls.some(([sql]) => sql.startsWith('INSERT INTO subscriptions')), false);
    assert.ok(h.calls.some(([sql]) => sql === 'ROLLBACK'));
  });
}
for (const options of [{ submitted: { bundleId: 'other.app' } }, { submitted: { environment: 'Production' } },
  { submitted: { productId: 'fake' } }, { submitted: { appAccountToken: undefined } },
  { submitted: { inAppOwnershipType: 'FAMILY_SHARED' } }, { invalidSignature: true },
  { latest: { originalTransactionId: 'wrong' } }, { renewal: { originalTransactionId: 'wrong' } }, { empty: true }]) {
  test('untrusted or inconsistent Apple data cannot grant access: ' + JSON.stringify(options), async () => {
    const h = setup(options); await assert.rejects(h.service.syncAppleSubscription('100002', 7));
    assert.equal(h.calls.some(([sql]) => sql.startsWith('INSERT INTO subscriptions')), false);
  });
}
test('canceling automatic renewal preserves the paid period; grace grants access only until its end', () => {
  const h = setup();
  assert.equal(h.service.appleEntitlement(h.latest, { autoRenewStatus: 0 }, 1).status, 'ACTIVE');
  assert.equal(h.service.appleEntitlement(h.latest, { autoRenewStatus: 0 }, 1).cancelAtPeriodEnd, true);
  const expired = { ...h.latest, expiresDate: Date.now() - 1000 };
  const grace = { gracePeriodExpiresDate: Date.now() + 10000 };
  assert.equal(h.service.appleEntitlement(expired, grace, 4).status, 'ACTIVE');
  assert.equal(h.service.appleEntitlement(expired, grace, 3).status, 'EXPIRED');
  for (const status of [2, 3, 5]) assert.equal(h.service.appleEntitlement(h.latest, h.renewal, status).status, 'EXPIRED');
  assert.equal(h.service.appleEntitlement({ ...h.latest, revocationDate: Date.now() }, h.renewal, 1).status, 'EXPIRED');
  assert.equal(h.service.appleEntitlement({ ...h.latest, isUpgraded: true }, h.renewal, 1).status, 'EXPIRED');
});
test('an inactive restore cannot expire or replace an unrelated open subscription', async () => {
  const h = setup({ status: 5, open: [{ id: '8', provider: 'GOOGLE_PLAY', current_period_end: new Date(Date.now() + 100000) }] });
  const result = await h.service.syncAppleSubscription('100002', 7);
  assert.equal(result.purchaseResult.state, 'INACTIVE');
  assert.equal(h.calls.some(([sql]) => sql.startsWith('INSERT INTO subscriptions') || sql.startsWith('UPDATE subscriptions')), false);
});
test('an active subscription in another paid store blocks a conflicting Apple activation', async () => {
  const h = setup({ open: [{ id: '8', provider: 'GOOGLE_PLAY', current_period_end: new Date(Date.now() + 100000) }] });
  await assert.rejects(h.service.syncAppleSubscription('100002', 7), /APPLE_OTHER_SUBSCRIPTION_ACTIVE/);
});
test('persistence failure cannot return successful verification', async () => {
  const h = setup({ failCommit: true }); await assert.rejects(h.service.syncAppleSubscription('100002', 7), /commit failed/);
});

function routes(options = {}) {
  const express = require('express');
  const calls = [];
  const exported = load('routes/appleSubscriptions.routes.ts', {
    express, 'express-rate-limit': () => (_req, _res, next) => next(),
    '@apple/app-store-server-library': { Environment: { SANDBOX: 'Sandbox', PRODUCTION: 'Production' } },
    '../middleware/auth': { authMiddleware(req, _res, next) { req.user = { id: 7 }; next(); } },
    '../lib/apple': { appleStore: () => ({ verifier: {
      async verifyAndDecodeNotification(payload) { calls.push(['SIGNATURE', payload]); if (options.badSignature) throw Error('bad signature'); return options.notification ?? { data: { signedTransactionInfo: 'tx' } }; },
      async verifyAndDecodeTransaction() { return { transactionId: '100002' }; },
    } }) },
    '../services/appleSubscription.service': {
      getAppleBillingIdentity: async id => ({ user: id }),
      syncAppleSubscription: async (...args) => { calls.push(['SYNC', ...args]); if (options.failSync) throw Error('database offline'); return { purchaseResult: { persisted: true } }; },
    },
    '../services/subscriptions.service': { getCurrentSubscriptionByUserId: async () => null, subscriptionGrantsAccess: () => false },
  });
  const app = express(); app.use(express.json());
  app.use('/subscriptions/apple', exported.appleSubscriptionsRouter); app.use('/webhooks/apple', exported.appleNotificationsRouter);
  return { app, calls };
}
async function request(h, route, body) {
  const server = h.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await response.text(); return response.status;
  } finally { await new Promise(resolve => server.close(resolve)); }
}
test('notification verifies signature before syncing, and a failed signature or database write requests redelivery', async () => {
  const h = routes(); assert.equal(await request(h, '/webhooks/apple', { signedPayload: SIGNED }), 200);
  assert.deepEqual(h.calls, [['SIGNATURE', SIGNED], ['SYNC', '100002', undefined, 'Sandbox']]);
  for (const options of [{ badSignature: true }, { failSync: true }]) {
    const failed = routes(options); assert.equal(await request(failed, '/webhooks/apple', { signedPayload: SIGNED }), 503);
    if (options.badSignature) assert.equal(failed.calls.length, 1);
  }
});
test('Apple test notifications acknowledge without altering subscriptions', async () => {
  const h = routes({ notification: { notificationType: 'TEST' } });
  assert.equal(await request(h, '/webhooks/apple', { signedPayload: SIGNED }), 200); assert.equal(h.calls.length, 1);
});
test('verify endpoint binds to authenticated account and rejects malformed transaction IDs', async () => {
  const h = routes();
  assert.equal(await request(h, '/subscriptions/apple/verify', { transactionId: 'fake', userId: 8 }), 400);
  assert.equal(await request(h, '/subscriptions/apple/verify', { transactionId: '100002', userId: 8 }), 200);
  assert.deepEqual(h.calls, [['SYNC', '100002', 7]]);
});

test('production routes only explicitly authorized review users into sandbox', () => {
  const oldEnvironment = process.env.APPLE_ENVIRONMENT;
  const oldReviewers = process.env.APPLE_SANDBOX_USER_IDS;
  try {
    const { appleEnvironment } = load('lib/apple.ts', { 'node:fs': require('node:fs'),
      '@apple/app-store-server-library': { Environment: { SANDBOX: 'Sandbox', PRODUCTION: 'Production' } } });
    process.env.APPLE_ENVIRONMENT = 'Production'; process.env.APPLE_SANDBOX_USER_IDS = '7, 12';
    assert.equal(appleEnvironment(7), 'Sandbox'); assert.equal(appleEnvironment(12), 'Sandbox');
    assert.equal(appleEnvironment(8), 'Production'); assert.equal(appleEnvironment(), 'Production');
    process.env.APPLE_ENVIRONMENT = 'Sandbox'; assert.equal(appleEnvironment(8), 'Sandbox');
    process.env.APPLE_ENVIRONMENT = 'Xcode'; assert.throws(() => appleEnvironment(7), /APPLE_NOT_CONFIGURED/);
  } finally {
    if (oldEnvironment === undefined) delete process.env.APPLE_ENVIRONMENT; else process.env.APPLE_ENVIRONMENT = oldEnvironment;
    if (oldReviewers === undefined) delete process.env.APPLE_SANDBOX_USER_IDS; else process.env.APPLE_SANDBOX_USER_IDS = oldReviewers;
  }
});


test('sandbox-only purchase flag never enables Production sales and active access stays blocked', () => {
  const { appleNewPurchasesEnabled: enabled } = setup().service;
  assert.equal(enabled('Sandbox',false,{}),false);
  assert.equal(enabled('Production',false,{APPLE_SANDBOX_NEW_PURCHASES_ENABLED:'true'}),false);
  assert.equal(enabled('Sandbox',false,{APPLE_SANDBOX_NEW_PURCHASES_ENABLED:'true'}),true);
  assert.equal(enabled('Production',false,{APPLE_NEW_PURCHASES_ENABLED:'true'}),true);
  for(const environment of ['Sandbox','Production']) {
    assert.equal(enabled(environment,true,{APPLE_NEW_PURCHASES_ENABLED:'true',APPLE_SANDBOX_NEW_PURCHASES_ENABLED:'true'}),false);
  }
  for(const flag of ['TRUE','1','yes','false']) {
    assert.equal(enabled('Sandbox',false,{APPLE_SANDBOX_NEW_PURCHASES_ENABLED:flag}),false);
  }
});

test('identity opens sandbox purchases only for server-allowlisted reviewers, preserving Production policy', async () => {
  const keys=['APPLE_ENVIRONMENT','APPLE_SANDBOX_USER_IDS','APPLE_NEW_PURCHASES_ENABLED','APPLE_SANDBOX_NEW_PURCHASES_ENABLED'];
  const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,{APPLE_ENVIRONMENT:'Production',APPLE_SANDBOX_USER_IDS:'7',
      APPLE_NEW_PURCHASES_ENABLED:'false',APPLE_SANDBOX_NEW_PURCHASES_ENABLED:'true'});
    const apple=load('lib/apple.ts',{'node:fs':require('node:fs'),
      '@apple/app-store-server-library':{Environment:{SANDBOX:'Sandbox',PRODUCTION:'Production'}}});
    apple.appleStore=()=>({});
    const service=load('services/appleSubscription.service.ts',{
      'node:crypto':require('node:crypto'),'../lib/apple':apple,
      '../lib/db':{pool:{query:async sql=>({rows:sql.includes('SELECT app_account_token')?[{app_account_token:token}]:[]})}},
      './subscriptions.service':{getCurrentSubscriptionByUserId:async()=>null,subscriptionGrantsAccess:()=>false},
    });
    const reviewer=await service.getAppleBillingIdentity(7);
    assert.equal(reviewer.environment,'Sandbox');assert.equal(reviewer.newPurchasesEnabled,true);
    const ordinary=await service.getAppleBillingIdentity(8);
    assert.equal(ordinary.environment,'Production');assert.equal(ordinary.newPurchasesEnabled,false);
  } finally {
    for(const key of keys) {if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
  }
});
