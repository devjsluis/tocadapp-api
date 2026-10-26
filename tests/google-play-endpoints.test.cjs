const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function controllerHarness({failure, purchaseState='ACTIVE', access=false}={}) {
  const calls=[];
  const sub=access ? {provider:'GOOGLE_PLAY',currentPeriodEnd:'2099-01-01T00:00:00Z'} : null;
  const purchaseResult={state:purchaseState,subscriptionState:'SUBSCRIPTION_STATE_'+purchaseState,acknowledgementState:null,retryable:purchaseState==='PENDING'};
  const catalogCode=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/services/googlePlayCatalog.service.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const catalogModule={exports:{}};
  vm.runInNewContext('(function(exports){'+catalogCode+'\n})',{process:{env:{}}})(catalogModule.exports);
  const mocks={
    '../services/googlePlayCatalog.service':catalogModule.exports,
    '../services/googlePlayIdentity.service':{getGooglePlayBillingIdentity:async userId=>{calls.push(['identity',userId]);if(failure) throw Error(failure);return {obfuscatedAccountId:'a'.repeat(32)};}},
    '../services/googlePlayOwnership.service':{googlePlayRecoveryErrorCode:()=> 'GOOGLE_PLAY_VERIFICATION_FAILED'},
    '../services/subscriptions.service':{getCurrentSubscriptionByUserId:async userId=>{calls.push(['current',userId]);return sub;},subscriptionGrantsAccess:()=>access},
    '../services/googlePlaySubscription.service':{syncGooglePlaySubscription:async input=>{calls.push(['verify',input]);if(failure)throw Error(failure);return {status:purchaseState, purchaseResult};}},
    '../services/stripeCheckout.service':{},'../services/stripeSubscriptionManagement.service':{},
  };
  const file=path.join(__dirname,'../src/controllers/subscriptions.controller.ts');
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const module={exports:{}};
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Error,console:{error(){}}})(name=>{assert.ok(name in mocks,name);return mocks[name];},module,module.exports);
  const res={statusCode:200,headers:{},setHeader(name,value){this.headers[name]=value;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  return {handlers:module.exports,res,calls,purchaseResult};
}

test('authenticated identity endpoint returns capabilities and prevents cache reuse across accounts',async()=>{
  const h=controllerHarness();
  await h.handlers.getMyGooglePlayBillingIdentity({user:{id:7},query:{userId:2},body:{userId:2}},h.res);
  assert.equal(h.res.statusCode,200);assert.equal(h.res.headers['Cache-Control'],'no-store');
  assert.equal(h.res.body.obfuscatedAccountId,'a'.repeat(32));assert.deepEqual(h.calls,[['identity',7]]);
  assert.equal(h.res.body.capabilities.strictOwnership,true);assert.equal(h.res.body.capabilities.legacyUnownedTokenClaim,false);
});

test('identity route is protected by the same authentication middleware as verify',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/routes/subscriptions.routes.ts'),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const auth=()=>{};const router=require('express').Router();const module={exports:{}};
  const handlers=new Proxy({}, {get:(_,name)=>function(){return name;}});
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})')(
    name=>name==='express'?{Router:()=>router}:name==='../middleware/auth'?{authMiddleware:auth}:handlers,module,module.exports);
  for(const route of ['/google-play/identity','/google-play/verify','/me']) {
    const layer=router.stack.find(layer=>layer.route?.path===route);
    assert.ok(layer);assert.equal(layer.route.stack[0].handle,auth);
  }
});

test('/subscriptions/me preserves exactly its established response structure',async()=>{
  const h=controllerHarness();await h.handlers.getMySubscription({user:{id:7}},h.res);
  assert.equal(JSON.stringify(h.res.body),JSON.stringify({hasAccess:false,subscription:null}));
});

for(const state of ['ACTIVE','PENDING','CANCELED']) {
  test('v16 verify body remains token-only and ignores forged ownership fields: '+state,async()=>{
    const h=controllerHarness({purchaseState:state,access:true});
    await h.handlers.verifyGooglePlaySubscription({user:{id:7},body:{purchaseToken:'token',userId:2,obfuscatedAccountId:'forged',productId:'forged',basePlanId:'forged'}},h.res);
    assert.equal(h.res.statusCode,200);assert.equal(h.res.body.hasAccess,true);assert.equal(h.res.body.subscription.provider,'GOOGLE_PLAY');
    assert.equal(h.res.body.googlePlay.purchaseResult.state,state);assert.equal(h.res.body.purchaseResult.state,state);
    assert.equal(JSON.stringify(h.calls[0]),JSON.stringify(['verify',{userId:7,purchaseToken:'token'}]));
  });
}

for(const [code,status,retryable] of [
 ['GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED',409,false],['GOOGLE_PLAY_OWNER_UNVERIFIABLE',409,false],
 ['GOOGLE_PLAY_BILLING_IDENTITY_UNKNOWN',409,false],['GOOGLE_PLAY_LINKED_PURCHASE_OWNER_UNKNOWN',409,false],
 ['PLAN_NOT_FOUND',404,false],['GOOGLE_PLAY_INVALID_PRODUCT',400,false],['TRANSIENT_GOOGLE_ERROR',502,true],
]) {
  test('explicit verify error response: '+code,async()=>{
    const h=controllerHarness({failure:code});
    await h.handlers.verifyGooglePlaySubscription({user:{id:7},body:{purchaseToken:'token'}},h.res);
    assert.equal(h.res.statusCode,status);assert.equal(h.res.body.retryable,retryable);
    if(status===409) assert.equal(h.res.body.code,code);
    assert.equal(h.res.body.userId,undefined);assert.equal(h.res.body.obfuscatedAccountId,undefined);
  });
}


test('identity advertises dual recovery but leaves new v2 purchases disabled by default',async()=>{
  const h=controllerHarness();await h.handlers.getMyGooglePlayBillingIdentity({user:{id:7}},h.res);
  assert.equal(h.res.body.capabilities.multiProductRecovery,true);
  assert.equal(h.res.body.capabilities.purchaseCatalogVersion,1);
  assert.equal(h.res.body.purchasePolicy.newPurchasesEnabled,false);
  assert.equal(h.res.body.purchasePolicy.productId,'tocadapp_premium_v2');
  assert.equal(h.res.body.purchasePolicy.basePlans.TOCADAPP_MONTHLY,'monthly');
  assert.equal(h.res.body.purchasePolicy.basePlans.TOCADAPP_YEARLY,'yearly');
});
