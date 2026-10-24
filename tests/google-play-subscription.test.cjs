const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the actual service, replacing only Google and the database transport.
// This suite never loads credentials, opens a database, or makes HTTP requests.
function harness(initial = []) {
  let subscriptions = structuredClone(initial);
  let owners = initial.map(row => ({ purchase_token: row.token, user_id: row.user_id, replaced_by_token: null }));
  let snapshot;
  let nextId = 100;
  const calls = [];
  const acknowledged = [];
  const purchases = new Map();
  const rowResult = rows => ({ rows, rowCount: rows.length });
  const client = {
    async query(sql, args = []) {
      sql = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql, args });
      if (sql === 'BEGIN') { snapshot = structuredClone({ subscriptions, owners }); return rowResult([]); }
      if (sql === 'COMMIT') return rowResult([]);
      if (sql === 'ROLLBACK') { ({ subscriptions, owners } = snapshot); return rowResult([]); }
      if (sql.includes('pg_advisory_xact_lock')) return rowResult([]);
      if (sql.includes('FROM users')) return rowResult([{ id: args[0] }]);
      if (sql.includes('FROM google_play_purchase_tokens')) return rowResult(owners.filter(row => args[0].includes(row.purchase_token)).map(row => ({ ...row })));
      if (sql.includes('FROM plans')) return rowResult([{ id: '1', price_amount: 7900, currency: 'MXN' }]);
      if (sql.includes('SELECT id, user_id FROM subscriptions')) return rowResult(subscriptions.filter(row => row.token === args[0]).map(row => ({ ...row })));
      if (sql.startsWith('INSERT INTO google_play_purchase_tokens')) {
        if (!owners.some(row => row.purchase_token === args[0])) owners.push({ purchase_token: args[0], user_id: args[1], replaced_by_token: null });
        return rowResult([]);
      }
      if (sql.startsWith('UPDATE google_play_purchase_tokens')) {
        owners.filter(row => row.purchase_token === args[0] && row.user_id === args[2]).forEach(row => { row.replaced_by_token = args[1]; });
        return rowResult([]);
      }
      if (sql.startsWith('UPDATE subscriptions') && sql.includes("WHERE provider = 'GOOGLE_PLAY'")) {
        subscriptions.filter(row => row.token === args[0] && row.user_id === args[1]).forEach(row => { row.status = 'EXPIRED'; });
        return rowResult([]);
      }
      if (sql.startsWith('UPDATE subscriptions') && sql.includes('AND NOT')) {
        subscriptions.filter(row => row.user_id === args[0] && row.token !== args[1] && ['ACTIVE', 'PENDING', 'PAST_DUE'].includes(row.status)).forEach(row => { row.status = 'EXPIRED'; });
        return rowResult([]);
      }
      if (sql.startsWith('SELECT id FROM subscriptions')) return rowResult(subscriptions.filter(row => row.user_id === args[0] && ['ACTIVE', 'PENDING', 'PAST_DUE'].includes(row.status)));
      if (sql.startsWith('UPDATE subscriptions')) {
        const row = subscriptions.find(row => Number(row.id) === args[9]);
        Object.assign(row, { status: args[1], end: args[5] });
        return rowResult([]);
      }
      if (sql.startsWith('INSERT INTO subscriptions')) {
        if (subscriptions.some(row => row.token === args[3])) throw new Error('duplicate token');
        if (['ACTIVE', 'PENDING', 'PAST_DUE'].includes(args[2]) && subscriptions.some(row => row.user_id === args[0] && ['ACTIVE', 'PENDING', 'PAST_DUE'].includes(row.status))) throw new Error('duplicate open subscription');
        const row = { id: String(nextId++), user_id: args[0], token: args[3], status: args[2], end: args[7] };
        subscriptions.push(row);
        return rowResult([{ id: row.id }]);
      }
      throw new Error('Unexpected SQL: ' + sql);
    },
    release() {},
  };
  const google = {
    GOOGLE_PLAY_PACKAGE_NAME: 'com.tocadapp.mobile',
    GOOGLE_PLAY_PRODUCT_ID: 'tocadapp_premium',
    GOOGLE_PLAY_BASE_PLAN_TO_PLAN_CODE: { monthly: 'TOCADAPP_MONTHLY', yearly: 'TOCADAPP_YEARLY' },
    androidPublisher: { purchases: {
      subscriptionsv2: { get: async ({ token, packageName }) => {
        assert.equal(packageName, 'com.tocadapp.mobile');
        if (!purchases.has(token)) throw new Error('GOOGLE_REJECTED_TOKEN');
        return { data: purchases.get(token) };
      } },
      subscriptions: { acknowledge: async ({ token }) => { acknowledged.push(token); } },
    } },
  };
  const filename = path.resolve(__dirname, '../src/services/googlePlaySubscription.service.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = name => {
    if (name === '../lib/googlePlay') return google;
    if (name === '../lib/db') return { pool: { connect: async () => client } };
    throw new Error('Unexpected dependency: ' + name);
  };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { Date })(localRequire, module, module.exports);
  function purchase(token, linkedPurchaseToken, state = 'ACTIVE') {
    purchases.set(token, {
      subscriptionState: 'SUBSCRIPTION_STATE_' + state,
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      startTime: '2025-01-01T00:00:00Z',
      linkedPurchaseToken,
      lineItems: [{ productId: 'tocadapp_premium', offerDetails: { basePlanId: 'monthly' }, expiryTime: '2099-01-01T00:00:00Z', autoRenewingPlan: { autoRenewEnabled: true } }],
    });
  }
  return { sync: module.exports.syncGooglePlaySubscription, purchase, purchases, calls, acknowledged,
    rows: () => subscriptions, owners: () => owners };
}
const oldRow = { id: '1', user_id: 1, token: 'old', status: 'ACTIVE' };

