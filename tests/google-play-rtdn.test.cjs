const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/google-play.cjs');
const old = { id: '1', user_id: 1, token: 'old', status: 'ACTIVE' };
const encode = (token, type = 4, extra = {}) => Buffer.from(JSON.stringify({
  packageName: 'com.tocadapp.mobile', eventTimeMillis: '100',
  subscriptionNotification: { purchaseToken: token, notificationType: type }, ...extra,
})).toString('base64');

test('new unassociated purchase is fetched from Google and durably deferred, never guessed', async () => {
  const h = harness(); h.purchase('new');
  h.purchases.get('new').externalAccountIdentifiers = { obfuscatedExternalAccountId: '1', externalAccountId: 'user@example.com' };
  const result = await h.process(encode('new'));
  assert.equal(result.kind, 'DEFERRED'); assert.equal(result.reason, 'GOOGLE_PLAY_BILLING_IDENTITY_UNKNOWN');
  assert.deepEqual(h.getCalls, ['new']); assert.equal(h.rows().length, 0); assert.equal(h.owners().length, 0);
  assert.equal(h.inbox().get('new').google_snapshot.externalAccountIdentifiers.obfuscatedExternalAccountId, '1');
  assert.deepEqual(h.acknowledged, []);
});

test('unknown token linked to a registered owner replaces and acknowledges safely', async () => {
  const h = harness([old]); h.purchase('new', 'old');
  const result = await h.process(encode('new'));
  assert.equal(result.kind, 'SUBSCRIPTION'); assert.equal(result.userId, 1);
  assert.equal(h.inbox().get('new').status, 'PROCESSED');
  assert.deepEqual(h.rows().filter(row => row.status === 'ACTIVE').map(row => row.token), ['new']);
  assert.deepEqual(h.acknowledged, ['new']);
});

test('out-of-app resubscription uses the verified expired token owner', async () => {
  const h = harness([{ ...old, status: 'EXPIRED' }]); h.purchase('new');
  h.purchases.get('new').outOfAppPurchaseContext = { expiredPurchaseToken: 'old', expiredExternalAccountIdentifiers: { obfuscatedExternalAccountId: 'a'.repeat(32) } };
  assert.equal((await h.process(encode('new'))).userId, 1);
  assert.equal(h.inbox().get('new').status, 'PROCESSED');
});

test('conflicting owners are deferred with no entitlement or acknowledgement changes', async () => {
  const h = harness([old, { id: '2', user_id: 2, token: 'new', status: 'ACTIVE' }]); h.purchase('new', 'old');
  assert.equal((await h.process(encode('new'))).reason, 'OWNER_CONFLICT');
  assert.deepEqual(h.rows().map(row => row.status), ['ACTIVE', 'ACTIVE']); assert.deepEqual(h.acknowledged, []);
});

test('unknown predecessor stays deferred even if current token has an owner', async () => {
  const h = harness([old]); h.purchase('old', 'unseen');
  assert.equal((await h.process(encode('old'))).reason, 'GOOGLE_PLAY_LINKED_PURCHASE_OWNER_UNKNOWN');
  assert.equal(h.owners().length, 1); assert.deepEqual(h.acknowledged, []);
});

test('pending purchase without dates is persisted without granting or acknowledging', async () => {
  const h = harness([old]); h.purchase('new', 'old', 'PENDING');
  delete h.purchases.get('new').startTime; delete h.purchases.get('new').lineItems[0].expiryTime;
  assert.equal((await h.process(encode('new'))).reason, 'PENDING_PURCHASE');
  assert.equal(h.inbox().get('new').status, 'DEFERRED'); assert.deepEqual(h.rows(), [old]);
  assert.deepEqual(h.acknowledged, []);
  h.purchase('new', 'old');
  assert.equal((await h.reconcile()).processed, 1);
});

test('duplicates update one inbox row and one subscription, without repeating completed acknowledgement', async () => {
  const h = harness([old]); h.purchase('new', 'old'); await h.process(encode('new'));
  h.purchases.get('new').acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  await h.process(encode('new')); assert.equal(h.inbox().size, 1); assert.equal(h.rows().length, 2);
  assert.deepEqual(h.acknowledged, ['new']);
});

