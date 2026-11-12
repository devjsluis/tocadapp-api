const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'), {
    compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const module={exports:{}};
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})', {process:{env:{WEB_APP_URL:'https://example.test'}},Date,Error,console})(
    name => { if (name==='node:crypto') return require(name); assert.ok(name in mocks,name); return mocks[name]; },module,module.exports);
  return module.exports;
}
const result=rows=>({rows,rowCount:rows.length});
const plan={id:'1',code:'TOCADAPP_MONTHLY',name:'Monthly',price_amount:7900,currency:'MXN',billing_interval:'MONTH',interval_count:1};
const input={userId:7,email:'user@example.test',planCode:plan.code};

function checkoutHarness(options={}) {
  const state={attempt:null,creates:[],sessions:[],expired:[],queries:[],released:0,locked:false};
  let tail=Promise.resolve();
  const pool={connect:async()=>{
    let unlock;
    return {query:async(sql,args=[])=>{
      state.queries.push(sql);
      if(sql.includes('pg_advisory_lock(')) {
        const before=tail;tail=new Promise(resolve=>unlock=resolve);await before;state.locked=true;return result([]);
      }
      if(sql.includes('pg_advisory_unlock')) {state.locked=false;unlock();return result([]);}
      if(sql.includes('FROM users')) return result([{id:7}]);
      if(sql.includes('FROM subscriptions')) return result(options.existing??[]);
      if(sql.includes('SELECT * FROM stripe_checkout_attempts')) return result(state.attempt?[state.attempt]:[]);
      if(sql.includes('INSERT INTO stripe_checkout_attempts')) {state.attempt={idempotency_key:args[1],request:JSON.parse(args[2]),session_id:null,created_at:new Date()};return result([]);}
      if(sql.includes('UPDATE stripe_checkout_attempts')) {state.attempt.session_id=args[1];return result([]);}
      if(sql.includes('DELETE FROM stripe_checkout_attempts')) {state.attempt=null;return result([]);}
      if(sql.includes('FROM plans')) return result(options.noPlan?[]:[plan]);
      throw Error('Unexpected SQL: '+sql);
    },release:()=>state.released++};
  }};
  const created=new Map();
  let fail=options.timeout;
  const stripe={subscriptions:{retrieve:async id=>({id,status:options.remoteStatus??'active'})},checkout:{sessions:{
    list:params=>({async *[Symbol.asyncIterator](){
      assert.equal(state.locked,true);
      for(const session of state.sessions) if(!params.status||session.status===params.status) yield session;
    }}),
    retrieve:async id=>state.sessions.find(s=>s.id===id),
    expire:async id=>{state.expired.push(id);state.sessions.find(s=>s.id===id).status='expired';},
    create:async(request,opts)=>{
      assert.equal(state.locked,true);assert.ok(state.attempt,'attempt persisted before Stripe');
      state.creates.push({request,key:opts.idempotencyKey});
      if(!created.has(opts.idempotencyKey)) {
        const session={id:'cs_'+created.size,url:'https://checkout.stripe.test/'+created.size,status:'open',mode:'subscription',client_reference_id:'7'};
        created.set(opts.idempotencyKey,session);state.sessions.push(session);
      }
      if(fail){fail=false;throw Error('Network timeout after remote creation');}
      return created.get(opts.idempotencyKey);
    },
  }}};
  return {state,run:load('services/stripeCheckout.service.ts',{'../lib/db':{pool},'../lib/stripe':{stripe}}).createCheckoutSession};
}