test('same owner replaces old token atomically and acknowledges new purchase', async () => {
  const h = harness([oldRow]); h.purchase('new', 'old');
  const result = await h.sync({ userId: 1, purchaseToken: 'new' });
  assert.equal(result.status, 'ACTIVE');
  assert.equal(h.rows().find(row => row.token === 'old').status, 'EXPIRED');
  assert.equal(h.rows().filter(row => row.status === 'ACTIVE').length, 1);
  assert.equal(h.owners().find(row => row.purchase_token === 'old').replaced_by_token, 'new');
  assert.deepEqual(h.acknowledged, ['new']);
  assert.ok(h.calls.findIndex(call => call.sql === 'COMMIT') > h.calls.findIndex(call => call.sql.startsWith('UPDATE google_play_purchase_tokens')));
});

test('different owner cannot claim a linked purchase and does not acknowledge', async () => {
  const h = harness([oldRow]); h.purchase('new', 'old');
  await assert.rejects(h.sync({ userId: 2, purchaseToken: 'new' }), { message: 'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED' });
  assert.deepEqual(h.rows(), [oldRow]); assert.equal(h.owners().length, 1);
  assert.deepEqual(h.acknowledged, []); assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
});

for (const state of ['ACTIVE', 'CANCELED', 'IN_GRACE_PERIOD', 'EXPIRED']) {
  test('late old-token ' + state + ' cannot change the successor or reactivate access', async () => {
    const h = harness([oldRow]); h.purchase('new', 'old');
    await h.sync({ userId: 1, purchaseToken: 'new' });
    h.purchase('old', undefined, state);
    const before = structuredClone(h.rows());
    assert.equal((await h.sync({ userId: 1, purchaseToken: 'old' })).status, 'EXPIRED');
    assert.deepEqual(h.rows(), before); assert.deepEqual(h.acknowledged, ['new']);
  });
}

test('unseen predecessor is rejected without reserving either token', async () => {
  const h = harness(); h.purchase('new', 'old');
  await assert.rejects(h.sync({ userId: 1, purchaseToken: 'new' }), { message: 'GOOGLE_PLAY_LINKED_PURCHASE_OWNER_UNKNOWN' });
  assert.equal(h.rows().length, 0); assert.equal(h.owners().length, 0);
  assert.deepEqual(h.acknowledged, []);
});


test('replacement chain and duplicate events never revive an ancestor', async () => {
  const h = harness([oldRow]); h.purchase('new', 'old'); h.purchase('newest', 'new');
  await h.sync({ userId: 1, purchaseToken: 'new' });
  await h.sync({ userId: 1, purchaseToken: 'newest' });
  await h.sync({ userId: 1, purchaseToken: 'newest' });
  await h.sync({ userId: 1, purchaseToken: 'new' }); h.purchase('old');
  await h.sync({ userId: 1, purchaseToken: 'old' });
  assert.deepEqual(h.rows().filter(row => row.status === 'ACTIVE').map(row => row.token), ['newest']);
});

test('a competing successor cannot replace a token already replaced', async () => {
  const h = harness([oldRow]); h.purchase('new', 'old'); h.purchase('other', 'old');
  await h.sync({ userId: 1, purchaseToken: 'new' });
  await assert.rejects(h.sync({ userId: 1, purchaseToken: 'other' }), { message: 'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED' });
  assert.equal(h.rows().length, 2);
});

