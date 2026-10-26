const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { harness } = require('./helpers/google-play.cjs');

// Explicit opt-in, never dotenv/DATABASE_URL. Only a loopback isolated test DB.
const connectionString = process.env.GOOGLE_PLAY_TEST_DATABASE_URL;
test('isolated PostgreSQL migrations and acknowledgement concurrency', {skip: !connectionString}, async t => {
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/tocadapp_ack_test');
  const schema = 'ack_test_' + process.pid + '_' + Date.now();
  const admin = new Pool({connectionString});
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({connectionString, options: '-c search_path=' + schema, max: 8});
  t.after(async () => {
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY, deleted_at TIMESTAMPTZ);
    CREATE TABLE plans(id SERIAL PRIMARY KEY, code TEXT, active BOOLEAN, price_amount INTEGER, currency TEXT);
    CREATE TABLE subscriptions(
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), plan_id INTEGER,
      status TEXT, provider TEXT, provider_customer_id TEXT, provider_subscription_id TEXT UNIQUE,
      price_amount INTEGER, currency TEXT, started_at TIMESTAMPTZ, current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ, cancel_at_period_end BOOLEAN, canceled_at TIMESTAMPTZ, ended_at TIMESTAMPTZ);
    CREATE UNIQUE INDEX one_open_subscription ON subscriptions(user_id) WHERE status IN ('PENDING','ACTIVE','PAST_DUE');
    INSERT INTO users(id) VALUES(1),(2);
    INSERT INTO plans(code,active,price_amount,currency) VALUES('TOCADAPP_MONTHLY',true,7900,'MXN');
    INSERT INTO subscriptions(user_id,provider,provider_subscription_id,status) VALUES(1,'GOOGLE_PLAY','historical','EXPIRED');`);
  for (const file of ['035_google_play_purchase_tokens.sql', '036_google_play_rtdn_purchases.sql', '037_google_play_acknowledgements.sql', '038_google_play_billing_identities.sql', '039_google_play_purchase_recovery.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname,'../src/migrations',file),'utf8'));
  }
  await t.test('035/036/037 backfill historical tokens without granting access', async () => {
    assert.equal((await pool.query('SELECT status FROM google_play_acknowledgements')).rows[0].status,'PENDING');
    const h = harness([], {pool}); h.purchase('historical');
    assert.equal((await h.reconcileAck()).completed,1);
    assert.equal((await pool.query('SELECT status FROM subscriptions')).rows[0].status,'EXPIRED');
    assert.equal((await pool.query('SELECT count(*) FROM google_play_rtdn_purchases')).rows[0].count,'0');
  });
  async function fresh() {
    await pool.query('TRUNCATE google_play_purchase_recovery, google_play_acknowledgements, google_play_rtdn_purchases, google_play_purchase_tokens, subscriptions');
    const h = harness([], {pool});
    h.identities.clear();
    for (const row of (await pool.query('SELECT * FROM google_play_billing_identities')).rows) h.identities.set(row.obfuscated_account_id, row.user_id);
    h.identify = (token, userId = 1) => { h.purchases.get(token).externalAccountIdentifiers = { obfuscatedExternalAccountId: [...h.identities].find(([,id]) => id === userId)[0] }; };
    return h;
  }
  async function failed(h) {
    h.purchase('paid'); h.identify('paid'); h.faults.ack = Error('ACK_TIMEOUT');
    await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}), {message:'ACK_TIMEOUT'});
    delete h.faults.ack;
  }
  await t.test('durable post-COMMIT failure is recovered without RTDN or entitlement writes', async () => {
    const h = await fresh(); await failed(h);
    assert.equal((await pool.query('SELECT status FROM google_play_acknowledgements')).rows[0].status,'RETRY');
    const before = (await pool.query('SELECT * FROM subscriptions')).rows;
    assert.equal(before[0].status,'ACTIVE');
    assert.equal((await h.reconcileAck()).completed,1);
    assert.deepEqual((await pool.query('SELECT * FROM subscriptions')).rows,before);
    assert.deepEqual(h.acknowledged,['paid']);
    assert.equal((await pool.query('SELECT count(*) FROM google_play_rtdn_purchases')).rows[0].count,'0');
    assert.equal((await h.reconcileAck()).completed,0);
  });
  await t.test('two workers serialize the same obligation and acknowledge exactly once', async () => {
    const h = await fresh(); await failed(h);
    let entered, release;
    const arrived = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    h.faults.beforeAck = async () => { entered(); await gate; };
    const first = h.ack('paid'); await arrived;
    const second = h.ack('paid');
    try {
      let blocked = false;
      for (let i=0; i<100; i++) {
        const result = await pool.query("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        if (Number(result.rows[0].count)>0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve,10));
      }
      assert.equal(blocked,true);
    } finally { release(); }
    assert.deepEqual(await Promise.all([first,second]),[true,true]);
    assert.deepEqual(h.acknowledged,['paid']);
    const row = (await pool.query('SELECT status, attempts FROM google_play_acknowledgements')).rows[0];
    assert.equal(row.status,'COMPLETED'); assert.equal(row.attempts,2);
  });
  await t.test('replacement cannot overtake acknowledgement while its token lock is held', async () => {
    const h = await fresh(); await failed(h); h.purchase('successor','paid');
    let entered, release;
    const arrived = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    h.faults.beforeAck = async token => { if (token === 'paid') { entered(); await gate; } };
    const first = h.ack('paid'); await arrived;
    let replacementDone = false;
    const replacement = h.sync({userId:1,purchaseToken:'successor'}).then(result => { replacementDone = true; return result; });
    try {
      let blocked = false;
      for (let i=0; i<100; i++) {
        const result = await pool.query("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        if (Number(result.rows[0].count)>0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve,10));
      }
      assert.equal(blocked,true); assert.equal(replacementDone,false);
    } finally { release(); }
    await Promise.all([first,replacement]);
    assert.deepEqual(h.acknowledged,['paid','successor']);
    assert.equal((await pool.query("SELECT replaced_by_token FROM google_play_purchase_tokens WHERE purchase_token='paid'")).rows[0].replaced_by_token,'successor');
  });
  await t.test('a completed replacement excludes its still-unacknowledged predecessor', async () => {
    const h = await fresh(); await failed(h); h.purchase('successor','paid');
    await h.sync({userId:1,purchaseToken:'successor'});
    assert.equal(await h.ack('paid'),false);
    assert.deepEqual(h.acknowledged,['successor']);
    assert.equal((await pool.query("SELECT status FROM google_play_acknowledgements WHERE purchase_token='paid'")).rows[0].status,'SKIPPED');
  });
  await t.test('pending, expired, wrong owner and deleted user are excluded with real SQL', async () => {
    for (const scenario of ['PENDING','EXPIRED','owner','deleted']) {
      const h = await fresh(); await failed(h);
      if (['PENDING','EXPIRED'].includes(scenario)) h.purchase('paid',undefined,scenario);
      if (scenario === 'PENDING') { delete h.purchases.get('paid').startTime; delete h.purchases.get('paid').lineItems[0].expiryTime; }
      if (scenario === 'owner') await pool.query("UPDATE google_play_purchase_tokens SET user_id=2 WHERE purchase_token='paid'");
      if (scenario === 'deleted') await pool.query('UPDATE users SET deleted_at=NOW() WHERE id=1');
      assert.equal(await h.ack('paid'),false); assert.deepEqual(h.acknowledged,[]);
      await pool.query('UPDATE users SET deleted_at=NULL');
    }
  });
  await t.test('historical discovery and a subscription writer do not deadlock on the queue FK', async () => {
    await fresh();
    await pool.query(`INSERT INTO subscriptions(user_id,provider,provider_subscription_id,status) VALUES(1,'GOOGLE_PLAY','paid','ACTIVE');
      INSERT INTO google_play_purchase_tokens(purchase_token,user_id) VALUES('paid',1)`);
    let entered, release, intercepted = false;
    const arrived = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const proxy = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: async (...args) => {
            const result = await client.query(...args);
            if (!intercepted && args[0].includes('FROM google_play_purchase_tokens') && args[0].includes('FOR UPDATE')) {
              intercepted = true; entered(); await gate;
            }
            return result;
          },
        };
      },
    };
    const h = harness([], {pool:proxy}); h.purchase('paid');
    const writer = h.sync({userId:1,purchaseToken:'paid'}); await arrived;
    const discovery = h.reconcileAck();
    try {
      let blocked = false;
      for (let i=0; i<100; i++) {
        const result = await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO google_play_acknowledgements%'");
        if (Number(result.rows[0].count)>0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve,10));
      }
      assert.equal(blocked,true);
    } finally { release(); }
    await Promise.all([writer,discovery]);
    assert.deepEqual(h.acknowledged,['paid']);
  });
  await t.test('038 backfills permanent identities, creates them for new users, and prevents reuse', async () => {
    const identities = (await pool.query('SELECT * FROM google_play_billing_identities ORDER BY user_id')).rows;
    assert.equal(identities.length,2);
    assert.notEqual(identities[0].obfuscated_account_id,identities[1].obfuscated_account_id);
    assert.match(identities[0].obfuscated_account_id,/^[0-9a-f]{32}$/);
    await pool.query('INSERT INTO users(id) VALUES(3)');
    assert.equal((await pool.query('SELECT count(*) FROM google_play_billing_identities')).rows[0].count,'3');
    await assert.rejects(pool.query('UPDATE google_play_billing_identities SET user_id=4 WHERE user_id=3'));
    await assert.rejects(pool.query('DELETE FROM google_play_billing_identities WHERE user_id=3'));
    await assert.rejects(pool.query('TRUNCATE google_play_billing_identities'));
    await pool.query('UPDATE users SET deleted_at=NOW() WHERE id=3');
    assert.equal((await pool.query('SELECT count(*) FROM google_play_billing_identities WHERE user_id=3')).rows[0].count,'1');
    assert.deepEqual((await pool.query('SELECT * FROM google_play_billing_identities WHERE user_id IN (1,2) ORDER BY user_id')).rows,identities);
  });
  await t.test('competing authenticated accounts cannot steal an identified first purchase', async () => {
    const h=await fresh();h.purchase('race');h.identify('race',1);
    const results=await Promise.allSettled([h.sync({userId:1,purchaseToken:'race'}),h.sync({userId:2,purchaseToken:'race'})]);
    assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
    assert.equal(results[1].reason.message,'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED');
    const owners=(await pool.query('SELECT user_id FROM google_play_purchase_tokens')).rows;
    assert.deepEqual(owners,[{user_id:1}]);assert.deepEqual(h.acknowledged,['race']);
    assert.equal((await pool.query('SELECT user_id FROM subscriptions')).rows[0].user_id,1);
    // A stale/failed request journal never changes canonical ownership.
    await h.reconcilePurchases();
    assert.equal((await pool.query('SELECT user_id,status FROM google_play_purchase_recovery')).rows[0].status,'PROCESSED');
  });
  await t.test('two same-account verification writers acknowledge one transaction once', async () => {
    const h=await fresh();h.purchase('race');h.identify('race');
    await Promise.all([h.sync({userId:1,purchaseToken:'race'}),h.sync({userId:1,purchaseToken:'race'})]);
    assert.deepEqual(h.acknowledged,['race']);
    assert.equal((await pool.query('SELECT count(*) FROM subscriptions')).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM google_play_purchase_recovery')).rows[0].count,'1');
  });
  await t.test('unidentified v16 first purchases remain unowned under concurrent claims', async () => {
    const h=await fresh();h.purchase('legacy');
    const results=await Promise.allSettled([h.sync({userId:1,purchaseToken:'legacy'}),h.sync({userId:2,purchaseToken:'legacy'})]);
    assert.ok(results.every(r=>r.status==='rejected' && r.reason.message==='GOOGLE_PLAY_OWNER_UNVERIFIABLE'));
    assert.equal((await pool.query('SELECT count(*) FROM subscriptions')).rows[0].count,'0');
    assert.equal((await pool.query('SELECT count(*) FROM google_play_purchase_tokens')).rows[0].count,'0');
    assert.deepEqual(h.acknowledged,[]);
  });
  await t.test('pending without dates survives a new service process and cancellation without entitlements', async () => {
    const h=await fresh();h.purchase('pending',undefined,'PENDING');h.identify('pending');
    delete h.purchases.get('pending').startTime;delete h.purchases.get('pending').lineItems[0].expiryTime;
    assert.equal((await h.sync({userId:1,purchaseToken:'pending'})).purchaseResult.state,'PENDING');
    assert.equal((await pool.query('SELECT count(*) FROM subscriptions')).rows[0].count,'0');
    // A fresh harness has no in-memory journal; the same PostgreSQL work is enough.
    const recovered=harness([], {pool});recovered.purchases.set('pending',structuredClone(h.purchases.get('pending')));
    recovered.purchases.get('pending').subscriptionState='SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';
    assert.equal((await recovered.reconcilePurchases()).processed,1);
    const row=(await pool.query('SELECT * FROM google_play_purchase_recovery')).rows[0];
    assert.equal(row.status,'PROCESSED');assert.equal(row.purchase_state,'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED');
    assert.equal(row.user_id,1);assert.equal((await pool.query('SELECT count(*) FROM subscriptions')).rows[0].count,'0');
    assert.deepEqual(recovered.acknowledged,[]);
  });
  await t.test('pending replacement cancellation preserves the old paid subscription in PostgreSQL', async () => {
    const h=await fresh();h.purchase('paid');h.identify('paid');await h.sync({userId:1,purchaseToken:'paid'});
    const before=(await pool.query('SELECT * FROM subscriptions')).rows;
    h.purchase('pending','paid','PENDING');h.identify('pending');
    delete h.purchases.get('pending').startTime;delete h.purchases.get('pending').lineItems[0].expiryTime;
    await h.sync({userId:1,purchaseToken:'pending'});
    h.purchases.get('pending').subscriptionState='SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';
    await h.reconcilePurchases();
    assert.deepEqual((await pool.query('SELECT * FROM subscriptions')).rows,before);
    assert.equal((await pool.query("SELECT replaced_by_token FROM google_play_purchase_tokens WHERE purchase_token='paid'")).rows[0].replaced_by_token,null);
    assert.deepEqual(h.acknowledged,['paid']);
  });
  await t.test('subscription rollback cannot leave a queue entry', async () => {
    const h = await fresh(); h.purchase('paid'); h.identify('paid');
    await pool.query(`CREATE FUNCTION reject_ack_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'queue unavailable'; END $$;
      CREATE TRIGGER reject_ack BEFORE INSERT ON google_play_acknowledgements FOR EACH ROW EXECUTE FUNCTION reject_ack_insert()`);
    await assert.rejects(h.sync({userId:1,purchaseToken:'paid'}));
    assert.equal((await pool.query('SELECT count(*) FROM subscriptions')).rows[0].count,'0');
    assert.equal((await pool.query('SELECT count(*) FROM google_play_purchase_tokens')).rows[0].count,'0');
    assert.deepEqual(h.acknowledged,[]);
    await pool.query('DROP TRIGGER reject_ack ON google_play_acknowledgements');
  });
  await t.test('concurrent resubscription conflict preserves the replacement and durable recovery evidence', async () => {
    const h=await fresh();h.purchase('old');h.identify('old');
    await h.sync({userId:1,purchaseToken:'old'});
    h.purchase('replacement','old');await h.sync({userId:1,purchaseToken:'replacement'});
    const before=(await pool.query('SELECT * FROM subscriptions ORDER BY id')).rows;
    const owners=(await pool.query('SELECT * FROM google_play_purchase_tokens ORDER BY purchase_token')).rows;
    const acknowledged=[...h.acknowledged];
    h.purchase('resubscription');
    h.purchases.get('resubscription').outOfAppPurchaseContext={expiredPurchaseToken:'old'};
    const results=await Promise.allSettled([
      h.sync({userId:1,purchaseToken:'resubscription'}),
      h.sync({userId:1,purchaseToken:'resubscription'}),
      h.sync({userId:2,purchaseToken:'resubscription'}),
      h.sync({userId:1,purchaseToken:'replacement'}),
    ]);
    assert.ok(results.slice(0,3).every(r=>r.status==='rejected' && r.reason.message==='GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'));
    assert.equal(results[3].status,'fulfilled');
    assert.equal((await h.reconcilePurchases()).deferred,1);
    assert.deepEqual((await pool.query('SELECT * FROM subscriptions ORDER BY id')).rows,before);
    assert.deepEqual((await pool.query('SELECT * FROM google_play_purchase_tokens ORDER BY purchase_token')).rows,owners);
    assert.deepEqual(h.acknowledged,acknowledged);
    const work=(await pool.query("SELECT * FROM google_play_purchase_recovery WHERE purchase_token='resubscription'")).rows[0];
    assert.equal(work.status,'DEFERRED');assert.equal(work.reason,'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED');
    assert.ok(work.attempts>=3);
    assert.equal((await pool.query("SELECT count(*) FROM google_play_acknowledgements WHERE purchase_token='resubscription'")).rows[0].count,'0');
  });

  for(const product of ['tocadapp_premium','tocadapp_premium_v2']) for(const base of ['monthly','yearly']) {
    await t.test('real SQL concurrent verification and recovery '+product+'/'+base,async()=>{
      const h=await fresh();
      await pool.query("INSERT INTO plans(code,active,price_amount,currency) SELECT 'TOCADAPP_YEARLY',true,69900,'MXN' WHERE NOT EXISTS(SELECT 1 FROM plans WHERE code='TOCADAPP_YEARLY')");
      h.purchase('catalog-race');h.identify('catalog-race');
      Object.assign(h.purchases.get('catalog-race').lineItems[0],{productId:product,offerDetails:{basePlanId:base}});
      await Promise.all([h.sync({userId:1,purchaseToken:'catalog-race'}),h.sync({userId:1,purchaseToken:'catalog-race'})]);
      assert.deepEqual(h.acknowledged,['catalog-race']);assert.deepEqual(h.acknowledgementProducts,[product]);
      assert.equal((await pool.query('SELECT count(*) FROM subscriptions')).rows[0].count,'1');
      assert.equal((await pool.query('SELECT status FROM google_play_acknowledgements')).rows[0].status,'COMPLETED');
      await h.reconcilePurchases();
      await assert.rejects(h.sync({userId:2,purchaseToken:'catalog-race'}),{message:'GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED'});
    });
  }

});
