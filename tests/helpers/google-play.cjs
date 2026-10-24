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
  let inbox = new Map();
  const faults = {};
  const getCalls = [];
  let nextId = 100;
  const calls = [];
  const acknowledged = [];
  const purchases = new Map();
  const rowResult = rows => ({ rows, rowCount: rows.length });
  const client = {
    async query(sql, args = []) {
      sql = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql, args });
      if (sql === 'BEGIN') { snapshot = structuredClone({ subscriptions, owners, inbox }); return rowResult([]); }
      if (sql === 'COMMIT') return rowResult([]);
      if (sql === 'ROLLBACK') { ({ subscriptions, owners, inbox } = snapshot); return rowResult([]); }
      if (sql.includes('pg_advisory_xact_lock')) return rowResult([]);
      if (sql.startsWith('INSERT INTO google_play_rtdn_purchases')) {
        const row = inbox.get(args[0]);
        if (row) Object.assign(row, { notification_type: args[1], status: 'RECEIVED', version: row.version + 1 });
        else inbox.set(args[0], { purchase_token: args[0], notification_type: args[1], status: 'RECEIVED', version: 1, attempts: 0 });
        return rowResult([]);
      }
      if (sql.startsWith('UPDATE google_play_rtdn_purchases') && sql.includes('RETURNING version')) {
        const row = inbox.get(args[0]); row.version++; row.attempts++;
        row.last_attempt_at = Date.now();
        return rowResult([{ version: String(row.version) }]);
      }
      if (sql.startsWith('UPDATE google_play_rtdn_purchases')) {
        const row = inbox.get(args[0]);
        if (row.version === Number(args[1])) Object.assign(row, { status: args[2], reason: args[3], google_snapshot: args[4] ? JSON.parse(args[4]) : null, user_id: args[5] });
        return rowResult([]);
      }
      if (sql.includes('FROM google_play_rtdn_purchases')) return rowResult([...inbox.values()].filter(row => row.status !== 'PROCESSED').slice(0, args[0]));
      if (sql.includes('FROM users')) return rowResult([{ id: args[0] }]);
      if (sql.includes('FROM google_play_purchase_tokens')) return rowResult(owners.filter(row => Array.isArray(args[0]) ? args[0].includes(row.purchase_token) : args[0] === row.purchase_token).map(row => ({ ...row })));
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
        getCalls.push(token);
        if (faults.beforeGet) await faults.beforeGet(token);
        if (faults.google) throw faults.google;
        if (!purchases.has(token)) throw new Error('GOOGLE_REJECTED_TOKEN');
        return { data: purchases.get(token) };
      } },
      subscriptions: { acknowledge: async ({ token }) => { if (faults.ack) throw faults.ack; acknowledged.push(token); } },
    } },
  };
  const modules = new Map();
  function loadService(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const filename = path.resolve(__dirname, '../../src/services/' + name + '.service.ts');
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} }; modules.set(name, module);
    const localRequire = name => {
      if (name === '../lib/googlePlay') return google;
      if (name === '../lib/db') return { pool: { connect: async () => client }, query: (...args) => client.query(...args) };
      if (name === './googlePlaySubscription.service') return loadService('googlePlaySubscription');
      throw new Error('Unexpected dependency: ' + name);
    };
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { Date, Buffer, Error })(localRequire, module, module.exports);
    return module.exports;
  }
  const subscriptionService = loadService('googlePlaySubscription');
  const rtdnService = loadService('googlePlayRtdn');
  function purchase(token, linkedPurchaseToken, state = 'ACTIVE') {
    purchases.set(token, {
      subscriptionState: 'SUBSCRIPTION_STATE_' + state,
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      startTime: '2025-01-01T00:00:00Z',
      linkedPurchaseToken,
      lineItems: [{ productId: 'tocadapp_premium', offerDetails: { basePlanId: 'monthly' }, expiryTime: '2099-01-01T00:00:00Z', autoRenewingPlan: { autoRenewEnabled: true } }],
    });
  }
  return { sync: subscriptionService.syncGooglePlaySubscription, process: rtdnService.processGooglePlayRtdn, reconcile: rtdnService.reconcilePendingGooglePlayRtdn, faults, getCalls, inbox: () => inbox, purchase, purchases, calls, acknowledged,
    rows: () => subscriptions, owners: () => owners };
}

module.exports = { harness };
