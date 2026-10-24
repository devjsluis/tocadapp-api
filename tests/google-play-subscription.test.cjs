const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/google-play.cjs');

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
  assert.deepEqual(locks.map(call => call.args[0]), ['a-old', 'z-new', 'a-old', 'z-new']);
  // Both the entitlement transaction and the acknowledgement transaction lock in order.
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


test('expired purchase anchor cannot transfer an out-of-app resubscription to another account', async () => {
  const h = harness([{ ...oldRow, status: 'EXPIRED' }]); h.purchase('new');
  h.purchases.get('new').outOfAppPurchaseContext = { expiredPurchaseToken: 'old' };
  await assert.rejects(h.sync({ userId: 2, purchaseToken: 'new' }), { message: 'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED' });
  assert.deepEqual(h.rows(), [{ ...oldRow, status: 'EXPIRED' }]); assert.deepEqual(h.acknowledged, []);
});

test('unknown expired purchase anchor is not assigned to the authenticated caller', async () => {
  const h = harness(); h.purchase('new');
  h.purchases.get('new').outOfAppPurchaseContext = { expiredPurchaseToken: 'unseen' };
  await assert.rejects(h.sync({ userId: 1, purchaseToken: 'new' }), { message: 'GOOGLE_PLAY_LINKED_PURCHASE_OWNER_UNKNOWN' });
  assert.equal(h.rows().length, 0); assert.equal(h.owners().length, 0);
});

test('state is refreshed under token locks before entitlement writes', async () => {
  const h = harness([oldRow]); h.purchase('old');
  h.faults.beforeGet = async () => {
    if (h.getCalls.length === 2) h.purchases.get('old').subscriptionState = 'SUBSCRIPTION_STATE_ON_HOLD';
  };
  assert.equal((await h.sync({ userId: 1, purchaseToken: 'old' })).status, 'PAST_DUE');
  assert.equal(h.rows()[0].status, 'PAST_DUE'); assert.deepEqual(h.acknowledged, []);
});

test('changed ancestry while acquiring locks aborts instead of using an unlocked anchor', async () => {
  const h = harness([oldRow]); h.purchase('new', 'old');
  h.faults.beforeGet = async () => {
    if (h.getCalls.length === 2) h.purchases.get('new').linkedPurchaseToken = 'other';
  };
  await assert.rejects(h.sync({ userId: 1, purchaseToken: 'new' }), { message: 'GOOGLE_PLAY_PURCHASE_LINK_CHANGED' });
  assert.deepEqual(h.rows(), [oldRow]); assert.equal(h.owners().length, 1);
});
