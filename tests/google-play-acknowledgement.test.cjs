const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/google-play.cjs');

async function failedPurchase() {
  const h = harness(); h.purchase('paid'); h.faults.ack = Error('ACK_TIMEOUT');
  await assert.rejects(h.sync({userId: 1, purchaseToken: 'paid'}), {message: 'ACK_TIMEOUT'});
  delete h.faults.ack;
  return h;
}

test('post-COMMIT failure persists an acknowledgement obligation without RTDN', async () => {
  const h = await failedPurchase();
  assert.equal(h.rows()[0].status, 'ACTIVE'); assert.equal(h.inbox().size, 0);
  assert.equal(h.jobs().get('paid').status, 'RETRY');
  assert.equal(h.jobs().get('paid').reason, 'ACKNOWLEDGEMENT_FAILED');
  const insert = h.calls.findIndex(call => call.sql.startsWith('INSERT INTO google_play_acknowledgements'));
  assert.ok(insert < h.calls.findIndex(call => call.sql === 'COMMIT'));
  const before = structuredClone(h.rows());
  assert.equal((await h.reconcileAck()).completed, 1);
  assert.deepEqual(h.rows(), before); assert.deepEqual(h.acknowledged, ['paid']);
  assert.equal(h.jobs().get('paid').status, 'COMPLETED');
  assert.ok(h.jobs().get('paid').completed_at);
  assert.equal((await h.reconcileAck()).completed, 0);
  await h.sync({userId: 1, purchaseToken: 'paid'});
  assert.deepEqual(h.acknowledged, ['paid']);
});

test('lost acknowledgement response is recovered by reading Google without a second ack', async () => {
  const h = harness(); h.purchase('paid');
  h.faults.afterAck = () => { throw Error('LOST_RESPONSE'); };
  await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}));
  assert.equal(h.jobs().get('paid').status, 'RETRY');
  delete h.faults.afterAck;
  assert.equal((await h.reconcileAck()).completed, 1);
  assert.deepEqual(h.acknowledged, ['paid']);
});

test('failed local completion is recoverable after Google succeeds', async () => {
  const h = harness(); h.purchase('paid'); h.faults.finish = Error('DB_WRITE_FAILED');
  await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}));
  assert.equal(h.jobs().get('paid').status, 'RETRY');
  assert.equal((await h.reconcileAck()).completed, 1);
  assert.deepEqual(h.acknowledged, ['paid']);
});

for (const state of ['PENDING', 'PENDING_PURCHASE_CANCELED', 'EXPIRED', 'ON_HOLD', 'PAUSED']) {
  test('recovery does not acknowledge current Google state ' + state, async () => {
    const h = await failedPurchase(); h.purchase('paid', undefined, state);
    if (state === 'PENDING') { delete h.purchases.get('paid').startTime; delete h.purchases.get('paid').lineItems[0].expiryTime; }
    const before = structuredClone(h.rows());
    assert.equal((await h.reconcileAck()).deferred, 1);
    assert.deepEqual(h.acknowledged, []); assert.deepEqual(h.rows(), before);
    assert.equal(h.jobs().get('paid').status, 'DEFERRED');
  });
}
for (const state of ['ACTIVE', 'IN_GRACE_PERIOD', 'CANCELED']) {
  test('past expiry excludes acknowledgement even for ' + state, async () => {
    const h = await failedPurchase(); h.purchase('paid', undefined, state);
    h.purchases.get('paid').lineItems[0].expiryTime = '2000-01-01T00:00:00Z';
    assert.equal((await h.reconcileAck()).deferred, 1); assert.deepEqual(h.acknowledged, []);
  });
}

test('recovery refuses changed ownership, unknown anchors and replaced tokens', async () => {
  for (const scenario of ['owner', 'unknown', 'replaced', 'saved-owner']) {
    const h = await failedPurchase();
    if (scenario === 'owner') h.owners()[0].user_id = 2;
    if (scenario === 'unknown') h.purchases.get('paid').linkedPurchaseToken = 'unknown';
    if (scenario === 'replaced') h.owners()[0].replaced_by_token = 'successor';
    if (scenario === 'saved-owner') h.rows()[0].user_id = 2;
    assert.equal((await h.reconcileAck()).completed, 0); assert.deepEqual(h.acknowledged, []);
  }
});

test('historical discovery checks Google without activating locally expired access', async () => {
  const h = harness([{id:'1',user_id:1,token:'historic',status:'EXPIRED'}]); h.purchase('historic');
  const before = structuredClone(h.rows());
  assert.equal((await h.reconcileAck()).completed, 1);
  assert.deepEqual(h.rows(), before); assert.equal(h.inbox().size, 0);
  assert.deepEqual(h.acknowledged, ['historic']);
});

test('failed subscription transaction rolls back the acknowledgement obligation too', async () => {
  const h = harness(); h.purchase('paid');
  const push = h.calls.push;
  h.calls.push = function(call) {
    if (call.sql === 'COMMIT') throw Error('COMMIT_FAILED');
    return push.call(this, call);
  };
  await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}));
  assert.equal(h.jobs().size, 0); assert.equal(h.rows().length, 0); assert.deepEqual(h.acknowledged, []);
});


test('the existing reconciliation command runs both queues and reports failures', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ts = require('typescript');
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/scripts/reconcileGooglePlayRtdn.ts'),'utf8'), {
    compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText;
  for (const failed of [0,1]) {
    const events = []; const process = {};
    const require = name => {
      if (name === 'dotenv/config') return {};
      if (name === '../lib/db') return {pool:{end:async()=>{events.push('end');}}};
      if (name === '../services/googlePlayAcknowledgement.service') return {reconcileGooglePlayAcknowledgements:async()=>{events.push('ack');return {completed:1,deferred:0,failed};}};
      if (name === '../services/googlePlayRtdn.service') return {reconcilePendingGooglePlayRtdn:async()=>{events.push('rtdn');return {processed:1,deferred:0,failed:0};}};
      throw Error('Unexpected import '+name);
    };
    await vm.runInNewContext(code,{require,exports:{},process,console:{log(){},error(){}}});
    assert.deepEqual(events,['ack','rtdn','end']);
    assert.equal(process.exitCode,failed ? 1 : undefined);
  }
});
