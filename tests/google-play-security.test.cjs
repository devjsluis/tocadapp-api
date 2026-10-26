const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/google-play.cjs');
const old = { id: '1', user_id: 1, token: 'old', status: 'ACTIVE' };
const encode = token => Buffer.from(JSON.stringify({packageName:'com.tocadapp.mobile',subscriptionNotification:{purchaseToken:token,notificationType:4}})).toString('base64');

// Model the actual v16 request: a token only, no client identity or new fields.
test('v16: known legacy tokens restore and renew without an obfuscated ID', async () => {
  const h = harness([old]); h.purchase('old');
  const result = await h.sync({userId:1,purchaseToken:'old'});
  assert.equal(result.status,'ACTIVE'); assert.equal(result.purchaseResult.state,'ACTIVE');
  assert.deepEqual(h.acknowledged,['old']);
});

test('v16: a new legacy token cannot be assigned to the first authenticated claimant', async () => {
  const h = harness(); h.purchase('legacy');
  for (const userId of [1,2]) await assert.rejects(h.sync({userId,purchaseToken:'legacy'}),{message:'GOOGLE_PLAY_OWNER_UNVERIFIABLE'});
  assert.equal(h.owners().length,0); assert.equal(h.rows().length,0); assert.deepEqual(h.acknowledged,[]);
  assert.equal(h.recovery().get('legacy').status,'DEFERRED'); assert.equal(h.recovery().get('legacy').user_id,null);
  assert.equal((await h.reconcilePurchases()).deferred,1);
});

