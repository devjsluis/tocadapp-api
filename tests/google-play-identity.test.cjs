const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function identityService(query) {
  const file = path.join(__dirname, '../src/services/googlePlayIdentity.service.ts');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { Error })(
    name => { assert.equal(name, '../lib/db'); return { query }; }, module, module.exports,
  );
  return module.exports;
}

test('identity lookup returns only the authenticated account identity, without rotating it', async () => {
  const calls = [];
  const service = identityService(async (sql, args) => {
    calls.push({ sql, args });
    return { rows: args[0] === 7 ? [{ obfuscated_account_id: 'a'.repeat(32) }] : [] };
  });
  for (let i = 0; i < 2; i++) assert.equal((await service.getGooglePlayBillingIdentity(7)).obfuscatedAccountId, 'a'.repeat(32));
  await assert.rejects(service.getGooglePlayBillingIdentity(8), { message: 'USER_NOT_FOUND' });
  assert.ok(calls.every(call => call.sql.startsWith('SELECT') && call.sql.includes('u.deleted_at IS NULL')));
});

test('identity owner is resolved through the server mapping, never interpreted as a user ID', async () => {
  const service = identityService(async (_, [identity]) => ({ rows: identity === 'a'.repeat(32) ? [{ user_id: 7 }] : [] }));
  assert.equal(await service.findGooglePlayBillingIdentityOwner('a'.repeat(32)), 7);
  assert.equal(await service.findGooglePlayBillingIdentityOwner('7'), null);
  assert.equal(await service.findGooglePlayBillingIdentityOwner('user@example.invalid'), null);
});