test('concurrent Checkout calls reuse one durable session and release account lock',async()=>{
  const h=checkoutHarness();const [a,b]=await Promise.all([h.run(input),h.run(input)]);
  assert.equal(a.sessionId,b.sessionId);assert.equal(h.state.creates.length,1);assert.equal(h.state.released,2);assert.equal(h.state.locked,false);
});
test('ambiguous network failure retries exact persisted request/key instead of charging twice',async()=>{
  const h=checkoutHarness({timeout:true});await assert.rejects(h.run(input),/timeout/);
  const saved=JSON.stringify(h.state.attempt.request);await h.run({...input,email:'changed@example.test'});
  assert.equal(h.state.sessions.length,1);assert.equal(h.state.creates.length,2);
  assert.equal(h.state.creates[0].key,h.state.creates[1].key);
  assert.equal(JSON.stringify(h.state.creates[1].request),saved);
});
test('changing plan expires previous payable link before issuing another',async()=>{
  const h=checkoutHarness();const first=await h.run(input);await h.run({...input,planCode:'TOCADAPP_YEARLY'});
  assert.deepEqual(h.state.expired,[first.sessionId]);assert.equal(h.state.sessions.filter(s=>s.status==='open').length,1);
});
test('legacy open Checkout links are expired even without a local attempt',async()=>{
  const h=checkoutHarness();h.state.sessions.push({id:'legacy',status:'open',mode:'subscription',client_reference_id:'7'});
  await h.run(input);assert.deepEqual(h.state.expired,['legacy']);
});
for(const status of ['active','past_due','unpaid','paused','incomplete','trialing']) {
  test('historical locally expired Stripe subscription still billing blocks new Checkout: '+status,async()=>{
    const h=checkoutHarness({remoteStatus:status,existing:[{provider:'STRIPE',provider_subscription_id:'sub_old',status:'EXPIRED'}]});
    await assert.rejects(h.run(input),/SUBSCRIPTION_ALREADY_EXISTS/);assert.equal(h.state.creates.length,0);
  });
}
test('active native subscription prevents creating a second billing agreement',async()=>{
  const h=checkoutHarness({existing:[{provider:'APPLE',status:'ACTIVE',current_period_end:new Date('2099-01-01')}]});
  await assert.rejects(h.run(input),/SUBSCRIPTION_ALREADY_EXISTS/);assert.equal(h.state.creates.length,0);
});
test('completed Checkout with delayed webhook prevents another payment',async()=>{
  const h=checkoutHarness();h.state.sessions.push({id:'paid',status:'complete',subscription:'sub_paid',mode:'subscription',client_reference_id:'7'});
  await assert.rejects(h.run(input),/SUBSCRIPTION_ALREADY_EXISTS/);assert.equal(h.state.creates.length,0);
});
test('expired idempotency retention requires reconciliation instead of another create',async()=>{
  const h=checkoutHarness({timeout:true});await assert.rejects(h.run(input));
  h.state.attempt.created_at=new Date(Date.now()-24*3600000);h.state.sessions=[];
  await assert.rejects(h.run(input),/CHECKOUT_RECONCILIATION_REQUIRED/);assert.equal(h.state.creates.length,1);
});

const subscription=patch=>({id:'sub_1',metadata:{userId:'7',planCode:plan.code},status:'active',customer:'cus_1',start_date:100,
  cancel_at_period_end:false,canceled_at:null,ended_at:null,
  items:{data:[{current_period_start:100,current_period_end:200,price:{unit_amount:4900,currency:'mxn'}}]},...patch});
function webhookHarness(options={}) {
  const queries=[];let retrieved=0;
  const client={query:async(sql,args=[])=>{
    queries.push({sql,args});
    if(sql.includes('INSERT INTO payment_provider_events'))return result(options.duplicate?[]:[{id:1}]);
    if(sql.includes('FROM users'))return result(options.deleted?[]:[{id:7}]);
    if(sql.includes('FROM plans')){assert.equal(sql.includes('active = TRUE'),false);return result([plan]);}
    if(sql.includes('SELECT id, provider FROM subscriptions'))return result(options.competing??[]);
    if(sql.includes('SELECT id')&&sql.includes('FROM subscriptions'))return result(options.existing===false?[]:[{id:4}]);
    if(sql.includes('INSERT INTO subscriptions'))return result([{id:4}]);
    return result([]);
  },release(){}};
  const stripe={subscriptions:{retrieve:async()=>{
    retrieved++;if(options.failure)throw Error('Stripe unavailable');
    // All writes must use an authoritative read after acquiring the account lock.
    if(retrieved>1||!options.invoice) assert.ok(queries.some(q=>q.sql.includes('pg_advisory_xact_lock')));
    return subscription(options.remote);
  }},invoicePayments:{list:async()=>({data:[]})}};
  const process=load('services/stripeWebhook.service.ts',{'../lib/db':{pool:{connect:async()=>client}},'../lib/stripe':{stripe}}).processStripeEvent;
  return {queries,process,retrieved:()=>retrieved};
}
const event=(type='customer.subscription.updated',object=subscription())=>({id:'evt_1',created:300,type,data:{object}});
test('late ACTIVE snapshot cannot resurrect canceled remote subscription or expire another paid subscription',async()=>{
  const h=webhookHarness({remote:{status:'canceled',ended_at:200}});await h.process(event());
  const update=h.queries.find(q=>q.sql.includes('plan_id = $1'));
  assert.equal(update.args[1],'CANCELED');assert.equal(h.queries.some(q=>q.sql.includes('SELECT id, provider')),false);
});
test('late deleted snapshot uses current authoritative state too',async()=>{
  const h=webhookHarness({remote:{status:'canceled',ended_at:200}});await h.process(event('customer.subscription.deleted'));
  assert.equal(h.retrieved(),1);assert.equal(h.queries.find(q=>q.sql.includes('plan_id = $1')).args[1],'CANCELED');
});
test('sync retains contracted Stripe price despite later catalog changes and permits inactive plans',async()=>{
  const h=webhookHarness();await h.process(event());
  const args=h.queries.find(q=>q.sql.includes('plan_id = $1')).args;
  assert.equal(args[3],4900);assert.equal(args[4],'MXN');
});
for(const provider of ['STRIPE','APPLE','GOOGLE_PLAY','MANUAL']) {
  test('paid competing subscription is not expired by incoming Stripe event: '+provider,async()=>{
    const h=webhookHarness({competing:[{id:5,provider}]});await assert.rejects(h.process(event()),/STRIPE_SUBSCRIPTION_CONFLICT/);
    assert.equal(h.queries.some(q=>q.sql.includes("status = 'EXPIRED'")),false);
    assert.equal(h.queries.at(-1).sql,'ROLLBACK');
  });
}
test('pending new purchase preserves trial; only active purchase retires trial',async()=>{
  const pending=webhookHarness({remote:{status:'incomplete'},competing:[{id:5,provider:'TRIAL'}]});await pending.process(event());
  assert.equal(pending.queries.some(q=>q.sql.includes("status = 'EXPIRED'")),false);
  const active=webhookHarness({competing:[{id:5,provider:'TRIAL'}]});await active.process(event());
  assert.ok(active.queries.some(q=>q.sql.includes("provider = 'TRIAL'")&&q.sql.includes('UPDATE')));
});
test('duplicate event never calls Stripe or writes subscription again',async()=>{
  const h=webhookHarness({duplicate:true});const r=await h.process(event());assert.equal(r.duplicate,true);assert.equal(h.retrieved(),0);
});
test('Stripe failure rolls back event marker for webhook retry',async()=>{
  const h=webhookHarness({failure:true});await assert.rejects(h.process(event()),/Stripe unavailable/);assert.equal(h.queries.at(-1).sql,'ROLLBACK');
});
test('late invoice retains its original paid period instead of current subscription period',async()=>{
  const h=webhookHarness({invoice:true});await h.process(event('invoice.payment_succeeded',{
    id:'in_1',parent:{type:'subscription_details',subscription_details:{subscription:'sub_1'}},
    amount_paid:4900,currency:'mxn',period_start:5,period_end:95,lines:{data:[{period:{start:1,end:3}},{parent:{type:'subscription_item_details',subscription_item_details:{subscription:'sub_1',proration:false}},period:{start:10,end:90}}]},
  }));
  const args=h.queries.find(q=>q.sql.includes('INSERT INTO subscription_payments')).args;
  assert.equal(args[5].getTime(),10000);assert.equal(args[6].getTime(),90000);
});

