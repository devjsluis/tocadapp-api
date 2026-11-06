const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function setup({ missing = false, failure = false } = {}) {
  const calls = [];
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/controllers/bands.controller.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})')(name => {
    if (name === '../lib/db') return { pool: { query: async (sql, args) => {
      calls.push([sql, args]);
      if (failure) throw Error('private database details');
      return { rowCount: missing ? 0 : 1, rows: missing ? [] : [{ id: args[1], owner_id: args[2], name: args[0] }] };
    } } };
    if (name === '../services/pushNotifications.service') return {};
    throw Error('Unexpected dependency: ' + name);
  }, module, module.exports);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { calls, res, rename: (name, id = '11') => module.exports.renameBand({ params: { id }, body: { name, owner_id: 999 }, user: { id: 7 } }, res) };
}

test('rename trims name, uses authenticated owner atomically and supports archived bands', async () => {
  const h = setup(); await h.rename('  Nuevo nombre  ');
  assert.equal(h.res.statusCode, 200);
  assert.equal(h.res.body.data.name, 'Nuevo nombre');
  assert.deepEqual(h.calls[0][1], ['Nuevo nombre', 11, 7]);
  assert.match(h.calls[0][0], /WHERE id = \$2 AND owner_id = \$3/);
  assert.doesNotMatch(h.calls[0][0], /archived_at|invite_code|description/);
});
for (const name of ['', '   ', null, 7, {}, 'x'.repeat(256)]) {
  test('invalid name is rejected before accessing data: ' + typeof name + ':' + String(name).slice(0, 10), async () => {
    const h = setup(); await h.rename(name); assert.equal(h.res.statusCode, 400); assert.equal(h.calls.length, 0);
  });
}
for (const id of ['0', '-1', 'abc', '1.5']) {
  test('invalid band id is rejected: ' + id, async () => {
    const h = setup(); await h.rename('Valid', id); assert.equal(h.res.statusCode, 400); assert.equal(h.calls.length, 0);
  });
}
test('non-owner or missing band cannot be renamed or disclosed', async () => {
  const h = setup({ missing: true }); await h.rename('Valid'); assert.equal(h.res.statusCode, 404); assert.equal(h.res.body.data, undefined);
});
test('database failures do not disclose internal errors', async () => {
  const h = setup({ failure: true }); await h.rename('Valid'); assert.equal(h.res.statusCode, 500); assert.doesNotMatch(h.res.body.error, /private/);
});
