// Self-check for js/sync.js (hosted-site account saves). Run: node scripts/sync-test.mjs
// Stubs localStorage, fetch, document, confirm. No browser, no server.
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.document = { createElement: () => ({ style: {}, appendChild() {}, set innerHTML(v) {}, remove() {} }), body: { appendChild() {} }, getElementById: () => null, querySelector: () => null };
globalThis.location = { reload() {} };
let calls, answers, confirmAnswer = true;
globalThis.confirm = () => confirmAnswer;
const res = (status, body, json = true) => ({ status, ok: status < 300, headers: { get: () => (json ? 'application/json' : 'text/html') }, json: async () => body });
globalThis.fetch = async (url, o = {}) => { calls.push([o.method ?? 'GET', url, o.body && JSON.parse(o.body)]); return answers.shift()(url, o); };
const reset = (a) => { calls = []; answers = a; store.clear(); };

const sync = await import('../js/sync.js');
sync.__test.setFlushMs(5);
const K = 'openworld-v2';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// 1. not the hosted site (404 html): local mode, nothing else called
reset([() => res(404, {}, false)]);
await sync.hydrate();
assert.equal(sync.isHosted(), false);
sync.onSaved(); await wait(20);
assert.equal(calls.length, 1, 'local mode must never upload');

// 2. hosted, server has a save: it replaces a different local one, which is kept as a backup
reset([() => res(200, { name: 'kay' }), () => res(200, { rev: 4, data: { v: 5, ts: 100, money: 9 } })]);
store.set(K, JSON.stringify({ v: 5, ts: 50, money: 1 }));
await sync.hydrate();
assert.equal(sync.isHosted(), true);
assert.equal(JSON.parse(store.get(K)).money, 9);
assert.equal(JSON.parse(store.get(K + '-backup')).money, 1);

// 3. a save debounces into one PUT carrying the server revision; 200 stores the new rev
answers.push(() => res(200, { rev: 5 }));
store.set(K, JSON.stringify({ v: 5, ts: 200, money: 10 }));
sync.onSaved(); sync.onSaved(); sync.onSaved(); await wait(30);
const puts = calls.filter(c => c[0] === 'PUT');
assert.equal(puts.length, 1);
assert.equal(puts[0][2].rev, 4);
assert.equal(JSON.parse(store.get('openworld-sync')).rev, 5);
assert.equal(JSON.parse(store.get('openworld-sync')).dirty, false);

// 4. conflict where the server copy is newer: stop uploading, never overwrite it
answers.push(() => res(409, { rev: 9 }), () => res(200, { rev: 9, data: { v: 5, ts: 999 } }));
store.set(K, JSON.stringify({ v: 5, ts: 300 }));
sync.onSaved(); await wait(30);
const n = calls.length;
sync.onSaved(); await wait(30);
assert.equal(calls.length, n, 'uploads must stop after a newer server copy is found');

// 5. hosted, empty server, browser save present: confirm -> import
reset([() => res(200, { name: 'kay' }), () => res(200, { rev: 0, data: null }), () => res(200, { rev: 1 })]);
store.set(K, JSON.stringify({ v: 3, name: 'old' }));
await sync.hydrate();
const imp = calls.find(c => c[1].endsWith('api/save/import'));
assert.deepEqual(imp[2], { data: { v: 3, name: 'old' } });

// 6. declining the import keeps the browser copy as a backup and starts fresh
confirmAnswer = false;
reset([() => res(200, { name: 'kay' }), () => res(200, { rev: 0, data: null })]);
store.set(K, JSON.stringify({ v: 3, name: 'old' }));
await sync.hydrate();
assert.equal(store.get(K), undefined);
assert.equal(JSON.parse(store.get(K + '-backup')).name, 'old');

// 7. NEW GAME wipes local and server
answers.push(() => res(200, { ok: true }));
store.set(K, '{"v":5,"ts":1}');
assert.equal(await sync.resetSave(), true);
assert.equal(store.get(K), undefined);
assert.equal(calls.at(-1)[0], 'DELETE');

console.log('sync.js: all checks passed');
process.exit(0);
