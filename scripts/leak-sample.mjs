#!/usr/bin/env node
// Attach to a running node process's inspector (opened via SIGUSR1), run the V8
// SAMPLING heap profiler for a window, and print the top allocation call-sites by
// total allocated bytes. Ideal for a FAST leak: names the exact code path that is
// allocating the growing memory, with low overhead + tiny output.
//
// Usage: node scripts/leak-sample.mjs <pid> [durationMs] [inspectorPort]
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const pid = Number(process.argv[2]);
const durationMs = Number(process.argv[3] || 45000);
const startPort = Number(process.argv[4] || 9229);
if (!pid) { console.error('usage: leak-sample.mjs <pid> [durationMs] [port]'); process.exit(1); }

// 1) open the inspector on the target
try { process.kill(pid, 'SIGUSR1'); } catch (e) { console.error('SIGUSR1 failed:', e.message); process.exit(1); }
await sleep(1200);

// 2) discover the inspector ws url (Node picks startPort, or next free)
async function findWs() {
  for (let port = startPort; port < startPort + 6; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await r.json();
      const t = list.find((x) => x.webSocketDebuggerUrl);
      if (t) return t.webSocketDebuggerUrl;
    } catch { /* try next */ }
  }
  return null;
}
let wsUrl = null;
for (let i = 0; i < 8 && !wsUrl; i++) { wsUrl = await findWs(); if (!wsUrl) await sleep(700); }
if (!wsUrl) { console.error('could not find inspector ws url (SIGUSR1 may need --inspect support)'); process.exit(1); }
console.error('inspector:', wsUrl);

const ws = new WebSocket(wsUrl, { maxPayload: 1024 * 1024 * 1024 });
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.on('open', r));

await send('HeapProfiler.enable');
await send('HeapProfiler.startSampling', { samplingInterval: 16384 });
console.error(`sampling ${durationMs}ms ...`);
await sleep(durationMs);
const { profile } = await send('HeapProfiler.stopSampling');
ws.close();

// 3) aggregate self-allocated bytes per call frame (function@file:line)
const bySite = new Map();
let total = 0;
(function walk(node) {
  const cf = node.callFrame || {};
  const key = `${cf.functionName || '(anon)'} @ ${(cf.url || '').replace(/^.*\/papercusp\//, '')}:${cf.lineNumber ?? '?'}`;
  const self = node.selfSize || 0;
  bySite.set(key, (bySite.get(key) || 0) + self);
  total += self;
  for (const c of node.children || []) walk(c);
})(profile.head);

const top = [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(`\n=== TOP ALLOCATION SITES (sampled ${(durationMs/1000)|0}s, total ${(total/1048576).toFixed(1)}MB sampled) ===`);
for (const [site, bytes] of top) {
  const mb = (bytes / 1048576).toFixed(1);
  const pct = ((bytes / total) * 100).toFixed(1);
  console.log(`${mb.padStart(8)}MB  ${pct.padStart(5)}%  ${site}`);
}
