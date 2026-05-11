// Headless test for the iframe SDK message handlers. Mocks window +
// postMessage to exercise the full envelope-handling path.
import { initPapercupIframe, usePapercupAction, usePapercupEvent, usePapercupQuery } from '../src/iframe.ts';

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, 'got:', JSON.stringify(got), 'want:', JSON.stringify(want)); }
};
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
};

// --- Mock window/document in a JSDOM-free way ---
const listeners = [];
let posted = [];
const fakeWindow = {
  addEventListener(name, cb) { if (name === 'message') listeners.push(cb); },
  removeEventListener() {},
  parent: {
    postMessage(data) { posted.push(data); },
  },
};
const fakeDoc = {
  querySelector(sel) {
    if (sel === 'meta[name="papercup-nonce"]') return { content: 'abc123' };
    return null;
  },
};

globalThis.window = fakeWindow;
fakeWindow.parent.window = fakeWindow.parent; // simulate self
// SDK does `event.source !== window.parent` check; we simulate by setting source = window.parent
globalThis.document = fakeDoc;

// --- Test 1: nonce read from meta ---
console.log('# nonce + init');
initPapercupIframe();
ok(listeners.length === 1, 'message listener registered');

// Helper to deliver a fake postMessage from the parent.
const deliver = (data) => {
  for (const cb of listeners) {
    cb({ source: fakeWindow.parent, data });
  }
};

// --- Test 2: action round-trip ---
console.log('# usePapercupAction round-trip');
posted = [];
const enc = new TextEncoder();
const promise = usePapercupAction('echo', enc.encode('hi'));
ok(posted.length === 1, 'one message posted');
const sent = posted[0];
eq(sent.kind, 'rpc-request', 'kind=rpc-request');
eq(sent.action, 'echo', 'action name');
eq(sent.nonce, 'abc123', 'nonce stamped');
ok(sent.payloadB64 === 'aGk=', 'payload b64-encoded');

// Reply with rpc-response
deliver({ kind: 'rpc-response', id: sent.id, ok: true, payloadB64: 'eWVz', nonce: 'abc123' });
const result = await promise;
eq(new TextDecoder().decode(result), 'yes', 'action result decoded');

// --- Test 3: nonce-mismatch ignored ---
console.log('# nonce mismatch dropped');
posted = [];
const promise2 = usePapercupAction('foo', new Uint8Array(0));
const sent2 = posted[0];
deliver({ kind: 'rpc-response', id: sent2.id, ok: true, payloadB64: 'AAAA', nonce: 'WRONG' });
let resolved = false;
promise2.then(() => { resolved = true; });
await new Promise((r) => setTimeout(r, 50));
ok(!resolved, 'rpc-response with wrong nonce dropped');
// Now send correct nonce so it cleans up
deliver({ kind: 'rpc-response', id: sent2.id, ok: true, payloadB64: 'AAAA', nonce: 'abc123' });
await promise2;

// --- Test 4: error response shape ---
console.log('# error response');
const promise3 = usePapercupAction('bad', new Uint8Array(0));
const sent3 = posted[posted.length - 1];
deliver({ kind: 'rpc-response', id: sent3.id, ok: false, error: { tag: 'not-found', message: 'no such action' }, nonce: 'abc123' });
try {
  await promise3;
  fail++; console.log('  ✗ expected reject');
} catch (e) {
  ok(e.message === 'not-found: no such action', 'error message formatted');
  ok(e.tag === 'not-found', 'tag attached');
}

// --- Test 5: query round-trip (round-6 fix) ---
console.log('# usePapercupQuery (the round-6 channel fix)');
posted = [];
const qp = usePapercupQuery('SELECT 1');
const qsent = posted[0];
eq(qsent.kind, 'query', 'query kind');
eq(qsent.query, 'SELECT 1', 'query string');
eq(qsent.nonce, 'abc123', 'nonce on query');

// Operator replies with query-result envelope (NOT rpc-response)
deliver({ kind: 'query-result', id: qsent.id, rows: [{ x: 1 }, { x: 2 }], nonce: 'abc123' });
const rows = await qp;
eq(rows, [{ x: 1 }, { x: 2 }], 'query rows resolved');

// --- Test 6: events ---
console.log('# usePapercupEvent');
posted = [];
const seen = [];
const unsub = usePapercupEvent('foo.bar', (payload) => seen.push(new TextDecoder().decode(payload)));
ok(posted.length === 1 && posted[0].kind === 'event-subscribe', 'subscribed');
deliver({ kind: 'event', name: 'foo.bar', payloadB64: 'aGVsbG8=', nonce: 'abc123' });
deliver({ kind: 'event', name: 'foo.bar', payloadB64: 'd29ybGQ=', nonce: 'abc123' });
eq(seen, ['hello', 'world'], 'events delivered');

posted = [];
unsub();
ok(posted.length === 1 && posted[0].kind === 'event-unsubscribe', 'unsubscribed on cleanup');
deliver({ kind: 'event', name: 'foo.bar', payloadB64: 'eA==', nonce: 'abc123' });
eq(seen, ['hello', 'world'], 'no more events after unsubscribe');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