test('deactivated plan cannot return a previously opened Checkout session',async()=>{
  const options={};const h=checkoutHarness(options);await h.run(input);options.noPlan=true;
  await assert.rejects(h.run(input),/PLAN_NOT_FOUND/);assert.equal(h.state.creates.length,1);
});
test('canceled Stripe still locally ACTIVE waits for reconciliation before another charge',async()=>{
  const h=checkoutHarness({remoteStatus:'canceled',existing:[{provider:'STRIPE',provider_subscription_id:'sub_1',status:'ACTIVE'}]});
  await assert.rejects(h.run(input),/CHECKOUT_RECONCILIATION_REQUIRED/);assert.equal(h.state.creates.length,0);
});
test('terminal synchronized Stripe allows a genuine resubscription',async()=>{
  const h=checkoutHarness({remoteStatus:'canceled',existing:[{provider:'STRIPE',provider_subscription_id:'sub_1',status:'CANCELED'}]});
  await h.run(input);assert.equal(h.state.creates.length,1);
});
test('native ACTIVE with delayed renewal synchronization still prevents another billing agreement',async()=>{
  const h=checkoutHarness({existing:[{provider:'GOOGLE_PLAY',status:'ACTIVE',current_period_end:new Date('2020-01-01')}]});
  await assert.rejects(h.run(input),/SUBSCRIPTION_ALREADY_EXISTS/);
});
function controllerHarness(error) {
  const mocks={
    '../services/googlePlayCatalog.service':{},'../services/googlePlayOwnership.service':{},
    '../services/googlePlayIdentity.service':{},'../services/subscriptions.service':{},
    '../services/googlePlaySubscription.service':{},'../services/stripeSubscriptionManagement.service':{},
    '../services/stripeCheckout.service':{isCheckoutPlanCode:value=>value===plan.code,
      createCheckoutSession:async data=>{assert.equal(data.userId,7);if(error)throw Error(error);return {sessionId:'cs_1',checkoutUrl:'https://checkout.stripe.test'};}},
  };
  const handlers=load('controllers/subscriptions.controller.ts',mocks);
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  return {run:body=>handlers.createSubscriptionCheckout({user:{id:7,email:input.email},body},res),res};
}
for(const code of ['SUBSCRIPTION_ALREADY_EXISTS','CHECKOUT_RECONCILIATION_REQUIRED']) {
  test('Checkout controller returns actionable 409 for '+code,async()=>{
    const h=controllerHarness(code);await h.run({planCode:plan.code,userId:99});assert.equal(h.res.statusCode,409);assert.equal(h.res.body.code,code);
  });
}
test('Checkout controller rejects missing body and invalid plans before Stripe',async()=>{
  const h=controllerHarness();await h.run(undefined);assert.equal(h.res.statusCode,400);
  await h.run({planCode:'forged'});assert.equal(h.res.statusCode,400);
});
