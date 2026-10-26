const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { harness } = require('./helpers/google-play.cjs');
const encode = token => Buffer.from(JSON.stringify({packageName:'com.tocadapp.mobile',subscriptionNotification:{purchaseToken:token,notificationType:4}})).toString('base64');

const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/services/googlePlayCatalog.service.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const catalog={};vm.runInNewContext('(function(exports){'+code+'\n})',{process:{env:{}}})(catalog);
test('server sales policy is closed unless the operator opts in with exact true',()=>{
  for(const value of [undefined,'','false','TRUE','1',' true ']) assert.equal(catalog.getGooglePlayPurchasePolicy({GOOGLE_PLAY_NEW_PURCHASES_ENABLED:value}).newPurchasesEnabled,false);
  assert.equal(catalog.getGooglePlayPurchasePolicy().newPurchasesEnabled,false);
  assert.equal(catalog.getGooglePlayPurchasePolicy({GOOGLE_PLAY_NEW_PURCHASES_ENABLED:'true'}).productId,'tocadapp_premium_v2');
});
for(const product of ['tocadapp_premium','tocadapp_premium_v2']) for(const base of ['monthly','yearly']) {
  test(product+'/'+base+' validates, restores and acknowledges using the Google product',async()=>{
    const h=harness();h.purchase('paid');h.identify('paid');
    Object.assign(h.purchases.get('paid').lineItems[0],{productId:product,offerDetails:{basePlanId:base}});
    const result=await h.sync({userId:1,purchaseToken:'paid'});
    assert.equal(result.planCode,base==='monthly'?'TOCADAPP_MONTHLY':'TOCADAPP_YEARLY');
    assert.equal(result.purchaseResult.state,'ACTIVE');assert.deepEqual(h.acknowledgementProducts,[product]);
    await h.sync({userId:1,purchaseToken:'paid'});
    assert.deepEqual(h.acknowledged,['paid']);
    await assert.rejects(h.sync({userId:2,purchaseToken:'paid'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
  });
  test(product+'/'+base+' RTDN and durable pending recovery work with sales disabled',async()=>{
    const h=harness();h.purchase('pending',undefined,'PENDING');h.identify('pending');
    Object.assign(h.purchases.get('pending').lineItems[0],{productId:product,offerDetails:{basePlanId:base}});
    assert.equal((await h.process(encode('pending'))).kind,'DEFERRED');
    assert.deepEqual(h.acknowledged,[]);assert.equal(h.rows().length,0);
    h.purchases.get('pending').subscriptionState='SUBSCRIPTION_STATE_ACTIVE';
    assert.equal((await h.reconcilePurchases()).processed,1);
    assert.deepEqual(h.acknowledgementProducts,[product]);
  });
}
for(const [product,base,error] of [
  ['other','monthly','GOOGLE_PLAY_INVALID_PRODUCT'],['tocadapp_premium_v2','other','GOOGLE_PLAY_INVALID_BASE_PLAN'],
  ['__proto__','monthly','GOOGLE_PLAY_INVALID_PRODUCT'],['tocadapp_premium','constructor','GOOGLE_PLAY_INVALID_BASE_PLAN'],
]) test('unknown catalog combination is rejected: '+product+'/'+base,async()=>{
  const h=harness();h.purchase('paid');h.identify('paid');Object.assign(h.purchases.get('paid').lineItems[0],{productId:product,offerDetails:{basePlanId:base}});
  await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}),{message:error});
  assert.equal(h.rows().length,0);assert.equal(h.owners().length,0);assert.deepEqual(h.acknowledged,[]);
});
test('catalog identity changing while acquiring token locks aborts before writes',async()=>{
  const h=harness();h.purchase('paid');h.identify('paid');
  h.faults.beforeGet=()=>{if(h.getCalls.length===2)h.purchases.get('paid').lineItems[0].productId='tocadapp_premium_v2';};
  await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}),{message:'GOOGLE_PLAY_PURCHASE_LINK_CHANGED'});
  assert.equal(h.rows().length,0);assert.deepEqual(h.acknowledged,[]);
});
test('cross-product resubscription cannot reuse an anchor consumed by another successor',async()=>{
  const h=harness([{id:'1',user_id:1,token:'old',status:'ACTIVE'}]);h.purchase('replacement','old');
  h.purchases.get('replacement').lineItems[0].productId='tocadapp_premium_v2';
  await h.sync({userId:1,purchaseToken:'replacement'});
  const before=structuredClone(h.rows());h.purchase('resubscription');
  h.purchases.get('resubscription').outOfAppPurchaseContext={expiredPurchaseToken:'old'};
  await assert.rejects(h.sync({userId:1,purchaseToken:'resubscription'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
  assert.deepEqual(h.rows(),before);assert.deepEqual(h.acknowledged,['replacement']);
  assert.equal(h.recovery().get('resubscription').status,'DEFERRED');
});
