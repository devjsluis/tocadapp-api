const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const express = require('express');
const root = path.resolve(__dirname, '../src');
const result = rows => ({ rows, rowCount: rows.length });
const secret = 'isolated-accounting-user-secret';
const passwordHash = bcrypt.hashSync('accounting-test-password', 4);

function harness(options = {}) {
  const state = { accounts: [{ id: 3, username: 'contador', display_name: 'Contador', password_hash: passwordHash, active: true }],
    sessions: new Map(), audits: [], queries: [], documents: [], settlements: [], payments: [], stripeCalls: [], transactions: [], payouts: [], invoices: [] };
  const pool = { async query(sql, args = []) {
    state.queries.push({ sql, args });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return result([]);
    if (sql.includes('FROM accounting_accounts WHERE username')) return result(state.accounts.filter(a => a.username === args[0]).map(a => ({ ...a })));
    if (sql.includes('FROM accounting_accounts WHERE id=')) {
      if (options.rotateBeforeLock) state.accounts[0].password_hash = 'rotated-before-lock';
      return result(state.accounts.filter(a => a.id === args[0] && a.active && a.password_hash === args[1]));
    }
    if (sql.startsWith('INSERT INTO accounting_sessions')) { state.sessions.set(args[0], { accountId: args[1], expires: Date.now() + 8 * 3600000 }); return result([]); }
    if (sql.startsWith('DELETE FROM accounting_sessions WHERE expires_at')) { for (const [token, s] of state.sessions) if (s.accountId === args[0] || s.expires <= Date.now()) state.sessions.delete(token); return result([]); }
    if (sql.startsWith('DELETE FROM accounting_sessions WHERE token_hash')) { state.sessions.delete(args[0]); return result([]); }
    if (sql.startsWith('DELETE FROM accounting_sessions WHERE account_id')) { for (const [token, s] of state.sessions) if (s.accountId === args[0]) state.sessions.delete(token); return result([]); }
    if (sql.includes('JOIN accounting_accounts a')) {
      const session = state.sessions.get(args[0]); const account = state.accounts.find(a => a.id === session?.accountId && a.active);
      return result(account && session.expires > Date.now() ? [account] : []);
    }
    if (sql.startsWith('INSERT INTO accounting_audit_log')) { state.audits.push(args); return result([]); }
    if (sql.startsWith('UPDATE accounting_accounts')) {
      const account = state.accounts.find(a => a.id === args[0]); if (!account) return result([]);
      if (sql.includes('password_hash')) { account.password_hash = args[1]; account.active = true; } else account.active = false;
      return result([{ id: account.id }]);
    }
    if (sql.startsWith('INSERT INTO accounting_accounts')) {
      const account = { id: state.accounts.length + 10, username: args[0], display_name: args[1], password_hash: args[2], active: true };
      state.accounts.push(account); return result([{ id: account.id, username: account.username, displayName: account.display_name, active: true }]);
    }
    if (sql.includes('FROM accounting_accounts ORDER')) return result(state.accounts.map(a => ({ id: a.id, username: a.username, displayName: a.display_name, active: a.active })));
    if (sql.includes('FROM users')) return result([{ id: 7, email: 'admin@example.invalid', role: options.musician ? 'musician' : 'admin', session_version: 1 }]);
    if (sql.includes("AT TIME ZONE")) return result([{ start: new Date('2026-11-01T06:00:00Z'), end: new Date('2026-12-01T06:00:00Z') }]);
    if (sql.includes('FROM subscription_payments')) return result(state.payments);
    if (sql.includes('FROM accounting_settlements')) return result(state.settlements);
    if (sql.startsWith('DELETE FROM accounting_documents') && options.restrictCode) throw Object.assign(Error('Restricted'), { code: options.restrictCode });
    if (sql.includes('FROM accounting_documents WHERE id=') && sql.includes('content,')) {
      return result(state.documents.filter(d => d.id === args[0]).map(d => ({ ...d, month: '2026-11' })));
    }
    if (sql.includes('FROM accounting_documents WHERE id=')) return result(state.documents.filter(d => d.id === args[0] && d.month === args[1] && d.kind === args[2]));
    if (sql.includes('FROM accounting_documents WHERE month=')) return result(state.documents.map(({ content, ...d }) => d));
    if (sql.startsWith('INSERT INTO accounting_documents')) {
      const doc = { id: state.documents.length + 1, month: args[0], kind: args[1], filename: args[2], content_type: args[3], content: args[4], sha256: args[5] };
      state.documents.push(doc); return result([{ id: doc.id }]);
    }
    if (sql.startsWith('INSERT INTO accounting_settlements')) return result([{ id: 1 }]);
    if (sql.includes('FROM accounting_audit_log')) return result([]);
    throw Error('Unexpected SQL in isolated accounting test: ' + sql);
  }, async connect() { return { query: pool.query, release() {} }; } };
  const iterable = (kind, rows) => params => ({ async *[Symbol.asyncIterator]() {
    state.stripeCalls.push({ kind, params }); if (options.stripeUnavailable) throw Error('Stripe unavailable');
    for (const row of rows) yield row;
  } });
  const stripe = { balanceTransactions: { list: iterable('balance', state.transactions) }, payouts: { list: iterable('payouts', state.payouts) },
    invoices: { list: iterable('invoices', state.invoices), retrieve: async id => { state.stripeCalls.push({ kind: 'invoice', id }); return options.oldInvoice; } } };
  const cache = new Map();
  const env = { NODE_ENV: options.production ? 'production' : 'test', STRIPE_SECRET_KEY: 'sk_test_accounting_no_network' };
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { process: { env }, console, Buffer, URL, Error, Date, setTimeout })(name => {
      if (name.endsWith('/lib/db')) return { pool };
      if (name.endsWith('/lib/stripe')) return { stripe };
      if (name.endsWith('/lib/authConfig')) return { JWT_SECRET: secret };
      if (name === 'bcrypt') return { ...bcrypt, hashSync: () => passwordHash };
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
      return require(name);
    }, mod, mod.exports);
    return mod.exports;
  }
  const app = express(); app.use(express.json());
  const routes = load('routes/accounting.routes.ts');
  app.use('/accounting', routes.accountingRouter); app.use('/admin/accounting', routes.adminAccountingRouter);
  app.get('/musician-only', load('middleware/auth.ts').authMiddleware, (_req, res) => res.json({ ok: true }));
  const adminToken = jwt.sign({ id: 7, type: 'access', sessionVersion: 1 }, secret);
  return { state, load, app, adminToken };
}
async function withServer(h, run) {
  const server = h.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, options = {}) => {
    const response = await fetch(origin + route, { ...options, headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', ...options.headers } });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, headers: response.headers, body };
  };
  const login = async () => {
    const response = await request('/accounting/login', { method: 'POST', body: JSON.stringify({ username: 'contador', password: 'accounting-test-password' }) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  };
  try { await run({ request, login }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('accountant access uses HttpOnly cookie, hashed session storage, and no musician tokens', async () => {
  const h = harness(); await withServer(h, async ({ request, login }) => {
    const cookie = await login(); const raw = cookie.split('=')[1];
    assert.equal(raw.length, 64); assert.equal(h.state.sessions.has(raw), false);
    assert.ok(h.state.sessions.has(crypto.createHash('sha256').update(raw).digest('hex')));
    const current = await request('/accounting/session', { headers: { Cookie: cookie } });
    assert.equal(current.status, 200); assert.equal(current.body.account.username, 'contador');
    assert.match(current.headers.get('cache-control'), /no-store/);
    assert.equal((await request('/musician-only', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await request('/musician-only', { headers: { Authorization: 'Bearer ' + raw } })).status, 401);
    assert.equal((await request('/accounting/session', { headers: { Authorization: 'Bearer ' + h.adminToken } })).status, 401);
    assert.equal((await request('/admin/accounting/accounts', { headers: { Cookie: cookie } })).status, 401);
    assert.equal(JSON.stringify(current.body).includes(raw), false);
  });
});
test('production accounting cookie is Secure, HttpOnly, SameSite Strict and host-only', async () => {
  const h = harness({ production: true }); await withServer(h, async ({ request }) => {
    const response = await request('/accounting/login', { method: 'POST', headers: { Origin: 'https://tocadapp.com' }, body: JSON.stringify({ username: 'contador', password: 'accounting-test-password' }) });
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^__Host-tocadapp-accounting=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /Domain=/);
  });
});
test('cross-site login is rejected before creating any accounting session', async () => {
  const h = harness(); await withServer(h, async ({ request }) => {
    const response = await request('/accounting/login', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: JSON.stringify({ username: 'contador', password: 'accounting-test-password' }) });
    assert.equal(response.status, 403); assert.equal(h.state.sessions.size, 0);
  });
});
test('wrong credentials and inactive accounts do not issue cookies', async () => {
  const h = harness(); await withServer(h, async ({ request }) => {
    for (const credentials of [{ username: 'contador', password: 'wrong' }, { username: 'unknown', password: 'wrong' }]) {
      const response = await request('/accounting/login', { method: 'POST', body: JSON.stringify(credentials) });
      assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
    }
    h.state.accounts[0].active = false;
    assert.equal((await request('/accounting/login', { method: 'POST', body: JSON.stringify({ username: 'contador', password: 'accounting-test-password' }) })).status, 401);
    assert.equal(h.state.sessions.size, 0); assert.equal(JSON.stringify(h.state.audits).includes('wrong'), false);
  });
});
test('revocation immediately invalidates an already issued accountant session', async () => {
  const h = harness(); await withServer(h, async ({ request, login }) => {
    const cookie = await login();
    assert.equal((await request('/admin/accounting/accounts/3/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + h.adminToken } })).status, 200);
    assert.equal(h.state.sessions.size, 0);
    assert.equal((await request('/accounting/session', { headers: { Cookie: cookie } })).status, 401);
  });
});
test('password rotation revokes previous sessions, hashes the new secret and rejects the old password', async () => {
  const h = harness(); await withServer(h, async ({ request, login }) => {
    const cookie = await login();
    const rotated = await request('/admin/accounting/accounts/3/rotate', { method: 'POST', headers: { Authorization: 'Bearer ' + h.adminToken } });
    assert.equal(rotated.status, 200); assert.ok(rotated.body.password.length >= 24);
    assert.notEqual(h.state.accounts[0].password_hash, rotated.body.password); assert.ok(await bcrypt.compare(rotated.body.password, h.state.accounts[0].password_hash));
    assert.equal((await request('/accounting/session', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await request('/accounting/login', { method: 'POST', body: JSON.stringify({ username: 'contador', password: 'accounting-test-password' }) })).status, 401);
    const next = await request('/accounting/login', { method: 'POST', body: JSON.stringify({ username: 'contador', password: rotated.body.password }) });
    assert.equal(next.status, 200); assert.equal(JSON.stringify(h.state.audits).includes(rotated.body.password), false);
  });
});
test('a musician cannot create accounting credentials even by forging admin fields', async () => {
  const h = harness({ musician: true }); await withServer(h, async ({ request }) => {
    const response = await request('/admin/accounting/accounts', { method: 'POST', headers: { Authorization: 'Bearer ' + h.adminToken }, body: JSON.stringify({ username: 'forged', displayName: 'Forged', role: 'admin' }) });
    assert.equal(response.status, 403); assert.equal(h.state.accounts.length, 1);
  });
});
test('accountants can download an audited document but cannot upload, edit or revoke access', async () => {
  const h = harness(); h.state.documents.push({ id: 9, filename: 'respaldo.pdf', content_type: 'application/pdf', content: Buffer.from('%PDF-test') });
  await withServer(h, async ({ request, login }) => {
    const cookie = await login();
    const doc = await request('/accounting/documents/9', { headers: { Cookie: cookie } });
    assert.equal(doc.status, 200); assert.match(doc.headers.get('content-disposition'), /attachment/); assert.equal(doc.body, '%PDF-test');
    assert.ok(h.state.audits.some(row => row.includes('DOWNLOAD_DOCUMENT')));
    assert.equal((await request('/admin/accounting/documents', { method: 'POST', headers: { Cookie: cookie }, body: '{}' })).status, 401);
    assert.equal((await request('/accounting/documents/9', { method: 'DELETE', headers: { Cookie: cookie } })).status, 404);
  });
});
test('expired sessions and logout cannot continue reading reports', async () => {
  const h = harness(); await withServer(h, async ({ request, login }) => {
    const cookie = await login(); for (const session of h.state.sessions.values()) session.expires = 0;
    assert.equal((await request('/accounting/report?month=2026-11', { headers: { Cookie: cookie } })).status, 401);
    const again = await login(); assert.equal((await request('/accounting/logout', { method: 'POST', headers: { Cookie: again } })).status, 200);
    assert.equal((await request('/accounting/session', { headers: { Cookie: again } })).status, 401);
  });
});
test('invalid periods are rejected without querying Stripe', async () => {
  const h = harness(); await withServer(h, async ({ request, login }) => {
    const cookie = await login();
    for (const month of ['2026-00', '2026-13', '2026-11-01', '2026-1', "2026-11';DROP TABLE users;--"])
      assert.equal((await request('/accounting/report?month=' + encodeURIComponent(month), { headers: { Cookie: cookie } })).status, 400);
    assert.equal(h.state.stripeCalls.length, 0);
  });
});
test('Stripe outage stays unavailable, never a false zero, and native providers require settlements', async () => {
  const h = harness({ stripeUnavailable: true });
  const report = await h.load('services/accountingReport.service.ts').accountingReport('2026-11');
  assert.equal(report.stripe.status, 'unavailable'); assert.equal('totals' in report.stripe, false);
  assert.deepEqual(Array.from(report.pendingProviders), ['APPLE', 'GOOGLE_PLAY']);
  assert.match(h.load('services/accountingReport.service.ts').reportCsv(report), /NO_DISPONIBLE/);
});
test('cashflow summary keeps currencies separate and does not count payouts twice', () => {
  const h = harness(); const { summarizeStripe } = h.load('services/accountingReport.service.ts');
  const rows = [
    { type: 'charge', category: 'charge', currency: 'MXN', amountMinor: 7900, feeMinor: 400, netMinor: 7500 },
    { type: 'refund', category: 'refund', currency: 'MXN', amountMinor: -1000, feeMinor: 0, netMinor: -1000 },
    { type: 'payout', category: 'payout', currency: 'MXN', amountMinor: -6500, feeMinor: 0, netMinor: -6500 },
    { type: 'charge', category: 'charge', currency: 'USD', amountMinor: 500, feeMinor: 50, netMinor: 450 },
  ];
  const summary = summarizeStripe(rows, [{ status: 'paid', currency: 'MXN', amountMinor: 6500 }, { status: 'failed', currency: 'MXN', amountMinor: 9000 }]);
  const mxn = summary.find(s => s.currency === 'MXN'); assert.equal(mxn.grossMinor, 7900); assert.equal(mxn.refundsMinor, 1000); assert.equal(mxn.netMinor, 6500); assert.equal(mxn.depositsMinor, 6500);
  assert.equal(summary.find(s => s.currency === 'USD').netMinor, 450);
});
test('month boundaries use Mexico timezone and include invoices issued earlier but paid this month', async () => {
  const oldInvoice = { id: 'in_older', number: 'A1', status: 'paid', status_transitions: { paid_at: Date.parse('2026-11-01T06:00:00Z') / 1000 }, currency: 'mxn', amount_paid: 7900, invoice_pdf: 'https://pay.stripe.com/invoice/example/pdf' };
  const h = harness({ oldInvoice });
  h.state.payments.push({ id: 1, provider: 'STRIPE', amount: 7900, currency: 'MXN', paid_at: new Date('2026-11-01T06:00:00Z'), reference: 'in_older' });
  const report = await h.load('services/accountingReport.service.ts').accountingReport('2026-11');
  assert.equal(report.stripe.status, 'available'); assert.equal(report.stripe.invoices[0].id, 'in_older');
  assert.equal(h.state.stripeCalls.find(c => c.kind === 'balance').params.created.gte, Date.parse('2026-11-01T06:00:00Z') / 1000);
  assert.equal(h.state.stripeCalls.find(c => c.kind === 'payouts').params.arrival_date.lt, Date.parse('2026-12-01T06:00:00Z') / 1000);
  assert.ok(h.state.queries.some(q => q.args.includes('America/Mexico_City')));
});
test('CSV prevents formula injection and unsafe Stripe PDF links are rejected', () => {
  const h = harness(); const { csvCell, safeInvoicePdf } = h.load('services/accountingReport.service.ts');
  for (const value of ['=WEBSERVICE("https://example.test")', ' +SUM(A1)', '@SUM(A1)', '\t=1']) assert.match(csvCell(value), /^"'/);
  assert.equal(csvCell(-42), '"-42"'); assert.equal(safeInvoicePdf('javascript:alert(1)'), null); assert.equal(safeInvoicePdf('https://pay.stripe.com.attacker.test/pdf'), null);
  assert.equal(safeInvoicePdf('https://pay.stripe.com/invoice/test/pdf'), 'https://pay.stripe.com/invoice/test/pdf');
});
test('documents reject path traversal, oversized content, executable disguises and XML entities', () => {
  const h = harness(); const { validateAccountingDocument: validate } = h.load('services/accountingDocuments.service.ts');
  assert.equal(validate('2026-11', 'CFDI', 'original.pdf', 'application/pdf', Buffer.from('%PDF-1.4')).mime, 'application/pdf');
  for (const [filename, mime, content] of [['../original.pdf', 'application/pdf', Buffer.from('%PDF-1.4')], ['fake.pdf', 'application/pdf', Buffer.from('<script>bad</script>')],
    ['factura.xml', 'application/xml', Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><x>&e;</x>')], ['huge.pdf', 'application/pdf', Buffer.alloc(10485761)]])
    assert.throws(() => validate('2026-11', 'CFDI', filename, mime, content), /INVALID_DOCUMENT/);
});
test('native settlements require matching provider/month evidence and exact integer amounts', async () => {
  const h = harness(); const { validateSettlement, saveSettlement } = h.load('services/accountingDocuments.service.ts');
  const data = { month: '2026-11', provider: 'APPLE', currency: 'MXN', grossMinor: 10000, feesMinor: 1500, refundsMinor: 1000, withheldMinor: 500, depositsMinor: 7000, documentId: 3, notes: '' };
  assert.equal(validateSettlement(data).netMinor, 7000);
  assert.throws(() => validateSettlement({ ...data, grossMinor: 10.5 }), /INVALID_SETTLEMENT/);
  h.state.documents.push({ id: 3, month: '2026-10-01', kind: 'APPLE' });
  await assert.rejects(saveSettlement(7, validateSettlement(data)), /INVALID_SETTLEMENT_DOCUMENT/);
  h.state.documents[0].month = '2026-11-01'; h.state.documents[0].kind = 'BANK';
  await assert.rejects(saveSettlement(7, validateSettlement(data)), /INVALID_SETTLEMENT_DOCUMENT/);
  h.state.documents[0].kind = 'APPLE'; assert.equal((await saveSettlement(7, validateSettlement(data))).id, 1);
});
test('a password rotated between verification and session creation cannot issue a new session', async () => {
  const h = harness({ rotateBeforeLock: true });
  const session = await h.load('services/accountingAuth.service.ts').loginAccountant('contador', 'accounting-test-password');
  assert.equal(session, null); assert.equal(h.state.sessions.size, 0);
});
for (const restrictCode of ['23503', '23001']) {
  test('referenced evidence returns an explicit conflict for PostgreSQL constraint ' + restrictCode, async () => {
    const h = harness({ restrictCode });
    await withServer(h, async ({ request }) => {
      const response = await request('/admin/accounting/documents/9', { method: 'DELETE', headers: { Authorization: 'Bearer ' + h.adminToken } });
      assert.equal(response.status, 409); assert.match(response.body.error, /respalda una conciliación/);
    });
  });
}
test('accounting report never queries musicians personal gigs, bands, or financial movements', async () => {
  const h = harness();
  h.state.payments.push({ id: 99, provider: 'MANUAL', amount: 7900, currency: 'MXN', paid_at: new Date('2026-11-05T12:00:00Z'), reference: 'manual-test', email: 'must-not-be-returned@example.invalid' });
  const report = await h.load('services/accountingReport.service.ts').accountingReport('2026-11');
  assert.equal(report.manual.length, 1); assert.doesNotMatch(JSON.stringify(report), /must-not-be-returned/);
  assert.equal(h.state.queries.some(q => /FROM (gigs|bands|financial_movements|musicians|expenses)\b/.test(q.sql)), false);
});