test('delayed old notification cannot reactivate a replaced token', async () => {
  const h = harness([old]); h.purchase('new', 'old'); h.purchase('old');
  await h.process(encode('new')); await h.process(encode('old', 2, { eventTimeMillis: '1' }));
  assert.deepEqual(h.rows().filter(row => row.status === 'ACTIVE').map(row => row.token), ['new']);
});

test('out-of-order chain is reconciled after its missing predecessor is securely registered', async () => {
  const h = harness([old]); h.purchase('latest', 'middle'); h.purchase('middle', 'old');
  assert.equal((await h.process(encode('latest'))).kind, 'DEFERRED');
  await h.process(encode('middle')); assert.equal((await h.reconcile()).processed, 1);
  assert.deepEqual(h.rows().filter(row => row.status === 'ACTIVE').map(row => row.token), ['latest']);
});

test('an unassociated purchase can reconcile after authenticated verification registers its owner', async () => {
  const h = harness(); h.purchase('new'); await h.process(encode('new'));
  h.identify('new');
  await h.sync({ userId: 1, purchaseToken: 'new' });
  h.purchases.get('new').acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  assert.equal((await h.reconcile()).processed, 1);
  assert.equal(h.inbox().get('new').user_id, 1);
});

test('Google outage retains RETRY work, throws for HTTP retry, and recovers in a later batch', async () => {
  const h = harness([old]); h.purchase('new', 'old'); h.faults.google = Error('GOOGLE_TEMPORARILY_UNAVAILABLE');
  await assert.rejects(h.process(encode('new')), { message: 'GOOGLE_TEMPORARILY_UNAVAILABLE' });
  assert.equal(h.inbox().get('new').status, 'RETRY'); assert.deepEqual(h.rows(), [old]);
  assert.equal((await h.reconcile()).failed, 1);
  delete h.faults.google; assert.equal((await h.reconcile()).processed, 1);
});

test('acknowledgement failure remains retryable after the entitlement commit', async () => {
  const h = harness([old]); h.purchase('new', 'old'); h.faults.ack = Error('ACK_TIMEOUT');
  await assert.rejects(h.process(encode('new')), { message: 'ACK_TIMEOUT' });
  assert.equal(h.inbox().get('new').status, 'RETRY'); assert.equal(h.rows().length, 2);
  delete h.faults.ack; assert.equal((await h.reconcile()).processed, 1); assert.deepEqual(h.acknowledged, ['new']);
});

test('invalid product never creates ownership or access', async () => {
  const h = harness(); h.purchase('new'); h.purchases.get('new').lineItems[0].productId = 'wrong';
  await assert.rejects(h.process(encode('new')), { message: 'GOOGLE_PLAY_INVALID_PRODUCT' });
  assert.equal(h.rows().length, 0); assert.deepEqual(h.acknowledged, []);
});

test('test notifications and unsupported payloads do not create subscription work', async () => {
  const h = harness();
  assert.equal((await h.process(encode('new', 4, { testNotification: { version: '1' } }))).kind, 'TEST');
  assert.equal((await h.process(encode('new', 4, { subscriptionNotification: null }))).kind, 'IGNORED');
  assert.equal(h.inbox().size, 0); assert.equal(h.getCalls.length, 0);
});

test('wrong package fails before persistence or Google calls', async () => {
  const h = harness();
  await assert.rejects(h.process(encode('new', 4, { packageName: 'other.app' })), { message: 'GOOGLE_PLAY_RTDN_INVALID_PACKAGE' });
  assert.equal(h.inbox().size, 0); assert.equal(h.getCalls.length, 0);
});

test('older attempts cannot overwrite the outcome of a newer attempt', async () => {
  const h = harness(); h.purchase('new');
  h.faults.beforeGet = async () => { const row = h.inbox().get('new'); row.version++; row.status = 'PROCESSED'; };
  await h.process(encode('new'));
  assert.equal(h.inbox().get('new').status, 'PROCESSED');
});