test('v16: a new token with a verified known predecessor retains legacy restoration', async () => {
  const h = harness([old]); h.purchase('renewed','old');
  assert.equal((await h.sync({userId:1,purchaseToken:'renewed'})).status,'ACTIVE');
  await assert.rejects(h.sync({userId:2,purchaseToken:'renewed'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
});

test('a session switch cannot claim a fresh payment made with A identity as B', async () => {
  const h = harness(); h.purchase('paid'); h.identify('paid',1);
  await assert.rejects(h.sync({userId:2,purchaseToken:'paid'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
  assert.equal(h.rows().length,0); assert.equal(h.owners().length,0); assert.deepEqual(h.acknowledged,[]);
  // The worker recovers for A without reusing B as an ownership hint.
  assert.equal((await h.reconcilePurchases()).processed,1);
  assert.equal(h.owners()[0].user_id,1); assert.equal(h.recovery().get('paid').user_id,1);
  assert.deepEqual(h.acknowledged,['paid']);
});

test('Google identity and registered chain must agree even for an already known token', async () => {
  const h = harness([old]); h.purchase('new','old'); h.identify('new',2);
  await assert.rejects(h.sync({userId:1,purchaseToken:'new'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
  h.purchase('old'); h.identify('old',2);
  await assert.rejects(h.sync({userId:1,purchaseToken:'old'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
  assert.deepEqual(h.rows(),[old]); assert.deepEqual(h.acknowledged,[]);
});

test('unknown Google identity is rejected rather than parsed as the authenticated user ID', async () => {
  const h = harness(); h.purchase('new');
  h.purchases.get('new').externalAccountIdentifiers={obfuscatedExternalAccountId:'1'};
  await assert.rejects(h.sync({userId:1,purchaseToken:'new'}),{message:'GOOGLE_PLAY_BILLING_IDENTITY_UNKNOWN'});
  assert.equal(h.owners().length,0); assert.deepEqual(h.acknowledged,[]);
});

test('expired external identity and current identity cannot disagree', async () => {
  const h = harness([old]); h.purchase('new'); h.identify('new',1);
  h.purchases.get('new').outOfAppPurchaseContext={expiredPurchaseToken:'old',expiredExternalAccountIdentifiers:{obfuscatedExternalAccountId:'b'.repeat(32)}};
  await assert.rejects(h.sync({userId:1,purchaseToken:'new'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
  assert.deepEqual(h.rows(),[old]); assert.deepEqual(h.acknowledged,[]);
});

test('identity is refreshed inside token locks instead of trusting a pre-lock Google response', async () => {
  const h=harness(); h.purchase('paid'); h.identify('paid',1);
  h.faults.beforeGet=()=>{if(h.getCalls.length===2) h.identify('paid',2);};
  await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
  assert.equal(h.owners().length,0); assert.deepEqual(h.acknowledged,[]);
});

for (const terminal of ['PENDING_PURCHASE_CANCELED','ACTIVE']) {
  test('durable PENDING without dates recovers to '+terminal+' without another client callback', async () => {
    const h = harness([old]); h.purchase('pending','old','PENDING'); h.identify('pending');
    delete h.purchases.get('pending').startTime; delete h.purchases.get('pending').lineItems[0].expiryTime;
    const first=await h.sync({userId:1,purchaseToken:'pending'});
    assert.equal(first.purchaseResult.state,'PENDING'); assert.equal(first.currentPeriodEnd,null);
    assert.equal(h.recovery().get('pending').status,'PENDING'); assert.deepEqual(h.rows(),[old]); assert.deepEqual(h.acknowledged,[]);
    h.purchase('pending','old',terminal); h.identify('pending');
    if(terminal!=='ACTIVE'){delete h.purchases.get('pending').startTime; delete h.purchases.get('pending').lineItems[0].expiryTime;}
    assert.equal((await h.reconcilePurchases()).processed,1);
    assert.equal(h.recovery().get('pending').status,'PROCESSED');
    assert.equal(h.recovery().get('pending').purchase_state,'SUBSCRIPTION_STATE_'+terminal);
    if(terminal==='ACTIVE') {
      assert.deepEqual(h.rows().filter(r=>r.status==='ACTIVE').map(r=>r.token),['pending']); assert.deepEqual(h.acknowledged,['pending']);
    } else {
      assert.deepEqual(h.rows(),[old]); assert.equal(h.owners()[0].replaced_by_token,null); assert.deepEqual(h.acknowledged,[]);
      assert.equal((await h.sync({userId:1,purchaseToken:'pending'})).purchaseResult.state,'CANCELED');
    }
  });
}

test('RTDN can recover an identified first purchase before any authenticated verify', async () => {
  const h=harness(); h.purchase('paid'); h.identify('paid');
  assert.equal((await h.process(encode('paid'))).userId,1);
  assert.equal(h.recovery().get('paid').status,'PROCESSED'); assert.deepEqual(h.acknowledged,['paid']);
});

test('RTDN pending cancellation is terminal and leaves existing access untouched', async () => {
  const h=harness([old]); h.purchase('pending','old','PENDING'); h.identify('pending');
  delete h.purchases.get('pending').startTime; delete h.purchases.get('pending').lineItems[0].expiryTime;
  assert.equal((await h.process(encode('pending'))).reason,'PENDING_PURCHASE');
  h.purchases.get('pending').subscriptionState='SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';
  assert.equal((await h.reconcile()).processed,1);
  assert.equal(h.inbox().get('pending').status,'PROCESSED'); assert.deepEqual(h.rows(),[old]); assert.deepEqual(h.acknowledged,[]);
});

test('acknowledgement worker rechecks Google identities for saved purchases', async () => {
  const h=harness([old]); h.purchase('old'); h.identify('old',2);
  assert.equal((await h.reconcileAck()).completed,0); assert.deepEqual(h.acknowledged,[]); assert.deepEqual(h.rows(),[old]);
});

test('transport failures persist retry work without retaining raw error messages', async () => {
  const h=harness(); h.purchase('paid'); h.identify('paid');
  h.faults.google=Error('untrusted transport message with private URL');
  await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}));
  assert.equal(h.recovery().get('paid').reason,'GOOGLE_PLAY_VERIFICATION_FAILED'); assert.equal(h.recovery().get('paid').user_id,null);
  delete h.faults.google; assert.equal((await h.reconcilePurchases()).processed,1);
});


test('an unowned canceled legacy pending operation becomes terminal without assigning its token', async () => {
  const h=harness(); h.purchase('legacy',undefined,'PENDING');
  await assert.rejects(h.sync({userId:1,purchaseToken:'legacy'}),{message:'GOOGLE_PLAY_OWNER_UNVERIFIABLE'});
  h.purchases.get('legacy').subscriptionState='SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';
  delete h.purchases.get('legacy').startTime;delete h.purchases.get('legacy').lineItems[0].expiryTime;
  assert.equal((await h.reconcilePurchases()).processed,1);
  assert.equal(h.recovery().get('legacy').user_id,null);assert.equal(h.recovery().get('legacy').status,'PROCESSED');
  assert.equal((await h.process(encode('legacy'))).kind,'CANCELED');
  assert.equal(h.inbox().get('legacy').status,'PROCESSED');
  assert.equal(h.owners().length,0);assert.equal(h.rows().length,0);assert.deepEqual(h.acknowledged,[]);
});

for (const anchorKind of ['linkedPurchaseToken', 'expiredPurchaseToken']) {
  test('replaced '+anchorKind+' is deferred without changing paid access through verify, RTDN or recovery', async () => {
    const h=harness([old]); h.purchase('replacement','old');
    await h.sync({userId:1,purchaseToken:'replacement'});
    const before=structuredClone(h.rows()); const owners=structuredClone(h.owners());
    const ack=structuredClone(h.acknowledged);
    h.purchase('resubscription');
    if(anchorKind==='linkedPurchaseToken') h.purchases.get('resubscription').linkedPurchaseToken='old';
    else h.purchases.get('resubscription').outOfAppPurchaseContext={expiredPurchaseToken:'old'};
    for (const userId of [1,2]) await assert.rejects(h.sync({userId,purchaseToken:'resubscription'}),
      {message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
    assert.equal((await h.process(encode('resubscription'))).kind,'DEFERRED');
    assert.equal((await h.reconcilePurchases()).deferred,1);
    assert.deepEqual(h.rows(),before);assert.deepEqual(h.owners(),owners);assert.deepEqual(h.acknowledged,ack);
    const work=h.recovery().get('resubscription');
    assert.equal(work.status,'DEFERRED');assert.equal(work.reason,'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED');
    assert.notEqual(work.purchase_state,'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED');
    assert.equal(h.jobs().has('resubscription'),false);
  });
}

test('legitimate known expired anchor still activates and acknowledges for its original account', async () => {
  const h=harness([{...old,status:'EXPIRED'}]);h.purchase('resubscription');
  h.purchases.get('resubscription').outOfAppPurchaseContext={expiredPurchaseToken:'old'};
  const result=await h.sync({userId:1,purchaseToken:'resubscription'});
  assert.equal(result.purchaseResult.state,'ACTIVE');
  assert.equal(result.purchaseResult.acknowledgementState,'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');
  assert.deepEqual(h.acknowledged,['resubscription']);
  // Repeated delivery remains safe; no second Google acknowledgement.
  await h.sync({userId:1,purchaseToken:'resubscription'});
  assert.deepEqual(h.acknowledged,['resubscription']);
});

test('ack worker rejects a previously saved payment with a conflicting expired anchor', async () => {
  const h=harness([old,{id:'2',user_id:1,token:'replacement',status:'ACTIVE'},
    {id:'3',user_id:1,token:'resubscription',status:'ACTIVE'}]);
  h.owners().find(row=>row.purchase_token==='old').replaced_by_token='replacement';
  h.purchase('resubscription');
  h.purchases.get('resubscription').outOfAppPurchaseContext={expiredPurchaseToken:'old'};
  const before=structuredClone(h.rows());
  await h.reconcileAck();
  assert.equal(h.jobs().get('resubscription').status,'DEFERRED');
  assert.equal(h.jobs().get('resubscription').reason,'OWNER_CONFLICT_OR_UNKNOWN');
  assert.deepEqual(h.rows(),before);assert.deepEqual(h.acknowledged,[]);
});