test('initial purchase, renewal and duplicate processing keep a single token row', async () => {
  const h = harness(); h.purchase('initial');
  await h.sync({ userId: 1, purchaseToken: 'initial' });
  h.purchases.get('initial').acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  await h.sync({ userId: 1, purchaseToken: 'initial' });
  assert.equal(h.rows().length, 1); assert.deepEqual(h.acknowledged, ['initial']);
  await assert.rejects(h.sync({ userId: 2, purchaseToken: 'initial' }), { message: 'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED' });
});

test('Google rejection or invalid product cannot mutate ownership', async () => {
  const h = harness([oldRow]);
  await assert.rejects(h.sync({ userId: 1, purchaseToken: 'invalid' }), { message: 'GOOGLE_REJECTED_TOKEN' });
  h.purchase('new', 'old'); h.purchases.get('new').lineItems[0].productId = 'wrong';
  await assert.rejects(h.sync({ userId: 1, purchaseToken: 'new' }), { message: 'GOOGLE_PLAY_INVALID_PRODUCT' });
  assert.deepEqual(h.rows(), [oldRow]); assert.equal(h.owners().length, 1); assert.equal(h.calls.length, 0);
});

test('failed insert rolls back predecessor retirement and token reservations', async () => {
  const h = harness([oldRow]); h.purchase('new', 'old');
  // Cause the test database transport to fail the final insert.
  const originalPush = Array.prototype.push;
  const failingCalls = h.calls;
  failingCalls.push = function(call) {
    if (call.sql.startsWith('INSERT INTO subscriptions')) throw new Error('DB_UNAVAILABLE');
    return originalPush.call(this, call);
  };
  await assert.rejects(h.sync({ userId: 1, purchaseToken: 'new' }), { message: 'DB_UNAVAILABLE' });
  assert.deepEqual(h.rows(), [oldRow]); assert.equal(h.owners().length, 1); assert.equal(h.owners()[0].replaced_by_token, null);
  assert.deepEqual(h.acknowledged, []);
});

test('token locks are ordered and acquired before the user lock', async () => {
  const h = harness([{ id: '1', user_id: 1, token: 'a-old', status: 'ACTIVE' }]); h.purchase('z-new', 'a-old'); await h.sync({ userId: 1, purchaseToken: 'z-new' });
  const locks = h.calls.filter(call => call.sql.includes('pg_advisory_xact_lock'));
  assert.deepEqual(locks.map(call => call.args[0]), ['a-old', 'z-new']);
  assert.ok(h.calls.indexOf(locks[1]) < h.calls.findIndex(call => call.sql.includes('FROM users')));
});

for (const state of ['ON_HOLD', 'PAUSED', 'EXPIRED']) {
  test('completed replacement in ' + state + ' retires the predecessor without granting active access', async () => {
    const h = harness([oldRow]); h.purchase('new', 'old', state);
    await h.sync({ userId: 1, purchaseToken: 'new' });
    assert.equal(h.rows().find(row => row.token === 'old').status, 'EXPIRED');
    assert.equal(h.rows().filter(row => row.status === 'ACTIVE').length, 0);
    h.purchase('old'); await h.sync({ userId: 1, purchaseToken: 'old' });
    assert.equal(h.rows().filter(row => row.status === 'ACTIVE').length, 0);
    assert.deepEqual(h.acknowledged, []);
  });
}

for (const state of ['PENDING', 'PENDING_PURCHASE_CANCELED']) {
  test(state + ' does not retire the paid predecessor', async () => {
    const h = harness([oldRow]); h.purchase('new', 'old', state);
    await h.sync({ userId: 1, purchaseToken: 'new' });
    assert.equal(h.rows().find(row => row.token === 'old').status, 'ACTIVE');
    assert.equal(h.owners().find(row => row.purchase_token === 'old').replaced_by_token, null);
    assert.deepEqual(h.acknowledged, []);
  });
}

test('an already claimed successor cannot bypass the predecessor owner check', async () => {
  const h = harness([oldRow, { id: '2', user_id: 2, token: 'new', status: 'ACTIVE' }]);
  h.purchase('new', 'old');
  await assert.rejects(h.sync({ userId: 2, purchaseToken: 'new' }), { message: 'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED' });
  assert.equal(h.rows().length, 2); assert.deepEqual(h.acknowledged, []);
});

test('disconnected fragments of a chain cannot acquire separate owners', async () => {
  const h = harness([oldRow]);
  h.purchase('middle', 'old'); h.purchase('latest', 'unseen-middle');
  await h.sync({ userId: 1, purchaseToken: 'middle' });
  await assert.rejects(h.sync({ userId: 2, purchaseToken: 'latest' }), { message: 'GOOGLE_PLAY_LINKED_PURCHASE_OWNER_UNKNOWN' });
  assert.deepEqual(h.rows().filter(row => row.status === 'ACTIVE').map(row => row.user_id), [1]);
  assert.ok(h.owners().every(row => row.user_id === 1));
});
